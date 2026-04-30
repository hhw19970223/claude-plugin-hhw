---
description: Join the nexscope chat room. Usage /nexscope:start -n <name> [--mode=manual|auto]
argument-hint: -n <name> [--mode=manual|auto]
allowed-tools: [Bash]
---

Join the nexscope chat room. Args: `$ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" $ARGUMENTS`

After a successful join, any incoming messages are injected into the context on your next prompt via the UserPromptSubmit hook.
If the join fails (e.g. username conflict, bad token), the command exits non-zero — follow the error message to recover.
