import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './http.js';

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}

export function assertInside(root, target) {
  const base = path.resolve(root);
  const full = path.resolve(target);
  if (full !== base && !full.toLowerCase().startsWith(base.toLowerCase() + path.sep)) {
    throw httpError(400, 'path_traversal', 'Path escapes the sandbox.');
  }
  return full;
}

export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) {
    throw httpError(400, 'invalid_path', 'File path must be a non-empty string.');
  }
  const norm = rel.replace(/\\/g, '/');
  if (norm.includes('\0')) throw httpError(400, 'path_traversal', 'Path escapes the sandbox.');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
    throw httpError(400, 'path_traversal', 'Absolute paths are not allowed.');
  }
  if (norm.split('/').some((part) => part === '..')) {
    throw httpError(400, 'path_traversal', 'Path escapes the sandbox.');
  }
  return assertInside(root, path.join(root, norm));
}

export async function writeFiles(root, files) {
  if (files === undefined || files === null) return 0;
  if (typeof files !== 'object' || Array.isArray(files)) {
    throw httpError(400, 'invalid_files', 'Field "files" must be an object of path → content.');
  }
  const entries = Object.entries(files);
  if (entries.length > 200) throw httpError(400, 'invalid_files', 'Too many files (max 200).');
  let written = 0;
  for (const [rel, content] of entries) {
    if (typeof content !== 'string') {
      throw httpError(400, 'invalid_files', 'Each file content must be a string.');
    }
    const dest = safeJoin(root, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content, 'utf8');
    written++;
  }
  return written;
}

export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
