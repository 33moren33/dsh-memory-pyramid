/**
 * dsh-memory —— 给 DeepSeek Harness 补上**时间轴**记忆。
 *
 * ## 它补的是哪一格
 *
 * 官方没有「经历记忆」。沾边的三件都不记「发生过什么」：
 * `agent-instructions`（AGENTS.md 门规链）切的是**空间**轴（按目录 scope 就近生效）、
 * `compaction` 是压缩、`session-query` 是查询。检索式记忆切的是**相关性**轴。
 * 三轴正交可叠，官方只占了空间轴，**时间轴整根空着** —— 这就是本插件的落点。
 *
 * ## 复用的是谁的轮子
 *
 * 机制来自 **OptMem**（github.com/VictorTaelin/OptMem）：定宽只追加的事实日志、
 * 2 幂次块构成的二叉摘要树、由 agent 自己在 note 时顺带偿还的合并、
 * 以及固定阅读预算下「越老越粗」的覆盖挑选。**以那个项目为准**——凡是它已经
 * 想清楚的地方一律照做，我们只改为了适配 dsh 而必须改的部分。
 *
 * 该仓**没有 LICENSE 文件 ＝ 默认保留所有权利**，因此本仓不含它的任何代码，
 * 也不含它那 426-token 提示词的原文；以上均为依据其公开设计的独立实现。
 *
 * ## 为 dsh 改的五处（每一处都有不得不改的理由）
 *
 * 1. **接入方式**：原设计把提示词粘进 `AGENTS.md`，而 dsh 里读 AGENTS.md 的
 *    `agent-instructions` 在本机 profile 中标着**已停用**——照搬会连提示词都送不到
 *    模型面前。改走 `ctx.systemPrompt` 的两个座位（见第 5 条）。
 * 2. **形态**：原设计是 agent 去 shell 里跑一个 CLI；这里是原生 dsh 工具，
 *    不需要 shell 权限，也不依赖 agent 记得住可执行文件路径。
 * 3. **缺摘要时的行为**：原设计的 `wake` 会**拒绝执行**并先逼 agent 去补摘要。
 *    系统提示词的 section **没有「拒绝渲染」这个选项**，所以改成如实降级
 *    （把缺摘要的块就地拆细、显示原文），欠账仍在页脚点名催。
 * 4. **事实行挂会话指针**：每条记忆记下 `(sessionId, seq 区间)`——区间＝上一条
 *    记忆的位置→它自己的位置——可以回到产生它的那段会话原文。这是 dsh 有而
 *    原设计没有的原料层。
 * 5. **⭐ 记忆视图走 `context()` 而不是 `section()`**（真机实测后改）。
 *
 * ## 第 5 条为什么是这套设计里最贵的一课
 *
 * 视图最初写在 `ctx.systemPrompt.section()` 里，也就是**前缀**里，而 `text` 是个
 * 函数、每回合重新求值 —— 于是**每写一条记忆，整份视图原地重写一遍，它后面的
 * 全部对话按未命中价重算**。实测一次 8 轮的会话：95,362 个未命中输入 token 里
 * **98.7% 是这么烧掉的**，其中 88% 还只是一行页脚计数在跳数字。
 *
 * OptMem 的视图是 shell 命令的输出，只能落在消息尾巴上——那个「缓存安全」是走
 * CLI 这条路**被迫**白送的。我们有直接写系统提示词的权限，于是用了那个更"强"的
 * 接口，亲手把它弄丢了。
 *
 * `ctx.systemPrompt.context()` 是官方给的同一条安全通道，三处保证（均读自
 * 发布版源码）：①快照带前言 `This snapshot supersedes earlier runtime-context
 * snapshots.` ②`RuntimeContextProjection.project()` 里 `if (this.retained?.text
 * === snapshot) return` ＝**内容没变就不追加** ③变了则 `[...claimed, context]`
 * ＝**追加在消息队尾，从不回头改旧消息**。故增长与回合数无关，只与记忆真的变了
 * 几次有关，且每份快照只在追加那一刻付一次全价。
 *
 * **纪律（静态）留在 `section()`，视图（动态）走 `context()`** —— 分界就是
 * 「这段字会不会变」。
 *
 * ## 数据落在工作区，不落 `~/.dsh`
 *
 * `ctx.storage` 的 root 由 backend 的 composition config 钉死在
 * `dshHomePath('storages')`，第三方插件改不了。所以这里跟官方 `storage-json`
 * 一样直接用 node `fs` 写自己指定的目录。
 *
 * @module dsh-memory
 */

