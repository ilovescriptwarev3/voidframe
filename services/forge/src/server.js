import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, send, fail, requireToken, readBody, httpError } from './http.js';
import { newId, assertInside, writeFiles, pathExists } from './sandbox.js';
import { runCommand } from './runner.js';

const NAME = 'forge';
const VERSION = '0.1.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const SB_ROOT = path.join(DATA_DIR, 'sandboxes');
const META_FILE = path.join(DATA_DIR, 'sandboxes.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const MAX_RUNS = 500;

const sandboxes = new Map();
const runs = new Map();

function log(level, event, fields = {}) {
  const base = process.env.LENS_URL;
  if (!base) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300);
  fetch(`${base.replace(/\/$/, '')}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: NAME, level, event, fields }),
    signal: ctrl.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveMeta() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(META_FILE, JSON.stringify({ sandboxes: [...sandboxes.values()] }));
  } catch (err) {
    console.warn(`[${NAME}] could not save sandbox metadata: ${err.message}`);
  }
}

async function saveRuns() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const list = [...runs.values()]
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      .slice(0, MAX_RUNS);
    await fsp.writeFile(RUNS_FILE, JSON.stringify({ runs: list }));
  } catch (err) {
    console.warn(`[${NAME}] could not save runs: ${err.message}`);
  }
}

function defaultTimeout() {
  const v = Number(process.env.VF_FORGE_TIMEOUT_S);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 600) : 60;
}

function sandboxRuns(id) {
  let n = 0;
  for (const r of runs.values()) if (r.sandbox === id) n++;
  return n;
}

function sandboxView(sb) {
  return { id: sb.id, path: sb.path, created_at: sb.created_at, runs: sandboxRuns(sb.id) };
}

function checkAllowlist(cmd) {
  const raw = process.env.VF_FORGE_ALLOWLIST;
  if (!raw) return;
  const allowed = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return;
  const first = cmd.trim().split(/\s+/)[0].toLowerCase();
  const base = first.split(/[\\/]/).pop();
  if (!allowed.includes(first) && !allowed.includes(base)) {
    throw httpError(403, 'command_not_allowed', `Command "${first}" is not on VF_FORGE_ALLOWLIST.`);
  }
}

async function route(req, res, u) {
  const p = u.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method === 'GET' && p === '/healthz') {
    return json(res, 200, {
      service: NAME,
      status: 'ok',
      version: VERSION,
      uptime_s: Number(process.uptime().toFixed(3)),
    });
  }
  if (req.method === 'GET' && p === '/') {
    return json(res, 200, { service: NAME, docs: '/healthz' });
  }
  if (!requireToken(req, res)) return;

  if (req.method === 'POST' && p === '/v1/sandboxes') {
    const body = await readBody(req);
    if (body.name !== undefined && typeof body.name !== 'string') {
      throw httpError(400, 'invalid_field', 'Field "name" must be a string.');
    }
    if (body.image !== undefined && typeof body.image !== 'string') {
      throw httpError(400, 'invalid_field', 'Field "image" must be a string.');
    }
    const id = newId();
    const dir = path.join(SB_ROOT, id);
    await fsp.mkdir(dir, { recursive: true });
    const sb = {
      id,
      path: dir,
      created_at: new Date().toISOString(),
      name: body.name ? body.name.trim().slice(0, 120) || null : null,
      image: body.image ? body.image.trim().slice(0, 120) || null : null,
    };
    sandboxes.set(id, sb);
    await saveMeta();
    log('info', 'sandbox_created', { id });
    return json(res, 201, { id: sb.id, path: sb.path, created_at: sb.created_at });
  }

  if (req.method === 'GET' && p === '/v1/sandboxes') {
    const list = [...sandboxes.values()]
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map(sandboxView);
    return json(res, 200, { sandboxes: list });
  }

  const sbMatch = p.match(/^\/v1\/sandboxes\/([^/]+)$/);
  if (sbMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(sbMatch[1]);
    const sb = sandboxes.get(id);
    const dir = path.join(SB_ROOT, id);
    let inside;
    try {
      inside = assertInside(SB_ROOT, dir);
    } catch {
      throw httpError(404, 'sandbox_not_found', 'No sandbox with that id.');
    }
    if (!sb && !(await pathExists(inside))) {
      throw httpError(404, 'sandbox_not_found', 'No sandbox with that id.');
    }
    await fsp.rm(inside, { recursive: true, force: true });
    sandboxes.delete(id);
    await saveMeta();
    log('info', 'sandbox_deleted', { id });
    return send(res, 204);
  }

  if (req.method === 'POST' && p === '/v1/runs') {
    const body = await readBody(req, 8 << 20);
    if (typeof body.sandbox !== 'string' || !body.sandbox.trim()) {
      throw httpError(400, 'missing_field', 'Field "sandbox" is required.');
    }
    if (typeof body.cmd !== 'string' || !body.cmd.trim()) {
      throw httpError(400, 'missing_field', 'Field "cmd" is required.');
    }
    if (body.cmd.length > 10000) {
      throw httpError(400, 'invalid_field', 'Command is too long (max 10000 characters).');
    }
    const id = body.sandbox.trim();
    let sb = sandboxes.get(id);
    if (!sb) {
      const maybe = path.join(SB_ROOT, id);
      let inside;
      try {
        inside = assertInside(SB_ROOT, maybe);
      } catch {
        throw httpError(404, 'sandbox_not_found', 'No sandbox with that id.');
      }
      if (!(await pathExists(inside))) {
        throw httpError(404, 'sandbox_not_found', 'No sandbox with that id.');
      }
      sb = { id, path: inside, created_at: new Date().toISOString() };
      sandboxes.set(id, sb);
      await saveMeta();
    }

    let timeoutS = defaultTimeout();
    if (body.timeout_s !== undefined && body.timeout_s !== null) {
      const n = Number(body.timeout_s);
      if (!Number.isFinite(n) || n <= 0 || n > 600) {
        throw httpError(400, 'invalid_timeout', 'Field "timeout_s" must be between 1 and 600.');
      }
      timeoutS = n;
    }

    let env;
    if (body.env !== undefined && body.env !== null) {
      if (typeof body.env !== 'object' || Array.isArray(body.env)) {
        throw httpError(400, 'invalid_env', 'Field "env" must be an object of strings.');
      }
      env = {};
      for (const [k, v] of Object.entries(body.env)) {
        if (typeof v !== 'string') {
          throw httpError(400, 'invalid_env', 'Each env value must be a string.');
        }
        env[k] = v;
      }
    }

    checkAllowlist(body.cmd);
    const sandboxPath = assertInside(SB_ROOT, sb.path);
    if (body.files !== undefined && body.files !== null) {
      await writeFiles(sandboxPath, body.files);
    }

    const result = await runCommand({
      cmd: body.cmd,
      cwd: sandboxPath,
      timeoutS,
      env,
    });

    const record = {
      id: newId(),
      sandbox: sb.id,
      cmd: body.cmd,
      ...result,
    };
    runs.set(record.id, record);
    await saveRuns();
    log(record.error === 'timeout' ? 'warn' : 'info', 'run_finished', {
      id: record.id,
      sandbox: sb.id,
      exit_code: record.exit_code,
      ms: record.ms,
    });
    return json(res, 200, record);
  }

  if (req.method === 'GET' && p === '/v1/runs') {
    const raw = u.searchParams.get('limit');
    let limit = 20;
    if (raw !== null) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw httpError(400, 'invalid_limit', 'Query "limit" must be an integer between 1 and 100.');
      }
      limit = n;
    }
    const list = [...runs.values()]
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      .slice(0, limit);
    return json(res, 200, { runs: list });
  }

  const runMatch = p.match(/^\/v1\/runs\/([^/]+)$/);
  if (req.method === 'GET' && runMatch) {
    const run = runs.get(decodeURIComponent(runMatch[1]));
    if (!run) throw httpError(404, 'run_not_found', 'No run with that id.');
    return json(res, 200, run);
  }

  throw httpError(404, 'not_found', 'No such endpoint.');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const u = new URL(req.url, 'http://localhost');
  res.on('finish', () => {
    process.stdout.write(JSON.stringify({
      t: new Date().toISOString(),
      svc: NAME,
      method: req.method,
      path: u.pathname,
      status: res.statusCode,
      ms: Date.now() - started,
    }) + '\n');
  });
  try {
    await route(req, res, u);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err && err.status) {
      fail(res, err.status, err.code || 'error', err.message);
    } else {
      console.warn(`[${NAME}] ${err && err.message ? err.message : err}`);
      fail(res, 500, 'internal_error', 'Something went wrong.');
    }
  }
});

await fsp.mkdir(SB_ROOT, { recursive: true });
const savedMeta = await loadJson(META_FILE, { sandboxes: [] });
if (Array.isArray(savedMeta.sandboxes)) {
  for (const sb of savedMeta.sandboxes) {
    if (sb && sb.id && sb.path) sandboxes.set(sb.id, sb);
  }
}
const savedRuns = await loadJson(RUNS_FILE, { runs: [] });
if (Array.isArray(savedRuns.runs)) {
  for (const r of savedRuns.runs) {
    if (r && r.id) runs.set(r.id, r);
  }
}
if (!process.env.VF_SERVICE_TOKEN) {
  console.warn(`[${NAME}] VF_SERVICE_TOKEN not set; using the development default token.`);
}
const port = Number(process.env.PORT) || 8000;
server.listen(port, () => {
  console.log(`[${NAME}] listening on :${port}`);
});

export { server };
