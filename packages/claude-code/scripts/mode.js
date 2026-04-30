import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope is not joined to the chat room. Run /nexscope:start -n <name> first.');
    process.exit(1);
  }
  const mode = process.argv[2];
  if (!mode) {
    // Report current mode.
    const s = await callDaemon('status');
    userOut(`mode=${s.mode} (hopLimit=${s.hopLimit})`);
    return;
  }
  if (!['manual', 'auto'].includes(mode)) {
    userErr(`Usage: /nexscope:mode manual|auto (no args = show current)`);
    process.exit(1);
  }
  try {
    const { mode: m } = await callDaemon('mode', { mode });
    userOut(`mode switched to ${m}`);
  } catch (e) {
    if (e instanceof IpcError) userErr(`[${e.code}] ${e.message}`);
    else userErr(e.message);
    process.exit(1);
  }
}
main();
