import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const DATA = path.join(__dirname, 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startService(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'src', 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return { port, base, child, log: () => log };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  child.kill();
  throw new Error(`service did not start:\n${log}`);
}

async function call(base, method, p, body, token = TOKEN) {
  const headers = {};
  if (token) headers['x-vf-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, data };
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

const failures = [];
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

const svc = await startService({
  VF_SERVICE_TOKEN: TOKEN,
  LENS_URL: '',
  VF_FORGE_TIMEOUT_S: '60',
});
let sandboxId;
let sandboxPath;

try {
  await test('GET /healthz is public', async () => {
    const r = await call(svc.base, 'GET', '/healthz', undefined, null);
    assert.equal(r.status, 200);
    assert.equal(r.data.service, 'forge');
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.version, '0.1.0');
    assert.equal(typeof r.data.uptime_s, 'number');
  });

  await test('GET / describes the service', async () => {
    const r = await call(svc.base, 'GET', '/', undefined, null);
    assert.equal(r.status, 200);
    assert.equal(r.data.service, 'forge');
  });

  await test('OPTIONS returns 204 with CORS', async () => {
    const raw = await fetch(svc.base + '/v1/runs', { method: 'OPTIONS' });
    assert.equal(raw.status, 204);
    assert.equal(raw.headers.get('access-control-allow-origin'), '*');
  });

  await test('POST /v1/sandboxes without token is 401', async () => {
    const r = await call(svc.base, 'POST', '/v1/sandboxes', {}, null);
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'unauthorized');
  });

  await test('POST /v1/sandboxes creates a real directory', async () => {
    const r = await call(svc.base, 'POST', '/v1/sandboxes', { name: 'test-box' });
    assert.equal(r.status, 201);
    assert.match(r.data.id, /^[a-f0-9]{16}$/);
    assert.equal(typeof r.data.created_at, 'string');
    assert.ok(path.resolve(r.data.path).startsWith(path.resolve(DATA)));
    assert.ok(await exists(r.data.path), 'sandbox directory exists');
    sandboxId = r.data.id;
    sandboxPath = r.data.path;
  });

  await test('GET /v1/sandboxes lists the sandbox with run count', async () => {
    const r = await call(svc.base, 'GET', '/v1/sandboxes');
    assert.equal(r.status, 200);
    const sb = r.data.sandboxes.find((s) => s.id === sandboxId);
    assert.ok(sb, 'sandbox listed');
    assert.equal(sb.runs, 0);
    assert.equal(sb.path, sandboxPath);
  });

  await test('POST /v1/runs missing fields is 400', async () => {
    const a = await call(svc.base, 'POST', '/v1/runs', {});
    assert.equal(a.status, 400);
    assert.equal(a.data.error.code, 'missing_field');
    const b = await call(svc.base, 'POST', '/v1/runs', { sandbox: sandboxId });
    assert.equal(b.status, 400);
  });

  await test('POST /v1/runs unknown sandbox is 404', async () => {
    const r = await call(svc.base, 'POST', '/v1/runs', { sandbox: '0123456789abcdef', cmd: 'echo hi' });
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'sandbox_not_found');
  });

  await test('cmd echo hello runs in the sandbox', async () => {
    const r = await call(svc.base, 'POST', '/v1/runs', {
      sandbox: sandboxId,
      cmd: 'echo hello',
      timeout_s: 10,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.exit_code, 0);
    assert.match(r.data.stdout, /hello/);
    assert.equal(r.data.sandbox, sandboxId);
    assert.equal(r.data.truncated, false);
    assert.ok(Date.parse(r.data.started_at) <= Date.parse(r.data.ended_at));
    assert.equal(typeof r.data.ms, 'number');
  });

  await test('files are written before the run', async () => {
    const r = await call(svc.base, 'POST', '/v1/runs', {
      sandbox: sandboxId,
      files: { 'notes/a.txt': 'hello file' },
      cmd: 'node -e "console.log(require(\'fs\').readFileSync(\'notes/a.txt\',\'utf8\').trim())"',
      timeout_s: 15,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.exit_code, 0);
    assert.match(r.data.stdout, /hello file/);
    assert.ok(await exists(path.join(sandboxPath, 'notes', 'a.txt')));
  });

  await test('file path traversal is rejected', async () => {
    const r = await call(svc.base, 'POST', '/v1/runs', {
      sandbox: sandboxId,
      files: { '../escape.txt': 'nope' },
      cmd: 'echo x',
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'path_traversal');
    assert.equal(await exists(path.join(DATA, 'escape.txt')), false);
  });

  await test('absolute file paths are rejected', async () => {
    const r = await call(svc.base, 'POST', '/v1/runs', {
      sandbox: sandboxId,
      files: { 'C:\\Windows\\evil.txt': 'nope' },
      cmd: 'echo x',
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'path_traversal');
  });

  await test('node -e runs and returns output', async () => {
    const r = await call(svc.base, 'POST', '/v1/runs', {
      sandbox: sandboxId,
      cmd: 'node -e "console.log(1+1)"',
      timeout_s: 15,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.exit_code, 0);
    assert.match(r.data.stdout, /^2/);
  });

  await test('stdout is capped at 64 KB and flagged truncated', async () => {
    const r = await call(svc.base, 'POST', '/v1/runs', {
      sandbox: sandboxId,
      cmd: 'node -e "process.stdout.write(\'x\'.repeat(70000))"',
      timeout_s: 15,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.truncated, true);
    assert.equal(Buffer.byteLength(r.data.stdout, 'utf8'), 65536);
  });

  await test('timeout kills the process tree with exit_code 124', async () => {
    const r = await call(svc.base, 'POST', '/v1/runs', {
      sandbox: sandboxId,
      cmd: 'ping -n 30 127.0.0.1',
      timeout_s: 1,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.exit_code, 124);
    assert.equal(r.data.error, 'timeout');
    assert.ok(r.data.ms < 10000, `took ${r.data.ms}ms`);
  });

  await test('GET /v1/runs/:id returns the stored record', async () => {
    const run = await call(svc.base, 'POST', '/v1/runs', {
      sandbox: sandboxId,
      cmd: 'echo stored',
      timeout_s: 10,
    });
    const r = await call(svc.base, 'GET', `/v1/runs/${run.data.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.id, run.data.id);
    assert.equal(r.data.cmd, 'echo stored');
    assert.equal(r.data.exit_code, 0);
  });

  await test('GET /v1/runs?limit returns recent runs', async () => {
    const r = await call(svc.base, 'GET', '/v1/runs?limit=2');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.runs));
    assert.ok(r.data.runs.length <= 2);
    assert.ok(r.data.runs.length >= 1);
    const bad = await call(svc.base, 'GET', '/v1/runs?limit=999');
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'invalid_limit');
  });

  await test('GET /v1/runs/:id unknown is 404', async () => {
    const r = await call(svc.base, 'GET', '/v1/runs/deadbeef');
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'run_not_found');
  });

  await test('DELETE /v1/sandboxes/:id removes the directory', async () => {
    const r = await call(svc.base, 'DELETE', `/v1/sandboxes/${sandboxId}`);
    assert.equal(r.status, 204);
    assert.equal(await exists(sandboxPath), false);
    const again = await call(svc.base, 'DELETE', `/v1/sandboxes/${sandboxId}`);
    assert.equal(again.status, 404);
    assert.equal(again.data.error.code, 'sandbox_not_found');
  });

  await test('runs history survives sandbox deletion', async () => {
    const r = await call(svc.base, 'GET', '/v1/runs?limit=100');
    assert.equal(r.status, 200);
    assert.ok(r.data.runs.some((x) => x.sandbox === sandboxId));
  });
} finally {
  try { svc.child.kill(); } catch { /* gone */ }
}

console.log(`\nforge: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('failed:', failures.join(', '));
  process.exit(1);
}
