/**
 * 微信扫码登录状态机。
 *
 * 照抄官方 src/auth/login-qr.ts 的状态流转：
 *   wait → 继续；scaned → 继续；need_verifycode → 要验证码后立刻重试（不 sleep）；
 *   expired / verify_code_blocked → 刷新二维码（最多 3 次）；
 *   scaned_but_redirect → 换 redirect_host 继续；binded_redirect / confirmed → 成功。
 * 每次请求完成后 sleep 1000ms；总时长默认 480s。
 * 详见 docs/wechat-ilink-protocol.md 第 2 节。
 */
import {
  LOGIN_POLL_INTERVAL_MS, LOGIN_TIMEOUT_MS, MAX_QR_REFRESH_COUNT,
} from './constants.js'

/** 轮询间隔。 */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new Error('aborted'))
    return
  }
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(new Error('aborted'))
  }, { once: true })
})

/**
 * 一次扫码登录会话。
 *
 * 面板通过 `state` 读取进度、通过 `provideVerifyCode()` 回填手机号验证码。
 */
export class QrLoginSession {
  /**
   * @param {object} options 选项
   * @param {import('./api.js').ILinkApi} options.api 未鉴权的 API 客户端
   * @param {string[]} [options.localTokens] 本地已有 token，供服务端判断是否已绑定
   * @param {(msg: string) => void} [options.log] 日志
   * @param {number} [options.timeoutMs] 总超时
   */
  constructor({ api, localTokens = [], log, timeoutMs = LOGIN_TIMEOUT_MS }) {
    this.api = api
    this.localTokens = localTokens
    this.log = log ?? (() => {})
    this.timeoutMs = timeoutMs

    /** 面板读取的状态快照。 */
    this.state = {
      status: 'idle',
      qrcodeContent: '',
      qrcodeUrl: '',
      redirectHost: '',
      verifyCodeRequired: false,
      verifyCodeAttempts: 0,
      refreshCount: 0,
      startedAt: 0,
      error: '',
      credentials: null,
    }

    this.#controller = new AbortController()
    this.#verifyCode = ''
    this.#verifyResolver = null
  }

  #controller
  #verifyCode
  #verifyResolver
  #running = false

  /** 提供给面板：是否需要用户输入验证码。 */
  get needsVerifyCode() {
    return this.state.verifyCodeRequired
  }

  /**
   * 面板回填验证码。
   * @param {string} code 手机微信上显示的数字
   * @returns {boolean} 是否被接受
   */
  provideVerifyCode(code) {
    const value = String(code ?? '').trim()
    if (!value) return false
    this.#verifyCode = value
    this.state.verifyCodeRequired = false
    this.state.status = 'verifying'
    const resolve = this.#verifyResolver
    this.#verifyResolver = null
    resolve?.()
    return true
  }

  /** 取消登录。 */
  cancel() {
    this.#controller.abort()
    this.state.status = 'cancelled'
  }

