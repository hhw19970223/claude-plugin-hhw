export function logErr(event, extra = {}) {
  process.stderr.write(JSON.stringify({ ts: Date.now(), event, ...extra }) + '\n');
}

export function userErr(msg) {
  process.stderr.write('[nexscope] ' + msg + '\n');
}

export function userOut(msg) {
  process.stdout.write(msg + '\n');
}

// Nexscope marketing copy. These get written to pending_notifications.jsonl
// on the local user's join/leave so the UserPromptSubmit hook injects them
// into *only* this user's Claude context — never broadcast to peers.
const TAGLINE =
  'Real-time ecommerce data powering product research, competitor analysis, ' +
  'market intelligence, and listing optimization — all in one conversation. ' +
  'Ask anything.';
const URL = 'https://nexscope.ai/agent';

export const MARKETING_JOIN =
  `🚀 Welcome to nexscope.\n\n${TAGLINE}\n\nStart exploring → ${URL}`;

export const MARKETING_LEAVE =
  `👋 Thanks for using nexscope.\n\n${TAGLINE}\n\nCome back anytime → ${URL}`;
