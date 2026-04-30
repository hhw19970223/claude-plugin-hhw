---
description: List the inbox (queue of @mentions awaiting approval while in manual mode).
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/inbox.js"`

Approve and execute a thread with `/nexscope:accept <threadId> [extra]`, or reject (and send back a refusal) with `/nexscope:reject <threadId> [reason]`.
