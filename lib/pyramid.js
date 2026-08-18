/**
 * 金字塔 —— 摘要树的块代数、稠密分层存储、与固定预算的覆盖挑选。
 *
 * 本模块是对 **OptMem**（github.com/VictorTaelin/OptMem）金字塔机制的复用：
 * 算法照它的公开设计重写，**不含其代码**（该仓无 LICENSE ＝ 保留所有权利）。
 * 与它的每一处分歧都在下面标了原因，都是为了适配 dsh 才改的。
 *
 * ## 块
 *
 * 一个**块**是对齐的 2 幂次区间 `[lo, hi)`，压缩成一行。块构成 LOG 之上的
 * 二叉合并树：块 `[lo,hi)` 是 `[lo,mid)` 与 `[mid,hi)` 的压缩。
 *
 * ## 位置即身份，这里也成立
 *
 * 每一层是**一个稠密前缀文件** `TREE/<size>`，定宽 288 字节一条，块
 * `[k·size, (k+1)·size)` 住在第 `k·288` 字节。于是：
 *
 * - 读一块摘要 = 一次 seek；
 * - **「这一层做到哪了」= 文件长度 ÷ 288**，一次 `stat`，不用扫描；
 * - **待办队列不需要单独存**——它由各层文件长度推导出来，没有可失同步的状态。
 *
 * ## RAW_MAX：前几层直接读原文
 *
 * ≤16 条的块**从原文压缩**，只有更大的块才由两个半块摘要合并。
 * 这是为了不让传话游戏太早开始：若每一层都只看下一层的摘要，才 16 条记忆
 * 就已经传了 4 代话。读 16 条原文仍是有界的工作量，恒定性没有丢。
 *
 * @module dsh-memory/pyramid
 */

import fs from 'node:fs'
import path from 'node:path'

/** 摘要瓦片目录名。 */
export const TREE_DIR = 'TREE'
/** 一条摘要记录的字节数。 */
export const TREE_REC = 288
/** 请 agent 写摘要时给出的字节上限（记录本身还留了几字节余量）。 */
export const MAX_SUMMARY_BYTES = 280
/** 不超过这么多条的块，直接读原文压缩，而不是合并两个半块的摘要。 */
export const RAW_MAX = 16

/**
 * 用对齐的 2 幂次块铺满 `[0, T)`：一个块保持完整，当且仅当它的大小不超过
 * `alpha` 倍的年龄。alpha 越大越粗、行数越少。
 *
 * 年龄按块的**起点**算（`T - lo`）。
 *
 * @param {number} T - 记录总数。
 * @param {number} alpha - 粗化速度。
 * @returns {Array<[number, number]>} 半开区间，按时间正序。
 */
export function tile(T, alpha) {
  let root = 1
  while (root < T) root *= 2
  const out = []
  const stack = [[0, root]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()
    if (lo >= T) continue
    const size = hi - lo
    if (size > 1 && (hi > T || size > alpha * (T - lo))) {
      const mid = (lo + hi) / 2
      stack.push([mid, hi])
      stack.push([lo, mid])
    } else {
      out.push([lo, hi])
    }
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

/**
 * wake 要打印的那组块：最多 `budget` 块，靠近现在的最细。
 *
 * **它永远盖满 `[0, T)`，从不截断。** 预算不够时不是把老记忆丢掉，而是把它们
 * 合并得更粗——所以再久远的事也始终在视野里，只是越来越模糊。做法是对 alpha
 * 做二分搜索，找到恰好塞进预算的那个粗细，再把剩下的预算花在最近的块上细分。
 *
 * 全部装得下时（`T ≤ budget`）**一点都不压缩**，直接给原文。
 *
 * @param {number} T - 记录总数。
 * @param {number} budget - 行数预算。
 * @returns {Array<[number, number]>} 半开区间，按时间正序。
 */
export function cover(T, budget) {
  if (T <= 0) return []
  if (T <= budget) {
    const all = []
    for (let i = 0; i < T; i++) all.push([i, i + 1])
    return all
  }
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (tile(T, mid).length > budget) lo = mid
    else hi = mid
  }
  const out = tile(T, hi)
  // 块大小按 2 的幂跳，光靠 alpha 会低于预算。把余下的额度花在最近处，
  // 因为细节在那里最值钱。
  while (out.length < budget) {
    let index = -1
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i][1] - out[i][0] > 1) { index = i; break }
    }
    if (index < 0) break
    const [blockLo, blockHi] = out[index]
    const mid = (blockLo + blockHi) / 2
    out.splice(index, 1, [blockLo, mid], [mid, blockHi])
  }
  return out
}