import { openDataDir, resolveDataDir } from './store.js'
import { byteLength, FixedWidthLog, MAX_TEXT_BYTES } from './log.js'
import { MAX_SUMMARY_BYTES, nodeName, parseNode, Pyramid, RAW_MAX } from './pyramid.js'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt']

/** 纪律段在系统提示词里的位置。100–199 是官方给工具引导留的号段。 */
const SECTION_ORDER_DISCIPLINE = 130
/** 记忆视图在**动态上下文**里的位置（与 section 的号段无关，只决定同类之间的先后）。 */
const CONTEXT_ORDER_WAKE = 130

/** 记忆视图的行数预算。这是**阅读**预算，不是存储预算——改它不重算任何摘要。 */
const DEFAULT_WAKE_LINES = 96

/**
 * 装载记忆插件。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 注册上下文。
 * @param {object} [config] - 部署配置。
 * @param {string} [config.dataDir] - 数据目录。绝对路径，或相对工作区根。
 * @param {string} [config.namespace] - 公共区名字，落在 `<工作区>/<名字>/dsh_memory`。
 * @param {boolean} [config.migrate] - 换落点时自动搬迁旧记忆，默认 true。
 * @param {number} [config.wakeLines] - 记忆视图的行数预算，默认 96。
 * @param {boolean} [config.injectWake] - 是否把记忆视图注进系统提示词，默认 true。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const dir = resolveDataDir(config)
  const opened = openDataDir(dir, { subdirs: ['TREE'], migrate: config.migrate !== false })
  const log = new FixedWidthLog(dir)
  const pyramid = new Pyramid(dir)
  const budget = positive(config.wakeLines, DEFAULT_WAKE_LINES)

  for (const notice of opened.notices) report(ctx, notice)
  if (log.repaired > 0) {
    report(ctx, `dsh-memory: 掐掉了 LOG.txt 末尾 ${log.repaired} 字节残片（上次写入被中断），既有记录未受影响`)
  }
  report(ctx, `dsh-memory: 当前 ${log.count()} 条事实，${pyramid.pendingCount(log.count())} 块待压缩`)

  /**
   * wake 视图的记忆化。视图只在写入后变化，所以按「记录数 + 待办数」判定。
   * 每次 assemble 都重扫摘要树不只是白费 I/O，更会让系统提示词的字节无谓抖动
   * ——而那正是姊妹插件 dsh-frozen 要治的病。
   * @type {{ key: string, text: string } | undefined}
   */
  let cached

  /**
   * 渲染当前的记忆视图。
   * @returns {string}
   */
  const renderWake = () => {
    const count = log.count()
    const key = `${count}:${pyramid.pendingCount(count)}`
    if (cached?.key === key) return cached.text
    const text = buildWakeView(log, pyramid, count, budget)
    cached = { key, text }
    return text
  }

  // 纪律是静态的，永不变 → 留在系统提示词里，一次缓存、此后永远命中。
  ctx.systemPrompt.section({
    name: 'dsh-memory:discipline',
    order: SECTION_ORDER_DISCIPLINE,
    text: DISCIPLINE,
  })

  // 记忆视图**写一条就变** → 必须走 context()，不能走 section()。见本文件抬头「为
  // dsh 改的第五处」。形状与 section() 完全一致（`{name, order, text}`）。
  if (config.injectWake !== false) {
    ctx.systemPrompt.context({
      name: 'dsh-memory:wake',
      order: CONTEXT_ORDER_WAKE,
      text: () => renderWake(),
    })
  }

  ctx.tools.register({
    name: 'memory_note',
    description:
      'Record ONE durable fact on the long-term timeline. Facts are append-only and never edited. '
      + `The text must be a single self-contained line of at most ${MAX_TEXT_BYTES} UTF-8 bytes. `
      + 'Record only what cannot be re-derived from the code, the git history, or the files in front of you: '
      + 'a decision and the reason behind it, an incident and what it cost, a constraint found the hard way, '
      + 'an approach that was ruled out and why, anything the user teaches you about how they want to work. '
      + 'Never record duplicates — read the memory view in the system prompt first. '
      + 'If the response asks for a compression, do it before your next action: it is the upkeep cost of the '
      + 'memory tree, and skipping it makes older memory unreadable.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: `The fact, as one self-contained line, at most ${MAX_TEXT_BYTES} UTF-8 bytes.`,
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'integer' },
          total: { type: 'integer' },
          dueSummary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              node: { type: 'string' },
              fromRaw: { type: 'boolean' },
              parts: { type: 'array', items: { type: 'string' } },
              remaining: { type: 'integer' },
            },
            required: ['node', 'fromRaw', 'parts', 'remaining'],
          },
        },
        required: ['seq', 'total'],
      },
      render: (_args, value) => [{ type: 'text', text: renderNoteResult(value) }],
    },
    execute(args, exec) {
      const text = requireLine(args?.text, 'text', MAX_TEXT_BYTES)
      const session = exec.agent?.session
      const sessionId = session?.id ?? ''
      const now = session?.seq ?? 0
      // 区间锚点：串行记录的区间 ＝ 上一条记忆的位置 → 它自己的位置。
      // 「上一条在哪」是白拿的——LOG 定宽
      // 只追加，最后一条就是 count-1。同会话则从它的 seqHi 接续；换了会话
      // （或整个 LOG 还是空的）则从会话开头（0）起。后者只会让覆盖面偏大，
      // 不会编造：那些事件确实发生在本会话里。
      // 并发说明：读 prev 与 append 之间没有锁，但撞进来的另一个进程必然是
      // 另一个会话（headless 一任务一进程），sessionId 对不上自然落回 0。
      const prev = log.read(log.count() - 1)
      const seqLo = sessionId !== '' && prev?.sessionId === sessionId
        ? Math.min(prev.seqHi, now)
        : 0
      const written = log.append({ text, sessionId, seqLo, seqHi: now })
      cached = undefined
      const total = log.count()
      const due = describeDue(log, pyramid, total)
      return Promise.resolve({
        seq: written.seq,
        total,
        ...(due === undefined ? {} : { dueSummary: due }),
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Record a memory',
      kind: 'other',
      rawInput: args?.text,
    }),
  })

  ctx.tools.register({
    name: 'memory_summarize',
    description:
      'Compress one node of the memory tree into a single line, as requested by `memory_note`. '
      + `At most ${MAX_SUMMARY_BYTES} UTF-8 bytes — a summary costs the same to read as one raw fact, `
      + 'which is what keeps recall cost flat as memory grows. '
      + 'Compress ONLY the parts handed to you; do not widen the scope and do not go read more. '
      + 'Keep what has lasting effect, drop what does not, and invent nothing. '
      + 'A summary is only a map — the raw facts survive underneath and can always be re-read.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'The node to compress, e.g. "0-3". Comes from `dueSummary.node`.' },
        text: { type: 'string', description: `The summary, at most ${MAX_SUMMARY_BYTES} UTF-8 bytes.` },
      },
      required: ['node', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { type: 'string' },
          alreadySettled: { type: 'boolean' },
          remaining: { type: 'integer' },
        },
        required: ['node', 'remaining'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.alreadySettled === true
          ? `#${value.node} was already settled — nothing was overwritten. `
          : `Compressed node #${value.node}. `)
          + (value.remaining === 0 ? 'Nothing else is pending.' : `${value.remaining} node(s) still pending.`),
      }],
    },
    execute(args) {
      const node = parseNode(args?.node)
      const text = requireLine(args?.text, 'text', MAX_SUMMARY_BYTES)
      const total = log.count()
      if (node.size < 2) {
        throw new Error('memory_summarize: a single fact (#n-n) is already raw text and needs no summary')
      }
      if (node.hi > total) {
        throw new Error(
          `memory_summarize: node #${nodeName(node.lo, node.hi)} covers records ${node.lo}..${node.hi - 1}, `
          + `but the log only has ${total}. That node is not complete yet.`,
        )
      }
      // 全局顺序，照 OptMem `cmd_nap` 对齐（`if (lo, hi) != todo[0]: die(...)`）。
      // `pyramid.put()` 只保证**本层**是稠密前缀，层与层之间不管；实测过它的后果：
      // 跳过 #0-1 之后层 2 的后续全被拒，而层 4/8/16… 照样落进去 97 块——
      // 塔基缺着，塔身却盖起来了。OptMem 那边这 97 块一块都进不去。
      // 已经还过的块：不是错误，也绝不覆盖（照 OptMem 的 "already settled"）。
      // 这一关必须排在「还有没有欠债」前面——债还清之后重复提交，正好落在这里。
      if (pyramid.get(node.lo, node.hi) !== undefined) {
        return Promise.resolve({
          node: nodeName(node.lo, node.hi),
          alreadySettled: true,
          remaining: pyramid.pendingCount(total),
        })
      }
      const next = pyramid.pending(total, 1)[0]
      if (next === undefined || node.lo !== next[0] || node.hi !== next[1]) {
        throw new Error(
          'memory_summarize: wrong node. Nodes are built in order, smallest first, '
          + 'so the tree never has a hole under a summary. '
          + (next === undefined
            ? 'Nothing is pending right now.'
            : `The next one is #${nodeName(next[0], next[1])} — compress that instead of `
              + `#${nodeName(node.lo, node.hi)}.`),
        )
      }
      if (!pyramid.put(node.lo, node.hi, text)) {
        throw new Error(
          `memory_summarize: #${nodeName(node.lo, node.hi)} was settled or forgotten meanwhile — re-read the view.`,
        )
      }
      cached = undefined
      return Promise.resolve({
        node: nodeName(node.lo, node.hi),
        remaining: pyramid.pendingCount(total),
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: `Compress memory node #${String(args?.node)}`,
      kind: 'other',
      rawInput: args?.text,
    }),
  })

  ctx.tools.register({
    name: 'memory_zoom',
    description:
      'Open one node of the memory tree into its two halves — the cheap way down. '
      + 'Every `#a-b` line in the memory view is a node; zooming it costs two lines instead of re-reading '
      + 'the whole range. Zoom repeatedly to walk down to the raw facts. '
      + 'Use `memory_recall` instead when you want to scan for a word rather than navigate.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'The node to open, e.g. "0-63".' },
      },
      required: ['node'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { type: 'string' },
          halves: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                node: { type: 'string' },
                raw: { type: 'boolean' },
                text: { type: 'string' },
              },
              required: ['node', 'raw', 'text'],
            },
          },
        },
        required: ['node', 'halves'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `#${value.node} opens into:\n${value.halves.map(h => `  #${h.node} ${h.text}`).join('\n')}`,
      }],
    },
    execute(args) {
      const node = parseNode(args?.node)
      if (node.size < 2) {
        throw new Error(`memory_zoom: #${nodeName(node.lo, node.hi)} is a single raw fact — nothing is below it`)
      }
      const mid = (node.lo + node.hi) / 2
      const halves = [[node.lo, mid], [mid, node.hi]].map(([lo, hi]) => {
        if (hi - lo === 1) {
          return { node: nodeName(lo, hi), raw: true, text: log.read(lo)?.text ?? '(missing record)' }
        }
        return {
          node: nodeName(lo, hi),
          raw: false,
          text: pyramid.get(lo, hi) ?? '(not compressed yet — zoom further or recall the raw range)',
        }
      })
      return Promise.resolve({ node: nodeName(node.lo, node.hi), halves })
    },
  })

  ctx.tools.register({
    name: 'memory_recall',
    description:
      'Read raw facts from the long-term timeline. Either give `query` to scan every fact ever recorded '
      + 'for a substring (newest first), or give `from`/`to` to read an exact record range. '
      + 'Each fact carries the session id and the event seq range it distilled, so the original transcript '
      + 'can be opened from there. To navigate the tree instead of scanning, use `memory_zoom`.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring to scan for, newest first.' },
        from: { type: 'integer', description: 'First record number to read (inclusive).' },
        to: { type: 'integer', description: 'Last record number to read (exclusive).' },
        limit: { type: 'integer', description: 'Maximum records to return. Defaults to 40.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          records: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer' },
                time: { type: 'string' },
                sessionId: { type: 'string' },
                sessionSeqLo: { type: 'integer' },
                sessionSeqHi: { type: 'integer' },
                text: { type: 'string' },
              },
              required: ['seq', 'time', 'sessionId', 'sessionSeqLo', 'sessionSeqHi', 'text'],
            },
          },
        },
        required: ['total', 'records'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.records.length === 0
          ? `No matching facts (${value.total} recorded in total).`
          : `${value.records.length} of ${value.total} facts:\n${value.records.map(formatRecord).join('\n')}`,
      }],
    },
    execute(args) {
      const limit = clamp(args?.limit, 1, 200, 40)
      const total = log.count()
      const found = typeof args?.query === 'string' && args.query !== ''
        ? log.search(args.query, limit)
        : log.readRange(
          Number.isInteger(args?.from) ? args.from : Math.max(0, total - limit),
          Number.isInteger(args?.to) ? args.to : total,
        ).slice(-limit)
      return Promise.resolve({
        total,
        records: found.map(record => ({
          seq: record.seq,
          time: record.time,
          sessionId: record.sessionId,
          sessionSeqLo: record.seqLo,
          sessionSeqHi: record.seqHi,
          text: record.text,
        })),
      })
    },
  })

  ctx.tools.register({
    name: 'memory_forget',
    description:
      'Discard one summary you judge to be wrong or misleading, so it gets written again. '
      + 'Every coarser summary built on top of it is discarded too — they were derived from it. '
      + 'This deletes NO facts: the raw log is append-only and untouchable; only the map is redrawn. '
      + 'Use it when zooming into a node shows the summary does not honestly represent its halves.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'The node whose summary should be discarded, e.g. "0-3".' },
      },
      required: ['node'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { type: 'string' },
          discarded: { type: 'array', items: { type: 'string' } },
          remaining: { type: 'integer' },
        },
        required: ['node', 'discarded', 'remaining'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.discarded.length === 0
          ? `#${value.node} had no summary to discard.`
          : `Discarded ${value.discarded.length} summary/summaries (${value.discarded.join(', ')}); `
            + `they are queued to be written again (${value.remaining} pending). No facts were touched.`,
      }],
    },
    execute(args) {
      const node = parseNode(args?.node)
      if (node.size < 2) throw new Error('memory_forget: raw facts are permanent and cannot be discarded')
      const gone = pyramid.drop(node.lo, node.hi)
      cached = undefined
      return Promise.resolve({
        node: nodeName(node.lo, node.hi),
        discarded: gone.map(([lo, hi]) => nodeName(lo, hi)),
        remaining: pyramid.pendingCount(log.count()),
      })
    },
  })
}

