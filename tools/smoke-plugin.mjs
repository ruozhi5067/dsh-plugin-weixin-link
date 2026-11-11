#!/usr/bin/env node
/**
 * 插件侧离线自测：不需要 DSH 真的在跑。
 *
 * 用假的 Cordis 上下文 / 假的 agents 服务，验证：
 *   A. 桥接层：创建会话、提交消息、订阅助手输出、typing 状态、重置
 *   B. 存储层：设置、配对码、白名单、游标、context_token、会话映射
 *   C. 运行时：status() 快照、attach 不抛错
 *   D. 面板：路由注册、鉴权栅栏、status.json 与 action 的往返
 *
 * 用法：node tools/smoke-plugin.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在导入 store.js 之前指定状态目录（所以下面用动态 import）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-clawbot-test-'))
process.env.DSH_WECHAT_CLAWBOT_DIR = TMP
process.env.DSH_HOME = TMP

let failures = 0
function check(name, condition, detail = '') {
  if (!condition) failures += 1
  process.stdout.write(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? `  -- ${detail}` : ''}\n`)
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const { WeChatDshBridge } = await import('../lib/bridge.js')
const store = await import('../lib/store.js')
const { WeChatClawBotRuntime } = await import('../lib/runtime.js')
const { registerPanel } = await import('../lib/panel.js')
const plugin = await import('../lib/index.js')

/* ── 假 DSH ───────────────────────────────────────────────────────────── */

function makeAgent(id) {
  return {
    id,
    session: { id },
    followups: [],
    cancelled: 0,
    followup(message) {
      this.followups.push(message)
    },
    cancel() {
      this.cancelled += 1
    },
    whenIdle() {
      return Promise.resolve()
    },
  }
}

function makeCtx({ resumeFails = true, defaultModel = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } } = {}) {
  const listeners = new Map()
  const agentsById = new Map()
  const created = []
  return {
    created,
    listeners,
    defaultModel,
    /** 记录 setup 在 agent 作用域里注册的监听。 */
    agentSetupListeners: new Map(),
    agents: {
      async create(options) {
        const agent = makeAgent(options.sessionId)
        agentsById.set(agent.id, agent)
        created.push({ options, agent })
        return { agent, dispose: async () => { agent.disposed = true } }
      },
      async resume(options) {
        if (resumeFails) throw new Error('session not found')
        const agent = makeAgent(options.resumeSessionId)
        agentsById.set(agent.id, agent)
        return { agent, dispose: async () => { agent.disposed = true } }
      },
      get(id) {
        return agentsById.get(id)
      },
    },
    services: {},
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((item) => item !== handler))
      }
    },
    get(name) {
      if (name === 'agents') return this.agents
      if (name === 'agentDefaultModel') {
        if (this.defaultModel === null) return undefined
        return { currentSelection: () => this.defaultModel }
      }
      return this.services[name]
    },
    /** 造一个 agent 作用域上下文，交给 create 传入的 setup。 */
    makeAgentCtx() {
      const scope = new Map()
      this.agentSetupListeners = scope
      return {
        on: (event, handler) => {
          const list = scope.get(event) ?? []
          list.push(handler)
          scope.set(event, list)
          return () => scope.set(event, (scope.get(event) ?? []).filter((fn) => fn !== handler))
        },
      }
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    effect(fn) {
      return fn()
    },
  }
}

/* ── A. 桥接层 ────────────────────────────────────────────────────────── */

const ctxA = makeCtx()
const sent = []
const typing = []
const bound = []
const bridge = new WeChatDshBridge({
  ctx: ctxA,
  log: () => {},
  sendText: async (channelKey, text) => {
    sent.push({ channelKey, text })
  },
  sendTyping: (channelKey, on) => {
    typing.push({ channelKey, on })
  },
  resolveWorkspace: async () => 'D:\\fake-workspace',
  onSessionBound: (channelKey, sessionId) => bound.push({ channelKey, sessionId }),
})
bridge.start()

