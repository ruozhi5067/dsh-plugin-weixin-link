/**
 * 单个微信 Bot 账号的运行时：长轮询收消息 → 授权/命令/媒体处理 → 交给 DSH 桥 → 回发。
 *
 * 轮询节奏、错误退避、游标语义、typing 保活全部照抄官方
 * Tencent/openclaw-weixin v2.4.10 的 src/monitor/monitor.ts、src/channel.ts、
 * src/messaging/send.ts、src/messaging/typing.ts。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ILinkApi, ILinkError } from './ilink/api.js'
import { ITEM_TYPE, POLL_BACKOFF_AFTER, POLL_BACKOFF_MS, POLL_RETRY_MS, TIMEOUTS, TYPING_KEEPALIVE_MS } from './ilink/constants.js'
import { downloadInboundMedia } from './ilink/media.js'
import { chunkText, toWeChatText } from './ilink/markdown.js'
import {
  allow, isAllowed, loadContextToken, loadCursor, matchesPairingCode, pairingCode,
  recordStat, saveContextToken, saveCursor, sessionFor, stateDir,
} from './store.js'

/** typing 保活的安全上限，避免 idle 事件丢失时无限续期。 */
const TYPING_MAX_MS = 5 * 60_000
/** getconfig 的 typing_ticket 缓存时长（官方为 now + random()*24h）。 */
const TICKET_TTL_MS = 24 * 60 * 60_000
/** 去重 LRU 容量。 */
const DEDUPE_LIMIT = 500

/**
 * 延时，可被 abort。
 * @param {number} ms 毫秒
 * @param {AbortSignal} signal 信号
 * @returns {Promise<void>} 完成
 */
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve()
    return
  }
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    resolve()
  }, { once: true })
})

/**
 * 从入站消息里取纯文本（含语音转写与引用摘要）。
 * @param {any} msg 入站消息
 * @returns {string} 文本
 */
function extractText(msg) {
  const parts = []
  const quoted = msg?.item_list?.find((item) => item?.ref_msg)?.ref_msg
  if (quoted) {
    const title = String(quoted.title ?? '').trim()
    const inner = quoted.message_item?.text_item?.text
    const text = title || (inner ? String(inner).trim() : '')
    if (text) parts.push(`[引用消息] ${text}`)
  }
  for (const item of msg?.item_list ?? []) {
    if (item?.type === ITEM_TYPE.TEXT && item.text_item?.text) {
      parts.push(String(item.text_item.text))
    } else if (item?.type === ITEM_TYPE.VOICE && item.voice_item?.text) {
      // 微信自带的语音转写文本，可直接当用户输入。
      parts.push(String(item.voice_item.text))
    }
  }
  return parts.join('\n').trim()
}

/** 一个微信账号的运行时。 */
export class WeChatAccountRuntime {
  /**
   * @param {object} options 选项
   * @param {string} options.accountId 账号 ID
   * @param {object} options.credentials 凭证
   * @param {import('./bridge.js').WeChatDshBridge} options.bridge DSH 桥
   * @param {(msg: string) => void} options.log 日志
   * @param {(state: object) => void} [options.onState] 状态变化回调
   */
  constructor({ accountId, credentials, bridge, log, onState }) {
    this.accountId = accountId
    this.credentials = credentials
    this.bridge = bridge
    this.log = (msg) => log(`[${accountId}] ${msg}`)
    this.onState = onState ?? (() => {})

    this.api = new ILinkApi({ baseUrl: credentials.baseUrl, token: credentials.token, log: this.log })
    this.cursor = loadCursor(accountId)
    this.nextTimeout = TIMEOUTS.getUpdates
    this.controller = new AbortController()
    this.running = false
    this.failures = 0
    this.dedupe = new Set()
    this.dedupeOrder = []
    /** @type {Map<string, {ticket: string, expiresAt: number}>} */
    this.tickets = new Map()
    /** @type {Map<string, {timer: NodeJS.Timeout, startedAt: number}>} */
    this.typing = new Map()

    this.state = {
      accountId,
      userId: credentials.userId ?? '',
      connected: false,
      polling: false,
      lastMessageAt: 0,
      lastError: '',
      received: 0,
      replied: 0,
      cursor: this.cursor,
    }
  }

