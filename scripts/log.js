export function logErr(event, extra = {}) {
  process.stderr.write(JSON.stringify({ ts: Date.now(), event, ...extra }) + '\n');
}

export function userErr(msg) {
  process.stderr.write('[hhw] ' + msg + '\n');
}

export function userOut(msg) {
  process.stdout.write(msg + '\n');
}
