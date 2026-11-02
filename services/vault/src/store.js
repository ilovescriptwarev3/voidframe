import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.VF_VAULT_DATA_DIR || join(HERE, '..', 'data');
const DB_FILE = join(DATA_DIR, 'vault.db');

const CHUNK_MAX = 900;
const MAX_CHUNKS = 32;

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS collections (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    text TEXT NOT NULL,
    metadata TEXT,
    embedding TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_collection ON chunks(collection);
  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL
  );
`);

const nowIso = () => new Date().toISOString();

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function chunkText(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return [];

  const units = [];
  for (const paragraph of trimmed.split(/\n\s*\n/)) {
    const body = paragraph.trim();
    if (!body) continue;
    if (body.length <= CHUNK_MAX) {
      units.push(body);
      continue;
    }
    const sentences = body.split(/(?<=[.!?])\s+/);
    let buffer = '';
    for (let sentence of sentences) {
      sentence = sentence.trim();
      if (!sentence) continue;
      while (sentence.length > CHUNK_MAX) {
        if (buffer) {
          units.push(buffer);
          buffer = '';
        }
        units.push(sentence.slice(0, CHUNK_MAX));
        sentence = sentence.slice(CHUNK_MAX).trim();
      }
      if (!sentence) continue;
      if (!buffer) {
        buffer = sentence;
      } else if (buffer.length + 1 + sentence.length <= CHUNK_MAX) {
        buffer += ' ' + sentence;
      } else {
        units.push(buffer);
        buffer = sentence;
      }
    }
    if (buffer) units.push(buffer);
  }

  const chunks = [];
  let current = '';
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    if (current.length + 2 + unit.length <= CHUNK_MAX) {
      current += '\n\n' + unit;
    } else {
      chunks.push(current);
      current = unit;
      if (chunks.length >= MAX_CHUNKS) break;
    }
  }
  if (current && chunks.length < MAX_CHUNKS) chunks.push(current);
  return chunks.slice(0, MAX_CHUNKS);
}

export function createCollection(name) {
  const now = nowIso();
  const existing = db.prepare('SELECT name FROM collections WHERE name = ?').get(name);
  if (!existing) {
    db.prepare('INSERT INTO collections (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, now, now);
  }
  return { name };
}

export function listCollections() {
  const rows = db
    .prepare(
      `SELECT c.name AS name,
              (SELECT COUNT(*) FROM documents d WHERE d.collection = c.name) AS documents,
              c.updated_at AS updated_at
         FROM collections c
        ORDER BY c.name`,
    )
    .all();
  return rows.map((r) => ({ name: r.name, documents: Number(r.documents), updated_at: r.updated_at }));
}

export function putDocument({ id, collection, text, metadata, embedding, chunks }) {
  const now = nowIso();
  const metadataJson = metadata === undefined ? null : JSON.stringify(metadata);
  const embeddingJson = embedding === undefined ? null : JSON.stringify(embedding);

  db.exec('BEGIN');
  try {
    const existingCollection = db.prepare('SELECT name FROM collections WHERE name = ?').get(collection);
    if (existingCollection) {
      db.prepare('UPDATE collections SET updated_at = ? WHERE name = ?').run(now, collection);
    } else {
      db.prepare('INSERT INTO collections (name, created_at, updated_at) VALUES (?, ?, ?)').run(collection, now, now);
    }

    const existing = db.prepare('SELECT id FROM documents WHERE id = ?').get(id);
    if (existing) {
      db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
      db.prepare(
        'UPDATE documents SET collection = ?, text = ?, metadata = ?, embedding = ?, updated_at = ? WHERE id = ?',
      ).run(collection, text, metadataJson, embeddingJson, now, id);
    } else {
      db.prepare(
        'INSERT INTO documents (id, collection, text, metadata, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, collection, text, metadataJson, embeddingJson, now, now);
    }

    const insertChunk = db.prepare(
      'INSERT INTO chunks (doc_id, collection, seq, text, embedding) VALUES (?, ?, ?, ?, ?)',
    );
    chunks.forEach((chunk, seq) => insertChunk.run(id, collection, seq, chunk, embeddingJson));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id, collection, chunks: chunks.length };
}

function documentRow(row) {
  return {
    id: row.id,
    collection: row.collection,
    text: row.text,
    metadata: parseJson(row.metadata, null),
    embedding: parseJson(row.embedding, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getDocument(id) {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) return null;
  const chunks = db
    .prepare('SELECT seq, text, embedding FROM chunks WHERE doc_id = ? ORDER BY seq')
    .all(id)
    .map((c) => ({ seq: Number(c.seq), text: c.text, embedding: parseJson(c.embedding, null) }));
  return { ...documentRow(row), chunks };
}

export function deleteDocument(id) {
  const row = db.prepare('SELECT collection FROM documents WHERE id = ?').get(id);
  if (!row) return false;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    db.prepare('UPDATE collections SET updated_at = ? WHERE name = ?').run(nowIso(), row.collection);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

function loadChunks(collection) {
  const sql = `SELECT c.id AS chunk_id, c.doc_id, c.collection, c.text, c.embedding,
                      d.metadata AS doc_metadata
                 FROM chunks c JOIN documents d ON d.id = c.doc_id
                ${collection ? 'WHERE c.collection = ?' : ''}
                ORDER BY c.id`;
  const rows = collection ? db.prepare(sql).all(collection) : db.prepare(sql).all();
  return rows.map((r) => ({ ...r, chunk_id: Number(r.chunk_id) }));
}

function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1);
}

function toResult(entry) {
  return {
    id: entry.row.doc_id,
    collection: entry.row.collection,
    text: entry.row.text,
    score: Number(entry.score.toFixed(6)),
    metadata: parseJson(entry.row.doc_metadata, null),
  };
}

export function searchKeyword({ collection, query, limit }) {
  const rows = loadChunks(collection);
  if (!rows.length) return [];

  const tokenized = rows.map((r) => tokenize(r.text));
  const lengths = tokenized.map((t) => t.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / rows.length || 1;
  const df = new Map();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) || 0) + 1);
  }

  const terms = [...new Set(tokenize(query))];
  const N = rows.length;
  const k1 = 1.2;
  const b = 0.75;
  const scored = rows.map((row, i) => {
    if (!terms.length || !lengths[i]) return { row, score: 0 };
    const counts = new Map();
    for (const token of tokenized[i]) counts.set(token, (counts.get(token) || 0) + 1);
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term) || 0;
      if (!tf) continue;
      const d = df.get(term) || 0;
      const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lengths[i]) / avgLength));
    }
    return { row, score };
  });

  scored.sort((a, b2) => b2.score - a.score || b2.row.chunk_id - a.row.chunk_id);
  let chosen = scored.filter((entry) => entry.score > 0).slice(0, limit);
  if (!chosen.length) chosen = scored.slice(0, limit);
  return chosen.map(toResult);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function searchEmbedding({ collection, queryEmbedding, limit }) {
  const rows = loadChunks(collection);
  if (!rows.length) return [];
  const scored = rows.map((row) => ({
    row,
    score: cosine(queryEmbedding, parseJson(row.embedding, null)),
  }));
  scored.sort((a, b) => b.score - a.score || b.row.chunk_id - a.row.chunk_id);
  return scored.slice(0, limit).map(toResult);
}

function edgeView(row) {
  return {
    id: Number(row.id),
    from: row.from_node,
    to: row.to_node,
    kind: row.kind,
    metadata: parseJson(row.metadata, null),
    created_at: row.created_at,
  };
}

export function addEdge({ from, to, kind, metadata }) {
  const now = nowIso();
  const info = db
    .prepare('INSERT INTO edges (from_node, to_node, kind, metadata, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(from, to, kind, metadata === undefined ? null : JSON.stringify(metadata), now);
  return {
    id: Number(info.lastInsertRowid),
    from,
    to,
    kind,
    metadata: metadata === undefined ? null : metadata,
    created_at: now,
  };
}

export function getGraph(node, depth) {
  const edges = db.prepare('SELECT * FROM edges ORDER BY id').all().map(edgeView);
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push(edge);
    if (edge.to !== edge.from) adjacency.get(edge.to).push(edge);
  }

  const visited = new Set([node]);
  const usedEdges = new Map();
  let frontier = [node];
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next = [];
    for (const current of frontier) {
      for (const edge of adjacency.get(current) || []) {
        usedEdges.set(edge.id, edge);
        const other = edge.from === current ? edge.to : edge.from;
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }

  return {
    nodes: [...visited].sort().map((id) => ({ id })),
    edges: [...usedEdges.values()].sort((a, b) => a.id - b.id),
  };
}
