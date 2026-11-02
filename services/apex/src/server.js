import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cors, fail, json, readBody } from './http.js';
import * as store from './store.js';
import { routerBase, routerComplete } from './router-client.js';
import { addStep, startWorker } from './missions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = 'apex';
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 8088);
const SERVICE_TOKEN = process.env.VF_SERVICE_TOKEN || 'dev-token-change-me';
const PANEL_DIR = process.env.PANEL_DIR || join(HERE, '..', '..', 'panel', 'public');
const startedAt = Date.now();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTONOMY = new Set(['auto', 'restricted']);
const MODES = new Set(['code', 'chat', 'work', 'agent']);
const ACTIVE = new Set(['queued', 'running', 'awaiting_approval']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const nowIso = () => new Date().toISOString();

function serviceUrl(name) {
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
  const explicit = process.env[envMap[name]];
  if (explicit) return explicit.replace(/\/+$/, '');
  const defaults = {
    apex: `http://127.0.0.1:${server.address()?.port || PORT}`,
    keychain: 'http://127.0.0.1:8087',
    lens: 'http://127.0.0.1:8086',
    vault: 'http://127.0.0.1:8085',
    router: 'http://127.0.0.1:8089',
    forge: 'http://127.0.0.1:8000',
    crawler: 'http://127.0.0.1:3000',
    panel: 'http://127.0.0.1:5173',
  };
  return defaults[name];
}

function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let rel;
  try {
    rel = decodeURIComponent(path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  } catch {
    return false;
  }
  const root = resolve(PANEL_DIR);
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

const buckets = new Map();

function rateLimit(key) {
  const limit = Number(process.env.VF_RATE_LIMIT || 60);
  const windowS = Number(process.env.VF_RATE_WINDOW_S || 60);
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= windowS * 1000) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    const retry = Math.max(1, Math.ceil((bucket.start + windowS * 1000 - now) / 1000));
    return retry;
  }
  bucket.count += 1;
  return 0;
}

function tokenOf(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-vf-token'];
  return alt ? String(alt) : null;
}

function authenticate(req) {
  const token = tokenOf(req);
  if (!token) return null;
  if (token === SERVICE_TOKEN) return { kind: 'service' };
  const user = store.userForToken(token);
  if (!user) return null;
  return { kind: 'user', user };
}

function failRate(res, retry) {
  res.setHeader('retry-after', String(retry));
  return json(res, 429, {
    error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.', retry_after_s: retry },
  });
}

async function register(req, res) {
  const retry = rateLimit(`ip:${req.socket.remoteAddress}`);
  if (retry) return failRate(res, retry);
  const body = await readBody(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!EMAIL_RE.test(email)) return fail(res, 400, 'invalid_email', 'A valid email address is required.');
  if (password.length < 8) return fail(res, 400, 'weak_password', 'Password must be at least 8 characters.');
  const created = store.createUser(email, password);
  if (created.error) return fail(res, 409, created.error, 'An account with that email already exists.');
  const token = store.createSession(created.user_id);
  json(res, 201, { user_id: created.user_id, email: created.email, token });
}

async function login(req, res) {
  const retry = rateLimit(`ip:${req.socket.remoteAddress}`);
  if (retry) return failRate(res, retry);
  const body = await readBody(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const row = email ? store.findUserByEmail(email) : null;
  if (!row || !store.verifyPassword(row, password)) {
    return fail(res, 401, 'invalid_credentials', 'Email or password is incorrect.');
  }
  const token = store.createSession(row.id);
  json(res, 200, { user_id: row.id, email: row.email, token });
}

function canSee(auth, mission) {
  if (auth.kind === 'service') return true;
  return mission.user_id === auth.user.id;
}

async function githubLogin(req, res) {
  const presented = String(req.headers['x-vf-token'] || '');
  if (presented !== SERVICE_TOKEN) {
    return fail(res, 401, 'unauthorized', 'This route is for the panel only.');
  }
  const retry = rateLimit(`ip:${req.socket.remoteAddress}`);
  if (retry) return failRate(res, retry);

  const body = await readBody(req);
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const githubId = body.github_id === undefined || body.github_id === null ? '' : String(body.github_id);
  if (!login || !githubId) return fail(res, 400, 'invalid_github_profile', 'GitHub profile is incomplete.');

  const supplied = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const email = EMAIL_RE.test(supplied) ? supplied : `${login.toLowerCase()}@users.noreply.github.com`;

  let row = store.findUserByEmail(email);
  if (!row) {
    const created = store.createUser(email, randomBytes(24).toString('hex'));
    if (created.error) return fail(res, 409, created.error, 'An account with that email already exists.');
    row = store.findUserByEmail(email);
  }
  store.setGithub(row.id, {
    id: githubId,
    login,
    name: body.name,
    avatar_url: body.avatar_url,
  });
  const token = store.createSession(row.id);
  return json(res, 200, {
    user_id: row.id,
    email: row.email,
    token,
    github: { login },
  });
}

async function serviceHealth(name, url) {
  const started = Date.now();
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return {
      name,
      url,
      ok: res.ok,
      latency_ms: Date.now() - started,
      version: body?.version || null,
    };
  } catch (err) {
    return {
      name,
      url,
      ok: false,
      latency_ms: Date.now() - started,
      version: null,
      error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable',
    };
  }
}

