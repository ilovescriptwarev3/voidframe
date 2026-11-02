# router (:8089)

One OpenAI-compatible API in front of OpenAI, Anthropic, Gemini, OpenRouter and Ollama.
Credentials are read from keychain on every request (`GET /v1/secrets/:name`), so keys can be
rotated without restarting the router.

Default port `8089` (override with `PORT`). All routes except `GET /healthz` require
`x-vf-token: $VF_SERVICE_TOKEN`.

Base URL below assumes `http://localhost:8089` and `TOKEN=dev-token-change-me`.

## Credentials

Put these names in keychain (:8087):

| provider | keychain name |
|---|---|
| openai | OPENAI_API_KEY |
| anthropic | ANTHROPIC_API_KEY |
| gemini | GEMINI_API_KEY |
| openrouter | OPENROUTER_API_KEY |
| ollama | OLLAMA_URL (the base URL, e.g. http://localhost:11434) |

## Endpoints

| method | path | description |
|---|---|---|
| GET | /healthz | public health probe |
| GET | / | service banner |
| GET | /v1/models | supported models and per-1k-token costs |
| POST | /v1/chat/completions | OpenAI-compatible chat (stream supported) |
| POST | /v1/embeddings | OpenAI-compatible embeddings |
| GET | /v1/usage | in-memory call/token/cost totals |
| GET | /v1/health/providers | configured / reachable provider status |

## curl examples

```bash
# health (public)
curl http://localhost:8089/healthz

# banner
curl -H "x-vf-token: dev-token-change-me" http://localhost:8089/

# models
curl -H "x-vf-token: dev-token-change-me" http://localhost:8089/v1/models

# chat completion
curl -X POST http://localhost:8089/v1/chat/completions \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"temperature":0.2}'

# streaming chat
curl -N -X POST http://localhost:8089/v1/chat/completions \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'

# embeddings
curl -X POST http://localhost:8089/v1/embeddings \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"model":"text-embedding-3-small","input":"hello world"}'

# usage
curl -H "x-vf-token: dev-token-change-me" http://localhost:8089/v1/usage

# provider health
curl -H "x-vf-token: dev-token-change-me" http://localhost:8089/v1/health/providers
```

## Behaviour

- No credential for the requested model's provider -> `503 no_provider_configured`.
- Unknown model -> `400 model_not_found`; embedding model used for chat -> `400 model_not_chat`.
- Provider HTTP failure -> `502 provider_error` and the upstream status is included in the message.
- Provider without an embeddings endpoint -> `501 embeddings_unsupported`.
- Chat responses always include `vf.provider`, `vf.cost_usd` (0 when the model has no cost entry)
  and `vf.latency_ms`. Anthropic/Gemini requests are translated to their native payloads and
  their replies are mapped back to the OpenAI response shape.
- `stream:true` proxies OpenAI/OpenRouter SSE directly; other providers are translated into an
  OpenAI-style SSE stream.

Base URLs can be overridden for local testing with `VF_ROUTER_OPENAI_BASE_URL`,
`VF_ROUTER_ANTHROPIC_BASE_URL`, `VF_ROUTER_GEMINI_BASE_URL` and
`VF_ROUTER_OPENROUTER_BASE_URL`.

## Tests

```bash
node test.mjs
```

The test spins up a fake keychain and a fake provider upstream; no keys or internet required.
