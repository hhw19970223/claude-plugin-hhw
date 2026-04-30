# NEXSCOPE Relay Protocol (v1)

> Status: draft, matches PRD v0.4
> Scope: the wire-level contract between the `nexscope-relay` service and the `nexscope` plugin client
> Every change to this document must bump `SUPPORTED_PROTOCOL_VERSION` (see §1.3)

---

## 1. Overview

### 1.1 Transport

- Underlying: WebSocket (RFC 6455)
- Production requires `wss://` (TLS)
- One connection, one session: each WebSocket represents one online user's single session
- Text frames carry JSON control/metadata; binary frames carry file bytes

### 1.2 Connection URL

```
wss://<relay-host>/ws?name=<username>&token=<shared-token>&v=<protocol-version>
```

- `name`: required. Username; must match `^[a-zA-Z0-9_-]{1,32}$`
- `token`: required. Shared auth token
- `v`: optional but recommended. Protocol version number (numeric string, current `1`). Missing is treated as `1`; a mismatch with an unsupported future version → relay closes with `1008`

### 1.3 Versioning

- Current protocol version: **1**
- Incompatible changes must bump
- Relay and client each hard-code the version they support; on mismatch during handshake, relay sends `{type:"error",code:"version_mismatch"}` then closes with `1008`

---

## 2. Frame-type cheat sheet

| Direction | type / binary | Purpose |
|---|---|---|
| C→R | text `msg` | Send a text message (may carry attachments metadata) |
| C→R | text `file-start` | Begin a file stream |
| C→R | binary | File chunk (only between file-start and file-end) |
| C→R | text `file-end` | End a file stream |
| C→R | text `ping` | Application-layer liveness (optional — the WS-level ping/pong already exists) |
| R→C | text `presence` | Full online user list |
| R→C | text `msg` | Deliver a text message (pass-through + `ts` injection) |
| R→C | text `file-start` | Deliver the start of a file stream |
| R→C | binary | Deliver a file chunk |
| R→C | text `file-end` | Deliver the end of a file stream |
| R→Sender | text `ack` | Delivery/offline receipt |
| R→C | text `error` | Error frame |
| R→C | text `pong` | Reply to `ping` |

> Every text frame is **single-line UTF-8 JSON** with no embedded newlines; all include a `type` field.

---

## 3. Connection handshake

```
Client                                       Relay
  │                                            │
  │ ── WS connect(name=alice, token=...) ──▶   │
  │                                            │ (1) validate token
  │                                            │ (2) validate name against regex
  │                                            │ (3) validate name uniqueness
  │                                            │     on failure:
  │                            ◀── error frame ─┤
  │                            ◀── WS close ────┤ (1008 / 4009 / 4012)
  │                                            │
  │                            ◀── presence ───┤ broadcasts the full list (first frame)
  │                                            │ and simultaneously broadcasts the new list to other online clients
  │ ... normal messaging ...                    │
```

### 3.1 Validation order and close codes

| Failure | Behavior |
|---|---|
| `token` missing or incorrect | No error frame; close with `1008` directly |
| Protocol version unsupported | Send `{type:"error",code:"version_mismatch"}` → close `1008` |
| `name` fails regex | Send `{type:"error",code:"invalid_name"}` → close `4012` |
| `name` already in use | Send `{type:"error",code:"name_taken"}` → close `4009` |

---

## 4. Presence (online-list broadcast)

### 4.1 Format

```json
{"type":"presence","users":["alice","bob","carol"],"ts":1714000000000}
```

- `users`: the full list of currently online usernames, **sorted** (lexicographic), **including the recipient itself**
- `ts`: relay-generated timestamp (milliseconds)

### 4.2 When it's sent

The relay broadcasts a presence frame to **every** online connection whenever:

1. A new connection completes its handshake
2. A connection closes (explicit close / heartbeat timeout / client crash)

### 4.3 Client handling

- The client keeps no incremental state; **each `users` array is the single source of truth**.
- Diff consecutive frames to derive join/leave events for display.

---

## 5. Text messages (`msg`)

### 5.1 Client → relay

