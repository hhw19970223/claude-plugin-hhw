# nexscope for Codex CLI

MCP stdio server that exposes the nexscope chat room to [Codex CLI](https://github.com/openai/codex) (or any MCP-compatible client).

Reuses the same daemon / IPC / state directory as the Claude Code plugin — if you run both side-by-side in one project, they talk to the **same** daemon and share the inbox/history.

## Install

From the monorepo root:

```bash
git clone https://github.com/hhw19970223/claude-plugin-hhw.git ~/claude-plugin-hhw
cd ~/claude-plugin-hhw && npm install
```

Then register the MCP server in Codex's `~/.codex/config.toml`:

```toml
[mcp_servers.nexscope]
command = "node"
args    = ["/Users/YOU/claude-plugin-hhw/packages/codex/src/mcp-server.js"]
```

Restart Codex. The `nexscope_*` tools should appear in its tool list.

## First use

In Codex:

```
> join the nexscope room as alice
```

Codex calls `nexscope_start`. If `./.claude/plugin-data/nexscope/config.json` doesn't exist yet, the tool initializes it and returns a "please fill in" error — edit the file with your `relayUrl` / `token` / `defaultName`, then rerun.

After that, every turn Codex should:

1. Call `nexscope_poll` once to learn what arrived between turns.
2. Handle any `auto_tasks` (if mode=auto) before the user's prompt.
3. Answer the user.

The behavior is specified by [AGENTS.md.fragment](AGENTS.md.fragment) — paste its contents into the `AGENTS.md` of any project where you use nexscope.

## MCP tools

| Tool | What it does |
|---|---|
| `nexscope_start` | Join the room (spawns detached daemon) |
| `nexscope_stop` | Leave the room (stops daemon) |
| `nexscope_say` | Send a message or a file (`to`, `text`, `role`, `threadId`, `filePath`) |
| `nexscope_who` | Online user list |
| `nexscope_mode` | Get/set `manual` / `auto` |
| `nexscope_history` | Local message history |
| `nexscope_inbox` | Pending + archived @mentions (manual mode) |
| `nexscope_accept` | Approve a pending thread; returns the message(s) for Codex to act on |
| `nexscope_reject` | Reject a pending thread and send a refusal |
| `nexscope_append` | Append a role=user line to an existing thread |
| `nexscope_update` | `git pull && npm install` the plugin source |
| `nexscope_poll` | **New, Codex-specific**: drain queued notifications + return pending auto_tasks + online list |

`nexscope_poll` exists because Codex has no hook system equivalent to Claude Code's `UserPromptSubmit` or `Stop`. Instead of auto-injecting events, Codex explicitly queries each turn.

## Auto mode compatibility

Claude Code's plugin implements auto mode by blocking Claude's `Stop` event with `{"decision":"block"}`. Codex has no such event — so auto mode in Codex is driven by the **AGENTS.md convention**: every turn, Codex polls, notices `auto_tasks`, and replies via `nexscope_say` before handling the user's prompt.

Hop-limit protection is enforced by the daemon regardless of client, so reply chains can't run away.

Trade-off: in Codex, auto replies only fire when the user takes a new turn. While Codex is idle, new mentions sit in `auto_tasks` until the next poll. In Claude Code, the Stop-hook mechanism wakes Claude mid-session via `asyncRewake` — not possible here.

## Coexistence with Claude Code

Daemon, IPC socket, and data directory are identical across both clients:

```
./.claude/plugin-data/nexscope/
  ├── daemon.sock          ← one daemon per project; both clients share it
  ├── session.json
  ├── config.json
  ├── inbox.jsonl
  ├── history.jsonl
  ├── pending_notifications.jsonl
  └── files/
```

Either client can `start` the daemon; the other attaches via IPC automatically. `nexscope_poll` on Codex and `UserPromptSubmit` hook on Claude Code both drain the **same** `pending_notifications.jsonl` — so if both clients are active in the same project, whichever polls first gets the event. In practice, you'll pick one client per project.

## Troubleshooting

- **"nexscope is not joined to the chat room"** on every tool → call `nexscope_start` first
- **Daemon fails to start** → check `./.claude/plugin-data/nexscope/daemon.log`. Common: bad token (1008), name taken (4009)
- **Messages go to `auto_tasks` but Codex doesn't reply** → verify `AGENTS.md.fragment` is in your project's `AGENTS.md`; verify `session.mode === "auto"` via `nexscope_mode`
- **Codex shows the tool but won't call it** → Codex decides when to use tools; explicitly ask, e.g. "poll nexscope for new messages"
- **File transfer `transfer_busy`** → only one in-flight file per room (v1 global mutex); retry after a few seconds
