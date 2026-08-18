/**
 * 面板后厨半边 —— 把金字塔的形状与文本经 HTTP 播给前厅。
 *
 * 前厅（浏览器）够不着后厨的文件系统，这里挂三条只读为主的路由，全部走官方给
 * 第三方留的正门 `ctx.webServer.register()`（与姊妹项目 dsh-lab 的发报机同一条路）。
 *
 * - `GET  /dsh-memory/panel/state`  塔的形状：总数、各层已建块数、注入视图的
 *   覆盖块集（亮区）、视图全文、当前配置。**不含任何块正文**——万条记录的包
 *   有 6MB 原文，形状本身只有几百字节。
 * - `GET  /dsh-memory/panel/block?lo=&hi=`  单块正文，前厅按需懒取（语义缩放
 *   放大到能读字、或点击一块时才来要）。
 * - `GET  /dsh-memory/panel/source?name=`  一份架上快照的原文，也就是某条第一层
 *   记忆的**基底**。两种基底的够得着情况此前是交叉错开的：对话原文只有人够得着
 *   （面板跳转框选），md 快照只有模型够得着（`memory_open`）。这条路由把后半格
 *   补上——人点开一条 `md:` 锚的事实，看得到它是从哪段原文蒸出来的。
 * - `GET|POST /dsh-memory/panel/config`  运行时旋钮：`liveView`（冻结/实时）、
 *   `wakeLines`（注入行数预算）、`noteBytes`（此后写入的正文字节上限）。
 *   **只改内存里的 settings，不落盘**——重启回到 profile 配置，这是观测旋钮
 *   不是部署配置。
 *
 * 诚实纪律：亮区就是 `cover(T, wakeLines)` 本尊——面板的"哪些砖在视图里"与
 * 模型实际收到的视图同源同算法，不存在第二套真相。
 *
 * @module dsh-memory/panel
 */

import { injectSlot, OPEN, QUERY } from './heat.js'
import { byteLength } from './log.js'
import { listShelf, readShelfText, verifyShelfText } from './handoff.js'
import { cover } from './pyramid.js'

/** 路由挂载点。前厅按同样的常量拼 URL。 */
export const PANEL_BASE = '/dsh-memory/panel'

/** noteBytes 的硬上界＝磁盘正文容量。再大就要改 384 定宽、毁掉位置即身份，不做。 */
const NOTE_BYTES_MAX = 295
/** noteBytes 的下界。再小连一句中文都装不下，只会制造碎渣。 */
const NOTE_BYTES_MIN = 16
/** wakeLines 的钳位。上界防手滑把系统提示词撑爆。 */
const WAKE_LINES_MIN = 1
const WAKE_LINES_MAX = 4096
/** POST body 的字节上限。配置只有三个数字，超过这个就不是配置了。 */
const BODY_LIMIT = 4096

/**
 * 注册面板路由。
 *
 * 与 dsh-lab 发报机同一份纪律：`ctx.inject(['webServer'])` 等服务就绪（直接
 * `ctx.get` 会问早了拿 undefined）；申报 webServer 的爆炸半径在这里是对的——
 * 没有 webServer（如 headless profile）面板本来就无处显示，而 try/catch 保证
 * 这种缺席**绝不打断记忆功能本身**。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 注册上下文。
 * @param {object} deps - 后厨已有的活对象，不另开文件句柄。
 * @param {string} deps.dir - 数据目录（出生册的架子挂在它下面）。
 * @param {import('./heat.js').HeatLedger} deps.heat - 用量账。
 * @param {import('./log.js').FixedWidthLog} deps.log - 事实日志。
 * @param {import('./pyramid.js').Pyramid} deps.pyramid - 摘要树。
 * @param {{ liveView: boolean, wakeLines: number, noteBytes: number }} deps.settings - 可变旋钮。
 * @param {() => string} deps.renderWake - 当前注入视图的渲染函数（与模型看到的同一份）。
 * @returns {void}
 */
