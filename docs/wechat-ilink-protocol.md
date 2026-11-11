# 微信 ClawBot（iLink Bot）后端协议实现规格

面向「在 DSH 里自己实现机器人客户端、不装 OpenClaw」的照抄级说明。所有端点路径与 JSON 字段名均取自官方仓库
`Tencent/openclaw-weixin`（下称**官方插件**，版本 `2.4.10`，`package.json.ilink_appid = "bot"`）源码与官方协议文档
`docs/protocol_zh_CN.md`。凡仓库未体现的一律标 **未确认**，不臆造。依据文件：协议文档 `docs/protocol_zh_CN.md`；
请求/头/超时 `src/api/api.ts`；类型枚举 `src/api/types.ts`；登录 `src/auth/login-qr.ts`、`src/auth/accounts.ts`；
收消息 `src/monitor/monitor.ts`；发送 `src/messaging/send.ts`、`send-media.ts`；Markdown 过滤 `src/messaging/markdown-filter.ts`；
媒体 `src/cdn/upload.ts`、`cdn-upload.ts`、`cdn-url.ts`、`pic-decrypt.ts`、`aes-ecb.ts`、`src/media/media-download.ts`；
会话/游标/凭证 `src/api/session-guard.ts`、`src/storage/sync-buf.ts`、`state-dir.ts`。第三方 Python 复刻
`wechat-openclaw-sdk`（PyPI）仅作旁证，标注为「第三方」。

## 1. 基础地址、超时、请求头

### 1.1 地址（`accounts.ts`、`login-qr.ts`）

| 用途 | 值 |
| --- | --- |
| 默认 API base | `https://ilinkai.weixin.qq.com` |
| 二维码登录固定 base | `https://ilinkai.weixin.qq.com`（`FIXED_BASE_URL`，不随配置变） |
| 默认 CDN base | `https://novac2c.cdn.weixin.qq.com/c2c` |

路径相对 base 拼接（等价 `new URL(endpoint, base + "/")`）。登录成功后必须用 `get_qrcode_status` 返回的 `baseurl` 覆盖 API base
（官方存进账号文件，`resolveWeixinAccount` 优先用它，否则回退默认值）。`cdnBaseUrl` 只能来自本地配置，服务端不下发。

### 1.2 超时（`api.ts`、`login-qr.ts`）

| 场景 | 值 |
| --- | --- |
| `getupdates` 长轮询（客户端侧） | `35000` ms；服务端 `longpolling_timeout_ms`（>0 时）覆盖**下一次**超时 |
| `sendmessage` / `getuploadurl` | `15000` ms |
| `getconfig` / `sendtyping` / `notifystart` / `notifystop` | `10000` ms |
| 二维码状态轮询单次 | `35000` ms |
| 扫码登录总时长 | `max(timeoutMs ?? 480000, 1000)` ms；两次轮询之间固定 `1000` ms |
| 登录会话内存 TTL | `5 * 60_000` ms |

### 1.3 请求头（`api.ts`）

**带 Bot 鉴权的 POST**（`buildHeaders`）：

```http
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>          # 仅当 token 非空才加
X-WECHAT-UIN: <base64(十进制随机 uint32)>
iLink-App-Id: bot                          # = package.json.ilink_appid
iLink-App-ClientVersion: 132106            # = String(0x00MMNNPP)：2.4.10 → (2<<16)|(4<<8)|10
SKRouteTag: <可选路由标签>                  # 来自配置，可省略
```

- `X-WECHAT-UIN`：`crypto.randomBytes(4).readUInt32BE(0)` → 十进制字符串 → UTF-8 → base64；每次请求重新生成。
- `iLink-App-ClientVersion = ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)`，高位 8 bit 固定 0。
- 取不到自身 `package.json` 时 `channel_version = "unknown"`、`iLink-App-Id = ""`；实现时写死 `bot` + 自报版本即可。
- **普通 GET**（`apiGetFetch`，仅二维码状态轮询）：只发 `iLink-App-Id`、`iLink-App-ClientVersion`、可选 `SKRouteTag`；
  **不发** `Content-Type`、`AuthorizationType`、`Authorization`、`X-WECHAT-UIN`。
- **取二维码的 POST**：用带 token 的 POST 头（含 `AuthorizationType`、`X-WECHAT-UIN`），但**无** `Authorization`，body 里**无** `base_info`。

