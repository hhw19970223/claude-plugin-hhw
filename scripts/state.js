import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR       = path.join(os.homedir(), '.claude', 'plugin-data', 'hhw');
export const CONFIG_PATH    = path.join(DATA_DIR, 'config.json');
export const SESSION_PATH   = path.join(DATA_DIR, 'session.json');
export const SESSION_ERROR  = path.join(DATA_DIR, 'session-error.json');
export const SOCKET_PATH    = path.join(DATA_DIR, 'daemon.sock');
export const DAEMON_LOG     = path.join(DATA_DIR, 'daemon.log');
export const PENDING_NOTIFS = path.join(DATA_DIR, 'pending_notifications.jsonl');
export const PENDING_AUTO   = path.join(DATA_DIR, 'pending_auto_tasks.jsonl');
export const INBOX_PATH     = path.join(DATA_DIR, 'inbox.jsonl');
export const HISTORY_PATH   = path.join(DATA_DIR, 'history.jsonl');
export const PRESENCE_PATH  = path.join(DATA_DIR, 'presence.json');
export const FILES_DIR      = path.join(DATA_DIR, 'files');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
}

export function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Atomic read-then-truncate for JSONL "queue" files.
// Uses rename() so concurrent appenders with O_APPEND keep writing to a new inode.
export function drainJsonl(file) {
  const tmp = file + '.reading.' + process.pid + '.' + Date.now();
  try {
    fs.renameSync(file, tmp);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  let text;
  try {
    text = fs.readFileSync(tmp, 'utf8');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt */ }
  }
  return out;
}

export function readJsonlAll(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Overwrite a JSONL file with the given list (used for inbox status updates).
export function writeJsonl(file, items) {
  const tmp = file + '.tmp.' + process.pid;
  const text = items.map(x => JSON.stringify(x)).join('\n') + (items.length ? '\n' : '');
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, obj, mode) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (mode != null) { try { fs.chmodSync(tmp, mode); } catch {} }
  fs.renameSync(tmp, file);
}

export function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
