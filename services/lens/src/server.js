import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cors, fail, json, readBody, requireToken, send } from './http.js';
import { RingBuffer } from './ring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = 'lens';
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 8086);
const MAX_LOGS = 5000;
const MAX_METRICS = 2000;
const LEVELS = new Set(['info', 'warn', 'error']);
const DATA_DIR = process.env.VF_LENS_DATA_DIR || join(HERE, '..', 'data');
const ALERT_FILE = join(DATA_DIR, 'lens.json');
const startedAt = Date.now();

const logs = new RingBuffer(MAX_LOGS);
const metrics = new RingBuffer(MAX_METRICS);
const clients = new Set();
const alertState = new Map();
let alerts = [];

if (!process.env.VF_SERVICE_TOKEN) {
  warn('missing_service_token', 'VF_SERVICE_TOKEN is not set; using the development default.');
}

function warn(event, message) {
  process.stderr.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: SERVICE,
      level: 'warn',
      event,
      fields: { message },
    }) + '\n',
  );
}

function pathOf(raw) {
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    return String(raw || '');
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTime(value, fallback = Date.now()) {
  if (value === undefined || value === null) return new Date(fallback).toISOString();
  const millis = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

function loadAlerts() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(ALERT_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(ALERT_FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.alerts;
    if (Array.isArray(list)) {
      alerts = list.filter((a) => plainObject(a) && typeof a.id === 'string' && typeof a.name === 'string');
    }
  } catch {
    warn('alerts_file_unreadable', 'data/lens.json could not be parsed; starting with no alerts.');
    alerts = [];
  }
}

function saveAlerts() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${ALERT_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ alerts }, null, 2));
  renameSync(tmp, ALERT_FILE);
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function computeAlert(alert, now) {
  const windowMs = Number(alert.window_s ?? 60) * 1000;
  const cutoff = now - windowMs;
  let value;
  if (alert.metric) {
    let sum = 0;
    let count = 0;
    for (const point of metrics.toArray()) {
      if (point.name !== alert.metric) continue;
      if (Date.parse(point.t) < cutoff) continue;
      sum += point.v;
      count += 1;
    }
    if (!count) return { firing: false, value: 0 };
    value = sum / count;
  } else {
    let count = 0;
    for (const line of logs.toArray()) {
      if (alert.service && line.service !== alert.service) continue;
      if (line.level !== 'error') continue;
      if (Date.parse(line.t) < cutoff) continue;
      count += 1;
    }
    value = count;
  }
  const rounded = Number(value.toFixed(6));
  const firing = alert.op === 'gt' ? rounded > alert.threshold : rounded < alert.threshold;
  return { firing, value: rounded };
}

function evaluateAlerts(now, emit) {
  const firing = [];
  const seen = new Set();
  for (const alert of alerts) {
    const result = computeAlert(alert, now);
    if (!result.firing) continue;
    seen.add(alert.id);
    if (!alertState.has(alert.id)) {
      const since = new Date(now).toISOString();
      alertState.set(alert.id, since);
      if (emit) broadcast({ type: 'alert', alert, value: result.value, since });
    }
    firing.push({ alert, value: result.value, since: alertState.get(alert.id) });
  }
  for (const id of [...alertState.keys()]) {
    if (!seen.has(id)) alertState.delete(id);
  }
  return firing;
}

function ingestLog(entry) {
  logs.push(entry);
  broadcast({ type: 'log', ...entry });
  evaluateAlerts(Date.now(), true);
}

function ingestMetric(sample) {
  metrics.push(sample);
  broadcast({ type: 'metric', ...sample });
  evaluateAlerts(Date.now(), true);
}

