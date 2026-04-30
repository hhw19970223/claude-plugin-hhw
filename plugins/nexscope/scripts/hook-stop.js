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
`[NEXSCOPE AUTO MODE] 你在聊天室收到以下未回复的点名消息(mode=auto,当前 user=${session.name}):

${summary}

请为每条用 \`/nexscope:say --thread=<threadId> @<from> <你的回复>\` 发送回复;回复后 daemon 会自动把该 thread 的 hopCount+1 并清空 pending。
如果你认为不需要回复(例如只是告知),可用 \`/nexscope:mode manual\` 暂时退出 auto,或直接再次结束(5 分钟后任务自动降级到 inbox)。`;

  blockWith(reason);
}

main().catch((e) => {
  process.stderr.write(`[nexscope hook-stop] ${e.message}\n`);
  allow();
});