  /**
   * 跑完整条登录流程。
   * @returns {Promise<{accountId: string, token: string, baseUrl?: string, userId?: string}|null>} 成功返回凭证，超时/取消返回 null
   */
  async run() {
    if (this.#running) throw new Error('登录流程已在进行中')
    this.#running = true
    const deadline = Date.now() + this.timeoutMs
    this.state.startedAt = Date.now()

    try {
      let qr = await this.#fetchQrcode()
      if (!qr) return null

      while (Date.now() < deadline) {
        if (this.#controller.signal.aborted) return null

        const response = await this.api.getQrcodeStatus(
          qr.qrcode,
          this.#verifyCode || undefined,
          this.state.redirectHost || undefined,
        )
        const status = String(response?.status ?? 'wait')

        switch (status) {
          case 'wait':
            this.state.status = 'waiting-scan'
            break

          case 'scaned':
            // 带了验证码还能走到 scaned，说明验证码正确。
            if (this.#verifyCode) {
              this.#verifyCode = ''
              this.state.verifyCodeAttempts = 0
            }
            this.state.status = 'scanned'
            break

          case 'need_verifycode': {
            this.state.status = 'need-verifycode'
            if (!this.state.verifyCodeRequired) {
              this.state.verifyCodeRequired = true
              this.state.verifyCodeAttempts += 1
              this.log('微信要求输入手机上的验证码')
            }
            await this.#awaitVerifyCode()
            continue // 官方语义：拿到验证码后立刻重试，不 sleep
          }

          case 'expired': {
            this.state.refreshCount += 1
            if (this.state.refreshCount > MAX_QR_REFRESH_COUNT) {
              this.#fail('二维码多次过期，请重新发起登录')
              return null
            }
            this.log(`二维码已过期，刷新第 ${this.state.refreshCount} 次`)
            qr = await this.#fetchQrcode()
            if (!qr) return null
            break
          }

          case 'verify_code_blocked': {
            this.#verifyCode = ''
            this.state.verifyCodeRequired = false
            this.state.verifyCodeAttempts = 0
            this.state.refreshCount += 1
            if (this.state.refreshCount > MAX_QR_REFRESH_COUNT) {
              this.#fail('验证码错误次数过多，请重新发起登录')
              return null
            }
            this.log('验证码错误次数过多，已刷新二维码')
            qr = await this.#fetchQrcode()
            if (!qr) return null
            break
          }

          case 'scaned_but_redirect': {
            const host = String(response?.redirect_host ?? '').trim()
            if (host) {
              this.state.redirectHost = host
              this.state.status = 'redirected'
              this.log(`服务端要求切换到 ${host} 继续轮询`)
            }
            break
          }

          case 'binded_redirect': {
            // Bot 已绑定过本实例，不下发新凭证：按成功处理，本地旧凭证继续有效。
            this.state.status = 'already-bound'
            this.state.credentials = null
            this.log('该微信已绑定本实例，沿用本地凭证')
            return null
          }

          case 'confirmed': {
            const accountId = String(response?.ilink_bot_id ?? '').trim()
            if (!accountId) {
              this.#fail('登录成功但服务端未返回 ilink_bot_id')
              return null
            }
            const credentials = {
              accountId,
              token: String(response?.bot_token ?? ''),
              baseUrl: response?.baseurl ? String(response.baseurl) : undefined,
              userId: response?.ilink_user_id ? String(response.ilink_user_id) : undefined,
            }
            this.state.status = 'confirmed'
            this.state.credentials = credentials
            this.log(`扫码登录成功，账号 ${accountId}`)
            return credentials
          }

          default:
            this.log(`未知二维码状态：${status}`)
            break
        }

        await sleep(LOGIN_POLL_INTERVAL_MS, this.#controller.signal)
      }

      this.#fail('扫码登录超时')
      return null
    } catch (error) {
      if (this.#controller.signal.aborted) {
        this.state.status = 'cancelled'
        return null
      }
      this.#fail(String(error?.message ?? error))
      return null
    } finally {
      this.#running = false
    }
  }

  /** 等待面板回填验证码（带超时）。 */
  async #awaitVerifyCode() {
    if (this.#verifyCode) return
    await Promise.race([
      new Promise((resolve) => {
        this.#verifyResolver = resolve
      }),
      sleep(120_000, this.#controller.signal).then(() => {
        this.#verifyResolver = null
      }).catch(() => {
        this.#verifyResolver = null
      }),
    ])
  }

  /** 取一张新二维码。 */
  async #fetchQrcode() {
    try {
      const response = await this.api.getBotQrcode(this.localTokens)
      const content = String(response?.qrcode_img_content ?? '')
      if (!content || !response?.qrcode) throw new Error('服务端未返回二维码内容')
      this.state.qrcodeContent = content
      this.state.qrcodeUrl = String(response?.qrcode ?? '')
      this.state.status = 'waiting-scan'
      return { qrcode: String(response.qrcode), content }
    } catch (error) {
      this.#fail(`获取二维码失败：${error?.message ?? error}`)
      return null
    }
  }

  /** 记录失败。 */
  #fail(message) {
    this.state.status = 'failed'
    this.state.error = message
    this.log(`扫码登录失败：${message}`)
  }
}
