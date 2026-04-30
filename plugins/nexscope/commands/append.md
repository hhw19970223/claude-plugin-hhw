---
description: Append a role=user message to an existing thread (spoken by the human, not Claude).
argument-hint: <threadId> <text>
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/append.js" $ARGUMENTS`
