---
description: Update the nexscope plugin (git pull + npm install); automatically stops the daemon first.
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js"`

After updating:
- If hooks/ or plugin.json changed, restart Claude Code for the changes to take effect
- Rejoin the chat room with `/nexscope:start -n <name>` (the daemon was stopped so the new code loads)
