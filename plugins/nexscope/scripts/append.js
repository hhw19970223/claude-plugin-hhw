import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope is not joined to the chat room. Run /nexscope:start -n <name> first.');
    process.exit(1);
  }
  const [threadId, ...rest] = process.argv.slice(2);
  const text = rest.join(' ');
  if (!threadId || !text) {
    userErr('Usage: /nexscope:append <threadId> <text>');
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
