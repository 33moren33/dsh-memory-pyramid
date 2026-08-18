/**
 * 用量账 —— 记忆真的被用到时，在旁边记一笔。
 *
 * 面板用颜色表达「这块记忆有多被用到」。这个数**必须是真的**：本项目铁律是
 * 宁可少显示、禁止编造未测到的数据，而视觉稿里那套热度是占位的伪随机数。
 * 本模块就是把它换成真账。
 *
 * ## 为什么是旁挂，不是加字段
 *
 * LOG 与 TREE 是**定宽**的，宽度即格式版本：往记录里加一个计数字段会让既有
 * 记忆库整体错位，而错位是静默的。更要紧的是两者的性质不同——事实与摘要是
 * **不可丢的账本**，用量是**可丢的观测**。所以它单独住在 `HEAT/` 下：
 * 整个目录删掉，记忆一条不少，只是颜色回到全冷。任何一次记账失败都被吞掉，
 * **绝不允许因为记不上一笔用量而打断一次记忆写入**。
 *
 * ## 位置即身份，这里第三次成立
 *
 * 每一格 4 字节小端无符号整数，第 k 格住在第 `k×4` 字节，读越界即 0
 * （稀疏文件天然如此，不需要初始化，也不需要知道总长）。于是「某块的用量」
 * 是一次 `pread`，与库大小无关，和 LOG/TREE 是同一套道理。
 *
 * | 文件 | 一格是谁 | 记的是 |
 * |---|---|---|
 * | `HEAT/inject/<块大小>` | 与 `TREE/<块大小>` 同索引的那一块 | 这块被注入进上下文多少次 |
 * | `HEAT/inject/1` | 第 N 条事实 | 同上（`cover()` 会把最近的记录当成 1 条的块发出去） |
 * | `HEAT/query` | 第 N 条事实 | 被 `memory_recall` 捞出来交到模型手上多少次 |
 * | `HEAT/open` | 第 N 条事实 | 它的**基底**（原始出处）被打开多少次 |
 *
 * 上限 4,294,967,295，到顶即停在顶（不回绕——回绕会让一条用烂了的记忆显示成
 * 从没用过，又是一块自洽的假数据）。
 *
 * @module dsh-memory/heat
 */

import fs from 'node:fs'
import path from 'node:path'

/** 用量账目录名。 */
export const HEAT_DIR = 'HEAT'
/** 一格的字节数。 */
const SLOT = 4
/** 一格装得下的最大值。到顶即停。 */
const SLOT_MAX = 0xFFFFFFFF

/** 三类账。`inject` 按块大小再分文件，另两类各一个文件、按事实序号定位。 */
export const QUERY = 'query'
export const OPEN = 'open'

/**
 * 旁挂的用量账。
 *
 * 构造它**不创建任何文件**——一个从没被用过的记忆库不该因为开了面板就多出
 * 一堆空文件。目录与文件都在第一次真的记账时才出现。
 */
export class HeatLedger {
  /**
   * @param {string} dir - 数据目录。
   */
  constructor(dir) {
    /** @type {string} */
    this.dir = path.join(dir, HEAT_DIR)
  }

  /**
   * 某一类账的文件路径。
   * @param {string} kind - `query` / `open` / `inject/<块大小>`。
   * @returns {string}
   */
  file(kind) {
    return path.join(this.dir, ...String(kind).split('/'))
  }

  /**
   * 记一笔。**吞掉一切失败**：盘满、只读、权限不足都不该连累记忆本身。
   * @param {string} kind - 账的种类。
   * @param {number} index - 第几格。
   * @param {number} [times] - 记几笔。
   * @returns {void}
   */
  bump(kind, index, times = 1) {
    if (!Number.isInteger(index) || index < 0 || times <= 0) return
    const file = this.file(kind)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const fd = fs.openSync(file, 'r+')
      try {
        writeSlot(fd, index, add(readSlot(fd, index), times))
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') return
      // 还没有这个文件：建出来再记一次。'a+' 不能定位写，所以先创建再走正路。
      try {
        fs.closeSync(fs.openSync(file, 'a'))
        const fd = fs.openSync(file, 'r+')
        try {
          writeSlot(fd, index, add(readSlot(fd, index), times))
        } finally {
          fs.closeSync(fd)
        }
      } catch { /* 记不上就记不上，热度是可丢的 */ }
    }
  }

