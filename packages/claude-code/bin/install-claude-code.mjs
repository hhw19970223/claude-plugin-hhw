#!/usr/bin/env node
// One-shot installer for the Claude Code side: merges Bash permission-allow
// entries into ~/.claude/settings.json so `/nexscope:*` slash commands no
// longer prompt for Bash approval every invocation.
//
//   node packages/claude-code/bin/install-claude-code.mjs
//
// Options:
//   --dry-run     print intended changes without writing
//   --uninstall   remove the nexscope entries from permissions.allow
//   --local       write to ./.claude/settings.json (project-scoped) instead
//                 of ~/.claude/settings.json (user-scoped)
//
// Each /nexscope:* slash command expands to a Bash call shaped like:
//   node "<plugin-root>/scripts/<cmd>.js" <args>
// Two allow patterns are added per command — one with the literal path and
// one with the quoted-path form — so Claude Code's matcher catches both
// variants regardless of how it normalizes the command string.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename  = fileURLToPath(import.meta.url);
const HERE        = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(HERE, '..', 'scripts');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = /^--([a-zA-Z0-9_-]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const DRY_RUN   = !!args['dry-run'];
const UNINSTALL = !!args['uninstall'];
const LOCAL     = !!args['local'];

const SETTINGS = LOCAL
  ? path.join(process.cwd(), '.claude', 'settings.json')
  : path.join(os.homedir(), '.claude', 'settings.json');

// 11 slash commands backed by a script in scripts/.
const COMMANDS = [
  'start', 'stop', 'say', 'who', 'mode',
  'history', 'inbox', 'accept', 'reject', 'append', 'update',
];

function entriesFor(cmd) {
  const full = path.join(SCRIPTS_DIR, `${cmd}.js`);
  return [
    `Bash(node ${full}:*)`,
    `Bash(node "${full}":*)`,
  ];
}

const ENTRIES = COMMANDS.flatMap(entriesFor);

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
}

function install() {
  if (!fs.existsSync(SCRIPTS_DIR)) {
    console.error(`!! scripts dir not found at ${SCRIPTS_DIR}; refusing to install.`);
    process.exit(1);
  }

  const cur = readSettings();
  cur.permissions = cur.permissions || {};
  cur.permissions.allow = Array.isArray(cur.permissions.allow) ? cur.permissions.allow : [];

  const existing = new Set(cur.permissions.allow);
  const added = [];
  for (const e of ENTRIES) {
    if (!existing.has(e)) {
      cur.permissions.allow.push(e);
      added.push(e);
    }
  }

  console.log(`==> Bash allow entries in ${SETTINGS}`);
  console.log(`    scripts dir:     ${SCRIPTS_DIR}`);
  console.log(`    already present: ${ENTRIES.length - added.length}`);
  console.log(`    to add:          ${added.length}`);
  for (const e of added) console.log(`      + ${e}`);

  if (DRY_RUN) {
    console.log('    (dry-run — no write)');
    return;
  }
  if (added.length) writeSettings(cur);

  console.log('');
  console.log('Done. The /nexscope:* slash commands will no longer prompt for Bash approval.');
  console.log('');
  console.log('Note: entries bind to the absolute scripts path at install time. If you later');
  console.log('      move the plugin or bump a marketplace version (new cache dir), re-run this');
  console.log('      installer so the allow entries point to the new location.');
}

function uninstall() {
  const cur = readSettings();
  if (!cur.permissions || !Array.isArray(cur.permissions.allow)) {
    console.log(`no permissions.allow array in ${SETTINGS}; nothing to remove.`);
    return;
  }

  // Remove any entry whose body references the current scripts dir — tolerates
  // older installs (quoted or unquoted, with different args).
  const prefixes = [
    `Bash(node ${SCRIPTS_DIR}`,
    `Bash(node "${SCRIPTS_DIR}`,
  ];

  const before = cur.permissions.allow.length;
  cur.permissions.allow = cur.permissions.allow.filter(e =>
    !(typeof e === 'string' && prefixes.some(p => e.startsWith(p)))
  );
  const removed = before - cur.permissions.allow.length;

  console.log(`==> Removing ${removed} nexscope Bash allow entries from ${SETTINGS}`);
  if (removed === 0) return;
  if (DRY_RUN) {
    console.log('    (dry-run — no write)');
    return;
  }
  writeSettings(cur);
}

if (UNINSTALL) uninstall();
else install();