const sessionId = await bridge.submit('acct:user1', '你好 DSH', '')
check('提交后创建了 DSH 会话', ctxA.created.length === 1, `sessionId=${sessionId}`)
check('会话 ID 形如 session-<uuid>', /^session-[0-9a-f-]{36}$/.test(sessionId))
check('会话记在 resolveWorkspace 返回的目录', ctxA.created[0].options.meta.cwd === 'D:\\fake-workspace')
check('followup 收到文本块', ctxA.created[0].agent.followups[0]?.content?.[0]?.text === '你好 DSH')
check('followup 来源标记为 user', ctxA.created[0].agent.followups[0]?.source?.kind === 'user')
{
  const message = ctxA.created[0].agent.followups[0]
  check('消息带 id 与 role=user', typeof message?.id === 'string' && message.id.length >= 16 && message.role === 'user', `id=${message?.id}`)
  check('消息已冻结（对齐 dsh-llm createMessage）', Object.isFrozen(message) && Object.isFrozen(message?.content))
  check('内容块结构正确', message?.content?.[0]?.type === 'text' && typeof message.content[0].text === 'string')
}
check('提交后开启 typing', typing.some((entry) => entry.on === true))
check('会话绑定回调触发', bound[0]?.sessionId === sessionId)

/* ── A2. 模型路由（回归：{{model}} 变量必须有值） ─────────────────────── */

{
  const options = ctxA.created[0].options
  check('创建会话时带上了 provider', options.agentOptions?.provider === 'deepseek-official', String(options.agentOptions?.provider))
  check('创建会话时带上了 model', options.agentOptions?.model === 'deepseek-flash', String(options.agentOptions?.model))
  check('透传了默认选中的 reasoningEffort', options.agentOptions?.reasoningEffort === 'max', String(options.agentOptions?.reasoningEffort))
  check('提供了 setup 安装模型路由', typeof options.setup === 'function')

  const agentCtx = ctxA.makeAgentCtx()
  options.setup(agentCtx)
  const assemble = ctxA.agentSetupListeners.get('system-prompt/assemble') ?? []
  const request = ctxA.agentSetupListeners.get('agent/request') ?? []
  check('setup 注册了 system-prompt/assemble', assemble.length === 1)
  check('setup 注册了 agent/request', request.length === 1)

  if (assemble.length === 1) {
    const assembled = await assemble[0]({}, {}, async () => ({ variables: { other: 'keep' }, sections: [] }))
    check('组装时填上了 {{provider}}', assembled.variables.provider === 'deepseek-official', JSON.stringify(assembled.variables))
    check('组装时填上了 {{model}}', assembled.variables.model === 'deepseek-flash')
    check('组装时保留其它变量', assembled.variables.other === 'keep')
  }
  if (request.length === 1) {
    const resolved = await request[0]({}, async () => ({ provider: 'wrong', model: 'wrong', reasoningEffort: 'low', temperature: 1 }))
    check('请求时固定 provider/model', resolved.provider === 'deepseek-official' && resolved.model === 'deepseek-flash')
    check('请求时用选中的 reasoningEffort 覆盖继承值', resolved.reasoningEffort === 'max')
    check('请求时保留其它调用配置', resolved.temperature === 1)
  }
}

// 既没有插件覆盖、DSH 也没有默认模型时，必须给出清晰错误而不是建出坏会话
{
  const ctxNoModel = makeCtx({ defaultModel: null })
  const bridgeNoModel = new WeChatDshBridge({
    ctx: ctxNoModel,
    log: () => {},
    sendText: async () => {},
    sendTyping: () => {},
    resolveWorkspace: async () => 'D:\\fake-workspace',
  })
  bridgeNoModel.start()
  let message = ''
  try {
    await bridgeNoModel.submit('acct:nomodel', '你好', '')
  } catch (error) {
    message = String(error?.message ?? error)
  }
  check('没有可用模型时明确报错', message.includes('无法确定会话模型'), message || '(没有抛错)')
  check('没有可用模型时不创建会话', ctxNoModel.created.length === 0)
  await bridgeNoModel.dispose()
}

// 同一通道复用同一个会话
const again = await bridge.submit('acct:user1', '第二条', '')
check('同通道复用同一会话', again === sessionId && ctxA.created.length === 1)

// 建会话时必须提示一次（上下文被换掉是用户最需要知道的意外）
check('新建会话有微信提示', sent[0]?.text.includes('🆕 已开新会话'), JSON.stringify(sent[0]?.text))
check('新建会话提示只发一次', sent.filter((e) => e.text.includes('🆕')).length === 1)
const baseline = sent.length

