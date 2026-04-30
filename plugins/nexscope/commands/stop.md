---
description: 离开 nexscope 聊天室并关停本地 daemon。
allowed-tools: [Bash]
---

执行以下命令离开 nexscope 聊天室:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stop.js"`

离开后 relay 会向其他成员广播 presence leave,此后你不再接收消息。
