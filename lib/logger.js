/**
 * 插件日志：同时写 stdout 与 `<stateDir>/log.ndjson`。
 *
 * 为什么要落盘：DSH 桌面端的插件 stdout 不落地，出问题时用户和开发者都拿不到现场。
 * 每行一个 JSON 对象，超过上限就滚动一次（log.ndjson → log.ndjson.1）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from './store.js'

const MAX_BYTES = 2 * 1024 * 1024

/**
 * 创建 logger。
 * @param {string} [scope] 日志前缀
 * @returns {((msg: string) => void) & {warn: (msg: string) => void, error: (msg: string) => void, file: string}} logger
 */
export function createLogger(scope = 'wechat-clawbot') {
  let file = ''
  try {
    file = path.join(stateDir(), 'log.ndjson')
  } catch {
    file = ''
  }

  /**
   * 追加一行。
   * @param {'info'|'warn'|'error'} level 级别
   * @param {string} message 内容
   * @returns {void}
   */
  const append = (level, message) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg: String(message) })
    try {
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const stat = fs.existsSync(file) ? fs.statSync(file) : null
        if (stat && stat.size > MAX_BYTES) {
          fs.renameSync(file, `${file}.1`)
        }
        fs.appendFileSync(file, `${line}\n`, { mode: 0o600 })
      }
    } catch {
      /* 日志失败绝不影响主流程 */
    }
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    try {
      sink(`[${scope}] ${message}`)
    } catch {
      /* stdout 不可用时忽略 */
    }
  }

  const logger = (message) => append('info', message)
  logger.warn = (message) => append('warn', message)
  logger.error = (message) => append('error', message)
  logger.file = file
  return logger
}

/**
 * 读回最近若干行日志（面板/诊断用）。
 * @param {number} [limit] 行数
 * @returns {object[]} 日志条目，最新的在最后
 */
export function readLog(limit = 200) {
  try {
    const file = path.join(stateDir(), 'log.ndjson')
    const text = fs.readFileSync(file, 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { t: '', level: 'info', msg: line }
        }
      })
  } catch {
    return []
  }
}
