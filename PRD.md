# PRD: Claude Code 聊天室插件(hhw)—— H2A2A2H 协作管道

> 版本: v0.4 (草稿)
> 日期: 2026-04-28
> 变更:
> - v0.1 → v0.2: peer-to-peer 聊天 → 跨 agent 任务委派,引入 role 与 Gate
> - v0.2 → v0.3: **点对点路由 → 单一聊天室 + @mention**;引入显式 start/stop 生命周期、用户名唯一性、presence 广播;允许 Claude **自动回应**(引入 auto/manual 模式)
> - v0.3 → v0.3.1: **连接信息(relay URL、token 等)改为插件内配置文件**,不再强制 env;env 降级为可选覆盖
> - v0.3.1 → v0.4:
>   - **文件资源纳入 v1**,以 WebSocket binary frame 流式传输
>   - **每条消息必带 `from` + `to`**,否则服务端直接丢弃(含 `from == 认证 username` 一致性校验)
>   - **Presence 改为"每次变更广播完整在线列表"**(而非增量 join/leave 事件),客户端以服务端列表为唯一真相
>   - 敲定协议细节,独立 `PROTOCOL.md` 作为服务端 / 插件的 wire-level 契约

---

## 1. 背景与目标

### 1.1 背景

用户希望所有参与的 Claude Code 实例**共享一个聊天室**,像 IRC/Slack 频道那样彼此可见、可 @。发送方可以把消息定向投递给某个成员的 Claude(via `@username`),也可以广播给全室。接收端的 Claude 收到点名消息后**可自主回应**,形成 H2A2A2H 链路下的"multi-agent 协作对话"——人类仍是最终权威,但不再是每条消息的必经 Gate。

核心链路:

```
 ┌──────────┐           ┌─────────────────────────────────┐           ┌──────────┐
 │  Human A │──(start)─▶│        Relay (单一聊天室)        │◀─(start)──│  Human B │
 │  (alice) │           │  • 维护在线用户表(唯一 username) │           │  (bob)   │
 └────┬─────┘           │  • 广播 presence(join/leave)    │           └─────┬────┘
      │                 │  • @mention 定向  / 无 @ 广播     │                 │
      ▼                 └─────────────────────────────────┘                 ▼
 ┌──────────┐                    ▲                 ▲                 ┌──────────┐
 │ Agent A  │────────────────────┘                 └─────────────────│ Agent B  │
 │(A的Claude)│                                                         │(B的Claude)│
 └──────────┘                                                         └──────────┘
```

### 1.2 目标

- **P0** 所有参与者加入**同一个聊天室**,通过唯一 username 区分。
- **P0** 插件通过 `/hhw:start -n <name>` 显式加入,`/hhw:stop` 显式离开(**不自动常驻**)。
- **P0** username 冲突 → 连接失败,客户端给出清晰错误。
- **P0** 新连入时 relay 推送当前在线用户快照;后续有人加入/离开,广播 presence 事件。
- **P0** 消息通过 `@username` 定向(可多 @),无 @ = 广播全室。
- **P0** 消息带 `role` 标记(`user` / `userAgent`),接收端 Claude 可据此判断来源语义。
- **P0** 两种回应模式:
  - **Manual**(默认): 点名消息进 inbox,人类审批后执行;
  - **Auto**: Claude 自主回应点名消息(广播消息仍不主动参与,避免噪音)。
- **P0** 插件与 relay 可自部署。
- **P1** 离线状态、断线重连、thread 有序、消息去重。
- **P2** 离线消息排队、E2E 加密、role 签名、多房间、跨房间联邦。

### 1.3 非目标

- 不做 UI(Claude Code 无 webview)。
- 不做文件/富媒体(v1 仅纯文本)。
- 不做服务端消息持久化(v1 只维护"在线用户 + 实时转发")。
- 不做 auto 模式下的"无限自动对话"——必须有 hop 上限 / 用户可随时打断。

---

## 2. 用户与场景

### 2.1 主要用户与角色

| 角色 | 描述 |
|---|---|
| **Human(房间成员)** | 真人,通过 `/hhw:start` 加入、`/hhw:stop` 离开 |
| **Agent**(该 Human 的 Claude) | 代表 human 发言、读取消息、可选自主回应 |
| **运维者** | 部署并维护 relay(聊天室服务) |

