# panel :5173

The Voidframe dashboard: one dependency-free page (`public/index.html`, inline
CSS and JS) served by a small Node server that also proxies requests.

- `/api/*` → `APEX_URL` (default `http://127.0.0.1:8080`), path with `/api`
  stripped, **only the caller's token forwarded** (`authorization` or
  `x-vf-token`). The panel never injects a service token into `/api`.
- `/svc/<name>/*` → that service's base URL, forwarding the caller's token. Used
  for the direct read endpoints of keychain, vault and lens.
- Anything else is served from `public/` (`/` is `index.html`).

Configure with `PORT`, `APEX_URL`, `KEYCHAIN_URL`, `VAULT_URL`, `LENS_URL`,
`ROUTER_URL`, `FORGE_URL`, `CRAWLER_URL`.

## Screens

- **Overview** — service health tiles, mission counts, usage totals, last 20 lens
  log lines.
- **Missions** — list, create (title, prompt, mode, autonomy), detail with the
  step timeline and approve/cancel buttons.
- **Chat** — model picker fed from `/api/v1/models`, a running thread and plain
  replies through `/api/v1/chat`.
- **Services** — per-service health, recent lens logs by service and a method +
  path + body playground.
- **Secrets** — list, create, rotate and delete against keychain. Values are
  write-only and never re-displayed.
- **Search** — query vault and show ranked chunks with scores.

The look follows the project palette (`#0c0c0b` background, `#141413` panels,
`1px #252523` borders, `#7fff8c` accent, IBM Plex Mono labels, Inter text) with
no CDN, no build step, no viewport-unit layout, and a single-column layout under
1000px. Errors appear as toasts; every form is keyboard operable and Escape
clears a selection.

## Endpoints

### Health

```sh
curl http://localhost:5173/healthz
```

### Dashboard

```sh
curl http://localhost:5173/
```

### Proxy apex

```sh
curl -H "Authorization: Bearer $TOKEN" http://localhost:5173/api/v1/me
```

### Read another service

```sh
curl -H "x-vf-token: $SERVICE_TOKEN" http://localhost:5173/svc/keychain/v1/secrets
curl -X POST -H "x-vf-token: $SERVICE_TOKEN" -H "content-type: application/json" \
  -d '{"query":"rate limiting","limit":5}' \
  http://localhost:5173/svc/vault/v1/search
```

## Errors

| status | code                 | when                              |
| ------ | -------------------- | --------------------------------- |
| 404    | `unknown_service`    | `/svc/<name>` has an unknown name |
| 404    | `not_found`          | no such static file or route      |
| 413    | `payload_too_large`  | proxied body exceeds 5 MiB        |
| 502    | `upstream_unavailable` | the target service did not answer |

## Test

```sh
node test.mjs
```
