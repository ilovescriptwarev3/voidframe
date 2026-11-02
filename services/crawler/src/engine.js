import dns from 'node:dns/promises';
import net from 'node:net';
import { httpError } from './http.js';

const UA = 'VoidframeCrawler/0.1 (+https://voidframe.local)';
const PAGE_CAP = 5 * 1024 * 1024;
const TEXT_CAP = 200 * 1024;
const ROBOT_TTL = 5 * 60 * 1000;

const allowPrivate = () => process.env.VF_CRAWLER_ALLOW_PRIVATE === '1';
const robotsOn = () => process.env.VF_CRAWLER_ROBOTS !== '0';

export function requestTimeout() {
  const v = Number(process.env.VF_CRAWLER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 10000;
}

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateIp(ip) {
  let s = String(ip).toLowerCase();
  if (s.startsWith('[')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const kind = net.isIP(s);
  if (kind === 4) return isPrivateV4(s);
  if (kind === 6) {
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('::ffff:')) {
      const rest = s.slice(7);
      if (net.isIP(rest) === 4) return isPrivateV4(rest);
    }
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return true;
}

export async function ensureTarget(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw httpError(400, 'invalid_url', 'Only http(s) URLs are allowed.');
  }
  if (allowPrivate()) return;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    throw httpError(400, 'private_target', 'Private and localhost targets are not allowed.');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw httpError(400, 'private_target', 'Private targets are not allowed.');
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw httpError(502, 'fetch_failed', `Could not resolve host ${host}.`);
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw httpError(400, 'private_target', 'Private targets are not allowed.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastHit = new Map();
const chains = new Map();

function rateLimit(host) {
  const prev = chains.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const wait = 1000 - (Date.now() - (lastHit.get(host) || 0));
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  }).catch(() => {});
  chains.set(host, next);
  return next;
}

async function readCapped(res, cap = PAGE_CAP) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  if (!res.body) return { buffer: Buffer.alloc(0), truncated };
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
      if (total >= cap) {
        truncated = total > cap;
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  let buffer = Buffer.concat(chunks);
  if (buffer.length > cap) {
    truncated = true;
    buffer = buffer.subarray(0, cap);
  }
  return { buffer, truncated };
}

function mapFetchError(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return httpError(504, 'upstream_timeout', 'Upstream did not respond in time.');
  }
  return httpError(502, 'fetch_failed', `Could not fetch URL: ${err && err.message ? err.message : 'unknown error'}`);
}

export async function fetchPage(rawUrl, opt = {}) {
  const timeoutMs = opt.timeoutMs || requestTimeout();
  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    throw httpError(400, 'invalid_url', 'A valid absolute URL is required.');
  }
  const cap = opt.maxBytes || PAGE_CAP;
  for (let hop = 0; hop <= 5; hop++) {
    await ensureTarget(current);
    await rateLimit(current.host);
    let res;
    try {
      res = await fetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      });
    } catch (err) {
      throw mapFetchError(err);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (loc) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        try {
          current = new URL(loc, current);
        } catch {
          throw httpError(502, 'fetch_failed', 'Upstream sent an invalid redirect.');
        }
        continue;
      }
    }
    const { buffer, truncated } = await readCapped(res, cap);
    return {
      status: res.status,
      url: current.href,
      contentType: res.headers.get('content-type') || '',
      buffer,
      truncated,
    };
  }
  throw httpError(502, 'too_many_redirects', 'Too many redirects.');
}

const robotCache = new Map();

function parseRobots(text) {
  const groups = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || !line.includes(':')) continue;
    const i = line.indexOf(':');
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || cur.hasRules) {
        cur = { agents: [], rules: [], hasRules: false };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.hasRules = true;
      if (val) cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const out = [];
  for (const g of groups) {
    if (g.agents.some((a) => a === '*' || a.includes('voidframe'))) out.push(...g.rules);
  }
  return out;
}

function allowedBy(rules, target) {
  let best = null;
  for (const rule of rules) {
    if (target.startsWith(rule.path) && (!best || rule.path.length > best.path.length)) best = rule;
  }
  return best ? best.allow : true;
}

export async function robotsAllowed(u) {
  if (!robotsOn()) return true;
  let entry = robotCache.get(u.origin);
  if (!entry || Date.now() - entry.at > ROBOT_TTL) {
    const rules = [];
    try {
      await rateLimit(u.host);
      const res = await fetch(new URL('/robots.txt', u.origin).href, {
        signal: AbortSignal.timeout(Math.min(requestTimeout(), 5000)),
        headers: { 'user-agent': UA },
      });
      if (res.ok) {
        const { buffer } = await readCapped(res, 512 * 1024);
        rules.push(...parseRobots(buffer.toString('utf8')));
      } else {
        try { await res.body?.cancel(); } catch { /* ignore */ }
      }
    } catch { /* unreachable robots means allow */ }
    entry = { at: Date.now(), rules };
    robotCache.set(u.origin, entry);
  }
  return allowedBy(entry.rules, u.pathname + u.search);
}

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
    rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d',
    copy: '\u00a9', reg: '\u00ae', trade: '\u2122', middot: '\u00b7',
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

export function extractPage(html, baseUrl) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!raw) continue;
    let u;
    try { u = new URL(raw, baseUrl); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    links.push(u.href);
  }
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text).replace(/\s+/g, ' ').trim();
  if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP);
  return { title, text, links };
}
