#!/usr/bin/env node
// One-shot installer: registers this repo's MCP server as `nexscope` in
// Codex's ~/.codex/config.toml. Idempotent — running it repeatedly
// replaces the existing [mcp_servers.nexscope] section with the latest
// absolute path (useful after `git pull` relocates the repo).
//
//   node packages/codex/bin/install-codex.mjs
//
// Options:
//   --name=<alias>   register under a different mcp_servers key (default: nexscope)
//   --dry-run        print the intended change without writing
//   --uninstall      remove the section instead of writing it

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const MCP_ENTRY = path.resolve(HERE, '..', 'src', 'mcp-server.js');

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

const cur = readConfig();
const re  = sectionRegex(NAME);
const has = re.test(cur);

if (UNINSTALL) {
  if (!has) {
    console.log(`[mcp_servers.${NAME}] not present in ${CONFIG}; nothing to do.`);
    process.exit(0);
  }
  const next = cur.replace(re, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  report('Removing');
  if (!DRY_RUN) writeConfig(next);
  console.log('Restart Codex CLI for the change to take effect.');
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
console.log(``);
console.log(`Done. Restart Codex CLI — the nexscope_* tools (14 total) should appear in its tool list.`);
console.log(`To remove later:  node ${path.relative(process.cwd(), __filename)} --uninstall`);
