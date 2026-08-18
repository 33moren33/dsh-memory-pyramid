/**
 * memory_handoff —— 文本出生册（imported-text shelf）。
 *
 * 记忆的原料有两种出生册：**对话**住在 dsh 自己的会话日志里（我们只存
 * `(sessionId, seq)` 指针指回去）；**文本**（别的项目的记忆 md、笔记、书）
 * 原本住在塔外的文件系统里——路径会腐、文件会被编辑，指过去的锚点迟早撒谎。
 *
 * 解法与对话侧同构：**把导入那一刻的快照收进数据目录自己的
 * `memory_handoff/` 文件夹**，事实行的锚点指向这份快照而不是外面的活文件。
 * 放入时刻＝这份文本成为记忆的时刻；此后外面的原文怎么改，塔里的锚永远
 * 指着"当初读的那一版"。这也让整个数据目录自带原文、可整体搬迁。
 *
 * 快照**上架即应冻结**：文件夹是开放接口，机制上拦不住覆盖，但每份快照
 * 上架时的字节数与指纹都在流水上（{@link sweepShelf}），改过的快照在
 * `memory_open` 时会被点破——拦不住撒谎，但保证谎被看见。想导新版
 * 就换个名字（比如带日期后缀），旧版是历史。
 *
 * 锚点格式：LOG 的 sid 字段（44 字节 ASCII）写 `md:<name>`。因此名字必须
 * 是单层 ASCII 文件名且 ≤ 41 字符——校验在 {@link fitShelfName}，装不下
 * 或不合法就当场拒绝，绝不静默截断（`sid` 32→44 的教训：截断的指针
 * 看着仍像指针，却指不到任何地方）。
 *
 * @module dsh-memory/handoff
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 出生册文件夹名（位于数据目录内）。 */
export const HANDOFF_DIR = 'memory_handoff'

/**
 * 出生册流水文件名（架子文件夹内的点文件，{@link listShelf} 会跳过它）。
 *
 * 一行一次上架事件：`上架时刻|名字|字节数|sha256前16|源文件mtime`。
 * 只追加、永不改写。它是**审计级旁挂**（§13.7 模型署名同一先例）：丢了只丢
 * "何时上架/源日期"这两笔账，快照本身与锚一概不受影响。
 *
 * 为什么记源 mtime：LOG 的时间戳是**入库钟**（记忆诞生于何时），而书的出版年、
 * md 的最后修改日是**关于内容的事实**——它不占时间轴，落在这里。文件系统的
 * mtime 一次不带 `-p` 的搬迁就会被洗掉，抄进流水才耐搬。
 */
const JOURNAL = '.journal'

/** 锚点前缀。sid 字段以此开头即为文本锚，否则按会话锚解释。 */
export const HANDOFF_ANCHOR_PREFIX = 'md:'

/** sid 字段 44 字节减去前缀 3 字节。 */
const NAME_MAX = 44 - HANDOFF_ANCHOR_PREFIX.length

/**
 * 上架方式＝把文件放进 `memory_handoff/` 文件夹，没有写入工具（CEO 裁决）。
 * 复制时想保住源日期用 `cp -p`；不保也只丢那一列审计。插件每次装载做一遍
 * {@link sweepShelf}：补登新文件、警告装不进锚的名字——文件夹即接口。
 */

/**
 * 校验并返回合法的出生册文件名。
 *
 * 只收一层：路径分隔符、盘符、`..` 一律拒绝——名字用来当锚，不是当路径。
 * 非 ASCII 拒绝：sid 字段按 ASCII 写入，多字节字符会静默变成问号。
 *
 * @param {unknown} value - 待校验名字。
 * @returns {string}
 * @throws {Error} 名字非法或装不进锚点字段。
 */
export function fitShelfName(value) {
  if (typeof value !== 'string') throw new Error('`source` must be a string')
  const name = value.trim()
  if (name === '' || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
    throw new Error(`bad shelf name: '${name}' — one plain file name, no path parts`)
  }
  if (!/^[\x21-\x7e]+$/.test(name)) {
    throw new Error(`bad shelf name: '${name}' — ASCII only, so it fits the fixed-width anchor field`)
  }
  if (name.length > NAME_MAX) {
    throw new Error(`shelf name '${name}' is ${name.length} chars; the anchor field holds ${NAME_MAX}`)
  }
  return name
}

/**
 * 数据目录内的出生册路径。
 * @param {string} dir - 数据目录。
 * @param {string} [name] - 快照名。
 * @returns {string}
 */
