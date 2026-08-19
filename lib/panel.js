/**
 * 面板后厨半边 —— 把金字塔的形状与文本经 HTTP 播给前厅。
 *
 * 前厅（浏览器）够不着后厨的文件系统，这里挂三条只读为主的路由，全部走官方给
 * 第三方留的正门 `ctx.webServer.register()`。
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
 * ## ⭐ 每一问都要带 `root=`（2026-08-19）
 *
 * 记忆跟**用户在 dsh 里选的工作区**走。后厨的其余入口都能从 session 自报出身，
 * 唯独 HTTP 请求**不属于任何会话**，所以只能由前端把当前工作区路径带上来。
 *
 * 没带、或那个路径没有对应的库时，一律回 `{ ok: false, noWorkspace: true }`，
 * 面板据此如实说"还没选工作区"。**绝不兜底到某个库**——那正是这轮要修的病：
 * dsh 说"一个工作区都没有"，面板同时报着一万条。
 *
 * @module dsh-memory/panel
 */

import { injectSlot, OPEN, QUERY } from './heat.js'
import { byteLength } from './log.js'
import { listShelf, readShelfText, verifyShelfText } from './handoff.js'
import { selfReport } from './mounts.js'
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
 * 纪律：`ctx.inject(['webServer'])` 等服务就绪（直接
 * `ctx.get` 会问早了拿 undefined）；申报 webServer 的爆炸半径在这里是对的——
 * 没有 webServer（如 headless profile）面板本来就无处显示，而 try/catch 保证
 * 这种缺席**绝不打断记忆功能本身**。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 注册上下文。
 * @param {object} deps - 后厨已有的活对象，不另开文件句柄。
 * @param {{ liveView: boolean, wakeLines: number, noteBytes: number }} deps.settings - 可变旋钮。
 * @param {(root: string) => object | undefined} deps.libraryOfRoot - 工作区路径 → 那个
 *   工作区的库。够不着就 undefined，**这里绝不自己找补**。
 * @param {(library: object) => string} deps.renderWake - 某个库当前注入视图的渲染
 *   函数（与模型看到的同一份）。
 * @returns {void}
 */
