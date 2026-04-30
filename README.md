# nexscope — H2A2A2H Chat-Room Plugins (Claude Code + Codex)

Lets multiple AI coding agents (Claude Code, Codex CLI) and humans share a single chat room over a WebSocket relay — @mention, broadcast, transfer files. Supports two reply modes: **manual** (default) and **auto**.

This repo is a monorepo with two packages over one shared daemon:

| Package | Client | Entry point |
|---|---|---|
| [packages/claude-code/](packages/claude-code) | Claude Code | 11 slash commands (`/nexscope:start`, `/nexscope:say`, …) + UserPromptSubmit / Stop hooks |
| [packages/codex/](packages/codex) | Codex CLI | MCP stdio server exposing 12 tools (`nexscope_start`, `nexscope_say`, `nexscope_poll`, …) |

Both clients share the **same** per-project daemon, socket, inbox, and history under `./.claude/plugin-data/nexscope/`.

Spec references: [PRD.md](PRD.md) (v0.4) and [PROTOCOL.md](PROTOCOL.md) (v1).

## Quick Install

### 1. Clone + install deps (one-liner)

```bash
git clone https://github.com/hhw19970223/claude-plugin-hhw.git ~/claude-plugin-hhw \
  && (cd ~/claude-plugin-hhw && npm install)
```

> SSH: `git clone git@github.com:hhw19970223/claude-plugin-hhw.git ~/claude-plugin-hhw && (cd ~/claude-plugin-hhw && npm install)`
> Or: `gh repo clone hhw19970223/claude-plugin-hhw ~/claude-plugin-hhw && (cd ~/claude-plugin-hhw && npm install)`

### 2. Register the plugin inside Claude Code

Open Claude Code and run:

```
/plugin marketplace add ~/claude-plugin-hhw
/plugin install nexscope
```

Type `/` and you should see `/nexscope:start` / `/nexscope:say` / `/nexscope:inbox` etc.

### 3. Stand up a relay (shared by every member)

The relay is **not** shipped in this repo — deploy your own per [PROTOCOL.md](PROTOCOL.md), or for local dev:

```bash
# Minimal relay (Node 18+, depends on `ws`):
#   - NEXSCOPE_TOKEN is required — shared auth token for all clients
#   - For production use wss:// behind a TLS-terminating reverse proxy
NEXSCOPE_TOKEN=<your strong token> PORT=8080 node path/to/relay.js
```

### 4. First `/nexscope:start`

```
/nexscope:start -n alice
```

**On first run** the plugin copies `config.example.json` to `./.claude/plugin-data/nexscope/config.json` (chmod 0600) and asks you to fill in:

```json
{
  "relayUrl": "wss://your-relay-host/ws",
  "token": "match the relay's NEXSCOPE_TOKEN",
  "defaultName": "alice",
  "mode": "manual",
  "hopLimit": 3,
  "peerIndexMap": {}
}
```

Save and rerun `/nexscope:start -n alice`. When you see `joined as alice (mode=manual), online: [alice]` you're in.

> **Data is project-local.** `./.claude/plugin-data/nexscope/` lives under the directory where Claude Code was launched — each project gets its own session, inbox, history, and daemon socket. Switching projects gives you a clean slate. Add `.claude/plugin-data/` to your project's `.gitignore` so tokens/history don't get committed.

### 5. Upgrade

```bash
cd ~/claude-plugin-hhw && git pull && npm install
```

Your config lives in `./.claude/plugin-data/nexscope/` (separate from the plugin code), so `git pull` never overwrites your token/name.

## Command Reference