/**
 * 块的对外名字＝它覆盖的记录闭区间，如 `0-3`、`64-127`。
 *
 * 对模型来说这比「第 2 层第 0 块」好用：名字自带它覆盖了什么，而且因为块永远
 * 2 幂次对齐，区间反过来唯一确定这个块，不会有歧义。
 *
 * **只用于块（size ≥ 2）。** 单条事实不是块，它的名字是 `#N`（N ＝ 记录序号）
 * ——理由见 `parseNode`。
 *
 * @param {number} lo - 起点（含）。
 * @param {number} hi - 终点（不含）。
 * @returns {string}
 */
export function nodeName(lo, hi) {
  return `${lo}-${hi - 1}`
}

/**
 * 把 `a-b` 解回块区间，顺带校验它确实是一个合法的对齐块。
 *
 * **单条记录不是块，会被拒。** `#N` 与 `#a-b` 是两种语境、不许混：`#N` 只出现在
 * 事实行（视图里的原文行、`memory_recall` 的匹配面），`#a-b` 只出现在块（视图里的
 * 摘要行、`memory_summarize` / `memory_zoom` / `memory_forget` 的参数）。
 *
 * 曾经这里放行 `size === 1`（2⁰ 也是 2 的幂、也对齐），于是凭空多出一种 `#n-n`：
 * 视图把单条事实打印成 `#10006-10006`，模型照抄去 `memory_recall` 一搜得**零条**
 * ——匹配面上那一行叫 `#10006`。格式合法、数字真实、无声无息。同族的还有
 * `memory_summarize` 里那句专门拒绝 `#n-n` 的话：一种本不该存在的东西，
 * 逼着每个下游都写一句话去挡它。
 *
 * @param {unknown} text - 形如 `0-3` 的节点名。
 * @returns {{ lo: number, hi: number, size: number }}
 * @throws {Error} 不是合法的对齐 2 幂次区间，或只盖住一条记录。
 */
export function parseNode(text) {
  if (typeof text !== 'string') throw new Error('`node` must be a string like "0-3"')
  const match = /^\s*#?(\d+)\s*-\s*(\d+)\s*$/.exec(text)
  if (match === null) throw new Error(`\`node\` must look like "0-3", got ${JSON.stringify(text)}`)
  const lo = Number.parseInt(match[1], 10)
  const hi = Number.parseInt(match[2], 10) + 1
  const size = hi - lo
  if (size === 1) {
    throw new Error(
      `\`node\` "${text}" covers a single record, and a single fact is not a node — it is the raw text itself,`
      + ` written #${lo} everywhere it appears. Nodes start at two records;`
      + ' copy the id printed in the memory view, like "16-31".',
    )
  }
  if (size <= 0 || !Number.isInteger(Math.log2(size)) || lo % size !== 0) {
    throw new Error(
      `\`node\` "${text}" is not a real block: blocks are power-of-two ranges aligned to their own size`
      + ' (0-0, 0-1, 2-3, 0-3, 4-7, 0-7 …).',
    )
  }
  return { lo, hi, size }
}

/** 分层稠密存储的摘要树。 */
export class Pyramid {
  /**
   * @param {string} dir - 数据目录。
   */
  constructor(dir) {
    /** @type {string} */
    this.dir = path.join(dir, TREE_DIR)
    fs.mkdirSync(this.dir, { recursive: true })
  }

