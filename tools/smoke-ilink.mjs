#!/usr/bin/env node
/**
 * iLink 协议层离线自测：二维码渲染、Markdown 过滤、分片、uint64 精度。
 * 用法：node tools/smoke-ilink.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderQrSvg, qrAvailable, qrLoadError } from '../lib/ilink/qr.js'
import { toWeChatText, chunkText } from '../lib/ilink/markdown.js'
import { quoteLosslessIds, parseWeixinApiJson } from '../lib/ilink/api.js'
import { parseAesKey, encryptEcb, decryptEcb, encryptedSize } from '../lib/ilink/media.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let failures = 0

function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  process.stdout.write(`[${status}] ${name}${detail ? `  -- ${detail}` : ''}\n`)
}

// ── 二维码 ────────────────────────────────────────────────────────────────
check('vendor qrcode 可加载', qrAvailable(), qrLoadError() || 'ok')

// 真实的微信登录二维码内容形态：一段较长的 URL/令牌文本。
const loginPayload = `https://weixin.qq.com/x/${'A'.repeat(180)}?bot_type=3&ts=${Date.now()}`
const svg = renderQrSvg(loginPayload)
check('长内容二维码渲染成功', typeof svg === 'string' && svg.length > 1000, `svg=${svg?.length ?? 0}B`)
if (svg) {
  check('SVG 是自包含的 svg 根元素', svg.startsWith('<svg') && svg.endsWith('</svg>'))
  check('SVG 含 path 数据', svg.includes('<path d="M'))
  const modules = (svg.match(/M\d+ \d+h/g) ?? []).length
  // 版本 1 起 21x21，扣除定位图案后模块数应落在合理区间。
  check('模块数量合理', modules > 150 && modules < 20000, `modules=${modules}`)
  mkdirSync(path.join(HERE, '..', '.archive'), { recursive: true })
  writeFileSync(path.join(HERE, '..', '.archive', 'qr-test.svg'), svg)
}

check('空内容返回 null', renderQrSvg('') === null)
const shortSvg = renderQrSvg('https://example.com')
check('短内容二维码渲染成功', typeof shortSvg === 'string' && shortSvg.length > 200)

// ── Markdown 过滤 ─────────────────────────────────────────────────────────
check('保留粗体', toWeChatText('这是**重点**内容') === '这是**重点**内容')
check('剥 CJK 斜体标记', toWeChatText('这是*斜体*内容') === '这是斜体内容')
check('保留英文斜体标记', toWeChatText('this is *italic* text') === 'this is *italic* text')
check('剥 CJK 粗斜标记', toWeChatText('***很重要***') === '很重要')
check('删除图片', toWeChatText('看图 ![alt](https://x/y.png) 结束') === '看图  结束')
check('保留代码块', toWeChatText('```js\nconst a = 1 * 2\n```') === '```js\nconst a = 1 * 2\n```')
check('保留行内代码', toWeChatText('用 `a * b` 相乘') === '用 `a * b` 相乘')
check('H5 剥标记保留文字', toWeChatText('##### 五级标题') === '五级标题')
check('H2 原样保留', toWeChatText('## 二级标题') === '## 二级标题')
check('列表原样保留', toWeChatText('- 第一项\n- 第二项') === '- 第一项\n- 第二项')
check('引用原样保留', toWeChatText('> 引用内容') === '> 引用内容')
check(
  '代码块内的星号不被改写',
  toWeChatText('前\n```\n*不是斜体*\n```\n后') === '前\n```\n*不是斜体*\n```\n后',
)

// ── 分片 ──────────────────────────────────────────────────────────────────
check('短文本不分片', chunkText('你好', 100).length === 1)
const long = Array.from({ length: 50 }, (_, i) => `第 ${i} 行内容`).join('\n')
const chunks = chunkText(long, 100)
check('长文本分片', chunks.length > 1, `chunks=${chunks.length}`)
check('分片后内容无损', chunks.join('\n').replace(/\n+/g, '\n') === long.replace(/\n+/g, '\n'))
check('单片不超过上限', chunks.every((c) => c.length <= 100))
const noNewline = 'x'.repeat(450)
const hard = chunkText(noNewline, 100)
check('无换行长文硬切', hard.every((c) => c.length <= 100) && hard.join('') === noNewline, `n=${hard.length}`)

// ── uint64 精度 ───────────────────────────────────────────────────────────
const wire = '{"ret":0,"msgs":[{"message_id":7400000000000000001,"msg_id":123456789012345678,"svr_id":9}],"get_updates_buf":"abc"}'
const quoted = quoteLosslessIds(wire)
check('uint64 被加引号', quoted.includes('"message_id":"7400000000000000001"'))
const parsed = parseWeixinApiJson(wire)
check('message_id 无精度丢失', parsed.msgs[0].message_id === '7400000000000000001', String(parsed.msgs[0].message_id))
check('游标保留', parsed.get_updates_buf === 'abc')
check('短数字不被误加引号', parseWeixinApiJson('{"ret":0,"seq":123}').seq === 123)

// ── 媒体加解密 ────────────────────────────────────────────────────────────
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
check('hex 密钥解析', parseAesKey(key.toString('hex')).equals(key))
check('base64(16 原始字节) 解析', parseAesKey(key.toString('base64')).equals(key))
check('base64(32 hex 字符) 解析', parseAesKey(Buffer.from(key.toString('hex')).toString('base64')).equals(key))
check('非法密钥返回 undefined', parseAesKey('short') === undefined)
check('密文长度符合 PKCS#7', encryptedSize(12345) === Math.ceil((12345 + 1) / 16) * 16)
const plain = Buffer.from('微信媒体往返测试 payload', 'utf8')
check('AES-128-ECB 往返一致', decryptEcb(encryptEcb(plain, key), key).equals(plain))

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