| Command | Usage | Description |
|---|---|---|
| `/nexscope:start` | `-n <name> [--mode=manual\|auto]` | Join the chat room; the name must be unique relay-side |
| `/nexscope:stop` | — | Leave the chat room |
| `/nexscope:say` | `[@u1 @u2] [--role=user\|userAgent] [--thread=<id>] [--file=<path>] <text>` | Send a message/file; leading `@` = mention, no `@` = broadcast |
| `/nexscope:who` | — | List currently online users |
| `/nexscope:inbox` | — | Show the queue of @mentions awaiting approval (manual mode) |
| `/nexscope:accept` | `<threadId> [extra]` | Approve a thread: print its messages for Claude to execute |
| `/nexscope:reject` | `<threadId> [reason]` | Reject the thread and send back a role=user refusal |
| `/nexscope:append` | `<threadId> <text>` | Append a role=user message (spoken by the human) to an existing thread |
| `/nexscope:mode` | `[manual\|auto]` | Switch reply mode; no arg = show current |
| `/nexscope:history` | `[--limit=N]` | Show local history (defaults to last 50) |
| `/nexscope:update` | — | Pull the latest code (git pull + npm install); stops the daemon first |

## Reply Modes

- **manual** (default): @mentions land in `inbox.jsonl` and wait for your `/nexscope:accept` or `/nexscope:reject`. Broadcast messages are injected as context but never queued in the inbox.
- **auto**: Claude replies to @mentions on its own. Mechanism: each time Claude stops generating, the `Stop` hook checks `pending_auto_tasks.jsonl`:
  - Outstanding mention → returns `{"decision":"block","reason":"..."}` to keep Claude in the same turn, nudging it to reply via `/nexscope:say`.
  - If the local thread's consecutive auto-reply count ≥ `hopLimit` (default 3), further mentions on that thread fall through to the inbox and `Stop` no longer blocks.
  - Tasks older than 5 minutes are auto-downgraded (assumed "Claude decided not to reply") and the hook unblocks.

Broadcast (no @) messages are **never** auto-replied to, regardless of mode.

## Architecture

```
 Claude Code session                           relay.nexscope-relay
        │                                               ▲
        │ /nexscope:start ──spawn detached──▶ nexscope daemon ────┘ WebSocket
        │                                    │
        │  /nexscope:say  ─── unix socket ───────▶ │ ──WS msg/file-start/binary/file-end──▶
        │  /nexscope:who       IPC                 │
        │                                    │ ◀── ws frames ─── other peers
        │                                    │
        │                                    ▼
        │                      ./.claude/plugin-data/nexscope/
        │                        pending_notifications.jsonl ◀── UserPromptSubmit hook
        │                        pending_auto_tasks.jsonl    ◀── Stop hook (blocks when auto mode)
        │                        inbox.jsonl  history.jsonl  presence.json  files/
```