// 助手输出 → 回发
ctxA.emit('session/event', { id: sessionId }, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '**收到**，正在处理' }] } },
})
await tick()
check('助手正文被回发', sent.length === baseline + 1 && sent.at(-1).text === '**收到**，正在处理', JSON.stringify(sent.at(-1) ?? {}))
check('回发使用正确的通道键', sent.at(-1)?.channelKey === 'acct:user1')

// 纯工具调用步骤（无 text 块）不应回发
ctxA.emit('session/event', { id: sessionId }, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'tool-call', name: 'read' }] } },
})
await tick()
check('纯工具步骤不回发', sent.length === baseline + 1)

// 别的会话不进这个通道
ctxA.emit('session/event', { id: 'session-other' }, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '不该出现' }] } },
})
await tick()
check('其它会话的事件被忽略', sent.length === baseline + 1)

/* ── A3. 深度思考与工具调用 ───────────────────────────────────────────── */

const sentTexts = () => sent.map((entry) => entry.text)

// 深度思考：来自已提交 assistant/message 的 reasoning 块
ctxA.emit('session/event', { id: sessionId }, {
  type: 'assistant/message',
  data: {
    message: {
      content: [
        { type: 'reasoning', text: '先看目录结构，再决定读哪个文件。' },
        { type: 'text', text: '结论：没问题。' },
      ],
    },
  },
})
await tick()
check('深度思考被回发', sentTexts().includes('🧠 深度思考\n先看目录结构，再决定读哪个文件。'), JSON.stringify(sentTexts().at(-2)))
check('思考与正文分两条发', sentTexts().at(-1) === '结论：没问题。')

// 工具调用 + 结果（带耗时）
ctxA.emit('session/event', { id: sessionId }, {
  type: 'tool/call', time: 1000,
  data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"D:\\\\a.txt"}' },
})
await tick()
const callMessage = sentTexts().at(-1)
check('工具调用被回发', callMessage.startsWith('🔧 read'), JSON.stringify(callMessage))
check('工具参数带上（截断）', callMessage.includes('file_path'))

ctxA.emit('session/event', { id: sessionId }, {
  type: 'tool/result', time: 1500,
  data: { turn: 1, step: 1, message: { toolCallId: 'call-1', content: [{ type: 'text', text: '文件内容很长很长' }] } },
})
await tick()
check('工具结果被回发且带耗时', sentTexts().at(-1) === '✅ read 完成（0.5s）', JSON.stringify(sentTexts().at(-1)))
check('工具结果不回传正文', !sentTexts().at(-1).includes('文件内容很长很长'))

// 失败的工具调用
ctxA.emit('session/event', { id: sessionId }, {
  type: 'tool/call', time: 2000,
  data: { turn: 1, step: 1, callId: 'call-2', name: 'bash', arguments: '{"command":"nope"}' },
})
ctxA.emit('session/event', { id: sessionId }, {
  type: 'tool/result', time: 2100,
  data: { turn: 1, step: 1, message: { toolCallId: 'call-2', content: [] }, error: { name: 'BashError', code: 'ENOENT', reason: 'command not found' } },
})
await tick()
check('失败的工具调用被标出', sentTexts().at(-1).startsWith('❌ bash 失败'), JSON.stringify(sentTexts().at(-1)))
check('失败原因带上', sentTexts().at(-1).includes('command not found'))

// 分级：final 只发正文、tools 不含思考
{
  const ctxC = makeCtx()
  const sentC = []
  let level = 'final'
  const bridgeC = new WeChatDshBridge({
    ctx: ctxC,
    log: () => {},
    sendText: async (channelKey, text) => { sentC.push(text) },
    sendTyping: () => {},
    resolveWorkspace: async () => 'D:\\w',
    verboseLevel: () => level,
  })
  bridgeC.start()
  const sid = await bridgeC.submit('acct:v', 'hi', '')
  ctxC.emit('session/event', { id: sid }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '答案' }] } },
  })
  ctxC.emit('session/event', { id: sid }, { type: 'tool/call', time: 1, data: { callId: 'c', name: 'read', arguments: '{}' } })
  await tick()
  const nonNotice = sentC.filter((t) => !t.startsWith('🆕'))
  check('final 级只发正文', nonNotice.length === 1 && nonNotice[0] === '答案', JSON.stringify(nonNotice))

  level = 'tools'
  ctxC.emit('session/event', { id: sid }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '答案2' }] } },
  })
  ctxC.emit('session/event', { id: sid }, { type: 'tool/call', time: 2, data: { callId: 'c2', name: 'read', arguments: '{}' } })
  await tick()
  check('tools 级发工具但不发思考', sentC.some((t) => t.startsWith('🔧')) && !sentC.some((t) => t.startsWith('🧠')), JSON.stringify(sentC))
  await bridgeC.dispose()
}

