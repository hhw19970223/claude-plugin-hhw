import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('hhw 未加入聊天室。请先 /hhw:start -n <name>。');
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
    userErr(`用法: /hhw:mode manual|auto (不带参数查询当前)`);
    process.exit(1);
  }
  try {
    const { mode: m } = await callDaemon('mode', { mode });
    userOut(`mode 已切到 ${m}`);
  } catch (e) {
    if (e instanceof IpcError) userErr(`[${e.code}] ${e.message}`);
    else userErr(e.message);
    process.exit(1);
  }
}
main();