### 2.2 典型场景

**S1 点名委派(核心)**
Alice 在聊天室发 `@bob 麻烦让你的 Claude 重构 auth.ts,先写测试`(role=user)。Bob 的 Claude 会话里出现 `[user1 alice → @me] ...`。Manual 模式下 Bob 审批后执行;Auto 模式下 Bob 的 Claude 可先自动澄清("要不要保留旧 API?"),Alice 这边由 Claude 继续回复(role=userAgent),形成 H2A2A2H 的多轮。

**S2 A 让自己 Claude 代发**
Alice 说"让我的 Claude 整理当前 PR 的要点发给 bob",A 的 Claude 生成草稿(role=userAgent),Alice 再 `/hhw:append` 追加一句自己的话(role=user),一起发给 `@bob`。

**S3 群广播**
Alice 发 `准备下午 release,大家注意 freeze`(无 @,广播)。所有在线成员的 Claude 都收到;因为无点名,默认**不主动回应**,仅展示给各自 human。

**S4 Presence 感知**
Carol `/hhw:start -n carol` 加入,Alice 和 Bob 的 Claude 各自收到一行 `[presence] carol joined`;Alice 可直接 `@carol hi`。Carol 之后 `/hhw:stop` → 各客户端 Claude 收到 `[presence] carol left`。

**S5 用户名冲突**
Bob 在家用 `-n bob` 连入。公司 Bob 的机器也尝试 `-n bob` → 被拒,skill 提示"username taken,请换一个或让另一端先 stop"。

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| **Room** | 单一聊天室,由 relay 实现。v1 全局仅一个房间。 |
| **Username** | 房间内唯一的用户名(如 `alice`、`bob`、`hhw`)。 |
| **Session** | 一次 `start` ~ `stop` 之间的连接生命周期。 |
| **Presence** | 在线用户集的状态变化事件(snapshot / join / leave)。 |
| **@mention** | 消息正文或独立字段中指定的投递目标,格式 `@username`。 |
| **Role** | 消息来源语义,`user` 或 `userAgent`。 |
| **Role Label** | 接收端呈现格式,如 `[user1 alice]` / `[userAgent1 alice]`。本地人类自身永远是无后缀 `user`。 |
| **Thread / ThreadId** | 把同一话题的多条消息关联起来的 id。 |
| **Inbox** | Manual 模式下收到的点名消息队列,待本地 human 审批。 |
| **Mode** | `manual`(默认,人类 gate)/ `auto`(Claude 可主动回应点名消息)。 |
| **Hop Limit** | Auto 模式下同一 thread 连续 agent 自动回复次数上限,防死循环。 |

---

## 4. 范围

### 4.1 In Scope (v1)

| 模块 | 内容 |
|---|---|
| **插件 `hhw`** | skill: `start` / `stop` / `say` / `who` / `inbox` / `accept` / `reject` / `append` / `mode` / `history`;后台 monitor(仅在 session 活动时运行) |
| **中继 `hhw-relay`** | Node + ws,单房间,维护 username 集合、广播 presence、按 @mention 分发 |
| **认证** | 单一共享 token,从插件 `config.json` 读取(env 可覆盖) |
| **配置** | 插件根 `config.json` + `config.example.json`(模板,占位符 token) |
| **Username 唯一性** | 服务端强校验 |
| **Role 标记** | 客户端自声明,relay 透传 |
| **Inbox 本地文件** | 仅 manual 模式使用 |
| **Mode 切换** | 本地 per-session;可通过 env `HHW_MODE` 设默认值 |
| **Hop Limit** | Auto 模式同一 thread 内本端连续自动回复 ≤ 3 次;超出转 manual |

### 4.2 Out of Scope (v1)

- 多房间、房间创建/列表
- 服务端消息持久化、历史回放(v1 仅"上线后收到的实时消息")
- E2E 加密、role 签名
- 私聊(DM 独立通道)—— v1 通过 `@username` 模拟
- 离线排队
- **并发文件传输**(v1 同一时刻房间内最多一个进行中的文件流,详见 PROTOCOL.md)
- 图片/视频预览、富媒体渲染(文件以原始字节落地到接收端本地目录,由用户自行处理)
- Auto 模式跨 thread 的自主对话