/* ── A4. 微信端批权限 ─────────────────────────────────────────────────── */

/** 按 Cordis waterfall 语义跑一遍监听器（返回结果即认领，next() 才是交还）。 */
async function waterfall(ctx, event, payload, fallback) {
  const handlers = ctx.listeners.get(event) ?? []
  let index = -1
  const next = async () => {
    index += 1
    if (index >= handlers.length) return fallback()
    return handlers[index](payload, next)
  }
  return next()
}

{
  // 让审批能显示这次工具调用的原始参数（Agent 的 session 在真实运行里是可用的）
  const sessionStub = {
    seq: 2,
    eventAt: (seq) => (seq === 1
      ? { type: 'tool/call', data: { callId: 'call-approve', arguments: '{"command":"npm test"}' } }
      : undefined),
  }

  // ① 批准一次
  const before = sent.length
  const approved = waterfall(ctxA, 'approval/request', {
    agent: { id: sessionId, session: sessionStub },
    toolName: 'bash',
    callId: 'call-approve',
    reason: '该命令会修改工作区',
  }, () => 'unavailable')
  await tick()
  const promptText = sent.slice(before).map((e) => e.text).join('\n')
  check('微信收到授权请求', promptText.includes('🔐 DSH 需要授权'), JSON.stringify(promptText.slice(0, 60)))
  check('授权请求带工具名', promptText.includes('bash'))
  check('授权请求带原始参数', promptText.includes('npm test'), '参数来自会话日志的 tool/call')
  check('授权请求带原因', promptText.includes('该命令会修改工作区'))
  check('授权请求说明怎么回复', promptText.includes('同意') && promptText.includes('拒绝'))
  check('待授权状态可查', bridge.pendingApproval('acct:user1')?.toolName === 'bash')

  check('回复「同意」被当作答复', bridge.answerApproval('acct:user1', '同意') === true)
  check('批准返回 allowed-once（唯一授权值）', await approved === 'allowed-once')
  check('批准后清空待授权', bridge.pendingApproval('acct:user1') === null)
  check('批准后有回执', sent.at(-1).text.includes('已授权一次'), JSON.stringify(sent.at(-1).text))

  // ② 拒绝
  const rejected = waterfall(ctxA, 'approval/request', {
    agent: { id: sessionId }, toolName: 'bash', callId: 'call-2',
  }, () => 'unavailable')
  await tick()
  check('回复「拒绝」被当作答复', bridge.answerApproval('acct:user1', '拒绝') === true)
  check('拒绝返回 rejected', await rejected === 'rejected')
  check('拒绝后有回执', sent.at(-1).text.includes('已拒绝'))

  // ③ 非答复内容不会漏成新指令
  const pending = waterfall(ctxA, 'approval/request', {
    agent: { id: sessionId }, toolName: 'write', callId: 'call-3',
  }, () => 'unavailable')
  await tick()
  check('任意消息都算答复（不会漏给 DSH）', bridge.answerApproval('acct:user1', '帮我看看别的') === true)
  check('不是同意/拒绝就再问一次', sent.at(-1).text.includes('请回复「同意」'))
  check('再问一次后仍待授权', bridge.pendingApproval('acct:user1') !== null)
  bridge.answerApproval('acct:user1', '同意')
  check('补答同意仍生效', await pending === 'allowed-once')

  // ④ 不是本插件的会话 → 必须交还给 DSH 原本的审批流程
  const delegated = await waterfall(ctxA, 'approval/request', {
    agent: { id: 'session-not-ours' }, toolName: 'bash',
  }, () => 'delegated-to-others')
  check('非微信会话交还别的 answerer', delegated === 'delegated-to-others')

  // ⑤ 请求被中止 → cancelled（不授权）
  const aborted = waterfall(ctxA, 'approval/request', {
    agent: { id: sessionId }, toolName: 'bash', callId: 'call-4',
    signal: AbortSignal.timeout(20),
  }, () => 'unavailable')
  await tick()
  check('中止前处于待授权', bridge.pendingApproval('acct:user1') !== null)
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('请求中止返回 cancelled', await aborted === 'cancelled')
  check('中止后清空待授权', bridge.pendingApproval('acct:user1') === null)

  // ⑥ 超时 → cancelled（用很短的超时单独建一个桥）
  const ctxT = makeCtx()
  const sentT = []
  const bridgeT = new WeChatDshBridge({
    ctx: ctxT,
    log: () => {},
    sendText: async (channelKey, text) => { sentT.push(text) },
    sendTyping: () => {},
    resolveWorkspace: async () => 'D:\\w',
    approvalTimeoutMs: 40,
  })
  bridgeT.start()
  const sidT = await bridgeT.submit('acct:t', 'hi', '')
  const timedOut = waterfall(ctxT, 'approval/request', {
    agent: { id: sidT }, toolName: 'bash', callId: 'call-t',
  }, () => 'unavailable')
  check('超时后返回 cancelled', await timedOut === 'cancelled')
  check('超时有微信提示', sentT.some((t) => t.includes('已超时')), JSON.stringify(sentT.at(-1)))
  check('待授权清单可列出', bridgeT.listApprovals().length === 0)
  await bridgeT.dispose()
}