  /**
   * 某一层的文件路径。层按**块大小**命名，不按层号——块大小才是定位一条摘要
   * 所需要的全部信息。
   * @param {number} size - 块大小。
   * @returns {string}
   */
  levelPath(size) {
    return path.join(this.dir, String(size))
  }

  /**
   * 这一层已经写了多少块。一次 `stat`，与总量无关。
   * @param {number} size - 块大小。
   * @returns {number}
   */
  have(size) {
    try {
      return Math.floor(fs.statSync(this.levelPath(size)).size / TREE_REC)
    } catch (error) {
      if (error.code === 'ENOENT') return 0
      throw error
    }
  }

  /**
   * 读一块摘要，一次 seek。
   * @param {number} lo - 起点。
   * @param {number} hi - 终点（不含）。
   * @returns {string | undefined} 还没写就是 undefined。
   */
  get(lo, hi) {
    const size = hi - lo
    const index = lo / size
    if (index >= this.have(size)) return undefined
    const buffer = Buffer.alloc(TREE_REC)
    const fd = fs.openSync(this.levelPath(size), 'r')
    try {
      fs.readSync(fd, buffer, 0, TREE_REC, index * TREE_REC)
    } finally {
      fs.closeSync(fd)
    }
    const text = buffer.toString('utf8').trimEnd()
    return text === '' ? undefined : text
  }

  /**
   * 写一块摘要。
   *
   * 块是按顺序建的，所以这永远只是往某一层文件尾部追加一条——**乱序写会被拒绝**，
   * 因为稠密前缀一旦有洞，「文件长度＝做到哪了」这条等式就不成立了，
   * 而整个待办推导都建立在它上面。
   *
   * @param {number} lo - 起点。
   * @param {number} hi - 终点（不含）。
   * @param {string} text - 摘要正文。
   * @returns {boolean} 是否写成功（false ＝ 不是这一层的下一块）。
   */
  put(lo, hi, text) {
    const size = hi - lo
    const file = this.levelPath(size)
    repair(file)
    if (this.have(size) !== lo / size) return false
    const fd = fs.openSync(file, 'a')
    try {
      fs.writeSync(fd, pad(text), 0, TREE_REC)
    } finally {
      fs.closeSync(fd)
    }
    return true
  }

  /**
   * 丢掉一块摘要，**以及所有由它建起来的块**。
   *
   * 做法是把相关的每一层截回该点——那之后的块也会一起没掉并在下次补写。
   * 之所以必须连坐：上层摘要是从这一块推出来的，留着它们等于留着一份基于
   * 已被判定为错的地图画出来的、更粗的地图。
   *
   * **原文一个字节都不动。** 只动地图，不动领土。
   *
   * @param {number} lo - 起点。
   * @param {number} hi - 终点（不含）。
   * @returns {Array<[number, number]>} 被丢掉的块。
   */
  drop(lo, hi) {
    const gone = []
    const limit = this.maxLevelSize()
    for (let size = hi - lo; size <= limit; size *= 2) {
      const index = Math.floor(lo / size)
      const count = this.have(size)
      if (count > index) {
        for (let i = index; i < count; i++) gone.push([i * size, (i + 1) * size])
        fs.truncateSync(this.levelPath(size), index * TREE_REC)
      }
    }
    return gone
  }

  /**
   * 目前存在的最大块尺寸，给连坐截断定个上界。
   * @returns {number}
   */
  maxLevelSize() {
    let largest = 0
    for (const entry of fs.readdirSync(this.dir)) {
      const size = Number.parseInt(entry, 10)
      if (Number.isInteger(size) && size > largest) largest = size
    }
    return largest
  }

