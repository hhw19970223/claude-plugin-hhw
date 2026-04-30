#!/usr/bin/env node
// One-shot installer: (a) registers this repo's MCP server as `nexscope` in
// Codex's ~/.codex/config.toml and (b) merges AGENTS.md.fragment into
// ~/.codex/AGENTS.md so the agent sees the usage guidance (how to use
// nexscope_poll, nexscope_before_stop, auto mode, etc.). Idempotent —
// running it repeatedly replaces the existing artifacts with the latest
// absolute path (useful after `git pull` relocates the repo).
//
//   node packages/codex/bin/install-codex.mjs
//
// Options:
//   --name=<alias>   register under a different mcp_servers key (default: nexscope)
//   --dry-run        print the intended change without writing
//   --uninstall      remove both the config section and the AGENTS.md block

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const MCP_ENTRY   = path.resolve(HERE, '..', 'src', 'mcp-server.js');
const AGENTS_FRAG = path.resolve(HERE, '..', 'AGENTS.md.fragment');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = /^--([a-zA-Z0-9_-]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const NAME       = (typeof args.name === 'string' && args.name) ? args.name : 'nexscope';
const DRY_RUN    = !!args['dry-run'];
const UNINSTALL  = !!args['uninstall'];

const CODEX_DIR  = path.join(os.homedir(), '.codex');
const CONFIG     = path.join(CODEX_DIR, 'config.toml');
const AGENTS_MD  = path.join(CODEX_DIR, 'AGENTS.md');
const AGENTS_BEGIN = `<!-- nexscope-codex:${NAME}:start -->`;
const AGENTS_END   = `<!-- nexscope-codex:${NAME}:end -->`;
const HEADER     = `[mcp_servers.${NAME}]`;
const SECTION    = [
  HEADER,
  `command = "node"`,
  `args    = ["${MCP_ENTRY.replace(/\\/g, '\\\\')}"]`,
  '',
].join('\n');

// Regex that grabs the target section up to the next top-level [ header or EOF.
// Deliberately NO `m` flag: with multiline mode, `$` in the lookahead would
// match end-of-LINE and the lazy `*?` would stop right after the header,
// leaving old command/args lines untouched.
function sectionRegex(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)\\[mcp_servers\\.${escaped}\\][\\s\\S]*?(?=\\n\\[|$)`);
}

function readConfig() {
  try { return fs.readFileSync(CONFIG, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

function writeConfig(body) {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, body);
}

function report(action) {
  console.log(`==> ${action}`);
  console.log(`    file: ${CONFIG}`);
  console.log(`    entry [mcp_servers.${NAME}]:`);
  console.log(`        command = "node"`);
  console.log(`        args    = ["${MCP_ENTRY}"]`);
  if (DRY_RUN) console.log(`    (dry-run — no write)`);
}

// ---------- AGENTS.md fragment (agent-facing usage guidance) ----------

function agentsRegex() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\n?${esc(AGENTS_BEGIN)}[\\s\\S]*?${esc(AGENTS_END)}\\n?`);
}

function installAgents() {
  let fragment;
  try {
    fragment = fs.readFileSync(AGENTS_FRAG, 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`!!  AGENTS.md.fragment not found at ${AGENTS_FRAG}; skip agent-guidance injection.`);
      return;
    }
    throw e;
  }
  const block = `${AGENTS_BEGIN}\n${fragment}\n${AGENTS_END}\n`;

  let cur = '';
  try { cur = fs.readFileSync(AGENTS_MD, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }

  const re = agentsRegex();
  let next;
  if (re.test(cur)) {
    next = cur.replace(re, `\n${block}`);
    console.log(`==> Refreshing nexscope block in ${AGENTS_MD}`);
  } else {
    const prefix = cur && !cur.endsWith('\n') ? '\n\n' : (cur ? '\n' : '');
    next = cur + prefix + block;
    console.log(`==> Appending nexscope block to ${AGENTS_MD}`);
  }
  if (DRY_RUN) { console.log('    (dry-run — no write)'); return; }
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(AGENTS_MD, next);
}

function uninstallAgents() {
  let cur = '';
  try { cur = fs.readFileSync(AGENTS_MD, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`${AGENTS_MD} does not exist; skip agent-guidance removal.`);
      return;
    }
    throw e;
  }
  const re = agentsRegex();
  if (!re.test(cur)) {
    console.log(`no nexscope block in ${AGENTS_MD}; skip agent-guidance removal.`);
    return;
  }
  const next = cur.replace(re, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  console.log(`==> Removing nexscope block from ${AGENTS_MD}`);
  if (DRY_RUN) { console.log('    (dry-run — no write)'); return; }
  fs.writeFileSync(AGENTS_MD, next);
}

// ---------- main ----------

const cur = readConfig();
const re  = sectionRegex(NAME);
const has = re.test(cur);

if (UNINSTALL) {
  if (has) {
    const next = cur.replace(re, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    report('Removing');
    if (!DRY_RUN) writeConfig(next);
  } else {
    console.log(`[mcp_servers.${NAME}] not present in ${CONFIG}; skip MCP removal.`);
  }
  uninstallAgents();
  console.log('');
  console.log('Done. Restart Codex CLI for changes to take effect.');
  process.exit(0);
}

let next;
if (has) {
  // Replace: preserve the leading newline the regex captured.
  next = cur.replace(re, (m, lead) => (lead || '') + SECTION);
  report('Updating existing');
} else {
  const prefix = cur && !cur.endsWith('\n') ? '\n' : '';
  next = cur + prefix + SECTION;
  report('Adding new');
}
if (!DRY_RUN) writeConfig(next);

installAgents();

console.log(``);
console.log(`Done. Restart Codex CLI — the nexscope_* tools should appear in its tool list,`);
console.log(`and the agent now has usage guidance at ${AGENTS_MD}.`);
console.log(`To remove later:  node ${path.relative(process.cwd(), __filename)} --uninstall`);
