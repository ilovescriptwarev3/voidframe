import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
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

function stop(svc) {
  try { svc.child.kill(); } catch { /* gone */ }
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

function makeFixture() {
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>.a{}</style><script>bad()</script></head><body>${body}</body></html>`;
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const sendHtml = (status, body) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (p === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    if (p === '/') {
      return sendHtml(200, page('Fixture Root',
        '<h1>Hello fixture</h1><p>Root text says hi.</p><a href="/a">A</a><a href="/b">B</a><a href="/private">P</a><a href="mailto:x@example.com">m</a>'));
    }
    if (p === '/a') {
      return sendHtml(200, page('Page A', '<p>Alpha &amp; omega</p><a href="/a1">deeper</a>'));
    }
    if (p === '/a1') return sendHtml(200, page('Page A1', '<p>Deepest.</p>'));
    if (p === '/b') return sendHtml(200, page('Page B', '<p>Bravo.</p>'));
    if (p === '/private') return sendHtml(200, page('Private', '<p>must not be crawled</p>'));
    if (p === '/missing') return sendHtml(404, page('Nope', '<p>nothing here</p>'));
    if (p === '/slow') {
      setTimeout(() => sendHtml(200, page('Slow', '<p>too late</p>')), 4000);
      return;
    }
    sendHtml(404, page('Not found', '<p>404</p>'));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
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

const fixture = await makeFixture();
const fix = `http://127.0.0.1:${fixture.port}`;
const svc = await startService({
  VF_SERVICE_TOKEN: TOKEN,
  VF_CRAWLER_ALLOW_PRIVATE: '1',
  VF_CRAWLER_TIMEOUT_MS: '1200',
  LENS_URL: '',
  VAULT_URL: '',
});

try {
  await test('GET /healthz is public', async () => {
    const r = await call(svc.base, 'GET', '/healthz', undefined, null);
    assert.equal(r.status, 200);
    assert.equal(r.data.service, 'crawler');
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.version, '0.1.0');
    assert.equal(typeof r.data.uptime_s, 'number');
  });

  await test('GET / describes the service', async () => {
    const r = await call(svc.base, 'GET', '/', undefined, null);
    assert.equal(r.status, 200);
    assert.equal(r.data.service, 'crawler');
  });

  await test('OPTIONS returns 204 with CORS', async () => {
    const raw = await fetch(svc.base + '/v1/scrape', { method: 'OPTIONS' });
    assert.equal(raw.status, 204);
    assert.equal(raw.headers.get('access-control-allow-origin'), '*');
  });

  await test('POST /v1/scrape without token is 401', async () => {
    const r = await call(svc.base, 'POST', '/v1/scrape', { url: fix }, null);
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'unauthorized');
  });

  await test('POST /v1/scrape with bad token is 401', async () => {
    const r = await call(svc.base, 'POST', '/v1/scrape', { url: fix }, 'nope');
    assert.equal(r.status, 401);
  });

  await test('POST /v1/scrape missing url is 400', async () => {
    const r = await call(svc.base, 'POST', '/v1/scrape', {});
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'invalid_url');
  });

  await test('POST /v1/scrape refuses non-http scheme', async () => {
    const r = await call(svc.base, 'POST', '/v1/scrape', { url: 'ftp://example.com/x' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'invalid_url');
  });

  await test('POST /v1/scrape extracts title, text and links', async () => {
    const r = await call(svc.base, 'POST', '/v1/scrape', { url: fix + '/' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 200);
    assert.equal(r.data.title, 'Fixture Root');
    assert.match(r.data.text, /Hello fixture/);
    assert.ok(!/bad\(\)/.test(r.data.text), 'script content should be stripped');
    assert.ok(r.data.html_bytes > 100);
    assert.ok(r.data.links.includes(fix + '/a'));
    assert.ok(r.data.links.some((l) => l.endsWith('/a1')) === false);
    assert.ok(!r.data.links.some((l) => l.startsWith('mailto:')), 'mailto links filtered');
  });

  await test('POST /v1/scrape returns upstream 404 as data, not a crash', async () => {
    const r = await call(svc.base, 'POST', '/v1/scrape', { url: fix + '/missing' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 404);
    assert.equal(r.data.title, 'Nope');
  });

  await test('POST /v1/scrape times out on a slow upstream', async () => {
    const r = await call(svc.base, 'POST', '/v1/scrape', { url: fix + '/slow' });
    assert.equal(r.status, 504);
    assert.equal(r.data.error.code, 'upstream_timeout');
  });

  await test('POST /v1/crawl validates fields', async () => {
    const missing = await call(svc.base, 'POST', '/v1/crawl', {});
    assert.equal(missing.status, 400);
    const badDepth = await call(svc.base, 'POST', '/v1/crawl', { url: fix + '/', max_depth: 99 });
    assert.equal(badDepth.status, 400);
    const badBool = await call(svc.base, 'POST', '/v1/crawl', { url: fix + '/', same_origin: 'yes' });
    assert.equal(badBool.status, 400);
  });

  await test('POST /v1/crawl queues and completes a job respecting robots', async () => {
    const start = await call(svc.base, 'POST', '/v1/crawl', {
      url: fix + '/', max_pages: 5, max_depth: 2, same_origin: true,
    });
    assert.equal(start.status, 202);
    assert.equal(start.data.status, 'queued');
    assert.ok(start.data.job_id);
    let job = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const r = await call(svc.base, 'GET', `/v1/jobs/${start.data.job_id}`);
      assert.equal(r.status, 200);
      job = r.data;
      if (job.status === 'done' || job.status === 'failed') break;
      await sleep(200);
    }
    assert.equal(job.status, 'done', `job ended ${job && job.status}: ${job && job.error}`);
    assert.equal(job.pages_done, job.pages.length);
    const urls = job.pages.map((p) => p.url);
    assert.ok(urls.includes(fix + '/'), 'root crawled');
    assert.ok(urls.some((u) => u.endsWith('/a')), 'first link crawled');
    assert.ok(urls.some((u) => u.endsWith('/a1')), 'depth 2 link crawled');
    assert.ok(!urls.some((u) => u.endsWith('/private')), 'robots disallow respected');
    assert.ok(job.started_at && job.ended_at);
    assert.ok(job.pages.every((p) => typeof p.title === 'string' && typeof p.text === 'string'));
  });

  await test('GET /v1/jobs lists recent jobs', async () => {
    const r = await call(svc.base, 'GET', '/v1/jobs');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.jobs));
    assert.ok(r.data.jobs.length >= 1);
    assert.ok(r.data.jobs[0].job_id);
    assert.ok(r.data.jobs[0].pages_done >= 1);
  });

  await test('GET /v1/jobs/:id unknown is 404', async () => {
    const r = await call(svc.base, 'GET', '/v1/jobs/deadbeef');
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'job_not_found');
  });
} finally {
  stop(svc);
}

const strict = await startService({
  VF_SERVICE_TOKEN: TOKEN,
  VF_CRAWLER_ALLOW_PRIVATE: '0',
  LENS_URL: '',
  VAULT_URL: '',
});
try {
  await test('POST /v1/scrape refuses private targets when not allowed', async () => {
    const r = await call(strict.base, 'POST', '/v1/scrape', { url: fix + '/' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'private_target');
  });
  await test('localhost is refused when private targets are off', async () => {
    const r = await call(strict.base, 'POST', '/v1/scrape', { url: 'http://localhost:1/' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'private_target');
  });
} finally {
  stop(strict);
  fixture.server.close();
}

console.log(`\ncrawler: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('failed:', failures.join(', '));
  process.exit(1);
}