/* ── A5. 权限档位（/permission） ──────────────────────────────────────── */

{
  let currentPreset = 'readonly'
  const setCalls = []
  ctxA.services.permissionPresets = {
    catalog: () => ({
      options: [
        { value: 'readonly', name: '只读', description: '不允许写文件' },
        { value: 'workspace', name: '工作区可写' },
        { value: 'full', name: '完全访问', description: '危险' },
      ],
      defaultOptions: [],
      defaultPreset: 'readonly',
    }),
    current: () => currentPreset,
    set: (session, name) => {
      setCalls.push({ session, name })
      currentPreset = name
    },
  }

  const info = bridge.permissionInfo('acct:user1')
  check('能读到权限档位', info?.current === 'readonly', JSON.stringify(info?.current))
  check('能列出可选档位', info?.options.length === 3, String(info?.options.length))
  check('档位带中文名', info?.options[0]?.name === '只读')

  check('能切换权限档位', bridge.setPermission('acct:user1', 'full') === 'full')
  check('切换落到会话上', setCalls[0]?.session?.id === sessionId && setCalls[0]?.name === 'full')

  check('没有绑定的通道读不到档位', bridge.permissionInfo('acct:unknown') === null)

  // 服务不可用时必须给清晰错误，而不是崩
  const savedPresets = ctxA.services.permissionPresets
  delete ctxA.services.permissionPresets
  let presetError = ''
  try {
    bridge.setPermission('acct:user1', 'full')
  } catch (error) {
    presetError = String(error?.message ?? error)
  }
  check('没有权限服务时报错清晰', presetError.includes('权限档位'), presetError)
  check('没有权限服务时读回 null', bridge.permissionInfo('acct:user1') === null)
  ctxA.services.permissionPresets = savedPresets
}

// idle → 停止 typing
ctxA.emit('agent/status', { agent: { id: sessionId }, status: 'idle' })
await tick()
check('idle 后关闭 typing', typing.some((entry) => entry.on === false))
check('idle 后不再标记运行中', bridge.isRunning('acct:user1') === false)

// 错误轮次有人话提示
ctxA.emit('session/event', { id: sessionId }, {
  type: 'turn/end',
  data: { reason: { kind: 'error', error: { message: '连接超时' } } },
})
await tick()
check('轮次错误会告知用户', sent.some((entry) => entry.text.includes('连接超时')), JSON.stringify(sent.map((s) => s.text)))

// 中止
check('可中止运行中的会话', bridge.abort('acct:user1') === true)
check('cancel 被调用', ctxA.created[0].agent.cancelled === 1)

// 重置
await bridge.reset('acct:user1')
check('重置后释放了 agent', ctxA.created[0].agent.disposed === true)
check('重置后通道不再有绑定', bridge.bindings.has('acct:user1') === false)