---

## 5. 用户故事

### US-1 显式加入 / 离开
**As** 任意成员,**I want** 用 `/hhw:start -n <name>` 进房、`/hhw:stop` 出房,**so that** 我能清楚控制何时接收/不接收消息。

### US-2 Username 唯一
**As** 成员,**I want** 如果我的名字被占用,立刻看到清晰失败(而非静默连上后错乱),**so that** 我可以换一个名字或让另一端先 stop。

### US-3 在线感知
**As** 成员,**I want** 连入时立刻知道还有谁在线,并在后续有人进出时得到通知,**so that** 我能准确 @ 对方。

### US-4 点名消息
**As** Alice,**I want** 用 `@bob` 把消息投递给 Bob,**so that** Bob 的 Claude 知道这是给它的任务。

### US-5 广播消息
**As** Alice,**I want** 不带 @ 的消息让全房间成员都看到,**so that** 做通知/闲聊。

### US-6 Role 区分
**As** Bob,**I want** 我的 Claude 能区分消息是 Alice 本人还是 Alice 的 Claude 发的,**so that** 响应策略有差异。

### US-7 Manual 把关(默认)
**As** Bob,**I want** 默认情况下被 @ 的消息进 inbox、我审批后才执行,**so that** 避免 prompt injection。

### US-8 Auto 自主回应(可选)
**As** Bob,**I want** 我可以切到 auto 模式,让我的 Claude 对点名消息自主澄清/应答,**so that** 多 Claude 可以真正"对话"。

### US-9 Hop 防失控
**As** 成员,**I want** auto 模式下 Claude 自动回复不会无限循环,**so that** 不会刷屏或烧 API 额度。

### US-10 人类追加 / 打断
**As** Alice,**I want** Claude 生成消息后我可以 `append` 一句自己的话再发,**so that** 责任边界分明。

### US-11 自行部署
**As** 运维,**I want** 一条命令部署 relay,**so that** 不依赖 SaaS。

---

## 6. 功能需求

### FR-1 生命周期:Start / Stop
- `/hhw:start -n <username> [--room=<id>] [--mode=manual|auto]` 或 bin `hhw-start -n <name>`
- 建立 WebSocket 到 relay,携带 token + username
- 服务端校验:username 全局唯一,被占用 → 关闭码 `4009`,客户端打印 `username "<name>" taken`
- 成功后:
  - 保存 session 文件(含 connection 标识),`monitor` 才会连上
  - 打印 `joined as <name>, online: [alice, bob]`
- `/hhw:stop` 或 `hhw-stop`:
  - 主动关闭 ws,清理 session 文件
  - relay 广播 `presence leave`
  - 未 stop 前 Claude 进程退出:relay 心跳超时 30s 后判离线,广播 leave

**设计要点**: session 显式生命周期意味着 monitor 不能无脑常驻。方案:monitor 启动后检查 session 文件是否存在;不存在则空循环等待(低 CPU),`start` 成功后原子写入 session → monitor 感知并连接 ws;`stop` 删除 session → monitor 关 ws 回到等待态。

### FR-2 Presence(全量广播)
- **每次**有用户加入 / 离开房间时,relay 向**所有**在线连接(包括新加入的自己)广播完整在线用户列表:
  ```json
  {"type":"presence","users":["alice","bob","carol"],"ts":...}
  ```
- 不再发送增量 `join`/`leave` 事件;客户端以每次收到的 `users` 数组为**唯一真相**,自行对比前后差分并呈现变化(如 `[presence] carol joined`)。
- 客户端断线重连成功后,首条 presence 帧即刻下发(自然同步,无需额外 snapshot 指令)。

### FR-3 发送:`say` with @mention
- `/hhw:say [@<u1> @<u2> ...] [--role=user|userAgent] [--thread=<id>] <text>`
- 也支持在 `<text>` 内行首嵌入 `@user`(解析为 mention)。
- 无 mention = 广播。
- 有 mention = 仅投递给被 @ 的 online 成员(离线的被忽略,返回 offline 列表)。
- Role 默认值规则:
  - Agent 通过 skill 调用 → `userAgent`
  - Human 直接跑 bin `hhw-say` → `user`
  - 显式 `--role` 覆盖