/**
 * 记忆纪律 —— 注进系统提示词的静态那半。全文自写。
 *
 * 用英文是因为它落在官方英文提示词中间；给人读的文档在 README，用中文。
 */
const DISCIPLINE = `## Long-term memory (time axis)

You have a durable, append-only memory of what has happened across sessions. It is
separate from this session's transcript and outlives it, along with every compaction
and model change.

- \`memory_note\` records one fact. Facts are never edited or deleted.
- \`memory_summarize\` pays the upkeep: as facts accumulate, blocks of them come due
  for compression into one line. Do it the moment you are asked, before your next
  action — skipped upkeep is what makes old memory unreadable.
- \`memory_zoom\` opens any \`#a-b\` line of that view into its two halves;
  \`memory_recall\` scans the raw facts word for word.

What belongs here: a decision and the reason behind it, an incident and what it cost,
a constraint discovered the hard way, an approach that was ruled out and why, anything
the user teaches you about how they want to work. What does not: anything re-derivable
from the code, the git history, or the files in front of you.

Your memory is shown to you as a "Memory view" in the runtime context, not here. It is
not the whole memory — it is a fixed-budget reading of it, coarse where it is old and
verbatim where it is recent. Nothing ever falls off the end: older memory only gets
coarser. When a line is too coarse for what you need, zoom or recall rather than guess.
If several Memory views appear, only the last one is current.

If you are a subagent, do not write memories. You cannot see what is already recorded,
so your notes would arrive duplicated and out of context. Report to your caller instead.`