// 恢复失败时自动新建
const ctxB = makeCtx({ resumeFails: true })
const bridgeB = new WeChatDshBridge({
  ctx: ctxB,
  log: () => {},
  sendText: async () => {},
  sendTyping: () => {},
  resolveWorkspace: async () => TMP,
})
bridgeB.start()
const resumed = await bridgeB.submit('acct:user2', '继续', 'session-old-id')
check('恢复失败的会话会新建', ctxB.created.length === 1 && ctxB.created[0].options.sessionId !== 'session-old-id', resumed)
await bridgeB.dispose()

/* ── B. 存储层 ────────────────────────────────────────────────────────── */

check('状态目录指向临时目录', store.stateDir() === TMP)
const settings = store.loadSettings()
check('默认启用轮询', settings.enabled === true)
check('默认白名单为空', Array.isArray(settings.allowFrom) && settings.allowFrom.length === 0)

const code = store.pairingCode()
check('配对码是 6 位数字', /^\d{6}$/.test(code), code)
check('配对码稳定（重复读取不变）', store.pairingCode() === code)
check('配对码匹配忽略空白', store.matchesPairingCode(`  ${code} `) === true)
check('错误配对码不匹配', store.matchesPairingCode('000000') === false, code === '000000' ? '(巧合，忽略)' : '')
const rotated = store.rotatePairingCode()
check('可以换配对码', /^\d{6}$/.test(rotated) && rotated !== code)

check('未授权用户默认被拒', store.isAllowed('wxid_abc') === false)
store.allow('wxid_abc')
check('加入白名单生效', store.isAllowed('wxid_abc') === true)
check('重复加入返回 false', store.allow('wxid_abc') === false)
store.revoke('wxid_abc')
check('移出白名单生效', store.isAllowed('wxid_abc') === false)

store.saveAccount({ accountId: 'bot@im.bot', token: 'tok-123', baseUrl: 'https://x.example', userId: 'wxid_abc' })
check('账号 ID 被规范化', store.listAccountIds().includes('bot-im-bot'), JSON.stringify(store.listAccountIds()))
check('凭证可读回', store.loadAccount('bot@im.bot')?.token === 'tok-123')
// Windows 的 NTFS 不映射 POSIX 权限位，stat.mode 恒为 0666 一类；只在 POSIX 上断言 0600。
if (process.platform === 'win32') {
  check('凭证文件已落盘（Windows 不校验 POSIX 权限位）', fs.existsSync(path.join(TMP, 'accounts', 'bot-im-bot.json')))
} else {
  check('凭证文件权限为 0600', (fs.statSync(path.join(TMP, 'accounts', 'bot-im-bot.json')).mode & 0o777) === 0o600)
}

store.saveCursor('bot@im.bot', 'cursor-1')
check('游标持久化', store.loadCursor('bot@im.bot') === 'cursor-1')
store.saveCursor('bot@im.bot', '')
check('空游标不覆盖旧值', store.loadCursor('bot@im.bot') === 'cursor-1')

store.saveContextToken('bot@im.bot', 'wxid_abc', 'ctx-token-1')
check('context_token 持久化', store.loadContextToken('bot@im.bot', 'wxid_abc') === 'ctx-token-1')

store.bindSession('bot-im-bot:wxid_abc', 'session-xyz')
check('会话映射持久化', store.sessionFor('bot-im-bot:wxid_abc') === 'session-xyz')
store.bindSession('bot-im-bot:wxid_abc', '')
check('会话映射可解绑', store.sessionFor('bot-im-bot:wxid_abc') === '')

store.removeAccount('bot@im.bot')
check('移除账号清理索引', store.listAccountIds().length === 0)

/* ── B2. 通道键迁移（回归：重启后不该变成新对话） ─────────────────────── */

store.saveSettings({
  sessions: {
    'bot@im.bot:wxid_abc': 'session-legacy',
    'bot-im-bot:wxid_other': 'session-keep',
    'no-colon-key': 'session-weird',
  },
})
check('检测到需要迁移', store.migrateChannelKeys() === true)
check('旧键迁到规范化键', store.sessionFor('bot-im-bot:wxid_abc') === 'session-legacy', store.sessionFor('bot-im-bot:wxid_abc'))
check('旧键已删除', store.sessionFor('bot@im.bot:wxid_abc') === '')
check('已存在的规范化键不被覆盖', store.sessionFor('bot-im-bot:wxid_other') === 'session-keep')
check('无冒号的怪键保持原样', store.sessionFor('no-colon-key') === 'session-weird')
check('再迁移一次无变化', store.migrateChannelKeys() === false)
store.saveSettings({ sessions: {} })