- 返回 ack:`{delivered:["bob"], offline:["carol"]}`(广播时 delivered = 当前在线全员)

### FR-4 接收与注入
- Monitor 收消息,按类型处理:
  - `type=msg`:打印一行 `[<roleLabel> <from> → <target>] (thread=<tid>) <text>`,target 为 `@me` / `@all` / `@u1,u2` 等
  - `type=presence`:打印 `[presence] <user> joined|left|snapshot:[...]`
  - `type=ack`:不打印,返回给 send 调用方
- **Manual 模式**下,点名消息额外写入 inbox 文件(广播不写)。
- Auto 模式下不写 inbox,但所有消息仍打印为通知。

### FR-5 Inbox(Manual 模式)
- 文件: `~/.claude/plugin-data/hhw/inbox.jsonl`
- 条目: `{threadId, from, role, mentions, text, ts, status:"pending"}`
- Skill:
  - `/hhw:inbox` — 列出 pending + 最近归档的
  - `/hhw:accept <threadId> [extra]` — 标 accepted,Claude 把该 thread 所有消息合并作为本轮新的 user 输入执行;可追加 extra 指令
  - `/hhw:reject <threadId> [reason]` — 标 rejected,向原发送方回发一条 role=user 的拒绝消息(含 reason)
- 超过 24h pending 自动归 expired。

### FR-6 Auto 模式
- `/hhw:mode auto|manual` 切换本 session 模式;`env HHW_MODE` 可设默认。
- Auto 模式规则:
  1. 仅对**点名到自己**的消息自主回应;广播消息仅展示不回应。
  2. 回应前 Claude 必须判断是否"真正需要回"(澄清 / 同意 / 交付结果),避免空回复。
  3. 回应时自动复用同 threadId,role=userAgent。
  4. 同 thread 内,本端连续自主回复 ≤ 3 次(hop limit);达到上限后转 manual,等人类介入。
  5. 人类任何时候可 Ctrl+C 打断当前自动回复,或 `/hhw:mode manual` 立即退出 auto。

### FR-7 人类直达 / 追加
- `/hhw:append <threadId> <text>` 向 thread 追加一段 role=user 的消息(本 human 亲自说)。
- bin `hhw-say --role=user ...` 允许 human 不经 Claude 直接发言。

### FR-8 Who
- `/hhw:who` 列出当前在线用户(本地缓存,由 presence 维护)。

### FR-9 History(本地)
- `/hhw:history [--limit=N]` 列出本地收到的最近 N 条消息(不查 relay,仅本地内存/文件)。

### FR-10 身份与鉴权 / 配置来源
- **连接信息来自插件配置文件**(不走 env):
  - 路径:`~/.claude/plugin-data/hhw/config.json`(与插件目录解耦,升级插件不覆盖用户数据)
  - 首次启动若该路径不存在,自动从插件根的 `config.example.json` 复制过去,并打印提示 `已初始化 ~/.claude/plugin-data/hhw/config.json,请填入 relayUrl 和 token 后重新运行`
  - 字段:`relayUrl`、`token`、`defaultName`(可选)、`mode`(默认 `manual`)、`hopLimit`(默认 `3`)、`peerIndexMap`(可选)
  - 必填字段缺失或为占位符 `REPLACE_ME` → 插件初始化失败,打印清晰错误
  - 文件权限固定为 `0600`(仅 owner 可读写),启动时自动 `chmod`;v1 不走 keychain(明文 + 权限已足够)
- **Env 仅作覆盖**(可选):`HHW_RELAY_URL` / `HHW_TOKEN` / `HHW_DEFAULT_NAME` / `HHW_MODE` / `HHW_HOP_LIMIT`。存在时优先于 config.json。
- `config.example.json` 随插件仓库分发,所有敏感字段为占位符 `REPLACE_ME`,无预填默认值(避免误导用户以为能连到某个公共 relay)。

