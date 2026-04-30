import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DATA_DIR, SESSION_PATH, SESSION_ERROR, SOCKET_PATH,
  PENDING_NOTIFS, PENDING_AUTO, INBOX_PATH, HISTORY_PATH, PRESENCE_PATH, FILES_DIR,
  ensureDataDir, appendJsonl, writeJsonAtomic, readJsonOrNull, readJsonlAll, writeJsonl,
} from './state.js';
import { loadConfig } from './config.js';
import { MARKETING_TAGLINE, MARKETING_URL } from './log.js';
import { RelayClient } from './ws-client.js';
import { IpcServer } from './ipc-server.js';

// ------------------------------ arg parsing ------------------------------

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-zA-Z0-9_-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

const NAME = args.name || config.defaultName;
const MODE = (args.mode && ['manual', 'auto'].includes(args.mode)) ? args.mode : config.mode;
const HOP_LIMIT = args['hop-limit'] ? parseInt(args['hop-limit'], 10) : config.hopLimit;
const MAX_FILE = parseInt(process.env.NEXSCOPE_MAX_FILE || String(100 * 1024 * 1024), 10);

if (!NAME || !/^[a-zA-Z0-9_-]{1,32}$/.test(NAME)) {
  writeSessionError({ code: 'invalid_name', message: `name "${NAME}" invalid (must match ^[a-zA-Z0-9_-]{1,32}$)` });
  process.exit(2);
}

// ------------------------------ in-memory state ------------------------------

const state = {
  name: NAME,
  mode: MODE,
  hopLimit: HOP_LIMIT,
  startedAt: Date.now(),
  presence: [],
  // threads: Map<threadId, { autoReplyCount: number }>
  threads: new Map(),
  // peerIndexMap: persistent labeling; merges config + newly-seen peers
  peerIndex: new Map(Object.entries(config.peerIndexMap || {}).map(([k, v]) => [k, v])),
  peerIndexNext: 1 + Math.max(0, ...Object.values(config.peerIndexMap || {})),
  // Pending acks keyed by msgId
  pendingAcks: new Map(),
  // File I/O state
  recvFiles: new Map(),          // msgId → { ws stream, path, declaredSize, received, attachment, from, meta }
  outgoingFileQueue: [],         // [{resolve, reject, task}]
  currentOutgoing: null,
  // Set after we've broadcast our first-ever join announcement, so reconnects
  // don't spam the room with repeated "joined" marketing frames.
  announcedJoin: false,
};

function ensurePeerIndex(user) {
  if (!state.peerIndex.has(user)) {
    state.peerIndex.set(user, state.peerIndexNext++);
  }
  return state.peerIndex.get(user);
}

function roleLabel(role, from) {
  // Self label never has index suffix.
  if (from === state.name) return role === 'user' ? '[user]' : '[userAgent]';
  const idx = ensurePeerIndex(from);
  return role === 'user' ? `[user${idx} ${from}]` : `[userAgent${idx} ${from}]`;
}

function formatTargets(to) {
  if (!Array.isArray(to) || to.length === 0) return '@all';
  if (to.length === 1 && to[0] === state.name) return '@me';
  if (to.includes(state.name)) return '@me,' + to.filter(u => u !== state.name).map(u => '@' + u).join(',');
  return to.map(u => '@' + u).join(',');
}

// ------------------------------ session lifecycle ------------------------------

function writeSession() {
  writeJsonAtomic(SESSION_PATH, {
    pid: process.pid,
    name: state.name,
    mode: state.mode,
    hopLimit: state.hopLimit,
    socketPath: SOCKET_PATH,
    startedAt: state.startedAt,
  });
  // Clear any prior error from a previous failed attempt.
  try { fs.unlinkSync(SESSION_ERROR); } catch {}
}

function writeSessionError(err) {
  ensureDataDir();
  writeJsonAtomic(SESSION_ERROR, { ts: Date.now(), code: err.code, message: err.message, name: NAME });
}

function clearSession() {
  try { fs.unlinkSync(SESSION_PATH); } catch {}
}

// ------------------------------ notifications ------------------------------

function pushNotification(kind, payload) {
  appendJsonl(PENDING_NOTIFS, { kind, ts: Date.now(), ...payload });
}