/* ── C. 运行时 ────────────────────────────────────────────────────────── */

const runtime = new WeChatClawBotRuntime(() => {})
runtime.attach(makeCtx())
const status = runtime.status()
for (const key of ['enabled', 'pairingCode', 'accounts', 'allowFrom', 'sessions', 'login', 'qrAvailable']) {
  check(`status() 含字段 ${key}`, key in status)
}
check('没有账号时 accounts 为空', Array.isArray(status.accounts) && status.accounts.length === 0)
check('二维码渲染可用', status.qrAvailable === true, status.qrError || '')
check('未登录时没有二维码', runtime.qrSvg() === null)
const cancelled = runtime.cancelLogin()
check('未登录时取消登录不抛错', cancelled.ok === false || cancelled.ok === true)
await runtime.stopAll()

/* ── D. 面板 ──────────────────────────────────────────────────────────── */

const routes = []
const panelCtx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  get(name) {
    return name === 'webServer' ? this.webServer : undefined
  },
}
registerPanel(panelCtx, runtime, () => {})
check('注册了 4 条面板路由', routes.length === 4, routes.map((r) => r.path).join(', '))
check('面板路径正确', routes.some((r) => r.path === '/wechat-clawbot'))
check('二维码路由存在', routes.some((r) => r.path === '/wechat-clawbot/qr.svg'))
check('状态路由存在', routes.some((r) => r.path === '/wechat-clawbot/status.json'))
check('动作路由存在', routes.some((r) => r.path === '/wechat-clawbot/action'))

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      this.body += chunk ?? ''
    },
  }
}

const statusRoute = routes.find((r) => r.path === '/wechat-clawbot/status.json')
const res1 = fakeRes()
await statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res1)
check('回环请求放行', res1.statusCode === 200, `status=${res1.statusCode}`)
let parsed = null
try {
  parsed = JSON.parse(res1.body)
} catch {
  /* 保持 null */
}
check('status.json 是合法 JSON', parsed !== null && typeof parsed.pairingCode === 'string')

const res2 = fakeRes()
await statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }, res2)
check('跨站请求被拒', res2.statusCode === 403, `status=${res2.statusCode}`)

const res3 = fakeRes()
await statusRoute.handler({ method: 'GET', headers: { host: 'evil.example.com' } }, res3)
check('非回环 Host 被拒', res3.statusCode === 403, `status=${res3.statusCode}`)

const res4 = fakeRes()
await statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.com' } }, res4)
check('Origin 与 Host 不同源被拒', res4.statusCode === 403, `status=${res4.statusCode}`)

const actionRoute = routes.find((r) => r.path === '/wechat-clawbot/action')
const res5 = fakeRes()
await actionRoute.handler({
  method: 'POST',
  headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ action: 'unknown.action' }))
  },
}, res5)
check('未知 action 返回 400', res5.statusCode === 400, `status=${res5.statusCode}`)

/* ── D2. 工作目录校验（回归：相对路径会把建会话打挂） ─────────────────── */

const postAction = async (payload) => {
  const res = fakeRes()
  await actionRoute.handler({
    method: 'POST',
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }, res)
  let body = null
  try {
    body = JSON.parse(res.body)
  } catch {
    /* 保持 null */
  }
  return { status: res.statusCode, body }
}

{
  const bad = await postAction({ action: 'settings.save', value: { workspace: 'weixin with dsh' } })
  check('相对路径工作目录被拒', bad.body?.ok === false && String(bad.body?.message).includes('绝对路径'), JSON.stringify(bad.body))
  check('被拒后没有写坏设置', store.loadSettings().workspace === '', JSON.stringify(store.loadSettings().workspace))

  const good = await postAction({ action: 'settings.save', value: { workspace: 'D:\\work' } })
  check('绝对路径工作目录可保存', good.body?.ok === true && store.loadSettings().workspace === 'D:\\work', JSON.stringify(good.body))

  await postAction({ action: 'settings.save', value: { workspace: '', verbose: 'tools' } })
  check('留空恢复 DSH 默认目录', store.loadSettings().workspace === '')
  check('顺手能存显示分级', store.loadSettings().verbose === 'tools')
  await postAction({ action: 'settings.save', value: { workspace: '', verbose: 'all' } })
}

