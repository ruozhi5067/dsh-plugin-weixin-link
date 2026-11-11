# dsh-plugin-weixin-link

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe)](https://github.com/topics/dsh-plugin)
[![topic: deepseek-harness](https://img.shields.io/badge/topic-deepseek--harness-6b5bd2)](https://github.com/topics/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**用手机上的微信「龙虾」ClawBot 直接驱动这台机器上的 DSH（DeepSeek Harness）。**

微信连接（Weixin link）插件：在 DSH 里内置完整微信页面（扫码登录、配对码、账号、白名单、会话映射、日志），
把每条微信聊天映射成一个独立的 DSH Agent 会话；微信里可以看深度思考与工具调用、批准单次操作、切换权限档位。

```
手机微信 ──► 微信 ClawBot 插件 ──► 腾讯 iLink 服务 ──► 本插件（长轮询）──► DSH Agent
   ▲                                                        │
   └────────────────── 助手输出回发微信 ◄─────────────────────┘
```

不需要安装 OpenClaw。插件自己实现了微信 iLink Bot 后端协议（扫码登录、长轮询收消息、回发、
typing 保活、媒体加解密），把每条微信聊天映射成一个独立的 DSH 会话。

**界面就在 DSH 里**：侧边栏多一个「微信」按钮，点开就是完整页面（二维码、配对码、账号、
白名单、会话映射、日志），不需要另开浏览器，也不需要输入任何命令。

> 包名：`dsh-wechat-clawbot`；本仓库名 `dsh-plugin-weixin-link`。

---

## 它给你什么

- **手机上就是微信**：不用装 App、不用连内网、不用开端口。
- **DSH 里一个完整页面**：侧边栏独立按钮打开，二维码 / 配对码 / 状态 / 会话一屏看完。
- **每条微信聊天 = 一个独立 DSH 会话**：上下文互相隔离，互不干扰。
- **会话在 DSH 里可见**：微信里创建的 DSH 会话同样出现在会话列表里，电脑上能接着看、接着聊。
- **默认锁死**：只允许白名单里的微信用户驱动 DSH；第一次用配对码把自己加进去。

## 环境要求

- **DSH Desktop / DSH Web GUI**（开发验证于 DSH 0.2.2-rc.1；插件使用 DSH 的 Host 与 client 公开服务）；
- **Node.js ≥ 22.13**（DSH 自带运行时满足）；
- 手机微信 + 微信里的「龙虾」ClawBot 插件（微信官方提供，用于接入 iLink Bot）；
- 本机可以访问腾讯 iLink 服务（插件主动长轮询，不需要公网 IP / 端口映射）。

## 安装

### 方式 A：从本仓库源码安装（推荐，当前版本 0.4.1）

```bash
git clone https://github.com/ruozhi5067/dsh-plugin-weixin-link.git
dsh plugin --profile desktop add link:<仓库路径>
```

装完**重启一次 DSH**。侧边栏会多出一个「微信」按钮，点它就是插件页面。

> DSH Desktop 的 desktop profile 由应用独占管理，如果 `dsh plugin add` 被拒绝，请手工登记：
>
> 1. 在 profile 的 `package.json` 的 `dependencies` 增加 `"dsh-wechat-clawbot": "link:<仓库路径>"`；
> 2. 在 profile 的 `node_modules` 建立 `dsh-wechat-clawbot` 链接（Windows `mklink /J`，macOS/Linux `ln -s`）；
> 3. 在 profile 的 `dsh.profile.bundles` 中追加 `"dsh-wechat-clawbot"`（本包自带 `cordis.patch.yml`，会插入自己的 Loader 行）；
> 4. 重启 DSH。

### 方式 B：npm 安装

```bash
dsh plugin --profile desktop add dsh-wechat-clawbot
```

> npm 上已发布的版本可能落后于本仓库源码（当前源码为 0.4.1）。追求最新功能 / 修复请用方式 A。

### 为什么必须重启

DSH 的 base 组合包以 `root: []` 启用 HMR —— 不监听插件模块文件，所以新装的插件要下次启动才生效
（DSH 的插件管理器也会返回 `restart-required`）。

## 首次使用（三步）

1. **扫码登录** — 打开「微信」页面 → 点「生成二维码」→ 用手机微信扫一扫。
   若微信提示输入验证码，把数字填进页面上的输入框提交。
   登录成功后凭证落在 `$DSH_HOME/wechat-clawbot/accounts/<账号>.json`。

2. **配对** — 页面上有一串 6 位**配对码**。在微信里把这串数字发给这个机器人。
   机器人会把你加入白名单并回复「配对成功」。

3. **开始用** — 直接在微信里发消息，就是给 DSH 派活。
   发图片 / 文件也可以：插件会把它们下载到本机并把路径告诉 DSH。

## 会话是留存的

**每条微信聊天固定绑定一个 DSH 会话，重启 DSH 也不会换。** 映射落在
`settings.json` 的 `sessions` 里，形式是 `<规范化账号ID>:<微信用户ID> → session-xxxx`。

只有这三种情况会开新会话：

1. 你在微信里发 **`/new`**（这是唯一的手动入口）；
2. 在「微信」页面对某条会话点了**重置**；
3. 原来的 DSH 会话真的找不回来了（会话日志被删，或工作目录变了导致无法 resume）。

**新开会话时微信里会收到一句 🆕 提示**，不会悄无声息地换掉上下文 ——
这样「为什么它不记得刚才说的话」永远有个明确答案。

> 通道键用的是**规范化账号 ID**。早期版本登录后用的是服务端原始 ID（含 `@`/`.`），
> 重启后读回来的是规范化 ID，两者对不上，表现就是「每次重启微信聊天都变成新对话」。
> 现在键固定用规范化形式，并且启动时会把历史遗留的旧键自动迁移过来。
>
> 工作目录只接受**绝对路径**（DSH 的会话头要求如此）。填了相对路径会被拒绝并提示，
> 而不是等到发消息时报一句 `session header cwd must be an absolute path`。

## 页面里能做什么

- 生成 / 取消登录二维码，填手机上的验证码
- 查看与轮换配对码
- 启停微信消息轮询
- 查看已登录账号（连接状态、收发计数、最近错误）与退出登录
- 查看已授权微信用户、一键移除
- 查看「微信会话 ↔ DSH 会话」映射、重置某条会话
- 设置新会话的工作目录
- 查看最近日志

## 微信里可用的命令

| 命令 | 作用 |
| --- | --- |
| `/new` | 开一段全新的 DSH 会话（清空上下文） |
| `/stop` | 中止当前这一轮 |
| `/permission` | 查看权限档位；`/permission <档位>` 切换 |
| `/status` | 查看当前 DSH 会话 ID 与运行状态 |
| `/whoami` | 查看自己的微信用户 ID |
| `/help` | 帮助 |

其它任何文本都会作为用户消息进入 DSH 会话。

## 在微信端批权限

两件事都能在微信里做，走的是 DSH 自己的权限模型，不是绕过它。

### 一、批准某一次操作（`approval/request`）

DSH 在需要授权时会发出 `approval/request`。插件认领**自己创建的微信会话**的请求，
把它们转到微信里：

```
🔐 DSH 需要授权

工具：bash
内容：{"command":"npm test"}
原因：该命令会修改工作区

回复「同意」执行一次，「拒绝」放弃（300 秒内有效）。
```

回复「同意」→ 返回 `allowed-once`（**DSH 唯一的授权值，只放行这一次**，不是永久放行）；
回复「拒绝」→ `rejected`；不回复 → 超时按 `cancelled`（不授权）；
你在 DSH 里 `/stop` 或轮次结束 → 请求 abort，同样按 `cancelled`。

几个刻意的设计：

- **授权提示会带上这次工具调用的原始参数**（从会话日志的 `tool/call` 里按 callId 找回），
  否则「要不要批准 bash」这种问题没法回答。
- **非微信会话的请求一律 `next()` 交还**给 DSH 原本的 answerer —— 桌面端 / GUI 的审批流程完全不受影响。
- **有待批请求时，该通道的下一条消息一律当答复处理**（同意 / 拒绝词生效，其它内容回一句提示）。
  否则用户以为自己在回答，实际却给 DSH 派了新活。
- 时间上限默认 300 秒。

### 二、切换会话权限档位（`/permission`）

权限档位 = 沙箱模式 + 审批策略的组合（由 `ctx.permissionPresets` 提供）：

```
/permission
→ 当前权限档位：readonly
  可选：
    readonly — 只读（不允许写文件）
    workspace — 工作区可写
    full — 完全访问（危险）
  切换：/permission <档位>

/permission workspace
→ 已切换权限档位：workspace
```

档位是**按会话**生效的，只影响当前这条微信会话对应的那个 DSH 会话。

## 微信里能看到什么（显示分级）

页面上的「微信里显示」三选一，实时生效：

| 级别 | 微信里收到 |
| --- | --- |
| `all`（默认） | 🧠 深度思考 + 🔧 工具调用 + ✅ 工具结果 + 助手最终回复 |
| `tools` | 🔧 工具调用 + ✅ 工具结果 + 助手最终回复 |
| `final` | 只发助手最终回复 |

实际长这样：

```
🧠 深度思考
先看目录结构，再决定读哪个文件……

🔧 read
{"file_path":"D:\\work\\a.txt"}

✅ read 完成（0.5s）

🔧 bash
{"command":"npm test"}

❌ bash 失败（1.2s）：command not found

结论：没问题。
```

细节：

- **深度思考**取自已提交的 `assistant/message` 里的 `reasoning` 内容块（官方无头实现也是这么取思考的），
  不是未提交的尝试流 —— 所以重试不会重复发。超过 4000 字截断。
- **工具调用**用独立的 `tool/call` / `tool/result` 会话事件，顺序就是真实时间线，耗时由两者时间戳相减得到。
- **工具结果只报状态与耗时，不回传结果正文** —— 工具结果可能是整个文件内容，塞进微信没有意义。
- 多步工具调用会产生多条消息，这是故意的：手机上能看到 DSH 正在做什么。

## 备用入口：`/wechat` 命令与独立页面

页面打不开时（例如界面异常），在 DSH 聊天框里输入 `/wechat` 仍然可以：

```
/wechat                查看状态；未登录时自动生成二维码并打开独立页面
/wechat verify <验证码> 提交手机微信要求的验证码
/wechat open           重新打开二维码 / 状态页面
/wechat code           换一个配对码
/wechat allow [用户ID]  查看白名单，或把某个微信用户加进白名单
/wechat revoke <用户ID> 把某个微信用户移出白名单
/wechat start|stop     启停微信消息轮询
/wechat logout [账号]   查看或退出已登录的微信账号
/wechat reset <用户>    重置该微信会话与 DSH 会话的绑定
/wechat status         只看状态
```

「独立页面」是插件生成的自包含 HTML（`$DSH_HOME/wechat-clawbot/panel.html`），
内联二维码 SVG，不依赖网络与登录态；里面还带一个指向可交互面板的带令牌链接。

## 安全模型

微信消息可以驱动一个能读写文件、执行命令的 Agent，所以访问控制是**默认拒绝**：

1. **白名单**：只有 `allowFrom` 里的微信用户 ID 能被受理；其它人的消息直接丢弃（只记日志，不回复）。
2. **配对码**：首次通过「把 6 位配对码发给机器人」来证明你是本人。扫码登录的那个微信号会自动进白名单。
3. **HTTP 路由信任栅栏**：所有面板路由都要求回环地址或显式信任的 Host、同源 Origin、非跨站请求；
   写操作（加白名单、改设置、退出登录）**只允许本机**。宿主 `connection.requestRejection`
   可用时再委托一层（含 DSH 自带的浏览器鉴权）。
4. **凭证不外泄**：`bot_token` 只存在本机 `$DSH_HOME/wechat-clawbot/accounts/`，日志里用户 ID 一律脱敏。

## 数据与文件布局

```
$DSH_HOME/wechat-clawbot/
├─ settings.json                              设置 + 白名单 + 配对码 + 会话映射
├─ log.ndjson                                 插件日志（滚动保留一份 .1）
├─ panel.html                                 /wechat 生成的独立页面
├─ accounts.json                              已登录账号列表
├─ accounts/<账号>.json                       凭证 {token, baseUrl, userId}
├─ accounts/<账号>.sync.json                  长轮询游标 get_updates_buf
├─ accounts/<账号>.context-tokens.json        每个用户的 context_token
└─ inbox/<账号>/                              微信发来的图片 / 文件 / 语音
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 侧边栏没有「微信」按钮 | 插件还没被加载 —— 重启 DSH；仍没有就看 `$DSH_HOME/wechat-clawbot/log.ndjson` |
| 二维码扫了没反应 | 页面会显示 `wait` / `scaned` / `expired`；过期会自动刷新（最多 3 次），也可以点重新生成 |
| 微信里发消息没回复 | 先确认页面里账号是「已连接」；再确认自己在白名单里（`/whoami` 看 ID） |
| 提示「会话已失效（-14）」 | 微信侧 token 过期，需要重新扫码登录（协议要求暂停该账号 1 小时） |
| 页面 401 / 打不开 | 用 `/wechat open` 走备用入口；那条链接带进程令牌 |

## 开发

```bash
node tools/smoke-client.mjs          # 客户端半：插槽注册（打桩 window/document/React）
node tools/smoke-plugin.mjs          # 宿主半：桥接 / 存储 / 运行时 / 路由（打桩 Cordis 上下文）
node tools/smoke-ilink.mjs           # 协议层：二维码 / Markdown 过滤 / 分片 / uint64 / AES
node tools/qr-selftest.mjs           # 内置二维码库的 39 项结构自检
node tools/probe-ilink.mjs           # 对真实微信服务取一张二维码（只读探活）
node tools/preflight-installed.mjs   # 用 DSH 的方式加载「已安装」的那个包
```

调试用的状态目录可以用环境变量改到别处：`DSH_WECHAT_CLAWBOT_DIR`。
`DSH_WECHAT_CLAWBOT_NO_OPEN=1` 可以让 `/wechat` 命令不弹浏览器。

### 客户端半为什么是手写的

`lib/client.js` **不走打包**：它按 DSH 的模块加载器格式手写成
`window.__ModuleLoader__.load({ id, factory })`，React 通过 factory 的 `require('react')`
从宿主模块表里取（保证与界面用同一份 React）。所以文件里不能出现 JSX，也不能有 ESM import/export。

页面挂载方式：侧边栏 `sidebar.panellist` 注册一个按钮（id `wechat`），
中间栏 `main` 键控插槽注册同 key 的整页 —— 点按钮就切到这一页，与 DSH 自带的
「插件」「计划任务」面板同机制。

## 已知限制

- 只支持**单聊**；群聊在官方协议里就是 disabled，未实现。
- 出站只发文本；出站图片 / 视频 / 文件的上传协议已实现（`lib/ilink/media.js` `uploadOutboundMedia`）但尚未接到 UI / 工具上。
- 语音出站未实现（官方也未实现）；入站语音依赖微信自带转写文本。
- 助手输出按「已提交的 assistant 消息」逐条回发，多步工具调用会产生多条消息。
- 表格、复杂排版在微信里不会渲染；Markdown 会被过滤成纯文本（保留 `**粗体**`、代码块、列表、引用）。

## 协议来源与第三方

微信 iLink Bot 协议实现依据腾讯官方开源项目
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（v2.4.10，MIT）的
`docs/protocol_zh_CN.md` 与 `src/**` 源码逐条对齐，整理稿见
[`docs/wechat-ilink-protocol.md`](docs/wechat-ilink-protocol.md)；
DSH 侧的插件与 Agent 接口整理稿见 [`docs/dsh-agent-api.md`](docs/dsh-agent-api.md)。

内置二维码库：`qrcode-generator` 1.4.4（MIT，© 2009 Kazuhiko Arase），已随包放在 `vendor/qrcode.js`。

## 目录结构

```
dsh-plugin-weixin-link/
├─ cordis.patch.yml   # 组合包补丁：插入插件 Loader 行
├─ package.json
├─ lib/               # Host 半边 + 浏览器半边 + iLink 协议实现
├─ vendor/qrcode.js   # 内置二维码库
├─ tools/             # 冒烟测试 / 协议探针 / 自检脚本
├─ docs/              # 协议与 DSH Agent API 整理稿
└─ LICENSE
```

## License

[MIT](LICENSE)
