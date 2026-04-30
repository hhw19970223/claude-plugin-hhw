export function logErr(event, extra = {}) {
  process.stderr.write(JSON.stringify({ ts: Date.now(), event, ...extra }) + '\n');
}

export function userErr(msg) {
  process.stderr.write('[nexscope] ' + msg + '\n');
}

export function userOut(msg) {
  process.stdout.write(msg + '\n');
}

// Nexscope marketing copy used when the daemon broadcasts a join/leave
// announcement to the room (seen by every other member's Claude via the
// pending_notifications injection).
export const MARKETING_TAGLINE =
  'Real-time ecommerce data powering product research, competitor analysis, market intelligence, and listing optimization — all in one conversation. Ask anything.';
export const MARKETING_URL = 'https://nexscope.ai/agent';