/**
 * 拼出 wake 视图。
 *
 * **这里曾经有一行「还欠 N 块摘要」的页脚，已删。** 真机实测（一次 8 轮的会话）
 * 里，五次可缓存前缀失效有**四次**只是这个计数在跳数字（6→5→3→1→消失），
 * 烧掉 84,317 个未命中输入 token ＝ 全场全价开销的 **88%**。
 *
 * 它还是纯冗余的：「下一块该压缩谁」`memory_note` 的**工具回执**里已经连同
 * 待压缩原文一起给了模型，而回执落在消息队尾、不动前缀、天然免费。
 * 把同一件事再摆进提示词，等于花全价重复一遍已经白送到手的信息。
 *
 * 删掉它之后，欠账只由 `memory_note` 驱动偿还——这是自洽的：欠账只在记忆**变多**
 * 时产生，而记忆变多必然经过 `memory_note`。
 *
 * @param {FixedWidthLog} log - 事实日志。
 * @param {Pyramid} pyramid - 摘要树。
 * @param {number} count - 记录总数。
 * @param {number} budget - 行数预算。
 * @returns {string}
 */
function buildWakeView(log, pyramid, count, budget) {
  if (count === 0) {
    return '### Memory view\n\n(empty — nothing has been recorded yet)'
  }
  const { blocks, missing } = pyramid.expand(log, count, budget)
  if (missing !== undefined) return refuseWakeView(log, pyramid, count, missing)
  const lines = blocks.map((block) => {
    const label = nodeName(block.lo, block.hi)
    if (!block.raw) return `#${label} ${block.text}`
    return `#${label} ${log.read(block.lo)?.time.slice(0, 10) ?? '??'} ${block.text}`
  })
  return `### Memory view (${count} facts, oldest first)\n\n${lines.join('\n')}`
}

