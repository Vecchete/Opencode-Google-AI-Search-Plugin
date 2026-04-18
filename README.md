# Opencode Google AI Search Plugin

An Opencode plugin that exposes a native tool (`google_ai_search_plus`) for querying Google AI Mode. It uses Playwright to load the AI panel directly and converts the response into markdown with Turndown so the output renders like a normal OpenCode tool response.

## Features

- Uses the current `@opencode-ai/plugin` custom-tool API.
- Reuses a single Playwright browser session across requests.
- Closes the shared browser automatically after 5 minutes of inactivity.
- Captures headings, lists, tables, and sources from the AI panel.
- Returns markdown plus structured metadata (response time, source count, table presence).

## Installation

### Recommended: load directly from GitHub in OpenCode

Add the fork to your OpenCode config:

```json
{
  "plugin": [
    "github:Vecchete/Opencode-Google-AI-Search-Plugin"
  ]
}
```

This package points its server entry directly at `src/index.ts`, so OpenCode can install it from GitHub without requiring a prebuilt `dist/` directory.

### Local clone workflow

If you prefer a local plugin checkout, clone the repo and point OpenCode at the local file:

```json
{
  "plugin": [
    "file:///absolute/path/to/Opencode-Google-AI-Search-Plugin/src/index.ts"
  ]
}
```

## Runtime requirements

The plugin depends on Playwright and requires Chromium to be installed:

```bash
npx playwright install chromium
```

If Chromium is missing, the tool raises an explicit setup error.

## Usage

Once loaded, call the tool from any OpenCode session:

```text
google_ai_search_plus "What is the difference between TypeScript and JavaScript?"
```

Parameters:

| Name | Type | Description |
|---|---|---|
| `query` | string | Question or topic to submit to Google AI Mode. |
| `timeout` | number | Optional timeout in seconds (default 30, max 120). |
| `followUp` | boolean | Reuse the current AI Mode conversation instead of starting fresh. |

## Notes

- Google frequently throttles automated traffic. If you see timeout or blocking errors, wait a few minutes before retrying.
- The plugin now reuses a singleton browser session to avoid repeated browser/profile creation on consecutive searches.
- Idle sessions are cleaned up automatically after 5 minutes.
- You can still customize the tool ID by editing `src/index.ts`.

## Development

- `bun run build` compiles TypeScript to `dist/`.
- `bun run clean` removes build artefacts.
- If you publish to npm later, keep the `./server` export pointing at the runtime entrypoint OpenCode should load.

## License

MIT
