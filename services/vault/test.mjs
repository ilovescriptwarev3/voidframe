import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-vault-token';
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
    VF_VAULT_DATA_DIR: DATA_DIR,
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
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

const longText = Array.from({ length: 7 }, (_, i) =>
  `Paragraph ${i}. ${'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(24)}`,
).join('\n\n');

let failed = false;
try {
  await waitReady();

  const health = await call('GET', '/healthz', { token: null });
  ok(health.status === 200, 'health status');
  ok(health.data.service === 'vault' && health.data.status === 'ok', 'health body');
  ok(health.data.version === '0.1.0', 'health version');
  ok(typeof health.data.uptime_s === 'number', 'health uptime');

  const noAuth = await call('GET', '/', { token: null });
  ok(noAuth.status === 401 && noAuth.data.error.code === 'unauthorized', 'root requires token');

  const root = await call('GET', '/');
  ok(root.status === 200 && root.data.service === 'vault' && root.data.docs === '/healthz', 'banner');

  const preflight = await fetch(`${base}/v1/collections`, { method: 'OPTIONS' });
  ok(preflight.status === 204, 'OPTIONS is 204');
  ok(preflight.headers.get('access-control-allow-origin') === '*', 'CORS origin');

  const badCollection = await call('POST', '/v1/collections', { body: {} });
  ok(badCollection.status === 400 && badCollection.data.error.code === 'invalid_name', 'collection validates name');

  const collection = await call('POST', '/v1/collections', { body: { name: 'notes' } });
  ok(collection.status === 201 && collection.data.name === 'notes', 'create collection');
  const again = await call('POST', '/v1/collections', { body: { name: 'notes' } });
  ok(again.status === 201, 'create collection is idempotent');

  const emptyCollection = await call('POST', '/v1/collections', { body: { name: 'empty' } });
  ok(emptyCollection.status === 201, 'create empty collection');

  const collections = await call('GET', '/v1/collections');
  ok(collections.status === 200 && collections.data.collections.length === 2, 'list collections');
  const notes = collections.data.collections.find((c) => c.name === 'notes');
  ok(notes.documents === 0 && typeof notes.updated_at === 'string', 'collection counts');

  const badDoc = await call('POST', '/v1/documents', { body: { collection: 'notes' } });
  ok(badDoc.status === 400 && badDoc.data.error.code === 'invalid_text', 'document validates text');
  const badMeta = await call('POST', '/v1/documents', {
    body: { collection: 'notes', text: 'x', metadata: [] },
  });
  ok(badMeta.status === 400 && badMeta.data.error.code === 'invalid_metadata', 'document validates metadata');

  const doc1 = await call('POST', '/v1/documents', {
    body: {
      id: 'doc1',
      collection: 'notes',
      text: 'The quick brown fox jumps over the lazy dog.\n\nA second paragraph about foxes.',
      metadata: { source: 'test', topic: 'animals' },
      embedding: [1, 0, 0],
    },
  });
  ok(doc1.status === 201, 'create doc1');
  ok(doc1.data.id === 'doc1' && doc1.data.collection === 'notes', 'doc1 shape');
  ok(doc1.data.chunks >= 1, 'doc1 chunk count');

  const doc2 = await call('POST', '/v1/documents', {
    body: {
      id: 'doc2',
      collection: 'notes',
      text: 'Dogs are loyal companions and make excellent pets.',
      metadata: { source: 'test', topic: 'dogs' },
      embedding: [0, 1, 0],
    },
  });
  ok(doc2.status === 201, 'create doc2');

  const longDoc = await call('POST', '/v1/documents', {
    body: { collection: 'notes', text: longText },
  });
  ok(longDoc.status === 201, 'create long doc');
  ok(typeof longDoc.data.id === 'string' && longDoc.data.id.length > 0, 'generated id');
  ok(longDoc.data.chunks >= 2, 'long doc split into chunks');
  ok(longDoc.data.chunks <= 32, 'long doc capped at 32 chunks');

  const fetchedLong = await call('GET', `/v1/documents/${longDoc.data.id}`);
  ok(fetchedLong.status === 200 && Array.isArray(fetchedLong.data.chunks), 'long doc chunks returned');
  ok(fetchedLong.data.chunks.length === longDoc.data.chunks, 'chunk count matches');
  ok(fetchedLong.data.chunks.every((c) => c.text.length <= 900), 'every chunk <= 900 chars');
  ok(fetchedLong.data.chunks.every((c, i) => c.seq === i), 'chunk sequence is ordered');

  const got = await call('GET', '/v1/documents/doc1');
  ok(got.status === 200, 'get doc1');
  ok(got.data.text.includes('quick brown fox'), 'get doc1 text');
  ok(got.data.metadata.source === 'test' && got.data.metadata.topic === 'animals', 'get doc1 metadata');
  ok(Array.isArray(got.data.embedding) && got.data.embedding[0] === 1, 'get doc1 embedding');
  ok(Array.isArray(got.data.chunks) && got.data.chunks[0].seq === 0, 'get doc1 chunks');

  const missingDoc = await call('GET', '/v1/documents/nope');
  ok(missingDoc.status === 404 && missingDoc.data.error.code === 'document_not_found', 'missing doc 404');

  const badEmbedding = await call('POST', '/v1/documents', {
    body: { collection: 'notes', text: 'x', embedding: [1, 'a'] },
  });
  ok(badEmbedding.status === 400 && badEmbedding.data.error.code === 'invalid_embedding', 'document validates embedding');

  const keyword = await call('POST', '/v1/search', { body: { collection: 'notes', query: 'quick fox' } });
  ok(keyword.status === 200 && keyword.data.results.length > 0, 'keyword search returns results');
  ok(keyword.data.results[0].id === 'doc1', 'keyword search ranks fox doc first');
  ok(keyword.data.results[0].score > 0, 'keyword score positive');
  ok(keyword.data.results[0].metadata.source === 'test', 'search metadata returned');
  ok(typeof keyword.data.results[0].text === 'string', 'search text returned');

  const limited = await call('POST', '/v1/search', { body: { collection: 'notes', query: 'fox', limit: 1 } });
  ok(limited.data.results.length === 1, 'search honours limit');

  const nonsense = await call('POST', '/v1/search', { body: { collection: 'notes', query: 'zzzznotaword' } });
  ok(nonsense.data.results.length > 0, 'non-empty collection never returns empty keyword results');

  const emptySearch = await call('POST', '/v1/search', { body: { collection: 'empty', query: 'anything' } });
  ok(emptySearch.status === 200 && emptySearch.data.results.length === 0, 'empty collection returns no results');

  const vector = await call('POST', '/v1/search', {
    body: { collection: 'notes', query: '', query_embedding: [0.9, 0.1, 0], limit: 5 },
  });
  ok(vector.status === 200 && vector.data.results.length > 0, 'vector search returns results');
  ok(vector.data.results[0].id === 'doc1', 'vector search ranks matching embedding first');
  ok(vector.data.results[0].score > 0.9, 'vector score is cosine');
  const doc2Vector = vector.data.results.find((r) => r.id === 'doc2');
  ok(doc2Vector && doc2Vector.score < vector.data.results[0].score, 'weaker vector ranks lower');

  const badQuery = await call('POST', '/v1/search', { body: { collection: 'notes' } });
  ok(badQuery.status === 400 && badQuery.data.error.code === 'invalid_query', 'search validates query');
  const badLimit = await call('POST', '/v1/search', { body: { query: 'x', limit: 0 } });
  ok(badLimit.status === 400 && badLimit.data.error.code === 'invalid_limit', 'search validates limit');

  const edge1 = await call('POST', '/v1/edges', { body: { from: 'a', to: 'b', kind: 'links', metadata: { weight: 1 } } });
  ok(edge1.status === 201 && typeof edge1.data.id === 'number', 'create edge');
  const edge2 = await call('POST', '/v1/edges', { body: { from: 'b', to: 'c', kind: 'links' } });
  ok(edge2.status === 201, 'create second edge');
  await call('POST', '/v1/edges', { body: { from: 'x', to: 'y', kind: 'other' } });

  const badEdge = await call('POST', '/v1/edges', { body: { to: 'b', kind: 'links' } });
  ok(badEdge.status === 400 && badEdge.data.error.code === 'invalid_from', 'edge validates from');
  const badEdgeMeta = await call('POST', '/v1/edges', { body: { from: 'a', to: 'b', kind: 'k', metadata: 1 } });
  ok(badEdgeMeta.status === 400 && badEdgeMeta.data.error.code === 'invalid_metadata', 'edge validates metadata');

  const graph1 = await call('GET', '/v1/graph?node=a&depth=1');
  ok(graph1.status === 200, 'graph status');
  ok(JSON.stringify(graph1.data.nodes.map((n) => n.id).sort()) === JSON.stringify(['a', 'b']), 'depth 1 nodes');
  ok(graph1.data.edges.length === 1, 'depth 1 edges');

  const graph2 = await call('GET', '/v1/graph?node=a&depth=2');
  ok(JSON.stringify(graph2.data.nodes.map((n) => n.id).sort()) === JSON.stringify(['a', 'b', 'c']), 'depth 2 nodes');
  ok(graph2.data.edges.length === 2, 'depth 2 edges');
  ok(graph2.data.edges[0].metadata.weight === 1, 'edge metadata returned');

  const graph0 = await call('GET', '/v1/graph?node=a&depth=0');
  ok(JSON.stringify(graph0.data.nodes) === JSON.stringify([{ id: 'a' }]) && graph0.data.edges.length === 0, 'depth 0');

  const graphClamped = await call('GET', '/v1/graph?node=a&depth=9');
  ok(graphClamped.data.nodes.length === 3, 'depth clamps to 4');

  const badNode = await call('GET', '/v1/graph');
  ok(badNode.status === 400 && badNode.data.error.code === 'invalid_node', 'graph requires node');
  const badDepth = await call('GET', '/v1/graph?node=a&depth=abc');
  ok(badDepth.status === 400 && badDepth.data.error.code === 'invalid_depth', 'graph validates depth');

  const removed = await call('DELETE', '/v1/documents/doc1');
  ok(removed.status === 204, 'delete doc');
  const gone = await call('GET', '/v1/documents/doc1');
  ok(gone.status === 404, 'deleted doc gone');
  const deleteMissing = await call('DELETE', '/v1/documents/doc1');
  ok(deleteMissing.status === 404 && deleteMissing.data.error.code === 'document_not_found', 'delete missing doc');

  const afterDelete = await call('GET', '/v1/collections');
  const notesAfter = afterDelete.data.collections.find((c) => c.name === 'notes');
  ok(notesAfter.documents === 2, 'document count updated after delete');

  const known = await call('GET', '/v1/nope');
  ok(known.status === 404 && known.data.error.code === 'not_found', 'unknown route');

  const badJson = await call('POST', '/v1/collections', { rawBody: '{nope' });
  ok(badJson.status === 400 && badJson.data.error.code === 'invalid_json', 'invalid json');
} catch (err) {
  failed = true;
  console.error(err);
  console.error('--- server output ---\n' + output);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

if (failed) process.exit(1);
console.log(`vault: green, ${checks} tests`);
process.exit(0);