export function registerPanel(ctx, deps) {
  const { dir, log, pyramid, settings, heat, packs, renderWake } = deps
  /** 本库。`pack` 参数缺省时就是它，也是唯一会被写入用量账的那个。 */
  const own = { name: '', dir, log, pyramid, heat, own: true }

  /**
   * 这一问要看哪个库。
   *
   * ⭐ 只读挂载别的记忆库，是为了让人**在自己还没攒够记忆之前就看得见塔的样子**
   * ——`cover()` 在 70 条与一万条上给出的形状完全是两回事（70 条时整库原文全进
   * 上下文、摘要层一个块都用不上），这件事光靠描述说不清。
   *
   * 挂上来的库一律**只读**：不写它的用量账，也不碰它一个字节。
   *
   * @param {URLSearchParams} query - 查询串。
   * @returns {{ name: string, dir: string, log: any, pyramid: any, heat: any, own: boolean }}
   */
  function libraryOf(query) {
    const name = (query.get('pack') ?? '').trim()
    if (name === '') return own
    return packs.find(p => p.name === name) ?? own
  }
  const routes = [
    { name: 'dsh-memory-panel-state', path: `${PANEL_BASE}/state`, handler: handleState },
    { name: 'dsh-memory-panel-block', path: `${PANEL_BASE}/block`, handler: handleBlock },
    { name: 'dsh-memory-panel-source', path: `${PANEL_BASE}/source`, handler: handleSource },
    { name: 'dsh-memory-panel-heat', path: `${PANEL_BASE}/heat`, handler: handleHeat },
    { name: 'dsh-memory-panel-config', path: `${PANEL_BASE}/config`, handler: handleConfig },
  ]
  try {
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.get('webServer')
      for (const route of routes) {
        const dispose = server.register({
          name: route.name,
          kind: 'exact',
          path: route.path,
          handler: (req, res) => {
            try {
              route.handler(req, res)
            } catch (error) {
              json(res, 200, { ok: false, error: String(error?.message ?? error) })
            }
          },
        })
        if (typeof dispose === 'function') {
          scoped.effect(() => dispose, `dsh-memory: panel route ${route.path}`)
        }
      }
    })
  } catch {
    // 没有 webServer ＝ 没有面板可挂的地方。记忆本体照常工作。
  }

  /**
   * 塔的形状 + 当前视图。
   * @param {import('node:http').IncomingMessage} _req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  function handleState(req, res) {
    const lib = libraryOf(new URL(req.url ?? '', 'http://local').searchParams)
    const total = lib.log.count()
    /** @type {Record<string, number>} 各层已建块数；层按块大小命名，与 TREE/ 同规矩。 */
    const levels = {}
    for (let size = 2; size <= total; size *= 2) levels[size] = lib.pyramid.have(size)
    json(res, 200, {
      ok: true,
      total,
      levels,
      pendingCount: lib.pyramid.pendingCount(total),
      spotlight: lib.own ? (settings.spotlight ?? null) : null,
      config: snapshotConfig(),
      // 挂上来的只读库列表。面板据此画切换钮；`pack` 是这一问看的是谁。
      pack: lib.name,
      packs: packs.map(p => ({ name: p.name, total: p.log.count() })),
      wake: {
        // ⭐ 只读库**没有** wake 视图：视图是「此刻正注入给模型的东西」，而它
        // 根本没被注入。给它渲染一份就是编造一个不存在的当下。
        text: lib.own ? renderWake() : '',
        // 亮区＝cover 本尊。视图因欠压缩渲染不出来时，这仍是"补完欠账后会亮的那组块"；
        // 只读库上它是「若按当前预算注入，会覆盖这些」——真算法，不是真注入。
        blocks: cover(total, settings.wakeLines),
      },
    })
  }

  /**
   * 单块正文。`?lo=&hi=` 是半开区间，须为对齐的 2 幂次块。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  function handleBlock(req, res) {
    const query = new URL(req.url ?? '', 'http://local').searchParams
    const lib = libraryOf(query)
    const lo = Number.parseInt(query.get('lo') ?? '', 10)
    const hi = Number.parseInt(query.get('hi') ?? '', 10)
    const size = hi - lo
    const aligned = Number.isInteger(lo) && Number.isInteger(hi) && size > 0
      && Number.isInteger(Math.log2(size)) && lo % size === 0
    if (!aligned) {
      json(res, 200, { ok: false, error: `not an aligned block: lo=${lo} hi=${hi}` })
      return
    }
    if (size === 1) {
      const record = lib.log.read(lo)
      json(res, 200, record === undefined
        ? { ok: false, error: `record ${lo} does not exist` }
        : { ok: true, raw: true, record })
      return
    }
    const text = lib.pyramid.get(lo, hi)
    // text === undefined ＝ 这块还没被压缩 —— 就是画面上那块虚线柔光砖。如实说。
    json(res, 200, { ok: true, raw: false, text: text ?? null, debt: text === undefined })
  }

  /**
   * 按需取的重包：真用量 ＋ 每条事实的时间戳。
   *
   * **故意不并进 `/state`**：state 每 3 秒轮询一次，而这里是每格一个数
   * ——万条库约 2 万格，并进去等于把一个几百字节的心跳包撑成几十 KB 的定时下载。
   * 面板只在打开、手动刷新、或总条数变了的时候取一次。
   *
   * 编码成 base64 的 32 位小端数组：JSON 数字数组在万级上要 6 倍字节，而这批数
   * 绝大多数是 0。**不做游程压缩**——省下的那点带宽换来的是两边各一套要对齐的
   * 编解码，而这是本机回环。
   *
   * @param {import('node:http').IncomingMessage} _req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  function handleHeat(req, res) {
    const lib = libraryOf(new URL(req.url ?? '', 'http://local').searchParams)
    const total = lib.log.count()
    /** @type {Record<string, string>} 块大小 → base64；`1` 那层就是每条事实。 */
    const inject = {}
    for (let size = 1; size <= Math.max(1, total); size *= 2) {
      const blocks = Math.ceil(total / size)
      const counts = lib.heat.read(`inject/${size}`, 0, blocks)
      if (counts.some(n => n > 0)) inject[size] = pack(counts)
    }
    json(res, 200, {
      ok: true,
      total,
      inject,
      query: pack(lib.heat.read(QUERY, 0, total)),
      open: pack(lib.heat.read(OPEN, 0, total)),
      times: pack(timestamps(lib.log, total)),
    })
  }

  /**
   * 每条事实的入库时刻，**秒**级 Unix 时间。
   *
   * 时间轴上的刻度必须锚在真实记录上——面板不做任何插值，因为一条记录是一个
   * **时刻**不是一段时长，插出来的刻度不对应任何真实事件。所以这一串必须逐条给。
   *
   * 秒而不是毫秒：4 字节装得下到 2106 年，毫秒要 8 字节、体积翻倍，而轴上最细的
   * 一档就是秒。LOG 的时间戳是入库钟、天然单调，直接可用。
   *
   * @param {import('./log.js').FixedWidthLog} from - 要读的那个库的日志。
   * @param {number} total - 记录总数。
   * @returns {number[]}
   */
  function timestamps(from, total) {
    const out = new Array(total).fill(0)
    const CHUNK = 512
    for (let start = 0; start < total; start += CHUNK) {
      const batch = from.readRange(start, Math.min(total, start + CHUNK))
      for (let i = 0; i < batch.length; i++) {
        const at = Date.parse(batch[i].time)
        out[start + i] = Number.isNaN(at) ? 0 : Math.floor(at / 1000)
      }
    }
    return out
  }

  /**
   * 一份架上快照的原文 ＝ 某条第一层记忆的基底。`?name=` 是快照名。
   *
   * 与 `memory_open` 同源同纪律，只差收口值：改过的快照照样点破（拦不住有人绕开
   * 纪律改架上的文件，但改过必须被看见），而这里的读者是人不是模型，**不掐
   * 20000 字节**——那个上限是给模型的阅读预算留的，人在面板里滚动看不花预算。
   *
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  function handleSource(req, res) {
    const query = new URL(req.url ?? '', 'http://local').searchParams
    const lib = libraryOf(query)
    const name = (query.get('name') ?? '').trim()
    const text = readShelfText(lib.dir, name)
    if (text === undefined) {
      const shelf = listShelf(lib.dir)
      json(res, 200, {
        ok: false,
        error: `架上没有名为 '${name}' 的快照`
          + (shelf.length === 0 ? '（架子是空的）。' : `。架上现有：${shelf.join('、')}。`),
      })
      return
    }
    // 人点开出处，与模型走 `memory_open` 是同一件事，记同一笔账。
    // `fact` 是点进来的那条事实的序号；没有它就记不到任何一格上，宁可不记。
    // ⛔ 只读挂上来的库一笔都不记——那不是这台机器的使用痕迹。
    const fact = Number.parseInt(query.get('fact') ?? '', 10)
    if (lib.own && Number.isInteger(fact)) heat.bump(OPEN, fact)
    json(res, 200, {
      ok: true,
      name,
      bytes: byteLength(text),
      tampered: verifyShelfText(lib.dir, name, text) === false,
      text,
    })
  }

  /**
   * 运行时旋钮。GET 读，POST 改（部分更新，只认识三个键）。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  function handleConfig(req, res) {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, config: snapshotConfig() })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'GET or POST only' })
      return
    }
    readBody(req, (error, body) => {
      if (error !== undefined) {
        json(res, 200, { ok: false, error })
        return
      }
      let patch
      try {
        patch = JSON.parse(body)
      } catch {
        json(res, 200, { ok: false, error: 'body is not JSON' })
        return
      }
      if (typeof patch?.liveView === 'boolean') settings.liveView = patch.liveView
      if (Number.isInteger(patch?.wakeLines)) {
        settings.wakeLines = clampInt(patch.wakeLines, WAKE_LINES_MIN, WAKE_LINES_MAX)
      }
      if (Number.isInteger(patch?.noteBytes)) {
        settings.noteBytes = clampInt(patch.noteBytes, NOTE_BYTES_MIN, NOTE_BYTES_MAX)
      }
      // 聚光灯也可从外部点亮（脚本/未来的自动化都能驱动面板看向某块）。
      if (Number.isInteger(patch?.spotlight?.lo) && Number.isInteger(patch?.spotlight?.hi)
        && patch.spotlight.hi > patch.spotlight.lo) {
        settings.spotlight = { lo: patch.spotlight.lo, hi: patch.spotlight.hi, at: Date.now() }
      }
      json(res, 200, { ok: true, config: snapshotConfig() })
    })
  }

  /**
   * 配置快照（连同边界，前厅的滑块刻度直接用它，不各写一份常量）。
   * @returns {object}
   */
  function snapshotConfig() {
    return {
      liveView: settings.liveView,
      wakeLines: settings.wakeLines,
      noteBytes: settings.noteBytes,
      noteBytesMin: NOTE_BYTES_MIN,
      noteBytesMax: NOTE_BYTES_MAX,
    }
  }
}

/**
 * 一串计数打成 base64 的 32 位小端数组。
 * @param {number[]} counts - 计数。
 * @returns {string}
 */
function pack(counts) {
  const buffer = Buffer.alloc(counts.length * 4)
  for (let i = 0; i < counts.length; i++) buffer.writeUInt32LE(counts[i], i * 4)
  return buffer.toString('base64')
}

/**
 * 出一份 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {object} body - 响应体。
 * @returns {void}
 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 收 POST body，带上限。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {(error: string | undefined, body: string) => void} done - 回调。
 * @returns {void}
 */
function readBody(req, done) {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > BODY_LIMIT) {
      req.destroy()
      done(`body exceeds ${BODY_LIMIT} bytes`, '')
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (size <= BODY_LIMIT) done(undefined, Buffer.concat(chunks).toString('utf8'))
  })
  req.on('error', () => done('request stream error', ''))
}

/**
 * 夹取整数。
 * @param {number} value - 值。
 * @param {number} min - 下界。
 * @param {number} max - 上界。
 * @returns {number}
 */
function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