// 写操作来自非回环（但显式信任）应仍被拒
const res6 = fakeRes()
await actionRoute.handler({
  method: 'POST',
  headers: { host: 'lan.example.com', 'content-type': 'application/json' },
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ action: 'polling.set', value: false }))
  },
}, res6)
check('非本机写操作被拒', res6.statusCode === 403, `status=${res6.statusCode}`)

const htmlRoute = routes.find((r) => r.path === '/wechat-clawbot')
const res7 = fakeRes()
await htmlRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res7)
check('面板 HTML 可返回', res7.statusCode === 200 && res7.body.includes('微信 ClawBot'))
check('面板 HTML 不引用外部资源', !/https?:\/\//.test(res7.body.replace(/https?:\/\/www\.w3\.org[^"]*/g, '')), 'inline only')

/* ── E. 插件入口 ──────────────────────────────────────────────────────── */

check('插件导出 name', plugin.default?.name === 'dsh-wechat-clawbot' || plugin.name === 'dsh-wechat-clawbot')
check('插件导出 apply 函数', typeof plugin.default?.apply === 'function')

const pluginRoot = {
  injected: [],
  contexts: [],
  commands: [],
  inject(services, callback) {
    this.injected.push(services.join(','))
    const listeners = new Map()
    const ctx = {
      services: {},
      listeners,
      // Cordis 的 inject 会把服务同时挂成上下文属性（面板用的是 ctx.webServer.register）。
      webServer: pluginRoot.webServer,
      commands: pluginRoot.commandsService,
      on(event, handler) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler))
      },
      get(name) {
        if (name === 'agents') return makeCtx().agents
        if (name === 'webServer') return pluginRoot.webServer
        if (name === 'commands') return pluginRoot.commandsService
        return undefined
      },
      effect: (fn) => fn(),
    }
    this.contexts.push(ctx)
    callback(ctx)
  },
  webServer: {
    registered: [],
    register(route) {
      this.registered.push(route)
      return () => {}
    },
  },
  commandsService: {
    register(definition) {
      pluginRoot.commands.push(definition)
      return () => {}
    },
  },
}
const pluginLogs = []
const realLog = console.log
const realError = console.error
const realWarn = console.warn
console.log = (...args) => {
  pluginLogs.push(args.join(' '))
}
console.error = (...args) => {
  pluginLogs.push(args.join(' '))
}
console.warn = (...args) => {
  pluginLogs.push(args.join(' '))
}
plugin.default.apply(pluginRoot)
console.log = realLog
console.error = realError
console.warn = realWarn

check('插件申请了 agents 与 webServer', pluginRoot.injected.includes('agents') && pluginRoot.injected.includes('webServer'), pluginRoot.injected.join(' | '))
check('插件申请了 commands（桌面端入口）', pluginRoot.injected.includes('commands'))
check('注册了 /wechat 命令', pluginRoot.commands.some((c) => c.name === 'wechat'), pluginRoot.commands.map((c) => c.name).join(', ') || '(无)')
check('插件挂载后注册了面板路由', pluginRoot.webServer.registered.length === 4, `routes=${pluginRoot.webServer.registered.length}`)
check('插件挂载过程没有报错', !pluginLogs.some((line) => line.includes('失败')), pluginLogs.join(' | ') || '(无日志)')
check(
  '桥订阅了 session/event 与 agent/status',
  pluginRoot.contexts.some((ctx) => ctx.listeners.has('session/event') && ctx.listeners.has('agent/status')),
)
check('面板挂载日志已输出', pluginLogs.some((line) => line.includes('/wechat-clawbot')))
check('启动自检已写日志', pluginLogs.some((line) => line.includes('自检 agents:')))
check('日志已落盘', fs.existsSync(path.join(TMP, 'log.ndjson')), path.join(TMP, 'log.ndjson'))
check('日志可被读回', (await import('../lib/logger.js')).readLog(10).length > 0)
check('status() 带日志尾巴', Array.isArray(runtime.status().logTail) && runtime.status().logTail.length > 0)

/* ── 结果 ─────────────────────────────────────────────────────────────── */

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 清理失败无所谓 */
}
process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
