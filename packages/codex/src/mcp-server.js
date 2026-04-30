// nexscope MCP stdio server — exposes every /nexscope:* chat-room op as an
// MCP tool. The server reuses the daemon + IPC layer from the Claude Code
// sibling package (../../claude-code/scripts/) — a single daemon services
// both clients against the same project-local data dir.
//
// Entry point:
//   [mcp_servers.nexscope]
//   command = "node"
//   args = ["<repo>/packages/codex/src/mcp-server.js"]
//
// Stdio JSON-RPC transport per the MCP spec; no stdout pollution allowed.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { callDaemon, daemonRunning, IpcError } from '../../claude-code/scripts/ipc-client.js';
import {
  PENDING_NOTIFS, PENDING_AUTO, SESSION_PATH, SESSION_ERROR, DAEMON_LOG, SOCKET_PATH,
  ensureDataDir, drainJsonl, readJsonlAll, readJsonOrNull, pidAlive,
} from '../../claude-code/scripts/state.js';
import { loadConfig, ConfigError } from '../../claude-code/scripts/config.js';

const __filename = fileURLToPath(import.meta.url);
const DAEMON_PATH = path.resolve(path.dirname(__filename), '..', '..', 'claude-code', 'scripts', 'daemon.js');

const SERVER_NAME = 'nexscope';
const SERVER_VERSION = '0.2.0';

// -------------------------- tool handlers --------------------------

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}
function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errResult(message, code) {
  return { content: [{ type: 'text', text: `[error:${code || 'error'}] ${message}` }], isError: true };
}

function requireDaemon() {
  if (!daemonRunning()) throw new Error('nexscope is not joined to the chat room. Call nexscope_start first.');
}

async function toolWho() {
  requireDaemon();
  const { users } = await callDaemon('who');
  return textResult(users?.length ? `online (${users.length}): ${users.join(', ')}` : '(empty room)');
}

// Pollable local drain: consumes pending_notifications for this turn.
// Also returns pending_auto_tasks (not drained — daemon clears those when
// nexscope_say is invoked with the matching threadId).
async function toolPoll() {
  const session = readJsonOrNull(SESSION_PATH);
  if (!session || !pidAlive(session.pid)) {
    return jsonResult({ events: [], auto_tasks: [], daemon: 'not_running' });
  }
  const rows = drainJsonl(PENDING_NOTIFS);
  const events = rows.map(formatEvent);
  const auto_tasks = readJsonlAll(PENDING_AUTO);
  let online = [];
  try { online = (await callDaemon('who')).users || []; } catch {}
  return jsonResult({
    events,
    auto_tasks,
    online,
    session: { name: session.name, mode: session.mode, hopLimit: session.hopLimit },
  });
}

function formatEvent(n) {
  switch (n.kind) {
    case 'presence':
      if (n.event === 'snapshot') return `[presence snapshot] online: ${(n.users || []).join(', ')}`;
      if (n.event === 'joined')   return `[presence] ${n.user} joined | online: ${(n.users || []).join(', ')}`;
      if (n.event === 'left')     return `[presence] ${n.user} left | online: ${(n.users || []).join(', ')}`;
      return `[presence] ${JSON.stringify(n)}`;
    case 'msg': {
      const hop = typeof n.hopCount === 'number' && n.hopCount > 0 ? ` hop=${n.hopCount}` : '';
      return `${n.label} → ${n.target} (thread=${n.threadId}${hop}): ${String(n.text || '').replace(/\n/g, '\n  ')}`;
    }
    case 'file_start':
      return `${n.label} → ${n.target} (file incoming) name=${n.name} size=${n.size}B thread=${n.threadId}`;
    case 'file_end':
      return `${n.label} → ${n.target} (file received) ${n.name} saved to ${n.path}`;
    case 'system':
      return n.text;
    default:
      return `[event] ${JSON.stringify(n)}`;
  }
}

// -------------------------- lifecycle --------------------------

