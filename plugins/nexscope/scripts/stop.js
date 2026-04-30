import fs from 'node:fs';
import { SESSION_PATH, SOCKET_PATH, readJsonOrNull, pidAlive } from './state.js';
import { callDaemon, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  const session = readJsonOrNull(SESSION_PATH);
  if (!session) {
    userOut('nexscope 未在运行。');
    return;
  }
  if (!pidAlive(session.pid)) {
    // Stale file, just clean up.
    try { fs.unlinkSync(SESSION_PATH); } catch {}
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    userOut(`已清理失效 session(pid ${session.pid} 不存在)。`);
    return;
  }

  try {
    await callDaemon('shutdown', {}, { timeoutMs: 3000 });
  } catch (e) {
    if (!(e instanceof IpcError) || e.code !== 'daemon_down') {
      userErr(`shutdown 请求失败: ${e.message}`);
    }
  }

  // Wait for process to exit.
  for (let i = 0; i < 30; i++) {
    if (!pidAlive(session.pid)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (pidAlive(session.pid)) {
    try { process.kill(session.pid, 'SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  if (pidAlive(session.pid)) {
    try { process.kill(session.pid, 'SIGKILL'); } catch {}
  }

  // Final cleanup of files the daemon should have removed.
  try { fs.unlinkSync(SESSION_PATH); } catch {}
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  userOut(`left chat room (was "${session.name}", pid ${session.pid}).`);
}

main().catch((e) => {
  userErr(e.message);
  process.exit(1);
});
