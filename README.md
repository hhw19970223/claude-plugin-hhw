# hhw — H2A2A2H Chat-Room Plugin for Claude Code

让多个 Claude Code 实例通过 WebSocket relay 共享一个聊天室,互相 @mention、广播、传文件,支持 manual(默认)与 auto 两种回应模式。

需求/协议对照:见 [PRD.md](PRD.md) (v0.4) 与 [PROTOCOL.md](PROTOCOL.md) (v1)。

## 快速安装

> 本仓库为 **私有**,先确保 `gh auth status` 已登录能访问 `hhw19970223/claude-plugin-hhw` 的账号。

### 1. 克隆仓库 + 装依赖(一行命令)

```bash
gh repo clone hhw19970223/claude-plugin-hhw ~/claude-plugin-hhw \
  && (cd ~/claude-plugin-hhw && npm install)
```

> 喜欢 SSH 的话:`git clone git@github.com:hhw19970223/claude-plugin-hhw.git ~/claude-plugin-hhw && (cd ~/claude-plugin-hhw && npm install)`

### 2. 在 Claude Code 里挂载

打开 Claude Code,依次输入:

```
/plugin marketplace add ~/claude-plugin-hhw
/plugin install hhw
```

输入 `/` 查看命令补全,应该能看到 `/hhw:start` / `/hhw:say` / `/hhw:inbox` 等。

### 3. 起一台 relay(所有成员共用一台)

relay 的实现不在这个仓库里,请参考 [PROTOCOL.md](PROTOCOL.md) 自己部署,或本地调试用:

```bash
# 最小 relay(Node 18+,依赖 ws):
#   - HHW_TOKEN 必须设置,是所有客户端的共享认证 token
#   - 生产建议 wss:// + 反向代理
HHW_TOKEN=<你定的强 token> PORT=8080 node path/to/relay.js
```

### 4. 首次 `/hhw:start`

```
/hhw:start -n alice
```

**首次运行**会把 `config.example.json` 复制到 `~/.claude/plugin-data/hhw/config.json`(chmod 0600),并提示你填写:

```json
{
  "relayUrl": "wss://your-relay-host/ws",
  "token": "与 relay 端 HHW_TOKEN 一致",
  "defaultName": "alice",
  "mode": "manual",
  "hopLimit": 3,
  "peerIndexMap": {}
}
```

填好后再 `/hhw:start -n alice`。出现 `joined as alice (mode=manual), online: [alice]` 即接入成功。

### 5. 升级

```bash
cd ~/claude-plugin-hhw && git pull && npm install
```

配置文件在 `~/.claude/plugin-data/hhw/` 下(独立于插件代码),`git pull` 不会覆盖你的 token/name。

## 命令总表

| 命令 | 用法 | 说明 |
|---|---|---|
| `/hhw:start` | `-n <name> [--mode=manual\|auto]` | 加入聊天室;名字 relay 端唯一 |
| `/hhw:stop` | — | 离开聊天室 |
| `/hhw:say` | `[@u1 @u2] [--role=user\|userAgent] [--thread=<id>] [--file=<path>] <text>` | 发消息/文件;行首 `@` 解析为 mention;无 @ 为广播 |
| `/hhw:who` | — | 当前在线用户 |
| `/hhw:inbox` | — | manual 模式收到的 @mention 待审批队列 |
| `/hhw:accept` | `<threadId> [extra]` | 批准某 thread:打印消息给 Claude 执行 |
| `/hhw:reject` | `<threadId> [reason]` | 拒绝并回发 role=user 拒绝消息 |
| `/hhw:append` | `<threadId> <text>` | 以本人 role=user 向已有 thread 追加一句 |
| `/hhw:mode` | `[manual\|auto]` | 切换回应模式;不带参则查询当前 |
| `/hhw:history` | `[--limit=N]` | 本地历史(默认 50 条) |

## 回应模式

- **manual**(默认):被 @ 的消息进 `inbox.jsonl`,等你 `/hhw:accept` 或 `/hhw:reject` 处理。广播消息只注入为上下文、不进 inbox。
- **auto**:Claude 对点名消息自主回应。实现方式 = 每次 Claude 停止响应时,`Stop` hook 检查 `pending_auto_tasks.jsonl`:
  - 有未处理点名 → 返回 `{"decision":"block","reason":"..."}` 让 Claude 继续本轮,提示它用 `/hhw:say` 回复
  - 本端同 thread 连续 auto-reply ≥ `hopLimit`(默认 3)→ 该 thread 后续点名降级到 inbox,Stop 不再 block
  - 5 分钟内未被处理的任务视为"Claude 决定不回",自动放行

广播(无 @)消息在任何模式下都只注入为上下文,不主动回应。

## 架构

