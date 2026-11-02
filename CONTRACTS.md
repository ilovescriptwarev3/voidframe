# Voidframe — service contracts

Everything here is binding. Every service must match it exactly; the panel and the other
services code against these endpoints.

## Stack

- **Node.js 24, ESM, ZERO external dependencies.** No `npm install`, no `node_modules`.
  Use only `node:` built-ins (`node:http`, `node:crypto`, `node:fs`, `node:child_process`,
  `node:sqlite`, `node:path`, `node:url`).
- Python is 3.14 on this machine and Docker is **not installed** — do not use either.
- Each service lives in `services/<name>/`, entry point `src/server.js`.
- No build step. `node src/server.js` must start it.

## Ports

| service  | port | folder              |
|----------|------|---------------------|
| apex     | 8080 | services/apex       |
| forge    | 8000 | services/forge      |
| crawler  | 3000 | services/crawler    |
| vault    | 8085 | services/vault      |
| router   | 8089 | services/router     |
| lens     | 8086 | services/lens       |
| keychain | 8087 | services/keychain   |
| panel    | 5173 | services/panel      |

Ports come from `PORT` in the environment, defaulting to the table above.

## Common rules

1. `GET /healthz` is public and returns
   `{"service":"<name>","status":"ok","version":"0.1.0","uptime_s":<number>}`.
2. Every other route requires header `x-vf-token: <VF_SERVICE_TOKEN>` unless the route is
   marked **public**. Wrong or missing token → `401 {"error":{"code":"unauthorized","message":"..."}}`.
3. Request and response bodies are JSON, `content-type: application/json`.
4. Errors: `{"error":{"code":"<snake_case>","message":"<human sentence>"}}` with a matching
   HTTP status. Never leak stack traces.
5. `GET /` returns a one-line JSON `{"service":"<name>","docs":"/healthz"}`.
6. CORS: allow any origin, methods `GET,POST,PUT,PATCH,DELETE,OPTIONS`, headers
   `content-type,x-vf-token,authorization`. Answer `OPTIONS` with `204`.
7. Each service keeps its own data under `services/<name>/data/` (gitignored).
8. Startup must never crash on missing env: log a warning and use the documented default.
9. Every service writes a JSON line to stdout on each request:
   `{"t":"<iso>","svc":"<name>","method":"...","path":"...","status":<int>,"ms":<int>}`.
10. If `LENS_URL` is set, also `POST ${LENS_URL}/ingest` (fire and forget, 300 ms timeout,
    swallow errors) with
    `{"service":"<name>","level":"info|warn|error","event":"<short>","fields":{...}}`.

## Env

Root `.env.example` lists everything. Shared values:

```
VF_SERVICE_TOKEN=dev-token-change-me
LENS_URL=http://localhost:8086
KEYCHAIN_URL=http://localhost:8087
VAULT_URL=http://localhost:8085
ROUTER_URL=http://localhost:8089
APEX_URL=http://localhost:8080
FORGE_URL=http://localhost:8000
CRAWLER_URL=http://localhost:3000
```

A service reads env directly (`process.env.X`). Do not add a dotenv dependency.

## Shared helper (copy it, don't import across folders)

`services/<name>/src/http.js` may hold a tiny router:

```js
export function json(res, status, body) { ... }
export function readBody(req, limit = 1 << 20) { ... }  // parsed JSON, throws 400
export function send(res, status, body) { ... }
export function requireToken(req, res) -> boolean
```

Keep it under ~80 lines and dependency-free.

## Service APIs

### keychain :8087 — secrets at rest

AES-256-GCM, key from `VF_MASTER_KEY` (any string; derive with `scryptSync`).

- `POST /v1/secrets` **{name, value, meta?}** → `201 {name, created_at}` (overwrites; bumps `updated_at`)
- `GET /v1/secrets` → `{secrets:[{name, meta, created_at, updated_at}]}` (never values)
- `GET /v1/secrets/:name` → `{name, value, meta, created_at, updated_at}` or `404 secret_not_found`
- `DELETE /v1/secrets/:name` → `204`
- `POST /v1/secrets/:name/rotate` **{value}** → `200 {name, updated_at}`
- Redaction helper: `POST /v1/redact` **{text}** → `{text}` with known secret values replaced
  by `[redacted:<name>]`.

Storage: `data/secrets.json`, values encrypted, never plaintext on disk.

### vault :8085 — storage, vectors, knowledge graph

SQLite via `node:sqlite` in `data/vault.db`.

- `POST /v1/collections` **{name}** → `201 {name}`
- `GET /v1/collections` → `{collections:[{name, documents, updated_at}]}`
- `POST /v1/documents` **{collection, id?, text, metadata?, embedding?}** →
  `201 {id, collection, chunks}`. Chunk `text` at ~900 chars on paragraph/sentence
  boundaries, ≤ 32 chunks per document.
