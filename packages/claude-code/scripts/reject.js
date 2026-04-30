import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope is not joined to the chat room. Run /nexscope:start -n <name> first.');
    process.exit(1);
  }
  const [threadId, ...rest] = process.argv.slice(2);
  if (!threadId) {
    userErr('Usage: /nexscope:reject <threadId> [reason]');
    process.exit(1);
  }
  const reason = rest.join(' ');
  try {
    const r = await callDaemon('inbox_reject', { threadId, reason });
    userOut(`rejected ${r.rejected} message(s) on thread=${threadId}; rejection notice sent to [${r.to.join(', ')}].`);
  } catch (err) {
    if (err instanceof IpcError) userErr(`[${err.code}] ${err.message}`);
    else userErr(err.message);
    process.exit(1);
  }
}
main();