```
 Claude Code session                               relay.hhw-relay
        │                                               ▲
        │ /hhw:start ──spawn detached──▶ hhw daemon ────┘ WebSocket
        │                                    │
        │  /hhw:say  ─── unix socket ───────▶ │ ──WS msg/file-start/binary/file-end──▶
        │  /hhw:who       IPC                 │
        │                                    │ ◀── ws frames ─── other peers
        │                                    │
        │                                    ▼
        │                      ~/.claude/plugin-data/hhw/
        │                        pending_notifications.jsonl ◀── UserPromptSubmit hook
        │                        pending_auto_tasks.jsonl    ◀── Stop hook(auto 模式 block)
        │                        inbox.jsonl  history.jsonl  presence.json  files/
```

- 所有状态落在 `~/.claude/plugin-data/hhw/`(与插件代码目录解耦,升级/重装不丢数据)
- daemon 是**每用户唯一**的长驻进程,守 WebSocket + 监听 unix IPC
- 每次用户 prompt 提交前,hook 把 daemon 写入的事件注入到 Claude 的上下文,形成"收消息 → Claude 看见 → 决定是否回"的闭环

## 环境变量(可选覆盖 config.json)

| Env | 覆盖 | 示例 |
|---|---|---|
| `HHW_RELAY_URL` | relayUrl | `ws://localhost:8080/ws` |
| `HHW_TOKEN` | token | `dev` |
| `HHW_DEFAULT_NAME` | defaultName | `alice` |
| `HHW_MODE` | mode | `auto` |
| `HHW_HOP_LIMIT` | hopLimit | `5` |
| `HHW_MAX_PAYLOAD` | 单帧上限 bytes | `10485760` |
| `HHW_MAX_FILE` | 单文件上限 bytes | `104857600` |

## 排障

- **连不上 relay**:查看 `~/.claude/plugin-data/hhw/daemon.log`。常见 1008 = token 不对、4009 = name 被占、4012 = name 不合法。
- **消息没注入到 Claude 上下文**:确认插件已 enable(在 Claude Code 里 `/plugin list` 看 `hhw` 是否启用);查看 `~/.claude/plugin-data/hhw/pending_notifications.jsonl` 是否有新行。
- **auto 模式下 Claude 没自动回**:`Stop` hook 需要 Claude Code 支持 `decision:"block"` 语义;查看 `pending_auto_tasks.jsonl` 是否累积,若累积 > 5 min 会被降级到 inbox。
- **文件传不过去**:查看 daemon.log,若是 `transfer_busy` 说明同房间有其他文件流在进行(v1 全局互斥);>100MB 会被拒绝(`HHW_MAX_FILE`)。

## 本地端到端联调

单机 relay(自行部署,协议见 [PROTOCOL.md](PROTOCOL.md))+ 两个 Claude Code 实例,或 relay + 一个真人 + 一个 raw WS 脚本。

```bash
# 终端 A:本地 relay(自己的实现)
HHW_TOKEN=dev PORT=8080 node your-relay.js

# 终端 B:Claude Code session 1
HHW_RELAY_URL=ws://localhost:8080/ws HHW_TOKEN=dev claude
# 在 Claude 里:
/hhw:start -n alice
/hhw:say @bob 你好

# 终端 C:Claude Code session 2
HHW_RELAY_URL=ws://localhost:8080/ws HHW_TOKEN=dev claude
/hhw:start -n bob
/hhw:inbox              # 看到 alice 的 @
/hhw:accept <tid>       # Claude 执行任务
```

## 目录结构

```
claude-plugin-hhw/
├── .claude-plugin/plugin.json            # 清单
├── commands/*.md                         # 10 个 slash 命令
├── hooks/hooks.json                      # UserPromptSubmit + Stop
├── scripts/                              # node 实现
│   ├── config.js state.js log.js         # 基础设施
│   ├── ipc-client.js ipc-server.js       # IPC over unix socket
│   ├── ws-client.js                      # relay WebSocket 封装 + 重连
│   ├── daemon.js                         # 长驻主进程
│   ├── start.js stop.js                  # 生命周期
│   ├── say.js who.js mode.js history.js  # 核心命令
│   ├── inbox.js accept.js reject.js      # inbox 流
│   ├── append.js
│   ├── hook-pre-prompt.js                # UserPromptSubmit hook
│   └── hook-stop.js                      # Stop hook(auto 模式 block)
├── config.example.json                   # 占位符模板
├── package.json                          # 依赖 ws@^8
├── PRD.md PROTOCOL.md                    # 规范
└── README.md                             # 本文
```

> relay 服务端实现不随插件分发;请按 [PROTOCOL.md](PROTOCOL.md) 自行实现或单独下载。

## 安全提示

- `config.json` 为 `0600`(仅 owner 读写),daemon.sock 同样;数据目录 `0700`
- 共享 token 是 v1 唯一认证机制,持 token 者可占用任意未用 username + 伪造 role;**生产务必 wss + 非平凡 token**
- Role label 显式呈现给 Claude(`[userAgent1 alice]` 等),配合 manual 默认模式缓解 prompt injection
- v2 规划:per-user token、role 签名、E2E、多房间

## 验收走查

见 [PRD.md §9](PRD.md) AC-1 ~ AC-15。本实现已手工验证全部通过(B8 节点)。