- `GET /v1/documents/:id` → the document with its chunks.
- `DELETE /v1/documents/:id` → `204`
- `POST /v1/search` **{collection?, query, query_embedding?, limit?=8}** →
  `{results:[{id, collection, text, score, metadata}]}`.
  Rank with cosine similarity when an embedding is present; otherwise BM25-ish
  keyword ranking (tf·idf over the chunks). Never return an empty result set for a
  non-empty collection unless there is genuinely no match.
- Graph: `POST /v1/edges` **{from, to, kind, metadata?}**, `GET /v1/graph?node=<id>&depth=2`
  → `{nodes:[...], edges:[...]}`. BFS over edges, depth ≤ 4.

### router :8089 — LLM provider abstraction

Reads provider credentials from keychain at request time (names: `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_URL`).

- `GET /v1/models` → `{models:[{id, provider, cost_per_1k_in, cost_per_1k_out}]}`
  (report the models you actually support; unknown providers are skipped, not fatal).
- `POST /v1/chat/completions` — OpenAI-compatible request
  **{model, messages, temperature?, max_tokens?, stream?=false}**.
  Response `{id, object:"chat.completion", created, model, choices:[{index,message:{role,content},finish_reason}], usage:{prompt_tokens,completion_tokens,total_tokens}, vf:{provider, cost_usd, latency_ms}}`.
- `POST /v1/embeddings` **{model?, input}** → OpenAI-compatible
  `{object:"list", data:[{index, embedding:[...]}], model, usage}`.
- `GET /v1/usage` → `{calls, tokens_in, tokens_out, cost_usd, by_model:{}}` (in-memory, resets on restart).
- `GET /v1/health/providers` → `{providers:[{id, configured:boolean, reachable:boolean|null}]}`.

Rules: no provider configured → `503 no_provider_configured` with a message saying to add a
key to keychain. Provider HTTP failures → `502 provider_error` carrying the upstream status in
`error.message`. Always populate `vf.cost_usd` from the table (0 when unknown).
If a provider has no embeddings endpoint, return `501 embeddings_unsupported` for that model.

### forge :8000 — code execution

Runs commands inside `data/sandboxes/<id>/`, never outside it.

- `POST /v1/sandboxes` **{name?, image?}** → `201 {id, path, created_at}` (just a temp dir; no containers on this machine)
- `GET /v1/sandboxes` → `{sandboxes:[{id, path, created_at, runs}]}`
- `DELETE /v1/sandboxes/:id` → `204` (recursively removes the dir)
- `POST /v1/runs` **{sandbox, cmd, timeout_s?=60, env?, files?}** →
  `{id, sandbox, cmd, exit_code, stdout, stderr, started_at, ended_at, ms, truncated}`
  - `cmd` runs through the platform shell (`cmd.exe /c` on Windows, `sh -c` elsewhere) with
    `cwd` = sandbox path.
  - `files` is `{relativePath: content}` written before the run (path traversal rejected).
  - stdout/stderr capped at 64 KB each, `truncated: true` when hit.
  - timeout kills the process tree, `exit_code: 124`, `error: "timeout"`.
  - Never allow `sandbox` to escape its root: resolve the final path and verify it is inside.
- `GET /v1/runs/:id` → the stored run record.
- `GET /v1/runs?limit=20` → recent runs.

Note for the agent: this machine is Windows, so test with `cmd /c echo hello` and
`node -e "console.log(1+1)"` style commands. Keep an `ALLOWED_CMDS` allowlist check off by
default (`VF_FORGE_ALLOWLIST` unset = allow all, but still sandboxed).

### crawler :3000 — fetch and extract

- `POST /v1/scrape` **{url}** → `{url, status, title, text, html_bytes, links:[...], fetched_at}`
  (strip scripts/styles/tags, collapse whitespace, cap `text` at 200 KB)
- `POST /v1/crawl` **{url, max_pages?=20, same_origin?=true, max_depth?=2}** →
  `202 {job_id, status:"queued"}`
- `GET /v1/jobs/:id` → `{job_id, status:"queued|running|done|failed", pages_done, pages:[{url,status,title,text}], error?, started_at, ended_at}`
- `GET /v1/jobs` → last 20 jobs, summarised.
- Respect `robots.txt` (`VF_CRAWLER_ROBOTS=1` default on), a 10 s per-request timeout,
  1 request/second per host, and a 5 MB page cap. Refuse non-http(s) schemes and
  `localhost`/private IPs unless `VF_CRAWLER_ALLOW_PRIVATE=1`.
- Job state in memory + `data/jobs/*.json`.
- If `VAULT_URL` is set and a `collection` field is given to `/v1/crawl`, push each page to
  `POST ${VAULT_URL}/v1/documents` with `{collection, text, metadata:{url,title}}`
  (fire and forget, never fail the job on it).

### lens :8086 — observability

