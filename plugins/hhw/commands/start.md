---
description: 加入 hhw 聊天室。用法:/hhw:start -n <name> [--mode=manual|auto]
argument-hint: -n <name> [--mode=manual|auto]
allowed-tools: [Bash]
---

执行以下命令加入 hhw 聊天室,参数: `$ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" $ARGUMENTS`

加入成功后,接收到的消息会在你下一次 prompt 前通过 UserPromptSubmit hook 注入到上下文。
如果加入失败(例如用户名冲突、token 错误),上面命令会以非零退出码终止,请按提示处理。