function listServices(now) {
  const map = new Map();
  for (const line of logs.toArray()) {
    let row = map.get(line.service);
    if (!row) {
      row = { service: line.service, last_seen: line.t, lines: 0, level_counts: { info: 0, warn: 0, error: 0 } };
      map.set(line.service, row);
    }
    row.lines += 1;
    row.level_counts[line.level] = (row.level_counts[line.level] || 0) + 1;
    if (Date.parse(line.t) >= Date.parse(row.last_seen)) row.last_seen = line.t;
  }
  return [...map.values()]
    .map((row) => ({
      ...row,
      healthy: now - Date.parse(row.last_seen) <= 60000,
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    send(res, 204);
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

  if (method === 'POST' && path === '/ingest') {
    const body = await readBody(req);
    if (typeof body.service !== 'string' || !body.service.trim()) {
      return fail(res, 400, 'invalid_service', 'service must be a non-empty string.');
    }
    if (!LEVELS.has(body.level)) {
      return fail(res, 400, 'invalid_level', 'level must be one of info, warn, error.');
    }
    if (typeof body.event !== 'string' || !body.event.trim()) {
      return fail(res, 400, 'invalid_event', 'event must be a non-empty string.');
    }
    if (body.fields !== undefined && !plainObject(body.fields)) {
      return fail(res, 400, 'invalid_fields', 'fields must be an object when provided.');
    }
    const t = parseTime(body.ts);
    if (t === null) return fail(res, 400, 'invalid_ts', 'ts must be a valid date or epoch milliseconds.');
    ingestLog({
      t,
      service: body.service,
      level: body.level,
      event: body.event,
      fields: body.fields || {},
    });
    return json(res, 202, { ok: true });
  }

  if (!requireToken(req, res)) return;

  if (method === 'GET' && path === '/') {
    json(res, 200, { service: SERVICE, docs: '/healthz' });
    return;
  }

  if (method === 'GET' && path === '/v1/logs') {
    const service = url.searchParams.get('service');
    const level = url.searchParams.get('level');
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LOGS) : 100;

    const all = logs.toArray();
    const matched = [];
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const line = all[i];
      if (service && line.service !== service) continue;
      if (level && line.level !== level) continue;
      if (q) {
        const hay = `${line.service} ${line.event} ${JSON.stringify(line.fields)}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      matched.push(line);
    }
    json(res, 200, { lines: matched.slice(0, limit), total: matched.length });
    return;
  }

  if (method === 'POST' && path === '/v1/metrics') {
    const body = await readBody(req);
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return fail(res, 400, 'invalid_name', 'name must be a non-empty string.');
    }
    if (!Number.isFinite(body.value)) {
      return fail(res, 400, 'invalid_value', 'value must be a finite number.');
    }
    if (body.tags !== undefined && !plainObject(body.tags)) {
      return fail(res, 400, 'invalid_tags', 'tags must be an object when provided.');
    }
    ingestMetric({
      name: body.name,
      v: body.value,
      t: new Date().toISOString(),
      tags: body.tags || {},
    });
    return json(res, 202, { ok: true });
  }

  if (method === 'GET' && path === '/v1/metrics') {
    const name = url.searchParams.get('name');
    const rawSince = Number.parseFloat(url.searchParams.get('since_s') || '300');
    const sinceS = Number.isFinite(rawSince) && rawSince >= 0 ? rawSince : 300;
    const cutoff = Date.now() - sinceS * 1000;
    const series = new Map();
    for (const point of metrics.toArray()) {
      if (name && point.name !== name) continue;
      if (Date.parse(point.t) < cutoff) continue;
      if (!series.has(point.name)) series.set(point.name, []);
      series.get(point.name).push({ t: point.t, v: point.v, tags: point.tags });
    }
    json(res, 200, {
      series: [...series.entries()].map(([seriesName, points]) => ({ name: seriesName, points })),
    });
    return;
  }

  if (method === 'GET' && path === '/v1/services') {
    json(res, 200, { services: listServices(Date.now()) });
    return;
  }

  if (method === 'GET' && path === '/v1/alerts/firing') {
    json(res, 200, { firing: evaluateAlerts(Date.now(), false) });
    return;
  }

  if (method === 'POST' && path === '/v1/alerts') {
    const body = await readBody(req);
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return fail(res, 400, 'invalid_name', 'name must be a non-empty string.');
    }
    if (body.op !== 'gt' && body.op !== 'lt') {
      return fail(res, 400, 'invalid_op', 'op must be "gt" or "lt".');
    }
    if (!Number.isFinite(body.threshold)) {
      return fail(res, 400, 'invalid_threshold', 'threshold must be a finite number.');
    }
    if (body.service !== undefined && (typeof body.service !== 'string' || !body.service.trim())) {
      return fail(res, 400, 'invalid_service', 'service must be a non-empty string when provided.');
    }
    if (body.metric !== undefined && (typeof body.metric !== 'string' || !body.metric.trim())) {
      return fail(res, 400, 'invalid_metric', 'metric must be a non-empty string when provided.');
    }
    if (body.window_s !== undefined && (!Number.isFinite(body.window_s) || body.window_s <= 0)) {
      return fail(res, 400, 'invalid_window', 'window_s must be a positive number.');
    }
    const alert = {
      id: randomUUID(),
      name: body.name,
      service: body.service || null,
      metric: body.metric || null,
      op: body.op,
      threshold: body.threshold,
      window_s: body.window_s ?? 60,
      created_at: new Date().toISOString(),
    };
    alerts.push(alert);
    saveAlerts();
    return json(res, 201, alert);
  }

  if (method === 'GET' && path === '/v1/alerts') {
    json(res, 200, { alerts });
    return;
  }

  const alertMatch = path.match(/^\/v1\/alerts\/([^/]+)$/);
  if (alertMatch && method === 'DELETE') {
    const id = alertMatch[1];
    const index = alerts.findIndex((a) => a.id === id);
    if (index === -1) return fail(res, 404, 'alert_not_found', `Alert "${id}" was not found.`);
    alerts.splice(index, 1);
    alertState.delete(id);
    saveAlerts();
    return send(res, 204);
  }

  if (method === 'GET' && path === '/v1/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', t: new Date().toISOString() })}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }, 15000);
    heartbeat.unref();
    const close = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    req.on('close', close);
    res.on('close', close);
    res.on('error', () => {});
    return;
  }

  return fail(res, 404, 'not_found', 'Route not found.');
}

loadAlerts();

const server = createServer((req, res) => {
  const started = Date.now();
  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    process.stdout.write(
      JSON.stringify({
        t: new Date().toISOString(),
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
      warn('unhandled_error', String(err && err.message));
    }
  });
});

server.listen(PORT, () => {
  process.stdout.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: SERVICE,
      level: 'info',
      event: 'listening',
      fields: { port: PORT },
    }) + '\n',
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
