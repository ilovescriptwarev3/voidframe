# crawler — fetch, extract, crawl

Port **3000** (`PORT`). Zero dependencies, ESM (`src/server.js`). Data in `data/jobs/*.json`.

```powershell
node services/crawler/src/server.js
node services/crawler/test.mjs
```

Auth: every route except `GET /healthz`, `GET /` and `OPTIONS` needs `x-vf-token: $env:VF_SERVICE_TOKEN`
(default `dev-token-change-me`). Errors are `{"error":{"code":"...","message":"..."}}`.

## Endpoints

### `GET /healthz` — public

```powershell
curl.exe http://localhost:3000/healthz
```

### `GET /` — public

```powershell
curl.exe http://localhost:3000/
```

### `POST /v1/scrape`

`{url}` → `{url, status, title, text, html_bytes, links, fetched_at}`.
Strips scripts/styles/tags, collapses whitespace, caps text at 200 KB.

```powershell
curl.exe -X POST http://localhost:3000/v1/scrape -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" -d "{\"url\":\"https://example.com\"}"
```

### `POST /v1/crawl`

`{url, max_pages?=20, same_origin?=true, max_depth?=2, collection?}` → `202 {job_id, status:"queued"}`.
Respects robots.txt, 1 request/second per host, 5 MB page cap, 10 s timeout.
If `collection` is given and `VAULT_URL` is set, each page is pushed to the vault.

```powershell
curl.exe -X POST http://localhost:3000/v1/crawl -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" -d "{\"url\":\"https://example.com\",\"max_pages\":5,\"max_depth\":2}"
```

### `GET /v1/jobs/:id`

Returns `{job_id, status, pages_done, pages:[{url,status,title,text}], started_at, ended_at, error?}`.

```powershell
curl.exe http://localhost:3000/v1/jobs/0f3a9c2d1b4e6a8c -H "x-vf-token: dev-token-change-me"
```

### `GET /v1/jobs`

Last 20 jobs, summarised.

```powershell
curl.exe http://localhost:3000/v1/jobs -H "x-vf-token: dev-token-change-me"
```

## Environment

| variable | default | meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `VF_SERVICE_TOKEN` | `dev-token-change-me` | shared token |
| `VF_CRAWLER_ROBOTS` | `1` | `0` disables robots.txt checks |
| `VF_CRAWLER_ALLOW_PRIVATE` | `0` | `1` allows localhost/private targets (tests do this) |
| `VF_CRAWLER_TIMEOUT_MS` | `10000` | per-request timeout |
| `VAULT_URL` | — | optional vault for `collection` feeds |
| `LENS_URL` | — | optional log ingestion |
