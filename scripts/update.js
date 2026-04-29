import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_PATH, SOCKET_PATH, readJsonOrNull, pidAlive } from './state.js';
import { userErr, userOut } from './log.js';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), '..');

function run(cmd, label) {
  userOut(`\n==> ${label}`);
  userOut(`    $ ${cmd}  (cwd=${PLUGIN_ROOT})`);
  execSync(cmd, { cwd: PLUGIN_ROOT, stdio: 'inherit' });
}

async function stopDaemonIfRunning() {
  const s = readJsonOrNull(SESSION_PATH);
  if (!s || !pidAlive(s.pid)) return false;
  userOut(`==> 检测到正在运行的 hhw daemon (pid=${s.pid}, name=${s.name}),先关停以便加载新代码...`);
  try {
    const { callDaemon } = await import('./ipc-client.js');
    await callDaemon('shutdown', {}, { timeoutMs: 3000 });
  } catch {}
  for (let i = 0; i < 30; i++) {
    if (!pidAlive(s.pid)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (pidAlive(s.pid)) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  try { fs.unlinkSync(SESSION_PATH); } catch {}
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  return { wasRunning: true, name: s.name, mode: s.mode };
}

async function main() {
  if (!fs.existsSync(path.join(PLUGIN_ROOT, '.git'))) {
    userErr(`插件目录不是 git 仓库:${PLUGIN_ROOT}\n可能是通过 marketplace 安装的副本,请手动在源目录 git pull 后重装插件。`);
    process.exit(1);
  }

  const prev = await stopDaemonIfRunning();

  try {
    run('git pull --ff-only', 'git pull');
    run('npm install --no-audit --no-fund', 'npm install');
  } catch (e) {
    userErr(`更新失败: ${e.message}`);
    process.exit(1);
  }

  userOut('\n✓ hhw 插件已更新。');
  if (prev && prev.wasRunning) {
    userOut(`提示:daemon 已关停;重新启动用 /hhw:start -n ${prev.name} --mode=${prev.mode}`);
  }
  userOut('提示:如果改到了 hooks/ 或 .claude-plugin/plugin.json,需重启 Claude Code 才生效。');
}

main().catch((e) => {
  userErr(e.message);
  process.exit(1);
});