```json
{
  "type": "msg",
  "msgId": "01HQX5C9...",
  "from": "alice",
  "to": ["bob"],
  "role": "userAgent",
  "threadId": "t-2026-04-28-xyz",
  "text": "please refactor auth.ts, write tests first",
  "hopCount": 0,
  "attachments": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | ✓ | Fixed `"msg"` |
| `msgId` | string | ✓ | Client-generated unique id (ULID recommended); passed through by relay |
| `from` | string | ✓ | Must equal the authenticated username, otherwise dropped |
| `to` | string[] | ✓ | Recipients; `[]` = broadcast |
| `role` | `"user"` / `"userAgent"` | ✓ | Source-semantics role |
| `threadId` | string | ✓ | Topic id |
| `text` | string | ✓ | UTF-8 text; should be ≤ 4 KB |
| `hopCount` | number | ✗ | Defaults to 0 |
| `attachments` | Attachment[] | ✗ | Attachment metadata; if non-empty you **must** first upload via file-start |

### 5.2 Relay → recipient

```json
{
  "type": "msg",
  "msgId": "01HQX5C9...",
  "from": "alice",
  "to": ["bob"],
  "role": "userAgent",
  "threadId": "t-2026-04-28-xyz",
  "text": "...",
  "hopCount": 0,
  "attachments": [],
  "ts": 1714000000000
}
```

The relay passes it through verbatim, **only appending** `ts`. Other fields (including `from`) were validated at ingress and are never modified.

### 5.3 Ack

After routing completes, the relay sends to the sender (only the sender):

```json
{
  "type": "ack",
  "msgId": "01HQX5C9...",
  "threadId": "t-2026-04-28-xyz",
  "delivered": ["bob"],
  "offline":   ["carol"]
}
```

- `delivered`: array of usernames the message reached online
- `offline`: usernames in `to` that were offline (v1 drops the message, no queue)
- For broadcast (`to=[]`), `delivered` is every currently online member except the sender

---

## 6. File transfer (streamed)

### 6.1 Flow

```
Client                                    Relay                          Peer(s)
  │                                          │                              │
  │ ── text: {type:"file-start", ...} ────▶ │                              │
  │                                          │ take the global file-transfer lock
  │                                          │ ── text: file-start ───────▶ │
  │                                          │                              │
  │ ── binary: <chunk 0..N-1> ──────────▶   │ ── binary: <chunk> ────────▶ │
  │ ──────────────── repeat ─────────────── │ ──────────── repeat ───────── │
  │ ── text: {type:"file-end", ...} ─────▶  │                              │
  │                                          │ release the lock              │
  │                                          │ ── text: file-end ─────────▶ │
  │ ◀── text: ack (delivered/offline) ────  │                              │