### 1.4 `base_info`（除二维码两个端点外，所有 Bot API 请求都带）

`{"base_info": {"channel_version": "2.4.10", "bot_agent": "OpenClaw"}}`

`bot_agent` 仅用于日志/监控归因，**不参与鉴权或路由**。约束（`sanitizeBotAgent`）：UA 风格 `Name/Version`（可带 `(comment)`）
多段空格分隔，纯 ASCII，清洗后 ≤ 256 字节；非法 token 直接丢弃，结果为空回退 `"OpenClaw"`。DSH 可写 `"DSH/1.0"` 之类。

## 2. 扫码登录全流程

### 2.1 取二维码

```http
POST /ilink/bot/get_bot_qrcode?bot_type=3
{"local_token_list": ["<本地已有 bot_token>", "..."]}
```

- `local_token_list` 可为空；官方最多带**最近 10 个**已保存 token（按账号索引从末尾往前取），供服务端判断是否已绑定。
- 响应 `{"qrcode": "<二维码值>", "qrcode_img_content": "<URL 或内容>"}`。
- **二维码渲染**：把 `qrcode_img_content` 当二维码内容渲染（官方用 `qrcode-terminal` 出终端二维码），并同时打印该值作兜底链接。
  `qrcode` 只用于轮询，不要拿去渲染。

### 2.2 轮询状态

```http
GET /ilink/bot/get_qrcode_status?qrcode=<urlencode(qrcode)>
GET /ilink/bot/get_qrcode_status?qrcode=<urlencode(qrcode)>&verify_code=<urlencode(验证码)>
```

响应字段：`status`、`bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id`、`redirect_host`（仅 `scaned_but_redirect` 出现）。

| `status` | 处理 |
| --- | --- |
| `wait` | 继续轮询（请求失败/超时也按 `wait` 处理并继续） |
| `scaned` | 已扫码继续；若本次带了 `verify_code` 说明验证码正确，清空暂存 |
| `need_verifycode` | 让用户输入手机微信显示的数字，暂存后**立即**进入下一次轮询（不 sleep） |
| `expired` | 刷新二维码（重新 POST `get_bot_qrcode`），刷新计数 +1；超过 `MAX_QR_REFRESH_COUNT = 3` 放弃 |
| `verify_code_blocked` | 验证失败过多：清空暂存验证码 → 刷新二维码；同样受 3 次上限约束 |
| `scaned_but_redirect` | 有 `redirect_host` 时把轮询 base 换成 `https://<redirect_host>` 继续；没有则留在原 host |
| `binded_redirect` | Bot 已绑定过本实例，**不发新凭证**，按「已连接」成功态结束；本地旧凭证继续有效 |
| `confirmed` | 成功；必须要有 `ilink_bot_id`，否则判失败 |

节奏：每次请求完成（含失败/超时）后 `sleep 1000` ms；`need_verifycode` 分支 `continue` 跳过 sleep。

### 2.3 成功后拿到的凭证与保存

从 `confirmed` 取 4 值：`bot_token`、`ilink_bot_id`（→ accountId）、`baseurl`（→ API base）、`ilink_user_id`（→ userId 白名单）。
官方落盘（DSH 可换目录，字段语义照抄）：state dir = `$OPENCLAW_STATE_DIR | $CLAWDBOT_STATE_DIR | ~/.openclaw`（`state-dir.ts`）。

```
<stateDir>/openclaw-weixin/
├─ accounts.json                     # JSON 字符串数组，登录顺序追加，末尾=最新
└─ accounts/<accountId>.json         # chmod 0600
   {"token":"<bot_token>","savedAt":"2026-01-01T00:00:00.000Z","baseUrl":"https://...","userId":"<ilink_user_id>"}
```

- `accountId` 来自 `ilink_bot_id`，写文件名前需规范化（官方 `normalizeAccountId`；历史 `xxx@im.bot` → `xxx-im-bot`）。
- 同 `userId` 的其它历史账号在登录后会被清理（`clearStaleAccountsForUserId`），避免 `context_token` 归属歧义。
- 之后每个 Bot API 请求都用 `Authorization: Bearer <token>` + `baseUrl`。

## 3. 收消息（长轮询）

