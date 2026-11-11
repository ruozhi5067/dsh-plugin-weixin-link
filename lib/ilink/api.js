/**
 * 微信 iLink Bot HTTP 客户端。
 *
 * 端点、请求头、超时、错误码语义全部照抄 Tencent/openclaw-weixin v2.4.10：
 *   src/api/api.ts、src/api/types.ts、src/monitor/monitor.ts、src/api/session-guard.ts
 * 详见 docs/wechat-ilink-protocol.md 第 1、3、4、7 节。
 */
import { randomBytes } from 'node:crypto'
import {
  API_BASE, APP_ID, BOT_AGENT, CDN_BASE, CHANNEL_VERSION, CLIENT_VERSION_INT,
  LOGIN_BASE, LOSSLESS_ID_FIELDS, QR_BOT_TYPE, SESSION_PAUSE_MS, STALE_TOKEN_ERRCODE,
  TIMEOUTS,
} from './constants.js'

/** 业务返回码 / 网络失败统一异常。 */
export class ILinkError extends Error {
  constructor(message, { code, ret, errmsg, status, path } = {}) {
    super(message)
    this.name = 'ILinkError'
    this.code = code
    this.ret = ret
    this.errmsg = errmsg
    this.status = status
    this.path = path
  }

  /** bot token 失效，必须重新扫码登录。 */
  get isStaleToken() {
    return this.code === STALE_TOKEN_ERRCODE || this.ret === STALE_TOKEN_ERRCODE
  }
}

/**
 * 随机 X-WECHAT-UIN：uint32 的十进制字符串再 base64。每次请求重新生成。
 * @returns {string} base64 值
 */
function randomUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

/**
 * 在 JSON.parse 之前给 uint64 字段的数字字面量加引号，避免超出 2^53 后精度丢失。
 * @param {string} text 响应正文
 * @returns {string} 可安全解析的正文
 */
export function quoteLosslessIds(text) {
  let out = text
  for (const field of LOSSLESS_ID_FIELDS) {
    out = out.replace(new RegExp(`"${field}"\\s*:\\s*(-?\\d{6,})`, 'g'), `"${field}":"$1"`)
  }
  return out
}

/**
 * 解析响应正文，保留 uint64 精度。
 * @param {string} text 响应正文
 * @returns {any} 解析结果
 */
export function parseWeixinApiJson(text) {
  if (!text) return {}
  return JSON.parse(quoteLosslessIds(text))
}

/**
 * 单个微信 Bot 账号的 API 客户端。
 *
 * 一个实例只服务一个 (baseUrl, token) 组合；`-14` 之后调用 `pauseReason` 会变为
 * 非空，`assertActive()` 会拒绝一切后续请求，直到重新扫码登录。
 */
export class ILinkApi {
  /**
   * @param {object} options 构造参数
   * @param {string} [options.baseUrl] API base，登录后应传服务端下发的 baseurl
   * @param {string} [options.token] bot_token
   * @param {(msg: string) => void} [options.log] 日志回调
   */
  constructor({ baseUrl = API_BASE, token = '', log } = {}) {
    this.baseUrl = String(baseUrl || API_BASE).replace(/\/+$/, '')
    this.token = token
    this.log = typeof log === 'function' ? log : () => {}
    /** 非空表示该账号被服务端判定 token 失效，暂停到该时间戳。 */
    this.pausedUntil = 0
    this.pauseReason = ''
  }

  /** 服务端下发的 baseurl 覆盖本地默认值（登录成功后调用）。 */
  setBaseUrl(baseUrl) {
    if (baseUrl) this.baseUrl = String(baseUrl).replace(/\/+$/, '')
  }

  /** 更新 token 并解除暂停（重新扫码登录后调用）。 */
  setToken(token) {
    this.token = token
    this.pausedUntil = 0
    this.pauseReason = ''
  }

  /** 该账号当前是否可发请求；被暂停时抛错。 */
  assertActive() {
    if (this.pausedUntil > Date.now()) {
      const seconds = Math.ceil((this.pausedUntil - Date.now()) / 1000)
      throw new ILinkError(
        `微信会话已失效（${this.pauseReason || 'token expired'}），需重新扫码登录；剩余暂停 ${seconds}s`,
        { code: STALE_TOKEN_ERRCODE },
      )
    }
  }

  /** `-14`：暂停该账号全部请求 1 小时。 */
  pauseForStaleToken(reason = 'session timeout') {
    this.pausedUntil = Date.now() + SESSION_PAUSE_MS
    this.pauseReason = reason
    this.log(`微信机器人会话失效（-14），暂停所有请求 1 小时：${reason}`)
  }

