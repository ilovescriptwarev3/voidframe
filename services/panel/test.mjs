import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];
let server = null;
let stub = null;
let stubPort = 0;
const seen = [];

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

function startStub() {
  stub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      const send = (status, payload) => {
        const data = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
        res.end(data);
      };
      if (req.url === '/healthz') {
        return send(200, { service: 'stub', status: 'ok', version: '0.1.0', uptime_s: 1 });
      }
      if (req.url === '/v1/unauthorized') {
        return send(401, { error: { code: 'unauthorized', message: 'no token' } });
      }
      if (req.url === '/v1/auth/login' || req.url === '/v1/auth/register') {
        return send(200, {
          user_id: 'usr_test',
          email: (body && body.email) || 'test@voidframe.local',
          token: 'session-token-1234567890',
        });
      }
      if (req.url === '/v1/me' && req.headers.authorization === 'Bearer session-token-1234567890') {
        return send(200, { user_id: 'usr_test', email: 'test@voidframe.local', plan: 'free', usage: {} });
      }
      // Model apex: a forged session token is unauthorized, not a generic 200.
      if (req.url === '/v1/me' && req.headers.authorization === 'Bearer forged-token') {
        return send(401, { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } });
      }
      return send(200, {
        proxied: {
          url: req.url,
          method: req.method,
          authorization: req.headers.authorization || null,
          token: req.headers['x-vf-token'] || null,
          body,
        },
      });
    });
  });
  return new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => {
      stubPort = stub.address().port;
      resolve();
    });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const base = `http://127.0.0.1:${stubPort}`;
    const env = {
      ...process.env,
      PORT: '0',
      APEX_URL: base,
      KEYCHAIN_URL: base,
      VAULT_URL: base,
      LENS_URL: base,
      ROUTER_URL: base,
      FORGE_URL: base,
      CRAWLER_URL: base,
      PANEL_URL: base,
      VF_SERVICE_TOKEN: 'svc-token',
    };
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: here,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('server did not report a listening port in 15s'));
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.event === 'listening' && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ child, port: entry.fields.port });
          }
        } catch {}
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

