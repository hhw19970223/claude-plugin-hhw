---
description: Reject the request on a thread and reply to the sender with a role=user refusal message.
argument-hint: <threadId> [reason]
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/reject.js" $ARGUMENTS`
