/**
 * 微信 CDN 媒体上下行（AES-128-ECB + PKCS#7）。
 *
 * 照抄官方 src/cdn/pic-decrypt.ts、cdn-upload.ts、cdn-url.ts、media/media-download.ts。
 * 详见 docs/wechat-ilink-protocol.md 第 5 节。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { CDN_BASE, MEDIA_MAX_BYTES, MEDIA_TYPE } from './constants.js'

/** 图片扩展名 → MIME。 */
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}

/**
 * 解析 CDN 的 base64 密钥。接受两种形式：
 * base64 → 16 字节原始密钥，或 base64 → 32 个 ASCII hex 字符。
 * @param {string} value base64 密钥
 * @returns {Buffer|undefined} 16 字节密钥
 */
export function parseAesKey(value) {
  if (!value) return undefined
  const text = String(value).trim()
  // 直接就是 32 位 hex：image_item.aeskey 的形态（官方在图片分支优先用它）。
  if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex')
  let raw
  try {
    raw = Buffer.from(text, 'base64')
  } catch {
    return undefined
  }
  if (raw.length === 16) return raw
  if (raw.length === 32 && /^[0-9a-fA-F]{32}$/.test(raw.toString('utf8'))) {
    return Buffer.from(raw.toString('utf8'), 'hex')
  }
  return undefined
}

/**
 * AES-128-ECB + PKCS#7 解密。
 * @param {Buffer} data 密文
 * @param {Buffer} key 16 字节密钥
 * @returns {Buffer} 明文
 */
export function decryptEcb(data, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/**
 * AES-128-ECB + PKCS#7 加密。
 * @param {Buffer} data 明文
 * @param {Buffer} key 16 字节密钥
 * @returns {Buffer} 密文
 */
export function encryptEcb(data, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/**
 * PKCS#7 之后的密文长度。
 * @param {number} rawSize 明文字节数
 * @returns {number} 密文字节数
 */
export function encryptedSize(rawSize) {
  return Math.ceil((rawSize + 1) / 16) * 16
}

/**
 * 构造下载 URL。
 * @param {any} media CDN 媒体引用对象
 * @returns {string} URL
 */
export function mediaDownloadUrl(media) {
  if (media?.full_url) return String(media.full_url)
  const param = media?.encrypt_query_param
  if (!param) return ''
  return `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(String(param))}`
}

/**
 * 入站媒体：解密后的信息。
 * @typedef {{bytes: Buffer, name: string, mime: string, kind: string}} InboundMedia
 */

/**
 * 下载并解密一条入站媒体 item。
 * @param {any} item 入站 item（image_item / file_item / video_item …）
 * @param {number} [maxBytes] 体积上限
 * @returns {Promise<InboundMedia|null>} 成功返回媒体，跳过/失败返回 null
 */
export async function downloadInboundMedia(item, maxBytes = MEDIA_MAX_BYTES) {
  const type = Number(item?.type ?? 0)
  const payload = item?.image_item ?? item?.video_item ?? item?.file_item ?? item?.voice_item
  const media = payload?.media
  if (!media) return null

  let key
  if (type === 2) {
    // 图片：优先 image_item.aeskey（hex），其次 media.aes_key；都没有就当明文。
    const hexKey = payload?.aeskey
    key = /^[0-9a-fA-F]{32}$/.test(String(hexKey ?? '')) ? Buffer.from(String(hexKey), 'hex') : parseAesKey(media.aes_key)
  } else {
    key = parseAesKey(media.aes_key)
    // 语音/文件/视频必须带密钥，否则官方直接跳过。
    if (!key) return null
  }

  const url = mediaDownloadUrl(media)
  if (!url) return null

  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  } catch {
    return null
  }
  if (!response.ok) return null
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > maxBytes) return null
  const cipher = Buffer.from(await response.arrayBuffer())
  if (cipher.length > maxBytes) return null

  let bytes = cipher
  if (key) {
    try {
      bytes = decryptEcb(cipher, key)
    } catch {
      return null
    }
  }

  if (type === 2) {
    return { bytes, name: `wechat-image-${Date.now()}.png`, mime: 'image/png', kind: 'image' }
  }
  if (type === 4) {
    const name = String(payload?.file_name ?? `wechat-file-${Date.now()}`)
    return { bytes, name, mime: guessMime(name), kind: 'file' }
  }
  if (type === 5) {
    const name = `wechat-video-${Date.now()}.mp4`
    return { bytes, name, mime: 'video/mp4', kind: 'video' }
  }
  if (type === 3) {
    // 语音解密后是 SILK；没有转码器时按原样保存，交给 Agent 自行处理。
    return { bytes, name: `wechat-voice-${Date.now()}.silk`, mime: 'audio/silk', kind: 'voice' }
  }
  return null
}

/**
 * 按扩展名猜 MIME。
 * @param {string} name 文件名
 * @returns {string} MIME
 */
export function guessMime(name) {
  const ext = String(name).toLowerCase().split('.').pop() ?? ''
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext]
  const table = {
    txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
    pdf: 'application/pdf', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  }
  return table[ext] ?? 'application/octet-stream'
}

/**
 * 把本地文件上传到微信 CDN，返回可放进消息 item 的媒体引用。
 * @param {import('./api.js').ILinkApi} api API 客户端
 * @param {Buffer} plain 明文
 * @param {string} fileName 文件名
 * @param {number} mediaType MEDIA_TYPE.*
 * @param {string} toUserId 目标用户
 * @returns {Promise<{encrypt_query_param: string, aes_key: string, encrypt_type: number, size: number}|null>} 媒体引用
 */
export async function uploadOutboundMedia(api, plain, fileName, mediaType, toUserId) {
  const rawSize = plain.length
  if (rawSize <= 0 || rawSize > MEDIA_MAX_BYTES) return null
  const fileKey = randomBytes(16).toString('hex')
  const aesKey = randomBytes(16)
  const md5 = createHash('md5').update(plain).digest('hex')

  const target = await api.getUploadUrl({
    filekey: fileKey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: rawSize,
    rawfilemd5: md5,
    filesize: encryptedSize(rawSize),
    aeskey: aesKey.toString('hex'),
    ...(mediaType === MEDIA_TYPE.FILE ? { file_name: fileName } : {}),
  })

  const cipher = encryptEcb(plain, aesKey)
  const uploadUrl = target.upload_full_url
    ? String(target.upload_full_url)
    : `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(String(target.upload_param))}&filekey=${encodeURIComponent(fileKey)}`

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response
    try {
      response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: cipher,
        signal: AbortSignal.timeout(60_000),
      })
    } catch {
      continue
    }
    if (response.status >= 400 && response.status < 500) return null
    const param = response.headers.get('x-encrypted-param')
    if (response.status === 200 && param) {
      return {
        // 出站 aes_key 是 base64(32 字符 hex 字符串)，不是原始密钥的 base64。
        encrypt_query_param: param,
        aes_key: Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64'),
        encrypt_type: 1,
        size: cipher.length,
      }
    }
  }
  return null
}
