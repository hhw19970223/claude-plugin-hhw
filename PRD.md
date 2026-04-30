# PRD: nexscope — Claude Code Chat-Room Plugin (H2A2A2H Collaboration Pipe)

> Version: v0.4 (draft)
> Date: 2026-04-28
> Changelog:
> - v0.1 → v0.2: peer-to-peer chat → cross-agent task delegation; introduce role and Gate
> - v0.2 → v0.3: **point-to-point routing → single chat room + @mention**; introduce explicit start/stop lifecycle, username uniqueness, presence broadcast; allow Claude to **reply autonomously** (add auto/manual modes)
> - v0.3 → v0.3.1: **connection info (relay URL, token, etc.) moves to a plugin config file**; env is demoted to an optional override
> - v0.3.1 → v0.4:
>   - **File transfer brought into v1** as a streamed WebSocket binary frame feature
>   - **Every message must carry `from` + `to`**, otherwise the server drops it (including a `from == authenticated username` consistency check)
>   - **Presence switches to "broadcast full online list on every change"** (instead of incremental join/leave events); the client treats each `users` array as the single source of truth
>   - Protocol details finalized; spun out [`PROTOCOL.md`](PROTOCOL.md) as the wire-level contract between server and plugin

---

## 1. Background & Goals

### 1.1 Background

Users want every participating Claude Code instance to **share one chat room** — visible to each other and @-mentionable, like IRC/Slack channels. A sender may target the message at a specific member's Claude (via `@username`) or broadcast it to everyone. When the recipient's Claude is @-mentioned, it **may reply on its own**, forming a "multi-agent collaboration dialog" over the H2A2A2H link — the human stays the final authority, but is no longer a mandatory gate on every message.

Core topology:

```
 ┌──────────┐           ┌─────────────────────────────────┐           ┌──────────┐
 │  Human A │──(start)─▶│      Relay (single chat room)    │◀─(start)──│  Human B │
 │  (alice) │           │  • maintains online user table    │           │  (bob)   │
 └────┬─────┘           │    (unique username)              │           └─────┬────┘
      │                 │  • broadcasts presence            │                 │
      ▼                 │  • @mention → directed / no @ →   │                 ▼
 ┌──────────┐           │    broadcast                      │           ┌──────────┐
 │ Agent A  │───────────└─────────────────────────────────┘─────────────│ Agent B  │
 │(A's Claude)                                                          │(B's Claude)
 └──────────┘                                                           └──────────┘
```

### 1.2 Goals

- **P0** Every participant joins the **same chat room**, distinguished by a unique username.
- **P0** The plugin joins explicitly via `/nexscope:start -n <name>` and leaves via `/nexscope:stop` (**no auto-persistence**).
- **P0** Username conflict → connection fails with a clear client-side error.
- **P0** On a new connection, the relay pushes the current online snapshot; subsequent joins/leaves broadcast a presence event.
- **P0** Messages are directed via `@username` (multi-@ allowed); no @ = broadcast the whole room.
- **P0** Messages carry a `role` field (`user` / `userAgent`); the recipient Claude can branch on source semantics.
- **P0** Two reply modes:
  - **Manual** (default): @mentions land in the inbox; the human approves before the Claude executes.
  - **Auto**: Claude replies to @mentions autonomously (broadcast messages still trigger no auto-reply, to avoid noise).
- **P0** Both the plugin and the relay can be self-hosted.
- **P1** Offline state, reconnect, thread ordering, message dedupe.
- **P2** Offline message queueing, end-to-end encryption, role signing, multi-room, cross-room federation.

### 1.3 Non-Goals

- No UI (Claude Code has no webview).
- No file/rich-media support (v1 is text-only).
- No server-side message persistence (v1 only maintains "online users + live forwarding").
- No "unbounded auto chat" under auto mode — there must be a hop limit; the user can interrupt at any time.

---

## 2. Users & Scenarios

### 2.1 Roles