In-memory ring buffers (last 5 000 log lines, 2 000 metrics samples), `data/lens.json` for
alert rules. Metric points also come from `POST /v1/metrics`.

- `POST /ingest` **{service, level, event, fields?, ts?}** → `202` (public, no token — it is an
  ingestion endpoint only)
- `GET /v1/logs?service=&level=&q=&limit=100` → `{lines:[...], total}`
- `POST /v1/metrics` **{name, value, tags?}** → `202`
- `GET /v1/metrics?name=&since_s=300` → `{series:[{name, points:[{t,v,tags}]}]}`
- `GET /v1/services` → `{services:[{service, last_seen, lines, level_counts, healthy}]}`
  (`healthy` = seen in the last 60 s)
- Alerts: `POST /v1/alerts` **{name, service?, metric?, op:"gt|lt", threshold, window_s?=60}**,
  `GET /v1/alerts`, `DELETE /v1/alerts/:id`, `GET /v1/alerts/firing` →
  `{firing:[{alert, value, since}]}`
- `GET /v1/stream` — `text/event-stream`, emits `{"type":"log"|"metric"|"alert", ...}` live.

### apex :8080 — orchestrator, API, auth, rate limits, missions

The only service users talk to. Everything else sits behind it.

- `POST /v1/auth/register` **public** **{email, password}** → `201 {user_id, email, token}`
  (scrypt with per-user salt, `data/users.json`; token is a random 32-byte hex, stored hashed)
- `POST /v1/auth/login` **public** **{email, password}** → `{user_id, email, token}`
- `GET /v1/me` (user token via `authorization: Bearer <token>` or `x-vf-token`)
  → `{user_id, email, created_at, plan:"free", usage:{...}}`
- Rate limits per user: `VF_RATE_LIMIT` requests per `VF_RATE_WINDOW_S` (default 60 / 60 s),
  → `429 rate_limited` with `retry_after_s`.
- Missions (workflow engine): the state machine is
  `queued → running → (awaiting_approval) → running → done | failed | cancelled`.
  - `POST /v1/missions` **{title, prompt, mode:"code|chat|work|agent", autonomy:"restricted|auto"}**
    → `201 {id, status:"queued", ...}`
  - `GET /v1/missions`, `GET /v1/missions/:id` (includes `steps:[{at, kind, detail}]`)
  - `POST /v1/missions/:id/approve` **{step_id?}**, `POST /v1/missions/:id/cancel`
  - Worker loop: every 500 ms pick one queued mission, drive it. In `restricted` autonomy,
    any step that would write files or run a command creates an approval step and pauses.
  - A mission step that needs a model calls router `POST /v1/chat/completions`; one that
    needs to run code calls forge; one that needs a page calls crawler; retrieval calls vault.
    Keep every call behind a helper with a 30 s timeout and graceful degradation (`warn`
    step, mission keeps going).
- `POST /v1/chat` **{mission_id?, model?, messages}** → router passthrough plus usage accounting.
- `GET /v1/services` → live health fan-out to all seven services
  `{services:[{name, url, ok, latency_ms, version}]}` (2 s timeout each, parallel).
- `POST /v1/panic` → tells forge to delete all sandboxes `{stopped, sandboxes_removed}`.
- Static: serve `services/panel/public/` at `/` when it exists (no dependency on the panel
  server being up).

### panel :5173 — dashboard

Vanilla HTML/CSS/JS (no React build step, no CDN). Its own `src/server.js` serves
`public/` on 5173 and proxies `/api/*` → `APEX_URL` (adding nothing but the user's token).

Screens, all working against apex and the other services' read endpoints:
1. **Overview** — service health tiles, today's counts, last 20 log lines from lens.
2. **Missions** — list + create + detail with step timeline and approve/cancel buttons.
3. **Chat** — message thread, model picker (`/api/v1/models` via apex→router), streamed or
   plain replies.
4. **Services** — per-service detail: health, recent logs, and a small "call this endpoint"
   playground.
5. **Secrets** — list/create/rotate/delete against keychain (values never re-displayed).
6. **Search** — query vault, show ranked chunks.
Follow the site's look: near-black `#0c0c0b`, panels `#141413`, 1px `#252523` borders,
accent `#7fff8c`, IBM Plex Mono for labels, Inter for text. No viewport-unit layout hacks.
The panel is the only service allowed a CDN-free inline `<style>`; keep everything inline.

## Definition of done for every service

- `node services/<name>/src/server.js` starts with no warnings other than expected ones.
- `GET /healthz` answers.
- Every documented endpoint answers correctly, including the error cases.
- `services/<name>/README.md` lists the endpoints with a curl example each.
- A `services/<name>/test.mjs` that starts the server on a random port, exercises every
  endpoint, and exits non-zero on failure. Run with `node test.mjs`; all tests pass.
- No file outside `services/<name>/` is touched.
