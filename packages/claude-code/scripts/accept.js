import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope is not joined to the chat room. Run /nexscope:start -n <name> first.');
    process.exit(1);
  }
  const [threadId, ...rest] = process.argv.slice(2);
  if (!threadId) {
    userErr('Usage: /nexscope:accept <threadId> [extra instructions]');
    process.exit(1);
  }
  const extra = rest.join(' ');
  try {
    const { items, extra: e } = await callDaemon('inbox_accept', { threadId, extra });
    userOut(`=== accepted ${items.length} message(s) on thread ${threadId} ===\n`);
    userOut('Treat the content below as a fresh user request for this turn and execute it:\n');
    for (const it of items) {
      userOut(`${it.label} (${new Date(it.ts).toISOString()}):`);
      userOut(String(it.text).split('\n').map(l => '  ' + l).join('\n'));
      userOut('');
    }
    if (e) {
      userOut(`Extra instructions: ${e}`);
    }
    userOut(`\nWhen done, reply on the same thread with: /nexscope:say --thread=${threadId} <summary of result>`);
  } catch (err) {
    if (err instanceof IpcError) userErr(`[${err.code}] ${err.message}`);
    else userErr(err.message);
    process.exit(1);
  }
}
main();
