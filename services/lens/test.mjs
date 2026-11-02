import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RingBuffer } from './src/ring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-lens-token';
const DATA_DIR = join(HERE, 'data', `test-${process.pid}-${Date.now()}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(HERE, 'src', 'server.js')], {
  cwd: HERE,
  env: {
    ...process.env,
    PORT: String(port),
    VF_SERVICE_TOKEN: TOKEN,
    VF_LENS_DATA_DIR: DATA_DIR,
    LENS_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => { output += d.toString(); });
child.stderr.on('data', (d) => { output += d.toString(); });

let checks = 0;
function ok(cond, message) {
  assert.ok(cond, message);
  checks += 1;
}

async function call(method, path, { body, rawBody, token = TOKEN } = {}) {
  const headers = {};
  if (token !== null) headers['x-vf-token'] = token;
  let payload;
  if (rawBody !== undefined) {
    headers['content-type'] = 'application/json';
    payload = rawBody;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function waitReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

async function sseRoundTrip() {
  const controller = new AbortController();
  const res = await fetch(`${base}/v1/stream`, {
    headers: { 'x-vf-token': TOKEN },
    signal: controller.signal,
  });
  ok(res.status === 200, 'stream status');
  ok((res.headers.get('content-type') || '').includes('text/event-stream'), 'stream content type');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  async function readEvent(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let timer;
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('SSE read timeout')), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) throw new Error('stream ended unexpectedly');
      buf += decoder.decode(chunk.value, { stream: true });
      let split;
      while ((split = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, split);
        buf = buf.slice(split + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const parsed = JSON.parse(dataLine.slice(6));
        if (predicate(parsed)) return parsed;
      }
    }
    throw new Error('SSE event timeout');
  }

  try {
    const hello = await readEvent((e) => e.type === 'hello');
    ok(hello.type === 'hello', 'stream hello');
    await call('POST', '/ingest', {
      token: null,
      body: { service: 'streamsvc', level: 'info', event: 'live', fields: { n: 1 } },
    });
    const live = await readEvent((e) => e.type === 'log' && e.event === 'live');
    ok(live.service === 'streamsvc', 'stream log service');
    await call('POST', '/v1/metrics', {
      body: { name: 'stream_metric', value: 7, tags: {} },
    });
    const metricEvent = await readEvent((e) => e.type === 'metric' && e.name === 'stream_metric');
    ok(metricEvent.v === 7, 'stream metric value');
  } finally {
    controller.abort();
    try { await reader.cancel(); } catch {}
  }
}

let failed = false;
try {
  const probe = new RingBuffer(3);
  probe.push(1);
  probe.push(2);
  probe.push(3);
  probe.push(4);
  probe.push(5);
  ok(probe.length === 3, 'ring capacity enforced');
  ok(JSON.stringify(probe.toArray()) === '[3,4,5]', 'ring evicts oldest');

  await waitReady();

  const health = await call('GET', '/healthz', { token: null });
  ok(health.status === 200, 'health status');
  ok(health.data.service === 'lens' && health.data.status === 'ok', 'health body');
  ok(health.data.version === '0.1.0', 'health version');
  ok(typeof health.data.uptime_s === 'number', 'health uptime');

  const noAuth = await call('GET', '/', { token: null });
  ok(noAuth.status === 401 && noAuth.data.error.code === 'unauthorized', 'root requires token');

  const root = await call('GET', '/');
  ok(root.status === 200 && root.data.service === 'lens', 'banner');

  const preflight = await fetch(`${base}/v1/logs`, { method: 'OPTIONS' });
  ok(preflight.status === 204, 'OPTIONS is 204');
  ok(preflight.headers.get('access-control-allow-origin') === '*', 'CORS origin');

  const publicIngest = await call('POST', '/ingest', {
    token: null,
    body: { service: 'demo', level: 'info', event: 'booted', fields: { build: '1' } },
  });
  ok(publicIngest.status === 202, 'public ingest works without token');
  ok(publicIngest.data.ok === true, 'ingest body');

  await call('POST', '/ingest', {
    token: null,
    body: { service: 'demo', level: 'warn', event: 'slow', fields: { ms: 900 } },
  });
  await call('POST', '/ingest', {
    token: null,
    body: { service: 'demo', level: 'error', event: 'crash', fields: { reason: 'boom' } },
  });
  await call('POST', '/ingest', {
    token: null,
    body: { service: 'other', level: 'info', event: 'hello', fields: {} },
  });
  await call('POST', '/ingest', {
    token: null,
    body: { service: 'stale', level: 'info', event: 'old', ts: Date.now() - 120000 },
  });

  const badLevel = await call('POST', '/ingest', {
    token: null,
    body: { service: 'demo', level: 'trace', event: 'x' },
  });
  ok(badLevel.status === 400 && badLevel.data.error.code === 'invalid_level', 'invalid level');

  const missingService = await call('POST', '/ingest', {
    token: null,
    body: { level: 'info', event: 'x' },
  });
  ok(missingService.status === 400 && missingService.data.error.code === 'invalid_service', 'missing service');

  const badFields = await call('POST', '/ingest', {
    token: null,
    body: { service: 'demo', level: 'info', event: 'x', fields: [] },
  });
  ok(badFields.status === 400 && badFields.data.error.code === 'invalid_fields', 'invalid fields');

  const logs = await call('GET', '/v1/logs');
  ok(logs.status === 200, 'logs status');
  ok(logs.data.total === 5, `logs total (got ${logs.data.total})`);
  ok(logs.data.lines.length === 5, 'logs length');
  ok(logs.data.lines[0].service === 'stale', 'logs newest first');

  const byService = await call('GET', '/v1/logs?service=demo');
  ok(byService.data.total === 3 && byService.data.lines.every((l) => l.service === 'demo'), 'logs service filter');

  const byLevel = await call('GET', '/v1/logs?level=error');
  ok(byLevel.data.total === 1 && byLevel.data.lines[0].event === 'crash', 'logs level filter');

  const byQuery = await call('GET', '/v1/logs?q=booted');
  ok(byQuery.data.total === 1 && byQuery.data.lines[0].event === 'booted', 'logs q filter');

  const limited = await call('GET', '/v1/logs?limit=2');
  ok(limited.data.lines.length === 2 && limited.data.total === 5, 'logs limit');

  const noAuthLogs = await call('GET', '/v1/logs', { token: null });
  ok(noAuthLogs.status === 401, 'logs requires token');

  const m1 = await call('POST', '/v1/metrics', { body: { name: 'cpu', value: 10, tags: { host: 'a' } } });
  ok(m1.status === 202, 'metric ingest status');
  await call('POST', '/v1/metrics', { body: { name: 'cpu', value: 20, tags: { host: 'a' } } });
  await call('POST', '/v1/metrics', { body: { name: 'mem', value: 55, tags: {} } });

  const badMetric = await call('POST', '/v1/metrics', { body: { name: 'cpu', value: 'high' } });
  ok(badMetric.status === 400 && badMetric.data.error.code === 'invalid_value', 'invalid metric value');
  const badTags = await call('POST', '/v1/metrics', { body: { name: 'cpu', value: 1, tags: [] } });
  ok(badTags.status === 400 && badTags.data.error.code === 'invalid_tags', 'invalid metric tags');

  const series = await call('GET', '/v1/metrics?name=cpu&since_s=300');
  ok(series.status === 200 && series.data.series.length === 1, 'metric series count');
  ok(series.data.series[0].name === 'cpu' && series.data.series[0].points.length === 2, 'metric series points');
  ok(series.data.series[0].points[0].v === 10, 'metric points oldest first');
  ok(series.data.series[0].points[0].tags.host === 'a', 'metric tags kept');

  const allSeries = await call('GET', '/v1/metrics');
  ok(allSeries.data.series.length === 2, 'all series returned');

  const services = await call('GET', '/v1/services');
  ok(services.status === 200, 'services status');
  const demoSvc = services.data.services.find((s) => s.service === 'demo');
  ok(demoSvc.lines === 3, 'services line count');
  ok(demoSvc.level_counts.info === 1 && demoSvc.level_counts.warn === 1 && demoSvc.level_counts.error === 1, 'services level counts');
  ok(demoSvc.healthy === true, 'recent service healthy');
  const stale = services.data.services.find((s) => s.service === 'stale');
  ok(stale.healthy === false, 'stale service unhealthy');

  const alert1 = await call('POST', '/v1/alerts', {
    body: { name: 'cpu high', metric: 'cpu', op: 'gt', threshold: 12, window_s: 60 },
  });
  ok(alert1.status === 201 && typeof alert1.data.id === 'string', 'create metric alert');
  const alert2 = await call('POST', '/v1/alerts', {
    body: { name: 'cpu never', metric: 'cpu', op: 'gt', threshold: 1000 },
  });
  ok(alert2.status === 201, 'create non-firing alert');
  const alert3 = await call('POST', '/v1/alerts', {
    body: { name: 'demo errors', service: 'demo', op: 'gt', threshold: 0, window_s: 60 },
  });
  ok(alert3.status === 201, 'create log alert');

  const badAlert = await call('POST', '/v1/alerts', { body: { name: 'bad', op: 'eq', threshold: 1 } });
  ok(badAlert.status === 400 && badAlert.data.error.code === 'invalid_op', 'alert validates op');
  const badWindow = await call('POST', '/v1/alerts', { body: { name: 'bad', op: 'gt', threshold: 1, window_s: -1 } });
  ok(badWindow.status === 400 && badWindow.data.error.code === 'invalid_window', 'alert validates window');

  const alertList = await call('GET', '/v1/alerts');
  ok(alertList.data.alerts.length === 3, 'alerts list');

  const persisted = JSON.parse(readFileSync(join(DATA_DIR, 'lens.json'), 'utf8'));
  ok(persisted.alerts.length === 3, 'alerts persisted to lens.json');

  await new Promise((r) => setTimeout(r, 20));
  const firing = await call('GET', '/v1/alerts/firing');
  ok(firing.status === 200, 'firing status');
  const firingNames = firing.data.firing.map((f) => f.alert.name).sort();
  ok(JSON.stringify(firingNames) === JSON.stringify(['cpu high', 'demo errors']), 'firing alerts correct');
  const cpuFiring = firing.data.firing.find((f) => f.alert.name === 'cpu high');
  ok(cpuFiring.value === 15, 'metric alert value is window mean');
  ok(typeof cpuFiring.since === 'string', 'firing has since');
  const errorFiring = firing.data.firing.find((f) => f.alert.name === 'demo errors');
  ok(errorFiring.value === 1, 'log alert value is error count');

  const removed = await call('DELETE', `/v1/alerts/${alert2.data.id}`);
  ok(removed.status === 204, 'delete alert status');
  const deleteMissing = await call('DELETE', '/v1/alerts/nope');
  ok(deleteMissing.status === 404 && deleteMissing.data.error.code === 'alert_not_found', 'delete missing alert');
  const afterDelete = await call('GET', '/v1/alerts');
  ok(afterDelete.data.alerts.length === 2, 'alert deleted from list');
  const firingAfter = await call('GET', '/v1/alerts/firing');
  ok(firingAfter.data.firing.length === 2, 'firing unaffected by deleting non-firing alert');

  await sseRoundTrip();

  const unknown = await call('GET', '/v1/nope');
  ok(unknown.status === 404 && unknown.data.error.code === 'not_found', 'unknown route');
} catch (err) {
  failed = true;
  console.error(err);
  console.error('--- server output ---\n' + output);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 250));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

if (failed) process.exit(1);
console.log(`lens: green, ${checks} tests`);
process.exit(0);
