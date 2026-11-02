# vault (:8085)

Documents, chunks, hybrid search and a small knowledge graph, backed by SQLite
(`node:sqlite`) at `data/vault.db`.

Default port `8085` (override with `PORT`). All routes except `GET /healthz` require
`x-vf-token: $VF_SERVICE_TOKEN`.

Base URL below assumes `http://localhost:8085` and `TOKEN=dev-token-change-me`.

## Endpoints

| method | path | description |
|---|---|---|
| GET | /healthz | public health probe |
| GET | / | service banner |
| POST | /v1/collections | create a collection |
| GET | /v1/collections | list collections with document counts |
| POST | /v1/documents | create/upsert a document and chunk it |
| GET | /v1/documents/:id | read a document with its chunks |
| DELETE | /v1/documents/:id | delete a document and its chunks |
| POST | /v1/search | cosine (embedding) or BM25-ish keyword search |
| POST | /v1/edges | add a graph edge |
| GET | /v1/graph | BFS neighbourhood of a node (depth <= 4) |

## curl examples

```bash
# health (public)
curl http://localhost:8085/healthz

# banner
curl -H "x-vf-token: dev-token-change-me" http://localhost:8085/

# create collection
curl -X POST http://localhost:8085/v1/collections \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"name":"notes"}'

# list collections
curl -H "x-vf-token: dev-token-change-me" http://localhost:8085/v1/collections

# add document (text is chunked at ~900 chars, max 32 chunks)
curl -X POST http://localhost:8085/v1/documents \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"id":"doc1","collection":"notes","text":"The quick brown fox.","metadata":{"source":"test"},"embedding":[1,0,0]}'

# get document
curl -H "x-vf-token: dev-token-change-me" http://localhost:8085/v1/documents/doc1

# keyword search (BM25-ish tf-idf)
curl -X POST http://localhost:8085/v1/search \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"collection":"notes","query":"quick fox","limit":8}'

# vector search (cosine)
curl -X POST http://localhost:8085/v1/search \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"collection":"notes","query":"","query_embedding":[0.9,0.1,0],"limit":5}'

# delete document
curl -X DELETE -H "x-vf-token: dev-token-change-me" \
  http://localhost:8085/v1/documents/doc1

# add edge
curl -X POST http://localhost:8085/v1/edges \
  -H "content-type: application/json" -H "x-vf-token: dev-token-change-me" \
  -d '{"from":"a","to":"b","kind":"links","metadata":{"weight":1}}'

# graph neighbourhood
curl -H "x-vf-token: dev-token-change-me" \
  "http://localhost:8085/v1/graph?node=a&depth=2"
```

## Search notes

With `query_embedding`, chunks are ranked by cosine similarity against their stored document
embedding. Without it, chunks are ranked with BM25 (`k1=1.2`, `b=0.75`); document frequency is
computed over the chunks in scope (the named collection, or all chunks). If a non-empty scope
has no keyword overlap, the top chunks are still returned with score `0` rather than an empty
list.

## Tests

```bash
node test.mjs
```
