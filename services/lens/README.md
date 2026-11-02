# lens (:8086)

Observability for Voidframe: log and metric ingest, filters, service health, alert rules and a
live SSE stream. State lives in memory (5 000 log lines, 2 000 metric samples); alert rules
persist to `data/lens.json`.

Default port `8086` (override with `PORT`). All routes except `GET /healthz` and
`POST /ingest` require `x-vf-token: $VF_SERVICE_TOKEN`.

Base URL below assumes `http://localhost:8086` and `TOKEN=dev-token-change-me`.

## Endpoints

| method | path | description |
|---|---|---|
| GET | /healthz | public health probe |
| POST | /ingest | public log ingestion (202) |
| GET | / | service banner |
| GET | /v1/logs | filter logs by service, level, q, limit |
| POST | /v1/metrics | ingest a metric sample (202) |
| GET | /v1/metrics | query metric series by name and since_s |
| GET | /v1/services | per-service line counts and health |
| POST | /v1/alerts | create an alert rule |
| GET | /v1/alerts | list alert rules |
| DELETE | /v1/alerts/:id | delete an alert rule |
| GET | /v1/alerts/firing | currently firing alerts |
| GET | /v1/stream | live SSE stream of log/metric/alert events |

## curl examples

```bash
# health (public)
curl http://localhost:8086/healthz

# ingest a log line (public)
curl -X POST http://localhost:8086/ingest \
  -H "content-type: application/json" \
  -d '{"service":"apex","level":"info","event":"booted","fields":{"build":"1"}}'

# banner
curl -H "x-vf-token: dev-token-change-me" http://localhost:8086/

# filter logs
curl -H "x-vf-token: dev-token-change-me" \
  "http://localhost:8086/v1/logs?service=apex&level=info&q=booted&limit=50"

# ingest a metric
curl -X POST http://localhost:8086/v1/metrics \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"name":"cpu","value":42.5,"tags":{"host":"local"}}'

# query metrics
curl -H "x-vf-token: dev-token-change-me" \
  "http://localhost:8086/v1/metrics?name=cpu&since_s=300"

# service health
curl -H "x-vf-token: dev-token-change-me" http://localhost:8086/v1/services

# create an alert
curl -X POST http://localhost:8086/v1/alerts \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"name":"cpu high","metric":"cpu","op":"gt","threshold":90,"window_s":60}'

# list / firing / delete alerts
curl -H "x-vf-token: dev-token-change-me" http://localhost:8086/v1/alerts
curl -H "x-vf-token: dev-token-change-me" http://localhost:8086/v1/alerts/firing
curl -X DELETE -H "x-vf-token: dev-token-change-me" \
  http://localhost:8086/v1/alerts/<id>

# live stream
curl -N -H "x-vf-token: dev-token-change-me" http://localhost:8086/v1/stream
```

## Alert evaluation

Alerts are evaluated after every log/metric ingest and on `GET /v1/alerts/firing`.
A metric alert uses the mean of matching samples in `window_s`. An alert without a metric uses
the count of `error` log lines for the given service (or globally) in `window_s`. `gt` fires
when the value is strictly greater, `lt` when strictly less. Newly firing alerts are pushed
over SSE as `{"type":"alert","alert":{...},"value":n,"since":"..."}`.

## Tests

```bash
node test.mjs
```
