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
 * ## 冻结（默认）：视图开局注入一次，会话内不再更新
 *
 * 即便走 context()，会话内每写一条记忆仍会让官方追加一份**整版**新视图（写入方
 * 一个 turn 里要吃两份快照）。在增量注入成熟之前，默认把这份冗余也关掉：
 *
 * - 官方快照落盘时带 `source.sections=[{name,text}]`——**会话自己就是账本**。
 *   渲染时从 `AssembleContext.scope.session` 的事件史里倒扫，找到最后一份仍在
 *   surface 上的官方快照，把其中我们那段原文照抄返回；官方比对无差异即静默。
 *   零持久化，服务进程重启免疫（官方 retained 同样从会话史重建）。
 * - 找不到（新会话，或快照被 compaction 压掉）→ 渲染当前全量：前者＝开局注入，
 *   后者＝官方全量重注，两者都该给最新版。
 * - `scope.session` 摸不到（无 scope 的装配、未来版本变化）→ 退回实时渲染：
 *   宁可回到"活视图"的旧行为，不冻错、不黑屏。
 * - 会话中途写入的内容不丢：工具回执落在消息队尾，本来就免费可见；下个新会话
 *   开局拿到最新全量。`liveView: true` 可换回实时更新。
 *
 * ## 数据落在工作区，不落 `~/.dsh`
 *
 * `ctx.storage` 的 root 由 backend 的 composition config 钉死在
 * `dshHomePath('storages')`，第三方插件改不了。所以这里跟官方 `storage-json`
 * 一样直接用 node `fs` 写自己指定的目录。
 *
 * @module dsh-memory
 */

import fs from 'node:fs'
import path from 'node:path'

import { openDataDir, resolveDataDir, workspaceRoot } from './store.js'
import { HeatLedger, injectSlot, OPEN, QUERY } from './heat.js'
import { byteLength, FixedWidthLog, MAX_TEXT_BYTES } from './log.js'
import { registerPanel } from './panel.js'
import {
  HANDOFF_ANCHOR_PREFIX, listShelf, pendingImports, readShelfText,
  shelfNameFromAnchor, sweepShelf, verifyShelfText,
} from './handoff.js'
import { MAX_SUMMARY_BYTES, nodeName, parseNode, Pyramid, RAW_MAX } from './pyramid.js'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt']

/** 纪律段在系统提示词里的位置。100–199 是官方给工具引导留的号段。 */
const SECTION_ORDER_DISCIPLINE = 130
/** 记忆视图在**动态上下文**里的位置（与 section 的号段无关，只决定同类之间的先后）。 */
const CONTEXT_ORDER_WAKE = 130
/** 记忆视图在官方快照 `sections` 里的署名，也是冻结时找回自己上一份原文的钥匙。 */
const CONTEXT_NAME_WAKE = 'dsh-memory:wake'
/** 官方 runtime-context 快照消息的署名（`user/message` 的 `source.plugin`）。 */
const OFFICIAL_SNAPSHOT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

/**
 * 冻结模式：从会话事件史里找回「这个会话最后一次被注入的记忆视图原文」。
 *
 * 判据镜像官方 `RuntimeContextProjection` 的恢复逻辑（倒扫事件史，只认仍在
 * surface 上的官方快照；不在 surface 的说明已被 compaction 换掉，跳过继续找
 * 更老的）。返回那份快照里我们署名段的原文；返回 `undefined` 表示没有可冻结
 * 的底——新会话、快照被压光、或根本摸不到会话——由调用方渲染当前全量。
 *
 * @param {object} [session] - `AssembleContext.scope.session`（官方 agent 的会话对象）。
 * @returns {string | undefined}
 */
