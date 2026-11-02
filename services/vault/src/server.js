import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cors, fail, json, readBody, requireToken, send } from './http.js';
import * as store from './store.js';

const SERVICE = 'vault';
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 8085);
const startedAt = Date.now();

if (!process.env.VF_SERVICE_TOKEN) {
  process.stderr.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: SERVICE,
      level: 'warn',
      event: 'missing_service_token',
      fields: { message: 'VF_SERVICE_TOKEN is not set; using the development default.' },
    }) + '\n',
  );
}

function report(level, event, fields = {}) {
  const base = process.env.LENS_URL;
  if (!base) return;
  fetch(`${base.replace(/\/+$/, '')}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: SERVICE, level, event, fields }),
    signal: AbortSignal.timeout(300),
  }).catch(() => {});
}

function pathOf(raw) {
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    return String(raw || '');
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    send(res, 204);
    return;
  }

  if (method === 'GET' && path === '/healthz') {
    json(res, 200, {
      service: SERVICE,
      status: 'ok',
      version: VERSION,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    });
    return;
  }

  if (!requireToken(req, res)) return;

  if (method === 'GET' && path === '/') {
    json(res, 200, { service: SERVICE, docs: '/healthz' });
    return;
  }

  if (method === 'POST' && path === '/v1/collections') {
    const body = await readBody(req);
    if (!nonEmptyString(body.name) || body.name.length > 256) {
      return fail(res, 400, 'invalid_name', 'name must be a non-empty string of at most 256 characters.');
    }
    const collection = store.createCollection(body.name);
    report('info', 'collection_created', { name: collection.name });
    return json(res, 201, { name: collection.name });
  }

  if (method === 'GET' && path === '/v1/collections') {
    return json(res, 200, { collections: store.listCollections() });
  }

  if (method === 'POST' && path === '/v1/documents') {
    const body = await readBody(req);
    if (!nonEmptyString(body.collection)) {
      return fail(res, 400, 'invalid_collection', 'collection must be a non-empty string.');
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return fail(res, 400, 'invalid_text', 'text must be a non-empty string.');
    }
    if (body.id !== undefined && !nonEmptyString(body.id)) {
      return fail(res, 400, 'invalid_id', 'id must be a non-empty string when provided.');
    }
    if (body.metadata !== undefined && !plainObject(body.metadata)) {
      return fail(res, 400, 'invalid_metadata', 'metadata must be an object when provided.');
    }
    if (body.embedding !== undefined && !numberArray(body.embedding)) {
      return fail(res, 400, 'invalid_embedding', 'embedding must be a non-empty array of finite numbers.');
    }

    const id = body.id || randomUUID();
    const chunks = store.chunkText(body.text);
    const result = store.putDocument({
      id,
      collection: body.collection,
      text: body.text,
      metadata: body.metadata,
      embedding: body.embedding,
      chunks,
    });
    report('info', 'document_upserted', { id: result.id, collection: result.collection, chunks: result.chunks });
    return json(res, 201, { id: result.id, collection: result.collection, chunks: result.chunks });
  }

  if (method === 'POST' && path === '/v1/search') {
    const body = await readBody(req);
    if (typeof body.query !== 'string') {
      return fail(res, 400, 'invalid_query', 'query must be a string.');
    }
    if (body.collection !== undefined && !nonEmptyString(body.collection)) {
      return fail(res, 400, 'invalid_collection', 'collection must be a non-empty string when provided.');
    }
    if (body.query_embedding !== undefined && !numberArray(body.query_embedding)) {
      return fail(res, 400, 'invalid_embedding', 'query_embedding must be a non-empty array of finite numbers.');
    }
    if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1)) {
      return fail(res, 400, 'invalid_limit', 'limit must be a positive integer.');
    }
    if (body.query_embedding === undefined && !body.query.trim()) {
      return fail(res, 400, 'invalid_query', 'query must not be empty without a query_embedding.');
    }

    const limit = Math.min(body.limit || 8, 100);
    const results =
      body.query_embedding !== undefined
        ? store.searchEmbedding({
            collection: body.collection,
            queryEmbedding: body.query_embedding,
            limit,
          })
        : store.searchKeyword({
            collection: body.collection,
            query: body.query,
            limit,
          });
    return json(res, 200, { results });
  }

  const documentMatch = path.match(/^\/v1\/documents\/([^/]+)$/);
  if (documentMatch) {
    let id;
    try {
      id = decodeURIComponent(documentMatch[1]);
    } catch {
      return fail(res, 400, 'invalid_id', 'Document id is not valid URL encoding.');
    }
    if (method === 'GET') {
      const document = store.getDocument(id);
      if (!document) return fail(res, 404, 'document_not_found', `Document "${id}" was not found.`);
      return json(res, 200, document);
    }
    if (method === 'DELETE') {
      if (!store.deleteDocument(id)) {
        return fail(res, 404, 'document_not_found', `Document "${id}" was not found.`);
      }
      report('info', 'document_deleted', { id });
      return send(res, 204);
    }
    return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
  }

  if (method === 'POST' && path === '/v1/edges') {
    const body = await readBody(req);
    if (!nonEmptyString(body.from)) {
      return fail(res, 400, 'invalid_from', 'from must be a non-empty string.');
    }
    if (!nonEmptyString(body.to)) {
      return fail(res, 400, 'invalid_to', 'to must be a non-empty string.');
    }
    if (!nonEmptyString(body.kind)) {
      return fail(res, 400, 'invalid_kind', 'kind must be a non-empty string.');
    }
    if (body.metadata !== undefined && !plainObject(body.metadata)) {
      return fail(res, 400, 'invalid_metadata', 'metadata must be an object when provided.');
    }
    const edge = store.addEdge({
      from: body.from,
      to: body.to,
      kind: body.kind,
      metadata: body.metadata,
    });
    report('info', 'edge_added', { from: edge.from, to: edge.to, kind: edge.kind });
    return json(res, 201, edge);
  }

  if (method === 'GET' && path === '/v1/graph') {
    const node = url.searchParams.get('node');
    if (!nonEmptyString(node)) {
      return fail(res, 400, 'invalid_node', 'node query parameter is required.');
    }
    const rawDepth = url.searchParams.get('depth');
    let depth = 2;
    if (rawDepth !== null && rawDepth !== '') {
      if (!/^\d+$/.test(rawDepth)) {
        return fail(res, 400, 'invalid_depth', 'depth must be a non-negative integer.');
      }
      depth = Math.min(Number(rawDepth), 4);
    }
    return json(res, 200, store.getGraph(node, depth));
  }

  return fail(res, 404, 'not_found', 'Route not found.');
}

const server = createServer((req, res) => {
  const started = Date.now();
  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    const ms = Date.now() - started;
    const path = pathOf(req.url);
    process.stdout.write(
      JSON.stringify({
        t: new Date().toISOString(),
        svc: SERVICE,
        method: req.method,
        path,
        status: res.statusCode,
        ms,
      }) + '\n',
    );
    if (path !== '/healthz') {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      report(level, 'http_request', { method: req.method, path, status: res.statusCode, ms });
    }
  };
  res.on('finish', log);
  res.on('close', log);

  cors(res);
  route(req, res).catch((err) => {
    if (!res.headersSent) {
      fail(
        res,
        err.status || 500,
        err.code || 'internal_error',
        err.status ? err.message : 'Unexpected server error.',
      );
    } else {
      try {
        res.end();
      } catch {}
    }
    if (!err.status) {
      process.stderr.write(
        JSON.stringify({
          t: new Date().toISOString(),
          svc: SERVICE,
          level: 'error',
          event: 'unhandled_error',
          fields: { message: String(err && err.message) },
        }) + '\n',
      );
    }
  });
});

server.listen(PORT, () => {
  process.stdout.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: SERVICE,
      level: 'info',
      event: 'listening',
      fields: { port: PORT },
    }) + '\n',
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
