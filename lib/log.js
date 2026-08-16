/**
 * LOG —— 定宽、只追加、位置即身份的事实行日志。
 *
 * 为什么定宽：第 N 条记录永远住在第 N×384 字节，所以「读第 N 条」是一次
 * `pread`，不需要扫描、不需要索引、不随记录数变慢。金字塔摘要（pyramid.js）
 * 靠这条性质才能做到「百万条也只花固定预算」。
 *
 * 为什么不复用 dsh 自己的会话日志：那份是**无条件全量流水**（连流式分块都记），
 * 变长内容 + 每次追加一个 zstd 帧，**没有 O(1) 寻址**。它是原料，不是成品。
 * 我们的事实行携带 `(sessionId, seq)` 指针指回去，需要原文时再下钻。
 *
 * 记录布局（共 384 字节，全 ASCII 定位）：
 *
 * ```
 *   [  0, 24)  time     ISO-8601，如 2026-08-15T03:04:05.678Z
 *   [ 24, 25)  '|'
 *   [ 25, 69)  sid      写入时的会话 id，右侧补空格
 *   [ 69, 70)  '|'
 *   [ 70, 78)  seqLo    会话事件 seq 区间下界
 *   [ 78, 79)  '-'
 *   [ 79, 87)  seqHi    会话事件 seq 区间上界
 *   [ 87, 88)  '|'
 *   [ 88,383)  text     事实正文，UTF-8，右侧补空格
 *   [383,384)  '\n'     便于 `tail`/编辑器直接看
 * ```
 *
 * 正文预算 295 字节，但工具边界只放行 280 字节 —— 留出的余量是为了保证
 * 任何合法正文都填得下，不会出现「刚好卡在边界导致截断成半个 UTF-8 字符」。
 *
 * **`sid` 为什么是 44 而不是 32**：dsh 的会话 id 形如 `session-<uuid>`，
 * 恰好 44 字符。第一次真机实测时这个字段是 32，于是每条记录都存下一个
 * **被切掉尾巴 12 字符的 id**——它照样像个 id，却再也定位不到
 * `~/.dsh/sessions/…/session-<uuid>/`，而「回到当时的对话原文」正是这个字段
 * 存在的全部理由。宽度不足即整字段作废，且不会有任何报错。
 *
 * **记录序号不入盘**：第 N 条记录的编号就是 N，由**位置**决定，存一份进去只会
 * 多一个可能与位置不一致的副本。这不是省字节，是让并发追加天然正确：
 * `headless` profile 是一次性任务模式（跑完即退），**每个任务一个新进程**，
 * 多个 dsh 进程共写一个工作区从理论问题变成日常场景。Linux 上 ≤4096 字节的
 * `O_APPEND` 写是原子的（我们 384），所以字节永不交错；先前「先 stat 拿条数当
 * seq、再写」才是唯一的破绽——两个进程会写着同一个号。删掉字段即无需任何锁。
 *
 * @module dsh-memory/log
 */

import fs from 'node:fs'
import path from 'node:path'

/** 每条记录的字节数。改这个数会让既有 LOG 全部错位，因此它同时是格式版本的一部分。 */
export const RECORD_SIZE = 384
/** 工具边界放行的正文上限（字节）。 */
export const MAX_TEXT_BYTES = 280

const TEXT_OFFSET = 88
const TEXT_CAPACITY = 295
/** 会话 id 字段的宽度。dsh 的 `session-<uuid>` 恰好 44 字符。 */
const SID_WIDTH = 44
const SPACE = 0x20
const NEWLINE = 0x0a

/**
 * 左侧补零的十进制。超出位数时保留低位——序号溢出属于「不该发生」，
 * 但宁可错位一条也不要写出长度不对的记录把整个文件毁掉。
 * @param {number} value - 非负整数。
 * @param {number} width - 目标宽度。
 * @returns {string}
 */
function pad(value, width) {
  const text = String(Math.max(0, Math.trunc(value)))
  return text.length >= width ? text.slice(-width) : text.padStart(width, '0')
}

/**
 * 把会话 id 摆进定宽字段——**装不下就一个字都不写**。
 *
 * 截断在这里是最坏的选项：切掉尾巴的 id 看上去仍然是个 id，却再也指不回任何
 * 目录，于是「这条记忆出自哪次对话」这个问题会得到一个自信的错误答案。
 * 空字段至少是诚实的「没有指针」。（本项目铁律：宁可少显示，禁止编造。）
 *
 * @param {string} [sessionId] - 会话 id。
 * @returns {string} 恰好 SID_WIDTH 个 ASCII 字符。
 */
