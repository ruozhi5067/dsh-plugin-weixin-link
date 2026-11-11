/**
 * 构造 DSH 的 user 消息。
 *
 * 为什么手搓而不是 import `@deepseek-ai/dsh-llm` 的 `createUserMessage`：
 * 插件是以 `link:`/普通依赖装进 profile 的，Node 从本包真实路径向上找 node_modules，
 * 解析不到 DSH 自己的 `@deepseek-ai/*`（只有 DSH 内置包才在那个目录里）。
 * 而 `agent.followup()` 是**直接把对象塞进 inbox** 的（dsh-agent-loop/lib/index.js:
 * `followup(input) { this.send(input, 'next-turn', true) }` → `inbox.splice(...)`），
 * 它不会帮你补 id/role，所以必须给出**结构完全一致**的消息。
 *
 * 官方实现等价于（dsh-llm/lib/types/message.js）：
 *   createUserMessage(input) → createMessage({ ...input, role: 'user' })
 *   createMessage(input)     → deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
 * 其中 `brandString` 是恒等函数（dsh-brand：`function brandString(value) { return value }`，
 * 且该包显式声明「多份独立安装的副本产出的值可互换」）。
 * 因此下面的产物与官方工厂逐字段一致，可直接交给 followup()/steer()/inject()。
 */

/**
 * 递归冻结（对齐 dsh-llm 的 deepFreeze）。
 * @param {any} value 任意值
 * @returns {any} 同一个值
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 生成一条带身份、已冻结的 user 消息。
 * @param {object} input 输入
 * @param {Array<object>} input.content 内容块，例如 [{ type: 'text', text: '你好' }]
 * @param {object} [input.source] 来源标记，默认 { kind: 'user' }
 * @returns {{id: string, role: 'user', content: Array<object>, source: object}} 不可变消息
 */
export function createUserMessage({ content, source = { kind: 'user' } }) {
  return deepFreeze({
    id: globalThis.crypto?.randomUUID?.() ?? fallbackUuid(),
    role: 'user',
    content,
    source,
  })
}

/**
 * 没有全局 crypto.randomUUID 时的兜底（Node 24 一定有，纯防御）。
 * @returns {string} UUID
 */
function fallbackUuid() {
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  let out = ''
  for (let i = 0; i < 32; i += 1) out += hex()
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-a${out.slice(17, 20)}-${out.slice(20, 32)}`
}

/**
 * 一条消息里所有 text 块的纯文本（回复/日志用）。
 * @param {any} message 消息
 * @returns {string} 文本
 */
export function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
