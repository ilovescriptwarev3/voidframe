import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const SERVICE = 'panel';
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 5173);
const SERVICE_TOKEN = process.env.VF_SERVICE_TOKEN || 'dev-token-change-me';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT = process.env.GITHUB_REDIRECT || `http://localhost:${PORT}/auth/github/callback`;
const SESSION_COOKIE = 'vf_session';
const STATE_COOKIE = 'vf_state';
const SESSION_TTL_S = 60 * 60 * 24 * 30;
const startedAt = Date.now();
const BODY_LIMIT = 5 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SERVICE_NAMES = ['apex', 'keychain', 'lens', 'vault', 'router', 'forge', 'crawler', 'panel'];

function serviceBase(name) {
  const envMap = {
    apex: 'APEX_URL',
    keychain: 'KEYCHAIN_URL',
    lens: 'LENS_URL',
    vault: 'VAULT_URL',
    router: 'ROUTER_URL',
    forge: 'FORGE_URL',
    crawler: 'CRAWLER_URL',
    panel: 'PANEL_URL',
  };
  const defaults = {
    apex: 'http://127.0.0.1:8088',
    keychain: 'http://127.0.0.1:8087',
    lens: 'http://127.0.0.1:8086',
    vault: 'http://127.0.0.1:8085',
    router: 'http://127.0.0.1:8089',
    forge: 'http://127.0.0.1:8000',
    crawler: 'http://127.0.0.1:3000',
    panel: 'http://127.0.0.1:5173',
  };
  const explicit = envMap[name] && process.env[envMap[name]];
  return (explicit || defaults[name]).replace(/\/+$/, '');
}

function forwardHeaders(req, extra = {}) {
  const headers = {};
  for (const name of ['authorization', 'x-vf-token', 'content-type', 'accept']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  return { ...headers, ...extra };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxy(req, res, base, targetPath, extraHeaders = {}) {
  const method = req.method || 'GET';
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch {
      return json(res, 413, { error: { code: 'payload_too_large', message: 'Request body is too large.' } });
    }
  }
  try {
    const upstream = await fetch(`${base}${targetPath}`, {
      method,
      headers: forwardHeaders(req, extraHeaders),
      body: body && body.length ? body : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const headers = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
    for (const name of ['retry-after', 'cache-control']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    res.end(method === 'HEAD' ? undefined : buffer);
  } catch (err) {
    json(res, 502, {
      error: { code: 'upstream_unavailable', message: `Could not reach ${targetPath}: ${err.message}` },
    });
  }
}

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  return bits.join('; ');
}

function sessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || null;
}

async function apexJson(method, path, body, token) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const upstream = await fetch(`${serviceBase('apex')}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await upstream.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: { code: 'bad_upstream', message: text.slice(0, 200) } };
  }
  return { status: upstream.status, body: parsed };
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

async function finishLogin(res, result) {
  if (result.status >= 400 || !result.body || !result.body.token) {
    return json(res, result.status || 400, result.body || {
      error: { code: 'login_failed', message: 'Could not sign you in.' },
    });
  }
  const { token, user_id, email } = result.body;
  res.setHeader('set-cookie', cookie(SESSION_COOKIE, token, SESSION_TTL_S));
  return json(res, 200, { user: { user_id, email } });
}

async function signIn(req, res, kind) {
  const body = await readJson(req);
  if (body === null) return json(res, 400, { error: { code: 'invalid_json', message: 'Body must be JSON.' } });
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return json(res, 400, { error: { code: 'missing_fields', message: 'Email and password are required.' } });
  }
  try {
    const result = await apexJson('POST', `/v1/auth/${kind}`, { email, password });
    return finishLogin(res, result);
  } catch (err) {
    return json(res, 502, {
      error: { code: 'apex_unavailable', message: `Apex is not reachable: ${err.message}` },
    });
  }
}

async function githubProfile(accessToken) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'voidframe-panel', authorization: `Bearer ${accessToken}` };
  const userRes = await fetch('https://api.github.com/user', { headers, signal: AbortSignal.timeout(15000) });
  if (!userRes.ok) {
    const status = userRes.status === 401 ? 401 : 502;
    throw Object.assign(new Error(`GitHub rejected the token (${userRes.status}).`), { status });
  }
  const user = await userRes.json();
  let email = user.email || null;
  if (!email) {
    try {
      const listRes = await fetch('https://api.github.com/user/emails', { headers, signal: AbortSignal.timeout(10000) });
      if (listRes.ok) {
        const emails = await listRes.json();
        const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) : null;
        if (primary) email = primary.email;
      }
    } catch {}
  }
  return {
    github_id: String(user.id),
    login: user.login,
    name: user.name || null,
    avatar_url: user.avatar_url || null,
    email,
  };
}

async function provision(profile) {
  const upstream = await fetch(`${serviceBase('apex')}/v1/auth/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vf-token': SERVICE_TOKEN },
    body: JSON.stringify(profile),
    signal: AbortSignal.timeout(15000),
  });
  const text = await upstream.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: upstream.status, body };
}

