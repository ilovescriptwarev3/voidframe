import { createServer } from 'node:http';
import { cors, fail, json, readBody, requireToken, send } from './http.js';
import * as store from './store.js';

const SERVICE = 'keychain';
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 8087);
const startedAt = Date.now();
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

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
  const target = `${base.replace(/\/+$/, '')}/ingest`;
  fetch(target, {
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

  if (method === 'POST' && path === '/v1/secrets') {
    const body = await readBody(req);
    const { name, value, meta } = body;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return fail(res, 400, 'invalid_name', 'name must be 1-128 characters of letters, digits, dot, underscore, colon, at or dash.');
    }
    if (typeof value !== 'string') {
      return fail(res, 400, 'invalid_value', 'value must be a string.');
    }
    if (meta !== undefined && (meta === null || typeof meta !== 'object' || Array.isArray(meta))) {
      return fail(res, 400, 'invalid_meta', 'meta must be an object when provided.');
    }
    const record = store.putSecret(name, value, meta);
    report('info', 'secret_written', { name });
    json(res, 201, { name: record.name, created_at: record.created_at });
    return;
  }

  if (method === 'GET' && path === '/v1/secrets') {
    json(res, 200, { secrets: store.listSecrets() });
    return;
  }

  if (method === 'POST' && path === '/v1/redact') {
    const body = await readBody(req);
    if (typeof body.text !== 'string') {
      return fail(res, 400, 'invalid_text', 'text must be a string.');
    }
    const text = store.redactText(body.text);
    report('info', 'redacted', { chars: body.text.length });
    json(res, 200, { text });
    return;
  }

  const rotateMatch = path.match(/^\/v1\/secrets\/([^/]+)\/rotate$/);
  if (rotateMatch) {
    let name;
    try {
      name = decodeURIComponent(rotateMatch[1]);
    } catch {
      return fail(res, 400, 'invalid_name', 'Secret name is not valid URL encoding.');
    }
    if (method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
    const body = await readBody(req);
    if (typeof body.value !== 'string') {
      return fail(res, 400, 'invalid_value', 'value must be a string.');
    }
    const record = store.rotateSecret(name, body.value);
    if (!record) return fail(res, 404, 'secret_not_found', `Secret "${name}" was not found.`);
    report('info', 'secret_rotated', { name });
    json(res, 200, { name: record.name, updated_at: record.updated_at });
    return;
  }

  const secretMatch = path.match(/^\/v1\/secrets\/([^/]+)$/);
  if (secretMatch) {
    let name;
    try {
      name = decodeURIComponent(secretMatch[1]);
    } catch {
      return fail(res, 400, 'invalid_name', 'Secret name is not valid URL encoding.');
    }
    if (method === 'GET') {
      const record = store.getSecret(name);
      if (!record) return fail(res, 404, 'secret_not_found', `Secret "${name}" was not found.`);
      return json(res, 200, record);
    }
    if (method === 'DELETE') {
      store.deleteSecret(name);
      report('info', 'secret_deleted', { name });
      return send(res, 204);
    }
    return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
  }

  return fail(res, 404, 'not_found', 'Route not found.');
}

store.init();

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
      report(level, 'http_request', {
        method: req.method,
        path,
        status: res.statusCode,
        ms,
      });
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
  const actual = server.address()?.port ?? PORT;
  process.stdout.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: SERVICE,
      level: 'info',
      event: 'listening',
      fields: { port: actual },
    }) + '\n',
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
