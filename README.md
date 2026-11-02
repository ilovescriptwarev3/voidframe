# Voidframe

Self-hosted AI agent platform — eight services, one platform, on your machine.

Node 24 · zero external dependencies · no Docker required.

## Run it

```powershell
# once
Copy-Item .env.example .env

# everything
node scripts/dev-all.mjs

# or one service
node services/router/src/server.js
```

`scripts/dev-all.mjs` starts all eight, prefixes their output, and restarts nothing: Ctrl+C
stops the lot. `node scripts/check-all.mjs` prints a health table.

| service  | port | what it does                                    |
|----------|------|-------------------------------------------------|
| apex     | 8080 | orchestrator, API, auth, rate limits, missions  |
| forge    | 8000 | sandboxed code execution                        |
| crawler  | 3000 | scrape and crawl, feed the vault                |
| vault    | 8085 | documents, chunks, search, knowledge graph      |
| router   | 8089 | LLM providers behind one OpenAI-compatible API  |
| lens     | 8086 | logs, metrics, alerts                           |
| keychain | 8087 | encrypted secrets                               |
| panel    | 5173 | dashboard                                       |

Open http://localhost:5173 once they are up.

## Read first

`CONTRACTS.md` — ports, auth, error shape, and every endpoint. Services are built against it,
so a change there is a change everywhere.

## Layout

```
services/<name>/
  src/server.js     entry point
  src/http.js       tiny router helpers
  test.mjs          endpoint tests, no test framework
  README.md         endpoints + curl examples
  data/             runtime state (gitignored)
```
