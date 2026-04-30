# NEXSCOPE Relay Protocol (v1)

> 状态:draft,对应 PRD v0.4
> 作用范围:`nexscope-relay` 中继服务 ↔ `nexscope` 插件客户端的 wire-level 契约
> 任何对本文档的修改必须同步 bump `SUPPORTED_PROTOCOL_VERSION`(见 §1.3)

---

## 1. 总览

### 1.1 传输层

- 底层:WebSocket(RFC 6455)
- 生产环境必须 `wss://`(TLS)
- 单连接单会话:一条 WebSocket 表示一个在线用户的一次 session
- 文本帧承载 JSON 控制/元数据;二进制帧承载文件字节

### 1.2 连接 URL

```
wss://<relay-host>/ws?name=<username>&token=<shared-token>&v=<protocol-version>
```

- `name`:必需,用户名,正则 `^[a-zA-Z0-9_-]{1,32}$`
- `token`:必需,共享认证 token
- `v`:可选但推荐,协议版本号(数字串,当前 `1`)。缺省按 `1` 处理;未来版本不匹配时 relay 以 close code `1008` 拒绝

### 1.3 版本控制

- 当前协议版本:**1**
- 不兼容变更必须 bump
- relay 与客户端各自硬编码自己支持的版本号;握手时如果不匹配,relay 回 `{type:"error",code:"version_mismatch"}` 然后以 `1008` 关闭

---

## 2. 帧类型速查

| 方向 | type / binary | 用途 |
|---|---|---|
| C→R | text `msg` | 发送文本消息(可选携带 attachments 元信息) |
| C→R | text `file-start` | 开始文件流 |
| C→R | binary | 文件 chunk(仅在 file-start 与 file-end 之间) |
| C→R | text `file-end` | 结束文件流 |
| C→R | text `ping` | 应用层探活(WS 层的 ping/pong 已有,此帧可选) |
| R→C | text `presence` | 全量在线用户列表 |
| R→C | text `msg` | 投递文本消息(透传 + 填充 ts) |
| R→C | text `file-start` | 投递文件流起始 |
| R→C | binary | 投递文件 chunk |
| R→C | text `file-end` | 投递文件流结束 |
| R→Sender | text `ack` | 送达 / 离线回执 |
| R→C | text `error` | 错误帧 |
| R→C | text `pong` | 应答 `ping` |

> 所有文本帧均为**单行 UTF-8 JSON**,不含换行;均有 `type` 字段。

---

## 3. 连接建立流程

```
Client                                       Relay
  │                                            │
  │ ── WS connect(name=alice, token=...) ──▶ │
  │                                            │ (1) 校验 token
  │                                            │ (2) 校验 name 正则
  │                                            │ (3) 校验 name 唯一
  │                                            │     若不通过:
  │                            ◀── error frame ─┤
  │                            ◀── WS close ────┤ (1008/4009/4012)
  │                                            │
  │                            ◀── presence ───┤ 广播全量列表(首条)
  │                                            │ 同时向其他在线者广播新列表
  │ ... 正常通信 ...                            │
```

### 3.1 校验顺序与关闭码

| 失败原因 | 行为 |
|---|---|
| `token` 缺失或错误 | 不发 error,直接 close `1008` |
| 协议版本不支持 | 发 `{type:"error",code:"version_mismatch"}` → close `1008` |
| `name` 不匹配正则 | 发 `{type:"error",code:"invalid_name"}` → close `4012` |
| `name` 已存在 | 发 `{type:"error",code:"name_taken"}` → close `4009` |

---

## 4. Presence(在线广播)

### 4.1 格式

```json
{"type":"presence","users":["alice","bob","carol"],"ts":1714000000000}
```

- `users`:当前房间内所有在线 username 的**排序数组**(字典序),**包括接收方自己**
- `ts`:relay 生成时间戳(毫秒)

### 4.2 时机

Relay 在以下事件发生后,**向所有**在线连接广播一帧 presence:

1. 新连接握手成功
2. 连接关闭(主动 close / 心跳超时 / 客户端崩溃)

### 4.3 客户端处理

- 客户端不维护增量状态,**以每条 presence 帧的 `users` 为唯一真相**
- 前后两次对比即可得出 join/leave 事件,用于 UI 呈现

---

## 5. 文本消息(`msg`)

### 5.1 客户端 → relay

