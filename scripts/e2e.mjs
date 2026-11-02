// End-to-end check across all eight services.
//   node scripts/e2e.mjs            (services must already be running)
//   node scripts/e2e.mjs --spawn    (starts them, waits, tests, stops)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.VF_SERVICE_TOKEN || 'dev-token-change-me';
const ports = { apex: 8088, forge: 8000, crawler: 3000, vault: 8085, router: 8089, lens: 8086, keychain: 8087, panel: 5173 };

const pass = [];
const fail = [];
const ok = (name, detail = '') => { pass.push(name); console.log(`  \x1b[32mâœ“\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`); };
const no = (name, err) => { fail.push(name); console.log(`  \x1b[31mâœ—\x1b[0m ${name} \x1b[31m${err}\x1b[0m`); };
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function call(method, path, body, { token = TOKEN, base = ports.apex, timeout = 15000 } = {}) {
  const res = await fetch(`http://localhost:${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-vf-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, text };
}

async function check(name, fn) {
  try { await fn(); ok(name); } catch (e) { no(name, e.message); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function waitForHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let children = [];
if (process.argv.includes('--spawn')) {
  console.log('\x1b[90mstarting servicesâ€¦\x1b[0m');
  for (const [name, port] of Object.entries(ports)) {
    const entry = join(root, 'services', name, 'src', 'server.js');
    if (!existsSync(entry)) { console.log(`  \x1b[33mÂ·\x1b[0m ${name} not built`); continue; }
    children.push(spawn(process.execPath, [entry], { cwd: join(root, 'services', name), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' }));
  }
}

const stop = () => children.forEach((c) => { try { c.kill(); } catch {} });
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(1); });

// a local fixture site for the crawler
const fixture = createServer((req, res) => {
  const pages = {
    '/': '<title>Fixture home</title><a href="/a">a</a><a href="/b">b</a><p>Hello voidframe crawler.</p>',
    '/a': '<title>Page A</title><p>Alpha content about agents and rate limits.</p>',
    '/b': '<title>Page B</title><p>Beta content about sandboxes and secrets.</p>',
  };
  const html = pages[req.url];
  res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
  res.end(html || 'not found');
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const fixturePort = fixture.address().port;

step('health');
for (const [name, port] of Object.entries(ports)) {
  await check(`${name} :${port}/healthz`, async () => {
    const up = await waitForHealth(port, 40);
    assert(up, 'no answer');
    if (name !== 'panel') {
      const r = await call('GET', '/healthz', undefined, { base: port, token: null });
      assert(r.body?.service === name, `service field is ${JSON.stringify(r.body?.service)}`);
    }
  });
}

step('keychain');
let secretName = 'E2E_KEY';
await check('create, read back, list hides value, redact, delete', async () => {
  let r = await call('POST', '/v1/secrets', { name: secretName, value: 'sk-test-123456' }, { base: ports.keychain });
  assert(r.status === 201 || r.status === 200, `create ${r.status}`);
  r = await call('GET', `/v1/secrets/${secretName}`, undefined, { base: ports.keychain });
  assert(r.body?.value === 'sk-test-123456', 'value round-trip');
  r = await call('GET', '/v1/secrets', undefined, { base: ports.keychain });
  assert(!JSON.stringify(r.body).includes('sk-test-123456'), 'value leaked in list');
  r = await call('POST', '/v1/redact', { text: 'key is sk-test-123456 ok' }, { base: ports.keychain });
  assert(!r.body.text.includes('sk-test-123456'), 'redaction missed the value');
  r = await call('GET', '/v1/secrets/nope', undefined, { base: ports.keychain });
  assert(r.status === 404, `missing secret ${r.status}`);
  r = await call('GET', '/v1/secrets', undefined, { base: ports.keychain, token: 'wrong' });
  assert(r.status === 401, `bad token ${r.status}`);
});

step('vault');
let docId;
await check('collection, document, search, graph', async () => {
  await call('POST', '/v1/collections', { name: 'e2e' }, { base: ports.vault });
  const r = await call('POST', '/v1/documents', {
    collection: 'e2e',
    text: 'Rate limiting protects the API. Sandboxes isolate code execution. Secrets are encrypted at rest.\n\n' +
          'The crawler fetches pages and feeds the knowledge graph.',
    metadata: { kind: 'note' },
  }, { base: ports.vault });
  assert(r.status === 201 && r.body?.id, `document ${r.status}`);
  docId = r.body.id;
  const s = await call('POST', '/v1/search', { query: 'sandboxes isolate code', limit: 5 }, { base: ports.vault });
  assert(Array.isArray(s.body?.results) && s.body.results.length > 0, 'search returned nothing');
  assert(s.body.results[0].text.toLowerCase().includes('sandbox'), 'search ranked the wrong chunk first');
  const g = await call('POST', '/v1/edges', { from: 'doc:1', to: 'doc:2', kind: 'links' }, { base: ports.vault });
  assert(g.status === 201 || g.status === 200, `edge ${g.status}`);
  const graph = await call('GET', '/v1/graph?node=doc:1&depth=2', undefined, { base: ports.vault });
  assert(Array.isArray(graph.body?.edges) && graph.body.edges.length > 0, 'graph empty');
});

step('router');
await check('model list, 503 without providers, usage', async () => {
  const m = await call('GET', '/v1/models', undefined, { base: ports.router });
  assert(Array.isArray(m.body?.models), 'models not an array');
  const c = await call('POST', '/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, { base: ports.router });
  assert([200, 502, 503].includes(c.status), `unexpected ${c.status}`);
  const u = await call('GET', '/v1/usage', undefined, { base: ports.router });
  assert(u.status === 200, `usage ${u.status}`);
});

step('crawler');
let jobId;
await check('scrape fixture, crawl fixture, job status', async () => {
  const url = `http://127.0.0.1:${fixturePort}/`;
  const s = await call('POST', '/v1/scrape', { url }, { base: ports.crawler, timeout: 20000 });
  assert(s.status === 200, `scrape ${s.status}`);
  assert(/hello voidframe crawler/i.test(s.body?.text || ''), 'text extraction lost content');
  assert(Array.isArray(s.body?.links) && s.body.links.length >= 2, 'links missing');
  const c = await call('POST', '/v1/crawl', { url, max_pages: 3, max_depth: 1 }, { base: ports.crawler });
  assert(c.status === 202, `crawl ${c.status}`);
  jobId = c.body.job_id;
  for (let i = 0; i < 40; i++) {
    const j = await call('GET', `/v1/jobs/${jobId}`, undefined, { base: ports.crawler });
    if (j.body?.status === 'done' || j.body?.status === 'failed') {
      assert(j.body.status === 'done', `job ${j.body.status}: ${j.body.error || ''}`);
      assert(j.body.pages.length >= 1, 'no pages crawled');
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('crawl did not finish in 20s');
});

step('forge');
await check('sandbox, run command, files, timeout, traversal', async () => {
  const sb = await call('POST', '/v1/sandboxes', { name: 'e2e' }, { base: ports.forge });
  assert(sb.status === 201, `sandbox ${sb.status}`);
  const id = sb.body.id;
  let r = await call('POST', '/v1/runs', { sandbox: id, cmd: 'node -e "console.log(1+1)"' }, { base: ports.forge });
  assert(r.body?.stdout?.trim() === '2', `stdout ${JSON.stringify(r.body?.stdout)}`);
  assert(r.body.exit_code === 0, `exit ${r.body.exit_code}`);
  r = await call('POST', '/v1/runs', { sandbox: id, cmd: 'type hello.txt', files: { 'hello.txt': 'from the test' } }, { base: ports.forge });
  assert(/from the test/.test(r.body?.stdout || ''), 'files were not written before the run');
  r = await call('POST', '/v1/runs', { sandbox: id, cmd: 'ping -n 10 127.0.0.1', timeout_s: 1 }, { base: ports.forge });
  assert(r.body?.exit_code === 124 || r.body?.error === 'timeout', `timeout not enforced: ${JSON.stringify(r.body?.exit_code)}`);
  r = await call('POST', '/v1/runs', { sandbox: '../../', cmd: 'echo nope' }, { base: ports.forge });
  assert(r.status >= 400, `traversal accepted (${r.status})`);
  await call('DELETE', `/v1/sandboxes/${id}`, undefined, { base: ports.forge });
});

step('lens');
await check('ingest, query logs, metrics, services, alerts', async () => {
  const i = await call('POST', '/ingest', { service: 'e2e', level: 'warn', event: 'e2e_check', fields: { n: 1 } }, { base: ports.lens, token: null });
  assert(i.status === 202, `ingest ${i.status}`);
  const l = await call('GET', '/v1/logs?q=e2e_check&limit=5', undefined, { base: ports.lens });
  assert(l.body?.lines?.some((x) => x.event === 'e2e_check'), 'ingested line not found');
  await call('POST', '/v1/metrics', { name: 'e2e.value', value: 3 }, { base: ports.lens });
  const m = await call('GET', '/v1/metrics?name=e2e.value', undefined, { base: ports.lens });
  assert(m.body?.series?.[0]?.points?.length > 0, 'metric not recorded');
  const s = await call('GET', '/v1/services', undefined, { base: ports.lens });
  assert(Array.isArray(s.body?.services), 'services not an array');
  const a = await call('POST', '/v1/alerts', { name: 'e2e alert', metric: 'e2e.value', op: 'gt', threshold: 2 }, { base: ports.lens });
  assert(a.status === 201 || a.status === 200, `alert ${a.status}`);
  const f = await call('GET', '/v1/alerts/firing', undefined, { base: ports.lens });
  assert(Array.isArray(f.body?.firing), 'firing not an array');
});

step('apex + panel');
let userToken;
await check('register, login, me, missions, service health, panic', async () => {
  const email = `e2e+${Date.now()}@voidframe.local`;
  let r = await call('POST', '/v1/auth/register', { email, password: 'correct-horse-9' }, { token: null });
  assert(r.status === 201 && r.body.token, `register ${r.status}`);
  userToken = r.body.token;
  r = await call('POST', '/v1/auth/login', { email, password: 'wrong' }, { token: null });
  assert(r.status === 401, `bad password ${r.status}`);
  r = await call('POST', '/v1/auth/login', { email, password: 'correct-horse-9' }, { token: null });
  assert(r.status === 200, `login ${r.status}`);
  r = await call('GET', '/v1/me', undefined, { token: userToken });
  assert(r.body?.email === email, 'me did not match');
  r = await call('POST', '/v1/missions', { title: 'e2e mission', prompt: 'say hello', mode: 'chat', autonomy: 'auto' }, { token: userToken });
  assert(r.status === 201 && r.body.id, `mission ${r.status}`);
  const id = r.body.id;
  let seen = 'queued';
  for (let i = 0; i < 40; i++) {
    const m = await call('GET', `/v1/missions/${id}`, undefined, { token: userToken });
    seen = m.body?.status;
    assert(Array.isArray(m.body?.steps), 'steps missing');
    if (['done', 'failed', 'awaiting_approval'].includes(seen)) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert(['done', 'failed', 'awaiting_approval'].includes(seen), `mission stuck in ${seen}`);
  const sv = await call('GET', '/v1/services', undefined, { token: userToken });
  assert(Array.isArray(sv.body?.services) && sv.body.services.length >= 7, 'service fan-out missing');
  const p = await call('POST', '/v1/panic', {}, { token: userToken });
  assert(p.status === 200, `panic ${p.status}`);
});

await check('panel serves its screens and proxies the api', async () => {
  const r = await fetch(`http://localhost:${ports.panel}/`, { signal: AbortSignal.timeout(5000) });
  assert(r.ok, `panel ${r.status}`);
  const html = await r.text();
  for (const word of ['missions', 'services', 'secrets', 'search']) {
    assert(html.toLowerCase().includes(word), `panel missing "${word}"`);
  }
  assert(!/https?:\/\/(cdn|unpkg|fonts\.google)/i.test(html), 'panel loads a CDN');
});

step('rate limit');
await check('429 after the limit', async () => {
  let got = 0;
  for (let i = 0; i < 200; i++) {
    const r = await call('GET', '/v1/me', undefined, { token: userToken });
    if (r.status === 429) { got = i; break; }
  }
  assert(got > 0, 'never rate limited within 200 requests');
});

fixture.closeAllConnections?.();
fixture.close();

console.log(`\n\x1b[1m${pass.length} passed, ${fail.length} failed\x1b[0m`);
if (fail.length) { console.log(fail.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);

