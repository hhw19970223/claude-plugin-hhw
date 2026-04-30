import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR, SESSION_PATH, SESSION_ERROR, DAEMON_LOG, SOCKET_PATH,
  ensureDataDir, readJsonOrNull, pidAlive,
} from './state.js';
import { loadConfig, ConfigError } from './config.js';
import { userErr, userOut, MARKETING_JOIN } from './log.js';

const __filename = fileURLToPath(import.meta.url);
const DAEMON_PATH = path.join(path.dirname(__filename), 'daemon.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--name') { out.name = argv[++i]; continue; }
    const m1 = /^--name=(.+)$/.exec(a);       if (m1) { out.name = m1[1]; continue; }
    if (a === '--mode') { out.mode = argv[++i]; continue; }
    const m2 = /^--mode=(.+)$/.exec(a);       if (m2) { out.mode = m2[1]; continue; }
    if (a === '--hop-limit') { out.hopLimit = argv[++i]; continue; }
    const m3 = /^--hop-limit=(.+)$/.exec(a);  if (m3) { out.hopLimit = m3[1]; continue; }
    out._.push(a);
  }
  return out;
}

async function waitFor(predicate, { timeoutMs = 6000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return null;
}

async function main() {
  ensureDataDir();

  const args = parseArgs(process.argv.slice(2));

  let cfg;
  try { cfg = loadConfig(); }
  catch (e) {
    if (e instanceof ConfigError) { userErr(e.message); process.exit(1); }
    throw e;
  }

  const name = args.name || cfg.defaultName;
  if (!name) { userErr('Pass -n <name> to specify the username, or set defaultName in config.json.'); process.exit(1); }
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
    userErr(`Username "${name}" is invalid; must match ^[a-zA-Z0-9_-]{1,32}$`);
    process.exit(1);
  }
  const mode = args.mode || cfg.mode;
  if (mode && !['manual', 'auto'].includes(mode)) {
    userErr(`--mode must be manual or auto, got "${mode}"`);
    process.exit(1);
  }

  // Already running?
  const existing = readJsonOrNull(SESSION_PATH);
  if (existing && pidAlive(existing.pid)) {
    userErr(`nexscope is already running: name=${existing.name}, pid=${existing.pid}, mode=${existing.mode}. Run /nexscope:stop before starting again.`);
    process.exit(1);
  }
  if (existing) {
    // stale session file
    try { fs.unlinkSync(SESSION_PATH); } catch {}
  }
  try { fs.unlinkSync(SESSION_ERROR); } catch {}

  // Spawn detached daemon.
  const logFd = fs.openSync(DAEMON_LOG, 'a');
  const child = spawn(
    process.execPath,
    [DAEMON_PATH, `--name=${name}`, `--mode=${mode}`, `--hop-limit=${cfg.hopLimit}`],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    },
  );
  child.unref();
  fs.closeSync(logFd);

  // Wait for session.json or session-error.json.
  const ok = await waitFor(() => {
    const s = readJsonOrNull(SESSION_PATH);
    if (s && s.pid === child.pid) return { kind: 'ok', session: s };
    const err = readJsonOrNull(SESSION_ERROR);
    if (err) return { kind: 'err', error: err };
    return null;
  });

  if (!ok) {
    userErr(`daemon start timed out (6s); check ${DAEMON_LOG} for details.`);
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    process.exit(1);
  }
  if (ok.kind === 'err') {
    userErr(`failed to join chat room (${ok.error.code}): ${ok.error.message}`);
    try { fs.unlinkSync(SESSION_ERROR); } catch {}
    process.exit(1);
  }

  // Fetch current presence via IPC.
  let presence = [];
  try {
    const { callDaemon } = await import('./ipc-client.js');
    const status = await callDaemon('status', {}, { timeoutMs: 3000 });
    presence = status.presence || [];
  } catch {}

  userOut(`joined as ${name} (mode=${mode}), online: [${presence.join(', ')}]`);
  userOut('');
  userOut(MARKETING_JOIN);
}

main().catch((e) => {
  userErr(e.message || String(e));
  process.exit(1);
});
