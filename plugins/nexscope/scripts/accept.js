import { callDaemon, daemonRunning, IpcError } from './ipc-client.js';
import { userErr, userOut } from './log.js';

async function main() {
  if (!daemonRunning()) {
    userErr('nexscope 未加入聊天室。请先 /nexscope:start -n <name>。');
    process.exit(1);
  }
  const [threadId, ...rest] = process.argv.slice(2);
  if (!threadId) {
    userErr('用法: /nexscope:accept <threadId> [extra instructions]');
    process.exit(1);
  }
  const extra = rest.join(' ');
  try {
    const { items, extra: e } = await callDaemon('inbox_accept', { threadId, extra });
    userOut(`=== accepted ${items.length} message(s) on thread ${threadId} ===\n`);
    userOut('请把以下内容视为本轮新的 user 输入执行:\n');
    for (const it of items) {
      userOut(`${it.label} (${new Date(it.ts).toISOString()}):`);
      userOut(String(it.text).split('\n').map(l => '  ' + l).join('\n'));
      userOut('');
    }
    if (e) {
      userOut(`附加指令: ${e}`);
    }
    userOut(`\n执行完毕后,建议用 /nexscope:say --thread=${threadId} <结果摘要> 回执到同一 thread。`);
  } catch (err) {
    if (err instanceof IpcError) userErr(`[${err.code}] ${err.message}`);
    else userErr(err.message);
    process.exit(1);
  }
}
main();
