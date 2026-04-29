import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

function fmt(entry) {
  const ts = new Date(entry.ts || Date.now()).toISOString();
  const dir = entry.dir === 'in' ? '←' : '→';
  const who = entry.dir === 'in' ? entry.from : 'me';
  const tgt = Array.isArray(entry.to) ? (entry.to.length ? '[' + entry.to.join(',') + ']' : '[broadcast]') : '[?]';
  const typ = entry.type || 'msg';
  if (typ === 'file-start') {
    return `${ts} ${dir} ${who} ${tgt} (file) ${entry.attachment?.name} (${entry.attachment?.size}B) thread=${entry.threadId}`;
  }
  return `${ts} ${dir} ${who} ${tgt} ${entry.role || '?'} thread=${entry.threadId}: ${String(entry.text || '').replace(/\n/g, ' ')}`;
}

async function main() {
  if (!daemonRunning()) {
    userErr('hhw 未加入聊天室。请先 /hhw:start -n <name>。');
    process.exit(1);
  }
  let limit = 50;
  for (let i = 2; i < process.argv.length; i++) {
    const m = /^--limit=(\d+)$/.exec(process.argv[i]);
    if (m) limit = parseInt(m[1], 10);
  }
  try {
    const { items } = await callDaemon('history', { limit });
    if (!items.length) { userOut('(no local history)'); return; }
    for (const it of items) userOut(fmt(it));
  } catch (e) {
    if (e instanceof IpcError) userErr(`[${e.code}] ${e.message}`);
    else userErr(e.message);
    process.exit(1);
  }
}
main();
