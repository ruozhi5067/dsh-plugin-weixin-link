#!/usr/bin/env node
/**
 * 对真实微信 iLink 服务做一次只读探活：取一张登录二维码。
 *
 * 这一步验证的是**真的能连上**：base URL、请求头、POST body、响应字段名。
 * 不消耗任何凭证，也不代表任何账号已登录。
 *
 * 用法：node tools/probe-ilink.mjs
 */
import { ILinkApi } from '../lib/ilink/api.js'
import { renderQrSvg } from '../lib/ilink/qr.js'

const api = new ILinkApi({ log: (msg) => process.stdout.write(`log: ${msg}\n`) })

process.stdout.write(`base: ${api.baseUrl}\n`)
const started = Date.now()
try {
  const response = await api.getBotQrcode([])
  const elapsed = Date.now() - started
  process.stdout.write(`OK in ${elapsed}ms\n`)
  process.stdout.write(`keys: ${Object.keys(response ?? {}).join(', ')}\n`)

  const qrcode = String(response?.qrcode ?? '')
  const content = String(response?.qrcode_img_content ?? '')
  process.stdout.write(`qrcode length: ${qrcode.length}  preview: ${qrcode.slice(0, 12)}…\n`)
  process.stdout.write(`qrcode_img_content length: ${content.length}  preview: ${content.slice(0, 80)}\n`)

  if (!qrcode || !content) {
    process.stdout.write('RESULT: FAIL — 响应缺少 qrcode 或 qrcode_img_content\n')
    process.exit(1)
  }

  const svg = renderQrSvg(content)
  process.stdout.write(`rendered svg bytes: ${svg ? svg.length : 0}\n`)
  process.stdout.write(svg ? 'RESULT: PASS — 真实服务返回二维码且可渲染\n' : 'RESULT: FAIL — 二维码渲染失败\n')
  process.exit(svg ? 0 : 1)
} catch (error) {
  process.stdout.write(`RESULT: FAIL — ${error?.name}: ${error?.message}\n`)
  process.exit(2)
}
