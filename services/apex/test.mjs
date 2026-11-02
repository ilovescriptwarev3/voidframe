import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE_TOKEN = 'test-service-token';
const workDir = mkdtempSync(join(tmpdir(), 'vf-apex-'));
const dbPath = join(workDir, 'apex.db');
const panelDir = join(workDir, 'panel');
mkdirSync(panelDir, { recursive: true });
writeFileSync(join(panelDir, 'index.html'), '<!doctype html><title>Apex Panel</title><p>panel shell</p>');

let pass = 0;
const failures = [];
let server = null;
let stub = null;
let stubPort = 0;
const forgeDeletes = [];

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
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}
      const send = (status, payload) => {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, {
          'content-type': status === 204 ? undefined : 'application/json',
          'content-length': Buffer.byteLength(data),
        });
        res.end(data);
      };
      if (req.url === '/healthz') {
        return send(200, { service: 'stub', status: 'ok', version: '0.1.0', uptime_s: 1 });
      }
      if (req.url === '/v1/models' && req.method === 'GET') {
        return send(200, { object: 'list', models: [{ id: 'gpt-4o', provider: 'openai' }] });
      }
      if (req.url === '/v1/sandboxes' && req.method === 'GET') {
        return send(200, { sandboxes: [{ id: 'sb1' }, { id: 'sb2' }] });
      }
      if (req.url.startsWith('/v1/sandboxes/') && req.method === 'DELETE') {
        forgeDeletes.push(req.url.split('/').pop());
        res.writeHead(204);
        return res.end();
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        if (body.model === 'explode') return send(500, { error: { message: 'boom' } });
        return send(200, {
          id: 'cmpl-stub',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          provider: 'openai',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'stub reply' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        });
      }
      return send(404, { error: { message: 'stub: unknown path' } });
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
    const env = { ...process.env };
    const stubBase = `http://127.0.0.1:${stubPort}`;
    Object.assign(env, {
      PORT: '0',
      VF_SERVICE_TOKEN: SERVICE_TOKEN,
      VF_APEX_DB: dbPath,
      VF_APEX_DATA_DIR: workDir,
      PANEL_DIR: panelDir,
      VF_RATE_LIMIT: '60',
      VF_RATE_WINDOW_S: '60',
      VF_MISSION_TICK_MS: '150',
      ROUTER_URL: stubBase,
      FORGE_URL: stubBase,
      KEYCHAIN_URL: stubBase,
      LENS_URL: stubBase,
      VAULT_URL: stubBase,
      PANEL_URL: stubBase,
      CRAWLER_URL: 'http://127.0.0.1:1',
    });
    delete env.APEX_URL;
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

