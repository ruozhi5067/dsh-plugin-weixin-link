#!/usr/bin/env node
/**
 * 冷启动预演：用 DSH 完全相同的加载方式，把**已安装到 profile 的那个包**加载一遍。
 *
 * 用途：改了插件、重新安装之后，不重启 DSH 也能先确认「下一次启动一定能起来」。
 * 它按 DSH 的解析方式 import 裸包名（通过 profile 目录），再拿一个假上下文跑 apply()。
 *
 * 用法：node tools/preflight-installed.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const PACKAGE = path.join(PROFILE, 'node_modules', 'dsh-wechat-clawbot')

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-preflight-'))
process.env.DSH_WECHAT_CLAWBOT_DIR = stateDir

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  -- ${detail}` : ''}`)
}

if (!fs.existsSync(PACKAGE)) {
  console.log(`[FAIL] 未找到已安装的插件：${PACKAGE}`)
  process.exit(1)
}
check('已安装包存在', true, PACKAGE)

// 用 profile 下的位置做基准解析，等价于 DSH 加载插件时的解析环境。
const require = createRequire(path.join(PROFILE, 'package.json'))
let manifest
try {
  manifest = require(path.join(PACKAGE, 'package.json'))
  check('已安装版本', true, `${manifest.name}@${manifest.version}`)
  check('声明了 dsh.bundle.patch', Boolean(manifest.dsh?.bundle?.patch), String(manifest.dsh?.bundle?.patch))
  check('声明了 dsh.client（界面内页面）', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client ?? null))
  const clientExport = manifest.exports?.['./client']
  check('导出了 ./client', typeof clientExport === 'string', String(clientExport))
  const clientFile = path.join(PACKAGE, String(clientExport ?? 'lib/client.js'))
  check('客户端半文件存在', fs.existsSync(clientFile), clientFile)
  if (fs.existsSync(clientFile)) {
    const clientSource = fs.readFileSync(clientFile, 'utf8')
    const clientCode = clientSource.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*/g, '')
    check('客户端半用 DSH 模块加载器格式', clientCode.startsWith('window.__ModuleLoader__.load({'), `${(clientSource.length / 1024).toFixed(1)} KB`)
  }
} catch (error) {
  check('读取 package.json', false, error.message)
  process.exit(1)
}

const entry = path.join(PACKAGE, 'lib', 'index.js')
let mod
try {
  mod = await import(pathToFileURL(entry).href)
  check('入口模块可以 import', true, `exports=${Object.keys(mod).join(',')}`)
} catch (error) {
  check('入口模块可以 import', false, `${error.code || ''} ${error.message}`)
  process.exit(1)
}

const plugin = mod.default
check('默认导出是插件对象', typeof plugin === 'object' && plugin !== null)
check('插件有 name 与 apply', typeof plugin?.name === 'string' && typeof plugin?.apply === 'function', plugin?.name)

const routes = []
const logs = []
const silence = () => {
  const saved = [console.log, console.warn, console.error]
  console.log = console.warn = console.error = (...args) => logs.push(args.join(' '))
  return () => {
    ;[console.log, console.warn, console.error] = saved
  }
}

function makeAgents() {
  return {
    created: [],
    async create(options) {
      const agent = { id: options.sessionId, followups: [], followup(m) { this.followups.push(m) }, cancel() {}, whenIdle: async () => {} }
      this.created.push({ options, agent })
      return { agent, dispose: async () => {} }
    },
    async resume() { throw new Error('no persistence in preflight') },
    get: () => undefined,
    list: () => [],
  }
}

const root = {
  inject(services, callback) {
    const agents = makeAgents()
    callback({
      on: () => () => {},
      get(name) {
        if (name === 'agents') return agents
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
        return undefined
      },
      effect: (fn) => fn(),
      webServer: { register: (route) => { routes.push(route); return () => {} } },
    })
  },
}

const restore = silence()
try {
  plugin.apply(root)
  check('apply() 不抛错', true)
} catch (error) {
  check('apply() 不抛错', false, error.message)
} finally {
  restore()
}

check('挂载了 4 条面板路由', routes.length === 4, routes.map((r) => r.path).join(', '))
check('日志文件已写出', fs.existsSync(path.join(stateDir, 'log.ndjson')))
check('启动自检已记录', logs.some((line) => line.includes('自检 agents:')))
check('面板挂载日志已记录', logs.some((line) => line.includes('面板已挂载')))

const statusRoute = routes.find((r) => r.path === '/wechat-clawbot/status.json')
const fakeRes = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(name, value) { this.headers[name] = value },
  end(chunk) { this.body += chunk ?? '' },
})
if (statusRoute) {
  const loopback = fakeRes()
  await statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, loopback)
  check('status.json 回环放行', loopback.statusCode === 200, `status=${loopback.statusCode}`)
  let payload = null
  try { payload = JSON.parse(loopback.body) } catch { /* 保持 null */ }
  check('配对码是 6 位数字', /^\d{6}$/.test(payload?.pairingCode ?? ''), payload?.pairingCode)
  const foreign = fakeRes()
  await statusRoute.handler({ method: 'GET', headers: { host: 'evil.example.com' } }, foreign)
  check('非回环 Host 被拒', foreign.statusCode === 403)
}

fs.rmSync(stateDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nPREFLIGHT ALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