async function githubTokenLogin(req, res) {
  const body = await readJson(req);
  if (body === null) return json(res, 400, { error: { code: 'invalid_json', message: 'Body must be JSON.' } });
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return json(res, 400, { error: { code: 'missing_token', message: 'A GitHub token is required.' } });
  try {
    const profile = await githubProfile(token);
    return finishLogin(res, await provision(profile));
  } catch (err) {
    return json(res, err.status || 502, { error: { code: 'github_error', message: err.message } });
  }
}

async function statusAll() {
  return Promise.all(
    SERVICE_NAMES.map(async (name) => {
      const t0 = Date.now();
      try {
        const res = await fetch(`${serviceBase(name)}/healthz`, { signal: AbortSignal.timeout(1500) });
        const body = await res.json().catch(() => ({}));
        return { name, ok: res.ok && body.status === 'ok', ms: Date.now() - t0, version: body.version || null };
      } catch {
        return { name, ok: false, ms: Date.now() - t0, version: null };
      }
    }),
  );
}

function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let rel;
  try {
    rel = decodeURIComponent(path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  } catch {
    return false;
  }
  const root = resolve(PUBLIC_DIR);
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) return false;
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const body = readFileSync(full);
  res.writeHead(200, {
    'content-type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  res.on('finish', () => {
    process.stdout.write(
      JSON.stringify({
        t: new Date().toISOString(),
        svc: SERVICE,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - started,
      }) + '\n',
    );
  });

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization,x-vf-token',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/healthz') {
      json(res, 200, {
        service: SERVICE,
        status: 'ok',
        version: VERSION,
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }

    // ── auth ─────────────────────────────────────────────
    if (req.method === 'POST' && path === '/auth/register') return void (await signIn(req, res, 'register'));
    if (req.method === 'POST' && path === '/auth/login') return void (await signIn(req, res, 'login'));
    if (req.method === 'POST' && path === '/auth/logout') {
      res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', 0));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && path === '/auth/session') {
      const token = sessionToken(req);
      if (!token) return json(res, 401, { error: { code: 'no_session', message: 'Not signed in.' } });
      try {
        const me = await apexJson('GET', '/v1/me', undefined, token);
        if (me.status !== 200) {
          res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', 0));
          return json(res, 401, { error: { code: 'no_session', message: 'Session expired.' } });
        }
        return json(res, 200, { user: me.body });
      } catch (err) {
        return json(res, 502, { error: { code: 'apex_unavailable', message: err.message } });
      }
    }

    if (req.method === 'GET' && path === '/auth/providers') {
      return json(res, 200, {
        password: true,
        github: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
        github_token: true,
      });
    }

    if (req.method === 'GET' && path === '/auth/github/start') {
      if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
        return redirect(res, '/#/signin?github=config');
      }
      const state = randomBytes(16).toString('hex');
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.searchParams.set('client_id', GITHUB_CLIENT_ID);
      authorize.searchParams.set('redirect_uri', GITHUB_REDIRECT);
      authorize.searchParams.set('scope', 'read:user user:email');
      authorize.searchParams.set('state', state);
      return redirect(res, authorize.toString(), { 'set-cookie': cookie(STATE_COOKIE, state, 600) });
    }

    if (req.method === 'GET' && path === '/auth/github/callback') {
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      const expected = parseCookies(req)[STATE_COOKIE];
      if (!code || !state || !expected || state !== expected) {
        return redirect(res, '/#/signin?github=state');
      }
      try {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: GITHUB_REDIRECT,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const tokenBody = await tokenRes.json().catch(() => ({}));
        if (!tokenBody.access_token) return redirect(res, '/#/signin?github=denied');
        const profile = await githubProfile(tokenBody.access_token);
        const result = await provision(profile);
        if (result.status >= 400 || !result.body?.token) return redirect(res, '/#/signin?github=failed');
        return redirect(res, '/#/overview', {
          'set-cookie': [cookie(SESSION_COOKIE, result.body.token, SESSION_TTL_S), cookie(STATE_COOKIE, '', 0)],
        });
      } catch {
        return redirect(res, '/#/signin?github=failed');
      }
    }

    if (req.method === 'POST' && path === '/auth/github/token') return void (await githubTokenLogin(req, res));

    // ── public status ────────────────────────────────────
    if (req.method === 'GET' && path === '/status') {
      const services = await statusAll();
      return json(res, 200, { services });
    }

    // ── proxies ──────────────────────────────────────────
    if (path.startsWith('/api/')) {
      const rest = path.slice(4) || '/';
      const token = sessionToken(req);
      const extra = token && !req.headers.authorization && !req.headers['x-vf-token']
        ? { authorization: `Bearer ${token}` }
        : {};
      await proxy(req, res, serviceBase('apex'), rest + url.search, extra);
      return;
    }

    const svcMatch = path.match(/^\/svc\/([a-z]+)(\/.*)?$/);
    if (svcMatch) {
      const name = svcMatch[1];
      if (!SERVICE_NAMES.includes(name)) {
        json(res, 404, { error: { code: 'unknown_service', message: `Unknown service "${name}".` } });
        return;
      }
      const rest = svcMatch[2] || '/';
      // /svc/* forwards the shared service token, so it must never be reachable
      // without a signed-in user. Validate the session against apex rather than
      // trusting that a vf_session cookie was merely present.
      const session = sessionToken(req);
      if (!session) {
        json(res, 401, { error: { code: 'no_session', message: 'Sign in to read service data.' } });
        return;
      }
      try {
        const me = await apexJson('GET', '/v1/me', undefined, session);
        if (me.status !== 200) {
          json(res, 401, { error: { code: 'no_session', message: 'Session expired.' } });
          return;
        }
      } catch (err) {
        json(res, 502, { error: { code: 'apex_unavailable', message: err.message } });
        return;
      }
      const extra = name === 'apex' || req.headers['x-vf-token'] ? {} : { 'x-vf-token': SERVICE_TOKEN };
      await proxy(req, res, serviceBase(name), rest + url.search, extra);
      return;
    }

    if (serveStatic(req, res, path)) return;

    json(res, 404, { error: { code: 'not_found', message: 'Route not found.' } });
  } catch (err) {
    if (!res.headersSent) {
      json(res, 500, { error: { code: 'internal_error', message: 'Unexpected server error.' } });
    } else {
      try {
        res.end();
      } catch {}
    }
  }
});

server.listen(PORT, () => {
  const actual = server.address()?.port ?? PORT;
  process.stdout.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: SERVICE,
      level: 'info',
      event: 'listening',
      fields: { port: actual, apex: serviceBase('apex'), github_oauth: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) },
    }) + '\n',
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
