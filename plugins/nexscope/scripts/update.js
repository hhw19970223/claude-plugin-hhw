import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SESSION_PATH, SOCKET_PATH, readJsonOrNull, pidAlive, IS_WIN } from './state.js';
import { userErr, userOut } from './log.js';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), '..');

// ---------------------------------------------------------------------------
// Install-mode detection
// ---------------------------------------------------------------------------
//
//  A. Local clone install          (user ran `git clone` somewhere + /plugin marketplace add <path>)
//     PLUGIN_ROOT is a normal dir, some ancestor has `.git`.
//     → git pull at the ancestor; npm install at PLUGIN_ROOT.
//
//  B. Marketplace install          (user ran /plugin install nexscope@nexscope-marketplace)
//     PLUGIN_ROOT lives under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.
//     Cache has no `.git`; the real git clone is at
//       ~/.claude/plugins/marketplaces/<marketplace>/  (installLocation from known_marketplaces.json).
//     → git pull at installLocation; sync plugin files to PLUGIN_ROOT; npm install at PLUGIN_ROOT.

function findGitRoot(start) {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function inferMarketplaceName(pluginRoot) {
  const norm = pluginRoot.replace(/\\/g, '/');
  const m = /\.claude\/plugins\/(?:cache|marketplaces)\/([^/]+)\//.exec(norm);
  return m ? m[1] : null;
}

function readKnownMarketplaces() {
  const p = path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function inferPluginSubdir(marketplaceRoot, pluginName) {
  // marketplace.json lists plugins with `source`: usually "./plugins/<name>" or "./<name>".
  try {
    const mf = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
    const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const entry = (j.plugins || []).find(p => p.name === pluginName);
    if (entry && typeof entry.source === 'string') {
      return path.resolve(marketplaceRoot, entry.source);
    }
  } catch {}
  // Fallback: try common layouts.
  for (const rel of [`plugins/${pluginName}`, pluginName]) {
    const cand = path.join(marketplaceRoot, rel);
    if (fs.existsSync(path.join(cand, '.claude-plugin', 'plugin.json'))) return cand;
  }
  return null;
}

function inferPluginName() {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    return pj.name;
  } catch { return null; }
}

// Recursively copy src → dst, preserving file times; excludes node_modules, .git.
function syncDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      syncDir(s, d);
    } else if (entry.isSymbolicLink()) {
      try { fs.unlinkSync(d); } catch {}
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ---------------------------------------------------------------------------

function run(cmd, label, cwd) {
  userOut(`\n==> ${label}`);
  userOut(`    $ ${cmd}  (cwd=${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

async function stopDaemonIfRunning() {
  const s = readJsonOrNull(SESSION_PATH);
  if (!s || !pidAlive(s.pid)) return false;
  userOut(`==> 检测到正在运行的 nexscope daemon (pid=${s.pid}, name=${s.name}),先关停以便加载新代码...`);
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
  if (!IS_WIN) { try { fs.unlinkSync(SOCKET_PATH); } catch {} }
  return { wasRunning: true, name: s.name, mode: s.mode };
}

async function main() {
  const prev = await stopDaemonIfRunning();

  // --- Strategy A: local clone ---------------------------------------------
  const localGitRoot = findGitRoot(PLUGIN_ROOT);
  if (localGitRoot) {
    userOut(`==> 检测到本地 clone 安装 (repo=${localGitRoot})`);
    try {
      run('git pull --ff-only', 'git pull', localGitRoot);
      run('npm install --no-audit --no-fund', 'npm install', PLUGIN_ROOT);
    } catch (e) {
      userErr(`更新失败: ${e.message}`);
      process.exit(1);
    }
    finishBanner(prev, 'local-clone');
    return;
  }

  // --- Strategy B: marketplace install -------------------------------------
  const mname = inferMarketplaceName(PLUGIN_ROOT);
  if (!mname) {
    userErr(`无法识别安装方式:PLUGIN_ROOT=${PLUGIN_ROOT} 既不是 git 仓库,也不在 Claude Code 的 marketplace 路径下。\n请手动在原仓库 git pull 后重装插件。`);
    process.exit(1);
  }

  const known = readKnownMarketplaces();
  const entry = known[mname];
  const marketRoot = entry?.installLocation;
  if (!marketRoot || !fs.existsSync(path.join(marketRoot, '.git'))) {
    userErr(`marketplace "${mname}" 的 git 仓库未找到(期望在 ${marketRoot || '<unknown>'})。\n请在 Claude Code 里执行:/plugin marketplace update ${mname}`);
    process.exit(1);
  }

  userOut(`==> 检测到 marketplace 安装 (market=${mname}, source=${marketRoot})`);
  userOut(`    PLUGIN_ROOT (cache 副本) = ${PLUGIN_ROOT}`);

  try {
    run('git pull --ff-only', `git pull [${mname}]`, marketRoot);
  } catch (e) {
    userErr(`git pull 失败: ${e.message}`);
    process.exit(1);
  }

  // After pull, sync the plugin subdir from marketplace source → cache copy.
  const pluginName = inferPluginName();
  if (!pluginName) {
    userErr(`无法从 ${PLUGIN_ROOT}/.claude-plugin/plugin.json 读出插件名。`);
    process.exit(1);
  }
  const srcSubdir = inferPluginSubdir(marketRoot, pluginName);
  if (!srcSubdir) {
    userErr(`在 ${marketRoot} 里找不到插件 "${pluginName}" 的子目录。\n请在 Claude Code 里执行:/plugin marketplace update ${mname}`);
    process.exit(1);
  }

  userOut(`\n==> sync 新版插件文件`);
  userOut(`    ${srcSubdir}  →  ${PLUGIN_ROOT}`);
  try {
    syncDir(srcSubdir, PLUGIN_ROOT);
  } catch (e) {
    userErr(`文件同步失败: ${e.message}`);
    process.exit(1);
  }

  try {
    run('npm install --no-audit --no-fund', 'npm install', PLUGIN_ROOT);
  } catch (e) {
    userErr(`npm install 失败: ${e.message}`);
    process.exit(1);
  }

  finishBanner(prev, `marketplace:${mname}`);
}

function finishBanner(prev, mode) {
  userOut(`\n✓ nexscope 插件已更新 (mode=${mode})。`);
  if (prev && prev.wasRunning) {
    userOut(`提示:daemon 已关停;用 /nexscope:start -n ${prev.name} --mode=${prev.mode} 重启。`);
  }
  userOut('提示:改到了 hooks/ 或 .claude-plugin/plugin.json 的话,需重启 Claude Code 才生效。');
}

main().catch((e) => {
  userErr(e.message);
  process.exit(1);
});
