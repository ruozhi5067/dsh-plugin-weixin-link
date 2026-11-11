/**
 * 微信会话 ↔ DSH Agent 会话 的桥接。
 *
 * 每条微信聊天（当前以 userId 为键）固定绑定一个 DSH Session：
 *   - 第一次收到消息时创建；之后复用内存里的 live Agent；
 *   - 进程重启后用 `ctx.agents.resume()` 从会话日志恢复同一段上下文；
 *   - `/new` 或面板解绑会丢弃绑定，下一条消息开新会话。
 *
 * 驱动方式照抄官方无头实现 @deepseek-ai/dsh-headless/lib/index.js：
 *   create({ sessionId, meta: { cwd }, agentOptions })
 *   agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
 *   监听 'session/event' 的 assistant/message 取**已提交**的助手正文（不是未提交的 attempt 流）
 *   监听 'agent/status' 判断 idle/running
 */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from './message.js'

/**
 * 从一条已提交的 assistant/message 事件里取某种内容块。
 *
 * 官方无头实现（dsh-headless/lib/json-stream）明确写着
 * “text and reasoning come from committed `assistant/message` content”，
 * 所以深度思考**不需要**去接未提交的 attempt 流，直接读已提交内容即可。
 * @param {any} event 会话事件
 * @param {'text'|'reasoning'} kind 块类型
 * @returns {string} 拼接后的文本，没有该类型时为空串
 */
function eventBlocks(event, kind) {
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === kind && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * 从一条已提交的 assistant/message 事件里取正文。
 * @param {any} event 会话事件
 * @returns {string} 文本，纯工具调用步骤为空串
 */
function eventText(event) {
  return eventBlocks(event, 'text')
}

/** 显示分级：值越大说得越多。 */
const VERBOSE_ORDER = { final: 0, tools: 1, all: 2 }

/** 等待微信授权的上限；超时按取消处理（不授权）。 */
const APPROVAL_TIMEOUT_MS = 5 * 60_000

/** 回复里表示同意的词。 */
const APPROVE_WORDS = new Set(['同意', '允许', '可以', '批准', '好', '好的', '行', 'ok', 'OK', 'okay', 'yes', 'y', 'allow', 'approve', '/approve'])
/** 回复里表示拒绝的词。 */
const REJECT_WORDS = new Set(['拒绝', '不行', '不要', '否', 'no', 'n', 'deny', 'reject', '/deny'])

/**
 * 从会话日志里找回这次工具调用的参数，授权时给用户看原始内容。
 * 只往回扫固定条数，避免长会话里做全量遍历。
 * @param {any} agent 实时 Agent
 * @param {string} callId 工具调用 ID
 * @returns {string} 参数 JSON 字符串，找不到为空串
 */
function findToolArguments(agent, callId) {
  if (!callId) return ''
  const session = agent?.session
  if (typeof session?.eventAt !== 'function' || typeof session?.seq !== 'number') return ''
  const end = Number(session.seq)
  const start = Math.max(0, end - 300)
  for (let seq = end - 1; seq >= start; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/call' && String(event.data?.callId ?? '') === String(callId)) {
      return String(event.data?.arguments ?? '')
    }
  }
  return ''
}

/**
 * 一条授权请求的微信文案。
 * @param {any} req approval/request 的 payload
 * @param {string} args 该次工具调用的参数（可能为空）
 * @param {number} timeoutMs 有效期
 * @returns {string} 文案
 */
function formatApprovalRequest(req, args, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000)
  const lines = ['🔐 DSH 需要授权', '', `工具：${String(req?.toolName ?? '未知')}`]
  if (args) lines.push(`内容：${clip(args, 400)}`)
  const reason = req?.displayReason?.zh ?? req?.displayReason?.en ?? req?.reason
  if (reason) lines.push(`原因：${clip(reason, 200)}`)
  lines.push('', `回复「同意」执行一次，「拒绝」放弃（${seconds} 秒内有效）。`)
  return lines.join('\n')
}

/**
 * 工具参数/结果太长就没必要整个塞进微信。
 * @param {string} text 原始文本
 * @param {number} limit 上限
 * @returns {string} 截断后的文本
 */