export function registerPanel(ctx, deps) {
  const { settings, libraryOfRoot, renderWake } = deps

  /**
   * 这一问看的是哪个工作区的库（＝会被写用量账的那个「本库」）。
   *
   * 空的 `root` 也照样问下去，**不在这里短路**：`dataDir` 钉死时压根不该要
   * `root`，而"钉没钉死"是后厨的事，面板不该知道。
   *
   * @param {URLSearchParams} query - 查询串。
   * @returns {object | undefined} 够不着时 undefined。
   */
  function ownLibrary(query) {
    return libraryOfRoot((query.get('root') ?? '').trim())
  }

  /**
   * 这一问要看哪个库：本库，还是它挂着的某个只读参照库。
   *
   * ⭐ 只读挂载别的记忆库，是为了让人**在自己还没攒够记忆之前就看得见塔的样子**
   * ——`cover()` 在 70 条与一万条上给出的形状完全是两回事（70 条时整库原文全进
   * 上下文、摘要层一个块都用不上），这件事光靠描述说不清。
   *
   * 挂上来的库一律**只读**：不写它的用量账，也不碰它一个字节。
   * `synthetic` 连本库也读：把测试包直接当数据目录用是很自然的事，那时它照样是
   * 合成的，界面该照说不误。
   *
   * @param {URLSearchParams} query - 查询串。
   * @param {object} own - 本库（已由 `ownLibrary` 解析好）。
   * @returns {{ name: string, dir: string, log: any, pyramid: any, heat: any, own: boolean }}
   */
  function libraryOf(query, own) {
    const mine = { name: '', ...own, own: true, synthetic: selfReport(own.dir) }
    const name = (query.get('pack') ?? '').trim()
    if (name === '') return mine
    // 每次现查：名单是活的，面板随时能挂上/卸掉一个库。
    return own.mounts.entries.find(pack => pack.name === name) ?? mine
  }

  // `library: true` ＝ 这条路由必须先认出工作区。**六条全要**：没选工作区时
  // 面板什么都不该显示，连旋钮也不该给——那会让人以为它正在管着某个库。
  const routes = [
    { name: 'dsh-memory-panel-state', path: `${PANEL_BASE}/state`, handler: handleState },
    { name: 'dsh-memory-panel-block', path: `${PANEL_BASE}/block`, handler: handleBlock },
    { name: 'dsh-memory-panel-source', path: `${PANEL_BASE}/source`, handler: handleSource },
    { name: 'dsh-memory-panel-heat', path: `${PANEL_BASE}/heat`, handler: handleHeat },
    { name: 'dsh-memory-panel-config', path: `${PANEL_BASE}/config`, handler: handleConfig },
    { name: 'dsh-memory-panel-mounts', path: `${PANEL_BASE}/mounts`, handler: handleMounts },
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
              const query = new URL(req.url ?? '', 'http://local').searchParams
              const own = ownLibrary(query)
              if (own === undefined) {
                json(res, 200, {
                  ok: false,
                  noWorkspace: true,
                  error: '还没选工作区。记忆住在工作区旁边（<工作区>/dsh_memory），'
                    + '选一个工作区就能看见它的塔。',
                })
                return
              }
              route.handler(req, res, query, own)
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
   * @param {URLSearchParams} query - 查询串。
   * @param {object} own - 本工作区的库。
   */
  function handleState(_req, res, query, own) {
    const lib = libraryOf(query, own)
    const total = lib.log.count()
    /** @type {Record<string, number>} 各层已建块数；层按块大小命名，与 TREE/ 同规矩。 */
    const levels = {}
    for (let size = 2; size <= total; size *= 2) levels[size] = lib.pyramid.have(size)
    json(res, 200, {
      ok: true,
      total,
      levels,
      pendingCount: lib.pyramid.pendingCount(total),
      spotlight: lib.own ? (own.spotlight ?? null) : null,
      config: snapshotConfig(),
      // 这一问落在哪个工作区的库上。前端拿它核对自己算的工作区没有跑偏
      // ——后厨认的是**官方规范路径**，可能与前端手上那个拼法不同字。
      root: own.dir,
      // 挂上来的只读库列表。面板据此画切换钮；`pack` 是这一问看的是谁。
      pack: lib.name,
      packs: own.mounts.list(),
      // 这一问看的这个库是不是合成的。⭐ 面板据此明示「时间戳/热度/基底是算出来的」
      // ——合成数看起来和真账一模一样，不点名就会被当真账读。
      synthetic: lib.synthetic ?? null,
      wake: {
        // 挂上来的库与本库同一套渲染：同一份算法算同一种东西，没有理由分岔。
        //
        // ⚠ 缓存对象同 `times` 那条：本库那一支的 `lib` 是每次现拼的投影，记忆化
        //    必须落在活得久的 `own` 上，否则每次轮询都重算一遍整份视图。
        // ⚠ 渲染只读不写——`renderWake` 只碰日志与摘要树，用量账一个字节都不动。
        //    面板每 3 秒问一次，若在这里记账就成了「把轮询当成注入」。
        text: renderWake(lib.own ? own : lib),
        // 亮区＝cover 本尊。视图因欠压缩渲染不出来时，这仍是"补完欠账后会亮的那组块"。
        blocks: cover(total, settings.wakeLines),
      },
    })
  }

  /**
   * 单块正文。`?lo=&hi=` 是半开区间，须为对齐的 2 幂次块。
   * @param {import('node:http').IncomingMessage} _req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {URLSearchParams} query - 查询串。
   * @param {object} own - 本工作区的库。
   */
  function handleBlock(_req, res, query, own) {
    const lib = libraryOf(query, own)
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
   * @param {URLSearchParams} query - 查询串。
   * @param {object} own - 本工作区的库。
   */
  function handleHeat(_req, res, query, own) {
    const lib = libraryOf(query, own)
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
      // ⚠ `lib` 在"本库"那一支是**每次现拼的投影对象**（要加 name/own/synthetic
      //    三个展示字段），缓存写在它身上下一次就没了。时间戳缓存必须落在**活得久
      //    的那个对象**上：本库＝`own`，参照库＝名单里那个 entry 本身。
      times: pack(timestamps(lib.own ? own : lib, total)),
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
   * ## ⭐ 只增量补，绝不重读
   *
   * 从前每次 `/heat` 都把整个 LOG 重读一遍：一万条 ＝ 3.7MB 文件读，而切库时
   * 这一批要整个重来，这就是「切包之后热度颜色要等明显一段时间」的大头。
   *
   * **LOG 是定宽只追加的**——第 N 条写下之后位置与内容永不改变，所以已经算过的
   * 前缀是**不可变的**，缓存它不需要任何失效判断，只需要往后接。这不是"赌它不变"，
   * 是这套数据结构的硬保证（`log.js` 抬头：位置即身份）。
   *
   * 缓存挂在库自己身上（`lib.times`），所以多个工作区各存各的、互不干扰。
   *
   * @param {object} lib - 要读的那个库（本库或只读参照库）。
   * @param {number} total - 记录总数。
   * @returns {number[]}
   */
  function timestamps(lib, total) {
    let out = lib.times
    // 只可能变短的情形：换了个同名对象或库被重建。长了就接着补，短了就重来。
    if (!Array.isArray(out) || out.length > total) out = []
    const CHUNK = 512
    for (let start = out.length; start < total; start += CHUNK) {
      const batch = lib.log.readRange(start, Math.min(total, start + CHUNK))
      for (const record of batch) {
        const at = Date.parse(record.time)
        out.push(Number.isNaN(at) ? 0 : Math.floor(at / 1000))
      }
    }
    lib.times = out
    return out
  }

  /**
   * 一份架上快照的原文 ＝ 某条第一层记忆的基底。`?name=` 是快照名。
   *
   * 与 `memory_open` 同源同纪律，只差收口值：改过的快照照样点破（拦不住有人绕开
   * 纪律改架上的文件，但改过必须被看见），而这里的读者是人不是模型，**不掐
   * 20000 字节**——那个上限是给模型的阅读预算留的，人在面板里滚动看不花预算。
   *
   * @param {import('node:http').IncomingMessage} _req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {URLSearchParams} query - 查询串。
   * @param {object} own - 本工作区的库。
   */
  function handleSource(_req, res, query, own) {
    const lib = libraryOf(query, own)
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
    if (lib.own && Number.isInteger(fact)) own.heat.bump(OPEN, fact)
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
   *
   * 三个旋钮是**整台服务**的（它们影响的是注入行为本身，不分库）；只有聚光灯
   * 跟库走——A 工作区指过的块，画在 B 工作区的塔上就是一个错的高亮。
   *
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {URLSearchParams} _query - 查询串。
   * @param {object} own - 本工作区的库。
   */
  function handleConfig(req, res, _query, own) {
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
        own.spotlight = { lo: patch.spotlight.lo, hi: patch.spotlight.hi, at: Date.now() }
      }
      json(res, 200, { ok: true, config: snapshotConfig() })
    })
  }

  /**
   * 挂载名单的增删查。
   *
   * `GET` 列名单；`POST {dir, synthetic}` 挂一个；`POST {remove}` 卸一个。
   *
   * ⚠ 这是本插件唯一一个**接受任意路径**的入口。它只做两件事：`FixedWidthLog`
   * 读那个目录、以及把路径记进本库自己的名单文件——**被挂的目录一个字节都不写**。
   * 与面板其余端点同一个信任边界（dsh 自己的本机 webServer）。
   *
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {URLSearchParams} _query - 查询串。
   * @param {object} own - 本工作区的库（名单住在它的数据目录里）。
   * @returns {void}
   */
  function handleMounts(req, res, _query, own) {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, packs: own.mounts.list() })
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
      const result = typeof patch?.remove === 'string'
        ? own.mounts.remove(patch.remove)
        : own.mounts.add(patch?.dir, patch?.synthetic === true)
      json(res, 200, { ...result, packs: own.mounts.list() })
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