/**
 * 视图渲染不出来时说的话 —— 照 OptMem `cmd_wake` 原样办。
 *
 * 它的原话是「拒绝的**唯一**理由：没有那块摘要，这份文档就写不出来」。这不是
 * 惩罚，是**唯一能让欠账被还上的力**：让老记忆真的读不到，欠账才会被当回事。
 * 换成"就地拆细"就等于把这股力卸掉了，然后行数无上限地涨。
 *
 * 与 OptMem 的差别只在形式：它 `exit 1`，我们渲染成一段文字——效果一样，模型
 * 把**挡路的那几块**都补完之后，视图自己就回来了。挡路的可能不止一块（实测
 * 102 条欠 98 块时要还 6 块），所以这段文字**不承诺「下一回合就出现」**——
 * 那句承诺在真机实测里曾连续失约 5 次。
 *
 * @param {FixedWidthLog} log - 事实日志。
 * @param {Pyramid} pyramid - 摘要树。
 * @param {number} count - 记录总数。
 * @param {[number, number]} missing - 视图必需却还没写的那一块。
 * @returns {string}
 */
function refuseWakeView(log, pyramid, count, missing) {
  const label = nodeName(missing[0], missing[1])
  const due = describeDue(log, pyramid, count)
  const head = `### Memory view (unavailable)\n\n`
    + `Your ${count} recorded facts cannot be shown: the view needs a one-line summary of `
    + `#${label}, which has not been written yet. Memory is unreadable until the upkeep is paid.\n\n`
    + 'Call `memory_summarize` as instructed below, and re-read the view after the upkeep is paid.'
  if (due === undefined) return head
  return `${head}\n\n${renderDue(due)}`
}

