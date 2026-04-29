// Background watcher registered on Stop with async+asyncRewake.
// Tails pending_notifications.jsonl; on new messages, exits 2 to wake Claude
// with the messages as a system-reminder. Auto-exits after idle timeout.

import fs from 'node:fs';
import path from 'node:path';
import { PENDING_NOTIFS, SESSION_PATH, DATA_DIR, drainJsonl, readJsonOrNull, pidAlive } from './state.js';

const POLL_MS       = 500;
const IDLE_TIMEOUT  = 10 * 60 * 1000;     // 10 min: exit quietly if no new messages
const WATCHER_PID   = path.join(DATA_DIR, 'watcher.pid');

// Mirror formatLine from hook-pre-prompt to keep messages readable.
function formatLine(n) {
  switch (n.kind) {
    case 'presence':
      if (n.event === 'snapshot') return `[hhw presence] online: ${(n.users || []).join(', ')}`;
      if (n.event === 'joined')   return `[hhw presence] ${n.user} joined | online: ${(n.users || []).join(', ')}`;
      if (n.event === 'left')     return `[hhw presence] ${n.user} left | online: ${(n.users || []).join(', ')}`;
      return `[hhw presence] ${JSON.stringify(n)}`;
    case 'msg': {
      const tid = n.threadId ? ` (thread=${n.threadId})` : '';
      const hop = typeof n.hopCount === 'number' && n.hopCount > 0 ? ` hop=${n.hopCount}` : '';
      return `${n.label} → ${n.target}${tid}${hop}: ${String(n.text || '').replace(/\n/g, '\n  ')}`;
    }
    case 'file_start':
      return `${n.label} → ${n.target} (file incoming) name=${n.name} size=${n.size}B thread=${n.threadId}`;
    case 'file_end':
      return `${n.label} → ${n.target} (file received) ${n.name} saved to ${n.path}`;
    case 'system':
      return n.text;
    default:
      return `[hhw] ${JSON.stringify(n)}`;
  }
}

// Kill prior watcher if still alive; register ourselves.
function claimSlot() {
  try {
    const prior = parseInt(fs.readFileSync(WATCHER_PID, 'utf8'), 10);
    if (prior && prior !== process.pid && pidAlive(prior)) {
      try { process.kill(prior, 'SIGTERM'); } catch {}
    }
  } catch {}
  try { fs.writeFileSync(WATCHER_PID, String(process.pid)); } catch {}
}

function releaseSlot() {
  try {
    const held = parseInt(fs.readFileSync(WATCHER_PID, 'utf8'), 10);
    if (held === process.pid) fs.unlinkSync(WATCHER_PID);
  } catch {}
}

function daemonAlive() {
  const s = readJsonOrNull(SESSION_PATH);
  return !!(s && pidAlive(s.pid));
}

async function main() {
  // If daemon isn't running, nothing to watch.
  if (!daemonAlive()) { process.stdout.write(''); process.exit(0); }

  claimSlot();
  process.on('SIGTERM', () => { releaseSlot(); process.exit(0); });
  process.on('exit',    () => { releaseSlot(); });

  const startedAt = Date.now();
  while (true) {
    // Daemon died? Stop watching.
    if (!daemonAlive()) { process.stdout.write(''); process.exit(0); }

    // Idle timeout.
    if (Date.now() - startedAt > IDLE_TIMEOUT) { process.stdout.write(''); process.exit(0); }

    let rows;
    try { rows = drainJsonl(PENDING_NOTIFS); } catch { rows = []; }
    if (rows.length) {
      const lines = rows.map(formatLine);
      const header = `[hhw inbox-stream] ${rows.length} new event(s):`;
      process.stdout.write([header, ...lines].join('\n'));
      // Exit code 2 = blocking error → Claude is woken up with the output as system-reminder.
      process.exit(2);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  process.stderr.write(`[hhw watcher] ${e.message}\n`);
  process.exit(0);
});
