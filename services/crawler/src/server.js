import http from 'node:http';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, send, fail, requireToken, readBody, httpError, cors } from './http.js';
import { fetchPage, extractPage, ensureTarget, robotsAllowed } from './engine.js';

const NAME = 'crawler';
const VERSION = '0.1.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const jobs = new Map();

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

function jobId() {
  return crypto.randomBytes(8).toString('hex');
}

async function persist(job) {
  try {
    await fsp.mkdir(JOBS_DIR, { recursive: true });
    await fsp.writeFile(path.join(JOBS_DIR, `${job.job_id}.json`), JSON.stringify(job));
  } catch (err) {
    console.warn(`[${NAME}] could not persist job ${job.job_id}: ${err.message}`);
  }
}

async function loadJobs() {
  try {
    const files = await fsp.readdir(JOBS_DIR);
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const job = JSON.parse(await fsp.readFile(path.join(JOBS_DIR, f), 'utf8'));
        if (job && job.job_id) jobs.set(job.job_id, job);
      } catch { /* skip corrupt */ }
    }
  } catch { /* no jobs yet */ }
}

function publicJob(job) {
  const out = {
    job_id: job.job_id,
    status: job.status,
    pages_done: job.pages_done,
    pages: job.pages,
    started_at: job.started_at,
    ended_at: job.ended_at,
  };
  if (job.error) out.error = job.error;
  return out;
}

function summary(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    pages_done: job.pages_done,
    started_at: job.started_at,
    ended_at: job.ended_at,
    ...(job.error ? { error: job.error } : {}),
  };
}

function intOr(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, 'invalid_field', `Expected an integer between ${min} and ${max}.`);
  }
  return n;
}

function boolOr(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw httpError(400, 'invalid_field', 'Expected a boolean.');
  return value;
}

async function feedVault(collection, page) {
  const vault = process.env.VAULT_URL;
  if (!vault) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  fetch(`${vault.replace(/\/$/, '')}/v1/documents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vf-token': process.env.VF_SERVICE_TOKEN || 'dev-token-change-me',
    },
    body: JSON.stringify({
      collection,
      text: page.text,
      metadata: { url: page.url, title: page.title },
    }),
    signal: ctrl.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

async function crawlJob(job, options) {
  job.status = 'running';
  job.started_at = new Date().toISOString();
  await persist(job);
  log('info', 'crawl_started', { job_id: job.job_id, url: options.url });
  try {
    const start = new URL(options.url);
    const visited = new Set();
    const queue = [{ url: options.url, depth: 0 }];
    while (queue.length && job.pages.length < options.max_pages) {
      const item = queue.shift();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      let target;
      try {
        target = new URL(item.url);
      } catch {
        continue;
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
      try {
        await ensureTarget(target);
      } catch (err) {
        if (item.depth === 0) throw err;
        continue;
      }
      let allowed = true;
      try {
        allowed = await robotsAllowed(target);
      } catch { /* allow on robots failure */ }
      if (!allowed) continue;
      let page;
      let links = [];
      try {
        const res = await fetchPage(target.href);
        const extracted = extractPage(res.buffer.toString('utf8'), res.url);
        links = extracted.links;
        page = {
          url: res.url,
          status: res.status,
          title: extracted.title,
          text: extracted.text,
        };
      } catch (err) {
        if (item.depth === 0) throw err;
        continue;
      }
      job.pages.push(page);
      job.pages_done = job.pages.length;
      await persist(job);
      if (options.collection) feedVault(options.collection, page);
      if (item.depth < options.max_depth) {
        for (const link of links) {
          if (visited.has(link)) continue;
          if (options.same_origin && new URL(link).origin !== start.origin) continue;
          if (queue.length + job.pages.length >= options.max_pages * 3) break;
          queue.push({ url: link, depth: item.depth + 1 });
        }
      }
    }
    job.status = 'done';
  } catch (err) {
    job.status = 'failed';
    job.error = err.message || 'Crawl failed.';
    log('error', 'crawl_failed', { job_id: job.job_id, error: job.error });
  }
  job.ended_at = new Date().toISOString();
  await persist(job);
  if (job.status === 'done') log('info', 'crawl_finished', { job_id: job.job_id, pages: job.pages_done });
}


function validateUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw httpError(400, 'invalid_url', 'Field "url" is required.');
  }
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    throw httpError(400, 'invalid_url', 'A valid absolute URL is required.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw httpError(400, 'invalid_url', 'Only http(s) URLs are allowed.');
  }
  return u.href;
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

  if (req.method === 'POST' && p === '/v1/scrape') {
    const body = await readBody(req);
    const url = validateUrl(body.url);
    await ensureTarget(new URL(url));
    const resPage = await fetchPage(url);
    const extracted = extractPage(resPage.buffer.toString('utf8'), resPage.url);
    return json(res, 200, {
      url: resPage.url,
      status: resPage.status,
      title: extracted.title,
      text: extracted.text,
      html_bytes: resPage.buffer.length,
      links: extracted.links,
      fetched_at: new Date().toISOString(),
    });
  }

  if (req.method === 'POST' && p === '/v1/crawl') {
    const body = await readBody(req);
    const url = validateUrl(body.url);
    await ensureTarget(new URL(url));
    const options = {
      url,
      max_pages: intOr(body.max_pages, 20, 1, 200),
      same_origin: boolOr(body.same_origin, true),
      max_depth: intOr(body.max_depth, 2, 0, 5),
      collection: typeof body.collection === 'string' && body.collection.trim()
        ? body.collection.trim()
        : null,
    };
    if (body.collection !== undefined && options.collection === null) {
      throw httpError(400, 'invalid_field', 'Field "collection" must be a non-empty string.');
    }
    const job = {
      job_id: jobId(),
      status: 'queued',
      pages_done: 0,
      pages: [],
      started_at: null,
      ended_at: null,
    };
    jobs.set(job.job_id, job);
    await persist(job);
    setImmediate(() => { crawlJob(job, options).catch(() => {}); });
    return json(res, 202, { job_id: job.job_id, status: 'queued' });
  }

  if (req.method === 'GET' && p === '/v1/jobs') {
    const list = [...jobs.values()]
      .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
      .slice(0, 20)
      .map(summary);
    return json(res, 200, { jobs: list });
  }

  const jobMatch = p.match(/^\/v1\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) throw httpError(404, 'job_not_found', 'No job with that id.');
    return json(res, 200, publicJob(job));
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

await fsp.mkdir(JOBS_DIR, { recursive: true });
await loadJobs();
if (!process.env.VF_SERVICE_TOKEN) {
  console.warn(`[${NAME}] VF_SERVICE_TOKEN not set; using the development default token.`);
}
const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`[${NAME}] listening on :${port}`);
});

export { server };
