/**
 * 二维码渲染：把微信登录二维码的内容渲染成 SVG。
 *
 * 用随包发布的 vendor/qrcode.js（qrcode-generator 1.4.4，MIT，离线可用）。
 * 这个包自己声明了 `"type": "module"`，所以 plugin 目录内的任何 `.js` 都会被 Node 当成 ESM，
 * `createRequire()` 去 require 它会直接抛 ERR_REQUIRE_ESM。为了不改动已校验过哈希的 vendor 文件，
 * 这里用 `new Function` 把它放进一个只有 module/exports 的作用域里执行，强制走它的 UMD CommonJS 分支。
 * 选 SVG 而不是 PNG：浏览器直接显示、矢量清晰、不需要写 PNG 编码器。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let factory = null
let loadError = ''

/** 惰性加载 vendor 库，失败时把原因记下来而不是让插件起不来。 */
function loadFactory() {
  if (factory || loadError) return factory
  const file = path.join(PACKAGE_ROOT, 'vendor', 'qrcode.js')
  try {
    const source = fs.readFileSync(file, 'utf8')
    // UMD 尾巴：`typeof exports === 'object'` → `module.exports = factory()`。
    const sandbox = new Function('module', 'exports', 'require', `${source}\n;return module.exports;`)
    const moduleShim = { exports: {} }
    const exported = sandbox(moduleShim, moduleShim.exports, undefined)
    factory = typeof exported === 'function' ? exported : exported?.default
    if (typeof factory !== 'function') throw new Error('vendor/qrcode.js 未导出工厂函数')
  } catch (error) {
    loadError = String(error?.message ?? error)
  }
  return factory
}

/** vendor 库是否可用（面板据此决定是否退化成显示原始链接）。 */
export function qrAvailable() {
  return Boolean(loadFactory())
}

/** 加载失败原因。 */
export function qrLoadError() {
  return loadError
}

/**
 * 把文本渲染成二维码 SVG。
 * @param {string} text 二维码内容
 * @param {object} [options] 选项
 * @param {number} [options.scale] 每个模块的像素数
 * @param {number} [options.margin] 静默区模块数
 * @param {'L'|'M'|'Q'|'H'} [options.level] 容错等级
 * @returns {string|null} SVG 字符串；内容为空或过长时返回 null
 */
export function renderQrSvg(text, { scale = 8, margin = 2, level = 'M' } = {}) {
  const content = String(text ?? '')
  if (!content) return null
  const qrcode = loadFactory()
  if (!qrcode) return null

  let model
  try {
    // typeNumber 0 = 按内容自动选版本（qrcode-generator 1.4.x 支持）。
    model = qrcode(0, level)
    model.addData(content)
    model.make()
  } catch (error) {
    loadError = String(error?.message ?? error)
    return null
  }

  const count = model.getModuleCount()
  const size = (count + margin * 2) * scale
  const parts = []
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!model.isDark(row, col)) continue
      const x = (col + margin) * scale
      const y = (row + margin) * scale
      parts.push(`M${x} ${y}h${scale}v${scale}h-${scale}z`)
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="微信扫码登录二维码">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path d="${parts.join('')}" fill="#000000"/>`,
    '</svg>',
  ].join('')
}
