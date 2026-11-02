import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, '..', 'data');
const DATA_DIR = process.env.VF_KEYCHAIN_DATA_DIR || DEFAULT_DIR;
const FILE = join(DATA_DIR, 'secrets.json');
const SALT = 'voidframe/keychain/v1';
const FALLBACK_KEY = 'dev-master-key-change-me';

let derivedKey = null;
let state = null;

function warn(event, message) {
  process.stderr.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: 'keychain',
      level: 'warn',
      event,
      fields: { message },
    }) + '\n',
  );
}

function masterKey() {
  if (derivedKey) return derivedKey;
  const raw = process.env.VF_MASTER_KEY;
  if (!raw) {
    warn('missing_master_key', 'VF_MASTER_KEY is not set; using the development default.');
  }
  derivedKey = scryptSync(raw || FALLBACK_KEY, SALT, 32);
  return derivedKey;
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ciphertext.toString('base64'),
  };
}

function decrypt(record) {
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(record.ct, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (state) return state;
  ensureDir();
  state = { version: 1, secrets: {} };
  if (existsSync(FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && typeof parsed.secrets === 'object' && parsed.secrets !== null) {
        state.secrets = parsed.secrets;
      }
    } catch {
      warn('secrets_file_unreadable', 'data/secrets.json could not be parsed; starting empty.');
      state = { version: 1, secrets: {} };
    }
  }
  return state;
}

function save() {
  ensureDir();
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, FILE);
}

function view(record) {
  return {
    name: record.name,
    meta: record.meta ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export function init() {
  load();
}

export function listSecrets() {
  return Object.values(load().secrets)
    .map(view)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSecret(name) {
  const record = load().secrets[name];
  if (!record) return null;
  return { ...view(record), value: decrypt(record) };
}

export function putSecret(name, value, meta) {
  const secrets = load().secrets;
  const now = new Date().toISOString();
  const existing = secrets[name];
  const created_at = existing ? existing.created_at : now;
  const nextMeta = meta === undefined ? existing?.meta ?? null : meta;
  secrets[name] = {
    name,
    meta: nextMeta,
    created_at,
    updated_at: now,
    ...encrypt(value),
  };
  save();
  return { name, created_at, updated_at: now };
}

export function rotateSecret(name, value) {
  const secrets = load().secrets;
  const existing = secrets[name];
  if (!existing) return null;
  const now = new Date().toISOString();
  secrets[name] = {
    ...existing,
    updated_at: now,
    ...encrypt(value),
  };
  save();
  return { name, updated_at: now };
}

export function deleteSecret(name) {
  const secrets = load().secrets;
  if (!(name in secrets)) return false;
  delete secrets[name];
  save();
  return true;
}

export function redactText(text) {
  const pairs = [];
  for (const record of Object.values(load().secrets)) {
    try {
      const value = decrypt(record);
      if (value) pairs.push([value, record.name]);
    } catch {
      warn('decrypt_failed', `Could not decrypt secret "${record.name}" while redacting.`);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [value, name] of pairs) {
    out = out.split(value).join(`[redacted:${name}]`);
  }
  return out;
}
