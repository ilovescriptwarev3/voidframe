# apex :8080

The orchestrator and front door of Voidframe: accounts, sessions, per-user rate
limiting, missions with a real background worker, chat passthrough to the
router, service health fan-out, the panic switch and static hosting of the panel.

Users live in `data/users.json`; missions and usage live in SQLite (`node:sqlite`) at `data/apex.db`. Passwords are hashed with scrypt and a per-user salt; session tokens are random and stored only as SHA-256 hashes.

`PORT`, `VF_SERVICE_TOKEN`, `VF_APEX_DB`, `VF_RATE_LIMIT` (default 60),
`VF_RATE_WINDOW_S` (default 60), `VF_MISSION_TICK_MS` (default 250),
`VF_MISSION_MODEL` (default `gpt-4o`), `VF_CHAT_MODEL`, `PANEL_DIR` and the
service URLs (`ROUTER_URL`, `KEYCHAIN_URL`, `LENS_URL`, `VAULT_URL`, `FORGE_URL`,
`CRAWLER_URL`, `PANEL_URL`, `APEX_URL`) configure the service.

Authentication accepts `Authorization: Bearer <token>` or `x-vf-token: <token>`.
The service token acts as an internal admin for the panel; user sessions are
scoped to their owner.

## Endpoints

### Health

```sh
curl http://localhost:8080/healthz
```

### Register

```sh
curl -X POST http://localhost:8080/v1/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"correct-horse-9"}'
```

Returns `{user_id, email, token}`. Duplicate email is `409 email_taken`, a short
password is `400 weak_password`.

### Login

```sh
curl -X POST http://localhost:8080/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"correct-horse-9"}'
```

### Current user

```sh
curl -H "x-vf-token: $TOKEN" http://localhost:8080/v1/me
```

Returns `{user_id, email, created_at, plan:"free", usage:{...}}`.

### Missions

```sh
curl -X POST http://localhost:8080/v1/missions \
  -H "x-vf-token: $TOKEN" -H "content-type: application/json" \
  -d '{"title":"Summarise notes","prompt":"Summarise the latest notes","mode":"chat","autonomy":"auto"}'

curl -H "x-vf-token: $TOKEN" http://localhost:8080/v1/missions
curl -H "x-vf-token: $TOKEN" http://localhost:8080/v1/missions/<id>
curl -X POST -H "x-vf-token: $TOKEN" http://localhost:8080/v1/missions/<id>/approve
curl -X POST -H "x-vf-token: $TOKEN" http://localhost:8080/v1/missions/<id>/cancel
```

`mode` is one of `code`, `chat`, `work`, `agent`. Missions move
`queued → running → awaiting_approval → running → done|failed|cancelled`.
`autonomy: "auto"` finalises after the model call; `"restricted"` stops at
`awaiting_approval` until `approve`. Each mission carries a
`steps: [{at, kind, detail}]` timeline; a failed model call becomes a `warn` step
and the mission still completes.

### Chat passthrough

```sh
curl -X POST http://localhost:8080/v1/chat \
  -H "x-vf-token: $TOKEN" -H "content-type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'
```

Forwards to the router and records usage. Streaming is not proxied here (use the
router directly for SSE).

### Models

```sh
curl -H "x-vf-token: $TOKEN" http://localhost:8080/v1/models
```

Proxies the router's model catalog.

### Usage

```sh
curl -H "x-vf-token: $TOKEN" http://localhost:8080/v1/usage
```

### Service health

```sh
curl -H "x-vf-token: $TOKEN" http://localhost:8080/v1/services
```

The seven other services are probed in parallel with a 2s timeout each and
reported as `{name, url, ok, latency_ms, version}`.

### Panic

```sh
curl -X POST -H "x-vf-token: $TOKEN" http://localhost:8080/v1/panic
```

Lists forge sandboxes and deletes each one. Returns
`{stopped, sandboxes_removed, ok, errors}`; a missing forge is reported in
`errors` rather than failing the request.

### Panel

`GET /` and any non-`/v1/` path serve files from `services/panel/public` when they
exist. Without a panel, `/` answers `{service, docs}`.

## Errors

| status | code                 | when                                  |
| ------ | -------------------- | ------------------------------------- |
| 400    | `invalid_email`      | email is malformed                    |
| 400    | `weak_password`      | password shorter than 8 characters    |
| 400    | `invalid_title`      | mission title missing or too long     |
| 400    | `invalid_prompt`     | mission prompt missing or too long    |
| 400    | `invalid_mode`       | mission mode invalid                  |
| 400    | `invalid_autonomy`   | autonomy is not auto/restricted       |
| 400    | `invalid_messages`   | chat messages missing                 |
| 400    | `stream_unsupported` | chat passthrough asked to stream      |
| 401    | `unauthorized`       | missing or invalid token              |
| 401    | `invalid_credentials`| login failed                          |
| 404    | `mission_not_found`  | mission missing or owned by another   |
| 404    | `not_found`          | unknown route                         |
| 409    | `email_taken`        | email already registered              |
| 409    | `invalid_state`      | mission is not in a state for that action |
| 429    | `rate_limited`       | per-user limit exceeded (`retry_after_s`) |
| 502    | `provider_error`     | router/provider failed                |
| 502    | `router_unavailable` | router unreachable                    |

## Test

The test spins a local stub for the other services, so it needs no network.

```sh
node test.mjs
```
