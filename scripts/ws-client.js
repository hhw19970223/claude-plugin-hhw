import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const PROTOCOL_VERSION = 1;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const AUTH_TIMEOUT_MS = 10_000;

function buildUrl(relayUrl, name, token) {
  const u = new URL(relayUrl);
  u.searchParams.set('name', name);
  u.searchParams.set('token', token);
  u.searchParams.set('v', String(PROTOCOL_VERSION));
  return u.toString();
}

// Fatal close codes = don't reconnect (user intervention needed).
const FATAL_CODES = new Set([1008, 4009, 4012, 4011, 4013]);

export class RelayClient extends EventEmitter {
  constructor({ relayUrl, token, name, maxPayload }) {
    super();
    this.relayUrl = relayUrl;
    this.token    = token;
    this.name     = name;
    this.maxPayload = maxPayload ?? 10 * 1024 * 1024;
    this.ws        = null;
    this.closing   = false;
    this.authenticated = false;      // true once we've received first server frame
    this.backoffMs = MIN_BACKOFF_MS;
    this.pendingError = null;        // captured server-side error frame (name_taken etc.)
    this.authTimer = null;
  }

  start() {
    this._connect();
  }

  close() {
    this.closing = true;
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    if (this.ws) {
      try { this.ws.close(1000, 'client_shutdown'); } catch {}
      try { this.ws.terminate(); } catch {}
    }
  }

  sendJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      this.emit('send_error', { error: e.message });
      return false;
    }
  }

  sendBinary(chunk) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(chunk, { binary: true });
      return true;
    } catch (e) {
      this.emit('send_error', { error: e.message });
      return false;
    }
  }

  get ready() {
    return this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated;
  }

  _connect() {
    const url = buildUrl(this.relayUrl, this.name, this.token);
    this.pendingError = null;
    this.authenticated = false;

    const ws = new WebSocket(url, { maxPayload: this.maxPayload });
    this.ws = ws;

    this.authTimer = setTimeout(() => {
      this.emit('log', { event: 'auth_timeout' });
      try { ws.terminate(); } catch {}
    }, AUTH_TIMEOUT_MS);

    ws.on('open', () => {
      this.emit('log', { event: 'ws_open' });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.emit('binary', data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        this.emit('log', { event: 'bad_json_from_relay' });
        return;
      }
      if (!this.authenticated) {
        // First frame. Could be 'presence' (success) or 'error' (failure).
        if (msg.type === 'error') {
          this.pendingError = msg;
          // relay will close us right after; handle in 'close'.
          return;
        }
        this._markAuthenticated();
      }
      this.emit('frame', msg);
    });

    ws.on('close', (code, reasonBuf) => {
      if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
      const reason = reasonBuf?.toString('utf8') ?? '';
      this.emit('log', { event: 'ws_close', code, reason });

      const wasAuth = this.authenticated;
      this.authenticated = false;
      this.ws = null;

      if (!wasAuth) {
        // Died before auth. Check pendingError + code to decide fatal vs retry.
        if (this.pendingError) {
          this.emit('fatal', { code, reason, error: this.pendingError });
          return;
        }
        if (FATAL_CODES.has(code)) {
          this.emit('fatal', { code, reason, error: { code: 'auth_failed', message: reason || `close ${code}` } });
          return;
        }
      }

      if (this.closing) {
        this.emit('closed', { code, reason });
        return;
      }

      // Otherwise reconnect (initial conn transient failure, or mid-session drop).
      this.emit('reconnecting', { code, reason, nextInMs: this.backoffMs });
      setTimeout(() => {
        if (this.closing) return;
        this._connect();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });

    ws.on('error', (err) => {
      this.emit('log', { event: 'ws_error', error: err.message });
    });

    ws.on('ping', () => {
      // ws library auto-pongs; no action needed.
    });
  }

  _markAuthenticated() {
    this.authenticated = true;
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    this.backoffMs = MIN_BACKOFF_MS;
    this.emit('authenticated');
  }
}
