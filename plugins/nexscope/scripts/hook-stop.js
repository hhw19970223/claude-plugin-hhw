import { PENDING_AUTO, SESSION_PATH, readJsonlAll, readJsonOrNull, pidAlive } from './state.js';

// Receive stdin (hook input from Claude Code) but we don't strictly need it.
async function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => buf += d);
    process.stdin.on('end',  () => resolve(buf));
  });
}

function allow() {
  process.stdout.write(JSON.stringify({}));
}

function blockWith(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

async function main() {
  await readStdin(); // consume and discard

  const session = readJsonOrNull(SESSION_PATH);
  if (!session || !pidAlive(session.pid)) return allow();
  if (session.mode !== 'auto') return allow();

  let tasks = [];
  try { tasks = readJsonlAll(PENDING_AUTO); } catch { return allow(); }
  if (!tasks.length) return allow();

  // Prevent infinite block loops: if Claude already tried to reply but daemon still
  // sees tasks (e.g. ack failed), surface once and allow. Track via env-smuggled counter:
  // Claude Code re-invokes the Stop hook each stop event, so cheap protection is:
  // drop tasks older than 5 minutes to avoid wedging the session.
  const FRESH_MS = 5 * 60 * 1000;
  const fresh = tasks.filter(t => (Date.now() - (t.ts || 0)) < FRESH_MS);
  if (!fresh.length) return allow();

  const summary = fresh.map(t =>
    `- thread=${t.threadId} from ${t.label}: "${String(t.text || '').slice(0, 200)}"${(t.text||'').length>200?'…':''} (incoming hop=${t.hopCount ?? 0})`
  ).join('\n');

  const reason =
`[NEXSCOPE AUTO MODE] You have unanswered @mentions in the chat room (mode=auto, current user=${session.name}):

${summary}

Reply to each with \`/nexscope:say --thread=<threadId> @<from> <your reply>\`. After replying, the daemon auto-increments the thread's hopCount and clears the pending task.
If you decide not to reply (e.g. the mention was informational), run \`/nexscope:mode manual\` to exit auto mode, or just stop again (tasks older than 5 min are auto-downgraded to inbox).`;

  blockWith(reason);
}

main().catch((e) => {
  process.stderr.write(`[nexscope hook-stop] ${e.message}\n`);
  allow();
});