```

### 6.2 `file-start` (client → relay)

```json
{
  "type": "file-start",
  "msgId": "01HQX5CA...",
  "from": "alice",
  "to": ["bob"],
  "role": "userAgent",
  "threadId": "t-2026-04-28-xyz",
  "text": "attached: current auth.ts",
  "hopCount": 0,
  "attachment": {
    "name": "auth.ts",
    "size": 12345,
    "mime": "text/x-typescript",
    "sha256": "a3f9...optional",
    "chunkSize": 65536
  }
}
```

- Field semantics mirror `msg`, but `type` is `file-start`; `attachments` is replaced by the singular `attachment` (v1 transfers one file at a time).
- `attachment.size` must equal the total number of subsequent binary bytes.
- `chunkSize` recommended 64 KB; clients may go smaller, but relay maxPayload caps a single frame at ≤ 1 MB.
- `sha256` optional; if provided, the recipient verifies the full file once assembled.

### 6.3 Binary chunks

- Sent consecutively immediately after `file-start`.
- Each frame is a **contiguous slice of raw file bytes** — no header, no padding.
- The relay preserves order and forwards to every online recipient in `file-start.to`.
- Total bytes must equal `attachment.size`.

### 6.4 `file-end` (client → relay)

```json
{"type":"file-end","msgId":"01HQX5CA...","from":"alice"}
```

- `msgId` must match the preceding `file-start`; mismatch causes the frame to be dropped and `{type:"error",code:"bad_file_end"}` to be emitted.
- On this frame the relay releases the global file-transfer lock and sends the sender an `ack`.

### 6.5 Global mutex & timeout

- The relay maintains **one file-transfer lock per room** (v1 constraint).
- While the lock is held, any `file-start` is rejected with:
  ```json
  {"type":"error","code":"transfer_busy","retryAfterMs":2000}
  ```
- If no `file-end` arrives within 60s of `file-start`, the relay:
  1. Releases the lock
  2. Closes the sender's connection with code `4014`
  3. Notifies recipients that already received `file-start` with `{type:"error","code":"transfer_incomplete","msgId":"..."}`

### 6.6 Recipient landing strategy

Recommended v1 client behavior on receipt:

1. On `file-start` → open a write stream to `~/.claude/plugin-data/nexscope/files/<msgId>-<name>.part`.
2. Append each binary chunk.
3. On `file-end` → rename `.part` to the final filename; if `sha256` is provided, verify.
4. Print a notification line `[<roleLabel> <from> → <target>] (file) <name> saved to <path>` (see PRD FR-4).

---

## 7. Error frames

```json
{"type":"error","code":"name_taken","message":"username \"bob\" already in room"}
```

### 7.1 Error codes

| code | Trigger | Closes connection? |
|---|---|---|
| `version_mismatch` | Client protocol version not supported | ✓ `1008` |
| `invalid_name` | name fails regex | ✓ `4012` |
| `name_taken` | name already in use | ✓ `4009` |
| `missing_from` | Upstream frame missing `from` | ✗ close `4013` after 10 accumulated |
| `from_mismatch` | Upstream `from` ≠ authenticated username | ✗ same as above |
| `missing_to` | Upstream `to` missing or not an array | ✗ same as above |
| `unknown_type` | Unknown `type` | ✗ |
| `bad_json` | Text frame isn't valid JSON | ✗ |
| `msg_too_large` | Single frame exceeds maxPayload | ✓ `4011` |
| `transfer_busy` | File-transfer lock held | ✗ |
| `transfer_incomplete` | Passive notification to recipients: sender's transfer did not complete | ✗ |
| `bad_file_end` | `file-end.msgId` doesn't match `file-start` | ✗ |
| `heartbeat_timeout` | Heartbeat timeout (logged only, no error frame) | ✓ `4010` |

### 7.2 Behavior on unauthenticated connections

Handshake-time failures **do not enter the message loop**; the socket is closed immediately. Apart from `version_mismatch` / `invalid_name` / `name_taken`, other auth failures (e.g. bad token) **do not send** an error frame (to prevent enumeration); they simply close with `1008`.

---

## 8. Heartbeat

- Relay sends a WebSocket-level `ping` (opcode 0x9) every 30s per connection.
- Clients auto-reply with `pong` (opcode 0xA) — standard for every WS library.
- Two consecutive missed pongs → `relay.terminate()` the connection, close code `4010`.
- Clients may also send an application-layer `{"type":"ping"}`; the relay replies with `{"type":"pong","ts":...}`. This flow is independent of WS-level heartbeat and is only for diagnostics.

---

## 9. Sizes & limits

| Item | v1 limit | Configurable env |
|---|---|---|
| Single WS frame max | 10 MB (supports binary chunks) | `NEXSCOPE_MAX_PAYLOAD` |
| Text frame suggested | ≤ 4 KB | — |
| Single-file total size | ≤ 100 MB | `NEXSCOPE_MAX_FILE` |
| Recommended chunk size | 64 KB | — |
| Room user cap | 50 | `NEXSCOPE_MAX_USERS` |

Any frame (including binary) exceeding `NEXSCOPE_MAX_PAYLOAD` → close `4011`.

---

## 10. Server authority & anti-forgery

- The relay is the **sole authority** on the `from` field: any `from` that doesn't match the authenticated username is dropped.
- The relay **does not modify** any message field other than `ts` (including `role`, `text`, `threadId`, `hopCount`). Role forgery is an application-layer risk, mitigated by the human gate (PRD FR-5 / FR-8).
- The relay **does not persist** any message body or file bytes; it only holds the in-memory online user table and the current file-transfer lock.

---

## 11. Full example session

```
Alice client                            Relay                                Bob client
    │                                      │                                      │
    │─ WS connect name=alice token=s ────▶ │                                      │
    │ ◀── presence {users:[alice]} ───────│                                      │
    │                                      │                                      │
    │                                      │◀── WS connect name=bob token=s ─────│
    │◀── presence {users:[alice,bob]} ────│── presence {users:[alice,bob]} ────▶│
    │                                      │                                      │
    │─ {type:msg, from:alice, to:[bob],                                           │
    │   role:userAgent, msgId:m1,                                                 │
    │   threadId:t1, text:"ping"} ───────▶│                                      │
    │                                      │── {type:msg, from:alice, ts:...,    │
    │                                      │    ...} ────────────────────────────▶│
    │◀── {type:ack, msgId:m1,             │                                      │
    │     delivered:[bob], offline:[]} ───│                                      │
    │                                      │                                      │
    │ ...                                  │                                      │
    │─ WS close ───────────────────────── │                                      │
    │                                      │── presence {users:[bob]} ──────────▶│
```

---

## 12. Mapping to PRD sections

| PRD item | This document |
|---|---|
| FR-1 Start/Stop | §3 handshake |
| FR-2 Presence | §4 |
| FR-3 Say / @mention | §5 |
| FR-4 Receive & inject (client-side) | §5.2, §6.6 |
| FR-11 Relay routing | §3, §5, §10 |
| §8.3 Close codes | §3.1, §7 |

---

## 13. Change log

- **v1** (PRD v0.4): first release. Defines text messages, file streaming, full-list presence broadcast, and `from` consistency checks.
