---
description: 拒绝 inbox 里某 threadId 的请求,并向原发送方回发一条 role=user 的拒绝消息。
argument-hint: <threadId> [reason]
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/reject.js" $ARGUMENTS`