async function waitFor(predicate, { timeoutMs = 6000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return null;
}

async function toolStart(args) {
  ensureDataDir();
  let cfg;
  try { cfg = loadConfig(); }
  catch (e) {
    if (e instanceof ConfigError) return errResult(e.message, e.code);
    throw e;
  }
  const name = args.name || cfg.defaultName;
  if (!name) return errResult('Pass a name or set defaultName in config.json.', 'missing_name');
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) return errResult(`Username "${name}" invalid (must match ^[a-zA-Z0-9_-]{1,32}$).`, 'bad_name');
  const mode = args.mode || cfg.mode;
  if (mode && !['manual', 'auto'].includes(mode)) return errResult(`mode must be manual or auto, got "${mode}".`, 'bad_mode');

  const existing = readJsonOrNull(SESSION_PATH);
  if (existing && pidAlive(existing.pid)) {
    return textResult(`already running: name=${existing.name}, pid=${existing.pid}, mode=${existing.mode}. Call nexscope_stop first to restart.`);
  }
  if (existing) { try { fs.unlinkSync(SESSION_PATH); } catch {} }
  try { fs.unlinkSync(SESSION_ERROR); } catch {}

  const logFd = fs.openSync(DAEMON_LOG, 'a');
  const child = spawn(
    process.execPath,
    [DAEMON_PATH, `--name=${name}`, `--mode=${mode}`, `--hop-limit=${cfg.hopLimit}`],
    { detached: true, stdio: ['ignore', logFd, logFd], env: process.env },
  );
  child.unref();
  fs.closeSync(logFd);

  const ok = await waitFor(() => {
    const s = readJsonOrNull(SESSION_PATH);
    if (s && s.pid === child.pid) return { kind: 'ok', session: s };
    const err = readJsonOrNull(SESSION_ERROR);
    if (err) return { kind: 'err', error: err };
    return null;
  });
  if (!ok) { try { process.kill(child.pid, 'SIGTERM'); } catch {} return errResult(`daemon start timed out; see ${DAEMON_LOG}.`, 'start_timeout'); }
  if (ok.kind === 'err') { try { fs.unlinkSync(SESSION_ERROR); } catch {} return errResult(`failed to join (${ok.error.code}): ${ok.error.message}`, ok.error.code); }

  let presence = [];
  try { presence = (await callDaemon('status', {}, { timeoutMs: 3000 })).presence || []; } catch {}
  return textResult(`joined as ${name} (mode=${mode}), online: [${presence.join(', ')}]`);
}