```http
POST /ilink/bot/getupdates
{"get_updates_buf": "", "base_info": {"channel_version": "2.4.10", "bot_agent": "OpenClaw"}}
```

```json
{"ret": 0, "msgs": [], "get_updates_buf": "<下次回传的游标>", "longpolling_timeout_ms": 35000}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ret` | number | `0` 成功 |
| `errcode` / `errmsg` | number / string | 可选应用错误码与描述 |
| `msgs` | `WeixinMessage[]` | 消息数组 |
| `get_updates_buf` | string | **不透明**全量上下文游标，下次原样回传 |
| `longpolling_timeout_ms` | number | 服务端建议的下次长轮询超时 |
| `sync_buf` | string | 已废弃；官方只发 `get_updates_buf`，也不回退读 `sync_buf` |

### 3.1 游标语义

- 首次请求或游标重置时传 `""`；**只有返回值非空**（`!= null && !== ""`）才保存并更新游标，空值保持旧游标。
- 官方持久化到 `openclaw-weixin/accounts/<accountId>.sync.json`，内容 `{"get_updates_buf":"..."}`；启动时读取续传。
- `message_id` / `msg_id` / `svr_id` 是 uint64：官方在 `JSON.parse` **之前**把这三个键的数字字面量加引号以防精度丢失
  （`parseWeixinApiJson` 的 `LOSSLESS_ID_FIELDS`）。实现时务必用字符串承载这三个字段。

### 3.2 循环、重试与错误处理（`monitor.ts`）

- 正常返回：`nextTimeout = longpolling_timeout_ms`（>0 时），`consecutiveFailures = 0`。
- 客户端侧超时（AbortError）→ 官方返回 `{ret:0, msgs:[], get_updates_buf:<原游标>}`，当作空响应继续。
- 业务错误判定：`ret !== 0` 或 `errcode !== 0`。
- `ret === -14` 或 `errcode === -14`（`STALE_TOKEN_ERRCODE`）：`pauseSession` **暂停该账号全部 API 调用 1 小时**
  （`3600000` ms），期间其它请求经 `assertSessionActive` 直接抛错。等价于必须重新扫码登录。
- 其它业务错误：失败计数 +1 → sleep `2000` ms 重试；连续 `3` 次则 sleep `30000` ms 退避并清零计数。网络异常同理。
- 每条消息依次处理：读 `from_user_id` → `getconfig` 取该用户 `typing_ticket` → 处理消息。

### 3.3 去重与过滤

- **官方插件没有基于 `message_id` 的去重集合**，不重复消费完全依赖 `get_updates_buf` 单调推进。若 DSH 可能回退游标，
  建议自行按 `message_id || item.msg_id` 做近期 LRU 去重（**这是建议，不是协议要求**）。
- 授权白名单（`authorization.ts` / `pairing.ts`）：读 `<credDir>/openclaw-weixin-<accountId>-allowFrom.json`
  的 `{"version":1,"allowFrom":["<uid>"]}`；credDir = `$OPENCLAW_OAUTH_DIR | $OPENCLAW_STATE_DIR/credentials | ~/.openclaw/credentials`。
  列表为空则回退用账号文件里的 `userId`；两者都为空 → **放行所有消息**（但 `commandAuthorized=false`）；未授权发送者直接丢弃、不回复。
- 会话策略固定单聊：`dmPolicy: "pairing"`、`groupPolicy: "disabled"`、`ChatType: "direct"`；**群聊未实现**。

## 4. 发消息

```http
POST /ilink/bot/sendmessage
{"msg": {"from_user_id": "", "to_user_id": "<目标用户 ID>",
         "client_id": "openclaw-weixin:1750000000000-1a2b3c4d",
         "message_type": 2, "message_state": 2,
         "item_list": [{"type": 1, "text_item": {"text": "你好"}}],
         "context_token": "<入站消息带来的会话令牌>"},
 "base_info": {"channel_version": "2.4.10", "bot_agent": "OpenClaw"}}
```

响应 `{"ret": 0, "errmsg": "", "message_id": "<服务端消息 ID，uint64 字符串>"}`；`ret` 存在且非 0 → 抛错（缺 `ret` 不报错）。

