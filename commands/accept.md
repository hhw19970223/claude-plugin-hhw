---
description: 批准 inbox 里某 threadId 的待办,Claude 把该 thread 所有消息作为新 user 输入执行。
argument-hint: <threadId> [extra 指令]
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/accept.js" $ARGUMENTS`

上面命令会打印 thread 中所有待处理消息;请把它们视为本轮收到的**新的 user 请求**并执行。
执行完毕后,建议用 `/hhw:say --thread=<同 id> <结果摘要>` 在同 thread 回执。