export function pickFrozenWake(session) {
  const events = session?.events
  const nodes = session?.surface?.nodes
  if (!Array.isArray(events) || nodes === undefined) return undefined
  const surface = new Set(nodes)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'plugin' || source.plugin !== OFFICIAL_SNAPSHOT_PLUGIN) continue
    if (!surface.has(event.seq)) continue
    const mine = Array.isArray(source.sections)
      ? source.sections.find(section => section?.name === CONTEXT_NAME_WAKE)
      : undefined
    // 快照在、但没有我们那段（如清空墓碑）＝没有可抄的底，交回全量渲染。
    return typeof mine?.text === 'string' ? mine.text : undefined
  }
  return undefined
}

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
 * @param {boolean} [config.liveView] - 会话中途记忆变化时是否实时更新视图，默认
 *   false＝冻结（视图只在会话开局注入一次，中途写入见工具回执，新会话见最新全量）。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const dir = resolveDataDir(config)
  const opened = openDataDir(dir, { subdirs: ['TREE'], migrate: config.migrate !== false })
  const log = new FixedWidthLog(dir)
  const pyramid = new Pyramid(dir)
  const heat = new HeatLedger(dir)
  /**
   * 已经记过注入的视图：会话 id → 那份视图原文。
   *
   * 上下文在一轮里可能被装配不止一次，而模型只看见了一份。**只记内存、重启即忘**
   * ——与用量账「可丢的观测」同一性质，宁可少记一笔也不虚报。
   * @type {Map<string, string>}
   */
  const counted = new Map()

  /**
   * 运行时旋钮。面板（panel.js 的 config 路由）会就地改这三个值，所以下面
   * 所有用到它们的地方都必须**每次现读**，不许在注册时拷贝快照——冻结/实时
   * 分支曾在注册时定死，是 §15.5 早预告要挪的那一行。
   * 只改内存不落盘：重启回到 profile 配置。
   */
  const settings = {
    liveView: config.liveView === true,
    wakeLines: positive(config.wakeLines, DEFAULT_WAKE_LINES),
    noteBytes: MAX_TEXT_BYTES,
    /**
     * 聚光灯：模型最近一次"用手指指过"的记忆位置（CEO 2026-08-16 提出的
     * LLM 友好接口）。不加新工具——模型调 `memory_zoom` / `memory_recall`
     * 本来就是在看某一块，后厨顺手记下，面板轻刷看到就把画面带过去。
     * 形如 { lo, hi, at }；null＝从未指过。
     */
    spotlight: null,
  }

  for (const notice of opened.notices) report(ctx, notice)
  if (log.repaired > 0) {
    report(ctx, `dsh-memory: 掐掉了 LOG.txt 末尾 ${log.repaired} 字节残片（上次写入被中断），既有记录未受影响`)
  }
  report(ctx, `dsh-memory: 当前 ${log.count()} 条事实，${pyramid.pendingCount(log.count())} 块待压缩`)

  // 巡架：出生册的入口就是文件夹本身（往里放文件＝上架，没有写入工具）。
  // 装载时补登手动放入的文件、点出装不进锚点字段的名字。幂等，代价一次 readdir。
  const swept = sweepShelf(dir)
  if (swept.registered.length > 0) {
    report(ctx, `dsh-memory: 出生册补登 ${swept.registered.length} 份新放入的文本：`
      + swept.registered.map(r => r.name).join(', '))
  }
  for (const bad of swept.invalid) {
    report(ctx, `dsh-memory: ⚠ 出生册文件 '${bad.name}' 的名字装不进锚点字段，改名后才能被记忆引用（${bad.reason}）`)
  }
  {
    const waiting = pendingImports(dir, anchoredSources(log))
    if (waiting.length > 0) {
      report(ctx, `dsh-memory: 出生册上 ${waiting.length} 份文本尚无记忆（待导入）：${waiting.join(', ')}`)
    }
  }

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
    // 预算进缓存键：面板拨动 wakeLines 时旧缓存自动失效，不需要手动打点。
    const key = `${count}:${pyramid.pendingCount(count)}:${settings.wakeLines}`
    if (cached?.key === key) return cached.text
    const text = buildWakeView(log, pyramid, count, settings.wakeLines)
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
  // 默认冻结（抬头「冻结」一节）：有底照抄＝官方静默；没底才渲染当前全量。
  if (config.injectWake !== false) {
    ctx.systemPrompt.context({
      name: CONTEXT_NAME_WAKE,
      order: CONTEXT_ORDER_WAKE,
      // 冻结/实时在**每次渲染**时现读，面板拨开关立即生效、不需重装插件。
      text: (ac) => {
        const text = settings.liveView
          ? renderWake()
          : pickFrozenWake(ac?.scope?.session) ?? renderWake()
        // ⚠ 记账只能记在这里，不能记进 renderWake()：面板的 /state 每 3 秒调一次
        // renderWake，记进去就是**把轮询当成注入**——面板开着就自己把颜色刷亮，
        // 一块看起来完全合理的假数据。这里是视图真的交给模型的唯一出口。
        countInjection(heat, counted, ac, text)
        return text
      },
    })
  }

  registerPanel(ctx, { dir, log, pyramid, settings, heat, packs: mountPacks(ctx, config), renderWake })

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
        source: {
          type: 'string',
          description: 'Only when distilling an imported text: the name of its snapshot on the '
            + 'memory_handoff shelf. The fact then carries a followable anchor to that original. '
            + 'Omit for facts born from this conversation.',
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
          dueImport: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'integer' },
              names: { type: 'array', items: { type: 'string' } },
            },
            required: ['count', 'names'],
          },
        },
        required: ['seq', 'total'],
      },
      render: (_args, value) => [{ type: 'text', text: renderNoteResult(value) }],
    },
    execute(args, exec) {
      // 上限现读 settings：面板可把它调小/调大（硬顶 295＝磁盘正文容量）。
      // 工具 description 里的数字保持静态——它在缓存前缀里，运行时改会打碎缓存。
      const text = requireLine(args?.text, 'text', settings.noteBytes)
      // 文本锚：事实提炼自出生册上的一份快照。快照必须已在架上——**先有原文、
      // 后有指针**，不存在的锚当场拒绝，绝不写下一个将来才兑现的地址。
      if (typeof args?.source === 'string' && args.source !== '') {
        const name = args.source.trim()
        if (readShelfText(dir, name) === undefined) {
          const shelf = listShelf(dir)
          throw new Error(
            `memory_note: no snapshot named '${name}' on the memory_handoff shelf`
            + (shelf.length === 0 ? ' (the shelf is empty).' : `. On the shelf: ${shelf.join(', ')}.`),
          )
        }
        const written = log.append({ text, sessionId: `${HANDOFF_ANCHOR_PREFIX}${name}`, seqLo: 0, seqHi: 0 })
        cached = undefined
        const total = log.count()
        const due = describeDue(log, pyramid, total)
        return Promise.resolve({
          seq: written.seq,
          total,
          ...(due === undefined ? {} : { dueSummary: due }),
          ...(describeImports(dir, log) ?? {}),
        })
      }
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
        ...(describeImports(dir, log) ?? {}),
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
      + 'Write the content only: the range id is printed for you wherever the summary appears, '
      + 'so repeating it inside the text spends bytes you need for the content itself. '
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
      + 'Use `memory_recall` instead when you want to scan for a pattern rather than navigate.',
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
      settings.spotlight = { lo: node.lo, hi: node.hi, at: Date.now() }
      const mid = (node.lo + node.hi) / 2
      const halves = [[node.lo, mid], [mid, node.hi]].map(([lo, hi]) => {
        // 半块只剩一条时它是事实行，不是块 —— 名字是 `#N`，也搜得到。
        if (hi - lo === 1) {
          return { node: String(lo), raw: true, text: log.read(lo)?.text ?? '(missing record)' }
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
      'Read raw facts from the long-term timeline. Give `query` — a case-insensitive REGULAR EXPRESSION — '
      + 'to scan for matching facts, newest first. It is matched against "#<record number> <timestamp> <text>", '
      + 'so `^#42 ` picks one record, `2026-08` picks a month, and `sh(rimp|ark)` covers two wordings at once. '
      + '`from`/`to` bound the scan when combined with `query`, or read an exact record range on their own. '
      + 'The reply always states how many facts matched in total, so a shortened answer is visibly shortened. '
      + 'Each fact carries the session id and the event seq range it distilled, so the original transcript '
      + 'can be opened from there. To navigate the tree instead of scanning, use `memory_zoom`.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive regular expression, matched against "#<record number> <timestamp> <text>".',
        },
        from: { type: 'integer', description: 'First record number to scan or read (inclusive).' },
        to: { type: 'integer', description: 'Last record number to scan or read (exclusive).' },
        limit: { type: 'integer', description: 'Maximum records to return. Defaults to 40.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          matched: { type: 'integer' },
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
        required: ['total', 'matched', 'records'],
      },
      // `total` 是库里有多少条，`matched` 是这一问命中多少条 —— 两个数必须都说，
      // 且**被截断时必须自报被截断**。旧文案只有「N of 总条数」，命中 3290 却
      // 只返 40 时它照样是一句真话，模型却只能读成「一共就 40 条」。诚实原则：
      // 宁可让回执长一行，也不给一个自洽到无从起疑的错觉。
      render: (_args, value) => {
        if (value.records.length === 0) {
          return [{ type: 'text', text: `No matching facts (${value.total} recorded in total).` }]
        }
        const withheld = value.matched - value.records.length
        const head = withheld > 0
          ? `Newest ${value.records.length} of ${value.matched} matches (${value.total} facts recorded). `
            + `${withheld} older ${withheld === 1 ? 'match is' : 'matches are'} not shown — narrow the pattern, `
            + 'raise `limit`, or aim the scan with `from`/`to`.'
          : `${value.matched} of ${value.total} facts:`
        return [{ type: 'text', text: `${head}\n${value.records.map(formatRecord).join('\n')}` }]
      },
    },
    execute(args) {
      const limit = clamp(args?.limit, 1, 200, 40)
      const total = log.count()
      const window = {}
      if (Number.isInteger(args?.from)) window.from = args.from
      if (Number.isInteger(args?.to)) window.to = args.to
      let matched
      let found
      if (typeof args?.query === 'string' && args.query !== '') {
        let pattern
        try {
          // `i` 而已 —— 不能带 `g`，那会让 test() 记住上次位置、隔一条漏一条。
          pattern = new RegExp(args.query, 'i')
        } catch (error) {
          throw new Error(
            `memory_recall: \`query\` is a regular expression, and this one does not compile (${error.message}). `
            + 'Escape the special characters — to look for the literal "C++", pass "C\\+\\+".',
          )
        }
        ;({ matched, records: found } = log.search(pattern, limit, window))
      } else {
        const lower = Math.max(0, window.from ?? Math.max(0, total - limit))
        const upper = Math.min(total, window.to ?? total)
        matched = Math.max(0, upper - lower)
        // 只把要交出去的那一段读进来。旧写法 readRange(lower, upper).slice(-limit)
        // 会把整段先装进内存再扔掉——from=0/to=10000 时白分配 3.7MB，而且同样
        // 悄悄丢掉 9960 条不吭声（与 search 那块是同一个病）。
        found = log.readRange(Math.max(lower, upper - limit), upper)
      }
      // 用量账：**只记交到模型手上的那几条**。被截断压下的那些没到模型面前，
      // 记了就是虚报——热度问的是「这条记忆被翻出来看过几次」。
      heat.bumpMany(QUERY, found.map(record => record.seq))
      // 聚光灯：搜到什么就指向什么（搜索取最新命中那条；区间读取指向整段）。
      if (found.length > 0) {
        settings.spotlight = {
          lo: Math.min(...found.map(r => r.seq)),
          hi: Math.max(...found.map(r => r.seq)) + 1,
          at: Date.now(),
        }
      }
      return Promise.resolve({
        total,
        matched,
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
    name: 'memory_open',
    description:
      'Open the original text behind a fact — the step OUT of the memory tree. '
      + 'Facts distilled from imported texts carry an anchor to a frozen snapshot on the '
      + 'memory_handoff shelf; this returns that snapshot in full. '
      + 'Give `fact` (a record number, e.g. from `memory_recall`) to follow its anchor, '
      + 'or `source` (a snapshot name) to open one directly. '
      + 'Use it when a one-line fact or summary is not enough and you need the details it was distilled from.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'integer', description: 'Record number whose anchor to follow.' },
        source: { type: 'string', description: 'Snapshot name on the memory_handoff shelf.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          bytes: { type: 'integer' },
          truncated: { type: 'boolean' },
          tampered: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['name', 'bytes', 'truncated', 'text'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.tampered === true
          ? `WARNING: '${value.name}' no longer matches its check-in record — it was edited after import. `
            + 'What follows is the CURRENT content, not necessarily what the memory distilled.\n'
          : '')
          + `=== ${value.name} (${value.bytes} bytes${value.truncated ? ', first part' : ''}) ===\n${value.text}`,
      }],
    },
    execute(args) {
      let name
      if (typeof args?.source === 'string' && args.source !== '') {
        name = args.source.trim()
      } else if (Number.isInteger(args?.fact)) {
        const record = log.read(args.fact)
        if (record === undefined) {
          throw new Error(`memory_open: no fact #${args.fact} — the log holds ${log.count()}`)
        }
        settings.spotlight = { lo: record.seq, hi: record.seq + 1, at: Date.now() }
        // 顺锚打开＝这条记忆的**基底**被翻出来了一次。按 source 名直接开的那条
        // 路不记：没有事实序号，记不到任何一格上，硬记就得编一个。
        heat.bump(OPEN, record.seq)
        name = shelfNameFromAnchor(record.sessionId)
        if (name === undefined) {
          throw new Error(record.sessionId === ''
            ? `memory_open: fact #${args.fact} carries no anchor (it predates anchoring, or was written without a session)`
            : `memory_open: fact #${args.fact} is anchored to a conversation (${record.sessionId}), `
              + 'not an imported text — opening session transcripts is not supported yet')
        }
      } else {
        throw new Error('memory_open: give `fact` (a record number) or `source` (a snapshot name)')
      }
      const text = readShelfText(dir, name)
      if (text === undefined) {
        const shelf = listShelf(dir)
        throw new Error(
          `memory_open: no snapshot named '${name}' on the memory_handoff shelf`
          + (shelf.length === 0 ? ' (the shelf is empty).' : `. On the shelf: ${shelf.join(', ')}.`),
        )
      }
      const bytes = byteLength(text)
      // 拦不住有人绕开纪律改架上的文件，但改过必须被看见（诚实原则）。
      const intact = verifyShelfText(dir, name, text)
      const flags = intact === false ? { tampered: true } : {}
      // 与 OptMem 的 PART_CHARS 同一个理由：每家 harness 都会掐超长输出，且各掐
      // 各的位置——与其被运输层静默截断，不如自己在 20000 字节整齐收口。
      const CAP = 20000
      if (bytes <= CAP) {
        return Promise.resolve({ name, bytes, truncated: false, ...flags, text })
      }
      const clipped = Buffer.from(text, 'utf8').subarray(0, CAP).toString('utf8').replace(/\uFFFD+$/, '')
      return Promise.resolve({ name, bytes, truncated: true, ...flags, text: clipped })
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
  \`memory_recall\` scans the raw facts with a regular expression — cover the several
  wordings a thing goes by in one pattern, and read the match count it reports: a
  shortened answer says so, and says how many older matches it held back.
- Facts marked \`[source: <name>]\` distill an imported text (notes, docs, a book)
  whose frozen original sits on the memory_handoff shelf; \`memory_open\` retrieves
  it in full when the one-line fact is not enough.

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
  // 单条事实打 `#N`，块打 `#a-b`。**这两种形状不许混**：`#N` 正是
  // `memory_recall` 的匹配面（`log.js` 的 `matchable`）上那一行的写法，模型从视图
  // 抄一个编号去搜必须能搜到。曾经这里一律打 `#N-N`，于是抄 `#10006-10006` 去搜
  // 得零条——格式合法、数字真实、无声无息。
  const lines = blocks.map((block) => {
    if (!block.raw) return `#${nodeName(block.lo, block.hi)} ${block.text}`
    return `#${block.lo} ${log.read(block.lo)?.time.slice(0, 10) ?? '??'} ${block.text}`
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
 * 只读挂上几个别的记忆库，给面板当参照。
 *
 * ⭐ 为什么值得有：`cover()` 在 70 条与一万条上给出的塔**形状完全是两回事**
 * ——70 条时整库原文全进上下文、摘要层一个块都用不上，橘线整整齐齐落在第一层
 * 那一排；一万条时才是那座十五层的塔。这件事光靠描述说不清，得看。而一个刚装上
 * 插件的人手里一条记忆都没有。
 *
 * 挂上来的库**一个字节都不写**：不记它的用量账、不补它的摘要、不给它渲染 wake
 * 视图（视图是「此刻正注入给模型的东西」，而它根本没被注入，渲染一份就是编造一个
 * 不存在的当下）。挂载失败只是少一个参照，绝不打断记忆本体。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 用来报信。
 * @param {{ packs?: Array<string | { name?: string, dir: string }> }} config - 配置。
 * @returns {Array<{ name: string, dir: string, log: FixedWidthLog, pyramid: Pyramid, heat: HeatLedger, own: boolean }>}
 */
function mountPacks(ctx, config) {
  const wanted = Array.isArray(config.packs) ? config.packs : []
  const out = []
  for (const entry of wanted) {
    const where = typeof entry === 'string' ? entry : entry?.dir
    if (typeof where !== 'string' || where === '') continue
    const full = path.resolve(workspaceRoot(), where)
    const name = (typeof entry === 'object' && entry?.name) || path.basename(full)
    try {
      // 认库只看 LOG.txt 在不在——不 openDataDir，那会**建目录、写标记文件**，
      // 而这里的承诺是一个字节都不写。
      if (!fs.existsSync(path.join(full, 'LOG.txt'))) {
        report(ctx, `dsh-memory: ⚠ 参照库 '${name}' 里没有 LOG.txt，跳过（${full}）`)
        continue
      }
      const log = new FixedWidthLog(full)
      out.push({ name, dir: full, log, pyramid: new Pyramid(full), heat: new HeatLedger(full), own: false })
      report(ctx, `dsh-memory: 只读挂上参照库 '${name}'（${log.count()} 条）`)
    } catch (error) {
      report(ctx, `dsh-memory: ⚠ 参照库 '${name}' 挂不上：${String(error?.message ?? error)}`)
    }
  }
  return out
}

/**
 * 记下「这份视图被注入了一次」。
 *
 * **记的是视图原文里真的出现了哪几块**，不是此刻 `cover()` 会算出哪几块——
 * 冻结模式下模型看到的是会话开局那份旧视图，按当前 cover 记就记错人了。
 * 视图是我们自己渲染的，行首那个编号就是块的名字，解析它是精确的。
 *
 * 去重口径：**每个会话、每份不同的视图记一次**。上下文在一轮里可能被装配多次
 * 而模型只看见一份；冻结模式下同一份视图每轮都会再交一遍，那也仍是「这个会话
 * 注入了这份视图」这一件事。
 *
 * @param {import('./heat.js').HeatLedger} heat - 用量账。
 * @param {Map<string, string>} counted - 会话 id → 已记过的视图原文。
 * @param {any} ac - 装配上下文。
 * @param {string} text - 即将交给模型的视图原文。
 * @returns {void}
 */
function countInjection(heat, counted, ac, text) {
  const session = String(ac?.scope?.session?.id ?? '')
  if (counted.get(session) === text) return
  // 会话数无上限，这张表却只是防重复的便签——留最近的几十个就够，
  // 满了从最旧的丢（Map 的迭代序就是插入序）。
  if (counted.size >= 64) counted.delete(counted.keys().next().value)
  counted.set(session, text)
  const slots = new Map()
  for (const [, lo, hi] of text.matchAll(/^#(\d+)(?:-(\d+))? /gm)) {
    const from = Number.parseInt(lo, 10)
    const to = hi === undefined ? from + 1 : Number.parseInt(hi, 10) + 1
    const size = to - from
    if (size < 1 || !Number.isInteger(Math.log2(size)) || from % size !== 0) continue
    const { kind, index } = injectSlot(from, to)
    if (!slots.has(kind)) slots.set(kind, [])
    slots.get(kind).push(index)
  }
  for (const [kind, indexes] of slots) heat.bumpMany(kind, indexes)
}

/**
 * 已被任何事实锚引用过的快照名集合。分块线性扫——与 `search` 同一节奏，
 * 不一次吃下整个 LOG。
 * @param {FixedWidthLog} log - 事实日志。
 * @returns {Set<string>}
 */
function anchoredSources(log) {
  const out = new Set()
  const total = log.count()
  const CHUNK = 512
  for (let start = 0; start < total; start += CHUNK) {
    for (const record of log.readRange(start, Math.min(total, start + CHUNK))) {
      const name = shelfNameFromAnchor(record.sessionId)
      if (name !== undefined) out.add(name)
    }
  }
  return out
}

/**
 * 待导入提醒（与 dueSummary 同族：搭 note 回执的车，队尾追加、不动前缀）。
 * @param {string} dir - 数据目录。
 * @param {FixedWidthLog} log - 事实日志。
 * @returns {{ dueImport: { count: number, names: string[] } } | undefined}
 */
function describeImports(dir, log) {
  const waiting = pendingImports(dir, anchoredSources(log))
  if (waiting.length === 0) return undefined
  return { dueImport: { count: waiting.length, names: waiting.slice(0, 5) } }
}

/**
 * `memory_note` 的模型可见回执。
 * @param {{ seq: number, total: number, dueSummary?: { node: string, parts: string[], remaining: number }, dueImport?: { count: number, names: string[] } }} value - 工具返回值。
 * @returns {string}
 */
function renderNoteResult(value) {
  let out = `Recorded fact #${value.seq} (${value.total} total).`
  if (value.dueSummary !== undefined) out += `\n\n${renderDue(value.dueSummary)}`
  if (value.dueImport !== undefined) {
    const { count, names } = value.dueImport
    out += `\n\n${count} imported text(s) on the shelf have no memories yet: `
      + names.join(', ') + (count > names.length ? ', …' : '')
      + '\nFor each: read it with memory_open (source=<name>), then record what it says '
      + 'in one fact — memory_note with source=<name>.'
  }
  return out
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
  // 文本锚渲染给模型看：看得见才跟得过去（memory_open）。会话锚暂不渲染
  // ——下钻会话原文的工具还不存在，渲染一个跟不过去的指针只会引人猜。
  const source = shelfNameFromAnchor(record.sessionId)
  const tail = source === undefined ? '' : ` [source: ${source}]`
  return `#${record.seq} ${record.time.slice(0, 10)} ${record.text}${tail}`
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