function fitSessionId(sessionId) {
  const id = String(sessionId ?? '')
  return (id.length > SID_WIDTH ? '' : id).padEnd(SID_WIDTH)
}

/** 定宽只追加日志。 */
export class FixedWidthLog {
  /**
   * @param {string} dir - 数据目录。
   */
  constructor(dir) {
    /** @type {string} */
    this.file = path.join(dir, 'LOG.txt')
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', { flag: 'a' })
    /**
     * 装载时掐掉的残片字节数，供调用方通报给部署者。
     * @type {number}
     */
    this.repaired = this.repair()
  }

  /**
   * 掐掉崩溃留下的半条尾部记录。
   *
   * 那条记录从未被确认过（`append` 是一次 384 字节的同步写，要么整条要么没有）。
   * 不掐掉的话，下一次追加会落在错误的偏移上，**此后每一条记录都会错位**
   * ——而错位是静默的，读出来的东西看着仍然像数据。只截尾部那不足一条的部分，
   * 别的一个字节不碰。
   *
   * @returns {number} 掐掉了多少字节（0 表示本来就整齐）。
   */
  repair() {
    const size = fs.statSync(this.file).size
    const partial = size % RECORD_SIZE
    if (partial === 0) return 0
    assertNotForeignLog(this.file, size)
    fs.truncateSync(this.file, size - partial)
    return partial
  }

  /**
   * 记录条数。一次 `stat`，与总量无关。
   * @returns {number}
   */
  count() {
    return Math.floor(fs.statSync(this.file).size / RECORD_SIZE)
  }

  /**
   * 追加一条事实行。
   * @param {object} entry - 待写入内容。
   * @param {string} entry.text - 事实正文，须已通过 280 字节校验。
   * @param {string} [entry.sessionId] - 写入时的会话 id。
   * @param {number} [entry.seqLo] - 会话事件 seq 区间下界。
   * @param {number} [entry.seqHi] - 会话事件 seq 区间上界。
   * @returns {{ seq: number, time: string }} 新记录的序号与时间戳。
   */
  append(entry) {
    const time = new Date().toISOString()
    const buffer = Buffer.alloc(RECORD_SIZE, SPACE)

    buffer.write(time.padEnd(24).slice(0, 24), 0, 'ascii')
    buffer.write('|', 24, 'ascii')
    buffer.write(fitSessionId(entry.sessionId), 25, 'ascii')
    buffer.write('|', 69, 'ascii')
    buffer.write(pad(entry.seqLo ?? 0, 8), 70, 'ascii')
    buffer.write('-', 78, 'ascii')
    buffer.write(pad(entry.seqHi ?? 0, 8), 79, 'ascii')
    buffer.write('|', 87, 'ascii')
    buffer.write(entry.text, TEXT_OFFSET, TEXT_CAPACITY, 'utf8')
    buffer[RECORD_SIZE - 1] = NEWLINE

    // 序号由**写完之后的文件长度**回推，而不是写之前的条数：中间不再有一段
    // 「已经算好号、还没落盘」的窗口。单写者下精确；并发下别的进程可能在我们
    // fstat 之前也追加了，此时这个号只会偏大 —— 它只用于回执文字，
    // **盘上的数据永远正确**，因为「第几条」由位置而不是由这个数字决定。
    const fd = fs.openSync(this.file, 'a')
    let size
    try {
      fs.writeSync(fd, buffer, 0, RECORD_SIZE)
      size = fs.fstatSync(fd).size
    } finally {
      fs.closeSync(fd)
    }
    return { seq: Math.floor(size / RECORD_SIZE) - 1, time }
  }

  /**
   * 一次寻址读出第 n 条。
   * @param {number} n - 记录序号，0 起。
   * @returns {{ seq: number, time: string, sessionId: string, seqLo: number, seqHi: number, text: string } | undefined}
   */
  read(n) {
    if (!Number.isInteger(n) || n < 0 || n >= this.count()) return undefined
    const buffer = Buffer.alloc(RECORD_SIZE)
    const fd = fs.openSync(this.file, 'r')
    try {
      fs.readSync(fd, buffer, 0, RECORD_SIZE, n * RECORD_SIZE)
    } finally {
      fs.closeSync(fd)
    }
    return decode(buffer, n)
  }

