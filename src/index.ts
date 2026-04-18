import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import TurndownService from "turndown"

type PlaywrightModule = typeof import("playwright")
type Browser = Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

type SourceReference = {
  title: string
  url?: string
  publisher?: string
}

type ComparisonRow = {
  feature: string
  column1: string
  column2: string
}

type AIResponse = {
  query: string
  answer: string
  summary?: string
  tableData: ComparisonRow[]
  tableHeaders: string[]
  sources: {
    count: number
    hasVideo: boolean
    sites: string[]
    references: SourceReference[]
  }
  metadata: {
    responseTime: number
    conversationIndex: number
    sessionId: string
    timestamp: Date
  }
}

type ExtractedTable = {
  header: string[]
  rows: string[][]
}

type ExtractedBlock =
  | { type: "heading"; text: string; level: number }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; heading?: string; items: string[] }
  | { type: "table" }

type ExtractionResult = {
  summary: string
  blocks: ExtractedBlock[]
  table: ExtractedTable | null
  rawHtml: string
  rawText: string
  fallbackParagraphs: string[]
  isConsent: boolean
  sources: {
    count: number
    entries: SourceReference[]
    hasVideo: boolean
  }
}

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 120_000
const IDLE_TIMEOUT = 5 * 60 * 1000

let globalManager: GoogleAIModeManager | null = null

