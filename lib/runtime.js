/**
 * 插件运行时：把「微信账号轮询」「DSH Agent 桥」「面板操作」串成一个可被 Web 面板读写的对象。
 *
 * 通道键统一为 `<accountId>:<userId>`，这样多账号时同一微信号的不同机器人账号互不串味。
 */
import { WeChatDshBridge } from './bridge.js'
import { WeChatAccountRuntime, redact } from './channel.js'
import { readLog } from './logger.js'
import { ILinkApi } from './ilink/api.js'
import { QrLoginSession } from './ilink/login.js'
import { qrAvailable, qrLoadError, renderQrSvg } from './ilink/qr.js'
import * as store from './store.js'
import path from 'node:path'

/** 从通道键取 userId。 */
export const channelUser = (channelKey) => String(channelKey).split(':').slice(1).join(':')

export class WeChatClawBotRuntime {
  /**
   * @param {(msg: string) => void} log 日志
   */
  constructor(log) {
    this.log = log
    this.ctx = null
    this.bridge = null
    /** @type {Map<string, WeChatAccountRuntime>} */
    this.runtimes = new Map()
    /** @type {QrLoginSession|null} */
    this.login = null
    this.loginPromise = null
    this.lastLoginResult = ''
    this.started = false
  }

  /**
   * 绑定插件上下文并建桥（不启动轮询）。
   * @param {object} ctx 已注入 agents 的插件上下文
   * @returns {void}
   */
  attach(ctx) {
    // 配置热重载会再次进入这里：先把旧的账号运行时与桥拆干净，避免重复轮询/重复监听。
    for (const runtime of this.runtimes.values()) {
      runtime.stop().catch(() => {})
    }
    this.runtimes.clear()
    if (this.bridge) this.bridge.dispose().catch(() => {})
    this.started = false

    this.ctx = ctx
    this.bridge = new WeChatDshBridge({
      ctx,
      log: this.log,
      sendText: async (channelKey, text) => {
        const runtime = this.#runtimeForChannel(channelKey)
        if (!runtime) return
        await runtime.sendText(channelUser(channelKey), text)
      },
      sendTyping: (channelKey, on) => {
        const runtime = this.#runtimeForChannel(channelKey)
        if (!runtime) return
        const userId = channelUser(channelKey)
        const task = on ? runtime.startTyping(userId) : runtime.stopTyping(userId)
        Promise.resolve(task).catch(() => {})
      },
      resolveWorkspace: () => this.#resolveWorkspace(),
      onSessionBound: (channelKey, sessionId) => store.bindSession(channelKey, sessionId),
      modelSelection: () => {
        const settings = store.loadSettings()
        return { provider: settings.provider, model: settings.model }
      },
      verboseLevel: () => store.loadSettings().verbose,
    })
    this.bridge.start()
  }