  /**
   * 读一段区间 `[lo, hi)`。越界端自动收拢到合法范围。
   * @param {number} lo - 起始序号（含）。
   * @param {number} hi - 结束序号（不含）。
   * @returns {Array<{ seq: number, time: string, sessionId: string, seqLo: number, seqHi: number, text: string }>}
   */
  readRange(lo, hi) {
    const total = this.count()
    const from = Math.max(0, Math.trunc(lo))
    const to = Math.min(total, Math.trunc(hi))
    if (to <= from) return []
    const length = (to - from) * RECORD_SIZE
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(this.file, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, from * RECORD_SIZE)
    } finally {
      fs.closeSync(fd)
    }
    const records = []
    for (let i = 0; i < to - from; i++) {
      records.push(decode(buffer.subarray(i * RECORD_SIZE, (i + 1) * RECORD_SIZE), from + i))
    }
    return records
  }

  /**
   * 从新到旧扫正文子串。**这是线性扫描**，不是索引——记忆库的规模
   * （几千到几十万条）下一次全扫远比维护倒排索引便宜，且不会失同步。
   * @param {string} needle - 子串，大小写不敏感。
   * @param {number} limit - 最多返回条数。
   * @returns {Array<{ seq: number, time: string, sessionId: string, seqLo: number, seqHi: number, text: string }>} 由新到旧。
   */
  search(needle, limit) {
    const target = needle.toLowerCase()
    const total = this.count()
    const hits = []
    const CHUNK = 512
    for (let end = total; end > 0 && hits.length < limit; end -= CHUNK) {
      const start = Math.max(0, end - CHUNK)
      const batch = this.readRange(start, end)
      for (let i = batch.length - 1; i >= 0 && hits.length < limit; i--) {
        if (batch[i].text.toLowerCase().includes(target)) hits.push(batch[i])
      }
    }
    return hits
  }
}

/**
 * 把一条 384 字节记录解码回字段。
 *
 * `seq` 由调用方按**位置**给出（第 N 条就是 N），盘上没有这个字段——
 * 参见本模块抬头「记录序号不入盘」。
 *
 * @param {Buffer} buffer - 恰好一条记录。
 * @param {number} seq - 这条记录在日志里的位置序号。
 * @returns {{ seq: number, time: string, sessionId: string, seqLo: number, seqHi: number, text: string }}
 */
function decode(buffer, seq) {
  return {
    seq,
    time: buffer.toString('ascii', 0, 24).trim(),
    sessionId: buffer.toString('ascii', 25, 25 + SID_WIDTH).trim(),
    seqLo: Number.parseInt(buffer.toString('ascii', 70, 78), 10),
    seqHi: Number.parseInt(buffer.toString('ascii', 79, 87), 10),
    text: buffer.toString('utf8', TEXT_OFFSET, TEXT_OFFSET + TEXT_CAPACITY).trimEnd(),
  }
}

/**
 * 正文的字节长度（UTF-8）。中文一个字 3 字节，280 字节约 93 个汉字。
 * @param {string} text - 正文。
 * @returns {number}
 */
export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** OptMem 的日志记录宽度。我们比它多 64 字节，多出来的是 dsh 的会话指针。 */
export const OPTMEM_RECORD_SIZE = 320

/**
 * 在动刀之前，确认这不是**别人家格式**的日志。
 *
 * 「长度不是 384 的整数倍」有两种成因，处理方式完全相反：
 *
 * - **崩溃残片**：尾部有半条从未被确认的记录 → 掐掉，让偏移回到正轨。
 * - **根本不是我们的格式**：比如一份 OptMem 的 LOG（320 字节定宽）→ 掐掉它
 *   等于**默默吃掉别人最多 383 字节、也就是一到两条真实记忆**。
 *
 * 两者用长度就能分开：一份 320 的整数倍、且不是 384 整数倍的文件，几乎不可能
 * 是我们写崩的，而极可能是 OptMem 的。**宁可拒绝启动，也不对别人的数据动刀。**
 *
 * @param {string} file - 日志路径。
 * @param {number} size - 文件字节数。
 * @returns {void}
 * @throws {Error} 看起来是 OptMem 的日志。
 */
function assertNotForeignLog(file, size) {
  if (size === 0 || size % OPTMEM_RECORD_SIZE !== 0) return
  throw new Error(
    `dsh-memory: ${file} 的长度 ${size} 恰好是 ${OPTMEM_RECORD_SIZE} 的整数倍，`
    + `而不是本插件的 ${RECORD_SIZE} —— 这看起来是一份 **OptMem** 的 LOG.txt。`
    + ' 两种格式不能混读：直接接管会让每一条记录整体错位，'
    + ` 而按残片处理会掐掉最多 ${RECORD_SIZE - 1} 字节、也就是别人一到两条真实记忆。`
    + ' 已拒绝任何写入。若确要迁移，请先转换 LOG.txt'
    + '（TREE/ 目录两边格式相同，可原样保留）。',
  )
}