async function call(method, path, body, token = null) {
  const headers = {};
  if (token) headers['x-vf-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

async function waitFor(token, id, wanted, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await call('GET', `/v1/missions/${id}`, undefined, token);
    last = r;
    if (r.status === 200 && wanted.includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`mission did not reach ${wanted.join('/')} (last: ${last?.body?.status})`);
}

let userToken = null;
let userEmail = null;
let autoMissionId = null;

async function main() {
  await startStub();
  server = await startServer();

  await check('GET /healthz is public and well-formed', async () => {
    const r = await call('GET', '/healthz');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.service === 'apex', 'service field');
    assert(r.body.status === 'ok' && r.body.version === '0.1.0', 'status/version');
    assert(typeof r.body.uptime_s === 'number', 'uptime_s');
    assert(r.headers.get('access-control-allow-origin') === '*', 'CORS header');
  });

  await check('GET / serves the panel when it exists', async () => {
    const r = await call('GET', '/');
    assert(r.status === 200, `status ${r.status}`);
    assert((r.headers.get('content-type') || '').includes('text/html'), 'content type');
    assert(r.text.includes('Apex Panel'), 'panel index not served');
  });

  await check('registration validates email and password', async () => {
    let r = await call('POST', '/v1/auth/register', { email: 'nope', password: 'longenough' });
    assert(r.status === 400 && r.body.error.code === 'invalid_email', 'bad email');
    r = await call('POST', '/v1/auth/register', { email: 'a@b.co', password: 'short' });
    assert(r.status === 400 && r.body.error.code === 'weak_password', 'weak password');
  });

  await check('register returns a token and user', async () => {
    userEmail = `apex+${Date.now()}@voidframe.local`;
    const r = await call('POST', '/v1/auth/register', { email: userEmail, password: 'correct-horse-9' });
    assert(r.status === 201, `status ${r.status}: ${r.text}`);
    assert(typeof r.body.token === 'string' && r.body.token.length > 20, 'token');
    assert(r.body.email === userEmail, 'email');
    assert(r.body.user_id, 'user_id');
    userToken = r.body.token;
  });

  await check('duplicate email is 409', async () => {
    const r = await call('POST', '/v1/auth/register', { email: userEmail, password: 'correct-horse-9' });
    assert(r.status === 409 && r.body.error.code === 'email_taken', `status ${r.status}`);
  });

  await check('login rejects bad passwords and accepts good ones', async () => {
    let r = await call('POST', '/v1/auth/login', { email: userEmail, password: 'wrong-password' });
    assert(r.status === 401 && r.body.error.code === 'invalid_credentials', 'bad password');
    r = await call('POST', '/v1/auth/login', { email: userEmail, password: 'correct-horse-9' });
    assert(r.status === 200 && typeof r.body.token === 'string', 'good password');
    assert(r.body.email === userEmail && r.body.user_id, 'login user');
  });

  await check('GET /v1/me needs a valid token', async () => {
    let r = await call('GET', '/v1/me');
    assert(r.status === 401 && r.body.error.code === 'unauthorized', 'no token');
    r = await call('GET', '/v1/me', undefined, 'garbage');
    assert(r.status === 401, 'bad token');
    r = await call('GET', '/v1/me', undefined, userToken);
    assert(r.status === 200 && r.body.email === userEmail, 'user token');
    assert(r.body.user_id && r.body.plan === 'free', 'me shape');
    assert(r.body.usage && typeof r.body.usage.requests === 'number', 'me usage');
    r = await call('GET', '/v1/me', undefined, SERVICE_TOKEN);
    assert(r.status === 200 && r.body.user_id === 'service', 'service token');
  });

  await check('mission creation validates its fields', async () => {
    let r = await call('POST', '/v1/missions', { prompt: 'x' }, userToken);
    assert(r.status === 400 && r.body.error.code === 'invalid_title', 'missing title');
    r = await call('POST', '/v1/missions', { title: 'x' }, userToken);
    assert(r.status === 400 && r.body.error.code === 'invalid_prompt', 'missing prompt');
    r = await call('POST', '/v1/missions', { title: 'x', prompt: 'y', autonomy: 'yolo' }, userToken);
    assert(r.status === 400 && r.body.error.code === 'invalid_autonomy', 'bad autonomy');
    r = await call('POST', '/v1/missions', { title: 'x', prompt: 'y', mode: 'sorcery' }, userToken);
    assert(r.status === 400 && r.body.error.code === 'invalid_mode', 'bad mode');
    r = await call('POST', '/v1/missions', { title: 'x', prompt: 'y' });
    assert(r.status === 401, 'mission without token');
  });

  await check('an auto mission runs to done through the worker', async () => {
    const r = await call(
      'POST',
      '/v1/missions',
      { title: 'auto mission', prompt: 'say hello', mode: 'chat', autonomy: 'auto' },
      userToken,
    );
    assert(r.status === 201, `status ${r.status}: ${r.text}`);
    assert(r.body.status === 'queued', `initial status ${r.body.status}`);
    assert(Array.isArray(r.body.steps), 'steps array');
    autoMissionId = r.body.id;
    const done = await waitFor(userToken, autoMissionId, ['done', 'failed']);
    assert(done.status === 'done', `mission failed: ${done.error}`);
    assert(done.result.content === 'stub reply', `result ${JSON.stringify(done.result)}`);
    assert(done.steps.length >= 2, `steps ${done.steps.length}`);
    assert(done.steps.every((s) => s.at && s.kind), 'step shape');
    assert(done.steps.some((s) => s.kind === 'model_call'), 'model_call step');
    assert(done.steps.some((s) => s.kind === 'finalize'), 'finalize step');
  });

  await check('a restricted mission waits for approval, then finishes', async () => {
    const r = await call(
      'POST',
      '/v1/missions',
      { title: 'restricted mission', prompt: 'draft a plan', mode: 'chat', autonomy: 'restricted' },
      userToken,
    );
    assert(r.status === 201, `status ${r.status}`);
    const id = r.body.id;
    const waiting = await waitFor(userToken, id, ['awaiting_approval', 'failed']);
    assert(waiting.status === 'awaiting_approval', `status ${waiting.status}`);
    assert(waiting.steps.some((s) => s.kind === 'approval'), 'approval step');
    let a = await call('POST', `/v1/missions/${id}/approve`, undefined, userToken);
    assert(a.status === 200 && a.body.status === 'done', `approve ${a.status}`);
    a = await call('POST', `/v1/missions/${id}/approve`, undefined, userToken);
    assert(a.status === 409 && a.body.error.code === 'invalid_state', 'double approve');
  });

  await check('a mission can be cancelled', async () => {
    const r = await call(
      'POST',
      '/v1/missions',
      { title: 'cancel me', prompt: 'work', mode: 'chat', autonomy: 'restricted' },
      userToken,
    );
    assert(r.status === 201, `status ${r.status}`);
    const id = r.body.id;
    const c = await call('POST', `/v1/missions/${id}/cancel`, undefined, userToken);
    assert(c.status === 200 && c.body.status === 'cancelled', `cancel ${c.status}: ${c.text}`);
    const again = await call('POST', `/v1/missions/${id}/cancel`, undefined, userToken);
    assert(again.status === 409 && again.body.error.code === 'invalid_state', 'double cancel');
  });

  await check('missions list and ownership are enforced', async () => {
    const list = await call('GET', '/v1/missions', undefined, userToken);
    assert(list.status === 200 && Array.isArray(list.body.missions), 'list');
    assert(list.body.missions.some((m) => m.id === autoMissionId), 'created mission missing');
    const all = await call('GET', '/v1/missions', undefined, SERVICE_TOKEN);
    assert(all.body.missions.length >= list.body.missions.length, 'service sees fewer missions');
    const other = await call(
      'POST',
      '/v1/auth/register',
      { email: `other+${Date.now()}@voidframe.local`, password: 'correct-horse-9' },
    );
    assert(other.status === 201, 'second user');
    const stolen = await call('GET', `/v1/missions/${autoMissionId}`, undefined, other.body.token);
    assert(stolen.status === 404, `other user saw the mission (${stolen.status})`);
  });

  await check('POST /v1/chat proxies the router and records usage', async () => {
    const r = await call(
      'POST',
      '/v1/chat',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] },
      userToken,
    );
    assert(r.status === 200, `status ${r.status}: ${r.text}`);
    assert(r.body.choices[0].message.content === 'stub reply', 'content');
    const u = await call('GET', '/v1/usage', undefined, userToken);
    assert(u.status === 200, `usage ${u.status}`);
    assert(u.body.usage.requests >= 1, `requests ${u.body.usage.requests}`);
    assert(u.body.usage.prompt_tokens > 0, 'prompt tokens');
  });

  await check('a router failure surfaces as 502', async () => {
    const r = await call(
      'POST',
      '/v1/chat',
      { model: 'explode', messages: [{ role: 'user', content: 'hi' }] },
      userToken,
    );
    assert(r.status === 502, `status ${r.status}`);
    assert(r.body.error.code === 'provider_error', `code ${r.body.error.code}`);
  });

  await check('GET /v1/services fans out to the seven services', async () => {
    const r = await call('GET', '/v1/services', undefined, userToken);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.services) && r.body.services.length === 7, 'service count');
    const byName = Object.fromEntries(r.body.services.map((s) => [s.name, s]));
    assert(!byName.apex, 'apex should not probe itself');
    assert(byName.router.ok === true, 'router should be up');
    assert(byName.router.version === '0.1.0', 'version missing');
    assert(byName.crawler.ok === false, 'crawler should be down');
    assert(typeof byName.router.latency_ms === 'number', 'latency');
  });

  await check('GET /v1/models proxies the router catalog', async () => {
    const r = await call('GET', '/v1/models', undefined, userToken);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.models) && r.body.models[0].id === 'gpt-4o', 'models');
  });

  await check('POST /v1/panic deletes every forge sandbox', async () => {
    forgeDeletes.length = 0;
    const r = await call('POST', '/v1/panic', undefined, userToken);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.sandboxes_removed === 2, `removed ${r.body.sandboxes_removed}`);
    assert(r.body.stopped === 2, `stopped ${r.body.stopped}`);
    assert(forgeDeletes.includes('sb1') && forgeDeletes.includes('sb2'), `deletes ${forgeDeletes}`);
  });

  await check('per-user rate limiting returns 429 with retry_after_s', async () => {
    const reg = await call('POST', '/v1/auth/register', {
      email: `rate+${Date.now()}@voidframe.local`,
      password: 'correct-horse-9',
    });
    assert(reg.status === 201, 'rate user');
    const token = reg.body.token;
    let limited = null;
    for (let i = 0; i < 200; i += 1) {
      const r = await call('GET', '/v1/me', undefined, token);
      if (r.status === 429) {
        limited = r;
        break;
      }
      assert(r.status === 200, `unexpected status ${r.status}`);
    }
    assert(limited, 'never rate limited within 200 requests');
    assert(limited.body.error.code === 'rate_limited', 'rate code');
    assert(limited.body.error.retry_after_s > 0, 'retry_after_s');
    assert(limited.headers.get('retry-after'), 'retry-after header');
  });

  await check('unknown routes are 404', async () => {
    const r = await call('GET', '/v1/nope', undefined, userToken);
    assert(r.status === 404 && r.body.error.code === 'not_found', 'unknown route');
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
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  });