### FR-11 中继路由
- relay 维护 `Map<username, {ws, alive, pendingFile?}>`。
- 连接时校验:token 正确 + username 合法(`^[a-zA-Z0-9_-]{1,32}$`) + username 未被占用。
- 冲突时:先发一条 `{type:"error",code:"name_taken",...}`,再以 close code `4009` 关闭。
- 每一条客户端上行消息帧必须包含合法 `from` 和 `to` 字段:
  - `from` 缺失 / 非字符串 → **丢弃**(服务端日志 `missing_from`,不回 ack)
  - `from !== 连接认证的 username` → **丢弃**(日志 `from_mismatch`,防伪造)
  - `to` 缺失或非数组 → **丢弃**(日志 `missing_to`)
  - 以上任一丢弃不关闭连接;连续 10 次非法帧 → 关闭 code `4013`
- 消息分发:`to` 非空 = 按列表定向投递;`to` 为空 `[]` = 广播给所有其他在线成员(不回发给 sender 自己)。
- 文件流:同一时刻房间内最多一个进行中的文件流(relay 全局互斥锁);超时 60s 未收到 file-end 则强制释放并通知接收方。详见 PROTOCOL.md §文件传输。
- 心跳:30s ping / pong,连续两次未响应则 terminate 连接;清理后触发 presence 广播。
- **不持久化**任何消息或文件内容;仅在线用户表在内存。

### FR-12 断线重连
- monitor 侧:断开后指数退避(1→2→…→30s)自动重连。
- 重连成功后**不自动重走** `start`;而是用最后一次 `start` 的参数自动重入(保留 username)。如果此时 username 已被别人占用 → 打印错误,需人类干预。

### FR-13 Hop 限制与防循环
- 消息帧中传递 `hopCount`(agent 间每经一个 Claude 自主回复 +1)。
- relay **不修改**该字段;客户端自维护。
- Hop ≥ 3 触发本端强制 manual。
- 广播消息永远不会被自动回应(即使 auto 模式)。

---

## 7. 非功能需求

### NFR-1 延迟
p50 消息端到端 < 500ms(同区域)。presence 事件 < 300ms。

### NFR-2 安全
- 传输层:生产必须 WSS。
- 认证:共享 token;v1 允许"持 token 者可占用任意未占 username、伪造 role"——prompt injection 由 manual 默认模式 + UI role label 缓解。
- v2:per-user token、role 签名、preshared-key 验证。

### NFR-3 可移植
Node ≥ 18,`ws` 依赖。

### NFR-4 可观测
- relay 日志:连接/断开/转发/认证失败/username 冲突,每行一条。
- 客户端错误走 stderr,通知流走 stdout。

### NFR-5 消息正文上限
4KB。超出客户端拒绝。

### NFR-6 房间容量
v1 单进程 relay 建议 ≤ 50 用户;超过需考虑分片(v2)。

---

## 8. 接口与协议

### 8.1 WebSocket URL

```
wss://<relay-host>/ws?name=<username>&token=<shared-token>
```

### 8.2 帧类型概览

完整 wire-level 规范见独立文档 [`PROTOCOL.md`](./PROTOCOL.md)。本节仅列要点:

| 方向 | type | 作用 |
|---|---|---|
| client → relay | `msg` | 发送文本消息(可含 attachments 元数据) |
| client → relay | `file-start` | 开始文件流(后接若干 binary frame + `file-end`) |
| client → relay (binary) | — | 文件字节 chunk |
| client → relay | `file-end` | 结束文件流 |
| relay → client | `msg` / `file-start` / `file-end` | 透传(注入 `from` 校验过,注入 `ts`) |
| relay → client (binary) | — | 透传文件字节 |
| relay → client | `presence` | 在线用户全量列表 |
| relay → sender | `ack` | 送达 / 离线目标回执 |
| relay → client | `error` | 错误(name_taken / from_mismatch / transfer_busy / ...) |

**通用必备字段**(所有 client → relay 的 text 帧):

| 字段 | 必需 | 说明 |
|---|---|---|
| `type` | 是 | 帧类型 |
| `from` | 是 | 发送方 username,必须与连接认证 username 一致(否则丢弃) |
| `to` | 是 | 接收方 username 数组;`[]` = 广播全员 |
| `msgId` | 是 | 消息唯一 id(UUID v4 或 ULID 之类) |
| `role` | 是(msg/file-start) | `user` / `userAgent` |
| `threadId` | 是(msg/file-start) | 话题归属 id |
| `text` | 否 | 正文;文件可仅作说明 |
| `attachments` | 否 | 文件附件元数据数组 |
| `hopCount` | 否 | auto 模式链路计数,缺省 0 |

