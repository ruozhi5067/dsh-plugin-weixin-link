/**
 * 微信 iLink Bot（ClawBot / "龙虾"）协议常量。
 *
 * 依据：Tencent/openclaw-weixin v2.4.10 官方源码（src/api/api.ts、src/auth/login-qr.ts）。
 * 详见 docs/wechat-ilink-protocol.md。
 */

/** 默认 API base；扫码登录成功后必须用服务端下发的 baseurl 覆盖。 */
export const API_BASE = 'https://ilinkai.weixin.qq.com'

/** 二维码登录固定 base，不随账号配置变化。 */
export const LOGIN_BASE = 'https://ilinkai.weixin.qq.com'

/** 默认 CDN base（服务端不下发，只能来自本地配置）。 */
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'

export const QR_BOT_TYPE = 3

/** 官方插件 package.json 的 ilink_appid。 */
export const APP_ID = 'bot'

/** 自报版本号，同时用于 iLink-App-ClientVersion。 */
export const CHANNEL_VERSION = '2.4.10'

/** ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)，2.4.10 → 132106。 */
export const CLIENT_VERSION_INT = Number(
  ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (10 & 0xff),
)

/**
 * bot_agent 仅用于服务端日志归因，不参与鉴权与路由。
 * 约束：UA 风格 `Name/Version`（可带 (comment)）多段空格分隔，纯 ASCII，≤256 字节。
 */
export const BOT_AGENT = 'DSH-WeChat-ClawBot/1.0.0'

/** 各接口超时（毫秒），照抄官方 api.ts / login-qr.ts。 */
export const TIMEOUTS = {
  getUpdates: 35_000,
  send: 15_000,
  short: 10_000,
  qrStatus: 35_000,
}

/** 扫码登录总时长与轮询节奏。 */
export const LOGIN_TIMEOUT_MS = 480_000
export const LOGIN_POLL_INTERVAL_MS = 1_000
export const MAX_QR_REFRESH_COUNT = 3

/** bot token 失效 / 会话过期：暂停该账号全部请求 1 小时，需重新扫码。 */
export const STALE_TOKEN_ERRCODE = -14
export const SESSION_PAUSE_MS = 3_600_000

/** 长轮询失败退避：每次 2s，连续 3 次后 30s 并清零。 */
export const POLL_RETRY_MS = 2_000
export const POLL_BACKOFF_AFTER = 3
export const POLL_BACKOFF_MS = 30_000

/** 媒体单文件上限。 */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024

/**
 * uint64 字段：JSON.parse 之前必须加引号，否则超出 2^53 会精度丢失。
 * 见官方 parseWeixinApiJson 的 LOSSLESS_ID_FIELDS。
 */
export const LOSSLESS_ID_FIELDS = ['message_id', 'msg_id', 'svr_id']

/** 入站 message_type / message_state。 */
export const MESSAGE_TYPE = { NONE: 0, USER: 1, BOT: 2 }
export const MESSAGE_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 }

/** 入站 item type。 */
export const ITEM_TYPE = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
}

/** 出站 media_type。 */
export const MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }

/** sendtyping status，必须 1/2 成对。 */
export const TYPING_STATUS = { TYPING: 1, CANCEL: 2 }

/** typing 保活间隔（官方 createTypingCallbacks 传 5000）。 */
export const TYPING_KEEPALIVE_MS = 5_000
