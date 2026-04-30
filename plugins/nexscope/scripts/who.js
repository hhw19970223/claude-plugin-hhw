import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope is not joined to the chat room. Run /nexscope:start -n <name> first.');
    process.exit(1);
  }
  try {
    const { users } = await callDaemon('who');
    if (!users || !users.length) userOut('(empty room)');
    else userOut(`online (${users.length}): ${users.join(', ')}`);
  } catch (e) {
    if (e instanceof IpcError) userErr(`[${e.code}] ${e.message}`);
    else userErr(e.message);
    process.exit(1);
  }
}
main();