**Presence 帧**(v0.4 变更):
```json
{"type":"presence","users":["alice","bob","carol"],"ts":1714000000000}
```
每次房间成员变更时 relay 向所有在线连接广播一次。客户端自行 diff 呈现。

### 8.3 关闭码

| Code | 含义 |
|---|---|
| 1008 | 认证失败(token 错误) |
| 4009 | username 冲突 |
| 4010 | 心跳超时 |
| 4011 | 消息过大(超出 maxPayload) |
| 4012 | username 格式非法(不匹配 `^[a-zA-Z0-9_-]{1,32}$`) |
| 4013 | 连续非法帧过多(from 不一致 / 缺字段,累计 10 次) |
| 4014 | 文件传输超时(file-start 后 60s 未 file-end) |

### 8.4 Role

| role | 含义 | 接收端标签 |
|---|---|---|
| `user` | human 亲自发 | `[user<idx> <username>]` |
| `userAgent` | 该用户的 Claude 代发 | `[userAgent<idx> <username>]` |

`<idx>` 由本地 Claude 实例按首次接触顺序分配;本地自身无后缀。

### 8.5 Skill 总表

```
/hhw:start  -n <name> [--mode=manual|auto]   加入聊天室
/hhw:stop                                    离开聊天室
/hhw:say    [@u1 @u2 ...] [--role=...] [--thread=...] <text>  发消息
/hhw:who                                     列出在线用户
/hhw:inbox                                   (manual)查看待审批
/hhw:accept <threadId> [extra]               (manual)批准执行
/hhw:reject <threadId> [reason]              (manual)拒绝并回发
/hhw:append <threadId> <text>                追加一段 role=user 消息
/hhw:mode   auto|manual                      切换模式
/hhw:history [--limit=N]                     查看本地历史
```

### 8.6 插件配置文件(首选)

**路径**: `~/.claude/plugin-data/hhw/config.json`(**非**插件根目录——与插件代码分离,升级/重装不会覆盖用户配置)

**schema**:
```json
{
  "relayUrl": "wss://REPLACE_ME/ws",
  "token": "REPLACE_ME",
  "defaultName": "hhw",
  "mode": "manual",
  "hopLimit": 3,
  "peerIndexMap": {"alice": 1, "bob": 2}
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `relayUrl` | 是 | relay WebSocket URL,生产须 `wss://` |
| `token` | 是 | 共享认证 token,敏感,勿 commit |
| `defaultName` | 否 | `/hhw:start` 未传 `-n` 时使用;用户安装插件后通常会改 |
| `mode` | 否 | 默认会话模式,`manual` / `auto`,默认 `manual` |
| `hopLimit` | 否 | auto 模式 hop 上限,默认 `3` |
| `peerIndexMap` | 否 | role label 编号映射,缺省按首次接触顺序自动编 |

**分发与初始化约定**:
- 插件仓库含 `config.example.json`,所有敏感字段为占位符 `REPLACE_ME`,**不预填任何 relay URL**(没有公共 relay,避免误导)
- 用户真实配置存于 `~/.claude/plugin-data/hhw/config.json`(插件自身目录仅含 example,可 commit)
- 插件启动时若 `~/.claude/plugin-data/hhw/config.json` 不存在 → 自动从插件根 `config.example.json` 复制过去并 `chmod 0600`,然后中止启动并提示用户填写
- 所有包含 `REPLACE_ME` 的必填字段触发"未配置"错误,指向该文件路径

### 8.7 环境变量(可选覆盖)

所有字段可被同名 env 覆盖,优先级高于 config.json:

| Env | 覆盖字段 |
|---|---|
| `HHW_RELAY_URL` | `relayUrl` |
| `HHW_TOKEN` | `token` |
| `HHW_DEFAULT_NAME` | `defaultName` |
| `HHW_MODE` | `mode` |
| `HHW_HOP_LIMIT` | `hopLimit` |

使用场景:临时切换 relay 调试、多账号测试、CI 环境。