  /**
   * 可以建、但还没建的块，**最小的在前**。
   *
   * 每层是稠密前缀，所以文件长度直接说明这层做到哪了：一层一次 `stat`，
   * 永远不用扫描，也不需要一份单独维护的待办清单。
   *
   * @param {number} T - 记录总数。
   * @param {number} [limit] - 最多返回几块。
   * @returns {Array<[number, number]>}
   */
  pending(T, limit) {
    const todo = []
    for (let size = 2; size <= T; size *= 2) {
      const have = this.have(size)
      for (let k = have; k < Math.floor(T / size); k++) {
        todo.push([k * size, (k + 1) * size])
        if (limit !== undefined && todo.length >= limit) return todo
      }
    }
    return todo
  }

  /**
   * 待办有多少块，但不把它们列出来。
   *
   * 每层按零下限夹一次：T 是一个快照，而 agent 读的时候记忆还在继续到达，
   * 所以某一层可能比 T 所需要的还多建了几块。
   *
   * @param {number} T - 记录总数。
   * @returns {number}
   */
  pendingCount(T) {
    let n = 0
    for (let size = 2; size <= T; size *= 2) {
      n += Math.max(0, Math.floor(T / size) - this.have(size))
    }
    return n
  }

  /**
   * wake 视图要打印的那些行：按预算挑出覆盖，逐块取原文或摘要。
   *
   * **行数恒等于 `cover()` 挑出的块数，永不超预算** —— 这是「记忆再多，读它的
   * 成本恒定」这句承诺的兑现处，不是尽力而为。
   *
   * 缺摘要**不拆细**。曾经拆过，理由是「系统提示词渲染时没有『拒绝』这个选项」；
   * 那个理由随视图搬进 `ctx.systemPrompt.context()` 已经不成立——渲染一段
   * **拒绝文字**当然是可以的。而拆细的代价实测很难看：400 条事实一条摘要不写，
   * 视图会铺成 **400 行**（预算 96），**四倍超支且无上限**，正好是整套设计要防的
   * 那件事。照 OptMem 原样办：**渲染不出来就明说渲染不出来，并把该补的摘要递过去。**
   *
   * @param {import('./log.js').FixedWidthLog} log - 事实日志（拿原文用）。
   * @param {number} T - 记录总数。
   * @param {number} budget - 行数预算。
   * @returns {{ blocks: Array<{ lo: number, hi: number, raw: boolean, text: string }>, missing: [number, number] | undefined }}
   *   `missing` ＝ 视图**必需**却还没写的那一块；非 undefined 时 `blocks` 不完整、不可显示。
   */
  expand(log, T, budget) {
    const blocks = []
    for (const [lo, hi] of cover(T, budget)) {
      if (hi - lo === 1) {
        const record = log.read(lo)
        blocks.push({ lo, hi, raw: true, text: record?.text ?? '(missing record)' })
        continue
      }
      const summary = this.get(lo, hi)
      if (summary === undefined) return { blocks, missing: [lo, hi] }
      blocks.push({ lo, hi, raw: false, text: summary })
    }
    return { blocks, missing: undefined }
  }
}

/**
 * 把摘要补齐成一条定宽记录。
 * @param {string} text - 摘要正文。
 * @returns {Buffer}
 */
function pad(text) {
  const body = Buffer.from(text, 'utf8')
  if (body.length > TREE_REC - 1) {
    throw new Error(`summary is ${body.length} bytes; the record holds ${TREE_REC - 1}`)
  }
  const record = Buffer.alloc(TREE_REC, 0x20)
  body.copy(record, 0)
  record[TREE_REC - 1] = 0x0a
  return record
}

/**
 * 掐掉崩溃留下的半条尾部记录。
 *
 * 那条记录从未被确认过。不掐掉的话，下一次追加会落在错误的偏移上，
 * **此后每一条记录都会错位**——而错位是静默的，读出来的东西看着像数据。
 *
 * @param {string} file - 层文件路径。
 * @returns {void}
 */
function repair(file) {
  let size
  try {
    size = fs.statSync(file).size
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const partial = size % TREE_REC
  if (partial !== 0) fs.truncateSync(file, size - partial)
}