- `from_user_id` 固定空串；`message_type = 2`（BOT）；`message_state = 2`（FINISH）；`to_user_id` 用入站消息的 `from_user_id`。
- `client_id` 客户端生成，官方格式 `openclaw-weixin:<毫秒时间戳>-<8 位 hex>`；服务端接受任意字符串并回包 `message_id`。
- **`item_list` 每次请求只放一个 item**：媒体 + 文案时先发一条 TEXT 请求，再发一条媒体请求，两条各有独立 `client_id`。

### 4.1 `context_token` 规则

- 服务端**每条入站消息**签发一个 `context_token`，出站必须在 `msg.context_token` 原样回带。
- 官方按 `(accountId, userId)` 缓存：内存 Map + 落盘 `openclaw-weixin/accounts/<accountId>.context-tokens.json`
  （内容 `{"<userId>":"<token>"}`），进程重启后恢复。
- 官方缺 token 时**只告警仍照发**（服务端是否接受未在仓库中验证）。第三方 SDK 报告缺/伪造 token 会被拒：
  `{"ret":-2,"errmsg":"prepare failed"}` → 机器人无法冷启动主动推送，必须先收到该用户一条入站消息。
- `context_token` 也是 `getconfig` 的可选请求字段。

### 4.2 文本 / Markdown 过滤（`StreamingMarkdownFilter`）

官方对每个 `deliver` 的文本执行 `new StreamingMarkdownFilter().feed(text) + flush()` 再发。它是**字符级流式状态机**，
会暂留末尾可能成为标记的字符（`*`、`**`、`_`、`__`、`!`）以消歧。按实现推导的净效果：

| 构造 | 处理 |
| --- | --- |
| 代码围栏（三反引号）、行内代码（单反引号）、表格、分隔线（`---`/`***`/`___` ≥3 且整行）、列表 `- `、引用 `>`、含 `~` 的删除线 | **原样保留** |
| `**粗体**`、`__粗体__` | **原样保留**（内容含 CJK 时也保留） |
| `*斜体*`、`_斜体_`、`***粗斜***`、`___粗斜___`，被包裹内容**含 CJK** | 标记剥掉，只留内容 |
| 同上但内容**不含 CJK** | 原样保留（含标记） |
| 标题 `#####` / `######`（H5/H6，后跟空格） | 标记与紧随空格剥掉，保留文字 |
| 标题 `#` ~ `####` | 原样保留 |
| 图片 `![alt](url)` | **整段删除**（若 `![x]` 后不接 `(` 则回吐 `![x]`） |

CJK 判定正则 `/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/`。微信客户端原生只渲染 `**粗体**` / `__粗体__`（第三方结论）。
**官方插件未做按长度分片或截断**，整段文本一次发出；服务端文本长度上限 **未确认**。

### 4.3 typing 保活

```http
POST /ilink/bot/sendtyping
{"ilink_user_id": "<用户 ID>", "typing_ticket": "<getconfig 返回>", "status": 1,
 "base_info": {"channel_version": "2.4.10", "bot_agent": "OpenClaw"}}
```

- `status`：`1` = 正在输入，`2` = 取消输入（`TypingStatus.TYPING/CANCEL`）；**必须成对**，开始发 1，结束（成功或失败）发 2。
- `typing_ticket` 来自 `getconfig`；**没有 ticket 时官方把 start/stop 都变成空操作**，不发请求。
- 官方调用框架的 `createTypingCallbacks({start, stop, keepaliveIntervalMs: 5000, onStartError, onStopError})`，
  即保活间隔传 `5000` ms；**该工厂内部的续期/上限逻辑不在本仓库 → 未确认**。第三方经验值「每 8–15 s 随机刷新、总上限 5 分钟」仅作旁证。
- 官方**不解析** `sendtyping` 响应体，也不检查其业务错误码。

```http
POST /ilink/bot/getconfig
{"ilink_user_id": "<用户 ID>", "context_token": "<可选>", "base_info": {...}}
→ {"ret": 0, "errmsg": "", "typing_ticket": "<base64>"}
```

官方按 userId 缓存：`ret === 0` 才落缓存，下次刷新 = `now + random() * 24h`；失败则指数退避 `2s → 4s → … → 上限 1h`，
期间用旧缓存或空 ticket。

### 4.4 生命周期通知

```http
POST /ilink/bot/msg/notifystart      # 客户端启动时
POST /ilink/bot/msg/notifystop       # 客户端停止时（独立超时，不受 abort 影响）
{"base_info": {"channel_version": "2.4.10", "bot_agent": "OpenClaw"}}   → {"ret": 0, "errmsg": ""}
```