function clip(text, limit) {
  const value = String(text ?? '').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * 一条工具调用的微信文案。
 * @param {string} name 工具名
 * @param {string} args 参数（JSON 字符串）
 * @returns {string} 文案
 */
function formatToolCall(name, args) {
  const body = clip(args, 400)
  return body ? `🔧 ${name}\n${body}` : `🔧 ${name}`
}

/**
 * 一条工具结果的微信文案：只报状态与耗时，不回传结果正文（可能极大）。
 * @param {string} name 工具名
 * @param {any} event tool/result 事件
 * @param {number} durationMs 耗时毫秒，未知为 -1
 * @returns {string} 文案
 */
function formatToolResult(name, event, durationMs) {
  const seconds = durationMs >= 0 ? `（${(durationMs / 1000).toFixed(1)}s）` : ''
  const error = event?.data?.error
  if (error) {
    const reason = error.reason || error.name || error.code || '未知错误'
    return `❌ ${name} 失败${seconds}：${clip(reason, 200)}`
  }
  return `✅ ${name} 完成${seconds}`
}

/**
 * 一段深度思考的微信文案。
 * 思考可能很长，超过上限就截断——手机上刷几十条思考没有意义。
 * @param {string} text 思考正文
 * @returns {string} 文案
 */
function formatReasoning(text) {
  const limit = 4000
  const body = text.length > limit ? `${text.slice(0, limit)}\n…（思考过长，已截断）` : text
  return `🧠 深度思考\n${body}`
}

/**
 * 把会话事件里的失败原因变成一句人话。
 * @param {any} reason turn/end 的 reason
 * @returns {string} 描述
 */
function describeTurnEnd(reason) {
  const kind = reason?.kind
  if (kind === 'completed') return ''
  if (kind === 'aborted') return `本轮已中止（${reason?.reason?.kind ?? 'unknown'}）`
  if (kind === 'blocked') return '本轮被阻断'
  if (kind === 'error') return `本轮出错：${reason?.error?.message ?? 'unknown'}`
  if (kind === 'max-tokens') return '本轮达到输出上限'
  if (kind === 'interrupted') return '本轮被中断'
  return kind ? `本轮结束：${kind}` : ''
}

/** 单条微信会话的桥接状态。 */
class Binding {
  constructor(channelKey) {
    this.channelKey = channelKey
    this.sessionId = ''
    this.handle = null
    this.started = false
  }
}

export class WeChatDshBridge {
  /**
   * @param {object} options 选项
   * @param {object} options.ctx 已注入 agent 相关服务的插件上下文
   * @param {(msg: string) => void} options.log 日志
   * @param {(channelKey: string, text: string) => Promise<void>} options.sendText 回发文本
   * @param {(channelKey: string, on: boolean) => void} options.sendTyping 输入状态
   * @param {() => Promise<string>} options.resolveWorkspace 解析新会话的工作目录
   * @param {(channelKey: string, sessionId: string) => void} [options.onSessionBound] 绑定回调（面板/持久化）
   * @param {() => {provider?: string, model?: string}} [options.modelSelection] 覆盖模型
   * @param {() => ('final'|'tools'|'all')} [options.verboseLevel] 微信里说多少：只最终回复 / 加工具调用 / 再加深度思考
   * @param {number} [options.approvalTimeoutMs] 等微信授权的上限
   */
  constructor({ ctx, log, sendText, sendTyping, resolveWorkspace, onSessionBound, modelSelection, verboseLevel, approvalTimeoutMs }) {
    this.ctx = ctx
    this.log = log
    this.sendText = sendText
    this.sendTyping = sendTyping
    this.resolveWorkspace = resolveWorkspace
    this.onSessionBound = onSessionBound ?? (() => {})
    this.modelSelection = modelSelection ?? (() => ({}))
    this.verboseLevel = verboseLevel ?? (() => 'all')
    this.approvalTimeoutMs = Number.isFinite(approvalTimeoutMs) && approvalTimeoutMs > 0 ? approvalTimeoutMs : APPROVAL_TIMEOUT_MS

    /** @type {Map<string, Binding>} channelKey → 绑定 */
    this.bindings = new Map()
    /** sessionId → channelKey，事件分发用 */
    this.bySession = new Map()
    /** 正在跑一轮的 channel，用于 typing 状态收尾。 */
    this.running = new Set()
    /** callId → { name, time }，把 tool/result 对上 tool/call。 */
    this.toolCalls = new Map()
    /** channelKey → 待授权的请求；等待期间该通道的下一条消息按答复处理。 */
    this.approvals = new Map()
    this.disposers = []
  }

  /** 订阅会话事件、agent 状态与授权请求。 */
  start() {
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      this.#onSessionEvent(session, event)
    }))
    this.disposers.push(this.ctx.on('agent/status', ({ agent, status }) => {
      this.#onAgentStatus(agent, status)
    }))
    // 授权请求是 waterfall：返回结果就是「认领」，调用 next() 才是交给别的 answerer。
    this.disposers.push(this.ctx.on('approval/request', (req, next) => this.#onApprovalRequest(req, next)))
  }

  /** 退订并释放所有由本桥创建的 agent。 */
  async dispose() {
    // 还在等授权的请求一律按取消处理，绝不让它们悬着。
    for (const channelKey of [...this.approvals.keys()]) {
      this.#settleApproval(channelKey, 'cancelled')
    }
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 退订失败不阻断 */
      }
    }
    for (const binding of this.bindings.values()) {
      if (!binding.handle) continue
      try {
        await binding.handle.dispose()
      } catch (error) {
        this.log(`释放 DSH 会话 ${binding.sessionId} 失败：${error?.message ?? error}`)
      }
    }
    this.bindings.clear()
    this.bySession.clear()
    this.running.clear()
  }

  /**
   * 取或创建该微信会话对应的 DSH Agent。
   * @param {string} channelKey 通道键
   * @param {string} knownSessionId 已持久化的会话 ID（可为空）
   * @returns {Promise<Binding>} 绑定
   */
  async ensureBinding(channelKey, knownSessionId) {
    const existing = this.bindings.get(channelKey)
    if (existing?.handle) {
      // 句柄还在不代表 agent 还活着：GUI 里关掉那个会话、或它自己出错销毁，
      // 都会让注册表里没有它。这时必须重建绑定，否则后续消息会一直打在空气上。
      const registry = this.ctx.get?.('agents')
      const live = typeof registry?.get === 'function' ? registry.get(existing.sessionId) : undefined
      if (live === undefined || live === existing.handle.agent) return existing
      this.log(`微信会话 ${existing.sessionId} 已不在注册表中，重新建立绑定`)
      this.bySession.delete(existing.sessionId)
      this.bindings.delete(channelKey)
    }

    const binding = existing ?? new Binding(channelKey)
    this.bindings.set(channelKey, binding)

    const agents = this.ctx.get('agents')
    if (!agents) throw new Error('DSH agents 服务不可用，无法创建会话')

    const wanted = knownSessionId || binding.sessionId
    if (wanted) {
      // 该会话可能已经在别的窗口里活着（例如用户从 GUI 打开过），先复用。
      const live = agents.get?.(wanted)
      if (live) {
        binding.sessionId = wanted
        binding.handle = { agent: live, dispose: async () => {} }
        this.bySession.set(wanted, channelKey)
        return binding
      }
      try {
        const handle = await agents.resume({
          resumeSessionId: wanted,
          ...this.#agentOptions(),
        })
        binding.sessionId = wanted
        binding.handle = handle
        this.bySession.set(wanted, channelKey)
        this.log(`已恢复 DSH 会话 ${wanted}（微信 ${channelKey}）`)
        return binding
      } catch (error) {
        this.log(`恢复 DSH 会话 ${wanted} 失败（改为新建）：${error?.message ?? error}`)
      }
    }

    const sessionId = `session-${randomUUID()}`
    const meta = { cwd: await this.resolveWorkspace() }
    const handle = await agents.create({
      sessionId,
      meta,
      ...this.#agentOptions(),
    })
    binding.sessionId = handle.agent?.id ?? sessionId
    binding.handle = handle
    this.bySession.set(binding.sessionId, channelKey)
    this.onSessionBound(channelKey, binding.sessionId)
    this.log(`已为微信 ${channelKey} 新建 DSH 会话 ${binding.sessionId}`)
    // 只有「新建」才提示：上下文被换掉是用户最需要知道的意外。
    // 恢复已有会话时不提示，否则每次重启后的第一条消息都要被刷一句。
    this.#emit(channelKey, `🆕 已开新会话（${binding.sessionId}）\n想继续上一段对话就直接发消息；想再换一段发 /new。`)
    return binding
  }

  /**
   * 把一条微信消息送进对应 DSH 会话。
   * @param {string} channelKey 通道键
   * @param {string} text 文本
   * @param {string} [knownSessionId] 已持久化的会话 ID
   * @returns {Promise<string>} 实际使用的会话 ID
   */
  async submit(channelKey, text, knownSessionId) {
    const binding = await this.ensureBinding(channelKey, knownSessionId)
    const agent = binding.handle?.agent
    if (!agent) throw new Error('DSH 会话不可用')
    this.running.add(channelKey)
    this.sendTyping(channelKey, true)
    // followup() 直接把消息塞进 inbox，不会补 id/role：必须给出去官方工厂等价的完整消息。
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    return binding.sessionId
  }

  /**
   * 中止该微信会话当前这一轮。
   * @param {string} channelKey 通道键
   * @returns {boolean} 是否找到了会话
   */
  abort(channelKey) {
    const binding = this.bindings.get(channelKey)
    const agent = binding?.handle?.agent
    if (!agent) return false
    try {
      agent.cancel?.({ kind: 'user' })
      return true
    } catch (error) {
      this.log(`中止会话失败：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 丢弃绑定并释放 agent（`/new` 与面板解绑用）。
   * @param {string} channelKey 通道键
   * @returns {Promise<void>} 完成
   */
  async reset(channelKey) {
    const binding = this.bindings.get(channelKey)
    this.bindings.delete(channelKey)
    this.running.delete(channelKey)
    if (!binding) return
    this.bySession.delete(binding.sessionId)
    if (binding.handle) {
      try {
        await binding.handle.dispose()
      } catch (error) {
        this.log(`释放 DSH 会话失败：${error?.message ?? error}`)
      }
    }
  }

  /** 该 channel 是否正在跑。 */
  isRunning(channelKey) {
    return this.running.has(channelKey)
  }

  /**
   * 解析这次建会话要用的模型路由。
   *
   * 顺序：插件设置里的显式覆盖 → DSH 的默认模型选择（`agentDefaultModel`）。
   * **必须解析出 provider + model**：dsh-agent-loop 用
   * `ctx.systemPrompt.variable('model', (context) => context.agent?.options.model)`
   * 供 `{{model}}` 变量，空值会让 prompt 组装直接失败
   * （`prompt variable "{{model}}" has no value ... section "deployment:persona-prefix"`）。
   * @returns {{provider: string, model: string, reasoningEffort?: string}} 路由
   */
  #resolveRoute() {
    const override = this.modelSelection() ?? {}
    const overrideProvider = String(override.provider ?? '').trim()
    const overrideModel = String(override.model ?? '').trim()
    if (overrideProvider && overrideModel) {
      return { provider: overrideProvider, model: overrideModel }
    }

    const fallback = this.ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {}
    const provider = String(fallback.provider ?? '').trim()
    const model = String(fallback.model ?? '').trim()
    if (!provider || !model) {
      throw new Error('无法确定会话模型：DSH 没有默认模型，插件设置里也没指定 provider/model')
    }
    const route = { provider, model }
    if (fallback.reasoningEffort !== undefined) route.reasoningEffort = fallback.reasoningEffort
    return route
  }

  /**
   * AgentOptions + setup。
   *
   * setup 照抄官方 `installModelSelection`（dsh-agent/model-selection）的两条作用域监听：
   * 组装 prompt 时把 provider/model 写进 variables，请求时固定路由。
   * 插件不会中途换模型，所以省掉官方的“换模型通知”那条。
   * @returns {{agentOptions: object, setup: (agentCtx: any) => void}} create/resume 的参数
   */
  #agentOptions() {
    const route = this.#resolveRoute()
    const agentOptions = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    }
    const setup = (agentCtx) => {
      const selection = { current: agentOptions, assembled: undefined }
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selected = selection.current
        const assembled = await next()
        selection.assembled = selected
        return {
          ...assembled,
          variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
        }
      })
      agentCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        const selected = selection.assembled
        if (selected === undefined) return resolved
        const { reasoningEffort: _inherited, ...rest } = resolved
        return {
          ...rest,
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
        }
      })
    }
    return { agentOptions, setup }
  }

  /** 当前显示分级（面板可改）。 */
  #level() {
    try {
      const value = String(this.verboseLevel?.() ?? 'all')
      return value in VERBOSE_ORDER ? value : 'all'
    } catch {
      return 'all'
    }
  }

  /** 该分级是否至少说到 `level`。 */
  #speaks(level) {
    return VERBOSE_ORDER[this.#level()] >= VERBOSE_ORDER[level]
  }

  /** 统一回发入口，失败只记日志。 */
  #emit(channelKey, text) {
    if (!text) return
    this.sendText(channelKey, text).catch((error) => {
      this.log(`回发微信失败：${error?.message ?? error}`)
    })
  }

  /**
   * 会话日志 → 微信。
   *
   * 显示分级：
   *   final — 只发助手最终正文
   *   tools — 再加 🔧 工具调用 / ✅ 工具结果
   *   all   — 再加 🧠 深度思考
   * 事件顺序就是日志顺序，所以手机上看到的是真实的时间线。
   */
  #onSessionEvent(session, event) {
    const channelKey = this.bySession.get(session?.id)
    if (!channelKey) return

    switch (event?.type) {
      case 'assistant/message': {
        if (this.#speaks('all')) {
          const reasoning = eventBlocks(event, 'reasoning')
          if (reasoning) this.#emit(channelKey, formatReasoning(reasoning))
        }
        const text = eventText(event)
        if (text) this.#emit(channelKey, text)
        return
      }

      case 'tool/call': {
        const callId = String(event.data?.callId ?? '')
        const name = String(event.data?.name ?? '工具')
        if (callId) this.toolCalls.set(callId, { name, time: Number(event.time ?? 0) })
        if (this.#speaks('tools')) this.#emit(channelKey, formatToolCall(name, event.data?.arguments))
        return
      }

      case 'tool/result': {
        const callId = String(event.data?.message?.toolCallId ?? '')
        const recorded = this.toolCalls.get(callId)
        if (callId) this.toolCalls.delete(callId)
        if (!this.#speaks('tools')) return
        const name = recorded?.name ?? '工具'
        const duration = recorded?.time ? Number(event.time ?? 0) - recorded.time : -1
        this.#emit(channelKey, formatToolResult(name, event, duration))
        return
      }

      case 'turn/end': {
        const message = describeTurnEnd(event.data?.reason)
        if (message) this.#emit(channelKey, message)
      }
    }
  }

  /** 状态变化：idle 时收尾 typing。 */
  #onAgentStatus(agent, status) {
    if (!agent?.id) return
    const channelKey = this.bySession.get(agent.id)
    if (!channelKey) return
    if (status === 'running') {
      this.running.add(channelKey)
      this.sendTyping(channelKey, true)
      return
    }
    if (status === 'idle') {
      this.running.delete(channelKey)
      this.sendTyping(channelKey, false)
    }
  }

  /* ── 微信端批权限 ────────────────────────────────────────────────────── */

  /**
   * 认领一条授权请求，改为在微信里问用户。
   *
   * 约定（对齐 DSH 的 `approval/request` waterfall）：
   *   - 只认领**本插件创建的微信会话**；其它 agent 一律 `next()` 交还给别的 answerer；
   *   - 返回 outcome 即认领，`'allowed-once'` 是唯一的授权值 —— 只能批**一次**，不是永久放行；
   *   - 请求自带的 signal 被中止（用户 /stop、轮次结束）→ 返回 `'cancelled'`；
   *   - 超时 → `'cancelled'`（不授权），并在微信里说明。
   * @param {any} req approval/request 的 payload
   * @param {() => Promise<string>} next 交给下一个 answerer
   * @returns {Promise<string>} ApprovalOutcome
   */
  async #onApprovalRequest(req, next) {
    const channelKey = this.bySession.get(req?.agent?.id)
    // 不是微信会话 → 不插手 DSH 原本的审批流程。
    if (!channelKey) return next()
    // 同一通道已有待批请求：交给别的 answerer，避免两条请求互相顶掉。
    if (this.approvals.has(channelKey)) return next()

    const toolName = String(req?.toolName ?? '未知工具')
    const args = findToolArguments(req?.agent, req?.callId)
    this.log(`微信会话请求授权：${toolName}${args ? ` ${clip(args, 120)}` : ''}`)

    return await new Promise((resolve) => {
      // 不加 unref：这个定时器是「未决 Promise 的结算者」，让事件循环提前退出会让审批永远悬着。
      // 它一定会在同意/拒绝/中止/超时/dispose 四条路径之一被 clearTimeout。
      const timer = setTimeout(() => {
        this.#settleApproval(channelKey, 'cancelled')
        this.#emit(channelKey, `⌛ 授权请求已超时（${Math.round(this.approvalTimeoutMs / 1000)} 秒），已按「不授权」处理。`)
      }, this.approvalTimeoutMs)

      const onAbort = () => this.#settleApproval(channelKey, 'cancelled')
      req?.signal?.addEventListener?.('abort', onAbort, { once: true })

      this.approvals.set(channelKey, {
        toolName,
        requestedAt: Date.now(),
        settle: (outcome) => {
          clearTimeout(timer)
          try {
            req?.signal?.removeEventListener?.('abort', onAbort)
          } catch {
            /* 监听器解绑失败不影响结果 */
          }
          resolve(outcome)
        },
      })

      this.#emit(channelKey, formatApprovalRequest(req, args, this.approvalTimeoutMs))
    })
  }

  /** 结算一条待授权请求（幂等：第二次调用无效果）。 */
  #settleApproval(channelKey, outcome) {
    const pending = this.approvals.get(channelKey)
    if (!pending) return
    this.approvals.delete(channelKey)
    try {
      pending.settle(outcome)
    } catch (error) {
      this.log(`结算授权请求失败：${error?.message ?? error}`)
    }
  }

  /**
   * 把一条微信消息当作授权答复。
   *
   * 有待批请求时，**任何**消息都算答复：同意/拒绝词生效，其它内容回一句提示并消费掉
   * （不会被当成新指令，否则用户会以为自己在回答，实际却给 DSH 派了新活）。
   * @param {string} channelKey 通道键
   * @param {string} text 微信消息文本
   * @returns {boolean} 是否被当作授权答复消费
   */
  answerApproval(channelKey, text) {
    const pending = this.approvals.get(channelKey)
    if (!pending) return false
    const normalized = String(text ?? '').trim()
    if (APPROVE_WORDS.has(normalized)) {
      this.#settleApproval(channelKey, 'allowed-once')
      this.#emit(channelKey, `✅ 已授权一次：${pending.toolName}`)
      this.log(`微信授权通过：${pending.toolName}`)
      return true
    }
    if (REJECT_WORDS.has(normalized)) {
      this.#settleApproval(channelKey, 'rejected')
      this.#emit(channelKey, `🚫 已拒绝：${pending.toolName}`)
      this.log(`微信授权被拒：${pending.toolName}`)
      return true
    }
    this.#emit(channelKey, `请回复「同意」执行一次「${pending.toolName}」，或回复「拒绝」放弃。`)
    return true
  }

  /** 该通道是否有待批授权（面板展示用）。 */
  pendingApproval(channelKey) {
    const pending = this.approvals.get(channelKey)
    if (!pending) return null
    return { toolName: pending.toolName, requestedAt: pending.requestedAt }
  }

  /** 全部待批授权（面板展示用）。 */
  listApprovals() {
    return [...this.approvals.entries()].map(([channel, pending]) => ({
      channel,
      toolName: pending.toolName,
      requestedAt: pending.requestedAt,
    }))
  }

  /**
   * 读该微信会话的权限档位（沙箱模式 + 审批策略的组合）。
   * @param {string} channelKey 通道键
   * @returns {{current: string, options: Array<{value: string, name: string, description?: string}>}|null} 档位信息，不可用时 null
   */
  permissionInfo(channelKey) {
    const presets = this.ctx.get?.('permissionPresets')
    const agent = this.bindings.get(channelKey)?.handle?.agent
    if (!presets?.catalog || !agent?.session) return null
    try {
      const catalog = presets.catalog()
      return { current: presets.current(agent.session), options: catalog?.options ?? [] }
    } catch (error) {
      this.log(`读取权限档位失败：${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 切换该微信会话的权限档位。
   * @param {string} channelKey 通道键
   * @param {string} name 档位名
   * @returns {string} 切换后的生效档位
   */
  setPermission(channelKey, name) {
    const presets = this.ctx.get?.('permissionPresets')
    const agent = this.bindings.get(channelKey)?.handle?.agent
    if (!presets?.set) throw new Error('该 DSH 没有启用权限档位')
    if (!agent?.session) throw new Error('还没有会话，先发一条消息再切换权限')
    presets.set(agent.session, String(name))
    return presets.current(agent.session)
  }
}
