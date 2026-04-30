---
description: 更新 nexscope 插件(git pull + npm install),自动先关停 daemon。
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js"`

更新完毕后:
- 如果改到了 hooks/ 或 plugin.json,需要重启 Claude Code 才生效
- 用 `/nexscope:start -n <name>` 重新加入聊天室(daemon 已被关停以加载新代码)
