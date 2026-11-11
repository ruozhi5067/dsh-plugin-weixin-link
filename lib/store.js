/**
 * 插件持久化层。
 *
 * 布局（$DSH_HOME/wechat-clawbot/）：
 *   settings.json                         插件设置 + 白名单 + 配对码
 *   accounts.json                         账号 ID 列表，末尾 = 最新
 *   accounts/<accountId>.json             {"token","savedAt","baseUrl","userId"}  (0600)
 *   accounts/<accountId>.sync.json        {"get_updates_buf":"..."}
 *   accounts/<accountId>.context-tokens.json  {"<userId>":"<context_token>"}
 *
 * 字段语义照抄官方 openclaw-weixin（src/auth/accounts.ts、src/storage/sync-buf.ts），
 * 存放目录换成 DSH 自己的位置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomInt } from 'node:crypto'

const DEFAULT_SETTINGS = {
  version: 1,
  /** 是否启用长轮询（可在面板里开关）。 */
  enabled: true,
  /** 白名单：允许驱动 DSH 的微信用户 ID。 */
  allowFrom: [],
  /** 首次配对码；发送该码即可把自己加入白名单。 */
  pairingCode: '',
  /** 新会话的工作目录（Agent 的 cwd）。 */
  workspace: '',
  /** 新会话使用的 provider/model，留空用 DSH 默认。 */
  provider: '',
  model: '',
  /**
   * 微信里显示多少：
   *   final — 只发助手最终回复
   *   tools — 再加工具调用与结果
   *   all   — 再加深度思考（reasoning）
   */
  verbose: 'all',
  /** 每条微信会话对应的 DSH 会话 ID 映射：{"<userId>":"<sessionId>"}。 */
  sessions: {},
  /** 每条会话的统计，仅用于面板展示。 */
  stats: {},
}

/**
 * 状态目录；`$DSH_WECHAT_CLAWBOT_DIR` 可覆盖（便于测试）。
 * @returns {string} 绝对路径
 */
export function stateDir() {
  const override = process.env.DSH_WECHAT_CLAWBOT_DIR
  if (override) return path.resolve(override)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'wechat-clawbot')
}

/**
 * 确保目录存在。
 * @param {string} dir 目录
 * @returns {string} 同一个目录
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 读 JSON，失败给回退值。
 * @param {string} file 文件
 * @param {any} fallback 回退值
 * @returns {any} 解析结果
 */
export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 原子写 JSON（先写临时文件再 rename），权限 0600。
 * @param {string} file 文件
 * @param {any} value 内容
 * @returns {void}
 */
export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** settings.json 路径。 */
const settingsFile = () => path.join(ensureDir(stateDir()), 'settings.json')
/** accounts.json 路径。 */
const accountsIndexFile = () => path.join(ensureDir(stateDir()), 'accounts.json')

/**
 * 读取设置，缺失字段用默认值补齐。
 * @returns {typeof DEFAULT_SETTINGS} 设置
 */
export function loadSettings() {
  const raw = readJson(settingsFile(), {}) ?? {}
  return { ...DEFAULT_SETTINGS, ...raw }
}

/**
 * 合并写回设置，返回合并后的结果。
 * @param {object} patch 增量
 * @returns {typeof DEFAULT_SETTINGS} 新设置
 */
export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  writeJson(settingsFile(), next)
  return next
}

/**
 * 账号文件路径。
 * @param {string} accountId 账号 ID
 * @returns {string} 路径
 */
const accountFile = (accountId) => path.join(ensureDir(path.join(stateDir(), 'accounts')), `${normalizeAccountId(accountId)}.json`)

/**
 * 账号 ID 规范化：文件名安全。
 * 对齐官方 normalizeAccountId 的历史约定（`xxx@im.bot` → `xxx-im-bot`）：
 * 除了 `[A-Za-z0-9_-]` 之外的字符（含 `.`）一律压成 `-`，并合并连续的 `-`。
 * @param {string} accountId 原始 ID
 * @returns {string} 规范化结果
 */
export function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'unknown'
}