非 0 只记警告，不阻断启动/停止。

## 5. 媒体上下行

### 5.1 上传（`getuploadurl` → CDN POST）

```http
POST /ilink/bot/getuploadurl
{"filekey": "<16 随机字节的 32 位 hex>", "media_type": 1, "to_user_id": "<目标用户 ID>",
 "rawsize": 12345, "rawfilemd5": "<明文 MD5 hex>", "filesize": 12352,
 "no_need_thumb": true, "aeskey": "<16 字节密钥的 32 位 hex>", "base_info": {...}}
→ {"upload_param": "...", "thumb_upload_param": "...", "upload_full_url": "..."}
```

- `media_type`：`1` 图片、`2` 视频、`3` 文件、`4` 语音。`rawsize` = 明文大小；`filesize = ceil((rawsize+1)/16)*16`（PKCS#7 密文大小）。
- 类型里还有 `thumb_rawsize` / `thumb_rawfilemd5` / `thumb_filesize`（注释称 IMAGE/VIDEO 必填），但官方**固定 `no_need_thumb: true`、
  只传原文件、不消费 `thumb_upload_param`**（这些字段为 `undefined` 时 `JSON.stringify` 直接省略）。
- 官方**不检查该接口的 `ret`**，只要求 `upload_full_url` 或 `upload_param` 至少一个非空。

上传步骤：①读明文算 `rawsize`/`rawfilemd5`，生成 16 字节 `filekey`（hex）与 16 字节 `aeskey`；②调 `getuploadurl`（`aeskey` 传 hex 字符串）；
③上传 URL 优先 `upload_full_url`，否则拼 `<cdnBaseUrl>/upload?encrypted_query_param=<urlencode(upload_param)>&filekey=<urlencode(filekey)>`；
④`AES-128-ECB` + PKCS#7 加密后 `POST` 密文，头 `Content-Type: application/octet-stream`；⑤**成功判定：HTTP `200` 且响应头
`x-encrypted-param` 非空**；4xx 立即终止，其它失败（含缺该头）最多重试 **3 次**；错误信息可看 `x-error-message` 响应头；
⑥把 `x-encrypted-param` 与密钥填进媒体引用后用 `sendmessage` 发出。

出站媒体 item 字段（`send.ts`）——注意 `aes_key` 是 **`base64(32 字符 hex 字符串)`**，不是原始密钥的 base64：

```json
{"type": 2, "image_item": {"media": {"encrypt_query_param": "<x-encrypted-param>",
  "aes_key": "<base64(hex)>", "encrypt_type": 1}, "mid_size": 12352}}
```

| 类型 | item | 体积字段 |
| --- | --- | --- |
| 图片 | `image_item` | `mid_size` = 密文字节数 |
| 视频 | `video_item` | `video_size` = 密文字节数 |
| 文件 | `file_item` | `len` = **明文字节数的十进制字符串**，另有 `file_name` |
| 语音 | 官方发送流程只选择图片/视频/文件；`media_type=4` 有定义但未用 | — |

上行路由（`send-media.ts`）按本地文件 MIME：`video/*` → 视频；`image/*` → 图片；其它 → 文件。

### 5.2 下载（CDN GET → 解密）

①URL 优先 `media.full_url`，否则 `<cdnBaseUrl>/download?encrypted_query_param=<urlencode(encrypt_query_param)>`
（回退开关 `ENABLE_CDN_URL_FALLBACK = true`）；②`GET` 取字节后 `AES-128-ECB` + PKCS#7 解密。

密钥来源与编码：

- 图片：优先 `image_item.aeskey`（32 位 hex 字符串），其次 `image_item.media.aes_key`；**两者都没有则把下载内容当明文图片**。
- 语音 / 文件 / 视频：必须 `media.aes_key`，缺失则官方**跳过**该媒体。
- `parseAesKey(base64)` 接受两种形式：base64 解出 **16 字节原始密钥**，或 base64 解出 **32 个 ASCII hex 字符**再 hex 解码；
  其它长度直接报错。