| Role | Description |
|---|---|
| **Human (room member)** | A real person, joining via `/nexscope:start` and leaving via `/nexscope:stop` |
| **Agent** (this human's Claude) | Speaks on behalf of the human, reads messages, may reply autonomously |
| **Operator** | Deploys and maintains the relay (chat-room service) |

### 2.2 Scenarios

**S1 — Mention delegation (core)**
Alice says in the room: `@bob please have your Claude refactor auth.ts; write tests first` (role=user). In Bob's Claude session, `[user1 alice → @me] ...` appears. In manual mode Bob approves and then executes; in auto mode Bob's Claude may clarify first ("should I keep the old API?"), and Alice's Claude replies on Alice's side (role=userAgent), forming an H2A2A2H multi-turn dialogue.

**S2 — A asks their Claude to send on their behalf**
Alice says "let my Claude summarize the current PR and send it to bob"; A's Claude generates a draft (role=userAgent); Alice then `/nexscope:append`s a line of her own (role=user); both go to `@bob`.

**S3 — Group broadcast**
Alice sends `prepping release this afternoon, please freeze` (no @, broadcast). Every online member's Claude receives it; because no one was @'d, no one auto-replies — it's just shown to each human.

**S4 — Presence awareness**
Carol runs `/nexscope:start -n carol` to join; Alice and Bob's Claude each see `[presence] carol joined`; Alice can immediately `@carol hi`. When Carol runs `/nexscope:stop`, each client's Claude sees `[presence] carol left`.

**S5 — Username conflict**
Bob is online at home with `-n bob`. Company-Bob's machine also tries `-n bob` → rejected; the skill reports "username taken, pick a different name or have the other end stop first."

---

## 3. Glossary

| Term | Meaning |
|---|---|
| **Room** | The single chat room hosted by the relay. v1 = globally one room. |
| **Username** | Room-unique identifier (e.g. `alice`, `bob`, `carol`). |
| **Session** | One connection lifetime between `start` and `stop`. |
| **Presence** | An event describing the change in the online user set (snapshot / join / leave). |
| **@mention** | A delivery target expressed either in the message text or as an explicit field, formatted `@username`. |
| **Role** | Source semantics of a message, either `user` or `userAgent`. |
| **Role Label** | How a message is displayed on the receiving side, e.g. `[user1 alice]` / `[userAgent1 alice]`. The local human itself is always shown without the index suffix. |
| **Thread / ThreadId** | The id that ties together multiple messages of one topic. |
| **Inbox** | Queue of @mentions awaiting local-human approval (manual mode only). |
| **Mode** | `manual` (default, human-gated) or `auto` (Claude may reply to @mentions). |
| **Hop Limit** | In auto mode, the cap on consecutive agent-to-agent replies in one thread — prevents runaway loops. |

---

## 4. Scope

### 4.1 In Scope (v1)

| Module | Contents |
|---|---|
| **Plugin `nexscope`** | skills: `start` / `stop` / `say` / `who` / `inbox` / `accept` / `reject` / `append` / `mode` / `history`; background monitor (runs only during an active session) |
| **Relay `nexscope-relay`** | Node + ws; single room; maintains the username set; broadcasts presence; dispatches by @mention |
| **Auth** | One shared token, read from the plugin `config.json` (env may override) |
| **Config** | Plugin-root `config.json` + `config.example.json` (template with placeholder token) |
| **Username uniqueness** | Enforced by the server |
| **Role field** | Self-declared by clients; relay passes through |
| **Inbox (local file)** | Manual mode only |
| **Mode switch** | Per-session local state; env `NEXSCOPE_MODE` sets the default |
| **Hop Limit** | In auto mode, at most 3 consecutive local auto-replies per thread; past that, falls back to manual |

### 4.2 Out of Scope (v1)

- Multi-room; room create/list
- Server-side message persistence, history replay (v1 only delivers messages received while online)
- End-to-end encryption, role signing
- Direct messaging (DM via a separate channel) — v1 simulates this via `@username`
- Offline queueing
- **Concurrent file transfer** (v1 allows at most one in-flight file stream per room; see [PROTOCOL.md](PROTOCOL.md))
- Image/video preview, rich media rendering (files land as raw bytes in the receiver's local directory; user handles further)
- Auto-mode cross-thread autonomous dialogue

---

## 5. User Stories

### US-1 Explicit join / leave
**As** any member, **I want** to `/nexscope:start -n <name>` to enter the room and `/nexscope:stop` to leave, **so that** I control exactly when I receive messages.

### US-2 Username uniqueness
**As** a member, **I want** an immediate, clear failure if my name is taken (rather than connecting silently and behaving wrong), **so that** I can switch names or ask the other end to stop.

### US-3 Presence awareness
**As** a member, **I want** to know who is online when I connect and be notified as people come and go, **so that** I can @ the right peer.

### US-4 Directed messages
**As** Alice, **I want** to use `@bob` to target Bob, **so that** Bob's Claude knows the message is for it.

### US-5 Broadcast messages
**As** Alice, **I want** no-@ messages to reach every room member, **so that** I can post notices or chitchat.

### US-6 Role disambiguation
**As** Bob, **I want** my Claude to tell apart "Alice herself" from "Alice's Claude", **so that** response strategies can differ.

### US-7 Manual gating (default)
**As** Bob, **I want** incoming @mentions to queue in the inbox for my approval before they execute, **so that** I can mitigate prompt injection.

### US-8 Opt-in auto reply
**As** Bob, **I want** the option to flip to auto mode so my Claude can clarify/respond autonomously, **so that** multiple Claudes can truly "converse."

### US-9 Hop protection
**As** a member, **I want** auto replies not to loop forever, **so that** no one floods the room or burns API quota.

### US-10 Human append / override
**As** Alice, **I want** to `append` my own line after Claude drafts a message, **so that** responsibility boundaries stay clear.

### US-11 Self-hosting
**As** an operator, **I want** to deploy the relay with a single command, **so that** I don't depend on a SaaS.

---

## 6. Functional Requirements

### FR-1 Lifecycle: Start / Stop
- `/nexscope:start -n <username> [--room=<id>] [--mode=manual|auto]` or bin `nexscope-start -n <name>`
- Opens a WebSocket to the relay with token + username
- Server validation: username is globally unique; conflict → close code `4009`, client prints `username "<name>" taken`
- On success:
  - Writes a session file (with connection ids); only then does `monitor` attach
  - Prints `joined as <name>, online: [alice, bob]`
- `/nexscope:stop` or `nexscope-stop`:
  - Closes the WS, cleans up the session file
  - Relay broadcasts `presence leave`
  - If the Claude process exits before stop: the relay's heartbeat timeout (30s) marks the user offline and broadcasts a leave

**Design notes**: an explicit session lifecycle means the monitor can't run blindly at all times. Solution: on launch the monitor checks for the session file; if absent it idles in a low-CPU wait loop; `start` atomically writes the session → monitor picks it up and connects the WS; `stop` deletes the session → monitor closes the WS and returns to idle.

### FR-2 Presence (full-list broadcast)
- **Every time** a user joins or leaves the room, the relay broadcasts the full online list to **every** connection (including the freshly joined one):
  ```json
  {"type":"presence","users":["alice","bob","carol"],"ts":...}
  ```
- No more incremental `join`/`leave` events. The client treats each received `users` array as the **single source of truth** and computes deltas for display (`[presence] carol joined`).
- After a client reconnects, the first presence frame is sent immediately (natural sync; no separate snapshot command needed).

### FR-3 Send: `say` with @mention
- `/nexscope:say [@<u1> @<u2> ...] [--role=user|userAgent] [--thread=<id>] <text>`
- Mentions may also appear at the start of `<text>` (parsed as `@user`).
- No mention = broadcast.
- With mentions = deliver only to @-targeted online members (offline targets are skipped and reported in the offline list).
- Role defaults:
  - Invoked by an Agent via a skill → `userAgent`
  - Human runs the bin `nexscope-say` → `user`
  - Explicit `--role` overrides
- Returns an ack: `{delivered:["bob"], offline:["carol"]}` (for broadcast, `delivered` = every currently online member except the sender).

### FR-4 Receive & inject
- The monitor routes incoming frames by type:
  - `type=msg`: prints `[<roleLabel> <from> → <target>] (thread=<tid>) <text>`, where `target` is `@me` / `@all` / `@u1,u2`
  - `type=presence`: prints `[presence] <user> joined|left|snapshot:[...]`
  - `type=ack`: not printed; returned to the send caller
- **Manual mode** additionally records @mentions in the inbox file (broadcasts do not land there).
- Auto mode does not write the inbox, but still prints every message as a notification.

### FR-5 Inbox (manual mode)
- File: `./.claude/plugin-data/nexscope/inbox.jsonl`
- Entry: `{threadId, from, role, mentions, text, ts, status:"pending"}`
- Skills:
  - `/nexscope:inbox` — lists pending + recent archived items
  - `/nexscope:accept <threadId> [extra]` — marks `accepted`, treats every message in that thread as new user input for this turn (with optional extra instructions)
  - `/nexscope:reject <threadId> [reason]` — marks `rejected`, sends a role=user rejection message back to the sender(s) including the reason
- Pending items older than 24h are auto-marked `expired`.

### FR-6 Auto mode
- `/nexscope:mode auto|manual` switches the session mode; `env NEXSCOPE_MODE` sets the default.
- Rules for auto mode:
  1. Only autonomously replies to messages that @-mention the local user. Broadcasts are shown but never auto-replied.
  2. Before replying, Claude must decide whether a reply is "actually needed" (clarification / agreement / deliverable), to avoid empty replies.
  3. Replies reuse the same threadId with role=userAgent.
  4. Per thread, the local side's consecutive auto-reply count must be ≤ 3 (hop limit). Once exceeded, the thread falls back to manual and waits for the human.
  5. The human can Ctrl+C to interrupt the current auto-reply at any time, or run `/nexscope:mode manual` to exit auto immediately.

### FR-7 Human-direct / append
- `/nexscope:append <threadId> <text>` appends a role=user message (spoken by the local human) to a thread.
- Bin `nexscope-say --role=user ...` lets the human bypass Claude and speak directly.

### FR-8 Who
- `/nexscope:who` lists currently online users (read from the local cache maintained by presence).

### FR-9 History (local)
- `/nexscope:history [--limit=N]` lists the last N locally received messages (local in-memory/file only; does not query the relay).

### FR-10 Identity, auth & config sources
- **Connection info comes from the plugin config file** (not from env):
  - Path: `./.claude/plugin-data/nexscope/config.json` (decoupled from the plugin dir so plugin upgrades don't wipe user data)
  - On first launch, if the file is missing it is copied from the plugin's `config.example.json` with the message `Initialized ./.claude/plugin-data/nexscope/config.json, fill in relayUrl and token, then rerun.`
  - Fields: `relayUrl`, `token`, `defaultName` (optional), `mode` (default `manual`), `hopLimit` (default `3`), `peerIndexMap` (optional)
  - Missing required fields or any remaining `REPLACE_ME` placeholder → init fails with a clear error
  - File mode fixed at `0600` (owner-only read/write), enforced via `chmod` on boot; v1 does not use a keychain (plaintext + permissions is sufficient)
- **Env is override-only** (optional): `NEXSCOPE_RELAY_URL` / `NEXSCOPE_TOKEN` / `NEXSCOPE_DEFAULT_NAME` / `NEXSCOPE_MODE` / `NEXSCOPE_HOP_LIMIT`. When present, they take precedence over config.json.
- `config.example.json` ships with the plugin repo; every sensitive field is `REPLACE_ME` and no relay URL is pre-filled (there is no public relay — that would be misleading).

### FR-11 Relay routing
- The relay maintains `Map<username, {ws, alive, pendingFile?}>`.
- On connect it validates: token correct + username matches the regex (`^[a-zA-Z0-9_-]{1,32}$`) + username not taken.
- On conflict: emit `{type:"error",code:"name_taken",...}` first, then close with code `4009`.
- Every client → relay text frame must include valid `from` and `to` fields:
  - `from` missing or not a string → **drop** the frame (server logs `missing_from`, no ack)
  - `from !== authenticated username` → **drop** (logs `from_mismatch`, prevents forgery)
  - `to` missing or not an array → **drop** (logs `missing_to`)
  - None of these close the connection; after 10 illegal frames the connection is closed with code `4013`.
- Dispatch: non-empty `to` = targeted delivery to the listed users; `to == []` = broadcast to every other online member (sender does not receive their own broadcast).
- File streams: at most one in-flight file per room (relay-global mutex). If `file-end` isn't received within 60s the lock is force-released and recipients are notified. See PROTOCOL.md §file transfer.
- Heartbeat: 30s ping/pong. Two consecutive missed pongs → terminate the connection; after cleanup, presence is re-broadcast.
- **Nothing is persisted** — no messages, no file bytes. Only the online user table, in memory.

### FR-12 Reconnect
- Monitor side: after disconnect, exponential backoff (1→2→…→30s) reconnect.
- After reconnecting, `start` is not re-executed; the monitor rejoins using the last `start` parameters (keeps the username). If the username is now taken, an error is printed and the human must intervene.

### FR-13 Hop limit & loop prevention
- Every message frame carries `hopCount` (incremented by 1 at each Claude that auto-replies along the chain).
- The relay **does not modify** this field; the client maintains it.
- `hopCount ≥ 3` forces the local client into manual mode.
- Broadcasts are never auto-replied to, regardless of mode.

---

## 7. Non-Functional Requirements

### NFR-1 Latency
p50 end-to-end message latency < 500 ms (same region). Presence events < 300 ms.

### NFR-2 Security
- Transport: production must use WSS.
- Auth: one shared token. v1 accepts the premise that "anyone with the token can squat on any free username and forge the role" — prompt-injection exposure is mitigated by manual-default mode and prominent role labels.
- v2: per-user tokens, role signatures, pre-shared-key verification.

### NFR-3 Portability
Node ≥ 18; depends on `ws`.

### NFR-4 Observability
- Relay logs: connect / disconnect / forward / auth failure / username conflict — one line per event.
- Client errors go to stderr; notification stream goes to stdout.

### NFR-5 Max text size
4 KB. Oversized messages are rejected client-side.

### NFR-6 Room capacity
v1 single-process relay recommends ≤ 50 users; beyond that, sharding is needed (v2).

---

## 8. Interface & Protocol

### 8.1 WebSocket URL

```
wss://<relay-host>/ws?name=<username>&token=<shared-token>
```

### 8.2 Frame types (overview)

See [`PROTOCOL.md`](PROTOCOL.md) for the full wire-level spec. Highlights:

| Direction | type | Purpose |
|---|---|---|
| client → relay | `msg` | Send a text message (may carry attachments metadata) |
| client → relay | `file-start` | Begin a file stream (followed by binary frames + `file-end`) |
| client → relay (binary) | — | File chunk |
| client → relay | `file-end` | End a file stream |
| relay → client | `msg` / `file-start` / `file-end` | Pass-through (after `from` validation and `ts` injection) |
| relay → client (binary) | — | Pass-through file bytes |
| relay → client | `presence` | Full online list |
| relay → sender | `ack` | Delivery/offline receipt |
| relay → client | `error` | Error (name_taken / from_mismatch / transfer_busy / ...) |

**Required fields on every client → relay text frame**:

| Field | Required | Notes |
|---|---|---|
| `type` | yes | Frame type |
| `from` | yes | Sender username; must match the authenticated username (otherwise dropped) |
| `to` | yes | Receiver username array; `[]` = broadcast |
| `msgId` | yes | Unique message id (UUID v4 or ULID, etc.) |
| `role` | yes (msg/file-start) | `user` / `userAgent` |
| `threadId` | yes (msg/file-start) | Topic id |
| `text` | no | Message body; for files may just be a caption |
| `attachments` | no | Attachment metadata array |
| `hopCount` | no | Auto-mode chain counter; defaults to 0 |

**Presence frame** (v0.4 change):
```json
{"type":"presence","users":["alice","bob","carol"],"ts":1714000000000}
```
Broadcast to every connection whenever the room membership changes; clients diff locally.

### 8.3 Close codes

| Code | Meaning |
|---|---|
| 1008 | Auth failure (bad token) |
| 4009 | Username conflict |
| 4010 | Heartbeat timeout |
| 4011 | Message too large (exceeds maxPayload) |
| 4012 | Invalid username (fails `^[a-zA-Z0-9_-]{1,32}$`) |
| 4013 | Too many illegal frames (from mismatch / missing fields — 10 accumulated) |
| 4014 | File transfer timeout (no `file-end` within 60s of `file-start`) |

### 8.4 Roles

| role | Meaning | Receiver label |
|---|---|---|
| `user` | Human speaks directly | `[user<idx> <username>]` |
| `userAgent` | This user's Claude speaks on their behalf | `[userAgent<idx> <username>]` |

`<idx>` is allocated by the local Claude instance in first-contact order; the local user itself has no index suffix.

### 8.5 Skill list

```
/nexscope:start  -n <name> [--mode=manual|auto]   Join chat room
/nexscope:stop                                    Leave chat room
/nexscope:say    [@u1 @u2 ...] [--role=...] [--thread=...] <text>  Send a message
/nexscope:who                                     List online users
/nexscope:inbox                                   (manual) show pending mentions
/nexscope:accept <threadId> [extra]               (manual) approve & execute
/nexscope:reject <threadId> [reason]              (manual) reject & send refusal
/nexscope:append <threadId> <text>                Append a role=user message to a thread
/nexscope:mode   auto|manual                      Switch mode
/nexscope:history [--limit=N]                     Show local history
```

### 8.6 Plugin config file (primary)

**Path**: `./.claude/plugin-data/nexscope/config.json` (**not** under the plugin dir — keeps user data separate from plugin code so upgrades/reinstalls don't overwrite config)

**Schema**:
```json
{
  "relayUrl": "wss://REPLACE_ME/ws",
  "token": "REPLACE_ME",
  "defaultName": "nexscope",
  "mode": "manual",
  "hopLimit": 3,
  "peerIndexMap": {"alice": 1, "bob": 2}
}
```

| Field | Required | Notes |
|---|---|---|
| `relayUrl` | yes | Relay WebSocket URL; production must be `wss://` |
| `token` | yes | Shared auth token; sensitive — don't commit |
| `defaultName` | no | Used when `/nexscope:start` omits `-n`; users typically set this post-install |
| `mode` | no | Default session mode (`manual` / `auto`); defaults to `manual` |
| `hopLimit` | no | Hop ceiling for auto mode; defaults to `3` |
| `peerIndexMap` | no | Role-label index map; defaults to "allocate in first-contact order" |

**Distribution & init convention**:
- The repo ships `config.example.json` where every sensitive field is `REPLACE_ME` and **no relay URL is pre-filled** (there is no public relay — avoids misleading users).
- The user's real config lives at `./.claude/plugin-data/nexscope/config.json` (the plugin dir itself only holds the example, which is safe to commit).
- On plugin startup, if `./.claude/plugin-data/nexscope/config.json` is missing, it's copied from the plugin's `config.example.json` and chmodded to `0600`; the plugin then aborts boot and prompts the user to fill it in.
- Any required field still equal to `REPLACE_ME` triggers a "not configured" error pointing at that file path.

### 8.7 Environment variables (optional overrides)

Every field may be overridden by an env var, at a priority higher than config.json:

| Env | Overrides |
|---|---|
| `NEXSCOPE_RELAY_URL` | `relayUrl` |
| `NEXSCOPE_TOKEN` | `token` |
| `NEXSCOPE_DEFAULT_NAME` | `defaultName` |
| `NEXSCOPE_MODE` | `mode` |
| `NEXSCOPE_HOP_LIMIT` | `hopLimit` |

Use cases: temporary relay switching for debugging, multi-account testing, CI environments.

---

## 9. Acceptance Criteria

| # | Scenario | Expected |
|---|---|---|
| AC-1 | Alice `/nexscope:start -n alice`, Bob `/nexscope:start -n bob` | Both join; Alice's Claude sees `[presence] bob joined` (or snapshot) |
| AC-2 | Alice `/nexscope:start -n bob` (bob already online) | Connection fails with `username "bob" taken` |
| AC-3 | Alice `/nexscope:say @bob task...` (role=userAgent) | Bob's session shows `[userAgent1 alice → @me] ...`; Alice's ack has delivered=[bob] |
| AC-4 | Alice `/nexscope:say hello all` (no @) | Bob and every other online member sees `[userAgent1 alice → @all] hello all` |
| AC-5 | Manual mode: Alice @bob a task | Bob's message goes to the inbox; `/nexscope:inbox` shows it; after `/nexscope:accept`, Claude executes per instructions |
| AC-6 | Auto mode: Alice @bob a clarifying question | Bob's Claude auto-replies (role=userAgent), same threadId, hopCount=1 |
| AC-7 | Auto mode after 3 consecutive hops | Bob's client flips to manual; Claude no longer auto-replies |
| AC-8 | Auto mode, someone broadcasts | Everyone sees it, but no Claude auto-replies |
| AC-9 | Bob `/nexscope:stop` | Relay broadcasts leave; Alice's Claude sees `[presence] bob left`; Bob stops receiving messages |
| AC-10 | Bob restarts Claude Code without running stop | Heartbeat times out, relay broadcasts leave; after restart, `/nexscope:start` recovers |
| AC-11 | Relay restart | Clients reconnect; auto-rejoin with the last username; on conflict, prompt the human |
| AC-12 | Alice uses the bin: `nexscope-say --role=user @bob ...` | Bob sees `[user1 alice → @me] ...` (human role) |
| AC-13 | Alice's Claude drafts, then Alice `/nexscope:append`s | Two messages (userAgent + user) land at Bob in order, same threadId |
| AC-14 | Wrong auth token | Connection fails with a clear error |
| AC-15 | Message > 4 KB | Client rejects with a "split the message" hint |

---

## 10. Milestones

| Version | Contents |
|---|---|
| **v0.3 PRD** | This document (current) |
| **v1.0** | All of FR-1 ~ FR-13; NFRs met; AC-1 ~ AC-15 pass |
| **v1.1** | History replay (relay persists recent N messages); auto-mode policy refinements |
| **v2.0** | Multi-room, E2E, role signing, per-user tokens, offline queueing |
| **v3.0** | Cross-room federation, Bot API, file attachments (rich) |

---

## 11. Risks & Open Questions

| # | Risk / Question | Current disposition |
|---|---|---|
| R-1 | Prompt injection (userAgent messages luring Claude into bad actions) | Manual default + prominent role labels + auto limited to mentions |
| R-2 | Auto mode flooding / infinite loops | Hop limit = 3; no auto-reply to broadcasts; human may interrupt at any time |
| R-3 | Role forgery (client self-declares) | Known risk in v1; v2 adds signatures |
| R-4 | Username squatting (malicious holder refuses to release) | v1 relies on token-sharing trust; v2 per-user tokens |
| R-5 | Single-process relay | Acceptable in v1; v2 shards or sticky-routes |
| R-6 | Heartbeat timeout false-positives → presence flapping | 30s heartbeat + 5s grace re-check |
| R-7 | Monitor / start-stop coordination races | Atomic session-file write + monitor polling |
| R-8 | Messages dropped during reconnect | Acceptable loss in v1; v2 adds buffered delivery at the relay |
| **Q-1** | Where to deploy the relay? (fly.io / Render / VPS) | TBD |
| **Q-2** | Is 4 KB enough for a message? | TBD |
| **Q-3** | Auto-mode hop counting — "local consecutive" or "full chain"? | **Propose local-consecutive**; each Claude tracks its own count. TBD |
| **Q-4** | Should auto mode reply to "questions" but not "statements"? How to decide? | Propose: Claude decides in-prompt, with two hard rules (no auto-reply for broadcasts, no auto-reply past hop limit). TBD |
| **Q-5** | What happens to pending inbox items after `/nexscope:stop`? | Propose: keep them; still visible on next start. TBD |
| **Q-6** | v1 message history — store nothing, or keep last N at the relay for new joiners? | Propose: store nothing. TBD |
| **Q-7** | `@mention` semantics — private delivery (non-mentioned users can't see) or public mention (everyone sees but only @'d users act)? | Propose: private delivery (more private, less noise in v1); public mention deferred to v2. TBD |
| **Q-8** | In auto mode, does Claude read broadcasts or ignore them entirely? | Propose: read (as context), just don't send auto-replies. TBD |
| **Q-9** | If a person's Claude and the human are both in the room, are they one username or two? | Propose v1: one username, one connection; agent sends role=userAgent, human sends role=user, both under the same username. TBD |
| **Q-10** | After `/nexscope:accept`, should Claude publicly announce "done"? Or only send a final result message? | Propose: auto-post a brief summary as `userAgent` to the same thread after completion. TBD |

> **Decided (v0.3.1)**:
> - Config file path = `./.claude/plugin-data/nexscope/config.json` (decoupled from plugin dir)
> - `config.example.json` pre-fills no relay URL; every field is `REPLACE_ME`
> - Token storage = plaintext file + `chmod 0600` (v1 does not use a keychain)

---

## 12. Next Steps

1. Review v0.3.1 and triage each open question below.
2. Confirm the plugin name is `nexscope` (plugin dir name and skill namespace); skills invoked as `/nexscope:start`.
3. Once finalized, produce a technical design doc (session file protocol, monitor state machine, inbox storage, relay room-memory structure).
4. Then start coding.

---

## 13. Open-Question Priorities (by impact)

### 🟥 Tier 1 (affects core semantics, **must** be decided first)

| # | Question | Proposal |
|---|---|---|
| Q-9 | Should the human and their agent share a single username? | Yes: one username, one connection; `role` disambiguates sender. |
| Q-7 | `@mention` delivery — private to @'d users, or public with everyone seeing? | Private delivery (stronger privacy, less noise in v1); public mode deferred to v2. |
| Q-3 | Auto-mode hop counting — local consecutive vs full chain? | Local consecutive (each Claude maintains its own counter). |
| Q-4 | In auto mode, how does Claude decide whether to reply (question vs statement)? | Let Claude decide via prompt + two hard rules: no auto-reply for broadcasts, no auto-reply past hop limit. |
| Q-8 | In auto mode, does Claude read broadcasts or skip entirely? | Read (as context); do not send auto-replies. |

### 🟨 Tier 2 (affects behavior details)

| # | Question | Proposal |
|---|---|---|
| Q-5 | After `/nexscope:stop`, what happens to pending inbox items? | Keep them; still visible after next start; entries older than 24h mark `expired`. |
| Q-6 | Store message history in v1? | No. New joiners do not see past messages. |
| Q-10 | After `/nexscope:accept`, should Claude auto-post "done" to the thread? | Yes — a brief summary as `userAgent` to the same thread. |

### 🟩 Tier 3 (deployment / ops details)

| # | Question | Proposal |
|---|---|---|
| Q-1 | Where to deploy the relay? | VPS if you have one; otherwise fly.io (free tier is enough). |
| Q-2 | Is 4 KB message body enough? | Yes for text delegation. Revisit if you need to inline code patches. |

> **Suggested cadence**: lock Tier 1 → v1 can be finalized. Tiers 2 and 3 can be decided during implementation.
