/**
 * 桌面端入口。
 *
 * 为什么需要它：DSH 桌面版用 `file://` 加载界面、fetch 走 IPC 桥，
 * **浏览器 HTTP 路由在桌面端没有入口**；而 Host 的 web server 又要求
 * 进程级 launch token 换取的签名 Cookie，用户没法直接打开那个地址。
 *
 * 所以桌面端的主入口是**人类斜杠命令** `/wechat`（在 DSH 聊天框里输入）：
 *   - 生成并打开一个自包含的二维码页面（内联 SVG，不依赖网络/鉴权）；
 *   - 在命令回复里给出配对码、连接状态与下一步提示；
 *   - 验证码也可以直接在聊天框里提交（`/wechat verify 123456`）。
 * 同时页面里附一个「打开可交互面板」链接：那是带 launch token 的地址，
 * 在浏览器里点一次就会铸出 Cookie，之后就是完整的交互面板。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { renderQrSvg } from './ilink/qr.js'
import { readLog } from './logger.js'
import * as store from './store.js'

/**
 * 打开本地文件/URL（失败只返回 false，不抛）。
 * 设了 `DSH_WECHAT_CLAWBOT_NO_OPEN=1` 时只返回 false、不弹窗口
 * （无桌面环境、CI、以及自测里用）。
 */
