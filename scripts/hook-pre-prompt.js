import { PENDING_NOTIFS, SESSION_PATH, drainJsonl, readJsonOrNull, pidAlive } from './state.js';

// Format a single notification row into a human-readable line.
function formatLine(n) {
  switch (n.kind) {
    case 'presence': {
      if (n.event === 'snapshot') return `[hhw presence] online: ${(n.users || []).join(', ')}`;
      if (n.event === 'joined')   return `[hhw presence] ${n.user} joined | online: ${(n.users || []).join(', ')}`;
      if (n.event === 'left')     return `[hhw presence] ${n.user} left | online: ${(n.users || []).join(', ')}`;
      return `[hhw presence] (unknown event) ${JSON.stringify(n)}`;
    }
    case 'msg': {
      const tid = n.threadId ? ` (thread=${n.threadId})` : '';
      const hop = typeof n.hopCount === 'number' && n.hopCount > 0 ? ` hop=${n.hopCount}` : '';
      return `${n.label} → ${n.target}${tid}${hop}: ${String(n.text || '').replace(/\n/g, '\n  ')}`;
    }
    case 'file_start':
      return `${n.label} → ${n.target} (file incoming) name=${n.name} size=${n.size}B thread=${n.threadId}`;
    case 'file_end':
      return `${n.label} → ${n.target} (file received) ${n.name} saved to ${n.path}`;
    case 'system':
      return n.text;
    default:
      return `[hhw] ${JSON.stringify(n)}`;
  }
}

async function main() {
  const session = readJsonOrNull(SESSION_PATH);
  // If no session (hhw not started), stay silent — the hook just outputs nothing.
  if (!session || !pidAlive(session.pid)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  let rows;
  try {
    rows = drainJsonl(PENDING_NOTIFS);
  } catch (e) {
    process.stderr.write(`[hhw hook-pre-prompt] ${e.message}\n`);
    process.stdout.write(JSON.stringify({}));
    return;
  }
  if (!rows.length) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const header = `[hhw inbox-stream] ${rows.length} event(s) since last turn (user=${session.name}, mode=${session.mode}):`;
  const lines = rows.map(formatLine);
  const additionalContext = [header, ...lines].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
}

main().catch((e) => {
  process.stderr.write(`[hhw hook-pre-prompt] ${e.message}\n`);
  process.stdout.write(JSON.stringify({}));
});