  /** 带 Bot 鉴权的 POST 头。 */
  authHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomUin(),
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': String(CLIENT_VERSION_INT),
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    return headers
  }

  /** 未鉴权的普通 GET 头：只有 app id 与版本号。 */
  plainHeaders() {
    return {
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': String(CLIENT_VERSION_INT),
    }
  }

  /** 所有 Bot 请求都带的 base_info。 */
  baseInfo() {
    return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
  }

  /**
   * 发一个请求并解析 JSON。
   * @param {string} path 相对 base 的路径
   * @param {object} options 请求选项
   * @param {'POST'|'GET'} [options.method] 方法
   * @param {object} [options.body] JSON 体
   * @param {Record<string,string>} [options.headers] 头
   * @param {number} [options.timeout] 超时毫秒
   * @param {boolean} [options.checkActive] 是否走会话暂停检查
   * @returns {Promise<any>} 解析后的响应
   */
  async request(path, { method = 'POST', body, headers, timeout = TIMEOUTS.send, checkActive = true } = {}) {
    if (checkActive) this.assertActive()
    const url = `${this.baseUrl}/${String(path).replace(/^\/+/, '')}`
    let response
    try {
      response = await fetch(url, {
        method,
        headers: headers ?? (method === 'GET' ? this.plainHeaders() : this.authHeaders()),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
      throw new ILinkError(`${path} 请求失败：${error?.message ?? error}`, {
        code: aborted ? 'ETIMEDOUT' : 'ENETWORK',
        path,
      })
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new ILinkError(`${path} HTTP ${response.status}: ${text.slice(0, 300)}`, {
        code: 'EHTTP', status: response.status, path,
      })
    }
    try {
      return parseWeixinApiJson(text)
    } catch (error) {
      throw new ILinkError(`${path} 响应不是合法 JSON：${error?.message ?? error}`, { code: 'EPARSE', path })
    }
  }

  // ── 扫码登录 ────────────────────────────────────────────────────────────

  /**
   * 取登录二维码。
   * @param {string[]} localTokenList 本地已有 token（官方最多带 10 个）
   * @returns {Promise<{qrcode: string, qrcode_img_content: string}>} 二维码数据
   */
  async getBotQrcode(localTokenList = []) {
    // 该端点用带 token 的 POST 头（含 AuthorizationType / X-WECHAT-UIN），但无 Authorization，body 无 base_info。
    return this.request(`ilink/bot/get_bot_qrcode?bot_type=${QR_BOT_TYPE}`, {
      method: 'POST',
      body: { local_token_list: localTokenList.slice(-10) },
      headers: this.authHeaders(),
      timeout: TIMEOUTS.send,
      checkActive: false,
    })
  }

  /**
   * 轮询二维码状态。固定走 LOGIN_BASE，成功前没有 token。
   * @param {string} qrcode 二维码值
   * @param {string} [verifyCode] 手机微信显示的验证码
   * @param {string} [host] redirect_host 覆盖
   * @returns {Promise<any>} 状态响应
   */
  async getQrcodeStatus(qrcode, verifyCode, host) {
    const base = host ? `https://${host}` : LOGIN_BASE
    const query = new URLSearchParams({ qrcode })
    if (verifyCode) query.set('verify_code', verifyCode)
    const url = `${base.replace(/\/+$/, '')}/ilink/bot/get_qrcode_status?${query.toString()}`
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.plainHeaders(),
        signal: AbortSignal.timeout(TIMEOUTS.qrStatus),
      })
    } catch (error) {
      // 官方把所有网络/网关错误（含 Cloudflare 524）都当 wait 继续轮询。
      return { status: 'wait', __networkError: String(error?.message ?? error) }
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) return { status: 'wait', __networkError: `HTTP ${response.status}` }
    try {
      return parseWeixinApiJson(text)
    } catch {
      return { status: 'wait', __networkError: 'invalid json' }
    }
  }

  // ── 收发消息 ────────────────────────────────────────────────────────────

  /**
   * 长轮询收消息。客户端超时按空响应处理（官方行为）。
   * @param {string} cursor get_updates_buf 游标
   * @param {number} timeoutMs 本次超时
   * @returns {Promise<{ret:number, msgs:any[], get_updates_buf:string, longpolling_timeout_ms?:number}>} 响应
   */
  async getUpdates(cursor = '', timeoutMs = TIMEOUTS.getUpdates) {
    try {
      const result = await this.request('ilink/bot/getupdates', {
        method: 'POST',
        body: { get_updates_buf: cursor, base_info: this.baseInfo() },
        timeout: timeoutMs,
      })
      this.#throwOnBusinessError(result, 'getupdates')
      return result
    } catch (error) {
      if (error instanceof ILinkError && error.code === 'ETIMEDOUT') {
        return { ret: 0, msgs: [], get_updates_buf: cursor }
      }
      throw error
    }
  }

  /**
   * 发一条消息。`item_list` 必须只放一个 item。
   * @param {object} message 出站消息
   * @param {string} message.toUserId 目标用户
   * @param {object} message.item 单个消息 item
   * @param {string} [message.contextToken] 入站消息带来的会话令牌
   * @param {string} [message.clientId] 客户端 ID
   * @returns {Promise<any>} 响应
   */
  async sendMessage({ toUserId, item, contextToken, clientId }) {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId ?? `dsh-wechat-clawbot:${Date.now()}-${randomBytes(4).toString('hex')}`,
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: contextToken ?? '',
      },
      base_info: this.baseInfo(),
    }
    const result = await this.request('ilink/bot/sendmessage', { method: 'POST', body })
    this.#throwOnBusinessError(result, 'sendmessage')
    return result
  }

  /**
   * 取该用户的 typing_ticket。
   * @param {string} userId 用户 ID
   * @param {string} [contextToken] 可选会话令牌
   * @returns {Promise<string>} ticket，失败返回空串
   */
  async getConfig(userId, contextToken) {
    try {
      const body = { ilink_user_id: userId, base_info: this.baseInfo() }
      if (contextToken) body.context_token = contextToken
      const result = await this.request('ilink/bot/getconfig', { method: 'POST', body, timeout: TIMEOUTS.short })
      if (result?.ret !== 0) return ''
      return String(result?.typing_ticket ?? '')
    } catch {
      // 官方在失败时静默地用缓存或空 ticket。
      return ''
    }
  }

  /**
   * 发送输入状态。status 1/2 必须成对；无 ticket 时空操作。
   * @param {string} userId 用户 ID
   * @param {string} ticket typing_ticket
   * @param {1|2} status 状态
   * @returns {Promise<void>} 完成
   */
  async sendTyping(userId, ticket, status) {
    if (!ticket) return
    try {
      await this.request('ilink/bot/sendtyping', {
        method: 'POST',
        body: { ilink_user_id: userId, typing_ticket: ticket, status, base_info: this.baseInfo() },
        timeout: TIMEOUTS.short,
      })
    } catch {
      // 官方不解析该响应，失败只忽略。
    }
  }

  /**
   * 生命周期通知。
   * @param {'start'|'stop'} phase 启动或停止
   * @returns {Promise<void>} 完成
   */
  async notify(phase) {
    const path = phase === 'start' ? 'ilink/bot/msg/notifystart' : 'ilink/bot/msg/notifystop'
    try {
      await this.request(path, { method: 'POST', body: { base_info: this.baseInfo() }, timeout: TIMEOUTS.short })
    } catch (error) {
      this.log(`notify${phase} 失败（忽略）：${error?.message ?? error}`)
    }
  }

  /**
   * 申请媒体上传地址。
   * @param {object} params 上传参数
   * @returns {Promise<{upload_full_url?: string, upload_param?: string}>} 上传目标
   */
  async getUploadUrl(params) {
    const result = await this.request('ilink/bot/getuploadurl', {
      method: 'POST',
      body: { ...params, no_need_thumb: true, base_info: this.baseInfo() },
      timeout: TIMEOUTS.send,
    })
    if (!result?.upload_full_url && !result?.upload_param) {
      throw new ILinkError('getuploadurl 未返回可用上传地址', { code: 'EUPLOAD' })
    }
    return result
  }

  /** 检查业务返回码，`-14` 触发暂停。 */
  #throwOnBusinessError(result, path) {
    const ret = result?.ret
    const errcode = result?.errcode
    if (ret === undefined && errcode === undefined) return
    if (ret === 0 && (errcode === undefined || errcode === 0)) return
    const code = ret && ret !== 0 ? ret : errcode
    if (code === STALE_TOKEN_ERRCODE) {
      this.pauseForStaleToken(`${path}: ${result?.errmsg ?? ''}`)
      throw new ILinkError(`微信会话失效（-14）`, { code: STALE_TOKEN_ERRCODE, ret, path })
    }
    throw new ILinkError(`${path} 失败：ret=${ret} errcode=${errcode} ${result?.errmsg ?? ''}`, {
      code, ret, errmsg: result?.errmsg, path,
    })
  }
}

export { API_BASE, CDN_BASE }
