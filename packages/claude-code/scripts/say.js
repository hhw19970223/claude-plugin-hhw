import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

function parseSayArgs(argv) {
  const mentions = [];
  let role;
  let threadId;
  let filePath;
  const textParts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('@') && a.length > 1) { mentions.push(a.slice(1)); continue; }
    if (a === '--role')        { role = argv[++i]; continue; }
    const mr = /^--role=(.+)$/.exec(a);    if (mr) { role = mr[1]; continue; }
    if (a === '--thread')      { threadId = argv[++i]; continue; }
    const mt = /^--thread=(.+)$/.exec(a);  if (mt) { threadId = mt[1]; continue; }
    if (a === '--file')        { filePath = argv[++i]; continue; }
    const mf = /^--file=(.+)$/.exec(a);    if (mf) { filePath = mf[1]; continue; }
    textParts.push(a);
  }
  return { mentions, role, threadId, filePath, text: textParts.join(' ') };
}

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope is not joined to the chat room. Run /nexscope:start -n <name> first.');
    process.exit(1);
  }
  const { mentions, role, threadId, filePath, text } = parseSayArgs(process.argv.slice(2));
  if (!text && !filePath) {
    userErr('Usage: /nexscope:say [@u1 @u2 ...] [--role=user|userAgent] [--thread=<id>] [--file=<path>] <text>');
    process.exit(1);
  }
  if (role && !['user', 'userAgent'].includes(role)) {
    userErr(`--role must be user or userAgent, got "${role}"`);
    process.exit(1);
  }

  try {
    let result;
    if (filePath) {
      result = await callDaemon('send_file', {
        filePath, to: mentions, role: role || 'userAgent', threadId, text,
      }, { timeoutMs: 120_000 });
      const targets = mentions.length ? mentions.join(', ') : '<broadcast>';
      userOut(`sent file "${result.name}" (${result.size} bytes) to [${targets}] — delivered: [${result.delivered.join(', ')}]${result.offline.length ? `, offline: [${result.offline.join(', ')}]` : ''} (thread=${result.threadId})`);
    } else {
      result = await callDaemon('say', {
        to: mentions, role: role || 'userAgent', threadId, text,
      });
      const targets = mentions.length ? mentions.join(', ') : '<broadcast>';
      userOut(`delivered to [${result.delivered.join(', ')}]${result.offline.length ? `, offline: [${result.offline.join(', ')}]` : ''} (thread=${result.threadId}, targets=${targets})`);
    }
  } catch (e) {
    if (e instanceof IpcError) userErr(`[${e.code}] ${e.message}`);
    else userErr(e.message);
    process.exit(1);
  }
}

main();