export function openPath(target) {
  if (process.env.DSH_WECHAT_CLAWBOT_NO_OPEN === '1') return false
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** HTML 转义。 */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

export class DesktopSurface {
  /**
   * @param {object} options 选项
   * @param {import('./runtime.js').WeChatClawBotRuntime} options.runtime 运行时
   * @param {(msg: string) => void} options.log 日志
   */
  constructor({ runtime, log }) {
    this.runtime = runtime
    this.log = log
    this.ctx = null
    this.disposers = []
    this.refreshTimer = null
    this.panelFile = path.join(store.stateDir(), 'panel.html')
    /** 上一次写盘的内容指纹，避免无意义重写。 */
    this.lastFingerprint = ''
  }

  /** 页面路径（给命令回复用）。 */
  get file() {
    return this.panelFile
  }

  /**
   * 注册命令。
   * @param {object} ctx 已注入 commands 的插件上下文
   * @returns {void}
   */
  attach(ctx) {
    this.ctx = ctx
    this.disposers.push(ctx.commands.register({
      name: 'wechat',
      description: '微信 ClawBot：扫码登录 DSH、查看配对码与连接状态',
      input: { hint: 'status | login | verify <验证码> | open | code | allow <用户ID> | revoke <用户ID> | start | stop | logout <账号> | help' },
      handler: async ({ rawInput }) => this.#handle(String(rawInput ?? '')),
    }))
    this.log('已注册人类命令 /wechat（在 DSH 聊天框输入即可）')
  }

  /** 退订并停止刷新。 */
  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 退订失败不阻断 */
      }
    }
    this.#stopRefresh()
  }

  /**
   * 取带 launch token 的面板地址；拿不到就返回空串。
   * @returns {string} 地址
   */
  authenticatedPanelUrl() {
    const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
    try {
      const connection = this.ctx?.get?.('connection')
      const url = connection?.authenticatedUrl?.(`${base.replace(/\/+$/, '')}/wechat-clawbot`)
      if (typeof url === 'string' && url) return url
    } catch {
      /* 没有 connection 服务就退化成普通地址 */
    }
    return `${base.replace(/\/+$/, '')}/wechat-clawbot`
  }

  /** 把当前状态写成自包含的 HTML 页面。 */
  writePanelFile() {
    const status = this.runtime.status()
    const login = status.login
    const qrSvg = this.runtime.qrSvg()
    const panelUrl = this.authenticatedPanelUrl()
    const accounts = status.accounts ?? []
    const sessions = status.sessions ?? []
    const allowFrom = status.allowFrom ?? []
    const logs = readLog(40)
    const logFile = status.logFile ?? ''

    const fingerprint = JSON.stringify({
      qr: qrSvg ? qrSvg.length : 0,
      loginStatus: login?.status ?? '',
      qrContent: this.runtime.login?.state.qrcodeContent ?? '',
      verify: login?.verifyCodeRequired ?? false,
      pairing: status.pairingCode,
      accounts: accounts.map((a) => [a.accountId, a.connected, a.polling, a.received]),
      sessions: sessions.map((s) => [s.channel, s.sessionId]),
      allowFrom: allowFrom.map((a) => a.id),
    })
    if (fingerprint === this.lastFingerprint) return this.panelFile

    const rows = (pairs) => pairs
      .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`)
      .join('')

    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信 ClawBot × DSH</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:24px; font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; background:#10141c; color:#e6e9ef; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:13px; color:#9aa4b2; letter-spacing:.05em; margin:0 0 10px; }
  .sub { color:#8b95a5; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:300px 1fr; gap:20px; align-items:start; }
  @media (max-width:820px){ .grid{ grid-template-columns:1fr } }
  .card { background:#171c26; border:1px solid #232a38; border-radius:12px; padding:16px; margin-bottom:16px; }
  svg { width:100%; max-width:268px; height:auto; background:#fff; border-radius:8px; display:block; }
  .empty { width:100%; max-width:268px; aspect-ratio:1; background:#0d1117; border:1px dashed #2c3546; border-radius:8px;
           display:flex; align-items:center; justify-content:center; color:#6b7686; text-align:center; padding:16px; }
  .code { font-size:26px; letter-spacing:.18em; font-weight:700; color:#ffd166; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; margin:0; }
  dt { color:#8b95a5; } dd { margin:0; word-break:break-all; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid #232a38; } th { color:#8b95a5; }
  code { background:#0d1117; padding:1px 6px; border-radius:5px; font-size:12px; }
  .pill { display:inline-block; padding:1px 9px; border-radius:999px; font-size:12px; }
  .ok { background:#123524; color:#6ee7a8; } .bad { background:#3a1620; color:#ff9aa8; } .idle { background:#262d3b; color:#9aa4b2; }
  a.btn { display:inline-block; padding:8px 14px; border-radius:8px; background:#2f6df6; color:#fff; text-decoration:none; }
  .logs { font:12px/1.55 ui-monospace,Consolas,monospace; max-height:220px; overflow:auto; background:#0d1117;
          padding:10px; border-radius:8px; white-space:pre-wrap; word-break:break-all; }
  .logs .warn{color:#ffd166} .logs .error{color:#ff9aa8} .ts{color:#6b7686}
  .muted { color:#7d8798; font-size:12px; }
  ol { margin:0; padding-left:20px; } li { margin-bottom:4px; }
</style></head><body>
<h1>微信 ClawBot × DSH</h1>
<div class="sub">这个页面由 dsh-wechat-clawbot 生成于 ${esc(new Date().toLocaleString('zh-CN'))}。重新生成：在 DSH 里再发一次 <code>/wechat</code>。</div>
<div class="grid">
  <div>
    <div class="card"><h2>扫码登录</h2>
      ${qrSvg ? qrSvg : '<div class="empty">还没有二维码<br>在 DSH 聊天框里发送 /wechat 开始</div>'}
      <div class="muted" style="margin-top:10px">登录状态：${esc(login?.status ?? 'idle')}${login?.error ? `（${esc(login.error)}）` : ''}</div>
      ${login?.verifyCodeRequired ? '<div style="margin-top:8px;color:#ffd166">手机微信要求验证码：请回 DSH 聊天框发送 <code>/wechat verify 123456</code></div>' : ''}
    </div>
    <div class="card"><h2>首次配对码</h2><div class="code">${esc(status.pairingCode)}</div>
      <div class="muted" style="margin-top:8px">在微信里把这个数字发给机器人，即可把自己加入白名单。</div></div>
  </div>
  <div>
    <div class="card"><h2>操作步骤</h2><ol>
      <li>用手机微信扫左边的二维码${login?.verifyCodeRequired ? '，若提示验证码就回 DSH 发 <code>/wechat verify 数字</code>' : ''}</li>
      <li>在微信里把上面的 6 位配对码发给机器人</li>
      <li>之后直接在微信里发消息就是给 DSH 派活</li>
    </ol>
    <div style="margin-top:12px"><a class="btn" href="${esc(panelUrl)}">打开可交互面板（浏览器）</a></div>
    <div class="muted" style="margin-top:8px">该地址带 DSH 进程令牌，点一次就会记住登录，之后正常访问即可。</div>
    </div>
    <div class="card"><h2>运行状态</h2><dl>${rows([
    ['轮询', status.enabled ? '已启用' : '已停用'],
    ['二维码渲染', status.qrAvailable ? '正常' : `不可用：${status.qrError}`],
    ['工作目录', status.workspace || '（DSH 默认）'],
    ['模型', (status.provider && status.model) ? `${status.provider} / ${status.model}` : '（DSH 默认）'],
  ])}</dl></div>
    <div class="card"><h2>已登录账号</h2>${accounts.length
    ? `<table><tr><th>账号</th><th>绑定微信</th><th>状态</th><th>收/回</th></tr>${accounts.map((a) => `<tr><td><code>${esc(a.accountId)}</code></td><td>${esc(a.userId || '—')}</td><td><span class="pill ${a.connected ? 'ok' : 'idle'}">${a.connected ? '已连接' : (a.polling ? '轮询中' : '已停止')}</span>${a.lastError ? `<div class="muted">${esc(a.lastError)}</div>` : ''}</td><td>${a.received} / ${a.replied}</td></tr>`).join('')}</table>`
    : '<div class="muted">还没有登录任何微信账号。</div>'}</div>
    <div class="card"><h2>已授权微信用户</h2>${allowFrom.length
    ? `<table><tr><th>用户</th></tr>${allowFrom.map((u) => `<tr><td>${esc(u.masked)}</td></tr>`).join('')}</table>`
    : '<div class="muted">白名单为空。把配对码发给机器人即可添加。</div>'}</div>
    <div class="card"><h2>微信会话 ↔ DSH 会话</h2>${sessions.length
    ? `<table><tr><th>微信用户</th><th>DSH 会话</th><th>状态</th></tr>${sessions.map((s) => `<tr><td>${esc(s.user)}</td><td><code>${esc(s.sessionId)}</code></td><td><span class="pill ${s.running ? 'ok' : 'idle'}">${s.running ? '运行中' : '空闲'}</span></td></tr>`).join('')}</table>`
    : '<div class="muted">还没有任何微信会话。</div>'}</div>
    <div class="card"><h2>最近日志</h2><div class="logs">${logs.length
    ? logs.slice().reverse().map((entry) => `<div class="${entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : ''}"><span class="ts">${esc(String(entry.t || '').replace('T', ' ').slice(0, 19))}</span> ${esc(entry.msg)}</div>`).join('')
    : '<span class="muted">暂无日志。</span>'}</div>
    ${logFile ? `<div class="muted" style="margin-top:8px">日志文件：${esc(logFile)}</div>` : ''}</div>
  </div>
</div></body></html>`

    try {
      fs.mkdirSync(path.dirname(this.panelFile), { recursive: true })
      fs.writeFileSync(this.panelFile, html, 'utf8')
      this.lastFingerprint = fingerprint
    } catch (error) {
      this.log(`写状态页面失败：${error?.message ?? error}`)
    }
    return this.panelFile
  }

  /** 写页面并在系统默认程序里打开。 */
  showPanel() {
    const file = this.writePanelFile()
    const opened = openPath(file)
    if (!opened) this.log(`无法自动打开浏览器，请手动打开：${file}`)
    return file
  }

  /** 登录期间每 2 秒刷新一次页面，扫码/验证码状态能实时反映。 */
  #startRefresh() {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      if (!this.runtime.isLoggingIn) {
        this.writePanelFile()
        this.#stopRefresh()
        return
      }
      this.writePanelFile()
    }, 2000)
    this.refreshTimer.unref?.()
  }

  #stopRefresh() {
    if (!this.refreshTimer) return
    clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  /**
   * 等二维码出现（登录刚发起时是异步的）。
   * @param {number} timeoutMs 最长等待
   * @returns {Promise<boolean>} 是否拿到二维码
   */
  async #waitForQr(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.runtime.qrSvg()) return true
      if (!this.runtime.isLoggingIn) return Boolean(this.runtime.qrSvg())
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return Boolean(this.runtime.qrSvg())
  }

  /** 命令处理。 */
  async #handle(raw) {
    const [action = '', ...rest] = raw.trim().split(/\s+/).filter(Boolean)
    const argument = rest.join(' ')

    switch (action.toLowerCase()) {
      case '':
      case 'login': {
        const status = this.runtime.status()
        if (!status.accounts.length) {
          const started = await this.runtime.beginLogin()
          if (!started.ok && !this.runtime.isLoggingIn) {
            return { kind: 'error', text: `发起扫码登录失败：${started.message}` }
          }
          await this.#waitForQr()
          this.#startRefresh()
        }
        const file = this.showPanel()
        const now = this.runtime.status()
        const lines = []
        if (now.accounts.length) {
          lines.push(`已登录账号：${now.accounts.map((a) => a.accountId).join('、')}`)
        } else if (this.runtime.qrSvg()) {
          lines.push('已生成登录二维码，并已在浏览器里打开页面（若没弹出就手动打开下面的文件）。')
          lines.push('手机微信扫一扫 → 若提示验证码，回这里发送：/wechat verify 数字')
        } else {
          lines.push('还没拿到二维码，稍等几秒后再发一次 /wechat。')
        }
        lines.push(`配对码：${now.pairingCode}（在微信里把它发给机器人即可加入白名单）`)
        lines.push(`二维码页面：${file}`)
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'verify': {
        if (!argument) return { kind: 'error', text: '用法：/wechat verify 123456' }
        const result = this.runtime.submitVerifyCode(argument)
        this.writePanelFile()
        return result.ok
          ? { kind: 'success', text: '验证码已提交，手机微信上确认即可。' }
          : { kind: 'error', text: result.message }
      }

      case 'open': {
        const file = this.showPanel()
        return { kind: 'success', text: `已打开：${file}\n可交互面板：${this.authenticatedPanelUrl()}` }
      }

      case 'code': {
        const code = store.rotatePairingCode()
        this.writePanelFile()
        return { kind: 'success', text: `新的配对码：${code}\n在微信里把它发给机器人即可加入白名单。` }
      }

      case 'allow': {
        if (!argument) {
          const settings = store.loadSettings()
          return {
            kind: 'success',
            text: settings.allowFrom.length
              ? `白名单：\n${settings.allowFrom.map((id) => `  ${id}`).join('\n')}`
              : '白名单为空。把配对码发给机器人即可添加，或 /wechat allow <用户ID>。',
          }
        }
        const added = store.allow(argument)
        this.writePanelFile()
        return { kind: 'success', text: added ? `已加入白名单：${argument}` : `${argument} 已在白名单里。` }
      }

      case 'revoke': {
        if (!argument) return { kind: 'error', text: '用法：/wechat revoke <用户ID>' }
        store.revoke(argument)
        this.writePanelFile()
        return { kind: 'success', text: `已移出白名单：${argument}` }
      }

      case 'start':
      case 'stop': {
        const enabled = action.toLowerCase() === 'start'
        const result = await this.runtime.setPolling(enabled)
        this.writePanelFile()
        return { kind: 'success', text: result.message }
      }

      case 'logout': {
        if (!argument) {
          const ids = store.listAccountIds()
          return {
            kind: 'success',
            text: ids.length ? `已登录账号：\n${ids.map((id) => `  ${id}`).join('\n')}\n退出：/wechat logout <账号>` : '还没有登录任何账号。',
          }
        }
        const result = await this.runtime.removeAccount(argument)
        this.writePanelFile()
        return { kind: 'success', text: result.message }
      }

      case 'reset': {
        if (!argument) return { kind: 'error', text: '用法：/wechat reset <微信用户ID|通道键>' }
        const result = await this.runtime.resetSession(argument)
        this.writePanelFile()
        return { kind: 'success', text: result.message }
      }

      case 'status': {
        const status = this.runtime.status()
        const lines = [
          `插件：${status.enabled ? '已启用' : '已停用'}｜二维码渲染：${status.qrAvailable ? '正常' : status.qrError}`,
          `配对码：${status.pairingCode}`,
          `已登录账号：${status.accounts.length ? status.accounts.map((a) => `${a.accountId}(${a.connected ? '已连接' : a.polling ? '轮询中' : '已停止'})`).join('、') : '无'}`,
          `白名单：${status.allowFrom.length ? status.allowFrom.map((a) => a.masked).join('、') : '空'}`,
          `微信会话：${status.sessions.length ? status.sessions.map((s) => `${s.user} → ${s.sessionId}`).join('；') : '无'}`,
          `登录流程：${status.login ? status.login.status : '未开始'}`,
        ]
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'help':
      default:
        return {
          kind: 'success',
          text: [
            'dsh-wechat-clawbot 命令：',
            '/wechat                查看状态；未登录时自动生成二维码并打开页面',
            '/wechat verify <验证码> 提交手机微信要求的验证码',
            '/wechat open           重新打开二维码 / 状态页面',
            '/wechat code           换一个配对码',
            '/wechat allow [用户ID]  查看白名单，或把某个微信用户加进白名单',
            '/wechat revoke <用户ID> 把某个微信用户移出白名单',
            '/wechat start|stop     启停微信消息轮询',
            '/wechat logout [账号]   查看或退出已登录的微信账号',
            '/wechat reset <用户>    重置该微信会话与 DSH 会话的绑定',
            '/wechat status         只看状态',
            '',
            '配对码：把 6 位数字发给微信里的机器人，就能把自己加进白名单。',
          ].join('\n'),
        }
    }
  }
}
