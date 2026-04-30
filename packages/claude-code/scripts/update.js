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
  userOut(`==> Detected running nexscope daemon (pid=${s.pid}, name=${s.name}); stopping it first so the new code can load...`);
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
    userOut(`==> Local-clone install detected (repo=${localGitRoot})`);
    try {
      run('git pull --ff-only', 'git pull', localGitRoot);
      run('npm install --no-audit --no-fund', 'npm install', PLUGIN_ROOT);
    } catch (e) {
      userErr(`Update failed: ${e.message}`);
      process.exit(1);
    }
    finishBanner(prev, 'local-clone');
    return;
  }

  // --- Strategy B: marketplace install -------------------------------------
  const mname = inferMarketplaceName(PLUGIN_ROOT);
  if (!mname) {
    userErr(`Cannot determine install mode: PLUGIN_ROOT=${PLUGIN_ROOT} is not a git repo and is not under a Claude Code marketplace path.\nRun git pull manually in the source repo, then reinstall the plugin.`);
    process.exit(1);
  }

  const known = readKnownMarketplaces();
  const entry = known[mname];
  const marketRoot = entry?.installLocation;
  if (!marketRoot || !fs.existsSync(path.join(marketRoot, '.git'))) {
    userErr(`Git clone for marketplace "${mname}" not found (expected at ${marketRoot || '<unknown>'}).\nRun inside Claude Code: /plugin marketplace update ${mname}`);
    process.exit(1);
  }

  userOut(`==> Marketplace install detected (market=${mname}, source=${marketRoot})`);
  userOut(`    PLUGIN_ROOT (cache copy) = ${PLUGIN_ROOT}`);

  try {
    run('git pull --ff-only', `git pull [${mname}]`, marketRoot);
  } catch (e) {
    userErr(`git pull failed: ${e.message}`);
    process.exit(1);
  }

  // After pull, sync the plugin subdir from marketplace source → cache copy.
  const pluginName = inferPluginName();
  if (!pluginName) {
    userErr(`Could not read plugin name from ${PLUGIN_ROOT}/.claude-plugin/plugin.json.`);
    process.exit(1);
  }
  const srcSubdir = inferPluginSubdir(marketRoot, pluginName);
  if (!srcSubdir) {
    userErr(`Plugin subdirectory "${pluginName}" not found under ${marketRoot}.\nRun inside Claude Code: /plugin marketplace update ${mname}`);
    process.exit(1);
  }

  userOut(`\n==> Syncing new plugin files`);
  userOut(`    ${srcSubdir}  →  ${PLUGIN_ROOT}`);
  try {
    syncDir(srcSubdir, PLUGIN_ROOT);
  } catch (e) {
    userErr(`File sync failed: ${e.message}`);
    process.exit(1);
  }

  try {
    run('npm install --no-audit --no-fund', 'npm install', PLUGIN_ROOT);
  } catch (e) {
    userErr(`npm install failed: ${e.message}`);
    process.exit(1);
  }

  finishBanner(prev, `marketplace:${mname}`);
}

function finishBanner(prev, mode) {
  userOut(`\n✓ nexscope plugin updated (mode=${mode}).`);
  if (prev && prev.wasRunning) {
    userOut(`Tip: daemon was stopped; restart with /nexscope:start -n ${prev.name} --mode=${prev.mode}`);
  }
  userOut('Tip: if hooks/ or .claude-plugin/plugin.json changed, restart Claude Code for it to take effect.');
}

main().catch((e) => {
  userErr(e.message);
  process.exit(1);
});
