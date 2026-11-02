# forge — sandboxed code execution

Port **8000** (`PORT`). Zero dependencies, ESM (`src/server.js`). Sandboxes are real
directories under `data/sandboxes/<id>/`; runs are stored in `data/runs.json`.

```powershell
node services/forge/src/server.js
node services/forge/test.mjs
```

Auth: every route except `GET /healthz`, `GET /` and `OPTIONS` needs `x-vf-token: $env:VF_SERVICE_TOKEN`
(default `dev-token-change-me`). Errors are `{"error":{"code":"...","message":"..."}}`.

## Endpoints

### `GET /healthz` — public

```powershell
curl.exe http://localhost:8000/healthz
```

### `GET /` — public

```powershell
curl.exe http://localhost:8000/
```

### `POST /v1/sandboxes`

`{name?, image?}` → `201 {id, path, created_at}`.

```powershell
curl.exe -X POST http://localhost:8000/v1/sandboxes -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" -d "{\"name\":\"demo\"}"
```

### `GET /v1/sandboxes`

```powershell
curl.exe http://localhost:8000/v1/sandboxes -H "x-vf-token: dev-token-change-me"
```

### `DELETE /v1/sandboxes/:id`

Recursively removes the sandbox directory. `204` on success, `404 sandbox_not_found`.

```powershell
curl.exe -X DELETE http://localhost:8000/v1/sandboxes/0f3a9c2d1b4e6a8c -H "x-vf-token: dev-token-change-me"
```

### `POST /v1/runs`

`{sandbox, cmd, timeout_s?=60, env?, files?}` → the run record
`{id, sandbox, cmd, exit_code, stdout, stderr, started_at, ended_at, ms, truncated, error?}`.
`files` is `{relativePath: content}` written before the run; traversal and absolute paths are
rejected with `400 path_traversal`. stdout/stderr are capped at 64 KB each. On timeout the
process tree is killed and `exit_code` is `124` with `error: "timeout"`.

```powershell
curl.exe -X POST http://localhost:8000/v1/runs -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" -d "{\"sandbox\":\"0f3a9c2d1b4e6a8c\",\"cmd\":\"echo hello\",\"timeout_s\":10}"
```

### `GET /v1/runs/:id`

```powershell
curl.exe http://localhost:8000/v1/runs/2b7d1a9c4e6f8a0b -H "x-vf-token: dev-token-change-me"
```

### `GET /v1/runs?limit=20`

Recent runs, newest first (`limit` 1–100).

```powershell
curl.exe "http://localhost:8000/v1/runs?limit=20" -H "x-vf-token: dev-token-change-me"
```

## Environment

| variable | default | meaning |
|---|---|---|
| `PORT` | `8000` | listen port |
| `VF_SERVICE_TOKEN` | `dev-token-change-me` | shared token |
| `VF_FORGE_TIMEOUT_S` | `60` | default run timeout in seconds |
| `VF_FORGE_ALLOWLIST` | — | optional comma-separated command allowlist; unset = allow all |
| `LENS_URL` | — | optional log ingestion |

Commands run through `cmd.exe /c` on Windows and `sh -c` elsewhere, with the working directory
inside the sandbox.
