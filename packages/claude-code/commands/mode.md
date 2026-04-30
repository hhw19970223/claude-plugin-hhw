---
description: Switch this session's reply mode (manual/auto). No arg = show current.
argument-hint: [manual|auto]
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mode.js" $ARGUMENTS`

- **manual** (default): @mentions land in the inbox and require a human `/nexscope:accept` to act on.
- **auto**: Claude replies to @mentions on its own (with hop-limit protection); broadcasts never trigger auto-reply.
