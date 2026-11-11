/**
 * 客户端半：往 DSH 界面里挂一个「微信」页面 + 侧边栏独立按钮。
 *
 * 形态说明（对照 DSH 自己的 ui-sidebar / dshmarket 的客户端半）：
 *   - 侧边栏的 `sidebar.panellist` 是「全局面板图标」列表，每个条目
 *     `{ id, order, label }` 渲染成一个图标按钮，点击时调用 `ctx.layout.selectPanel(id)`。
 *   - 中间栏的 `main` 是**键控**插槽，key 就是面板 id；选中哪个 id 就渲染哪个。
 *   所以「独立按钮 + 整页」= panellist 注册一个条目 + main 注册同 key 的页面。
 *
 * 这个文件**不打包**：按 DSH 的模块加载器格式手写成 `window.__ModuleLoader__.load(...)`，
 * React 通过 factory 的 `require` 从宿主模块表里取（与其它客户端插件同源，不会出现两份 React）。
 * 因此这里不能用 JSX，统一用 React.createElement。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-clawbot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    var PANEL_ID = 'wechat'
    var STYLE_ID = 'dsh-wechat-clawbot-style'

    /**
     * 把接口路径解析成当前页面挂载点的相对路径。
     * 桌面端与反代前缀部署下都不能用根绝对路径（抄 dshmarket 的做法）。
     * @param {string} path 根绝对路径
     * @returns {string} 可直接 fetch 的路径
     */
    function api(path) {
      var relative = String(path).replace(/^\/+/, '')
      if (typeof document === 'undefined') return '/' + relative
      try {
        return new URL(relative, document.baseURI).pathname
      } catch (error) {
        return '/' + relative
      }
    }

    /** 统一 POST 一个面板动作。 */
    function action(name, value) {
      return fetch(api('/wechat-clawbot/action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: name, value: value }),
      })
        .then((res) => res.json())
        .catch(() => ({ ok: false, message: '请求失败' }))
    }

    var CSS = [
      '.wcw-root{height:100%;overflow:auto;padding:24px 28px 48px;box-sizing:border-box;color:var(--dsw-alias-text-1,#e6e9ef);font-size:14px;line-height:1.6}',
      '.wcw-wrap{max-width:1080px;margin:0 auto}',
      '.wcw-title{font-size:20px;font-weight:600;margin:0 0 4px}',
      '.wcw-sub{color:var(--dsw-alias-text-3,#8b95a5);margin-bottom:20px;font-size:13px}',
      '.wcw-grid{display:grid;grid-template-columns:320px 1fr;gap:20px;align-items:start}',
      '@media (max-width:900px){.wcw-grid{grid-template-columns:1fr}}',
      '.wcw-card{background:var(--dsw-alias-bg-layer-1,#171c26);border:1px solid var(--dsw-alias-border-1,#232a38);border-radius:12px;padding:16px;margin-bottom:16px}',
      '.wcw-card h2{font-size:13px;color:var(--dsw-alias-text-3,#9aa4b2);letter-spacing:.05em;margin:0 0 12px;font-weight:600}',
      '.wcw-qr{width:100%;max-width:288px;aspect-ratio:1;background:#fff;border-radius:8px;display:block}',
      '.wcw-qr-empty{width:100%;max-width:288px;aspect-ratio:1;border:1px dashed var(--dsw-alias-border-1,#2c3546);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-text-3,#6b7686);text-align:center;padding:20px;box-sizing:border-box;font-size:13px}',
      '.wcw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.wcw-btn{font:inherit;font-size:13px;padding:6px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-1,#2f3a4d);background:var(--dsw-alias-bg-layer-2,#212938);color:inherit;cursor:pointer}',
      '.wcw-btn:hover{filter:brightness(1.15)}',
      '.wcw-btn:disabled{opacity:.5;cursor:default}',
      '.wcw-btn-primary{background:#2f6df6;border-color:#2f6df6;color:#fff}',
      '.wcw-btn-danger{border-color:#5a2b34;color:#ff9aa8}',
      '.wcw-input{font:inherit;font-size:13px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-1,#2f3a4d);background:var(--dsw-alias-bg-layer-2,#0d1117);color:inherit;width:100%;box-sizing:border-box}',
      '.wcw-code{font-size:26px;letter-spacing:.18em;font-weight:700;color:#ffd166}',
      '.wcw-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}',
      '.wcw-kv dt{color:var(--dsw-alias-text-3,#8b95a5)}',
      '.wcw-kv dd{margin:0;word-break:break-all}',
      '.wcw-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.wcw-table th,.wcw-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-1,#232a38)}',
      '.wcw-table th{color:var(--dsw-alias-text-3,#8b95a5);font-weight:600}',
      '.wcw-pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;background:var(--dsw-alias-bg-layer-2,#262d3b)}',
      '.wcw-pill-ok{background:rgba(110,231,168,.14);color:#6ee7a8}',
      '.wcw-pill-bad{background:rgba(255,154,168,.14);color:#ff9aa8}',
      '.wcw-muted{color:var(--dsw-alias-text-3,#7d8798);font-size:12px}',
      '.wcw-msg{margin-top:10px;min-height:18px;font-size:13px;color:#9cc4ff}',
      '.wcw-logs{font:12px/1.55 ui-monospace,Consolas,monospace;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-layer-2,#0d1117);padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-all}',
      '.wcw-logs .warn{color:#ffd166}.wcw-logs .error{color:#ff9aa8}.wcw-logs .ts{color:#6b7686}',
      '.wcw-steps{margin:0;padding-left:20px}.wcw-steps li{margin-bottom:4px}',
    ].join('\n')

    /**
     * 拉取面板状态并按需轮询。
     * @param {number} intervalMs 轮询间隔
     * @returns {{data: object|null, reload: () => Promise<void>}}
     */
    function useStatus(intervalMs) {
      var [data, setData] = React.useState(null)
      var reload = React.useCallback(function () {
        return fetch(api('/wechat-clawbot/status.json'), { cache: 'no-store' })
          .then(function (res) { return res.json() })
          .then(function (body) { setData(body) })
          .catch(function () {})
      }, [])
      React.useEffect(function () {
        var alive = true
        var tick = function () {
          if (!alive) return
          fetch(api('/wechat-clawbot/status.json'), { cache: 'no-store' })
            .then(function (res) { return res.json() })
            .then(function (body) { if (alive) setData(body) })
            .catch(function () {})
        }
        tick()
        var timer = window.setInterval(tick, intervalMs)
        return function () {
          alive = false
          window.clearInterval(timer)
        }
      }, [intervalMs])
      return { data: data, reload: reload }
    }

    /** 侧边栏图标（简单的聊天气泡）。 */
    function WeChatGlyph(props) {
      var size = (props && props.size) || 18
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-2.9-.4L4 21l1.4-3.6A8.1 8.1 0 0 1 3 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z' }),
        h('circle', { cx: 9, cy: 11.5, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 11.5, r: 1, fill: 'currentColor', stroke: 'none' })
      )
    }

    /** 一行「标签: 值」。 */
    function Kv(props) {
      return h('div', null, h('dt', null, props.k), h('dd', null, props.v))
    }

    /**
     * 微信主页面。
     * @returns {object} React 元素
     */
    function WeChatPage() {
      var status = useStatus(2000)
      var data = status.data
      var [message, setMessage] = React.useState('')
      var [verifyCode, setVerifyCode] = React.useState('')

      var run = React.useCallback(function (name, value) {
        setMessage('处理中…')
        return action(name, value).then(function (result) {
          setMessage((result && result.message) || '')
          return status.reload()
        })
      }, [status])

      if (!data) {
        return h('div', { className: 'wcw-root' }, h('div', { className: 'wcw-wrap' }, h('div', { className: 'wcw-muted' }, '正在读取微信插件状态…')))
      }

      var login = data.login
      var accounts = data.accounts || []
      var allowFrom = data.allowFrom || []
      var sessions = data.sessions || []
      var logs = (data.logTail || []).slice().reverse()
      var approvals = data.approvals || []
      var qrVersion = login ? String(login.startedAt) + '-' + String(login.refreshCount) : '0'

      return h('div', { className: 'wcw-root' }, h('div', { className: 'wcw-wrap' }, [
        h('h1', { className: 'wcw-title', key: 't' }, '微信 ClawBot × DSH'),
        h('div', { className: 'wcw-sub', key: 's' }, '在手机上用微信「龙虾」插件直接驱动这台机器上的 DSH。每条微信聊天对应一个独立的 DSH 会话。'),

        approvals.length
          ? h('div', {
            className: 'wcw-card', key: 'approvals',
            style: { borderColor: '#6b5a1f', background: 'rgba(255,209,102,.08)' },
          }, [
            h('h2', { key: 'h' }, '等待微信授权'),
            h('div', { key: 'l' }, approvals.map(function (a, i) {
              return h('div', { key: i }, '🔐 ' + a.toolName + '（' + a.user + '）— 在微信里回复「同意」或「拒绝」')
            })),
          ])
          : null,

        h('div', { className: 'wcw-grid', key: 'g' }, [
          h('div', { key: 'left' }, [
            h('div', { className: 'wcw-card', key: 'qr' }, [
              h('h2', { key: 'h' }, '扫码登录'),
              (login && login.hasQr)
                ? h('img', { key: 'img', className: 'wcw-qr', alt: '微信扫码登录二维码', src: api('/wechat-clawbot/qr.svg') + '?v=' + qrVersion })
                : h('div', { key: 'empty', className: 'wcw-qr-empty' }, '还没有二维码，点下面的「生成二维码」'),
              h('div', { className: 'wcw-row', key: 'r1', style: { marginTop: 12 } }, [
                h('button', { key: 'a', className: 'wcw-btn wcw-btn-primary', onClick: function () { run('login') } }, '生成二维码'),
                h('button', { key: 'b', className: 'wcw-btn', onClick: function () { run('login.cancel') } }, '取消'),
              ]),
              (login && login.verifyCodeRequired)
                ? h('div', { key: 'v', style: { marginTop: 12 } }, [
                  h('div', { className: 'wcw-muted', key: 'l', style: { marginBottom: 6 } }, '手机微信要求输入验证码：'),
                  h('div', { className: 'wcw-row', key: 'r' }, [
                    h('input', {
                      key: 'i', className: 'wcw-input', style: { maxWidth: 140 }, placeholder: '6 位数字',
                      value: verifyCode, onChange: function (e) { setVerifyCode(e.target.value) },
                    }),
                    h('button', { key: 'b', className: 'wcw-btn wcw-btn-primary', onClick: function () { run('login.verify', verifyCode) } }, '提交'),
                  ]),
                ])
                : null,
              login ? h('div', { key: 'st', className: 'wcw-muted', style: { marginTop: 10 } }, '状态：' + login.status + (login.error ? '（' + login.error + '）' : '')) : null,
              message ? h('div', { key: 'm', className: 'wcw-msg' }, message) : null,
            ]),

            h('div', { className: 'wcw-card', key: 'pair' }, [
              h('h2', { key: 'h' }, '首次配对码'),
              h('div', { className: 'wcw-row', key: 'r' }, [
                h('span', { key: 'c', className: 'wcw-code' }, data.pairingCode || '------'),
                h('button', { key: 'b', className: 'wcw-btn', onClick: function () { run('pairing.rotate') } }, '换一个'),
              ]),
              h('div', { className: 'wcw-muted', key: 'm', style: { marginTop: 8 } }, '在微信里把这串数字发给机器人，就能把自己加入白名单。'),
            ]),
          ]),

          h('div', { key: 'right' }, [
            h('div', { className: 'wcw-card', key: 'steps' }, [
              h('h2', { key: 'h' }, '三步开通'),
              h('ol', { className: 'wcw-steps', key: 'o' }, [
                h('li', { key: '1' }, '点「生成二维码」，用手机微信扫一扫' + (login && login.verifyCodeRequired ? '（若提示验证码，填在上面）' : '')),
                h('li', { key: '2' }, '在微信里把 6 位配对码发给机器人'),
                h('li', { key: '3' }, '之后直接在微信里发消息，就是给 DSH 派活'),
              ]),
              h('div', { className: 'wcw-row', key: 'r', style: { marginTop: 12 } }, [
                h('button', {
                  key: 'p',
                  className: 'wcw-btn',
                  onClick: function () { run('polling.set', !data.enabled) },
                }, data.enabled ? '停止轮询' : '启动轮询'),
              ]),
            ]),

            h('div', { className: 'wcw-card', key: 'status' }, [
              h('h2', { key: 'h' }, '运行状态'),
              h('dl', { className: 'wcw-kv', key: 'd' }, [
                h(Kv, { key: 'a', k: '轮询', v: data.enabled ? '已启用' : '已停用' }),
                h(Kv, { key: 'b', k: '二维码渲染', v: data.qrAvailable ? '正常' : String(data.qrError || '不可用') }),
                h(Kv, { key: 'c', k: '工作目录', v: data.workspace || '（DSH 默认）' }),
                h(Kv, { key: 'd', k: '模型', v: (data.provider && data.model) ? data.provider + ' / ' + data.model : '（DSH 默认）' }),
                h(Kv, {
                  key: 'e', k: '微信里显示',
                  v: data.verbose === 'final' ? '只最终回复' : (data.verbose === 'tools' ? '回复 + 工具调用' : '回复 + 工具调用 + 深度思考'),
                }),
              ]),
              h('div', { key: 'set', style: { marginTop: 12 } }, [
                h('div', { key: 'l', className: 'wcw-muted', style: { marginBottom: 6 } },
                  '新会话工作目录（必须是绝对路径，例如 D:\\work；留空 = DSH 默认）'),
                h('input', {
                  key: 'w', className: 'wcw-input', placeholder: '留空 = DSH 默认（不要在这里写消息）',
                  defaultValue: data.workspace || '',
                  onBlur: function (e) {
                    var value = String(e.target.value || '').trim()
                    // 绝对路径才收：DSH 的会话头要求绝对路径，写错会让「建会话」直接失败。
                    if (value && !/^[A-Za-z]:[\\/]|^\\\\|^\//.test(value)) {
                      setMessage('工作目录必须是绝对路径（例如 D:\\work），已忽略「' + value + '」。')
                      e.target.value = data.workspace || ''
                      return
                    }
                    run('settings.save', { workspace: value, provider: data.provider, model: data.model, verbose: data.verbose })
                  },
                }),
              ]),
              h('div', { className: 'wcw-row', key: 'verbose', style: { marginTop: 8 } }, [
                h('select', {
                  key: 'v', className: 'wcw-input', value: data.verbose || 'all',
                  onChange: function (e) {
                    run('settings.save', {
                      workspace: data.workspace, provider: data.provider, model: data.model, verbose: e.target.value,
                    })
                  },
                }, [
                  h('option', { key: 'all', value: 'all' }, '微信里显示：回复 + 工具调用 + 深度思考'),
                  h('option', { key: 'tools', value: 'tools' }, '微信里显示：回复 + 工具调用'),
                  h('option', { key: 'final', value: 'final' }, '微信里显示：只发最终回复'),
                ]),
              ]),
            ]),

            h('div', { className: 'wcw-card', key: 'accounts' }, [
              h('h2', { key: 'h' }, '已登录账号'),
              accounts.length
                ? h('table', { className: 'wcw-table', key: 't' }, [
                  h('thead', { key: 'h' }, h('tr', null, [
                    h('th', { key: 'a' }, '账号'), h('th', { key: 'b' }, '绑定微信'),
                    h('th', { key: 'c' }, '状态'), h('th', { key: 'd' }, '收/回'), h('th', { key: 'e' }, ''),
                  ])),
                  h('tbody', { key: 'b' }, accounts.map(function (a) {
                    return h('tr', { key: a.accountId }, [
                      h('td', { key: 'a' }, h('code', null, a.accountId)),
                      h('td', { key: 'b' }, a.userId || '—'),
                      h('td', { key: 'c' }, [
                        h('span', {
                          key: 'p',
                          className: 'wcw-pill ' + (a.connected ? 'wcw-pill-ok' : ''),
                        }, a.connected ? '已连接' : (a.polling ? '轮询中' : '已停止')),
                        a.lastError ? h('div', { key: 'e', className: 'wcw-muted' }, a.lastError) : null,
                      ]),
                      h('td', { key: 'd' }, String(a.received) + ' / ' + String(a.replied)),
                      h('td', { key: 'e' }, h('button', {
                        className: 'wcw-btn wcw-btn-danger',
                        onClick: function () { run('account.remove', a.accountId) },
                      }, '退出')),
                    ])
                  })),
                ])
                : h('div', { className: 'wcw-muted', key: 'e' }, '还没有登录任何微信账号。'),
            ]),

            h('div', { className: 'wcw-card', key: 'allow' }, [
              h('h2', { key: 'h' }, '已授权微信用户'),
              allowFrom.length
                ? h('table', { className: 'wcw-table', key: 't' }, [
                  h('thead', { key: 'h' }, h('tr', null, [h('th', { key: 'a' }, '用户'), h('th', { key: 'b' }, '')])),
                  h('tbody', { key: 'b' }, allowFrom.map(function (u) {
                    return h('tr', { key: u.id }, [
                      h('td', { key: 'a' }, u.masked),
                      h('td', { key: 'b' }, h('button', {
                        className: 'wcw-btn wcw-btn-danger',
                        onClick: function () { run('allow.revoke', u.id) },
                      }, '移除')),
                    ])
                  })),
                ])
                : h('div', { className: 'wcw-muted', key: 'e' }, '白名单为空。把配对码发给机器人即可添加。'),
            ]),

            h('div', { className: 'wcw-card', key: 'sessions' }, [
              h('h2', { key: 'h' }, '微信会话 ↔ DSH 会话'),
              sessions.length
                ? h('table', { className: 'wcw-table', key: 't' }, [
                  h('thead', { key: 'h' }, h('tr', null, [
                    h('th', { key: 'a' }, '微信用户'), h('th', { key: 'b' }, 'DSH 会话'),
                    h('th', { key: 'c' }, '状态'), h('th', { key: 'd' }, ''),
                  ])),
                  h('tbody', { key: 'b' }, sessions.map(function (s) {
                    return h('tr', { key: s.channel }, [
                      h('td', { key: 'a' }, s.user),
                      h('td', { key: 'b' }, h('code', null, s.sessionId)),
                      h('td', { key: 'c' }, h('span', {
                        className: 'wcw-pill ' + (s.running ? 'wcw-pill-ok' : ''),
                      }, s.running ? '运行中' : '空闲')),
                      h('td', { key: 'd' }, h('button', {
                        className: 'wcw-btn',
                        onClick: function () { run('session.reset', s.channel) },
                      }, '重置')),
                    ])
                  })),
                ])
                : h('div', { className: 'wcw-muted', key: 'e' }, '还没有任何微信会话。'),
            ]),

            h('div', { className: 'wcw-card', key: 'logs' }, [
              h('h2', { key: 'h' }, '最近日志'),
              h('div', { className: 'wcw-logs', key: 'l' }, logs.length
                ? logs.map(function (entry, index) {
                  return h('div', { key: index, className: entry.level === 'error' ? 'error' : (entry.level === 'warn' ? 'warn' : '') }, [
                    h('span', { key: 't', className: 'ts' }, String(entry.t || '').replace('T', ' ').slice(0, 19) + ' '),
                    entry.msg,
                  ])
                })
                : h('span', { className: 'wcw-muted' }, '暂无日志。')),
              data.logFile ? h('div', { className: 'wcw-muted', key: 'f', style: { marginTop: 8 } }, '日志文件：' + data.logFile) : null,
            ]),
          ]),
        ]),
      ]))
    }

    var inject = ['slots']

    /**
     * 客户端插件入口。
     * @param {object} ctx 客户端上下文
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(function () {
        if (document.getElementById(STYLE_ID)) return function () {}
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return function () { style.remove() }
      }, 'dsh-wechat-clawbot: styles')

      // ① 侧边栏独立按钮
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 60,
            label: '微信',
          }, function (props) { return h(WeChatGlyph, props) })
        })
      }, 'dsh-wechat-clawbot: sidebar button')

      // ② 中间栏整页（key 必须与按钮 id 相同）
      ctx.effect(function () {
        return ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, function () { return h(WeChatPage) })
        })
      }, 'dsh-wechat-clawbot: main page')
    }

    exports.apply = apply
    exports.inject = inject
    module.exports = exports
    return module.exports
  },
})