  /** 更新对外可见状态。 */
  #publish(patch = {}) {
    Object.assign(this.state, patch)
    try {
      this.onState(this.state)
    } catch {
      /* 面板回调失败不影响收发 */
    }
  }

  /** 启动：生命周期通知 + 长轮询。 */
  async start() {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    this.#publish({ polling: true, lastError: '' })
    await this.api.notify('start')
    this.#pollLoop().catch((error) => {
      this.log(`轮询循环退出：${error?.message ?? error}`)
    })
  }

  /** 停止：取消轮询、结束 typing、生命周期通知。 */
  async stop() {
    if (!this.running) return
    this.running = false
    this.controller.abort()
    for (const userId of [...this.typing.keys()]) await this.stopTyping(userId)
    await this.api.notify('stop').catch(() => {})
    this.#publish({ polling: false, connected: false })
  }

  /** 长轮询主循环。 */
  async #pollLoop() {
    while (this.running) {
      try {
        const response = await this.api.getUpdates(this.cursor, this.nextTimeout)
        this.failures = 0

        const suggested = Number(response?.longpolling_timeout_ms ?? 0)
        if (suggested > 0) this.nextTimeout = suggested

        const next = response?.get_updates_buf
        if (typeof next === 'string' && next !== '') {
          this.cursor = next
          saveCursor(this.accountId, next)
          this.#publish({ cursor: next })
        }

        this.#publish({ connected: true, lastError: '' })

        for (const msg of response?.msgs ?? []) {
          if (!this.running) break
          await this.#handleMessage(msg)
        }
      } catch (error) {
        if (!this.running) break

        if (error instanceof ILinkError && error.isStaleToken) {
          this.#publish({ connected: false, lastError: '微信会话已失效，请重新扫码登录' })
          this.log('会话失效（-14），停止轮询，需要重新扫码登录')
          this.running = false
          break
        }

        this.failures += 1
        const message = String(error?.message ?? error)
        this.#publish({ connected: false, lastError: message })
        this.log(`拉取消息失败（第 ${this.failures} 次）：${message}`)

        if (this.failures >= POLL_BACKOFF_AFTER) {
          this.failures = 0
          await sleep(POLL_BACKOFF_MS, this.controller.signal)
        } else {
          await sleep(POLL_RETRY_MS, this.controller.signal)
        }
      }
    }
    this.#publish({ polling: false, connected: false })
  }

  /** 处理一条入站消息。 */
  async #handleMessage(msg) {
    // 只处理用户发来的、已完成的消息（Bot 自己的回声是 message_type 2）。
    if (Number(msg?.message_type ?? 0) !== 1) return
    const state = Number(msg?.message_state ?? 2)
    if (state !== 2) return

    const userId = String(msg?.from_user_id ?? '')
    if (!userId) return

    const dedupeKey = String(msg?.message_id ?? msg?.item_list?.[0]?.msg_id ?? '')
    if (dedupeKey && !this.#firstSight(dedupeKey)) return

    this.#publish({ lastMessageAt: Date.now(), received: this.state.received + 1 })

    // 每条入站消息都签发新的 context_token，必须刷新。
    const token = String(msg?.context_token ?? '')
    if (token) saveContextToken(this.accountId, userId, token)

    const text = extractText(msg)

    // ── 访问控制 ──
    if (!isAllowed(userId)) {
      if (matchesPairingCode(text)) {
        allow(userId)
        this.log(`用户 ${redact(userId)} 通过配对码加入白名单`)
        await this.sendText(userId, `配对成功 ✅\n现在你可以直接在这里给 DSH 派活了。\n发送 /help 查看可用命令。`)
        return
      }
      this.log(`拒绝未授权用户 ${redact(userId)} 的消息（配对码：/panel 查看）`)
      return
    }

    // ── 待授权应答 ──
    // 有待批请求时，这条消息必须当答复处理：否则用户以为自己在回答，实际却给 DSH 派了新活。
    if (this.bridge.answerApproval(this.#channelKey(userId), text)) return

    // ── 命令 ──
    const command = text.startsWith('/') ? text.split(/\s+/)[0].toLowerCase() : ''
    if (command) {
      const handled = await this.#runCommand(command, text, userId)
      if (handled) return
    }

    // ── 媒体 ──
    let mediaNote = ''
    const media = await this.#saveInboundMedia(msg)
    if (media) mediaNote = media

    const prompt = [text, mediaNote].filter(Boolean).join('\n\n').trim()
    if (!prompt) return

    try {
      const channelKey = this.#channelKey(userId)
      await this.bridge.submit(channelKey, prompt, sessionFor(channelKey))
      this.#publish({ lastError: '' })
    } catch (error) {
      const message = String(error?.message ?? error)
      this.#publish({ lastError: message })
      this.log(`提交到 DSH 失败：${message}`)
      await this.sendText(userId, `❌ 提交到 DSH 失败：${message}`)
    }
  }

  /** 处理斜杠命令；返回 true 表示已处理。 */
  async #runCommand(command, text, userId) {
    const argument = text.slice(command.length).trim()
    switch (command) {
      case '/help':
        await this.sendText(userId, [
          'DSH × 微信 ClawBot 可用命令：',
          '/new — 开一段全新的 DSH 会话（清空上下文）',
          '/stop — 中止当前这一轮',
          '/permission — 查看权限档位；/permission <档位> 切换',
          '/status — 查看当前会话与运行状态',
          '/whoami — 查看你的微信用户 ID',
          '/help — 显示本帮助',
          '',
          '直接发消息就是给 DSH 派活；图片和文件会自动存到本机并告诉 DSH 路径。',
          'DSH 需要授权某个操作时，微信里会问你，回复「同意」或「拒绝」即可。',
        ].join('\n'))
        return true

      case '/permission': {
        const channelKey = this.#channelKey(userId)
        if (!argument) {
          const info = this.bridge.permissionInfo(channelKey)
          if (!info) {
            await this.sendText(userId, '这个 DSH 没有启用权限档位（permissionPresets 不可用），或还没有会话。')
            return true
          }
          const lines = [`当前权限档位：${info.current}`, '', '可选：']
          for (const option of info.options) {
            lines.push(`  ${option.value} — ${option.name}${option.description ? `（${option.description}）` : ''}`)
          }
          lines.push('', '切换：/permission <档位>')
          await this.sendText(userId, lines.join('\n'))
          return true
        }
        try {
          const next = this.bridge.setPermission(channelKey, argument)
          await this.sendText(userId, `已切换权限档位：${next}`)
        } catch (error) {
          await this.sendText(userId, `切换权限失败：${error?.message ?? error}`)
        }
        return true
      }

      case '/whoami':
        await this.sendText(userId, `你的微信用户 ID：${userId}`)
        return true

      case '/new': {
        await this.bridge.reset(this.#channelKey(userId))
        await this.sendText(userId, '已开新会话，之前的上下文不再带入。')
        return true
      }

      case '/stop': {
        const ok = this.bridge.abort(this.#channelKey(userId))
        await this.sendText(userId, ok ? '已请求中止当前这一轮。' : '当前没有在跑的会话。')
        return true
      }

      case '/status': {
        const binding = this.bridge.bindings.get(this.#channelKey(userId))
        await this.sendText(userId, [
          `账号：${this.accountId}`,
          `微信用户：${redact(userId)}`,
          `DSH 会话：${binding?.sessionId || '（尚未创建，发一条消息即可）'}`,
          `运行中：${this.bridge.isRunning(this.#channelKey(userId)) ? '是' : '否'}`,
          `轮询：${this.state.polling ? '正常' : '已停止'}`,
        ].join('\n'))
        return true
      }

      default:
        return false
    }
  }

  /** 下载入站媒体到本机，返回给 Agent 的说明文本。 */
  async #saveInboundMedia(msg) {
    const items = (msg?.item_list ?? []).filter((item) => [2, 3, 4, 5].includes(Number(item?.type ?? 0)))
    if (!items.length) return ''

    const dir = path.join(stateDir(), 'inbox', this.accountId)
    const notes = []
    for (const item of items) {
      let media
      try {
        media = await downloadInboundMedia(item)
      } catch (error) {
        this.log(`媒体下载失败：${error?.message ?? error}`)
      }
      if (!media) {
        notes.push(`（收到一条微信媒体消息，但下载或解密失败，类型 ${item?.type}）`)
        continue
      }
      try {
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `${Date.now()}-${path.basename(media.name)}`)
        fs.writeFileSync(file, media.bytes)
        notes.push(`（用户通过微信发来了一个${media.kind === 'image' ? '图片' : media.kind === 'video' ? '视频' : media.kind === 'voice' ? '语音' : '文件'}，已保存到本机：${file}）`)
      } catch (error) {
        this.log(`媒体落盘失败：${error?.message ?? error}`)
      }
    }
    return notes.join('\n')
  }

  /** 账号 + 用户的通道键，与 runtime/bridge 的会话映射保持一致。 */
  #channelKey(userId) {
    return `${this.accountId}:${userId}`
  }

  /** 去重：首次见到返回 true。 */
  #firstSight(key) {
    if (this.dedupe.has(key)) return false
    this.dedupe.add(key)
    this.dedupeOrder.push(key)
    while (this.dedupeOrder.length > DEDUPE_LIMIT) {
      const oldest = this.dedupeOrder.shift()
      this.dedupe.delete(oldest)
    }
    return true
  }

  /** 取（并缓存）typing_ticket。 */
  async #ticket(userId) {
    const cached = this.tickets.get(userId)
    if (cached && cached.expiresAt > Date.now()) return cached.ticket
    const token = loadContextToken(this.accountId, userId)
    const ticket = await this.api.getConfig(userId, token)
    this.tickets.set(userId, { ticket, expiresAt: Date.now() + TICKET_TTL_MS })
    return ticket
  }

  /**
   * 开始/续期"正在输入"。status 1 与 2 必须成对。
   * @param {string} userId 用户 ID
   * @returns {Promise<void>} 完成
   */
  async startTyping(userId) {
    const existing = this.typing.get(userId)
    if (existing) return
    const ticket = await this.#ticket(userId)
    if (!ticket) return

    const startedAt = Date.now()
    await this.api.sendTyping(userId, ticket, 1)
    const timer = setInterval(() => {
      if (Date.now() - startedAt > TYPING_MAX_MS) {
        this.stopTyping(userId).catch(() => {})
        return
      }
      this.api.sendTyping(userId, ticket, 1).catch(() => {})
    }, TYPING_KEEPALIVE_MS)
    timer.unref?.()
    this.typing.set(userId, { timer, startedAt })
  }

  /**
   * 结束"正在输入"。
   * @param {string} userId 用户 ID
   * @returns {Promise<void>} 完成
   */
  async stopTyping(userId) {
    const entry = this.typing.get(userId)
    if (!entry) return
    this.typing.delete(userId)
    clearInterval(entry.timer)
    const ticket = await this.#ticket(userId)
    await this.api.sendTyping(userId, ticket, 2)
  }

  /**
   * 回发一条文本（自动过 Markdown 过滤 + 分片）。
   * @param {string} userId 目标用户
   * @param {string} text 原始文本
   * @returns {Promise<boolean>} 是否全部发出
   */
  async sendText(userId, text) {
    const plain = toWeChatText(text)
    if (!plain.trim()) return false
    const contextToken = loadContextToken(this.accountId, userId)
    if (!contextToken) {
      // 官方在缺 token 时告警后仍照发；第三方报告会被拒，这里保持官方行为并留痕。
      this.log(`用户 ${redact(userId)} 还没有 context_token，仍尝试发送`)
    }
    const chunks = chunkText(plain, 2000)
    let ok = true
    for (const chunk of chunks) {
      try {
        await this.api.sendMessage({
          toUserId: userId,
          item: { type: 1, text_item: { text: chunk } },
          contextToken,
        })
        this.#publish({ replied: this.state.replied + 1 })
        recordStat(userId, { replies: this.state.replied })
      } catch (error) {
        ok = false
        const message = String(error?.message ?? error)
        this.log(`发送失败：${message}`)
        this.#publish({ lastError: message })
        break
      }
    }
    return ok
  }

  /** 该账号当前配对码（面板展示）。 */
  pairingCode() {
    return pairingCode()
  }
}

/**
 * 日志脱敏：前 4 后 4，中间打码（照抄官方 util/redact.ts）。
 * @param {string} value 原始值
 * @returns {string} 脱敏值
 */
export function redact(value) {
  const text = String(value ?? '')
  if (text.length <= 8) return text ? `${text.slice(0, 2)}***` : ''
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}
