---
description: Send a chat-room message. @mentions target specific users; no @ = broadcast.
argument-hint: [@u1 @u2 ...] [--role=user|userAgent] [--thread=<id>] [--file=<path>] <text>
allowed-tools: [Bash]
---

Send a message to the chat room as Claude's agent (role=userAgent). Args: `$ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/say.js" $ARGUMENTS`

Argument reference:
- Leading `@name` tokens become directed mentions; multiple @ = multicast; no @ = broadcast
- `--role=user` marks the message as spoken by the human, not Claude
- `--thread=<id>` appends to an existing thread; otherwise the daemon generates a new threadId
- `--file=<path>` streams a file as binary chunks on the same thread (file-start / binary / file-end)