const HEALTH_SERVICES = ['keychain', 'lens', 'vault', 'router', 'forge', 'crawler', 'panel'];

async function panic() {
  const base = serviceUrl('forge');
  const errors = [];
  let removed = 0;
  const headers = { 'x-vf-token': SERVICE_TOKEN };
  try {
    const listRes = await fetch(`${base}/v1/sandboxes`, { headers, signal: AbortSignal.timeout(5000) });
    if (!listRes.ok) {
      errors.push(`forge list returned ${listRes.status}`);
    } else {
      const body = await listRes.json();
      const list = Array.isArray(body?.sandboxes) ? body.sandboxes : Array.isArray(body) ? body : [];
      for (const item of list) {
        const id = typeof item === 'object' && item ? item.id : item;
        try {
          const res = await fetch(`${base}/v1/sandboxes/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers,
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok || res.status === 204) removed += 1;
          else errors.push(`delete ${id}: ${res.status}`);
        } catch {
          errors.push(`delete ${id}: unreachable`);
        }
      }
    }
  } catch (err) {
    errors.push(`forge unreachable: ${err.message}`);
  }
  return { stopped: removed, sandboxes_removed: removed, ok: errors.length === 0, errors };
}

function missionSummary(m) {
  return {
    id: m.id,
    title: m.title,
    mode: m.mode,
    autonomy: m.autonomy,
    status: m.status,
    steps: m.steps.length,
    result: m.result,
    warning: m.warning,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
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

  if (!path.startsWith('/v1/')) {
    if (serveStatic(req, res, path)) return;
    if (path === '/') {
      json(res, 200, { service: SERVICE, docs: '/healthz' });
      return;
    }
    return fail(res, 404, 'not_found', 'Route not found.');
  }

  if (method === 'POST' && path === '/v1/auth/register') {
    await register(req, res);
    return;
  }
  if (method === 'POST' && path === '/v1/auth/login') {
    await login(req, res);
    return;
  }
  if (method === 'GET' && path === '/v1/auth/providers') {
    return json(res, 200, {
      password: true,
      github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    });
  }
  if (method === 'POST' && path === '/v1/auth/github') {
    await githubLogin(req, res);
    return;
  }

  const auth = authenticate(req);
  if (!auth) return fail(res, 401, 'unauthorized', 'Missing or invalid bearer token.');

  if (auth.kind === 'user') {
    const retry = rateLimit(`user:${auth.user.id}`);
    if (retry) return failRate(res, retry);
  }

  const userId = auth.kind === 'user' ? auth.user.id : null;

  if (method === 'GET' && path === '/v1/me') {
    if (auth.kind === 'service') {
      return json(res, 200, {
        user_id: 'service',
        email: 'service@voidframe.local',
        created_at: null,
        plan: 'service',
        usage: store.getUsage(null),
      });
    }
    return json(res, 200, {
      ...store.publicUser(auth.user),
      plan: 'free',
      usage: store.getUsage(auth.user.id),
    });
  }

  if (method === 'GET' && path === '/v1/usage') {
    json(res, 200, { usage: store.getUsage(userId) });
    return;
  }

  if (method === 'GET' && path === '/v1/models') {
    try {
      const res2 = await fetch(`${routerBase()}/v1/models`, {
        headers: { 'x-vf-token': SERVICE_TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      const body = await res2.json();
      return json(res, res2.ok ? 200 : 502, body);
    } catch (err) {
      return fail(res, 502, 'router_unavailable', `Router is unreachable: ${err.message}`);
    }
  }

  if (method === 'GET' && path === '/v1/services') {
    const services = await Promise.all(
      HEALTH_SERVICES.map((name) => serviceHealth(name, serviceUrl(name))),
    );
    json(res, 200, { services });
    return;
  }

  if (method === 'POST' && path === '/v1/panic') {
    json(res, 200, await panic());
    return;
  }

  if (method === 'POST' && path === '/v1/chat') {
    const body = await readBody(req);
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return fail(res, 400, 'invalid_messages', 'messages must be a non-empty array.');
    }
    if (body.stream) {
      return fail(res, 400, 'stream_unsupported', 'Apex proxies non-streaming completions only.');
    }
    const model = typeof body.model === 'string' && body.model ? body.model : 'gpt-4o';
    try {
      const out = await routerComplete(
        {
          model,
          messages: body.messages,
          provider: body.provider,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
        },
        { timeoutMs: 60000 },
      );
      store.addUsage(userId, out.usage?.prompt_tokens, out.usage?.completion_tokens);
      json(res, 200, out);
    } catch (err) {
      const code = err.code === 'router_unavailable' ? 'router_unavailable' : 'provider_error';
      fail(res, 502, code, err.message);
    }
    return;
  }

  if (method === 'POST' && path === '/v1/missions') {
    const body = await readBody(req);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const mode = body.mode === undefined ? 'chat' : body.mode;
    const autonomy = body.autonomy === undefined ? 'auto' : body.autonomy;
    if (!title || title.length > 200) {
      return fail(res, 400, 'invalid_title', 'title must be a non-empty string of at most 200 characters.');
    }
    if (!prompt || prompt.length > 20000) {
      return fail(res, 400, 'invalid_prompt', 'prompt must be a non-empty string of at most 20000 characters.');
    }
    if (!MODES.has(mode)) {
      return fail(res, 400, 'invalid_mode', `mode must be one of ${[...MODES].join(', ')}.`);
    }
    if (!AUTONOMY.has(autonomy)) {
      return fail(res, 400, 'invalid_autonomy', 'autonomy must be auto or restricted.');
    }
    const mission = store.insertMission({ userId, title, prompt, mode, autonomy });
    json(res, 201, mission);
    return;
  }

  if (method === 'GET' && path === '/v1/missions') {
    json(res, 200, { missions: store.listMissions(userId).map(missionSummary) });
    return;
  }

  const missionMatch = path.match(/^\/v1\/missions\/([^/]+)(?:\/(approve|cancel))?$/);
  if (missionMatch) {
    let id;
    try {
      id = decodeURIComponent(missionMatch[1]);
    } catch {
      return fail(res, 400, 'invalid_id', 'Mission id is not valid URL encoding.');
    }
    const action = missionMatch[2] || null;
    const mission = store.getMission(id);
    if (!mission || !canSee(auth, mission)) {
      return fail(res, 404, 'mission_not_found', `Mission "${id}" was not found.`);
    }
    if (!action) {
      if (method === 'GET') return json(res, 200, mission);
      return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
    }
    if (method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Method not allowed.');

    if (action === 'approve') {
      if (mission.status !== 'awaiting_approval') {
        return fail(res, 409, 'invalid_state', `Mission is ${mission.status}, not awaiting approval.`);
      }
      mission.status = 'running';
      addStep(mission, 'approval', 'Approved');
      addStep(mission, 'finalize', 'Mission complete');
      mission.status = 'done';
      store.updateMission(mission);
      return json(res, 200, mission);
    }

    if (!ACTIVE.has(mission.status)) {
      return fail(res, 409, 'invalid_state', `Mission is ${mission.status} and cannot be cancelled.`);
    }
    addStep(mission, 'cancel', 'Cancelled by the user');
    mission.status = 'cancelled';
    store.updateMission(mission);
    return json(res, 200, mission);
  }

  return fail(res, 404, 'not_found', 'Route not found.');
}

function pathOf(raw) {
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    return String(raw || '');
  }
}

store.init();

const server = createServer((req, res) => {
  const started = Date.now();
  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    process.stdout.write(
      JSON.stringify({
        t: nowIso(),
        svc: SERVICE,
        method: req.method,
        path: pathOf(req.url),
        status: res.statusCode,
        ms: Date.now() - started,
      }) + '\n',
    );
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
          t: nowIso(),
          svc: SERVICE,
          level: 'error',
          event: 'unhandled_error',
          fields: { message: String(err && err.message) },
        }) + '\n',
      );
    }
  });
});

startWorker();

server.listen(PORT, () => {
  const actual = server.address()?.port ?? PORT;
  process.stdout.write(
    JSON.stringify({
      t: nowIso(),
      svc: SERVICE,
      level: 'info',
      event: 'listening',
      fields: { port: actual, db: store.dbPath(), users: store.usersPath(), panel: PANEL_DIR },
    }) + '\n',
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