export const GoogleAISearchPlugin: Plugin = async () => {
  return {
    tool: {
      google_ai_search_plus: tool({
        description:
          "Search the web using Google's AI-powered search mode. This tool provides comprehensive, AI-enhanced search results with contextual information, summaries, and source references. Use this for web searches, current events, factual lookups, research questions, and any task that needs up-to-date information.",
        args: {
          query: tool.schema
            .string()
            .describe("Question or topic to submit to Google AI Mode"),
          timeout: tool.schema
            .number()
            .min(5)
            .max(120)
            .optional()
            .describe("Timeout in seconds (default: 30, max: 120)"),
          followUp: tool.schema
            .boolean()
            .optional()
            .describe("Treat the query as a follow-up in the same session"),
        },
        async execute(args, ctx) {
          if (!globalManager) {
            globalManager = new GoogleAIModeManager(await loadPlaywright())
          }

          const timeoutMs = Math.min(
            (args.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000,
            MAX_TIMEOUT,
          )

          globalManager.clearIdleTimer()

          try {
            const result = await globalManager.query(
              args.query,
              args.followUp ?? false,
              timeoutMs,
              ctx.abort,
            )

            ctx.metadata({
              title: `Google AI: ${args.query}`,
              metadata: {
                query: args.query,
                sourceCount: result.sources.count,
                responseTime: result.metadata.responseTime,
                hasTable: result.tableData.length > 0,
              },
            })

            return {
              output: formatAIResponse(result),
              metadata: {
                query: result.query,
                responseTime: result.metadata.responseTime,
                sourceCount: result.sources.count,
                hasTable: result.tableData.length > 0,
              },
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (
              message.includes("Timeout") ||
              message.includes("forSelector") ||
              message.includes("blocking")
            ) {
              throw new Error(
                "Google AI Mode unavailable: automated access is currently blocked. Try again in a few minutes.",
              )
            }
            throw error
          } finally {
            globalManager?.startIdleTimer()
          }
        },
      }),
    },
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import("playwright")
  } catch (error) {
    throw new Error(
      "google_ai_search_plus requires the playwright package and Chromium. Install dependencies and run `npx playwright install chromium`.",
      { cause: error },
    )
  }
}

class GoogleAIModeManager {
  private browser: Browser | null = null
  private page: Page | null = null
  private conversationActive = false
  private sessionStartTime = Date.now()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private queryLock = false
  private readonly sessionTimeout = 5 * 60 * 1000

  constructor(private readonly playwright: PlaywrightModule) {}

  startIdleTimer() {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      void this.dispose()
    }, IDLE_TIMEOUT)
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  async query(
    query: string,
    followUp: boolean,
    timeout: number,
    abortSignal: AbortSignal,
  ): Promise<AIResponse> {
    const waitStart = Date.now()
    while (this.queryLock) {
      if (Date.now() - waitStart > timeout) {
        throw new Error("System busy: multiple search requests")
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    this.queryLock = true
    try {
      if (Date.now() - this.sessionStartTime > this.sessionTimeout) {
        await this.resetConversation()
      }

      await this.ensureBrowserSession()

      if (!followUp || !this.conversationActive) {
        await this.navigateToAIMode()
        this.conversationActive = true
      }

      return await this.submitQuery(query, timeout, abortSignal)
    } finally {
      this.queryLock = false
    }
  }

  private async ensureBrowserSession() {
    if (!this.browser) {
      this.browser = await this.playwright.chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=VizDisplayCompositor",
        ],
      })
    }

    if (!this.page) {
      this.page = await this.browser.newPage({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      })

      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => false,
        })

        const windowWithChrome = window as Window & {
          chrome?: {
            runtime?: {
              onConnect?: unknown
            }
          }
        }

        if (windowWithChrome.chrome?.runtime?.onConnect) {
          delete windowWithChrome.chrome.runtime.onConnect
        }

        Object.defineProperty(navigator, "languages", {
          get: () => ["en-GB", "en-US", "en"],
        })
      })

      this.sessionStartTime = Date.now()
    }
  }

  private async navigateToAIMode() {
    if (!this.page) {
      throw new Error("Page not initialized")
    }
    await this.page.goto("https://www.google.com")
    await this.page.waitForTimeout(2_000)
  }

  private buildAIModeURL(query?: string): string {
    const baseUrl = "https://www.google.com/search"
    const params = new URLSearchParams({
      udm: "50",
      aep: "22",
      q: query ?? "",
      hl: "en",
    })
    return `${baseUrl}?${params.toString()}`
  }

  private async submitQuery(
    query: string,
    timeout: number,
    abortSignal: AbortSignal,
  ): Promise<AIResponse> {
    if (!this.page) {
      throw new Error("Page not initialized")
    }

    const startTime = Date.now()
    await this.page.goto(this.buildAIModeURL(query), {
      waitUntil: "networkidle",
      timeout,
    })

    if (this.page.url().includes("/sorry/")) {
      throw new Error("Google is blocking automated access.")
    }

    await this.page.waitForTimeout(3_000)

    let previousLength = 0
    let stableCount = 0
    const waitStart = Date.now()

    while (Date.now() - waitStart < timeout) {
      await this.page.waitForTimeout(2_000)

      const currentLength = await this.page.evaluate(
        () => document.body.textContent?.length ?? 0,
      )

      if (currentLength === previousLength) {
        stableCount += 1
        if (stableCount >= 3) {
          break
        }
      } else {
        stableCount = 0
      }

      previousLength = currentLength

      if (abortSignal.aborted) {
        throw new Error("Operation aborted")
      }
    }

    const hasContent = await this.page.evaluate(() => {
      const body = document.body.textContent ?? ""
      return (
        body.includes("AI responses may include mistakes") ||
        Boolean(document.querySelector("table")) ||
        body.length > 10_000
      )
    })

    if (!hasContent) {
      throw new Error("AI content did not load")
    }

    const response = await this.parseResponse(query, Date.now() - startTime)

    if (abortSignal.aborted) {
      throw new Error("Operation aborted")
    }

    return response
  }

  private async parseResponse(
    query: string,
    responseTime: number,
  ): Promise<AIResponse> {
    if (!this.page) {
      throw new Error("Page not initialized")
    }

    const extraction = await this.page.evaluate<ExtractionResult>(() => {
      const clean = (text?: string | null) => {
        if (!text) {
          return ""
        }
        return text
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n")
          .replace(/[\t ]+\n/g, "\n")
          .replace(/\n[\t ]+/g, "\n")
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/\s([,:;.!?])/g, "$1")
          .trim()
      }

      const root =
        (document.querySelector('[data-aimmrs="true"]') as HTMLElement | null) ??
        (document.querySelector('#aim-chrome-initial-inline-async-container') as HTMLElement | null) ??
        (document.querySelector('[data-aim-chrome-rendered="true"]') as HTMLElement | null) ??
        document.body

      const main =
        (root.querySelector('.mZJni.Dn7Fzd') as HTMLElement | null) ?? root
      const contentContainer =
        (main.querySelector('.Zkbeff') as HTMLElement | null) ?? main

      const blockSelectors =
        '[role="heading"], h1, h2, h3, h4, h5, h6, .Y3BBE, .Fv6NCb, table, ul, ol, p'
      const orderedNodes = Array.from(
        contentContainer.querySelectorAll(blockSelectors),
      ) as HTMLElement[]

      const blocks: ExtractedBlock[] = []
      const listHeadingMarkers = new Set<HTMLElement>()
      const paragraphTexts = new Set<string>()
      let summary = ""
      let tableBlock: ExtractedTable | null = null

      const shouldSkipText = (text: string) => {
        if (!text) {
          return true
        }
        if (/AI responses may include mistakes/i.test(text)) {
          return true
        }
        if (/learn more$/i.test(text)) {
          return true
        }
        return false
      }

      orderedNodes.forEach((node) => {
        const text = clean(node.innerText)
        if (shouldSkipText(text)) {
          return
        }

        if (
          node.classList.contains('otQkpb') ||
          node.matches('[role="heading"], h1, h2, h3, h4, h5, h6')
        ) {
          const level = Number.parseInt(node.getAttribute('aria-level') ?? '3', 10)
          blocks.push({ type: 'heading', text, level })
          return
        }

        if (node.classList.contains('Fv6NCb')) {
          const table = node.querySelector('table')
          if (table) {
            const rows = Array.from(table.querySelectorAll('tr'))
              .map((row) =>
                Array.from(row.querySelectorAll('th,td')).map((cell) =>
                  clean((cell as HTMLElement).innerText),
                ),
              )
              .filter((row) => row.some((cell) => cell))

            if (rows.length > 1) {
              tableBlock = {
                header: rows[0],
                rows: rows.slice(1),
              }
              blocks.push({ type: 'table' })
            }
          }
          return
        }

        if (node.tagName === 'UL' || node.tagName === 'OL') {
          const items = Array.from(node.querySelectorAll(':scope > li'))
            .map((li) => clean((li as HTMLElement).innerText))
            .filter(Boolean)

          if (items.length === 0) {
            return
          }

          let heading: string | undefined
          const previous = node.previousElementSibling as HTMLElement | null
          if (previous && listHeadingMarkers.has(previous)) {
            heading = clean(previous.innerText).replace(/:\s*$/, '')
          }

          blocks.push({
            type: 'list',
            ordered: node.tagName === 'OL',
            heading,
            items,
          })
          return
        }

        if (node.classList.contains('Y3BBE') || node.tagName === 'P') {
          if (node.tagName === 'P' && node.closest('li')) {
            return
          }
          if (!summary) {
            summary = text
          }

          const next = node.nextElementSibling
          if (next && (next.tagName === 'UL' || next.tagName === 'OL')) {
            listHeadingMarkers.add(node)
            return
          }

          if (!paragraphTexts.has(text)) {
            paragraphTexts.add(text)
            blocks.push({ type: 'paragraph', text })
          }
        }
      })

      if (!summary) {
        summary = clean(contentContainer.innerText.split('\n').find(Boolean) ?? '')
      }

      const rawHtml = contentContainer.innerHTML
      const rawText = clean(contentContainer.innerText)
      const fallbackParagraphs = rawText
        .split(/\n{2,}/)
        .map((part) => clean(part))
        .filter((value) => value.length > 0)

      const consentIndicators = [
        'Before you continue to Google Search',
        'We use cookies',
        'By using our services, you agree',
        'We value your privacy',
      ]
      const isConsent = consentIndicators.some((phrase) => root.innerText.includes(phrase))

      const sourceContainer = root.querySelector('.ofHStc') as HTMLElement | null
      let sourceCount = 0
      const sources: SourceReference[] = []
      let hasVideo = false

      if (sourceContainer) {
        const countMatch = sourceContainer.innerText.match(/(\d+)\s+sites?/i)
        if (countMatch) {
          sourceCount = Number.parseInt(countMatch[1], 10)
        }

        const list = sourceContainer.querySelector('ul')
        if (list) {
          const seenLinks = new Set<string>()
          Array.from(list.querySelectorAll(':scope > li')).forEach((item) => {
            const itemText = clean((item as HTMLElement).innerText)
            const link =
              (item.querySelector('a') as HTMLAnchorElement | null)?.href ?? undefined
            if (/sites?$/i.test(itemText)) {
              return
            }
            if (link) {
              if (seenLinks.has(link)) {
                return
              }
              seenLinks.add(link)
            }
            const lines = itemText
              .split('\n')
              .map((part) => part.trim())
              .filter(Boolean)
            const titleLine = lines[0] ?? itemText
            if (/YouTube/i.test(itemText)) {
              hasVideo = true
            }
            const publisherMatch = lines.length > 1 ? lines[lines.length - 1] : undefined
            sources.push({
              title: titleLine,
              url: link,
              publisher:
                publisherMatch && publisherMatch !== titleLine
                  ? publisherMatch
                  : undefined,
            })
          })
        }
      }

      if (!sourceCount && sources.length > 0) {
        sourceCount = sources.length
      }

      return {
        summary,
        blocks,
        table: tableBlock,
        rawHtml,
        rawText,
        fallbackParagraphs,
        isConsent,
        sources: {
          count: sourceCount,
          entries: sources,
          hasVideo,
        },
      }
    })

    const answerSections: string[] = []
    const tableRows: ComparisonRow[] = []
    const tableHeaders = extraction.table?.header.slice(0, 3) ?? []

    extraction.blocks.forEach((block) => {
      if (block.type === 'heading') {
        const prefix = '#'.repeat(Math.min(6, Math.max(3, block.level)))
        answerSections.push(`${prefix} ${block.text}`)
        return
      }

      if (block.type === 'paragraph') {
        answerSections.push(block.text)
        return
      }

      if (block.type === 'list') {
        if (block.heading) {
          answerSections.push(`**${block.heading}:**`)
        }
        block.items.forEach((item) => {
          answerSections.push(`- ${item}`)
        })
        return
      }

      if (block.type === 'table' && extraction.table) {
        const headers = extraction.table.header.slice(0, 3)
        const rows = extraction.table.rows
        if (headers.length >= 2 && rows.length > 0) {
          answerSections.push(`| ${headers.join(' | ')} |`)
          answerSections.push(`|${headers.map(() => '---').join('|')}|`)
          rows.forEach((row) => {
            answerSections.push(
              `| ${headers.map((_, index) => row[index] ?? '').join(' | ')} |`,
            )
            tableRows.push({
              feature: row[0] ?? '',
              column1: row[1] ?? '',
              column2: row[2] ?? '',
            })
          })
        }
      }
    })

    const summary = extraction.summary || undefined
    if (summary && !answerSections.some((section) => section.includes(summary))) {
      answerSections.unshift(summary)
    }

    let finalAnswer = answerSections.filter(Boolean).join('\n\n')

    const fallbackContent = extraction.fallbackParagraphs
      .filter((paragraph) => paragraph.length > 40)
      .filter(
        (paragraph) =>
          !finalAnswer.includes(paragraph.slice(0, Math.min(60, paragraph.length))),
      )

    if ((!finalAnswer || finalAnswer.length < 500) && fallbackContent.length > 0) {
      const fallbackBlock = fallbackContent.join('\n\n')
      finalAnswer = finalAnswer
        ? `${finalAnswer}\n\n---\n${fallbackBlock}`
        : fallbackBlock
    }

    if (extraction.isConsent) {
      finalAnswer = finalAnswer || extraction.rawText
    }

    let markdownAnswer = ''
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
    })
    turndownService.remove(['script', 'style', 'meta', 'link'])

    if (extraction.rawHtml) {
      try {
        markdownAnswer = turndownService.turndown(extraction.rawHtml)
      } catch {
        markdownAnswer = ''
      }
    }

    if (markdownAnswer && fallbackContent.length > 0) {
      const fallbackBlock = fallbackContent.join('\n\n')
      if (!markdownAnswer.includes(fallbackBlock.slice(0, Math.min(80, fallbackBlock.length)))) {
        markdownAnswer = `${markdownAnswer}\n\n---\n${fallbackBlock}`
      }
    }

    if (!markdownAnswer || markdownAnswer.trim().length < 200) {
      markdownAnswer = finalAnswer || extraction.rawText
    }

    return {
      query,
      answer: markdownAnswer,
      summary,
      tableData: tableRows,
      tableHeaders,
      sources: {
        count: extraction.sources.count || extraction.sources.entries.length,
        hasVideo: extraction.sources.hasVideo,
        sites: Array.from(
          new Set(
            extraction.sources.entries
              .map((entry) => entry.publisher)
              .filter((publisher): publisher is string => Boolean(publisher)),
          ),
        ),
        references: extraction.sources.entries,
      },
      metadata: {
        responseTime,
        conversationIndex: this.conversationActive ? 2 : 1,
        sessionId: `session_${this.sessionStartTime}`,
        timestamp: new Date(),
      },
    }
  }

  async resetConversation() {
    this.conversationActive = false
    this.sessionStartTime = Date.now()
    try {
      if (this.page) {
        await this.page
          .getByRole('button', { name: 'Start new search' })
          .click({ timeout: 2_000 })
      }
    } catch {
      if (this.page) {
        await this.page.goto('https://www.google.com', { waitUntil: 'load' })
      }
    }
  }

  async dispose() {
    this.clearIdleTimer()
    if (this.page) {
      await this.page.close().catch(() => undefined)
      this.page = null
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined)
      this.browser = null
    }
    this.conversationActive = false
    if (globalManager === this) {
      globalManager = null
    }
  }
}

