import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.VF_APEX_DATA_DIR || join(HERE, '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');
const DB_PATH = process.env.VF_APEX_DB || join(DATA_DIR, 'apex.db');

let db = null;
let users = null;

const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function loadUsers() {
  if (users) return users;
  mkdirSync(DATA_DIR, { recursive: true });
  users = { users: [], sessions: {} };
  if (existsSync(USERS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.users)) {
        users.users = parsed.users;
        users.sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
      }
    } catch {
      users = { users: [], sessions: {} };
    }
  }
  return users;
}

function saveUsers() {
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(users, null, 2));
  renameSync(tmp, USERS_FILE);
}

export function init() {
  loadUsers();
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      mode TEXT NOT NULL,
      autonomy TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      warning TEXT,
      steps TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_missions_user ON missions(user_id);
    CREATE TABLE IF NOT EXISTS usage (
      user_id TEXT PRIMARY KEY,
      requests INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

export function dbPath() {
  return DB_PATH;
}

export function usersPath() {
  return USERS_FILE;
}

export function createUser(email, password) {
  const state = loadUsers();
  if (state.users.some((u) => u.email === email)) return { error: 'email_taken' };
  const salt = randomBytes(16).toString('hex');
  const row = {
    id: newId('usr'),
    email,
    password_hash: scryptSync(password, salt, 64).toString('hex'),
    salt,
    created_at: nowIso(),
  };
  state.users.push(row);
  saveUsers();
  return { user_id: row.id, email: row.email, created_at: row.created_at };
}

export function findUserByEmail(email) {
  return loadUsers().users.find((u) => u.email === email) || null;
}

export function userById(id) {
  return loadUsers().users.find((u) => u.id === id) || null;
}

export function verifyPassword(row, password) {
  try {
    const expected = Buffer.from(row.password_hash, 'hex');
    const actual = scryptSync(password, row.salt, 64);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  loadUsers().sessions[hashToken(token)] = { user_id: userId, created_at: nowIso() };
  saveUsers();
  return token;
}

export function userForToken(token) {
  if (!token) return null;
  const session = loadUsers().sessions[hashToken(token)];
  if (!session) return null;
  return userById(session.user_id);
}

export function setGithub(userId, profile) {
  const state = loadUsers();
  const row = state.users.find((u) => u.id === userId);
  if (!row) return null;
  row.github = {
    id: String(profile.id),
    login: profile.login,
    name: profile.name || null,
    avatar_url: profile.avatar_url || null,
    linked_at: nowIso(),
  };
  saveUsers();
  return row.github;
}

export function publicUser(row) {
  return {
    user_id: row.id,
    email: row.email,
    created_at: row.created_at,
    github: row.github
      ? { login: row.github.login, name: row.github.name, avatar_url: row.github.avatar_url }
      : null,
  };
}

function missionView(row) {
  if (!row) return null;
  let steps = [];
  try {
    steps = JSON.parse(row.steps);
  } catch {
    steps = [];
  }
  let result = null;
  if (row.result) {
    try {
      result = JSON.parse(row.result);
    } catch {
      result = null;
    }
  }
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    prompt: row.prompt,
    mode: row.mode,
    autonomy: row.autonomy,
    status: row.status,
    result,
    warning: row.warning,
    steps,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function insertMission({ userId, title, prompt, mode, autonomy }) {
  const mission = {
    id: newId('msn'),
    user_id: userId,
    title,
    prompt,
    mode,
    autonomy,
    status: 'queued',
    result: null,
    warning: null,
    steps: [],
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  saveMission(mission);
  return mission;
}

function saveMission(m) {
  db.prepare(
    `INSERT INTO missions (id, user_id, title, prompt, mode, autonomy, status, result, warning, steps, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status, result = excluded.result, warning = excluded.warning,
       steps = excluded.steps, updated_at = excluded.updated_at`,
  ).run(
    m.id,
    m.user_id,
    m.title,
    m.prompt,
    m.mode,
    m.autonomy,
    m.status,
    m.result ? JSON.stringify(m.result) : null,
    m.warning,
    JSON.stringify(m.steps),
    m.created_at,
    m.updated_at,
  );
}

export function updateMission(m) {
  m.updated_at = nowIso();
  saveMission(m);
  return m;
}

export function getMission(id) {
  return missionView(db.prepare('SELECT * FROM missions WHERE id = ?').get(id));
}

export function listMissions(userId) {
  const rows = userId
    ? db.prepare('SELECT * FROM missions WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    : db.prepare('SELECT * FROM missions ORDER BY created_at DESC').all();
  return rows.map(missionView);
}

export function nextQueuedMission() {
  const row = db
    .prepare("SELECT * FROM missions WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get();
  return row ? missionView(row) : null;
}

export function addUsage(userId, promptTokens, completionTokens) {
  const key = userId || 'service';
  const existing = db.prepare('SELECT * FROM usage WHERE user_id = ?').get(key);
  if (existing) {
    db.prepare(
      `UPDATE usage SET requests = requests + 1,
        prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?,
        updated_at = ? WHERE user_id = ?`,
    ).run(promptTokens || 0, completionTokens || 0, nowIso(), key);
  } else {
    db.prepare(
      'INSERT INTO usage (user_id, requests, prompt_tokens, completion_tokens, updated_at) VALUES (?, 1, ?, ?, ?)',
    ).run(key, promptTokens || 0, completionTokens || 0, nowIso());
  }
}

export function getUsage(userId) {
  if (userId) {
    const row = db.prepare('SELECT * FROM usage WHERE user_id = ?').get(userId);
    return row
      ? {
          requests: row.requests,
          prompt_tokens: row.prompt_tokens,
          completion_tokens: row.completion_tokens,
          updated_at: row.updated_at,
        }
      : { requests: 0, prompt_tokens: 0, completion_tokens: 0, updated_at: null };
  }
  const rows = db.prepare('SELECT * FROM usage').all();
  return {
    requests: rows.reduce((sum, r) => sum + r.requests, 0),
    prompt_tokens: rows.reduce((sum, r) => sum + r.prompt_tokens, 0),
    completion_tokens: rows.reduce((sum, r) => sum + r.completion_tokens, 0),
    accounts: rows.length,
    updated_at: nowIso(),
  };
}