/**
 * 下一块该压缩的节点，连同它的输入。
 *
 * **≤16 条的块直接读原文**，更大的块才用两个半块的摘要。这是为了不让传话游戏
 * 太早开始：若每层都只看下一层的摘要，才 16 条记忆就已经传了 4 代话。
 * 读 16 条原文仍是有界的工作量，所以「每块摘要的成本恒定」并没有因此失效。
 *
 * @param {FixedWidthLog} log - 事实日志。
 * @param {Pyramid} pyramid - 摘要树。
 * @param {number} total - 记录总数。
 * @returns {{ node: string, fromRaw: boolean, parts: string[], remaining: number } | undefined}
 */
function describeDue(log, pyramid, total) {
  const next = pyramid.pending(total, 1)[0]
  if (next === undefined) return undefined
  const [lo, hi] = next
  const remaining = Math.max(0, pyramid.pendingCount(total) - 1)

  if (hi - lo <= RAW_MAX) {
    return {
      node: nodeName(lo, hi),
      fromRaw: true,
      parts: log.readRange(lo, hi).map(record => `#${record.seq} ${record.text}`),
      remaining,
    }
  }
  const mid = (lo + hi) / 2
  return {
    node: nodeName(lo, hi),
    fromRaw: false,
    parts: [[lo, mid], [mid, hi]].map(([a, b]) => {
      const summary = pyramid.get(a, b)
      return `#${nodeName(a, b)} ${summary ?? '(not compressed yet — compress that node first)'}`
    }),
    remaining,
  }
}

