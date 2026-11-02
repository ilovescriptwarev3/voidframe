const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'were', 'will', 'with',
]);

export function tokenize(text) {
  const out = [];
  const matches = String(text).toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu);
  for (const match of matches) {
    const token = match[0];
    if (token.length >= 2 && !STOPWORDS.has(token)) out.push(token);
  }
  return out;
}

function splitUnits(text) {
  const units = [];
  for (const paragraph of String(text).split(/\n{2,}/)) {
    if (!paragraph.trim()) continue;
    const sentences = paragraph.match(/[^.!?\n]+[.!?]*\s*/g) || [paragraph];
    for (const sentence of sentences) {
      if (sentence.length <= 900) {
        units.push(sentence);
      } else {
        for (let i = 0; i < sentence.length; i += 900) units.push(sentence.slice(i, i + 900));
      }
    }
  }
  return units.length ? units : [String(text)];
}

function pack(text, target) {
  const chunks = [];
  let current = '';
  for (const unit of splitUnits(text)) {
    if (current && current.length + unit.length > target) {
      chunks.push(current.trim());
      current = '';
    }
    current += unit;
    if (current.length >= target) {
      chunks.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export function chunkText(text, target = 900, maxChunks = 32) {
  let chunks = pack(text, target);
  if (chunks.length > maxChunks) {
    const size = Math.max(1, Math.ceil(String(text).length / maxChunks));
    chunks = pack(text, size);
  }
  if (chunks.length > maxChunks) {
    const flat = String(text);
    const step = Math.max(1, Math.ceil(flat.length / maxChunks));
    chunks = [];
    for (let i = 0; i < flat.length; i += step) chunks.push(flat.slice(i, i + step));
    chunks = chunks.slice(0, maxChunks);
  }
  return chunks;
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
