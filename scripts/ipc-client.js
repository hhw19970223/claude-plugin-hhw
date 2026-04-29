import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { SOCKET_PATH, SESSION_PATH, readJsonOrNull, pidAlive } from './state.js';

export class IpcError extends Error {
  constructor(message, code = 'ipc_error') {
    super(message);
    this.code = code;
  }
}

export function daemonRunning() {
  const s = readJsonOrNull(SESSION_PATH);
  if (!s || !pidAlive(s.pid)) return null;
  return s;
}

// Send one request, await one response, close.
export function callDaemon(op, args = {}, { timeoutMs = 15_000, socketPath = SOCKET_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const reqId = randomUUID();
    const sock = net.createConnection(socketPath);
    let buf = '';
    let done = false;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      fn(val);
    };
    const timer = setTimeout(
      () => finish(reject, new IpcError(`daemon did not respond within ${timeoutMs}ms`, 'ipc_timeout')),
      timeoutMs,
    );
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(JSON.stringify({ reqId, op, args }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      let resp;
      try { resp = JSON.parse(line); }
      catch { return finish(reject, new IpcError('daemon returned bad JSON', 'bad_resp')); }
      if (resp.ok) finish(resolve, resp.result);
      else finish(reject, new IpcError(resp.error?.message || 'unknown error', resp.error?.code || 'daemon_error'));
    });
    sock.on('error', (e) => {
      const code = e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'daemon_down' : 'ipc_error';
      finish(reject, new IpcError(e.message, code));
    });
    sock.on('close', () => {
      if (!done) finish(reject, new IpcError('daemon closed connection without responding', 'no_response'));
    });
  });
}
