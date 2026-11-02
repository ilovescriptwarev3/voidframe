import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-keychain';
const MASTER = 'test-master-key';
const dataDir = mkdtempSync(join(tmpdir(), 'vf-keychain-'));

let pass = 0;
const failures = [];
let server = null;

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

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: here,
      env: {
        ...process.env,
        PORT: '0',
        VF_SERVICE_TOKEN: TOKEN,
        VF_MASTER_KEY: MASTER,
        VF_KEYCHAIN_DATA_DIR: dataDir,
        LENS_URL: '',
      },
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
        } catch {
          /* ignore non-json output */
        }
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

async function call(method, path, body, token = TOKEN) {
  const headers = {};
  if (token !== null) headers['x-vf-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
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
  server = await startServer();
  const base = server.port;

  await check('GET /healthz is public and well-formed', async () => {
    const r = await call('GET', '/healthz', undefined, null);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.service === 'keychain', 'service field');
    assert(r.body.status === 'ok', 'status field');
    assert(r.body.version === '0.1.0', 'version field');
    assert(typeof r.body.uptime_s === 'number', 'uptime_s field');
    assert(r.headers.get('access-control-allow-origin') === '*', 'CORS header');
  });

  await check('OPTIONS returns 204', async () => {
    const r = await call('OPTIONS', '/v1/secrets', undefined, null);
    assert(r.status === 204, `status ${r.status}`);
  });

  await check('GET / describes the service', async () => {
    const r = await call('GET', '/');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.service === 'keychain', 'service field');
    assert(r.body.docs === '/healthz', 'docs field');
  });

  await check('protected route without token is 401', async () => {
    const r = await call('GET', '/v1/secrets', undefined, null);
    assert(r.status === 401, `status ${r.status}`);
    assert(r.body.error.code === 'unauthorized', 'error code');
  });

  await check('protected route with wrong token is 401', async () => {
    const r = await call('GET', '/v1/secrets', undefined, 'nope');
    assert(r.status === 401, `status ${r.status}`);
    assert(r.body.error.code === 'unauthorized', 'error code');
  });

  await check('malformed JSON body is 400 invalid_json', async () => {
    const res = await fetch(`http://127.0.0.1:${base}/v1/secrets`, {
      method: 'POST',
      headers: { 'x-vf-token': TOKEN, 'content-type': 'application/json' },
      body: '{not json',
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    assert(res.status === 400, `status ${res.status}`);
    assert(body.error.code === 'invalid_json', 'error code');
  });

  await check('POST /v1/secrets creates and returns created_at', async () => {
    const r = await call('POST', '/v1/secrets', {
      name: 'OPENAI_KEY',
      value: 'sk-test-1234567890',
      meta: { provider: 'openai' },
    });
    assert(r.status === 201, `status ${r.status}`);
    assert(r.body.name === 'OPENAI_KEY', 'name');
    assert(typeof r.body.created_at === 'string', 'created_at');
    assert(!r.text.includes('sk-test-1234567890'), 'value leaked in create response');
  });

  await check('GET /v1/secrets/:name returns the decrypted value', async () => {
    const r = await call('GET', '/v1/secrets/OPENAI_KEY');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.value === 'sk-test-1234567890', 'value round-trip');
    assert(r.body.meta.provider === 'openai', 'meta round-trip');
  });

  await check('GET /v1/secrets lists names but never values', async () => {
    const r = await call('GET', '/v1/secrets');
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.secrets), 'secrets array');
    const entry = r.body.secrets.find((s) => s.name === 'OPENAI_KEY');
    assert(entry, 'secret missing from list');
    assert(!('value' in entry), 'value key present in list');
    assert(!r.text.includes('sk-test-1234567890'), 'plaintext leaked in list');
  });

  await check('POST rotating an existing name keeps created_at and bumps updated_at', async () => {
    const before = await call('GET', '/v1/secrets/OPENAI_KEY');
    await new Promise((r) => setTimeout(r, 15));
    const r = await call('POST', '/v1/secrets', { name: 'OPENAI_KEY', value: 'sk-test-abcdef' });
    assert(r.status === 201, `status ${r.status}`);
    assert(r.body.created_at === before.body.created_at, 'created_at changed');
    const after = await call('GET', '/v1/secrets/OPENAI_KEY');
    assert(after.body.value === 'sk-test-abcdef', 'value not replaced');
    assert(after.body.updated_at !== before.body.updated_at, 'updated_at unchanged');
  });

  await check('POST /v1/secrets/:name/rotate updates the value', async () => {
    const r = await call('POST', '/v1/secrets/OPENAI_KEY/rotate', { value: 'sk-rotated-1' });
    assert(r.status === 200, `status ${r.status}`);
    assert(typeof r.body.updated_at === 'string', 'updated_at');
    const after = await call('GET', '/v1/secrets/OPENAI_KEY');
    assert(after.body.value === 'sk-rotated-1', 'value not rotated');
  });

  await check('POST rotate on a missing secret is 404', async () => {
    const r = await call('POST', '/v1/secrets/MISSING/rotate', { value: 'x' });
    assert(r.status === 404, `status ${r.status}`);
    assert(r.body.error.code === 'secret_not_found', 'error code');
  });

  await check('POST /v1/redact replaces secret values', async () => {
    const r = await call('POST', '/v1/redact', {
      text: 'key is sk-rotated-1 and also sk-test-abcdef here',
    });
    assert(r.status === 200, `status ${r.status}`);
    assert(!r.body.text.includes('sk-rotated-1'), 'current value survived redaction');
    assert(r.body.text.includes('[redacted:OPENAI_KEY]'), 'redaction marker missing');
  });

  await check('POST /v1/redact requires text', async () => {
    const r = await call('POST', '/v1/redact', {});
    assert(r.status === 400, `status ${r.status}`);
    assert(r.body.error.code === 'invalid_text', 'error code');
  });

  await check('POST /v1/secrets validates name and value', async () => {
    let r = await call('POST', '/v1/secrets', { name: 'bad name!', value: 'x' });
    assert(r.status === 400 && r.body.error.code === 'invalid_name', 'invalid name');
    r = await call('POST', '/v1/secrets', { name: 'GOOD', value: 42 });
    assert(r.status === 400 && r.body.error.code === 'invalid_value', 'invalid value');
    r = await call('POST', '/v1/secrets', { name: 'GOOD', value: 'x', meta: 'nope' });
    assert(r.status === 400 && r.body.error.code === 'invalid_meta', 'invalid meta');
  });

  await check('oversized body is 413', async () => {
    const r = await call('POST', '/v1/secrets', { name: 'BIG', value: 'x'.repeat(2 * 1024 * 1024) });
    assert(r.status === 413, `status ${r.status}`);
    assert(r.body.error.code === 'payload_too_large', 'error code');
  });

  await check('DELETE removes the secret and GET is then 404', async () => {
    let r = await call('DELETE', '/v1/secrets/OPENAI_KEY');
    assert(r.status === 204, `delete status ${r.status}`);
    r = await call('GET', '/v1/secrets/OPENAI_KEY');
    assert(r.status === 404 && r.body.error.code === 'secret_not_found', 'get after delete');
    r = await call('DELETE', '/v1/secrets/OPENAI_KEY');
    assert(r.status === 204, 'delete is idempotent');
  });

  await check('unknown route is 404', async () => {
    const r = await call('GET', '/v1/does-not-exist');
    assert(r.status === 404, `status ${r.status}`);
    assert(r.body.error.code === 'not_found', 'error code');
  });

  await check('secrets survive a restart (encrypted at rest)', async () => {
    let r = await call('POST', '/v1/secrets', { name: 'PERSIST', value: 'sticky-value' });
    assert(r.status === 201, `create ${r.status}`);
    await stopServer();
    server = await startServer();
    r = await call('GET', '/v1/secrets/PERSIST');
    assert(r.status === 200 && r.body.value === 'sticky-value', 'value lost on restart');
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
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  });
