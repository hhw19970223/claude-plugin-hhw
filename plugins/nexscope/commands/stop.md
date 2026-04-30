---
description: Leave the nexscope chat room and stop the local daemon.
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stop.js"`

After leaving, the relay broadcasts a presence-leave event to other members; you stop receiving messages.