  /**
   * 一次记一批（同一个文件只开一次）。
   * @param {string} kind - 账的种类。
   * @param {Iterable<number>} indexes - 要记的格子，允许重复。
   * @returns {void}
   */
  bumpMany(kind, indexes) {
    const tally = new Map()
    for (const index of indexes) {
      if (Number.isInteger(index) && index >= 0) tally.set(index, (tally.get(index) ?? 0) + 1)
    }
    for (const [index, times] of tally) this.bump(kind, index, times)
  }

  /**
   * 读一段 `[from, to)` 的用量。**没记过的一律 0**，不区分「零次」与「文件还不存在」
   * ——对读者来说这两件事就是同一件事：没被用过。
   * @param {string} kind - 账的种类。
   * @param {number} from - 起（含）。
   * @param {number} to - 止（不含）。
   * @returns {number[]} 长度 `to - from`。
   */
  read(kind, from, to) {
    const length = Math.max(0, Math.trunc(to) - Math.trunc(from))
    const out = new Array(length).fill(0)
    if (length === 0) return out
    let buffer
    try {
      const fd = fs.openSync(this.file(kind), 'r')
      try {
        buffer = Buffer.alloc(length * SLOT)
        fs.readSync(fd, buffer, 0, buffer.length, from * SLOT)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return out
    }
    for (let i = 0; i < length; i++) out[i] = buffer.readUInt32LE(i * SLOT)
    return out
  }

  /**
   * 现有的 `inject/<块大小>` 层。
   * @returns {number[]} 块大小，从小到大。
   */
  injectLevels() {
    try {
      return fs.readdirSync(path.join(this.dir, 'inject'))
        .map(entry => Number.parseInt(entry, 10))
        .filter(size => Number.isInteger(size) && size > 0)
        .sort((a, b) => a - b)
    } catch {
      return []
    }
  }
}

/**
 * 块 `[lo, hi)` 在用量账里的坐标。与 `TREE/<size>` 用的是同一个算法，
 * 因为它们本来就是同一批块。
 * @param {number} lo - 起点。
 * @param {number} hi - 终点（不含）。
 * @returns {{ kind: string, index: number }}
 */
export function injectSlot(lo, hi) {
  const size = hi - lo
  return { kind: `inject/${size}`, index: lo / size }
}

/**
 * 加法，到顶即停。回绕会让一条用烂了的记忆显示成从没用过。
 * @param {number} value - 现值。
 * @param {number} times - 增量。
 * @returns {number}
 */
function add(value, times) {
  return Math.min(SLOT_MAX, value + times)
}

/**
 * 读一格。越过文件末尾读到的是 0。
 * @param {number} fd - 文件描述符。
 * @param {number} index - 第几格。
 * @returns {number}
 */
function readSlot(fd, index) {
  const buffer = Buffer.alloc(SLOT)
  const read = fs.readSync(fd, buffer, 0, SLOT, index * SLOT)
  return read === SLOT ? buffer.readUInt32LE(0) : 0
}

/**
 * 写一格。写在文件末尾之外时，中间的空洞由文件系统补零——这正是我们要的
 * 「没记过就是 0」，不需要预先铺满。
 * @param {number} fd - 文件描述符。
 * @param {number} index - 第几格。
 * @param {number} value - 新值。
 * @returns {void}
 */
function writeSlot(fd, index, value) {
  const buffer = Buffer.alloc(SLOT)
  buffer.writeUInt32LE(value, 0)
  fs.writeSync(fd, buffer, 0, SLOT, index * SLOT)
}
