import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

const EXPIRE_MS = 24 * 60 * 60 * 1000;

function fmt(it) {
  const ts = new Date(it.ts || Date.now()).toISOString();
  const age = Date.now() - (it.ts || Date.now());
  const expired = it.status === 'pending' && age > EXPIRE_MS ? ' (expired)' : '';
  return `[${it.status}] thread=${it.threadId} from=${it.label} hop=${it.hopCount || 0} @ ${ts}${expired}
  ${String(it.text || '').replace(/\n/g, '\n  ')}`;
}

async function main() {
  if (!daemonRunning()) {
    userErr('hhw 未加入聊天室。请先 /hhw:start -n <name>。');
    process.exit(1);
  }
  try {
    const { items } = await callDaemon('inbox_list');
    const pending = items.filter(i => i.status === 'pending');
    const other = items.filter(i => i.status !== 'pending').slice(-10);
    userOut(`pending: ${pending.length} | archive (latest 10): ${other.length}\n`);
    if (pending.length) {
      userOut('=== pending ===');
      for (const it of pending) userOut(fmt(it));
    }
    if (other.length) {
      userOut('\n=== archive ===');
      for (const it of other) userOut(fmt(it));
    }
    if (!pending.length && !other.length) userOut('(empty)');
  } catch (e) {
    if (e instanceof IpcError) userErr(`[${e.code}] ${e.message}`);
    else userErr(e.message);
    process.exit(1);
  }
}
main();
