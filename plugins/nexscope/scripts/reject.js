import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope 未加入聊天室。请先 /nexscope:start -n <name>。');
    process.exit(1);
  }
  const [threadId, ...rest] = process.argv.slice(2);
  if (!threadId) {
    userErr('用法: /nexscope:reject <threadId> [reason]');
    process.exit(1);
  }
  const reason = rest.join(' ');
  try {
    const r = await callDaemon('inbox_reject', { threadId, reason });
    userOut(`已拒绝 ${r.rejected} 条 (thread=${threadId});已向 [${r.to.join(', ')}] 回发拒绝消息。`);
  } catch (err) {
    if (err instanceof IpcError) userErr(`[${err.code}] ${err.message}`);
    else userErr(err.message);
    process.exit(1);
  }
}
main();