async function call(method, path, body, headers = {}, extra = {}) {
  const opts = { method, headers: { ...headers }, ...extra };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function main() {
  await startStub();
  server = await startServer();

  await check('GET /healthz is public and well-formed', async () => {
    const r = await call('GET', '/healthz');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.service === 'panel', 'service');
    assert(r.body.status === 'ok' && r.body.version === '0.1.0', 'status/version');
    assert(typeof r.body.uptime_s === 'number', 'uptime_s');
  });

  await check('the dashboard serves all six screens without a CDN', async () => {
    const r = await call('GET', '/');
    assert(r.status === 200, `status ${r.status}`);
    assert((r.headers.get('content-type') || '').includes('text/html'), 'content type');
    const lower = r.text.toLowerCase();
    for (const word of ['overview', 'missions', 'chat', 'services', 'secrets', 'search']) {
      assert(lower.includes(word), `missing screen "${word}"`);
    }
    for (const color of ['#0c0c0b', '#141413', '#252523', '#7fff8c']) {
      assert(lower.includes(color), `missing palette ${color}`);
    }
    assert(!/https?:\/\/(cdn|unpkg|cdnjs|jsdelivr|fonts\.googleapis)/i.test(r.text), 'loads a CDN');
    assert(!/\bvw\b|\bvh\b/.test(r.text), 'uses viewport units');
  });

  await check('GET /api/* proxies to apex and forwards only the user token', async () => {
    const r = await call('GET', '/api/v1/me', undefined, { authorization: 'Bearer user-token' });
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.proxied.url === '/v1/me', `path ${r.body.proxied.url}`);
    assert(r.body.proxied.authorization === 'Bearer user-token', 'authorization not forwarded');
    assert(r.body.proxied.token === null, 'panel added a service token');
  });

  await check('upstream error statuses pass through', async () => {
    const r = await call('GET', '/api/v1/unauthorized', undefined, { authorization: 'Bearer user-token' });
    assert(r.status === 401, `status ${r.status}`);
    assert(r.body.error.code === 'unauthorized', 'error body');
  });

  await check('POST bodies and query strings are forwarded intact', async () => {
    const r = await call('POST', '/api/v1/chat?trace=1', { model: 'gpt-4o' }, { authorization: 'Bearer user-token' });
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.proxied.method === 'POST', 'method');
    assert(r.body.proxied.url === '/v1/chat?trace=1', `url ${r.body.proxied.url}`);
    assert(r.body.proxied.body.model === 'gpt-4o', 'body');
  });

  // /svc/* forwards the shared service token, so it is only ever reachable for a
  // signed-in user. These four cases pin that down in both directions.
  const signedIn = { cookie: 'vf_session=session-token-1234567890' };

  await check('GET /svc/* without a session is refused', async () => {
    const r = await call('GET', '/svc/keychain/v1/secrets');
    assert(r.status === 401, `status ${r.status}`);
    assert(r.body.error && r.body.error.code === 'no_session', `code ${r.body.error && r.body.error.code}`);
  });

  await check('GET /svc/* with a forged session cookie is refused', async () => {
    const r = await call('GET', '/svc/vault/v1/collections', undefined, { cookie: 'vf_session=forged-token' });
    assert(r.status === 401, `status ${r.status}`);
  });

  await check('GET /svc/keychain/* proxies to keychain with the service token when signed in', async () => {
    const r = await call('GET', '/svc/keychain/v1/secrets', undefined, signedIn);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.proxied.url === '/v1/secrets', `path ${r.body.proxied.url}`);
    assert(r.body.proxied.token === 'svc-token', 'service token not forwarded');
  });

  await check('POST /svc/vault/* forwards search bodies when signed in', async () => {
    const r = await call(
      'POST',
      '/svc/vault/v1/search',
      { query: 'rate limiting', limit: 5 },
      signedIn,
    );
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.proxied.url === '/v1/search', 'path');
    assert(r.body.proxied.body.query === 'rate limiting', 'query');
  });

  await check('email sign-in sets an httpOnly session cookie', async () => {
    const r = await call('POST', '/auth/login', { email: 'test@voidframe.local', password: 'correct-horse-9' });
    assert(r.status === 200, `status ${r.status}: ${r.text}`);
    assert(r.body.user && r.body.user.email === 'test@voidframe.local', 'user body');
    const setCookie = r.headers.get('set-cookie') || '';
    assert(/vf_session=/.test(setCookie), 'no session cookie');
    assert(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), 'cookie flags');
  });

  await check('the session cookie authenticates /api and /auth/session', async () => {
    const login = await call('POST', '/auth/login', { email: 'test@voidframe.local', password: 'correct-horse-9' });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert(cookie, 'no cookie to reuse');

    const session = await call('GET', '/auth/session', undefined, { cookie });
    assert(session.status === 200, `session ${session.status}`);
    assert(session.body.user.email === 'test@voidframe.local', 'session user');

    const me = await call('GET', '/api/v1/me', undefined, { cookie });
    assert(me.status === 200, `api ${me.status}`);
    assert(me.body.user_id === 'usr_test', 'cookie token not forwarded to apex');
  });

  await check('signed-out sessions are refused and logout clears the cookie', async () => {
    let r = await call('GET', '/auth/session');
    assert(r.status === 401, `no cookie should be 401, got ${r.status}`);
    r = await call('POST', '/auth/logout');
    assert(r.status === 200, `logout ${r.status}`);
    assert(/Max-Age=0/.test(r.headers.get('set-cookie') || ''), 'cookie not cleared');
  });

  await check('auth providers and unconfigured GitHub start', async () => {
    const p = await call('GET', '/auth/providers');
    assert(p.status === 200 && p.body.password === true, 'password provider');
    assert(p.body.github === false, 'github should be off without env');
    const g = await call('GET', '/auth/github/start', undefined, {}, { redirect: 'manual' });
    assert(g.status === 302, `start ${g.status}`);
    assert((g.headers.get('location') || '').includes('github=config'), `location ${g.headers.get('location')}`);
  });

  await check('GET /status reports every service', async () => {
    const r = await call('GET', '/status');
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.services) && r.body.services.length === 8, 'service count');
    assert(r.body.services.every((s) => s.ok), 'a service reported down');
    assert(r.body.services.some((s) => s.name === 'panel'), 'panel missing');
  });

  await check('unknown services are rejected without proxying', async () => {
    const before = seen.length;
    const r = await call('GET', '/svc/wizard/v1/anything');
    assert(r.status === 404, `status ${r.status}`);
    assert(r.body.error.code === 'unknown_service', 'error code');
    assert(seen.length === before, 'request reached the upstream');
  });

  await check('static traversal and unknown files are refused', async () => {    let r = await call('GET', '/../src/server.js');
    assert(r.status === 404, `traversal status ${r.status}`);
    assert(!r.text.includes('createServer'), 'server source leaked');
    r = await call('GET', '/missing.html');
    assert(r.status === 404 && r.body.error.code === 'not_found', 'missing file');
  });
}

async function stopServer() {
  if (!server) return;
  const child = server.child;
  server = null;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

main()
  .catch((err) => {
    failures.push('harness');
    console.error(`FAIL harness: ${err.message}`);
  })
  .finally(async () => {
    await stopServer();
    if (stub) await new Promise((r) => stub.close(r));
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  });
