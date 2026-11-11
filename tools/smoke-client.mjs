#!/usr/bin/env node
/**
 * 客户端半自测：不需要浏览器。
 *
 * lib/client.js 是 DSH 模块加载器格式（`window.__ModuleLoader__.load({id, factory})`），
 * 这里把 window / document / React 全部打桩，验证：
 *   A. 文件能被加载，且按要求注册到加载器（id 正确、factory 是函数）
 *   B. factory 在只给 React 的情况下能跑通，导出 { apply, inject }
 *   C. apply() 把「侧边栏按钮」与「中间栏整页」注册到了正确的插槽，且 id/key 对齐
 *
 * 用法：node tools/smoke-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  -- ${detail}` : ''}\n`)
}

/* ── 打桩浏览器环境 ───────────────────────────────────────────────────── */

const styleElements = []
const fakeElement = () => ({
  dataset: {},
  textContent: '',
  remove() {},
})

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.document = {
  baseURI: 'http://127.0.0.1:19387/',
  head: { appendChild: (el) => styleElements.push(el) },
  createElement: () => fakeElement(),
  getElementById: () => null,
}

/* ── 打桩 React ───────────────────────────────────────────────────────── */

const react = {
  createElement(type, props, ...children) {
    return { __element: true, type, props: props ?? {}, children }
  },
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const requireShim = (name) => {
  if (name === 'react') return react
  throw new Error(`客户端半只应该 require('react')，实际 require 了 ${name}`)
}

/* ── 加载 ─────────────────────────────────────────────────────────────── */

const source = fs.readFileSync(CLIENT, 'utf8')
// 去掉开头的注释与空白，再看第一行实际代码。
const code = source.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*/g, '')
check('lib/client.js 存在且非空', source.length > 1000, `${(source.length / 1024).toFixed(1)} KB`)
check('使用 DSH 模块加载器格式', code.startsWith('window.__ModuleLoader__.load({'))
check('没有用 ESM import/export（否则加载器无法执行）', !/^\s*(import|export)\s/m.test(source))
check('没有用 JSX（无构建步骤）', !/<[A-Z][A-Za-z]*[\s/>]/.test(source))

await import(pathToFileURL(CLIENT).href)
check('加载后向 __ModuleLoader__ 注册了模块', captured !== null)
check('模块 id 是包名', captured?.id === 'dsh-wechat-clawbot', String(captured?.id))
check('factory 是函数', typeof captured?.factory === 'function')

let mod
try {
  mod = captured.factory(requireShim)
  check('factory 能跑通（只依赖 react）', true)
} catch (error) {
  check('factory 能跑通（只依赖 react）', false, error.message)
  process.exit(1)
}

check('导出 apply', typeof mod.apply === 'function')
check('导出 inject（短服务名）', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject))

/* ── apply() ──────────────────────────────────────────────────────────── */

const registered = []
const injected = []
const disposers = []
const ctx = {
  effect(fn, label) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  slots: {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, render) {
      registered.push({ options, render })
      return () => {}
    },
  },
}

try {
  mod.apply(ctx)
  check('apply() 不抛错', true)
} catch (error) {
  check('apply() 不抛错', false, error.message)
}

check('注入了 sidebar.panellist 与 main', injected.includes('sidebar.panellist') && injected.includes('main'), injected.join(', '))

const side = registered.find((r) => r.options.name === 'sidebar.panellist')
const page = registered.find((r) => r.options.name === 'main')
check('注册了侧边栏按钮', Boolean(side))
check('注册了中间栏页面', Boolean(page))
check('按钮 id 与页面 key 对齐', side?.options.id === page?.options.key && side?.options.id === 'wechat', `${side?.options.id} / ${page?.options.key}`)
check('按钮有中文标签', side?.options.label === '微信', String(side?.options.label))
check('按钮有排序值', typeof side?.options.order === 'number')
check('按钮与页面都有 render 函数', typeof side?.render === 'function' && typeof page?.render === 'function')

// 渲染函数必须能返回元素（不调用页面组件内部的 hooks）
try {
  const glyph = side.render({ size: 16, active: false })
  check('图标 render 返回元素', Boolean(glyph) && glyph.__element === true, String(glyph?.type?.name ?? glyph?.type))
} catch (error) {
  check('图标 render 返回元素', false, error.message)
}
try {
  const element = page.render({})
  check('页面 render 返回元素', Boolean(element) && element.__element === true, typeof element?.type === 'function' ? element.type.name : String(element?.type))
} catch (error) {
  check('页面 render 返回元素', false, error.message)
}

check('注入了一份样式', styleElements.length === 1, `count=${styleElements.length}`)
check('样式内容非空', (styleElements[0]?.textContent ?? '').length > 200)

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
