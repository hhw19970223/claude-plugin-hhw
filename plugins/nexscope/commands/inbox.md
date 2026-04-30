---
description: 列出 inbox(manual 模式下收到的 @mention 待审批队列)。
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/inbox.js"`

之后用 `/nexscope:accept <threadId> [extra]` 批准并执行,或 `/nexscope:reject <threadId> [reason]` 拒绝并回发。