function formatAIResponse(response: AIResponse): string {
  let output = `# ${response.query}\n\n`

  if (response.summary && response.summary !== response.answer) {
    output += `**Summary**: ${response.summary}\n\n`
  }

  output += `## Answer\n\n${response.answer}\n\n`

  if (response.tableData.length > 0) {
    const headers =
      response.tableHeaders.length >= 3
        ? response.tableHeaders.slice(0, 3)
        : ['Feature', 'Option 1', 'Option 2']
    const signature = `| ${headers[0]} | ${headers[1]} |`
    if (!response.answer.includes(signature)) {
      output += '## Comparison Table\n\n'
      output += `| ${headers.join(' | ')} |\n`
      output += `|${headers.map(() => '---').join('|')}|\n`
      response.tableData.forEach((row) => {
        const values = [row.feature, row.column1, row.column2]
        output += `| ${headers.map((_, index) => values[index] ?? '').join(' | ')} |\n`
      })
      output += '\n'
    }
  }

  output += '## Sources\n\n'
  output += `- **Sources Referenced**: ${response.sources.count} sites\n`
  if (response.sources.hasVideo) {
    output += '- **Includes Video Sources**: Yes\n'
  }
  output += `- **Response Time**: ${response.metadata.responseTime}ms\n`
  output += `- **Session**: ${response.metadata.sessionId}\n`

  if (response.sources.references.length > 0) {
    output += '- **Source Links:**\n'
    response.sources.references.forEach((reference) => {
      const label = reference.url
        ? `[${reference.title}](${reference.url})`
        : reference.title
      output += `  - ${label}\n`
    })
  }

  return output
}
