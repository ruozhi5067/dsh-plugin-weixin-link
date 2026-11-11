/**
 * 微信不渲染 Markdown，出站文本必须先转纯文本。
 *
 * 官方用字符级流式状态机 StreamingMarkdownFilter（src/messaging/markdown-filter.ts）。
 * 我们发送的是**已完成的整段文本**，不需要它的末尾字符暂留逻辑，因此这里实现等价的
 * 非流式版本，净效果与协议文档第 4.2 节的表格一致：
 *
 *   保留：代码围栏 / 行内代码 / 表格 / 分隔线 / 列表 / 引用 / `**粗体**` / `__粗体__` / `#`~`####` 标题
 *   剥离标记：内容含 CJK 的 `*斜体*`、`_斜体_`、`***粗斜***`、`___粗斜___`
 *   剥离标记：`#####`/`######` 标题标记与其后空格
 *   整段删除：`![alt](url)` 图片
 */

/** CJK 判定，照抄官方的 CJK_PATTERN。 */
const CJK = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/

/** 代码围栏 / 行内代码：这些区域内的内容不做任何改写。 */
const PROTECTED = /(```[\s\S]*?```|`[^`\n]*`)/g

/**
 * 处理一段不含代码的普通文本。
 * @param {string} text 输入片段
 * @returns {string} 纯文本片段
 */
function stripInline(text) {
  let out = text

  // 图片 `![alt](url)` 整段删除。若 `![x]` 后不接 `(`，官方会回吐 `![x]`。
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  out = out.replace(/!\[([^\]]*)\](?!\()/g, '![$1]')

  // 粗斜体：***x*** / ___x___，仅当内容含 CJK 时剥标记（两侧成对，内容不允许换行）。
  out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, (m, inner) => (CJK.test(inner) ? inner : m))
  out = out.replace(/___([^_\n]+)___/g, (m, inner) => (CJK.test(inner) ? inner : m))

  // 斜体：*x* / _x_，同样只在含 CJK 时剥标记。
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (m, lead, inner) => (CJK.test(inner) ? lead + inner : m))
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, (m, lead, inner) => (CJK.test(inner) ? lead + inner : m))

  // H5/H6 标题：标记与其后一个空格剥掉，保留文字；`#`~`####` 原样保留。
  out = out.replace(/^(\s*)(#{5,6})[ \t]+/gm, '$1')

  // 行尾空白清理（微信里没有意义，且会让对齐看起来奇怪）。
  return out.replace(/[ \t]+$/gm, '')
}

/**
 * Markdown → 微信纯文本。
 * @param {string} input 助手输出的原始 Markdown
 * @returns {string} 可直接发送的文本
 */
export function toWeChatText(input) {
  const text = String(input ?? '')
  if (!text) return ''

  // 代码块与行内代码原样保留，用占位符保护起来（占位符不含 Markdown 元字符）。
  const stash = []
  const guarded = text.replace(PROTECTED, (m) => {
    stash.push(m)
    return `\u0000${stash.length - 1}\u0000`
  })

  const processed = stripInline(guarded)

  return processed.replace(/\u0000(\d+)\u0000/g, (_m, index) => stash[Number(index)] ?? '')
}

/**
 * 一条微信文本消息的安全长度。服务端单条文本上限未确认（协议文档第 9 节第 4 条），
 * 这里采取保守分片：按行累积，尽量不撕裂 URL/单词。
 * @param {string} text 纯文本
 * @param {number} limit 单片最大字符数
 * @returns {string[]} 分片
 */
export function chunkText(text, limit = 2000) {
  const source = String(text ?? '')
  if (source.length <= limit) return source ? [source] : []

  const chunks = []
  let current = ''

  const flush = () => {
    if (current) {
      chunks.push(current)
      current = ''
    }
  }

  for (const rawLine of source.split('\n')) {
    let line = rawLine
    // 单行超长（例如一整段没有换行的长文）：按硬宽度切开。
    while (line.length > limit) {
      flush()
      chunks.push(line.slice(0, limit))
      line = line.slice(limit)
    }
    if (!line) {
      current = current ? `${current}\n` : current
      continue
    }
    if (current && current.length + line.length + 1 > limit) flush()
    current = current ? `${current}\n${line}` : line
  }
  flush()
  return chunks
}
