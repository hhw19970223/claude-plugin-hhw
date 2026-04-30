---
description: 在聊天室发消息。@mention 定向,无 @ 为广播。
argument-hint: [@u1 @u2 ...] [--role=user|userAgent] [--thread=<id>] [--file=<path>] <text>
allowed-tools: [Bash]
---

以 Claude 代理身份(role=userAgent)向聊天室发送消息,参数: `$ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/say.js" $ARGUMENTS`

参数说明:
- 行首 `@name` 会被解析为定向 mention;多个 @ 代表多播;无 @ 即广播
- `--role=user` 若用户希望以"本人身份"(而非 Claude 代发)说话
- `--thread=<id>` 追加到现有话题,否则服务端自动生成新 threadId
- `--file=<path>` 发送文件(二进制流式,自动通过同 thread 的 file-start/binary/file-end)