/**
 * 读取账号凭证。
 * @param {string} accountId 账号 ID
 * @returns {{token: string, savedAt: string, baseUrl?: string, userId?: string}|undefined} 凭证
 */
export function loadAccount(accountId) {
  return readJson(accountFile(accountId), undefined)
}

/**
 * 保存账号凭证并登记到 accounts.json（登录顺序追加，末尾最新）。
 * @param {object} credentials 凭证
 * @param {string} credentials.accountId 账号 ID
 * @param {string} credentials.token bot_token
 * @param {string} [credentials.baseUrl] 服务端下发的 baseurl
 * @param {string} [credentials.userId] 绑定的微信用户 ID
 * @returns {object} 落盘内容
 */
export function saveAccount({ accountId, token, baseUrl, userId }) {
  const record = {
    token,
    savedAt: new Date().toISOString(),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  }
  writeJson(accountFile(accountId), record)
  const ids = listAccountIds().filter((id) => id !== normalizeAccountId(accountId))
  ids.push(normalizeAccountId(accountId))
  writeJson(accountsIndexFile(), ids)
  return record
}

/**
 * 全部已登录账号 ID（末尾最新）。
 * @returns {string[]} 账号 ID 列表
 */
export function listAccountIds() {
  const ids = readJson(accountsIndexFile(), [])
  if (Array.isArray(ids) && ids.length) return ids.map(String)
  // 索引缺失时从目录恢复。
  try {
    return fs.readdirSync(path.join(stateDir(), 'accounts'))
      .filter((name) => name.endsWith('.json') && !name.endsWith('.sync.json') && !name.endsWith('.context-tokens.json'))
      .map((name) => name.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/**
 * 删除账号（凭证、游标、会话令牌一起删）。
 * @param {string} accountId 账号 ID
 * @returns {void}
 */
export function removeAccount(accountId) {
  const id = normalizeAccountId(accountId)
  for (const file of [accountFile(id), syncFile(id), contextTokenFile(id)]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 删除失败不阻断 */
    }
  }
  writeJson(accountsIndexFile(), listAccountIds().filter((item) => item !== id))
}

/** 游标文件。 */
const syncFile = (accountId) => path.join(stateDir(), 'accounts', `${normalizeAccountId(accountId)}.sync.json`)

/**
 * 读取长轮询游标。
 * @param {string} accountId 账号 ID
 * @returns {string} get_updates_buf
 */
export function loadCursor(accountId) {
  const raw = readJson(syncFile(accountId), {})
  return typeof raw?.get_updates_buf === 'string' ? raw.get_updates_buf : ''
}

/**
 * 保存长轮询游标；空值不覆盖旧游标（官方语义）。
 * @param {string} accountId 账号 ID
 * @param {string} cursor 新游标
 * @returns {void}
 */
export function saveCursor(accountId, cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return
  writeJson(syncFile(accountId), { get_updates_buf: cursor })
}

/** context token 文件。 */
const contextTokenFile = (accountId) => path.join(stateDir(), 'accounts', `${normalizeAccountId(accountId)}.context-tokens.json`)

/**
 * 读取某个用户的 context_token。
 * @param {string} accountId 账号 ID
 * @param {string} userId 用户 ID
 * @returns {string} token
 */
export function loadContextToken(accountId, userId) {
  const all = readJson(contextTokenFile(accountId), {}) ?? {}
  return typeof all[userId] === 'string' ? all[userId] : ''
}

/**
 * 记录某个用户最新的 context_token（每条入站消息都会刷新）。
 * @param {string} accountId 账号 ID
 * @param {string} userId 用户 ID
 * @param {string} token 新 token
 * @returns {void}
 */
export function saveContextToken(accountId, userId, token) {
  if (!token) return
  const all = readJson(contextTokenFile(accountId), {}) ?? {}
  all[userId] = token
  writeJson(contextTokenFile(accountId), all)
}

// ── 访问控制 ──────────────────────────────────────────────────────────────

/**
 * 该微信用户是否在白名单里。
 * @param {string} userId 用户 ID
 * @returns {boolean} 是否允许
 */
export function isAllowed(userId) {
  const settings = loadSettings()
  return settings.allowFrom.includes(userId)
}

/**
 * 加入白名单。
 * @param {string} userId 用户 ID
 * @returns {boolean} 是否新增
 */
export function allow(userId) {
  const settings = loadSettings()
  if (settings.allowFrom.includes(userId)) return false
  saveSettings({ allowFrom: [...settings.allowFrom, userId] })
  return true
}

/**
 * 移出白名单。
 * @param {string} userId 用户 ID
 * @returns {void}
 */
export function revoke(userId) {
  const settings = loadSettings()
  saveSettings({ allowFrom: settings.allowFrom.filter((id) => id !== userId) })
}

/**
 * 当前配对码；没有就生成一个 6 位数字。
 * @returns {string} 配对码
 */
export function pairingCode() {
  const settings = loadSettings()
  if (settings.pairingCode) return settings.pairingCode
  return rotatePairingCode()
}

/**
 * 重新生成配对码。
 * @returns {string} 新配对码
 */
export function rotatePairingCode() {
  const code = String(randomInt(100000, 1000000))
  saveSettings({ pairingCode: code })
  return code
}

/**
 * 判断文本是否是当前配对码（允许前后空白）。
 * @param {string} text 用户输入
 * @returns {boolean} 是否匹配
 */
export function matchesPairingCode(text) {
  const settings = loadSettings()
  if (!settings.pairingCode) return false
  return String(text ?? '').trim() === settings.pairingCode
}

// ── 会话映射 ──────────────────────────────────────────────────────────────

/**
 * 把用「原始账号 ID」当键的历史会话映射迁移成规范化键。
 *
 * 为什么需要：登录成功后服务端下发的是原始 accountId（形如 `xxx@im.bot`），
 * 而重启后账号是从 accounts.json 读出来的**规范化** ID（`xxx-im-bot`）。
 * 早期版本前者被直接当成了通道键，于是**每次重启都会丢掉绑定、开出一段新会话**。
 * 这里把旧键归一到新键，已经在用新键的映射优先保留。
 * @returns {boolean} 是否有迁移发生
 */
export function migrateChannelKeys() {
  const settings = loadSettings()
  const sessions = { ...(settings.sessions ?? {}) }
  let changed = false
  for (const key of Object.keys(sessions)) {
    const index = key.indexOf(':')
    if (index <= 0) continue
    const account = key.slice(0, index)
    const user = key.slice(index + 1)
    const normalized = normalizeAccountId(account)
    if (normalized === account) continue
    const next = `${normalized}:${user}`
    if (!sessions[next]) sessions[next] = sessions[key]
    delete sessions[key]
    changed = true
  }
  if (changed) saveSettings({ sessions })
  return changed
}

/**
 * 取某个微信会话已绑定的 DSH 会话 ID。
 * @param {string} channelKey 通道键（`<规范化账号ID>:<微信用户ID>`）
 * @returns {string} 会话 ID，未绑定返回空串
 */
export function sessionFor(channelKey) {
  const settings = loadSettings()
  return String(settings.sessions?.[channelKey] ?? '')
}

/**
 * 绑定/解绑 DSH 会话。
 * @param {string} channelKey 通道键
 * @param {string} sessionId 会话 ID；空串表示解绑
 * @returns {void}
 */
export function bindSession(channelKey, sessionId) {
  const sessions = { ...(loadSettings().sessions ?? {}) }
  if (sessionId) sessions[channelKey] = sessionId
  else delete sessions[channelKey]
  saveSettings({ sessions })
}

/**
 * 记录一次交互统计（面板展示用）。
 * @param {string} channelKey 通道键
 * @param {object} stat 统计增量
 * @returns {void}
 */
export function recordStat(channelKey, stat) {
  const stats = { ...(loadSettings().stats ?? {}) }
  const previous = stats[channelKey] ?? { messages: 0, replies: 0 }
  stats[channelKey] = { ...previous, ...stat, updatedAt: new Date().toISOString() }
  saveSettings({ stats })
}