- 语音解密后是 SILK，官方用 `silk-wasm` 转 `audio/wav`；转码不可用则原样存 `audio/silk`。
- 单文件上限 `100 * 1024 * 1024` 字节（`WEIXIN_MEDIA_MAX_BYTES`）。
- 主 `item_list` 内附件优先级 **图片 > 视频 > 文件 > 语音**；带转写文本（`voice_item.text`）的语音不下载音频。
  主列表无媒体时回退找 `TEXT` item 的 `ref_msg.message_item`（引用消息里的媒体），标记为「引用媒体」。

### 5.3 CDN 媒体引用对象

`{"encrypt_query_param": "<下载参数>", "aes_key": "<base64 密钥>", "encrypt_type": 1, "full_url": "<可选完整 URL>"}`
`encrypt_type`：`0` = 只加密 fileid，`1` = 打包缩略图/中图等信息（官方出站一律发 `1`）。

## 6. 入站消息对象完整字段（`types.ts`）

```json
{"seq": 123, "message_id": "7400000000000000001", "from_user_id": "xxx@im.wechat", "to_user_id": "",
 "client_id": "", "create_time_ms": 1750000000000, "update_time_ms": 0, "delete_time_ms": 0,
 "session_id": "", "group_id": "", "message_type": 1, "message_state": 2,
 "context_token": "<会话令牌>", "run_id": "", "item_list": [{"type": 1, "text_item": {"text": "你好"}}]}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `seq` | number | 消息序列号 |
| `message_id` | string(uint64) | 消息 ID，按字符串解析防精度丢失 |
| `from_user_id` / `to_user_id` | string | 发送者 / 接收者 ID |
| `client_id` | string | 客户端关联 ID |
| `create_time_ms` / `update_time_ms` / `delete_time_ms` | number | 时间戳（ms） |
| `session_id` / `group_id` | string | 会话 ID / 群 ID（群聊未支持） |
| `message_type` | number | `0` NONE、`1` USER、`2` BOT |
| `message_state` | number | `0` NEW、`1` GENERATING、`2` FINISH |
| `item_list` | `MessageItem[]` | 内容列表 |
| `context_token` | string | 回复时必须回带的会话上下文 |
| `run_id` | string | 生成/运行 ID |

`MessageItem` 公共字段：`type`、`create_time_ms`、`update_time_ms`、`is_completed`、`msg_id`(string)、`ref_msg`，外加对应内容对象。

| `type` | 内容对象 | 关键字段 |
| ---: | --- | --- |
| `0` | NONE | — |
| `1` | `text_item` | `text` |
| `2` | `image_item` | `media`、`thumb_media`、`aeskey`(hex)、`url`、`mid_size`、`thumb_size`、`thumb_height`、`thumb_width`、`hd_size` |
| `3` | `voice_item` | `media`、`encode_type`、`bits_per_sample`、`sample_rate`、`playtime`、`text`（**语音转写文本**） |
| `4` | `file_item` | `media`、`file_name`、`md5`、`len`(明文字节数的十进制字符串) |
| `5` | `video_item` | `media`、`video_size`、`play_length`、`video_md5`、`thumb_media`、`thumb_size`、`thumb_height`、`thumb_width` |
| `11` | `tool_call_start_item` | `tool_name`、`tool_call_id` |
| `12` | `tool_call_result_item` | `tool_name`、`tool_call_id`、`status` |

`voice_item.encode_type`：`1` pcm、`2` adpcm、`3` feature、`4` speex、`5` amr、`6` silk、`7` mp3、`8` ogg-speex。

引用消息结构：

```json
{"ref_msg": {"title": "摘要", "svr_id": "<服务端消息 ID>",
  "message_item": {"type": 1, "text_item": {"text": "被引用内容"}},
  "partial_text": {"start": "…", "end": "…", "startindex": 0, "endindex": 10, "quotemd5": "…"}}}