/**
 * `memory_note` 的模型可见回执。
 * @param {{ seq: number, total: number, dueSummary?: { node: string, parts: string[], remaining: number } }} value - 工具返回值。
 * @returns {string}
 */
function renderNoteResult(value) {
  const head = `Recorded fact #${value.seq} (${value.total} total).`
  const due = value.dueSummary
  return due === undefined ? head : `${head}\n\n${renderDue(due)}`
}

/**
 * 「压缩这一块」的指令原文。两处共用：`memory_note` 的回执，以及视图渲染不出来
 * 时的那段拒绝文字 —— 两边必须一字不差，否则模型会以为是两件不同的事。
 * @param {{ node: string, parts: string[], remaining: number }} due - 待压缩块。
 * @returns {string}
 */
function renderDue(due) {
  const tail = due.remaining === 0 ? '' : `\n${due.remaining} more compression(s) after this one.`
  return `Compress memories #${due.node} into one line of at most ${MAX_SUMMARY_BYTES} bytes.\n`
    + 'Keep what has lasting effect, drop what does not. Invent nothing.\n\n'
    + `${due.parts.map(part => `  ${part}`).join('\n')}\n`
    + `\nCall memory_summarize with node="${due.node}".${tail}`
}

/**
 * 一行事实的展示形态。
 * @param {{ seq: number, time: string, text: string }} record - 记录。
 * @returns {string}
 */
function formatRecord(record) {
  return `#${record.seq} ${record.time.slice(0, 10)} ${record.text}`
}

/**
 * 校验一行文本：非空、单行、字节数达标。
 * @param {unknown} value - 待校验值。
 * @param {string} field - 字段名，用于报错。
 * @param {number} maxBytes - 字节上限。
 * @returns {string} 修剪后的文本。
 */
function requireLine(value, field, maxBytes) {
  if (typeof value !== 'string') throw new Error(`\`${field}\` must be a string`)
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '') throw new Error(`\`${field}\` must not be empty`)
  const size = byteLength(text)
  if (size > maxBytes) {
    throw new Error(`\`${field}\` is ${size} UTF-8 bytes; the limit is ${maxBytes}. Say it shorter.`)
  }
  return text
}

/**
 * 取正数配置项。
 * @param {unknown} value - 配置值。
 * @param {number} fallback - 默认值。
 * @returns {number}
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 夹取整数配置项。
 * @param {unknown} value - 配置值。
 * @param {number} min - 下界。
 * @param {number} max - 上界。
 * @param {number} fallback - 默认值。
 * @returns {number}
 */
function clamp(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 把一条启动通告说给部署者听。logger 服务缺席时退回 stderr
 * ——「数据目录发生了什么」不能因为没有 logger 就被吞掉。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文。
 * @param {string} message - 通告。
 * @returns {void}
 */
function report(ctx, message) {
  const logger = ctx.get('logger')
  if (logger !== undefined) logger.info(message)
  else process.stderr.write(`${message}\n`)
}