export function shelfPath(dir, name) {
  return name === undefined
    ? path.join(dir, HANDOFF_DIR)
    : path.join(dir, HANDOFF_DIR, name)
}

/**
 * 内容指纹：sha256 的前 16 个十六进制位。够认出"改没改"，且流水一行装得下。
 * @param {string | Buffer} content - 快照内容。
 * @returns {string}
 */
export function sha16(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * 读流水，同名多行时后写的作数（重新上架＝新的一笔，旧账仍在纸上）。
 * @param {string} dir - 数据目录。
 * @returns {Map<string, { at: string, bytes: number, sha: string, mtime: string }>}
 */
export function readJournal(dir) {
  const out = new Map()
  let raw
  try {
    raw = fs.readFileSync(path.join(shelfPath(dir), JOURNAL), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return out
    throw error
  }
  for (const line of raw.split('\n')) {
    const [at, name, bytes, sha, mtime] = line.split('|')
    if (at === undefined || name === undefined || sha === undefined) continue
    out.set(name, { at, bytes: Number(bytes), sha, mtime: mtime ?? '' })
  }
  return out
}

/**
 * 巡架：给手动放入的文件补登流水、点出装不进锚点字段的名字。
 *
 * 幂等——已在流水上的名字一个字不写。每次插件装载跑一遍，代价是
 * 一次 readdir 加新文件各一次读。**只登记不搬动**：文件夹即接口，
 * 内容永远以放进来那一刻的样子为准。
 *
 * @param {string} dir - 数据目录。
 * @returns {{ registered: Array<{ name: string, bytes: number }>, invalid: Array<{ name: string, reason: string }> }}
 */
export function sweepShelf(dir) {
  const registered = []
  const invalid = []
  const journal = readJournal(dir)
  const lines = []
  for (const name of listShelf(dir)) {
    try {
      fitShelfName(name)
    } catch (error) {
      invalid.push({ name, reason: error.message })
      continue
    }
    if (journal.has(name)) continue
    const file = shelfPath(dir, name)
    const stat = fs.statSync(file)
    if (!stat.isFile()) continue
    const content = fs.readFileSync(file)
    lines.push([
      new Date().toISOString(), name, stat.size, sha16(content), stat.mtime.toISOString(),
    ].join('|'))
    registered.push({ name, bytes: stat.size })
  }
  if (lines.length > 0) {
    fs.appendFileSync(path.join(shelfPath(dir), JOURNAL), lines.join('\n') + '\n')
  }
  return { registered, invalid }
}

/**
 * 待导入清单＝集合减法：架上合法的名字，减去已被任何事实锚引用的名字。
 * 与「欠债从层文件长度推导」同一种洁癖——不存队列，每次现算。
 * @param {string} dir - 数据目录。
 * @param {Set<string>} anchored - 已出现在事实锚里的快照名集合。
 * @returns {string[]} 字典序。
 */
export function pendingImports(dir, anchored) {
  return listShelf(dir).filter((name) => {
    try {
      fitShelfName(name)
    } catch {
      return false
    }
    return !anchored.has(name)
  })
}

/**
 * 对一份快照做"还是不是入册时那份"的核对。
 * @param {string} dir - 数据目录。
 * @param {string} name - 快照名。
 * @param {string} content - 当前读到的内容。
 * @returns {boolean | undefined} true=相符；false=被改过；undefined=流水上没这笔（无从核对）。
 */
export function verifyShelfText(dir, name, content) {
  const entry = readJournal(dir).get(name)
  if (entry === undefined) return undefined
  return entry.sha === sha16(content)
}

/**
 * 读出一份快照。
 * @param {string} dir - 数据目录。
 * @param {string} name - 快照名。
 * @returns {string | undefined} 不存在时 undefined。
 */
export function readShelfText(dir, name) {
  try {
    return fs.readFileSync(shelfPath(dir, fitShelfName(name)), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 出生册目录清单。
 * @param {string} dir - 数据目录。
 * @returns {string[]} 名字，字典序。
 */
export function listShelf(dir) {
  try {
    return fs.readdirSync(shelfPath(dir)).filter(n => !n.startsWith('.')).sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * 从 sid 字段解出文本锚。
 * @param {string} sessionId - LOG 记录的 sid 字段值。
 * @returns {string | undefined} 快照名；不是文本锚时 undefined。
 */
export function shelfNameFromAnchor(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(HANDOFF_ANCHOR_PREFIX)) return undefined
  return sessionId.slice(HANDOFF_ANCHOR_PREFIX.length)
}
