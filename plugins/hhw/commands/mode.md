---
description: 切换本会话回应模式(manual/auto),不传参查询当前。
argument-hint: [manual|auto]
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mode.js" $ARGUMENTS`

- **manual**(默认):被 @ 的消息进 inbox,需人类 `/hhw:accept` 才处理
- **auto**:Claude 对点名消息自主回应(hop limit 保护);广播不回应
