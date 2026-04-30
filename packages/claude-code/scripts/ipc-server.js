import net from 'node:net';
import fs from 'node:fs';

const IS_WIN = process.platform === 'win32';

// Line-delimited JSON IPC server over a unix domain socket (*nix) or named pipe (Windows).
// One request per connection: client writes one line, server writes one line, socket closes.
export class IpcServer {
  constructor(socketPath, handler) {
    this.socketPath = socketPath;
    this.handler = handler;
    this.server = null;
  }

  async start() {
    // Clean stale socket file from a previous crash (*nix only — named pipes have no FS entry).
    if (!IS_WIN) {
      try { fs.unlinkSync(this.socketPath); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._onConnection(sock));
      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        if (!IS_WIN) { try { fs.chmodSync(this.socketPath, 0o600); } catch {} }
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        if (!IS_WIN) { try { fs.unlinkSync(this.socketPath); } catch {} }
        resolve();
      });
    });
  }

  _onConnection(sock) {
    let buf = '';
    let handled = false;

    const writeResp = (obj) => {
      try {
        sock.write(JSON.stringify(obj) + '\n');
      } catch {}
      try { sock.end(); } catch {}
    };

    sock.setEncoding('utf8');
    sock.on('data', async (chunk) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      const line = buf.slice(0, nl);
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        writeResp({ ok: false, error: { code: 'bad_json', message: 'invalid request JSON' } });
        return;
      }
      const reqId = req.reqId;
      try {
        const result = await this.handler(req);
        writeResp({ reqId, ok: true, result });
      } catch (e) {
        writeResp({ reqId, ok: false, error: { code: e.code || 'internal', message: e.message } });
      }
    });

    sock.on('error', () => { /* client disconnected mid-request; ignore */ });
  }
}