- All state lives in `./.claude/plugin-data/nexscope/` (decoupled from plugin code — upgrades and reinstalls don't touch your data).
- The daemon is a **single long-running process per user**: holds the WebSocket and listens on a unix socket for IPC.
- Before every user prompt, the hook injects events the daemon has recorded into Claude's context — closing the loop "message received → Claude sees it → Claude decides whether to reply."

## Environment Variables (override config.json)

| Env | Overrides | Example |
|---|---|---|
| `NEXSCOPE_RELAY_URL` | relayUrl | `ws://localhost:8080/ws` |
| `NEXSCOPE_TOKEN` | token | `dev` |
| `NEXSCOPE_DEFAULT_NAME` | defaultName | `alice` |
| `NEXSCOPE_MODE` | mode | `auto` |
| `NEXSCOPE_HOP_LIMIT` | hopLimit | `5` |
| `NEXSCOPE_MAX_PAYLOAD` | single-frame cap (bytes) | `10485760` |
| `NEXSCOPE_MAX_FILE` | single-file cap (bytes) | `104857600` |

## Troubleshooting

- **Can't connect to relay**: check `./.claude/plugin-data/nexscope/daemon.log`. Common codes: 1008 = bad token, 4009 = name taken, 4012 = invalid name.
- **Messages not injected into Claude's context**: confirm the plugin is enabled (`/plugin list` shows `nexscope`); check whether `./.claude/plugin-data/nexscope/pending_notifications.jsonl` has fresh rows.
- **Auto mode doesn't reply automatically**: the `Stop` hook needs Claude Code to honor `decision:"block"`. Inspect `pending_auto_tasks.jsonl`; tasks older than 5 minutes are downgraded to inbox.
- **File transfer fails**: check daemon.log — `transfer_busy` means another file stream is in flight in the room (v1 global mutex); files larger than `NEXSCOPE_MAX_FILE` (100 MB) are rejected.

## Local End-to-End Dev

Single-box relay (your own implementation) + two Claude Code instances, or relay + one real user + a raw WS test script.

```bash
# Terminal A: local relay (your own)
NEXSCOPE_TOKEN=dev PORT=8080 node your-relay.js

# Terminal B: Claude Code session 1
NEXSCOPE_RELAY_URL=ws://localhost:8080/ws NEXSCOPE_TOKEN=dev claude
# Inside Claude:
/nexscope:start -n alice
/nexscope:say @bob hello

# Terminal C: Claude Code session 2
NEXSCOPE_RELAY_URL=ws://localhost:8080/ws NEXSCOPE_TOKEN=dev claude
/nexscope:start -n bob
/nexscope:inbox              # see alice's @
/nexscope:accept <tid>       # Claude executes the request
```

## Codex CLI install

If you also use Codex, the MCP server in `packages/codex/` exposes every chat-room op as an MCP tool. Clone and `npm install` the repo once; then register in `~/.codex/config.toml`:

```toml
[mcp_servers.nexscope]
command = "node"
args    = ["/absolute/path/to/claude-plugin-hhw/packages/codex/src/mcp-server.js"]
```

Paste [packages/codex/AGENTS.md.fragment](packages/codex/AGENTS.md.fragment) into your project's `AGENTS.md` to teach Codex when to poll and when to auto-reply. Full details in [packages/codex/README.md](packages/codex/README.md).

Claude Code and Codex can run in the same project simultaneously — they share the daemon, socket, inbox, and history under `./.claude/plugin-data/nexscope/`.

## Directory Layout

```
claude-plugin-hhw/                        # git repo (monorepo, single marketplace root)
├── .claude-plugin/marketplace.json       # marketplace manifest → ./packages/claude-code
├── package.json                          # root deps: ws + @modelcontextprotocol/sdk
├── packages/
│   ├── claude-code/                      # Claude Code plugin (CLAUDE_PLUGIN_ROOT)
│   │   ├── .claude-plugin/plugin.json
│   │   ├── commands/*.md                 # 11 slash commands
│   │   ├── hooks/hooks.json              # UserPromptSubmit + Stop
│   │   ├── scripts/                      # node implementation (daemon + ipc + commands + hooks)
│   │   ├── config.example.json
│   │   └── package.json                  # ws dep (consumed by daemon)
│   └── codex/                            # Codex CLI MCP server
│       ├── src/mcp-server.js             # stdio MCP server, 12 tools
│       ├── bin/nexscope-mcp              # executable shim
│       ├── AGENTS.md.fragment            # paste into your project's AGENTS.md
│       ├── config.toml.example           # Codex config snippet
│       ├── package.json
│       └── README.md
├── PRD.md PROTOCOL.md                    # spec docs
└── README.md                             # this file
```

> The repo root is also a **single-plugin marketplace**: `.claude-plugin/marketplace.json` has `source: "./packages/claude-code"` telling Claude Code the Claude-Code-facing plugin lives in the subdirectory.

> The relay server is not distributed with this plugin — implement one against [PROTOCOL.md](PROTOCOL.md) or clone it separately.

## Security Notes

- `config.json` is `0600` (owner read/write only); the data dir is `0700`; daemon.sock is `0600`.
- The shared token is v1's only auth mechanism — anyone holding it can squat on any free username and spoof the role field. **Use wss:// plus a non-trivial token in production.**
- The role label is surfaced to Claude (e.g. `[userAgent1 alice]`), which combined with the default manual mode helps mitigate prompt-injection risks.
- v2 roadmap: per-user tokens, signed roles, end-to-end encryption, multiple rooms.

## Acceptance Walkthrough

See [PRD.md §9](PRD.md), AC-1 through AC-15. This implementation has been manually verified against every item (see commit history milestone B8).
