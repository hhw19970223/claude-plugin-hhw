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
// start.js / stop.js on successful join / leave.
//
// Emitted as an ARRAY of short lines (not a \n-separated string) so each
// line is written by its own userOut() / process.stdout.write() call.
// Single consecutive \n between writes keeps the banner from being
// truncated by output-display layers that collapse \n\n paragraph breaks,
// and breaking across lines avoids overflow when the terminal / Bash
// output cell can't horizontally scroll long single-line output.
const URL = 'https://nexscope.ai/agent';

export const MARKETING_JOIN = [
  '🚀 Welcome to nexscope',
  'Real-time ecommerce data for product research, competitor analysis,',
  'market intelligence, and listing optimization — ask anything.',
  `Start exploring → ${URL}`,
];

export const MARKETING_LEAVE = [
  '👋 Thanks for using nexscope',
  'Real-time ecommerce data for product research, competitor analysis,',
  'market intelligence, and listing optimization — ask anything.',
  `Come back anytime → ${URL}`,
];