```json
{
  "type": "msg",
  "msgId": "01HQX5C9...",
  "from": "alice",
  "to": ["bob"],
  "role": "userAgent",
  "threadId": "t-2026-04-28-xyz",
  "text": "请重构 auth.ts,先写测试",
  "hopCount": 0,
  "attachments": []
}
```

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `type` | string | ✓ | 固定 `"msg"` |
| `msgId` | string | ✓ | 客户端生成的唯一 id(建议 ULID),relay 透传 |
| `from` | string | ✓ | 必须等于连接认证 username,否则丢弃 |
| `to` | string[] | ✓ | 接收方;`[]` = 广播 |
| `role` | `"user"` / `"userAgent"` | ✓ | 消息语义角色 |
| `threadId` | string | ✓ | 话题归属 id |
| `text` | string | ✓ | UTF-8 文本;建议 ≤ 4 KB |
| `hopCount` | number | ✗ | 默认 0 |
| `attachments` | Attachment[] | ✗ | 附件元数据;若非空,**必须**先 file-start 上传 |

### 5.2 relay → 接收方

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

Relay 原样透传,**只追加** `ts` 字段。其他字段(包括 `from`)已在入口校验合法,不再修改。

### 5.3 回执(ack)

Relay 在完成路由后,向 sender(仅 sender)发送:

```json
{
  "type": "ack",
  "msgId": "01HQX5C9...",
  "threadId": "t-2026-04-28-xyz",
  "delivered": ["bob"],
  "offline":   ["carol"]
}
```

- `delivered`:成功投递的在线用户名数组
- `offline`:`to` 中不在线的用户名数组(v1 消息丢弃,不排队)
- 广播消息(`to=[]`)的 `delivered` 是当前除 sender 以外的全体在线成员

---

## 6. 文件传输(流式)

### 6.1 流程

```
Client                                    Relay                          Peer(s)
  │                                          │                              │
  │ ── text: {type:"file-start", ...} ────▶ │                              │
  │                                          │ 锁定全局文件传输互斥锁          │
  │                                          │ ── text: file-start ───────▶ │
  │                                          │                              │
  │ ── binary: <chunk 0..N-1> ──────────▶   │ ── binary: <chunk> ────────▶ │
  │ ──────────────── 重复 ───────────────── │ ──────────── 重复 ─────────── │
  │ ── text: {type:"file-end", ...} ─────▶  │                              │
  │                                          │ 释放锁                        │
  │                                          │ ── text: file-end ─────────▶ │
  │ ◀── text: ack (delivered/offline) ────  │                              │
```

### 6.2 `file-start`(客户端 → relay)