---

## 9. 验收标准

| # | 场景 | 预期 |
|---|---|---|
| AC-1 | Alice `/hhw:start -n alice`,Bob `/hhw:start -n bob` | 两人加入成功;Alice 的 Claude 看到 `[presence] bob joined`(或 snapshot) |
| AC-2 | Alice `/hhw:start -n bob`(bob 已在线) | 连接失败,提示 `username "bob" taken` |
| AC-3 | Alice `/hhw:say @bob 任务...`(role=userAgent) | Bob 会话中出现 `[userAgent1 alice → @me] ...`;Alice 侧 ack delivered=[bob] |
| AC-4 | Alice `/hhw:say hello all`(无 @) | Bob、其他在线成员都看到 `[userAgent1 alice → @all] hello all` |
| AC-5 | Manual 模式下 Alice @bob 发任务 | Bob 消息进 inbox,`/hhw:inbox` 可见,`/hhw:accept` 后 Claude 按指令执行 |
| AC-6 | Auto 模式下 Alice @bob 发澄清性问题 | Bob 的 Claude 自主回复(role=userAgent),回帧同 threadId,hopCount=1 |
| AC-7 | Auto 模式连续 hop=3 | Bob 客户端强制转 manual,Claude 不再自动回复 |
| AC-8 | Auto 模式下有人广播 | 所有人看到,但没有 Claude 自动回应 |
| AC-9 | Bob `/hhw:stop` | relay 广播 leave;Alice 的 Claude 看到 `[presence] bob left`;Bob 再也收不到消息 |
| AC-10 | Bob 重启 Claude Code(未 stop) | 心跳超时后 relay 广播 leave;Bob 重启完 `/hhw:start` 恢复 |
| AC-11 | relay 重启 | 所有客户端断线重连;重连后自动重入房间(用 last username);若冲突提示人类 |
| AC-12 | Alice 用 bin 直接发 `hhw-say --role=user @bob ...` | Bob 看到 `[user1 alice → @me] ...`(人类 role) |
| AC-13 | Alice 的 Claude 生成草稿后 Alice `/hhw:append` | 同 threadId 两条消息(userAgent + user)按序到达 Bob |
| AC-14 | 认证 token 错误 | 连接失败,clear error |
| AC-15 | 消息超过 4KB | 客户端拒绝,提示拆分 |

---

## 10. 里程碑

| 版本 | 内容 |
|---|---|
| **v0.3 PRD** | 本文档(当前) |
| **v1.0** | FR-1 ~ FR-13 全量,NFR 达标,AC-1 ~ AC-15 通过 |
| **v1.1** | 历史回放(relay 端持久化最近 N 条)、Auto 模式策略细化 |
| **v2.0** | 多房间、E2E、role 签名、per-user token、离线排队 |
| **v3.0** | 跨房间联邦、Bot API、文件附件 |

---

## 11. 风险与未决问题