  /** 启动所有已登录账号的轮询。 */
  async startAll() {
    if (!this.bridge) throw new Error('运行时尚未绑定上下文')
    if (this.started) return
    this.started = true
    // 先把历史遗留的通道键归一，避免同一个微信聊天在重启后被当成新会话。
    if (store.migrateChannelKeys()) this.log('已把历史会话映射迁移为规范化账号键')
    const settings = store.loadSettings()
    if (!settings.enabled) {
      this.log('插件已在面板中被停用，跳过轮询启动')
      return
    }
    for (const accountId of store.listAccountIds()) {
      const credentials = store.loadAccount(accountId)
      if (!credentials?.token) continue
      await this.#startAccount(accountId, credentials).catch((error) => {
        this.log(`启动账号 ${accountId} 失败：${error?.message ?? error}`)
      })
    }
    if (!store.listAccountIds().length) this.log('还没有已登录的微信账号，请在面板里扫码登录')
  }

  /** 停止全部并释放桥。 */
  async stopAll() {
    this.started = false
    for (const runtime of this.runtimes.values()) {
      await runtime.stop().catch(() => {})
    }
    this.runtimes.clear()
    if (this.bridge) await this.bridge.dispose().catch(() => {})
    this.bridge = null
  }

  /**
   * 启动单个账号。
   * 账号 ID 一律用**规范化**形式：登录时服务端给的是 `xxx@im.bot`，重启后从
   * accounts.json 读出来的是 `xxx-im-bot`。如果通道键随来源变化，同一个微信聊天
   * 在重启后就会查不到绑定、被当成新会话。
   */
  async #startAccount(accountId, credentials) {
    const id = store.normalizeAccountId(accountId)
    if (this.runtimes.has(id)) return this.runtimes.get(id)
    const runtime = new WeChatAccountRuntime({
      accountId: id,
      credentials,
      bridge: this.bridge,
      log: this.log,
      onState: () => {},
    })
    this.runtimes.set(id, runtime)
    await runtime.start()
    return runtime
  }

  /** 按通道键找账号运行时。 */
  #runtimeForChannel(channelKey) {
    const accountId = String(channelKey).split(':')[0]
    return this.runtimes.get(accountId)
  }

  /**
   * 解析新会话的工作目录。
   * DSH 的会话头要求绝对路径，非绝对的配置会把建会话直接打挂
   * （实测报错：`session header cwd must be an absolute path`），
   * 所以这里只认绝对路径，其它一律回落到 DSH 默认目录并留一条日志。
   */
  async #resolveWorkspace() {
    const configured = String(store.loadSettings().workspace ?? '').trim()
    if (configured) {
      if (path.isAbsolute(configured)) return configured
      this.log(`工作目录配置被忽略（必须是绝对路径）：${configured}`)
    }
    const fs = this.ctx?.get?.('fs')
    if (fs?.resolve && fs?.processPath) {
      try {
        const target = await fs.resolve('.')
        const resolved = fs.processPath(target)
        if (resolved && path.isAbsolute(resolved)) return resolved
      } catch {
        /* 回落到进程目录 */
      }
    }
    return process.cwd()
  }

  // ── 扫码登录 ────────────────────────────────────────────────────────────

  /** 是否有正在进行的扫码登录（桌面端据此刷新二维码页面）。 */
  get isLoggingIn() {
    return Boolean(this.loginPromise)
  }

  /**
   * 发起一次扫码登录。
   * @returns {Promise<{ok: boolean, message: string}>} 结果
   */
  async beginLogin() {
    if (this.loginPromise) return { ok: true, message: '登录流程已在进行中' }
    const localTokens = store.listAccountIds()
      .map((id) => store.loadAccount(id)?.token)
      .filter(Boolean)

    this.login = new QrLoginSession({
      api: new ILinkApi({ log: this.log }),
      localTokens,
      log: this.log,
    })

    this.loginPromise = (async () => {
      try {
        const credentials = await this.login.run()
        if (!credentials) {
          this.lastLoginResult = this.login?.state.error || '登录未完成'
          return { ok: false, message: this.lastLoginResult }
        }
        store.saveAccount(credentials)
        if (credentials.userId) store.allow(credentials.userId)
        await this.#startAccount(credentials.accountId, {
          token: credentials.token,
          baseUrl: credentials.baseUrl,
          userId: credentials.userId,
        })
        this.lastLoginResult = `登录成功：${credentials.accountId}`
        return { ok: true, message: this.lastLoginResult }
      } catch (error) {
        const message = String(error?.message ?? error)
        this.lastLoginResult = message
        return { ok: false, message }
      } finally {
        this.loginPromise = null
      }
    })()

    return { ok: true, message: '已生成二维码，请用微信扫码' }
  }

  /** 回填手机上的验证码。 */
  submitVerifyCode(code) {
    if (!this.login) return { ok: false, message: '当前没有进行中的登录' }
    const accepted = this.login.provideVerifyCode(code)
    return accepted
      ? { ok: true, message: '验证码已提交' }
      : { ok: false, message: '验证码无效' }
  }

  /** 取消登录。 */
  cancelLogin() {
    this.login?.cancel()
    return { ok: true, message: '已取消登录' }
  }

  /** 退出某个账号。 */
  async removeAccount(accountId) {
    const runtime = this.runtimes.get(accountId)
    if (runtime) {
      await runtime.stop().catch(() => {})
      this.runtimes.delete(accountId)
    }
    store.removeAccount(accountId)
    return { ok: true, message: `已移除账号 ${accountId}` }
  }

  // ── 面板操作 ────────────────────────────────────────────────────────────

  /**
   * 启停轮询。
   * @param {boolean} enabled 是否启用
   * @returns {Promise<{ok: boolean, message: string}>} 结果
   */
  async setPolling(enabled) {
    store.saveSettings({ enabled: Boolean(enabled) })
    if (enabled) {
      this.started = false
      await this.startAll()
      return { ok: true, message: '已启动轮询' }
    }
    for (const runtime of this.runtimes.values()) await runtime.stop().catch(() => {})
    return { ok: true, message: '已停止轮询' }
  }

  /**
   * 解除一条或多条微信会话与 DSH 会话的绑定。
   * @param {string} selector 通道键（`accountId:userId`）或裸 userId
   * @returns {Promise<{ok: boolean, message: string}>} 结果
   */
  async resetSession(selector) {
    const target = String(selector ?? '')
    const settings = store.loadSettings()
    const keys = Object.keys(settings.sessions ?? {}).filter((key) => (
      key === target || channelUser(key) === target || key.endsWith(`:${target}`)
    ))
    if (!keys.length) return { ok: true, message: '没有找到对应的会话绑定' }
    for (const key of keys) {
      await this.bridge?.reset(key).catch(() => {})
      store.bindSession(key, '')
    }
    return { ok: true, message: `已重置 ${keys.length} 条会话绑定` }
  }

  /** 当前二维码 SVG。 */
  qrSvg() {
    const content = this.login?.state.qrcodeContent ?? ''
    return content ? renderQrSvg(content) : null
  }

  /** 给面板的状态快照。 */
  status() {
    const settings = store.loadSettings()
    const login = this.login?.state
    return {
      enabled: Boolean(settings.enabled),
      pairingCode: store.pairingCode(),
      workspace: settings.workspace,
      provider: settings.provider,
      model: settings.model,
      verbose: settings.verbose,
      qrAvailable: qrAvailable(),
      qrError: qrLoadError(),
      accounts: store.listAccountIds().map((accountId) => {
        const credentials = store.loadAccount(accountId)
        const runtime = this.runtimes.get(accountId)
        return {
          accountId,
          userId: credentials?.userId ? redact(credentials.userId) : '',
          savedAt: credentials?.savedAt ?? '',
          baseUrl: credentials?.baseUrl ?? '',
          polling: Boolean(runtime?.state.polling),
          connected: Boolean(runtime?.state.connected),
          received: runtime?.state.received ?? 0,
          replied: runtime?.state.replied ?? 0,
          lastError: runtime?.state.lastError ?? '',
        }
      }),
      allowFrom: settings.allowFrom.map((id) => ({ id, masked: redact(id) })),
      approvals: (this.bridge?.listApprovals() ?? []).map((entry) => ({
        toolName: entry.toolName,
        user: redact(channelUser(entry.channel)),
        requestedAt: entry.requestedAt,
      })),
      sessions: Object.entries(settings.sessions ?? {}).map(([key, sessionId]) => ({
        channel: key,
        user: redact(channelUser(key)),
        sessionId,
        running: Boolean(this.bridge?.isRunning(key)),
      })),
      login: login
        ? {
          status: login.status,
          error: login.error,
          verifyCodeRequired: login.verifyCodeRequired,
          refreshCount: login.refreshCount,
          hasQr: Boolean(login.qrcodeContent),
          startedAt: login.startedAt,
        }
        : null,
      lastLoginResult: this.lastLoginResult,
      logFile: this.log.file ?? '',
      logTail: readLog(60),
    }
  }
}