```json
{
  "type": "file-start",
  "msgId": "01HQX5CA...",
  "from": "alice",
  "to": ["bob"],
  "role": "userAgent",
  "threadId": "t-2026-04-28-xyz",
  "text": "附上 auth.ts 当前版本",
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

- 字段语义同 `msg`,但类型为 `file-start`;`attachments` 改为单数 `attachment`(v1 一次传一个文件)
- `attachment.size` 必须等于后续二进制字节总和
- `chunkSize` 推荐 64 KB;客户端可自行调小,但 relay maxPayload 限制单帧 ≤ 1 MB
- `sha256` 可选;若提供,接收端算完整文件后做一次性校验

### 6.3 二进制 chunks

- 紧跟 `file-start` 之后,连续发送若干 binary frame
- 每帧是**原始文件字节的连续切片**,无 header、无 padding
- relay 保持顺序转发到所有 `file-start.to` 中在线的目标
- 总字节必须等于 `attachment.size`

### 6.4 `file-end`(客户端 → relay)

```json
{"type":"file-end","msgId":"01HQX5CA...","from":"alice"}
```

- `msgId` 必须与之前的 `file-start` 一致,否则丢弃并发 `{type:"error",code:"bad_file_end"}`
- relay 在此帧后释放全局文件传输互斥锁,并给 sender 发 `ack`

### 6.5 全局互斥锁与超时

- Relay 维护**全房间一个**文件传输锁(v1 约束)
- 锁被占用期间,任何 `file-start` 帧被拒绝,回:
  ```json
  {"type":"error","code":"transfer_busy","retryAfterMs":2000}
  ```
- `file-start` 后 60 秒内未收到 `file-end`,relay:
  1. 释放锁
  2. 向发送方 close 连接(code `4014`)
  3. 向已收到 file-start 的接收方发一帧 `{type:"error","code":"transfer_incomplete","msgId":"..."}`

### 6.6 接收方落地

v1 推荐接收端客户端行为:

1. 收到 `file-start` → 在本地 `~/.claude/plugin-data/nexscope/files/<msgId>-<name>.part` 打开写入流
2. 逐 binary chunk 追加
3. 收到 `file-end` → rename `.part` → 正式文件名;若 `sha256` 存在则校验
4. 打印通知行 `[<roleLabel> <from> → <target>] (file) <name> saved to <path>`(见 PRD FR-4)

---

## 7. 错误帧

```json
{"type":"error","code":"name_taken","message":"username \"bob\" already in room"}
```

### 7.1 错误码

| code | 触发条件 | 是否关闭连接 |
|---|---|---|
| `version_mismatch` | 客户端协议版本不被支持 | ✓ `1008` |
| `invalid_name` | name 不匹配正则 | ✓ `4012` |
| `name_taken` | name 已被占用 | ✓ `4009` |
| `missing_from` | 上行帧缺 `from` 字段 | ✗ 累计 10 次后关闭 `4013` |
| `from_mismatch` | 上行 `from` ≠ 连接 username | ✗ 同上 |
| `missing_to` | 上行帧 `to` 缺失或非数组 | ✗ 同上 |
| `unknown_type` | type 未识别 | ✗ |
| `bad_json` | 文本帧非合法 JSON | ✗ |
| `msg_too_large` | 单帧超出 maxPayload | ✓ `4011` |
| `transfer_busy` | 文件传输锁被占 | ✗ |
| `transfer_incomplete` | 接收方被动通知:来源方传输未完成 | ✗ |
| `bad_file_end` | file-end.msgId 与 file-start 不匹配 | ✗ |
| `heartbeat_timeout` | 心跳超时(仅日志,不发 error) | ✓ `4010` |

### 7.2 未认证连接行为

在握手校验阶段失败的连接**不进入消息循环**,直接 close。除 `version_mismatch` / `invalid_name` / `name_taken` 外,其它认证错误(如 token 错)**不发** error 帧(防枚举),直接 `1008` 关闭。

---

## 8. 心跳

- Relay 侧定时 30 秒对每个连接发送 WebSocket-level `ping`(opcode 0x9)
- 客户端自动以 `pong`(opcode 0xA)响应(所有 WS 库默认行为)
- 连续两次 ping 未收到 pong → relay `terminate()` 连接,close code `4010`
- 客户端也可主动发应用层 `{"type":"ping"}`,relay 回 `{"type":"pong","ts":...}`;此 flow 不影响 WS-level 心跳,仅供诊断

---

## 9. 大小与配额

| 项 | v1 限制 | 可配置 env |
|---|---|---|
| 单 WS 帧最大 | 10 MB(支持二进制 chunk) | `NEXSCOPE_MAX_PAYLOAD` |
| 文本帧建议 | ≤ 4 KB | — |
| 文件单次总大小 | ≤ 100 MB | `NEXSCOPE_MAX_FILE` |
| chunk size 推荐 | 64 KB | — |
| 房间用户数上限 | 50 | `NEXSCOPE_MAX_USERS` |

超出 `NEXSCOPE_MAX_PAYLOAD` 的任何帧(含二进制)→ close `4011`。

---

## 10. 服务端权威与无伪造

- Relay 是 `from` 字段的**唯一权威**:任何与连接认证 username 不一致的 `from` 都会被丢弃
- Relay **不修改**除 `ts` 以外的任何消息字段(含 `role`、`text`、`threadId`、`hopCount` 等);`role` 伪造属应用层风险,由人类 gate(PRD FR-5 / FR-8)抵御
- Relay **不持久化**任何消息或文件内容;仅维护内存中的在线用户表与当前文件传输锁

---

## 11. 示例会话(完整)

```
Alice 客户端                            Relay                                Bob 客户端
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

## 12. 与 PRD 的对应关系

| PRD 条目 | 本文档章节 |
|---|---|
| FR-1 Start/Stop | §3 连接建立 |
| FR-2 Presence | §4 |
| FR-3 Say / @mention | §5 |
| FR-4 接收与注入(客户端侧) | §5.2, §6.6 |
| FR-11 中继路由 | §3, §5, §10 |
| §8.3 关闭码 | §3.1, §7 |

---

## 13. 变更历史

- **v1** (PRD v0.4):首版。定义文本消息、文件流、presence 全量广播、from 一致性校验。
