import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope 未加入聊天室。请先 /nexscope:start -n <name>。');
    process.exit(1);
  }
  const [threadId, ...rest] = process.argv.slice(2);
  const text = rest.join(' ');
  if (!threadId || !text) {
    userErr('用法: /nexscope:append <threadId> <text>');
    process.exit(1);
  }
  try {
    const ack = await callDaemon('append', { threadId, text });
    userOut(`appended as role=user to thread=${ack.threadId};delivered: [${ack.delivered.join(', ')}]${ack.offline.length ? `, offline: [${ack.offline.join(', ')}]` : ''}`);
  } catch (err) {
    if (err instanceof IpcError) userErr(`[${err.code}] ${err.message}`);
    else userErr(err.message);
    process.exit(1);
  }
}
main();
