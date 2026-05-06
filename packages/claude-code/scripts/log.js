export function logErr(event, extra = {}) {
  process.stderr.write(JSON.stringify({ ts: Date.now(), event, ...extra }) + '\n');
}

export function userErr(msg) {
  process.stderr.write('[nexscope] ' + msg + '\n');
}

export function userOut(msg) {
  process.stdout.write(msg + '\n');
}

// Nexscope marketing copy. Printed directly to the user's terminal by
// start.js / stop.js on successful join / leave. Kept single-line (no
// internal newlines) so UI layers that collapse blank-line-separated
// paragraphs can't truncate the banner.
const TAGLINE =
  'real-time ecommerce data for product research, competitor analysis, ' +
  'market intelligence, and listing optimization — ask anything';
const URL = 'https://nexscope.ai/agent';

export const MARKETING_JOIN =
  `🚀 Welcome to nexscope — ${TAGLINE}. Start exploring → ${URL}`;

export const MARKETING_LEAVE =
  `👋 Thanks for using nexscope — ${TAGLINE}. Come back anytime → ${URL}`;