async function toolStop() {
  const session = readJsonOrNull(SESSION_PATH);
  if (!session) return textResult('nexscope is not running.');
  if (!pidAlive(session.pid)) {
    try { fs.unlinkSync(SESSION_PATH); } catch {}
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    return textResult(`cleaned up stale session (pid ${session.pid} not alive).`);
  }
  try { await callDaemon('shutdown', {}, { timeoutMs: 3000 }); } catch (e) {
    if (!(e instanceof IpcError) || e.code !== 'daemon_down') throw e;
  }
  for (let i = 0; i < 30; i++) {
    if (!pidAlive(session.pid)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (pidAlive(session.pid)) { try { process.kill(session.pid, 'SIGTERM'); } catch {} await new Promise(r => setTimeout(r, 300)); }
  if (pidAlive(session.pid)) { try { process.kill(session.pid, 'SIGKILL'); } catch {} }
  try { fs.unlinkSync(SESSION_PATH); } catch {}
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  return textResult(`left chat room (was "${session.name}", pid ${session.pid}).`);
}

// -------------------------- core ops --------------------------

async function toolSay(args) {
  requireDaemon();
  const text = args.text ?? '';
  const to = Array.isArray(args.to) ? args.to : (args.to ? [args.to] : []);
  const role = args.role === 'user' ? 'user' : 'userAgent';
  const threadId = args.threadId;
  const filePath = args.filePath;
  if (!text && !filePath) return errResult('one of `text` or `filePath` is required', 'bad_args');

  if (filePath) {
    const r = await callDaemon('send_file', { filePath, to, role, threadId, text }, { timeoutMs: 120_000 });
    const targets = to.length ? to.join(', ') : '<broadcast>';
    return textResult(`sent file "${r.name}" (${r.size} bytes) to [${targets}] — delivered: [${r.delivered.join(', ')}]${r.offline.length ? `, offline: [${r.offline.join(', ')}]` : ''} (thread=${r.threadId})`);
  }
  const r = await callDaemon('say', { to, role, threadId, text });
  const targets = to.length ? to.join(', ') : '<broadcast>';
  const note = r.autoReply ? ` [auto-reply, hop=${r.hopCount}]` : '';
  return textResult(`delivered to [${r.delivered.join(', ')}]${r.offline.length ? `, offline: [${r.offline.join(', ')}]` : ''} (thread=${r.threadId}, targets=${targets})${note}`);
}

async function toolMode(args) {
  requireDaemon();
  if (!args.mode) {
    const s = await callDaemon('status');
    return textResult(`mode=${s.mode} (hopLimit=${s.hopLimit})`);
  }
  if (!['manual', 'auto'].includes(args.mode)) return errResult('mode must be manual or auto', 'bad_mode');
  const { mode: m } = await callDaemon('mode', { mode: args.mode });
  return textResult(`mode switched to ${m}`);
}

async function toolHistory(args) {
  requireDaemon();
  const limit = Math.max(1, Math.min(parseInt(args.limit || '50', 10), 500));
  const { items } = await callDaemon('history', { limit });
  if (!items.length) return textResult('(no local history)');
  const lines = items.map(it => {
    const ts = new Date(it.ts || Date.now()).toISOString();
    const dir = it.dir === 'in' ? '<-' : '->';
    const who = it.dir === 'in' ? it.from : 'me';
    const tgt = Array.isArray(it.to) ? (it.to.length ? '[' + it.to.join(',') + ']' : '[broadcast]') : '[?]';
    if ((it.type || 'msg') === 'file-start') return `${ts} ${dir} ${who} ${tgt} (file) ${it.attachment?.name} (${it.attachment?.size}B) thread=${it.threadId}`;
    return `${ts} ${dir} ${who} ${tgt} ${it.role || '?'} thread=${it.threadId}: ${String(it.text || '').replace(/\n/g, ' ')}`;
  });
  return textResult(lines.join('\n'));
}

async function toolInbox() {
  requireDaemon();
  const { items } = await callDaemon('inbox_list');
  const pending = items.filter(i => i.status === 'pending');
  const archive = items.filter(i => i.status !== 'pending').slice(-10);
  return jsonResult({ pending, archive });
}

async function toolAccept(args) {
  requireDaemon();
  if (!args.threadId) return errResult('threadId required', 'bad_args');
  const r = await callDaemon('inbox_accept', { threadId: args.threadId, extra: args.extra || '' });
  return jsonResult({
    accepted: r.items.length,
    threadId: args.threadId,
    extra: r.extra || '',
    messages: r.items.map(it => ({ from: it.label, ts: new Date(it.ts).toISOString(), text: it.text })),
    hint: `Treat these messages as a new user request. When done, reply with nexscope_say threadId="${args.threadId}".`,
  });
}

async function toolReject(args) {
  requireDaemon();
  if (!args.threadId) return errResult('threadId required', 'bad_args');
  const r = await callDaemon('inbox_reject', { threadId: args.threadId, reason: args.reason || '' });
  return textResult(`rejected ${r.rejected} message(s) on thread=${args.threadId}; refusal sent to [${r.to.join(', ')}].`);
}

async function toolAppend(args) {
  requireDaemon();
  if (!args.threadId || !args.text) return errResult('threadId and text required', 'bad_args');
  const ack = await callDaemon('append', { threadId: args.threadId, text: args.text });
  return textResult(`appended (role=user) to thread=${ack.threadId}; delivered: [${ack.delivered.join(', ')}]${ack.offline.length ? `, offline: [${ack.offline.join(', ')}]` : ''}`);
}

// Long-poll: blocks until new events arrive in pending_notifications OR the
// timeout elapses. Short-circuits if events are already queued. Unlike
// nexscope_poll (which always returns immediately), nexscope_watch is the
// closest Codex equivalent to Claude Code's asyncRewake hook — the model
// stays occupied in a tool call until something happens.
//
// Caveat: because MCP tools are request/response and Codex does not invoke
// tools while idle (waiting for user input), watch only runs during the
// model's active turn. For true "idle-time wake-up" you still need a
// human-initiated turn — MCP/Codex has no async revival.
async function toolWatch(args) {
  const timeoutSec = Math.min(Math.max(parseInt(args.timeoutSeconds ?? 30, 10), 1), 120);
  const deadline = Date.now() + timeoutSec * 1000;
  const pollMs = 250;

  const snapshot = () => {
    const session = readJsonOrNull(SESSION_PATH);
    const alive = session && pidAlive(session.pid);
    return { session, alive };
  };

  // Immediate drain check.
  let first = snapshot();
  if (!first.alive) return jsonResult({ events: [], auto_tasks: [], daemon: 'not_running', timed_out: false });
  const early = drainJsonl(PENDING_NOTIFS);
  if (early.length) {
    const auto_tasks = readJsonlAll(PENDING_AUTO);
    let online = [];
    try { online = (await callDaemon('who')).users || []; } catch {}
    return jsonResult({
      events: early.map(formatEvent),
      auto_tasks,
      online,
      session: { name: first.session.name, mode: first.session.mode, hopLimit: first.session.hopLimit },
      timed_out: false,
    });
  }

  // Otherwise, long-poll.
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const cur = snapshot();
    if (!cur.alive) {
      return jsonResult({ events: [], auto_tasks: [], daemon: 'died_while_watching', timed_out: false });
    }
    const rows = drainJsonl(PENDING_NOTIFS);
    if (rows.length) {
      const auto_tasks = readJsonlAll(PENDING_AUTO);
      let online = [];
      try { online = (await callDaemon('who')).users || []; } catch {}
      return jsonResult({
        events: rows.map(formatEvent),
        auto_tasks,
        online,
        session: { name: cur.session.name, mode: cur.session.mode, hopLimit: cur.session.hopLimit },
        timed_out: false,
      });
    }
  }

  // Timed out — report auto_tasks so auto-mode can still react to anything
  // that arrived out-of-band.
  const auto_tasks = readJsonlAll(PENDING_AUTO);
  return jsonResult({
    events: [],
    auto_tasks,
    online: [],
    session: first.session ? { name: first.session.name, mode: first.session.mode, hopLimit: first.session.hopLimit } : null,
    timed_out: true,
  });
}

// Stop-equivalent: called before Codex finishes a turn. Reports whether the
// session has unfinished auto-reply obligations, so AGENTS.md can turn that
// into a hard gate ("do not stop if pending_auto_tasks is non-empty"). Does
// NOT drain pending_notifications (that's nexscope_poll's / nexscope_watch's
// job) — this call is side-effect-free; safe to invoke at any point.
async function toolBeforeStop() {
  const session = readJsonOrNull(SESSION_PATH);
  if (!session || !pidAlive(session.pid)) {
    return jsonResult({ can_stop: true, reason: 'daemon not running' });
  }
  if (session.mode !== 'auto') {
    return jsonResult({ can_stop: true, reason: `mode=${session.mode}; no auto-reply obligations` });
  }
  const auto_tasks = readJsonlAll(PENDING_AUTO);
  // Tasks older than 5 minutes are considered abandoned — hook-stop.js in
  // the Claude Code side already treats them as "Claude decided not to
  // reply". Match that behavior here.
  const FRESH_MS = 5 * 60 * 1000;
  const fresh = auto_tasks.filter(t => (Date.now() - (t.ts || 0)) < FRESH_MS);
  if (!fresh.length) {
    return jsonResult({ can_stop: true, reason: 'no fresh auto tasks', expired: auto_tasks.length });
  }
  return jsonResult({
    can_stop: false,
    reason: `${fresh.length} pending @mention(s) require a reply in auto mode`,
    auto_tasks: fresh,
    instruction:
      'For each task, call nexscope_say with to=<task.from>, threadId=<task.threadId>, text=<your reply>. ' +
      'The daemon will clear the task and bump hopCount. Once all are cleared, call nexscope_before_stop again to confirm can_stop:true.',
  });
}

async function toolUpdate() {
  // Delegate to the claude-code update.js by spawning it and collecting stdout.
  const updatePath = path.resolve(path.dirname(__filename), '..', '..', 'claude-code', 'scripts', 'update.js');
  return await new Promise((resolve) => {
    let out = ''; let err = '';
    const p = spawn(process.execPath, [updatePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      if (code === 0) resolve(textResult(out.trim()));
      else resolve(errResult((err || out || 'update failed').trim(), `exit_${code}`));
    });
  });
}

// -------------------------- tool registry --------------------------

const TOOLS = [
  {
    name: 'nexscope_start',
    description:
      'Join the nexscope chat room. Spawns a detached daemon that holds the WebSocket connection. Must be called once per project before other tools work. First run also initializes config.json if missing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Username (3-32 chars, [a-zA-Z0-9_-]). Defaults to config.defaultName.' },
        mode: { type: 'string', enum: ['manual', 'auto'], description: 'Reply mode. Defaults to config.mode (usually manual).' },
      },
      additionalProperties: false,
    },
    handler: toolStart,
  },
  {
    name: 'nexscope_stop',
    description: 'Leave the chat room and shut down the local daemon.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolStop,
  },
  {
    name: 'nexscope_say',
    description:
      'Send a text message or a file to the chat room. Use `to` to target specific users (@mention); leave `to` empty for broadcast. Pass `filePath` to stream a file (the daemon handles file-start + binary chunks + file-end).',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          oneOf: [
            { type: 'string', description: 'Single username' },
            { type: 'array', items: { type: 'string' }, description: 'List of usernames' },
          ],
          description: 'Recipients. Empty array or omit = broadcast.',
        },
        text: { type: 'string', description: 'Message body. Required if filePath is absent. Max 4 KB.' },
        role: { type: 'string', enum: ['user', 'userAgent'], description: 'Source role. Default userAgent (Claude/Codex speaking). Use "user" when the human is speaking through the agent verbatim.' },
        threadId: { type: 'string', description: 'Continue an existing thread. Default: daemon auto-generates.' },
        filePath: { type: 'string', description: 'Absolute path to a local file to send as a binary stream. Max 100 MB.' },
      },
      additionalProperties: false,
    },
    handler: toolSay,
  },
  {
    name: 'nexscope_who',
    description: 'List users currently online in the chat room.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolWho,
  },
  {
    name: 'nexscope_mode',
    description: 'Get or set the reply mode (manual/auto). In auto, pending @mentions appear as auto_tasks in nexscope_poll; reply to them with nexscope_say to satisfy the hop counter.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['manual', 'auto'] } },
      additionalProperties: false,
    },
    handler: toolMode,
  },
  {
    name: 'nexscope_history',
    description: 'Show local message history (recent messages sent and received).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
      additionalProperties: false,
    },
    handler: toolHistory,
  },
  {
    name: 'nexscope_inbox',
    description: 'List inbox items — @mentions received in manual mode (or auto mode items that fell through the hop limit). Returns pending and recent archive.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolInbox,
  },
  {
    name: 'nexscope_accept',
    description: 'Approve a pending inbox thread. Returns all pending messages on that thread so Codex can execute them as a new user request; then reply on the same thread with nexscope_say.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        extra: { type: 'string', description: 'Optional extra instructions from the local human to append.' },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
    handler: toolAccept,
  },
  {
    name: 'nexscope_reject',
    description: 'Reject all pending inbox items on a thread and send a role=user refusal back to the sender.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
    handler: toolReject,
  },
  {
    name: 'nexscope_append',
    description: 'Append a role=user message (spoken by the local human, not the agent) to an existing thread.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['threadId', 'text'],
      additionalProperties: false,
    },
    handler: toolAppend,
  },
  {
    name: 'nexscope_update',
    description: 'Update the nexscope plugin source (git pull + npm install). Auto-stops the daemon first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolUpdate,
  },
  {
    name: 'nexscope_poll',
    description:
      'Drain queued notifications for this session — presence changes, incoming messages, file-transfer events, system notices — and return them once. Call this at the START of every turn (or when the user asks what is new) so Codex becomes aware of activity that happened outside this turn. Also returns pending_auto_tasks and the online user list. Each notification is consumed on return; subsequent polls only see newer events. Non-blocking: returns immediately whether or not events exist.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolPoll,
  },
  {
    name: 'nexscope_watch',
    description:
      'Long-poll: block until a new event arrives in the chat room, or until the timeout elapses. Returns the same shape as nexscope_poll. Use this when the user asks to wait for a reply, or when you expect a response shortly and want to catch it in this turn instead of waiting for the next. Does not help with idle-time wake-up (Codex tools only run during active turns), but it does let a single turn absorb events that arrive a few seconds later. Drains pending_notifications on return.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 120,
          default: 30,
          description: 'How long to wait for an event before returning empty. Default 30s, max 120s.',
        },
      },
      additionalProperties: false,
    },
    handler: toolWatch,
  },
  {
    name: 'nexscope_before_stop',
    description:
      'Stop-equivalent gate for auto mode. Call this JUST BEFORE ending your response to the user. If it returns can_stop=false, it means there are fresh @mentions awaiting an auto-reply — you must handle them (via nexscope_say on the matching threadId) and call this again until can_stop=true, before finishing. Does NOT drain the notification queue; safe to call multiple times. In manual mode it always returns can_stop=true (mentions go to the inbox, handled by the human).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolBeforeStop,
  },
];

// -------------------------- dispatcher --------------------------

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ handler, ...rest }) => rest),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return errResult(`unknown tool: ${name}`, 'unknown_tool');
  try {
    return await tool.handler(args);
  } catch (e) {
    if (e instanceof IpcError) return errResult(e.message, e.code);
    return errResult(e.message || String(e), 'internal');
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