```

取引用正文：优先 `ref_msg.title`，拼接 `ref_msg.message_item` 的文本；引用 ID 优先 `ref_msg.svr_id`，其次 `ref_msg.message_item.msg_id`。
新客户端可能只给 `svr_id` 不给内容（需自行缓存被引用消息）；官方用本地 quote 缓存补齐，缺失时填 `[引用消息内容未缓存]`。
出站构造 `tool_call_*` 时按 `type: 11/12` + `create_time_ms` + `is_completed` 填充，`status` 归一化为
`completed` / `failed` / `blocked` / `unknown`。

## 7. 错误码 / 返回码

| 值 | 出处 | 含义与处理 |
| --- | --- | --- |
| `ret: 0` | 各接口 | 成功 |
| `ret`/`errcode`: `-14` | `session-guard.ts` `STALE_TOKEN_ERRCODE`；`types.ts` 注释 `-14 = session timeout` | bot token 失效/会话过期：暂停该账号所有请求 **1 小时**，必须重新扫码登录；`getupdates` 收到即 `pauseSession` |
| `ret: -2`，`errmsg: "prepare failed"` | **第三方** SDK 文档 | `sendmessage` 缺/伪造 `context_token` 被拒；官方仓库未出现该码 → **未确认** |
| HTTP 非 2xx | `api.ts` | fetch 包装层直接抛错（`<label> <status>: <body>`），与业务 `ret` 分开处理 |
| 二维码轮询网络/网关错误 | `login-qr.ts` | 一律转成 `status: "wait"` 继续轮询（含 Cloudflare 524） |
| `getconfig` 非 0 / 异常 | `config-cache.ts` | 静默忽略，用缓存或空 ticket，指数退避重试 |
| `sendtyping` / `notify*` 非 0 | `api.ts`、`channel.ts` | 仅记警告，不阻断 |

除 `-14`（与第三方报告的 `-2`）外，官方仓库**没有**其它 `ret`/`errcode` 取值表 → 其余错误码 **未确认**，
按「非 0 即失败 + 退避重试」处理。

## 8. 照抄实现的最短清单

1. 常量：`API_BASE=https://ilinkai.weixin.qq.com`、`CDN_BASE=https://novac2c.cdn.weixin.qq.com/c2c`、`APP_ID=bot`、`CLIENT_VERSION`。
2. 登录：`POST ilink/bot/get_bot_qrcode?bot_type=3` → 渲染 `qrcode_img_content` → `GET ilink/bot/get_qrcode_status?qrcode=...`
   每 1 s 轮询 → `confirmed` 存 `bot_token` / `ilink_bot_id` / `baseurl` / `ilink_user_id`。
3. 收：`POST ilink/bot/getupdates`，长轮询 35 s，回传 `get_updates_buf`；`-14` 停 1 h；错误 2 s、连续 3 次后 30 s 退避。
4. 发：`POST ilink/bot/sendmessage`，`item_list` 单 item，回带入站 `context_token`，文本先过 Markdown 过滤器。
5. 保活：`POST ilink/bot/getconfig` 取 `typing_ticket` → `POST ilink/bot/sendtyping` `status=1` … `status=2` 成对发送。
6. 媒体：`POST ilink/bot/getuploadurl`（`no_need_thumb: true`）→ CDN `POST` 密文（`application/octet-stream`，成功看
   `x-encrypted-param`）→ 出站媒体 item；入站优先 `full_url` 下载后 `AES-128-ECB` 解密。
7. 生命周期：启动 `notifystart`，停止 `notifystop`。

## 9. 未确认项（不要照抄猜测）

1. typing 保活的**上限时长**与框架内部续期逻辑：官方只传 `keepaliveIntervalMs: 5000`，工厂实现不在本仓库；
   第三方「8–15 s 随机 / 上限 5 分钟」未经官方证实。
2. `ret: -2 "prepare failed"`（缺 `context_token`）仅见第三方文档；官方插件是「告警后照发」。
3. 除 `-14` 外的所有 `ret`/`errcode` 取值与含义。
4. 服务端对单条文本/单条消息的**长度上限**及是否需客户端分片：官方插件无分片逻辑。
5. 语音上行（`media_type: 4`）的发送流程：类型有定义，官方发送流程未实现。
6. 缩略图上传（`thumb_*` 字段、`thumb_upload_param`）：类型有定义，官方固定 `no_need_thumb: true` 且不消费。
7. `encrypt_type: 0`（只加密 fileid）的入站行为：类型有注释，官方只发/按 `1` 处理。
8. 群聊（`group_id`、`groupPolicy`）行为：官方显式 `disabled`，服务端契约未知。
9. `sync_buf`（已废弃）服务端是否仍接受。
10. 服务端是否强制 `bot_agent` 格式、`SKRouteTag` 的合法取值。
11. `get_updates_buf` 的内部编码（按不透明字符串/base64 处理，勿解析）。
