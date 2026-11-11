/**
 * dsh-wechat-clawbot —— 通过微信「龙虾」ClawBot 在手机上连接 DSH。
 *
 * 插件形态：DSH bundle 包（package.json 的 dsh.bundle.patch 指向 cordis.patch.yml），
 * 入口是一个标准 Cordis 插件对象 { name, apply }。bundle patch 用裸包名挂载本包，
 * 因为 DSH 的 loader 不解析 exports 子路径（实测子路径会 import 失败）。
 *
 * 结构：
 *   lib/index.js      插件入口（本文件）
 *   lib/desktop.js    桌面端入口：人类命令 /wechat + 自包含二维码页面
 *   lib/runtime.js    运行时：账号轮询 + DSH 桥 + 面板操作
 *   lib/bridge.js     微信会话 ↔ DSH Agent 会话
 *   lib/channel.js    单账号长轮询 / 授权 / 命令 / 媒体 / 回发
 *   lib/panel.js      Web 状态面板（二维码、配对码、会话管理）
 *   lib/store.js      持久化（凭证、游标、context_token、白名单、映射）
 *   lib/logger.js     日志（stdout + <stateDir>/log.ndjson）
 *   lib/message.js    构造 DSH user 消息（等价于 dsh-llm 的 createUserMessage）
 *   lib/ilink/*       微信 iLink Bot 协议实现
 */
import { createLogger } from './logger.js'
import { DesktopSurface } from './desktop.js'
import { registerPanel } from './panel.js'
import { WeChatClawBotRuntime } from './runtime.js'
import { stateDir } from './store.js'

export const name = 'dsh-wechat-clawbot'
export const version = '0.4.1'

/** 进程内唯一运行时：插件被重新挂载时复用同一份，避免重复轮询。 */
let sharedRuntime = null

/**
 * 取（或创建）运行时单例。
 * @returns {WeChatClawBotRuntime} 运行时
 */
function runtimeInstance() {
  if (!sharedRuntime) {
    sharedRuntime = new WeChatClawBotRuntime(createLogger('wechat-clawbot'))
  }
  return sharedRuntime
}

export default {
  name: 'dsh-wechat-clawbot',

  /**
   * Cordis 插件入口。
   * @param {object} root 插件根上下文
   * @returns {void}
   */
  apply(root) {
    const runtime = runtimeInstance()
    const log = runtime.log

    log(`插件挂载 v${version}；状态目录 ${stateDir()}；日志 ${log.file || '(不可写)'}`)

    // ① DSH Agent 桥：没有 agents 服务就什么都不做（面板仍然可用，只是无法派活）。
    root.inject(['agents'], (ctx) => {
      try {
        runtime.attach(ctx)
      } catch (error) {
        log.error(`绑定 DSH 会话服务失败：${error?.message ?? error}`)
        return
      }

      // 启动自检：把关键前提一次记全，出问题时看日志就有现场。
      try {
        const agents = ctx.get('agents')
        const methods = ['create', 'resume', 'get', 'list']
          .map((method) => `${method}=${typeof agents?.[method] === 'function' ? 'ok' : '缺失'}`)
          .join(' ')
        const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
        log(`自检 agents: ${methods}`)
        log(`自检默认模型: ${selection ? `${selection.provider}/${selection.model}` : '(不可用)'}`)
        log(`自检会话持久化: sessionPersistence=${ctx.get('sessionPersistence') ? 'ok' : '缺失'}`)
      } catch (error) {
        log.warn(`自检失败：${error?.message ?? error}`)
      }

      ctx.effect(() => () => {
        runtime.stopAll().catch((error) => log.error(`停止运行时失败：${error?.message ?? error}`))
      })
      runtime.startAll().catch((error) => log.error(`启动失败：${error?.message ?? error}`))
    })

    // ② Web 面板：挂 http://127.0.0.1:<port>/wechat-clawbot
    root.inject(['webServer'], (ctx) => {
      let disposers = []
      try {
        disposers = registerPanel(ctx, runtime, (message) => log(message))
      } catch (error) {
        log.error(`注册面板路由失败：${error?.message ?? error}`)
        return
      }
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 退订失败不阻断卸载 */
          }
        }
      })
      const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
      log(`面板已挂载：${base}/wechat-clawbot（与 DSH 本体同一套浏览器鉴权）`)
    })

    // ③ 桌面端主入口：人类斜杠命令 /wechat（DSH 桌面版没有 HTTP 界面入口）。
    root.inject(['commands'], (ctx) => {
      const surface = new DesktopSurface({ runtime, log })
      try {
        surface.attach(ctx)
      } catch (error) {
        log.error(`注册 /wechat 命令失败：${error?.message ?? error}`)
        return
      }
      ctx.effect(() => () => surface.dispose())
    })
  },
}
