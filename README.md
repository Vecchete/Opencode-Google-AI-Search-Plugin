# Opencode Google AI Search Plugin

An Opencode plugin that exposes a native tool (`google_ai_search_plus`) for querying Google AI Mode. It uses Playwright to load the AI panel directly and converts the response into markdown with Turndown so the output renders like a normal OpenCode tool response.

## Features

- Works with OpenCode 2 and with OpenCode 1 from 1.18.29: one default export carries the OpenCode 2 definition (`id` and `setup`) and the OpenCode 1 `server()` entry.
- Reuses a single Playwright browser session across requests.
- Closes the shared browser automatically after 5 minutes of inactivity, and when OpenCode unloads the plugin.
- Stops a running search when the session is stopped.
- Captures headings, lists, tables, and sources from the AI panel.
- Returns markdown plus structured metadata (response time, source count, table presence).

## Installation

### Recommended: load directly from GitHub in OpenCode

With OpenCode 2:

```bash
opencode plugin add github:Vecchete/Opencode-Google-AI-Search-Plugin
```

or add it to the `plugins` array of your OpenCode config:

```json
{
  "plugins": [
    "github:Vecchete/Opencode-Google-AI-Search-Plugin"
  ]
}
```

OpenCode 1 reads the same entry from its `plugin` array, and OpenCode 2 still accepts that spelling.

The package points its entry directly at `src/index.ts`, so OpenCode installs it from GitHub without a prebuilt `dist/` directory. It also has no `build`, `prepare` or install script on purpose: npm prepares a Git dependency that has one by running a nested install, and that nested install fails inside the npm OpenCode 2 bundles (`git dep preparation failed`). Compiling is a development step, `npm run compile`.

### Local clone workflow

If you prefer a local plugin checkout, clone the repo and point OpenCode at the local file:

```json
{
  "plugins": [
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
- The plugin reuses a singleton browser session to avoid repeated browser/profile creation on consecutive searches.
- Idle sessions are cleaned up automatically after 5 minutes.
- You can still customize the tool ID by editing `src/index.ts`.

## Development

- `npm install` installs the dependencies, including the type packages of both plugin APIs.
- `npm run compile` compiles TypeScript to `dist/`.
- `npm test` compiles and runs the tests under `tests/`.
- `npm run clean` removes build artefacts.
- If you publish to npm later, keep the `.` and `./server` exports pointing at the runtime entrypoint OpenCode should load.

## License

MIT
