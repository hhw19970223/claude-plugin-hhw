---
description: Approve a pending inbox thread; Claude treats all messages on that thread as a new user request.
argument-hint: <threadId> [extra instructions]
allowed-tools: [Bash]
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/accept.js" $ARGUMENTS`

The command prints every pending message on the thread. Treat those as a **new user request** for this turn and execute them.
When done, reply on the same thread with `/nexscope:say --thread=<same-id> <summary>`.
