/**
 * DSH Web 面板：显示登录二维码、连接状态、配对码、已授权用户与会话映射。
 *
 * 路由挂载在 ctx.webServer 上，前缀 /wechat-clawbot。
 * 信任栅栏复用 dsh-whale-widget 验证过的三层做法：
 *   ① 插件自带的回环/同源校验（永远先跑）② 委托宿主 connection.requestRejection ③ 栅栏抛异常按拒绝处理。
 * 写操作额外要求来自回环地址。
 */

import path from 'node:path'
import { allow, revoke, rotatePairingCode, saveSettings } from './store.js'

const PREFIX = '/wechat-clawbot'
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 平台无关的绝对路径判断（Windows 盘符 / UNC / POSIX）。
 * @param {string} value 路径
 * @returns {boolean} 是否绝对路径
 */
function isAbsolutePath(value) {
  return path.isAbsolute(value)
}

/**
 * 是否回环主机名（逐段校验，防 127.0.0.1.evil.com）。
 * @param {string} hostname 主机名
 * @returns {boolean} 是否回环
 */
function isLoopback(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  return Number(match[1]) === 127 && [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}

/**
 * 允许访问面板的额外权威（环境变量声明，逗号分隔，可带端口）。
 * @returns {string[]} 列表
 */
function trustedHosts() {
  return String(process.env.DSH_WECHAT_CLAWBOT_HOSTS ?? '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
}

/**
 * 面板路由的访问判定。
 * @param {object} ctx 插件上下文（可能没有 connection 服务）
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {number|null} 需要拒绝时返回状态码，放行返回 null
 */
function rejection(ctx, req) {
  try {
    const headers = req?.headers ?? {}
    let url
    try {
      url = new URL(`http://${String(headers.host ?? '')}`)
    } catch {
      return 403
    }
    const trusted = trustedHosts()
    const listed = trusted.some((entry) => (entry.includes(':') ? entry === url.host.toLowerCase() : entry === url.hostname.toLowerCase()))
    const fence = ctx.get?.('connection') ?? ctx.connection
    const fenceAvailable = Boolean(fence && typeof fence.requestRejection === 'function')

    if (!isLoopback(url.hostname) && !listed && !fenceAvailable) return 403

    const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
    if (site === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      try {
        if (new URL(origin).host.toLowerCase() !== url.host.toLowerCase()) return 403
      } catch {
        return 403
      }
    }

    // 写操作必须来自本机：改设置/加白名单等于放开 DSH 的文件与命令能力。
    if (WRITE_METHODS.has(String(req?.method ?? 'GET').toUpperCase()) && !isLoopback(url.hostname) && !listed) {
      return 403
    }

    if (!fenceAvailable) return null
    let code
    try {
      code = fence.requestRejection(req)
    } catch {
      return 403
    }
    if (code === undefined || code === null || code === false) return null
    return typeof code === 'number' ? code : 403
  } catch {
    return 403
  }
}

/**
 * 读请求体（限制 64KB）。
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<any>} 解析后的 JSON，失败返回 {}
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) return {}
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * 发 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status 状态码
 * @param {any} payload 内容
 * @returns {void}
 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/**
 * 注册面板路由。
 * @param {object} ctx 已注入 webServer 的插件上下文
 * @param {import('./runtime.js').WeChatClawBotRuntime} runtime 运行时
 * @param {(msg: string) => void} log 日志
 * @returns {Array<() => void>} 退订函数
 */
export function registerPanel(ctx, runtime, log) {
  const disposers = []

  /**
   * 包一层信任栅栏。
   * @param {(req: any, res: any) => any} handler 真实处理器
   * @returns {(req: any, res: any) => Promise<void>} 包装后的处理器
   */
  const guarded = (handler) => async (req, res) => {
    const code = rejection(ctx, req)
    if (code !== null) {
      res.statusCode = code
      res.end()
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      log(`面板请求失败：${error?.message ?? error}`)
      if (!res.headersSent) json(res, 500, { ok: false, message: String(error?.message ?? error) })
      else res.end()
    }
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: PREFIX,
    handler: guarded((req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(panelHtml())
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/qr.svg`,
    handler: guarded((req, res) => {
      const svg = runtime.qrSvg()
      if (!svg) {
        res.statusCode = 404
        res.end('no qr')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(svg)
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/status.json`,
    handler: guarded((req, res) => json(res, 200, runtime.status())),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/action`,
    handler: guarded(async (req, res) => {
      const { action, value } = await readBody(req)
      switch (action) {
        case 'login':
          json(res, 200, await runtime.beginLogin())
          return
        case 'login.verify':
          json(res, 200, runtime.submitVerifyCode(value))
          return
        case 'login.cancel':
          json(res, 200, runtime.cancelLogin())
          return
        case 'account.remove':
          json(res, 200, await runtime.removeAccount(String(value ?? '')))
          return
        case 'allow.add':
          json(res, 200, { ok: true, message: allow(String(value ?? '')) ? '已加入白名单' : '该用户已在白名单' })
          return
        case 'allow.revoke':
          revoke(String(value ?? ''))
          json(res, 200, { ok: true, message: '已移出白名单' })
          return
        case 'pairing.rotate':
          json(res, 200, { ok: true, message: '配对码已更新', value: rotatePairingCode() })
          return
        case 'polling.set':
          json(res, 200, await runtime.setPolling(Boolean(value)))
          return
        case 'session.reset':
          json(res, 200, await runtime.resetSession(String(value ?? '')))
          return
        case 'settings.save': {
          const patch = value && typeof value === 'object' ? value : {}
          const verbose = String(patch.verbose ?? '').trim()
          const workspace = String(patch.workspace ?? '').trim()
          // DSH 的会话头要求绝对路径；非绝对的配置会让「建会话」直接失败，
          // 所以这里挡在入口，而不是等用户发消息时报一句看不懂的错。
          if (workspace && !isAbsolutePath(workspace)) {
            json(res, 200, { ok: false, message: `工作目录必须是绝对路径（例如 D:\\work），留空则用 DSH 默认；已忽略「${workspace}」` })
            return
          }
          saveSettings({
            workspace,
            provider: String(patch.provider ?? '').trim(),
            model: String(patch.model ?? '').trim(),
            ...(verbose ? { verbose } : {}),
          })
          json(res, 200, { ok: true, message: '设置已保存' })
          return
        }
        default:
          json(res, 400, { ok: false, message: `未知操作：${action}` })
      }
    }),
  }))

  return disposers
}

/** 面板页面（完全自包含，不依赖任何外部资源）。 */
function panelHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信 ClawBot × DSH</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #10141c; color: #e6e9ef; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 0 0 10px; color: #9aa4b2; font-weight: 600; letter-spacing: .04em; }
  .sub { color: #8b95a5; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: 320px 1fr; gap: 20px; align-items: start; }
  @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  .card { background: #171c26; border: 1px solid #232a38; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .qr { width: 100%; max-width: 288px; aspect-ratio: 1; background: #fff; border-radius: 8px; display: block; }
  .qr-empty { width: 100%; max-width: 288px; aspect-ratio: 1; background: #0d1117; border: 1px dashed #2c3546;
              border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #6b7686; text-align: center; padding: 20px; }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid #2f3a4d; background: #212938;
           color: #e6e9ef; cursor: pointer; }
  button:hover { background: #2a3446; }
  button.primary { background: #2f6df6; border-color: #2f6df6; color: #fff; }
  button.primary:hover { background: #3d7bff; }
  button.danger { border-color: #5a2b34; color: #ff9aa8; }
  input { font: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid #2f3a4d; background: #0d1117; color: #e6e9ef; width: 100%; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; }
  .kv dt { color: #8b95a5; }
  .kv dd { margin: 0; word-break: break-all; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; border: 1px solid transparent; }
  .ok { background: #123524; color: #6ee7a8; border-color: #1c5c39; }
  .bad { background: #3a1620; color: #ff9aa8; border-color: #6b2634; }
  .idle { background: #262d3b; color: #9aa4b2; border-color: #333c4d; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #232a38; }
  th { color: #8b95a5; font-weight: 600; }
  code { background: #0d1117; padding: 1px 6px; border-radius: 5px; font-size: 12px; }
  .code-big { font-size: 26px; letter-spacing: .18em; font-weight: 700; color: #ffd166; }
  .muted { color: #7d8798; font-size: 12px; }
  .msg { margin-top: 10px; min-height: 18px; color: #9cc4ff; font-size: 13px; }
  .logs { font: 12px/1.55 ui-monospace, Consolas, monospace; max-height: 240px; overflow: auto;
          background: #0d1117; padding: 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-all; }
  .logs .warn { color: #ffd166; }
  .logs .error { color: #ff9aa8; }
  .logs .ts { color: #6b7686; }
</style>
</head>
<body>
<h1>微信 ClawBot × DSH</h1>
<div class="sub">手机上用微信「龙虾」插件，直接驱动这台机器上的 DeepSeek Harness。</div>

<div class="grid">
  <div>
    <div class="card">
      <h2>扫码登录</h2>
      <div id="qrBox"></div>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="btnLogin">生成二维码</button>
        <button id="btnCancel">取消</button>
      </div>
      <div id="verifyBox" style="display:none;margin-top:12px">
        <div class="muted" style="margin-bottom:6px">手机微信要求输入验证码：</div>
        <div class="row"><input id="verifyCode" placeholder="6 位数字" style="max-width:140px">
        <button class="primary" id="btnVerify">提交</button></div>
      </div>
      <div class="msg" id="loginMsg"></div>
    </div>

    <div class="card">
      <h2>首次配对码</h2>
      <div class="row"><span class="code-big" id="pairing">------</span>
        <button id="btnRotate">换一个</button></div>
      <div class="muted" style="margin-top:8px">在微信里把这个数字发给机器人，即可把自己加入白名单。</div>
    </div>
  </div>

  <div>
    <div class="card">
      <h2>运行状态</h2>
      <div class="row" style="margin-bottom:10px">
        <span id="pollPill" class="pill idle">—</span>
        <button id="btnTogglePoll">切换轮询</button>
      </div>
      <dl class="kv" id="statusKv"></dl>
    </div>

    <div class="card">
      <h2>已登录账号</h2>
      <div id="accounts"></div>
    </div>

    <div class="card">
      <h2>已授权微信用户</h2>
      <div id="allow"></div>
    </div>

    <div class="card">
      <h2>微信会话 ↔ DSH 会话</h2>
      <div id="sessions"></div>
    </div>

    <div class="card">
      <h2>新会话设置</h2>
      <div class="row" style="margin-bottom:8px"><label style="min-width:88px">工作目录</label>
        <input id="setWorkspace" placeholder="留空 = DSH 默认工作目录"></div>
      <div class="row" style="margin-bottom:8px"><label style="min-width:88px">provider</label>
        <input id="setProvider" placeholder="留空 = 用 DSH 默认模型"></div>
      <div class="row" style="margin-bottom:12px"><label style="min-width:88px">model</label>
        <input id="setModel" placeholder="留空 = 用 DSH 默认模型"></div>
      <div class="row" style="margin-bottom:12px"><label style="min-width:88px">微信里显示</label>
        <select id="setVerbose" style="flex:1;font:inherit;padding:6px 10px;border-radius:8px;border:1px solid #2f3a4d;background:#0d1117;color:inherit">
          <option value="all">回复 + 工具调用 + 深度思考</option>
          <option value="tools">回复 + 工具调用</option>
          <option value="final">只发最终回复</option>
        </select></div>
      <button class="primary" id="btnSave">保存设置</button>
      <div class="msg" id="saveMsg"></div>
    </div>

    <div class="card">
      <h2>最近日志</h2>
      <div class="logs" id="logs"></div>
      <div class="muted" id="logFile" style="margin-top:8px"></div>
    </div>
  </div>
</div>

<script>
(function () {
  var state = { data: null, loginTimer: null };

  function el(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function post(action, value) {
    return fetch('/wechat-clawbot/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, value: value })
    }).then(function (r) { return r.json(); }).catch(function () { return { ok: false, message: '请求失败' }; });
  }

  function pill(text, kind) { return '<span class="pill ' + kind + '">' + esc(text) + '</span>'; }

  function render() {
    var d = state.data;
    if (!d) return;

    el('pairing').textContent = d.pairingCode || '------';

    el('pollPill').textContent = d.enabled ? (d.accounts.some(function (a) { return a.connected; }) ? '已连接' : '轮询中') : '已停用';
    el('pollPill').className = 'pill ' + (d.enabled ? (d.accounts.some(function (a) { return a.connected; }) ? 'ok' : 'idle') : 'bad');

    var kv = [
      ['插件', d.enabled ? '已启用' : '已停用'],
      ['二维码渲染', d.qrAvailable ? '正常' : ('不可用：' + d.qrError)],
      ['工作目录', d.workspace || '（DSH 默认）'],
      ['模型', (d.provider && d.model) ? d.provider + ' / ' + d.model : '（DSH 默认）']
    ];
    el('statusKv').innerHTML = kv.map(function (row) {
      return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
    }).join('');

    el('accounts').innerHTML = d.accounts.length ? '<table><tr><th>账号</th><th>绑定微信</th><th>状态</th><th>收/回</th><th></th></tr>' +
      d.accounts.map(function (a) {
        return '<tr><td><code>' + esc(a.accountId) + '</code></td><td>' + esc(a.userId || '—') + '</td><td>' +
          (a.connected ? pill('已连接', 'ok') : pill(a.polling ? '轮询中' : '已停止', 'idle')) +
          (a.lastError ? '<div class="muted">' + esc(a.lastError) + '</div>' : '') +
          '</td><td>' + a.received + ' / ' + a.replied + '</td>' +
          '<td><button class="danger" data-act="account.remove" data-val="' + esc(a.accountId) + '">退出</button></td></tr>';
      }).join('') + '</table>' : '<div class="muted">还没有登录任何微信账号。</div>';

    el('allow').innerHTML = d.allowFrom.length ? '<table><tr><th>用户</th><th></th></tr>' +
      d.allowFrom.map(function (u) {
        return '<tr><td>' + esc(u.masked) + '</td>' +
          '<td><button class="danger" data-act="allow.revoke" data-val="' + esc(u.id) + '">移除</button></td></tr>';
      }).join('') + '</table>' : '<div class="muted">白名单为空。把配对码发给机器人即可添加。</div>';

    el('sessions').innerHTML = d.sessions.length ? '<table><tr><th>微信用户</th><th>DSH 会话</th><th>状态</th><th></th></tr>' +
      d.sessions.map(function (s) {
        return '<tr><td>' + esc(s.user) + '</td><td><code>' + esc(s.sessionId) + '</code></td><td>' +
          (s.running ? pill('运行中', 'ok') : pill('空闲', 'idle')) + '</td>' +
          '<td><button data-act="session.reset" data-val="' + esc(s.channel) + '">重置</button></td></tr>';
      }).join('') + '</table>' : '<div class="muted">还没有任何微信会话。</div>';

    if (d.login && d.login.hasQr) {
      el('qrBox').innerHTML = '<img class="qr" src="/wechat-clawbot/qr.svg?t=' + Date.now() + '" alt="微信扫码登录二维码">';
    } else {
      el('qrBox').innerHTML = '<div class="qr-empty">点下面的按钮生成二维码<br>然后用微信扫一扫</div>';
    }
    el('verifyBox').style.display = (d.login && d.login.verifyCodeRequired) ? 'block' : 'none';
    if (d.login) {
      el('loginMsg').textContent = '状态：' + d.login.status + (d.login.error ? '（' + d.login.error + '）' : '');
    } else if (d.lastLoginResult) {
      el('loginMsg').textContent = d.lastLoginResult;
    }

    el('setWorkspace').value = d.workspace || '';
    el('setProvider').value = d.provider || '';
    el('setModel').value = d.model || '';
    el('setVerbose').value = d.verbose || 'all';

    var logs = d.logTail || [];
    el('logs').innerHTML = logs.length ? logs.slice().reverse().map(function (entry) {
      var level = entry.level === 'error' ? 'error' : (entry.level === 'warn' ? 'warn' : '');
      var time = String(entry.t || '').replace('T', ' ').slice(0, 19);
      return '<div class="' + level + '"><span class="ts">' + esc(time) + '</span> ' + esc(entry.msg) + '</div>';
    }).join('') : '<div class="muted">暂无日志。</div>';
    el('logFile').textContent = d.logFile ? ('日志文件：' + d.logFile) : '';
  }

  function refresh() {
    return fetch('/wechat-clawbot/status.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) { state.data = data; render(); })
      .catch(function () {});
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || target.tagName !== 'BUTTON') return;
    var act = target.getAttribute('data-act');
    if (act) {
      post(act, target.getAttribute('data-val')).then(refresh);
    }
  });

  el('btnLogin').onclick = function () {
    el('loginMsg').textContent = '正在生成二维码…';
    post('login').then(function (r) { el('loginMsg').textContent = r.message || ''; return refresh(); });
  };
  el('btnCancel').onclick = function () { post('login.cancel').then(refresh); };
  el('btnVerify').onclick = function () {
    var code = el('verifyCode').value;
    post('login.verify', code).then(function (r) { el('loginMsg').textContent = r.message || ''; return refresh(); });
  };
  el('btnRotate').onclick = function () { post('pairing.rotate').then(refresh); };
  el('btnTogglePoll').onclick = function () {
    var next = !(state.data && state.data.enabled);
    post('polling.set', next).then(function (r) { el('loginMsg').textContent = r.message || ''; return refresh(); });
  };
  el('btnSave').onclick = function () {
    var workspace = String(el('setWorkspace').value || '').trim();
    if (workspace && !/^[A-Za-z]:[\\/]|^\\\\|^\//.test(workspace)) {
      el('saveMsg').textContent = '工作目录必须是绝对路径（例如 D:\\work），已忽略「' + workspace + '」。';
      return;
    }
    post('settings.save', {
      workspace: workspace,
      provider: el('setProvider').value,
      model: el('setModel').value,
      verbose: el('setVerbose').value
    }).then(function (r) { el('saveMsg').textContent = r.message || ''; return refresh(); });
  };

  refresh();
  state.loginTimer = setInterval(refresh, 2500);
})();
</script>
</body>
</html>`
}