| # | 风险/问题 | 当前处置 |
|---|---|---|
| R-1 | Prompt injection(userAgent 消息诱导 Claude 做坏事) | Manual 默认 + role label 明显 + auto 仅限点名 |
| R-2 | Auto 模式刷屏 / 无限循环 | Hop limit=3;广播不回应;人类可随时打断 |
| R-3 | Role 伪造(客户端自声明) | v1 已知风险;v2 签名 |
| R-4 | Username 占用抢名(恶意者占用后不释放) | v1 依赖 token 共享信任;v2 per-user token |
| R-5 | Relay 单进程单点 | v1 可接受;v2 分片或 sticky routing |
| R-6 | 心跳超时误判离线 → presence 抖动 | 心跳 30s + 5s 宽限再判定 |
| R-7 | Monitor 与 start/stop 的协调竞争 | session 文件原子写 + monitor 轮询 |
| R-8 | 断线重连期间消息丢失 | v1 接受丢失;v2 relay 端 buffered delivery |
| **Q-1** | Relay 部署到哪?(fly.io / Render / VPS) | 待定 |
| **Q-2** | 消息 4KB 是否足够? | 待确认 |
| **Q-3** | Auto 模式 hop limit=3 是否合适?是按"本端连续回复"还是"全链路"计数? | **建议本端连续**,跨端各自独立计数;待确认 |
| **Q-4** | Auto 模式下 Claude 应该对"问题性消息"回复、对"陈述性消息"不回复吗?如何判定? | 建议让 Claude 自行判断 + prompt 指导;待确认 |
| **Q-5** | `/hhw:stop` 后 inbox 里未处理的消息如何处理? | 建议保留,下次 start 后仍在 inbox;待确认 |
| **Q-6** | 消息历史:v1 完全不存,还是 relay 保留最近 N 条给新入房者? | 建议 v1 不存;待确认 |
| **Q-7** | 是否允许"私聊"(接收方只有被 @ 的人能看到)vs "房间内公开 @"(所有人都能看到但只有被 @ 的处理)? | 建议 v1 = 仅被 @ 的人能看到;待确认 |
| **Q-8** | Auto 模式下广播消息 Claude 完全不看吗,还是读但不回? | 建议 Claude 读(作为上下文),仅不主动回;待确认 |
| **Q-9** | 同一个人的 Claude 和本人同时在房间里,算两个 username 还是合一? | 建议 v1 = 同一 username 同一连接;A 的 Claude 通过 role=userAgent 发,A 通过 role=user 发,都用同一 username;待确认 |
| **Q-10** | `/hhw:accept` 批准后,Claude 是否需要公开回"已执行"?还是完成后回一条消息? | 建议完成后自动发一条 `userAgent` 回 thread;待确认 |

> **已定(v0.3.1 拍板)**:
> - 配置文件路径 = `~/.claude/plugin-data/hhw/config.json`(与插件目录解耦)
> - `config.example.json` 不预填任何 relay URL,全部字段占位符 `REPLACE_ME`
> - token 存储方案 = 明文文件 + `chmod 0600`(v1 不走 keychain)

---

## 12. 下一步

1. 你 review v0.3.1,并按下方"未决问题优先级"逐条定案。
2. 确认插件名就叫 `hhw`(插件目录名、skill 命名空间),skill 调用形如 `/hhw:start`。
3. 定稿后产出技术设计文档(session 文件协议、monitor 状态机、inbox 存储、relay 房间内存结构)。
4. 再进编码。

---

## 13. 未决问题优先级(按影响面排序)

### 🟥 一级(影响核心语义,**必须**先定)

| # | 问题 | 建议 |
|---|---|---|
| Q-9 | 同一人的人类 + agent 是否共用一个 username? | 建议共用:同一 username 同一连接,通过 role 字段区分是人发还是 agent 发 |
| Q-7 | `@mention` 的投递语义是"定向投递(非被 @ 者看不到)"还是"公开点名(所有人都看到)"? | 建议定向投递(v1 私密性更强、无噪音),公开式 v2 再加 |
| Q-3 | Auto 模式 hop limit 计数方式:本端连续 vs 全链路? | 建议本端连续(每个 Claude 各自维护自己的计数) |
| Q-4 | Auto 模式下 Claude 如何判断该不该回?(问题性 vs 陈述性) | 建议交给 Claude prompt 判断 + 强制"广播不回、已达 hop limit 不回"两条硬规则 |
| Q-8 | Auto 模式下 Claude 读广播但不回应,还是完全不读? | 建议读(作为上下文),仅不主动 send |

### 🟨 二级(影响行为细节)

| # | 问题 | 建议 |
|---|---|---|
| Q-5 | `/hhw:stop` 后 inbox 里未处理的消息如何处理? | 建议保留,下次 start 后仍在 inbox;超过 24h 归 expired |
| Q-6 | v1 是否存消息历史? | 不存。新加入者不看到过去消息 |
| Q-10 | `/hhw:accept` 后 Claude 完成任务是否自动回一条 `userAgent`? | 建议自动回,简要结果摘要到同 thread |

### 🟩 三级(部署 / 运维细节)

| # | 问题 | 建议 |
|---|---|---|
| Q-1 | Relay 部署到哪? | 取决于你是否有 VPS;无则 fly.io(免费额度够) |
| Q-2 | 消息 4KB 足够? | 够(文本委派足矣);若要附代码片段再谈 |

> **建议沟通节奏**:一级问题拍板后就可定稿 v1;二三级可以边实现边定。