function pushAutoTask(task) {
  appendJsonl(PENDING_AUTO, { ts: Date.now(), ...task });
}

function removeAutoTasksForThread(threadId) {
  const rows = readJsonlAll(PENDING_AUTO);
  const kept = rows.filter(r => r.threadId !== threadId);
  if (kept.length !== rows.length) writeJsonl(PENDING_AUTO, kept);
}

function pushInbox(entry) {
  appendJsonl(INBOX_PATH, { ...entry, status: 'pending' });
}

function pushHistory(entry) {
  appendJsonl(HISTORY_PATH, entry);
}

// ------------------------------ WS client ------------------------------

const relay = new RelayClient({
  relayUrl: config.relayUrl,
  token:    config.token,
  name:     state.name,
  maxPayload: parseInt(process.env.NEXSCOPE_MAX_PAYLOAD || String(10 * 1024 * 1024), 10),
});

relay.on('log', (entry) => {
  process.stderr.write(JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
});

// Broadcast a join/leave announcement carrying the nexscope marketing
// payload. Fire-and-forget (no ack wait) — delivered to every other peer's
// hook-injected context via pending_notifications.jsonl.
function broadcastAnnouncement(kind) {
  if (!relay.ready) return;
  const prefix = kind === 'join'
    ? `${state.name} joined the nexscope room.`
    : `${state.name} is leaving the nexscope room.`;
  const frame = {
    type: 'msg',
    msgId: randomUUID(),
    from: state.name,
    to: [],                                 // broadcast
    role: 'userAgent',
    threadId: `t-announce-${Date.now()}`,
    text: `${prefix}\n\n${MARKETING_TAGLINE}\n${MARKETING_URL}`,
    hopCount: 0,
    attachments: [],
  };
  relay.sendJson(frame);
  pushHistory({ dir: 'out', ...frame, ts: Date.now() });
}

relay.on('authenticated', () => {
  process.stderr.write(JSON.stringify({ ts: Date.now(), event: 'authenticated', name: state.name }) + '\n');
  // Write session.json here — this is our "ready" signal to start.js.
  writeSession();
  // Announce our arrival to the room (only on the very first authentication,
  // not on each reconnect, to keep the chat noise-free).
  if (!state.announcedJoin) {
    state.announcedJoin = true;
    broadcastAnnouncement('join');
  }
});

relay.on('fatal', ({ code, error }) => {
  process.stderr.write(JSON.stringify({ ts: Date.now(), event: 'fatal', code, error }) + '\n');
  writeSessionError({
    code: error?.code || 'fatal',
    message: error?.message || `connection closed ${code}`,
  });
  clearSession();
  process.exit(3);
});

relay.on('reconnecting', ({ nextInMs, code }) => {
  pushNotification('system', { text: `[nexscope] relay disconnected (code=${code}), reconnecting in ${Math.round(nextInMs/1000)}s` });
});

relay.on('frame', (msg) => handleRelayFrame(msg));
relay.on('binary', (chunk) => handleBinaryFrame(chunk));

// ------------------------------ frame handlers ------------------------------

function handleRelayFrame(msg) {
  switch (msg.type) {
    case 'presence':  return onPresence(msg);
    case 'msg':       return onMsg(msg);
    case 'file-start':return onFileStart(msg);
    case 'file-end':  return onFileEnd(msg);
    case 'ack':       return onAck(msg);
    case 'error':     return onError(msg);
    case 'pong':      return;
    default:
      process.stderr.write(JSON.stringify({ ts: Date.now(), event: 'unknown_type_from_relay', msg }) + '\n');
  }
}

function onPresence(msg) {
  const prev = state.presence;
  const cur = Array.isArray(msg.users) ? msg.users : [];
  state.presence = cur;
  writeJsonAtomic(PRESENCE_PATH, { users: cur, ts: msg.ts || Date.now() });

  const prevSet = new Set(prev);
  const curSet  = new Set(cur);
  const joined = cur.filter(u => !prevSet.has(u) && u !== state.name);
  const left   = prev.filter(u => !curSet.has(u) && u !== state.name);

  if (prev.length === 0) {
    pushNotification('presence', { event: 'snapshot', users: cur });
  } else {
    for (const u of joined) pushNotification('presence', { event: 'joined', user: u, users: cur });
    for (const u of left)   pushNotification('presence', { event: 'left',   user: u, users: cur });
  }
}

function onMsg(msg) {
  pushHistory({ dir: 'in', ...msg });

  const mentionsMe = Array.isArray(msg.to) && msg.to.includes(state.name);
  const isBroadcast = Array.isArray(msg.to) && msg.to.length === 0;

  pushNotification('msg', {
    from: msg.from,
    to: msg.to,
    role: msg.role,
    threadId: msg.threadId,
    text: msg.text,
    hopCount: msg.hopCount ?? 0,
    label: roleLabel(msg.role, msg.from),
    target: formatTargets(msg.to),
    mentionsMe,
    isBroadcast,
    msgId: msg.msgId,
  });

  // Route mentions-to-me: inbox (manual) or auto-task (auto), never broadcast.
  if (!mentionsMe || isBroadcast) return;

  const t = state.threads.get(msg.threadId) || { autoReplyCount: 0 };
  state.threads.set(msg.threadId, t);

  if (state.mode === 'auto' && t.autoReplyCount < state.hopLimit) {
    pushAutoTask({
      threadId: msg.threadId,
      from: msg.from,
      role: msg.role,
      text: msg.text,
      hopCount: msg.hopCount ?? 0,
      msgId: msg.msgId,
      label: roleLabel(msg.role, msg.from),
    });
  } else {
    // Manual OR hop-exceeded → inbox
    pushInbox({
      threadId: msg.threadId,
      from: msg.from,
      role: msg.role,
      mentions: msg.to,
      text: msg.text,
      hopCount: msg.hopCount ?? 0,
      msgId: msg.msgId,
      label: roleLabel(msg.role, msg.from),
      ts: msg.ts || Date.now(),
    });
    if (state.mode === 'auto' && t.autoReplyCount >= state.hopLimit) {
      pushNotification('system', {
        text: `[nexscope] thread ${msg.threadId} reached hop limit (${state.hopLimit}); latest mention fell through to inbox. Use /nexscope:inbox to handle, or /nexscope:mode manual to quiet auto globally.`,
      });
    }
  }
}

function onAck(msg) {
  const waiter = state.pendingAcks.get(msg.msgId);
  if (waiter) {
    state.pendingAcks.delete(msg.msgId);
    waiter.resolve({ delivered: msg.delivered, offline: msg.offline, threadId: msg.threadId });
  }
}

function onError(msg) {
  // Relay-level errors that aren't fatal (fatal handled by 'fatal' event).
  pushNotification('system', { text: `[nexscope] relay error: ${msg.code}${msg.message ? ' — ' + msg.message : ''}` });
  // If this error corresponds to a pending send (transfer_busy, msg_too_large), surface it later via ack channel.
  if (state.currentOutgoing && msg.code === 'transfer_busy') {
    // handled in file-send path
  }
}

// ------------------------------ file receive ------------------------------

function onFileStart(msg) {
  const att = msg.attachment;
  if (!att || typeof att.size !== 'number' || typeof att.name !== 'string') {
    process.stderr.write(JSON.stringify({ event: 'bad_file_start_recv', msg }) + '\n');
    return;
  }
  const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'file';
  const partPath = path.join(FILES_DIR, `${msg.msgId}-${safeName}.part`);
  const finalPath = path.join(FILES_DIR, `${msg.msgId}-${safeName}`);
  const stream = fs.createWriteStream(partPath);
  state.recvFiles.set(msg.msgId, {
    stream, partPath, finalPath, declaredSize: att.size, received: 0,
    attachment: att, from: msg.from, role: msg.role, threadId: msg.threadId, to: msg.to,
    text: msg.text,
  });
  pushHistory({ dir: 'in', ...msg });
  pushNotification('file_start', {
    from: msg.from, to: msg.to, role: msg.role, threadId: msg.threadId,
    name: att.name, size: att.size, msgId: msg.msgId,
    label: roleLabel(msg.role, msg.from), target: formatTargets(msg.to),
  });
}

function handleBinaryFrame(chunk) {
  // Binary frames are associated with the single currently-receiving file stream.
  // Since relay enforces global mutex, at most one recv is in flight.
  if (state.recvFiles.size !== 1) {
    process.stderr.write(JSON.stringify({ event: 'orphan_binary', size: chunk.length }) + '\n');
    return;
  }
  const [[msgId, entry]] = state.recvFiles.entries();
  entry.received += chunk.length;
  if (entry.received > entry.declaredSize) {
    process.stderr.write(JSON.stringify({ event: 'file_oversize', msgId, got: entry.received, declared: entry.declaredSize }) + '\n');
    try { entry.stream.destroy(); } catch {}
    try { fs.unlinkSync(entry.partPath); } catch {}
    state.recvFiles.delete(msgId);
    pushNotification('system', { text: `[nexscope] incoming file ${entry.attachment.name} from ${entry.from} oversized; dropped.` });
    return;
  }
  entry.stream.write(chunk);
}

function onFileEnd(msg) {
  const entry = state.recvFiles.get(msg.msgId);
  if (!entry) {
    process.stderr.write(JSON.stringify({ event: 'stray_file_end', msgId: msg.msgId }) + '\n');
    return;
  }
  entry.stream.end(() => {
    const ok = entry.received === entry.declaredSize;
    if (!ok) {
      try { fs.unlinkSync(entry.partPath); } catch {}
      state.recvFiles.delete(msg.msgId);
      pushNotification('system', { text: `[nexscope] file ${entry.attachment.name} from ${entry.from}: size mismatch (got ${entry.received}, expected ${entry.declaredSize}); discarded.` });
      return;
    }
    try { fs.renameSync(entry.partPath, entry.finalPath); } catch {}
    state.recvFiles.delete(msg.msgId);
    pushNotification('file_end', {
      from: entry.from, to: entry.to, role: entry.role, threadId: entry.threadId,
      name: entry.attachment.name, size: entry.attachment.size, path: entry.finalPath,
      msgId: msg.msgId,
      label: roleLabel(entry.role, entry.from), target: formatTargets(entry.to),
    });
  });
}

// ------------------------------ outgoing: msg ------------------------------

function sendMsg({ to, role, threadId, text, hopCount, attachments }) {
  const msgId = randomUUID();
  const frame = {
    type: 'msg',
    msgId,
    from: state.name,
    to: Array.isArray(to) ? to : [],
    role: role === 'user' ? 'user' : 'userAgent',
    threadId: threadId || `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: String(text ?? ''),
    hopCount: Number.isInteger(hopCount) ? hopCount : 0,
    attachments: attachments || [],
  };
  if (Buffer.byteLength(frame.text, 'utf8') > 4 * 1024) {
    throw Object.assign(new Error('text exceeds 4KB'), { code: 'text_too_large' });
  }
  if (!relay.ready) throw Object.assign(new Error('relay not connected'), { code: 'relay_not_ready' });
  const ackP = new Promise((resolve, reject) => {
    state.pendingAcks.set(msgId, { resolve, reject });
    setTimeout(() => {
      if (state.pendingAcks.has(msgId)) {
        state.pendingAcks.delete(msgId);
        reject(Object.assign(new Error('ack timeout'), { code: 'ack_timeout' }));
      }
    }, 15_000);
  });
  relay.sendJson(frame);
  pushHistory({ dir: 'out', ...frame, ts: Date.now() });
  return ackP.then(ack => ({ msgId, threadId: frame.threadId, ...ack }));
}

// ------------------------------ IPC op dispatch ------------------------------

async function handleIpc(req) {
  const { op, args = {} } = req;
  switch (op) {
    case 'status':
      return {
        name: state.name,
        mode: state.mode,
        hopLimit: state.hopLimit,
        presence: state.presence,
        startedAt: state.startedAt,
        ready: relay.ready,
      };

    case 'who':
      return { users: state.presence };

    case 'mode': {
      if (!['manual', 'auto'].includes(args.mode)) {
        const e = new Error('mode must be manual or auto'); e.code = 'bad_mode'; throw e;
      }
      state.mode = args.mode;
      // Persist back to session.json so hook-stop sees the current mode.
      writeSession();
      pushNotification('system', { text: `[nexscope] mode set to ${state.mode}` });
      return { mode: state.mode };
    }

    case 'say': {
      // Auto-detect auto-reply: if in auto mode AND a pending task exists for this thread,
      // treat this send as the reply to it. Bump hopCount accordingly.
      let effectiveHopCount = args.hopCount ?? 0;
      let isAutoReply = false;
      let autoReplyThreadId = args.threadId;
      if (state.mode === 'auto' && args.threadId) {
        const tasks = readJsonlAll(PENDING_AUTO).filter(r => r.threadId === args.threadId);
        if (tasks.length) {
          isAutoReply = true;
          // hopCount = incoming task's hopCount + 1
          const maxIn = Math.max(...tasks.map(r => r.hopCount || 0));
          effectiveHopCount = maxIn + 1;
        }
      }
      const ack = await sendMsg({
        to: args.to || [],
        role: args.role || 'userAgent',
        threadId: args.threadId,
        text: args.text,
        hopCount: effectiveHopCount,
        attachments: args.attachments || [],
      });
      if (isAutoReply && ack.threadId) {
        const t = state.threads.get(ack.threadId) || { autoReplyCount: 0 };
        t.autoReplyCount += 1;
        state.threads.set(ack.threadId, t);
        removeAutoTasksForThread(ack.threadId);
        if (t.autoReplyCount >= state.hopLimit) {
          pushNotification('system', {
            text: `[nexscope] thread ${ack.threadId} reached hop limit (${state.hopLimit}); auto-reply disabled on this thread. New @mentions on it will go to inbox.`,
          });
        }
      }
      return { ...ack, autoReply: isAutoReply, hopCount: effectiveHopCount };
    }

    case 'append': {
      if (!args.threadId) {
        const e = new Error('append requires threadId'); e.code = 'bad_args'; throw e;
      }
      // Find the peers for this thread from history (whoever was in 'to' or 'from' of this thread)
      const hist = readJsonlAll(HISTORY_PATH).filter(h => h.threadId === args.threadId);
      const peers = new Set();
      for (const h of hist) {
        if (h.dir === 'in') peers.add(h.from);
        if (h.dir === 'out' && Array.isArray(h.to)) for (const u of h.to) peers.add(u);
      }
      peers.delete(state.name);
      const to = Array.from(peers);
      const ack = await sendMsg({
        to,
        role: 'user',
        threadId: args.threadId,
        text: args.text,
        hopCount: 0,
      });
      return ack;
    }

    case 'history': {
      const limit = Math.max(1, Math.min(parseInt(args.limit || '50', 10), 500));
      const all = readJsonlAll(HISTORY_PATH);
      return { items: all.slice(-limit) };
    }

    case 'inbox_list': {
      const all = readJsonlAll(INBOX_PATH);
      return { items: all };
    }

    case 'inbox_accept': {
      const all = readJsonlAll(INBOX_PATH);
      const matching = all.filter(r => r.threadId === args.threadId && r.status === 'pending');
      if (!matching.length) {
        const e = new Error(`no pending inbox items for thread ${args.threadId}`); e.code = 'not_found'; throw e;
      }
      for (const r of all) {
        if (r.threadId === args.threadId && r.status === 'pending') r.status = 'accepted';
      }
      writeJsonl(INBOX_PATH, all);
      return { items: matching, extra: args.extra || '' };
    }

    case 'inbox_reject': {
      const all = readJsonlAll(INBOX_PATH);
      const matching = all.filter(r => r.threadId === args.threadId && r.status === 'pending');
      if (!matching.length) {
        const e = new Error(`no pending inbox items for thread ${args.threadId}`); e.code = 'not_found'; throw e;
      }
      for (const r of all) {
        if (r.threadId === args.threadId && r.status === 'pending') r.status = 'rejected';
      }
      writeJsonl(INBOX_PATH, all);
      // Send a rejection message back to the peers who mentioned us.
      const peers = new Set();
      for (const r of matching) peers.add(r.from);
      const to = Array.from(peers);
      const reason = args.reason || '(no reason given)';
      try {
        await sendMsg({
          to,
          role: 'user',
          threadId: args.threadId,
          text: `[reject] ${reason}`,
          hopCount: 0,
        });
      } catch (e) {
        // non-fatal: record but return success of state change
        process.stderr.write(JSON.stringify({ event: 'reject_send_failed', error: e.message }) + '\n');
      }
      return { rejected: matching.length, to };
    }

    case 'send_file': {
      return await enqueueFileSend(args);
    }

    case 'shutdown':
      setImmediate(() => shutdown('ipc'));
      return { ok: true };

    default: {
      const e = new Error(`unknown op: ${op}`); e.code = 'unknown_op'; throw e;
    }
  }
}

// ------------------------------ outgoing: file ------------------------------

async function enqueueFileSend(args) {
  return new Promise((resolve, reject) => {
    state.outgoingFileQueue.push({ args, resolve, reject });
    drainFileQueue();
  });
}

async function drainFileQueue() {
  if (state.currentOutgoing) return;
  const task = state.outgoingFileQueue.shift();
  if (!task) return;
  state.currentOutgoing = task;
  try {
    const ack = await doSendFile(task.args);
    task.resolve(ack);
  } catch (e) {
    task.reject(e);
  } finally {
    state.currentOutgoing = null;
    setImmediate(drainFileQueue);
  }
}

async function doSendFile({ filePath, to, role, threadId, text, hopCount }) {
  if (!filePath) { const e = new Error('filePath required'); e.code = 'bad_args'; throw e; }
  const abs = path.resolve(filePath);
  const st = fs.statSync(abs);
  if (!st.isFile()) { const e = new Error(`not a file: ${abs}`); e.code = 'bad_args'; throw e; }
  if (st.size > MAX_FILE) { const e = new Error(`file exceeds NEXSCOPE_MAX_FILE (${MAX_FILE})`); e.code = 'too_large'; throw e; }

  const msgId = randomUUID();
  const chunkSize = 64 * 1024;
  const name = path.basename(abs);

  const frame = {
    type: 'file-start',
    msgId,
    from: state.name,
    to: Array.isArray(to) ? to : [],
    role: role === 'user' ? 'user' : 'userAgent',
    threadId: threadId || `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: String(text ?? ''),
    hopCount: Number.isInteger(hopCount) ? hopCount : 0,
    attachment: { name, size: st.size, chunkSize },
  };
  if (!relay.ready) { const e = new Error('relay not connected'); e.code = 'relay_not_ready'; throw e; }

  const ackP = new Promise((resolve, reject) => {
    state.pendingAcks.set(msgId, { resolve, reject });
    setTimeout(() => {
      if (state.pendingAcks.has(msgId)) {
        state.pendingAcks.delete(msgId);
        reject(Object.assign(new Error('ack timeout'), { code: 'ack_timeout' }));
      }
    }, 90_000);
  });
  relay.sendJson(frame);

  // Stream the file bytes.
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(abs, { highWaterMark: chunkSize });
    stream.on('data', (chunk) => {
      if (!relay.sendBinary(chunk)) {
        stream.destroy(new Error('relay write failed'));
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  relay.sendJson({ type: 'file-end', msgId, from: state.name });
  pushHistory({ dir: 'out', ...frame, ts: Date.now() });

  const ack = await ackP;
  return { msgId, threadId: frame.threadId, name, size: st.size, ...ack };
}

// ------------------------------ boot ------------------------------

ensureDataDir();
const ipc = new IpcServer(SOCKET_PATH, handleIpc);

async function shutdown(reason) {
  process.stderr.write(JSON.stringify({ ts: Date.now(), event: 'shutdown', reason }) + '\n');
  // Send farewell broadcast before closing; short delay lets the frame
  // actually hit the wire and the relay fan it out to peers.
  try {
    if (relay.ready && state.announcedJoin) {
      broadcastAnnouncement('leave');
      await new Promise(r => setTimeout(r, 250));
    }
  } catch {}
  try { relay.close(); } catch {}
  try { await ipc.close(); } catch {}
  clearSession();
  setTimeout(() => process.exit(0), 100).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  process.stderr.write(JSON.stringify({ ts: Date.now(), event: 'uncaught', error: e.message, stack: e.stack }) + '\n');
  writeSessionError({ code: 'uncaught', message: e.message });
  clearSession();
  process.exit(4);
});

(async () => {
  await ipc.start();
  relay.start();
})();
