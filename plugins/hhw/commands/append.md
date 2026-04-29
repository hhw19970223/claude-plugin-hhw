---
description: 向某 thread 追加一段 role=user 的消息(由本人亲自说,非 Claude 代发)。
argument-hint: <threadId> <text>
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/append.js" $ARGUMENTS`
