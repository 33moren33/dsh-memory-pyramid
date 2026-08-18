/**
 * dsh-memory 前厅半边 —— 记忆金字塔面板。
 *
 * 形态（CEO 2026-08-16 定）：右下悬浮球 → 占右半屏的抽屉；上半是塔，下半是
 * 文字区（默认显示「此刻的记忆」＝当前注入给模型的视图原文，点一块切换为该块
 * 内容），右下角是开关与滑块。
 *
 * ## 视觉语言（2026-08-18 视觉稿定稿，`probe/panel-starmap-demo-260817/`）
 *
 * ⭐⭐ **三种行——摘要 / 第一层记忆 / 基底——共用同一套渲染逻辑，唯一的差别是色表。**
 * 行高、点尺寸、变形、命中测试、密到亚像素时的画法，一个字都不分岔。旧稿给底排
 * 单开了一套画法（行高 ×1.7、另一套色阶），**它看起来像地基是因为我们把它画成了
 * 地基**——而 `handoff/memory-base-260818.md` §1 已定格：LOG 是受 280 字节封顶的
 * 第一层记忆，基底是它下面那层不限字数的原料（会话原文 / md 快照），1:1 对应。
 *
 * - **颜色只编码热度，只有 5 档**；层级深度完全交给位置（层高＋块宽），不占色相。
 *   尺寸也不承载信息：基底的点与记忆层的点一样大。
 * - **分档是绝对的**，一次算好、永不随视野改变。按当前视野算分位数会让同一批数据
 *   缩得越小反而越亮——那是分档逻辑在骗人。一个像素盖多条时取**最大值**。
 * - **禁止为「块太窄画不出个体」另起一套渲染**：星模式的色带就是星点自己叠出来的。
 *   点尺寸恒定，块越窄点挨得越近，挨到重叠自然连成带。另写一套会在缩放跨阈值时突变。
 * - **选中不是换成一个平色**，而是把覆盖到的每一块统一往强端推同样的度数，块与块
 *   之间原有的热度差照样看得见。不画区域框、不画灰叠加、不画描边。
 * - **此刻注入用橘色细线包住**，不用柔光（柔光在密排的塔上看不出来）。
 * - 文字只在砖/岩出现，装不下 10 个字就一个字都不显；星模式永远不显字。
 * - **纵横两轴是对称的自由量，且不能共用一个缩放系数**：横向线性（一万条）、纵向
 *   对数（十五行），全库铺满时一条记录 0.07px 而一行 20px，差 285 倍。所以两个手势
 *   （滚轮 / Shift＋滚轮），跟火焰图同一个取舍。
 *
 * ## 诚实纪律
 *
 * 画面上每一个数都来自后厨的真返回值：亮区＝`cover()` 本尊，与模型收到的视图同源
 * 同算法；**热度＝真用量账**（`lib/heat.js`，注入/查询/打开三笔真事件），不是模拟；
 * token 数标明是字节估算，不冒充分词器。欠压缩的块画成虚线空位，不猜它的内容。
 *
 * ## 装载方式
 *
 * 照官方判例 @deepseek-ai/dsh-client-ui-trajectory：经典 <script> →
 * window.__ModuleLoader__ 注册 factory → 导出 { inject, apply }。手写纯 JS、无打包器。
 * 自建 React 根挂 document.body（官方树塌方波及不到面板），拿不到 react-dom/client
 * 时退回 shell.overlay 座位。
 */
// ⚠ id 必须＝包名：client-modules 的 bundle 路由按 "loaded without registering
// <包名> via __ModuleLoader__.load" 校验（2026-08-16 实测报错原文）。
window.__ModuleLoader__.load({
  id: 'dsh-memory-pyramid',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React
    const module = { exports: {} }

    const API = '/dsh-memory/panel'

    // ══ 配色 ════════════════════════════════════════════════════════════════
    // ⭐ 颜色**一个都不写死在用的地方**，全部集中在这里。出厂值＝视觉稿 2026-08-18
    //   逐条定的那套（全部 Radix）：
    //     记忆＝Blue Dark 4/7/8/9/11（暗）/ Blue 3/5/7/8/10（亮）
    //     框选＝Teal 同档位一一对应——换色相的区分度远大于同色板推几度
    //     基底＝blackA / whiteA 透明阶：它不是记忆，不进彩色家族
    //     基底选中＝统一朝**对比增强**的一侧推（暗往白、亮往黑）。早先按「各档 +2」
    //       做过，结果绝大多数 0 档格子只是变得更黑，在暗卡片上等于没变化。
    //     橘线＝Orange 9/10，明暗分色（亮底上 9 压不住）
    const PAL = {
      ink: {
        bg: '#111927', card: '#0d2847', ink: '#e9ebf1', ink2: '#8f95a3', ink3: '#4d525e',
        mem: ['#003362', '#205d9e', '#2870bd', '#0090ff', '#70b8ff'],
        sel: ['#023b37', '#1c6961', '#207e73', '#12a594', '#0bd8b6'],
        base: ['#0000007a', '#00000017', '#ffffff00', '#ffffff27', '#ffffff9b'],
        bsel: ['#ffffff3b', '#ffffff4f', '#ffffff64', '#ffffff9b', '#ffffffec'],
        hot: '#f76b15', memInk: '#fffffff2', baseInkHi: '#090c14eb', baseInkLo: '#f0f4faf2',
        debt: '#e8a23c', line: 'rgba(233,235,241,0.10)',
      },
      paper: {
        bg: '#fbfdff', card: '#f4faff', ink: '#0f1116', ink2: '#5d626c', ink3: '#a6aab3',
        mem: ['#e6f4fe', '#c2e5ff', '#8ec8f6', '#5eb1ef', '#0588f0'],
        sel: ['#e0f8f3', '#b8eae0', '#83cdc1', '#53b9ab', '#0d9b8a'],
        base: ['#ffffff9b', '#ffffff27', '#ffffff00', '#00000017', '#0000007a'],
        bsel: ['#0000003b', '#0000004f', '#00000064', '#0000009b', '#000000e3'],
        hot: '#ef5f00', memInk: '#090c14eb', baseInkHi: '#f0f4faf2', baseInkLo: '#090c14eb',
        debt: '#b5730a', line: 'rgba(15,17,22,0.12)',
      },
    }

    const DEF_SANS = 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif'
    const DEF_MONO = 'Consolas, "Cascadia Mono", ui-monospace, monospace'
    // ⭐ 五个用途各选各的字号，不是一个全局字号。`row` 是**与卡片、与库都无关的
    //   绝对值**：曾经默认「开局按适应卡片算一次」，于是余量恒为零、纵向平移变成
    //   死功能。26px 的取法＝够塔上文字到 16px（26×0.62），且让 15 行的万条档略微
    //   溢出——小库全塔看得见，大库要拖，这才是正常梯度。
    const TYPO = {
      tower: { f: DEF_SANS, s: 11.5 },
      axis: { f: DEF_MONO, s: 12 },
      body: { f: DEF_SANS, s: 12.5 },
      meta: { f: DEF_SANS, s: 10.5 },
      ui: { f: DEF_SANS, s: 13 },
      row: 26,
      minChars: 10,
      maxChars: 80,
      rowLabels: true,
    }

    // ══ 三层结构 ════════════════════════════════════════════════════════════
    // L = BASE(-1) 基底：会话原文 / md 快照，与第一层 1:1，**不进上下文**
    // L = 0        第一层记忆：LOG.txt 的事实行，≤280 字节
    // L = 1..      摘要层：TREE/2^L
    const BASE = -1
    const spanOf = L => (L === BASE ? 1 : (1 << L))
    const rowUp = L => (L === BASE ? 0 : L + 1)
    const AXIS_H = 22
    const GAPY = 2
    const PADX = 10
    const PADT = 10
    const MORPH_MS = 380

    /** 层的名字。按 memory-base-260818.md §1 定格，「地基/基座/原文砖」全部作废。 */
    const rowLabel = L => (L === BASE ? '基底' : `${L + 1}层`)

    /**
     * 绝对分档器：阈值一次算好，永不随视野改变。
     *
     * 注入次数跨了三个数量级（低层最大几十、高层几千），线性分档会把上半座塔全烧成
     * 同一色，所以 4 个非零档按对数等分。三种量用同一个做法。
     */
    const levelerOf = (max) => {
      const th = [1, 2, 3].map(k => Math.pow(Math.max(1, max), k / 4))
      return v => (v <= 0 ? 0 : v < th[0] ? 1 : v < th[1] ? 2 : v < th[2] ? 3 : 4)
    }
    const maxOf = a => a.reduce((m, v) => (v > m ? v : m), 1)

    /** base64 的 32 位小端数组解回数字。后厨的重包就是这么编的。 */
    function unpack(packed) {
      if (typeof packed !== 'string' || packed === '') return []
      const binary = atob(packed)
      const out = new Array(binary.length >> 2)
      for (let i = 0; i < out.length; i++) {
        const at = i * 4
        out[i] = (binary.charCodeAt(at)
          | (binary.charCodeAt(at + 1) << 8)
          | (binary.charCodeAt(at + 2) << 16)
          | (binary.charCodeAt(at + 3) << 24)) >>> 0
      }
      return out
    }

    const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v)
    const blockKey = (lo, hi) => lo + '-' + hi
    function utf8Bytes(text) {
      try { return new TextEncoder().encode(text).length } catch { return text.length * 3 }
    }
    /** 粗估：中文 3 字节≈1 字≈1 token 量级。界面上标明「字节估算」。 */
    const estimateTokens = text => Math.round(utf8Bytes(text) / 3)

    async function getJson(url, init) {
      const res = await fetch(url, init)
      return res.json()
    }

    /** 文本锚前缀，与后厨 `handoff.js` 的 HANDOFF_ANCHOR_PREFIX 同一个字面量。 */
    const SOURCE_PREFIX = 'md:'

    /**
     * 认锚 —— 一条第一层记忆的**基底**在哪。
     *
     * 两种出生册共用 sid 这一个字段，靠前缀分辨：`md:<名字>` 是架上的文本快照，
     * 其余非空值是会话 id。曾经这里只有「非空就是会话」一种解释，于是 md 导入的
     * 事实被显示成「会话 md:xxx」、按钮照亮，点下去 `sessions.open('md:xxx')`
     * **必然失败**——不是帮不上忙，是主动说错话。
     */
    function readAnchor(record) {
      const sid = (record && record.sessionId) || ''
      if (sid.slice(0, SOURCE_PREFIX.length) === SOURCE_PREFIX) {
        return { kind: 'source', name: sid.slice(SOURCE_PREFIX.length) }
      }
      return sid !== '' ? { kind: 'session', name: sid } : { kind: 'none', name: '' }
    }

    // ══ 引擎：塔的全部几何与绘制 ═════════════════════════════════════════════
    // 全部做成**吃 `e`（引擎状态）的纯函数**，不闭包 React 的东西——闭包会在
    // rAF 里拿到上一帧的旧值，而这类 bug 截图照不出来。

    /** 一条多宽 / 一块的左边缘 / 一行的顶。行从**底部**往上排。 */
    const bw = (e, L) => spanOf(L) * e.unit
    const bx = (e, L, i) => e.offX + i * spanOf(L) * e.unit
    const yOf = (e, L) => e.H + e.offY - (rowUp(L) + 1) * e.ROW - rowUp(L) * GAPY
    const countOf = (e, L) => (L === BASE ? e.T : e.COUNT[L])
    const exists = (e, L, i) => i >= 0 && i < countOf(e, L)
    const towerH = e => PADT + e.NROWS * e.ROW + (e.NROWS - 1) * GAPY
    /**
     * 纵向平移**只有下界**。下界 offY=0 ＝ 基底贴着卡片底沿，再往下就会在基底与
     * 时间轴之间露出白边，而基底必须长在轴上。上界曾经也被锁成「塔高−卡片高」，
     * 那是把「底部不能露白」写成了双向夹取，后果是塔一旦塞得进卡片余量就恒为零、
     * **纵向彻底拖不动**，而横向从来不夹。
     */
    const panYMax = e => Math.max(0, towerH(e) - PADT - e.ROW)
    const clampY = (e) => { e.offY = Math.min(panYMax(e), Math.max(0, e.offY)) }
    const plotW = e => e.W - e.PADL - PADX

    const theme = e => PAL[e.theme]
    /** 被选中块覆盖到的块：本行及以下、区间完全落在选中区间里。BASE=-1<0<1，所以直接比数。 */
    const inSel = (e, L, i) => !!e.sel && L <= e.sel.L
      && i * spanOf(L) >= e.sel.lo && (i + 1) * spanOf(L) <= e.sel.hi
    /** 这一块该填什么色：**行的种类只决定用哪张色表**，档位的算法三行同一套。 */
    function fillOf(e, L, i, lv) {
      const on = inSel(e, L, i)
      return theme(e)[L === BASE ? (on ? 'bsel' : 'base') : (on ? 'sel' : 'mem')][lv]
    }
    const selColOf = (e, L, lv) => theme(e)[L === BASE ? 'bsel' : 'sel'][lv]

    /**
     * 这一块的热度档位。颜色说的是同一件事——**这块最近有多被用到**——只是「用到」
     * 在三种行上是三种动作：摘要层＝被注入 · 第一层＝被注入 ∪ 被查询命中 · 基底＝被打开。
     *
     * ⭐ 第一层为什么要**两笔取大**，不是二选一：只用查询命中，全库没几条非零，整行
     * 落第 0 档＝最暗，画出来又是一条压在塔底的暗带——正是让人把第一层误当地基的那个
     * 观感；只用注入次数，那条几乎是平的，它说的是「库当年有多小」而不是这条有多被
     * 用到，还会把查询那几下彻底淹掉。两笔取大：注入把第一层垫到与摘要层同一个身份
     * （它本来就是记忆），查询命中再把「老记忆突然被翻出来」那几颗顶到最亮档。
     */
    function levelAt(e, L, i) {
      if (L === BASE) return e.oLevel(e.OPEN[i] || 0)
      if (L === 0) return Math.max(e.injLevel((e.INJECT[0] || [])[i] || 0), e.qLevel(e.QUERY[i] || 0))
      return e.injLevel((e.INJECT[L] || [])[i] || 0)
    }
    /** 欠压缩：这一块该有摘要却还没写。虚线空位，不猜内容。 */
    const isDebt = (e, L, i) => L > 0 && i >= (e.HAVE[L] || 0)

    const morphOf = (e, L, i, m) => ((e.sel && e.sel.L === L && e.sel.i === i) ? Math.max(m, e.selGrow) : m)
    const STAR_S = e => Math.max(3, Math.min(e.ROW * 0.62, 10))
    const radBrick = (e, w) => Math.min(6, Math.max(1.2, w * 0.20), e.ROW * 0.32)

    /**
     * 形态插值：m∈[0,1] 星→砖（尺寸与圆角一起长），m∈[1,2] 砖→岩（圆角收成直角）。
     * 三种行共用，一个字都不分岔。
     */
    function shapeOf(e, L, i, m) {
      const w = bw(e, L), hh0 = e.ROW, y = yOf(e, L)
      const S = Math.min(STAR_S(e), hh0 * 0.62)
      const cx = bx(e, L, i) + w / 2, cy = y + hh0 / 2
      const t = clamp01(m)
      const gap = Math.min(2.4, w * 0.16) * (1 - clamp01(m - 1))
      const fullW = Math.max(0.7, w - gap)
      const ww = S + (fullW - S) * t
      const hh = S + (hh0 - S) * t
      const rStar = 2, rBrick = radBrick(e, w)
      const r = (rStar + (rBrick - rStar) * t) * (1 - clamp01(m - 1))
      return { x: cx - ww / 2, y: cy - hh / 2, w: ww, h: hh, r, cx, cy, S }
    }

    /**
     * ⭐ 交互形状 ≠ 绘制形状。星点画的时候尺寸恒定（挨近了就该叠起来），但**悬停、
     * 点击、橘线这些「指着某一块」的东西，宽度必须夹回那块自己的宽度**——密层里
     * 一块的真实占地就是一条细缝，指它就该指那条缝，不能指一个胖方点。
     */
    function hitShape(e, L, i, m) {
      const g = shapeOf(e, L, i, m)
      if (m >= 0.5) return g
      const ww = Math.max(1, Math.min(g.w, bw(e, L)))
      return { ...g, x: g.cx - ww / 2, w: ww }
    }

    function roundRect(ctx, x, y, w, hh, r) {
      const rr = Math.max(0, Math.min(r, w / 2, hh / 2))
      ctx.beginPath()
      if (rr < 0.5) { ctx.rect(x, y, w, hh); return }
      ctx.moveTo(x + rr, y)
      ctx.arcTo(x + w, y, x + w, y + hh, rr)
      ctx.arcTo(x + w, y + hh, x, y + hh, rr)
      ctx.arcTo(x, y + hh, x, y, rr)
      ctx.arcTo(x, y, x + w, y, rr)
      ctx.closePath()
    }

    /** ⭐ 一个循环画完全塔：摘要层、第一层、基底走的是同一段代码。 */
    function drawTower(e, ctx) {
      ctx.clearRect(0, 0, e.W, e.H)
      if (!e.T) return
      for (let L = e.LAYERS - 1; L >= BASE; L--) drawRow(e, ctx, L, e.morph)
      drawCoverMark(e, ctx, e.morph)
      drawHover(e, ctx)
      drawRowLabels(e, ctx)
    }

    function drawRowLabels(e, ctx) {
      if (!TYPO.rowLabels) return
      // 先用卡片色把左边槽刷一遍：横向拖动时块会滑到这底下，得挡住
      ctx.fillStyle = theme(e).card
      ctx.fillRect(0, 0, e.PADL, e.H)
      const fs = TYPO.meta.s
      if (e.ROW < fs + 2) return
      ctx.save()
      ctx.font = fs + 'px ' + TYPO.meta.f
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = theme(e).ink3
      for (let L = BASE; L < e.LAYERS; L++) {
        const cy = yOf(e, L) + e.ROW / 2
        if (cy < -e.ROW || cy > e.H + e.ROW) continue
        ctx.fillText(rowLabel(L), e.PADL - 7, cy + 0.5)
      }
      ctx.restore()
    }

    function drawRow(e, ctx, L, m) {
      const w = bw(e, L), n = countOf(e, L), y = yOf(e, L)
      if (y > e.H || y + e.ROW < 0) return
      const S = Math.min(STAR_S(e), e.ROW * 0.66)

      // ⭐ 星模式的色带**就是星点自己叠出来的**，不是另一套画法：点尺寸恒定，块越窄
      // 点挨得越近，挨到重叠就自然连成一条带。所以只要块还有 0.6px 宽就老老实实一块
      // 一个点画；窄到亚像素才改走逐像素游程（此时点已经完全重叠，画出来跟真画点
      // 一模一样，只是快得多）。另写一套（比如让带高随块宽收缩）会在缩放跨阈值时突变。
      if (w < 0.6) {
        band(e, ctx, L, n, y + e.ROW / 2, S + (e.ROW - S) * clamp01(m))
        if (e.sel && e.sel.L === L && e.selGrow > 0.02 && m < 0.5) {
          const mm = Math.max(m, e.selGrow)
          const g = shapeOf(e, L, e.sel.i, mm)
          paintBlock(e, ctx, L, e.sel.i, g, mm)
        }
        return
      }
      // ⚠ 按**格子的跨度**裁剪，不能按中心点裁：放大到一格几百像素时，跨在画面边缘
      // 上的那格中心早就出界了，按中心裁会把整格连同文字一起丢掉。
      const first = Math.max(0, Math.floor((-e.offX) / w) - 1)
      const last = Math.min(n - 1, Math.ceil((e.W - e.offX) / w) + 1)
      for (let i = first; i <= last; i++) {
        const mm = morphOf(e, L, i, m)
        const g = shapeOf(e, L, i, mm)
        if (g.x > e.W || g.x + g.w < 0) continue
        paintBlock(e, ctx, L, i, g, mm)
      }
      if (m > 0.55) labelRow(e, ctx, L, first, last, m)
    }

    /**
     * 画一块。**被覆盖的块只换颜色，形状一动不动**——展开是点击那一块独有的动作，
     * 覆盖列里的块该是星点就还是星点，绝不许长成砖。
     */
    function paintBlock(e, ctx, L, i, g, mm) {
      const lv = levelAt(e, L, i)
      if (isDebt(e, L, i)) {
        // 欠压缩＝诚实的空位。虚线，不填色：这块摘要还没被写出来，猜它的内容就是编造。
        ctx.save()
        ctx.strokeStyle = theme(e).debt
        ctx.setLineDash([3, 2])
        ctx.lineWidth = 1
        roundRect(ctx, g.x + 0.5, g.y + 0.5, Math.max(1.5, g.w - 1), Math.max(1.5, g.h - 1), g.r)
        ctx.stroke()
        ctx.restore()
        return
      }
      ctx.fillStyle = fillOf(e, L, i, lv)
      roundRect(ctx, g.x, g.y, Math.max(g.w, 0.7), g.h, g.r)
      ctx.fill()
      if (mm > 0.55 && e.sel && e.sel.L === L && e.sel.i === i) drawOne(e, ctx, L, i, mm, lv)
    }

    /**
     * 一行密到分不开：逐屏幕像素取该像素**真实覆盖的那几块里最热的一块**。
     *
     * 取最大值而不是取中心那块：一个像素盖住十几条记录时，按中心取会把热点整片漏掉；
     * 档位天然有上限，所以堆多少条都不会越描越白。不铺固定网格——铺了就是条形码，
     * 那是在假装分辨率比实际高。
     */
    function band(e, ctx, L, n, cy, hh) {
      const w = bw(e, L), top = cy - hh / 2
      const xa = Math.max(e.PADL, Math.floor(bx(e, L, 0)))
      const xb = Math.min(e.W, Math.ceil(bx(e, L, n)))
      let runX = -1, runCol = ''
      for (let px = xa; px < xb; px++) {
        const lo = Math.max(0, Math.floor((px - e.offX) / w))
        const hi = Math.min(n, Math.max(lo + 1, Math.ceil((px + 1 - e.offX) / w)))
        let col = ''
        if (lo < n) {
          let best = -1, at = lo
          for (let i = lo; i < hi; i++) {
            const v = isDebt(e, L, i) ? -1 : levelAt(e, L, i)
            if (v > best) { best = v; at = i }
          }
          col = best < 0 ? '' : fillOf(e, L, at, best)
        }
        if (col === runCol) continue
        if (runX >= 0 && runCol) { ctx.fillStyle = runCol; ctx.fillRect(runX, top, px - runX, hh) }
        runX = px; runCol = col
      }
      if (runX >= 0 && runCol) { ctx.fillStyle = runCol; ctx.fillRect(runX, top, xb - runX, hh) }
    }

    /**
     * 此刻注入＝橘色细线包住（星/砖/岩三态同一条线）。柔光试过，在密排的塔上看不出来。
     * ⭐ 基底行上永远看不到这条线——原料不进上下文，这是画面自己说出来的事实
     * （`COVER` 里根本没有 L=-1 的块，不是画的时候特意躲开）。
     */
    function drawCoverMark(e, ctx, m) {
      ctx.save()
      ctx.strokeStyle = theme(e).hot
      ctx.lineWidth = 1.4
      ctx.lineJoin = 'round'
      for (const b of e.COVER) {
        const g = hitShape(e, b.L, b.i, morphOf(e, b.L, b.i, m))
        // 最小 4px，否则亚像素块上描边只剩一根竖线、看着像"没包住"
        let ww = Math.max(4, g.w), hh = Math.max(4, g.h)
        let x = g.cx - ww / 2, y = g.cy - hh / 2
        if (x > e.W + 8 || x + ww < -8) continue
        // 整像素 + 半像素对齐：不对齐时 1.4px 的描边会被反锯齿吃掉一两条边
        x = Math.round(x) + 0.5; y = Math.round(y) + 0.5
        ww = Math.max(3, Math.round(ww) - 1); hh = Math.max(3, Math.round(hh) - 1)
        // 画在内缘而不是外缘：外缘会被相邻块盖住，看起来就是缺边
        roundRect(ctx, x, y, ww, hh, Math.min(g.r, ww / 2, hh / 2))
        ctx.stroke()
      }
      ctx.restore()
    }

    /** 悬停不画方框：只把光标压着的那一块本身提色（星模式下就是那个点）。 */
    function drawHover(e, ctx) {
      if (!e.hover) return
      const g = hitShape(e, e.hover.L, e.hover.i, morphOf(e, e.hover.L, e.hover.i, e.morph))
      ctx.save()
      ctx.globalAlpha = 0.72
      ctx.fillStyle = selColOf(e, e.hover.L, levelAt(e, e.hover.L, e.hover.i))
      // 密层里一块只有零点几像素宽，兜到 2px 才看得见（形状仍是那条缝，不是胖方点）
      const vw = Math.max(2, g.w)
      roundRect(ctx, g.cx - vw / 2, g.cy - g.h / 2, vw, g.h, Math.min(g.r, vw / 2))
      ctx.fill()
      ctx.restore()
    }

    /**
     * 能塞几个字，按这块**在画面里的实际可见跨度**算，不按整块宽算。
     * 按整块宽算：块跨出视口时字数虚高、尾巴被硬截；按「必须整块在画面内」算：
     * 贴着左右边缘的块干脆一个字都不画（那正是踩过的 bug）。
     */
    function fitChars(e, x, w, per) {
      const vis = Math.min(x + w, e.W) - Math.max(x, e.PADL)
      return Math.min(TYPO.maxChars, Math.floor((vis - 12) / per))
    }
    const towerFs = e => Math.min(TYPO.tower.s, e.ROW * 0.62)

    /**
     * 记忆层文字：暗模式统一白、亮模式统一黑。基底是黑白阶、从暗于卡片一路走到亮于
     * 卡片，所以它的文字必须跟着格子明暗翻。
     */
    function inkOf(e, L, lv) {
      if (L !== BASE) return theme(e).memInk
      const bright = e.theme === 'ink' ? lv >= 3 : lv <= 2
      return theme(e)[bright ? 'baseInkHi' : 'baseInkLo']
    }

    function drawOne(e, ctx, L, i, m, lv) {
      const w = bw(e, L), y = yOf(e, L), a = clamp01((m - 0.55) / 0.45)
      if (a <= 0.01 || e.ROW < 12) return
      const fs = towerFs(e), per = fs * 0.98          // 中文按全宽估
      const x = bx(e, L, i)
      const room = fitChars(e, x, w, per)
      if (room < TYPO.minChars) return
      const raw = e.textOf(L, i)
      if (typeof raw !== 'string' || raw === '') return
      const s = raw.replace(/\s+/g, ' ')
      ctx.save()
      ctx.globalAlpha = a
      ctx.font = fs.toFixed(1) + 'px ' + TYPO.tower.f
      ctx.textBaseline = 'middle'
      ctx.fillStyle = inkOf(e, L, lv)
      ctx.beginPath(); ctx.rect(x + 4, y, w - 9, e.ROW); ctx.clip()
      // 块比视口宽时文字贴视口左缘，否则整段字被推到屏幕外面去了
      ctx.fillText(s.length <= room ? s : s.slice(0, room - 1) + '…', Math.max(x + 5, e.PADL + 5), y + e.ROW / 2 + 0.5)
      ctx.restore()
    }

    function labelRow(e, ctx, L, first, last, m) {
      const w = bw(e, L)
      if (e.ROW < 12) return
      const per = towerFs(e) * 0.98
      if (Math.floor((Math.min(w, e.W) - 12) / per) < TYPO.minChars) return
      for (let i = first; i <= last; i++) {
        const x = bx(e, L, i)
        if (x > e.W || x + w < 0) continue
        if (isDebt(e, L, i)) continue
        drawOne(e, ctx, L, i, m, levelAt(e, L, i))
      }
    }

    // ── 时间轴：同屏最多两级，绝不出现「25年4月18日」──────────────────────────
    // 轴上**不存在插值**：刻度只画在真实记录的位置上。一条记录是一个时刻不是一段
    // 时长，插值撒出的刻度不对应任何真实事件。第一层与基底 1:1，所以两行共用同一根轴。
    // 副作用是好的：刻度的疏密本身就是使用强度，没有记录的月份轴上一根刻度都没有。
    const DAY = 86400000
    function drawAxis(e, g, axisW) {
      g.clearRect(0, 0, axisW, AXIS_H)
      if (!e.T || !e.TIMES.length) return
      const iLo = Math.max(0, Math.min(e.T - 1, Math.floor((0 - e.offX) / e.unit)))
      const iHi = Math.max(0, Math.min(e.T - 1, Math.ceil((e.W - e.offX) / e.unit)))
      const t0 = e.TIMES[iLo], t1 = e.TIMES[iHi]
      if (!(t1 > t0)) return

      g.save()
      g.font = TYPO.axis.s + 'px ' + TYPO.axis.f
      g.textBaseline = 'top'
      const dark = e.theme === 'ink'
      const inkA = a => (dark ? `rgba(233,235,241,${a})` : `rgba(15,17,22,${a})`)
      // 轴只画在塔的净宽里：左边那条槽是纵轴层标签的地盘，那里没有塔，
      // 画了刻度就是在给不存在的位置标时间。
      g.beginPath(); g.rect(e.PADL, 0, axisW - e.PADL, AXIS_H); g.clip()
      g.fillStyle = inkA(dark ? 0.55 : 0.45)
      g.fillRect(e.PADL, 0, axisW - e.PADL, 1)

      const days = (t1 - t0) / DAY
      const hours = (t1 - t0) / 3600000
      const mins = (t1 - t0) / 60000
      const bucket = days > 55 ? 'month' : days > 1.6 ? 'day'
        : hours >= 2.5 ? 'hour' : mins >= 2.5 ? 'minute' : 'second'
      const fa = Math.max(0, Math.floor((-e.offX) / e.unit) - 1)
      const fb = Math.min(e.T - 1, Math.ceil((axisW - e.offX) / e.unit) + 1)
      // 秒档：同一秒里可能不止一条记录。撞了不能只画一条——那会把真实存在的记录
      // 藏起来。先数一遍，撞的加 [n] 区分。
      const secCount = new Map()
      if (bucket === 'second') {
        for (let i = fa; i <= fb; i++) {
          const k = Math.floor(e.TIMES[i] / 1000)
          secCount.set(k, (secCount.get(k) || 0) + 1)
        }
      }
      const secSeen = new Map()
      const marks = []
      let prevKey = null, prevUp = null
      for (let i = fa; i <= fb; i++) {
        const d = new Date(e.TIMES[i])
        const Y = d.getFullYear(), M = d.getMonth(), Dd = d.getDate()
        const Hh = d.getHours(), Mi = d.getMinutes(), Se = d.getSeconds()
        const key = bucket === 'month' ? `${Y}/${M}`
          : bucket === 'day' ? `${Y}/${M}/${Dd}`
            : bucket === 'hour' ? `${Y}/${M}/${Dd}/${Hh}`
              : bucket === 'minute' ? `${Y}/${M}/${Dd}/${Hh}/${Mi}`
                : `rec${i}`
        if (key === prevKey) continue
        prevKey = key
        const up = bucket === 'month' ? Y : bucket === 'day' ? M
          : bucket === 'hour' ? Dd : bucket === 'minute' ? Hh : Mi
        const big = prevUp !== null && up !== prevUp
        // 大刻度**一律两两成对**，四档无例外：只标上一级会把下一级吞掉，于是出现
        // 「26号 … 2号」中间凭空跨月、或者跨天那条看不出是第几时。
        let text = bucket === 'month' ? (big ? `${Y % 100}年${M + 1}月` : `${M + 1}月`)
          : bucket === 'day' ? (big ? `${M + 1}月${Dd}号` : `${Dd}号`)
            : bucket === 'hour' ? (big ? `${Dd}号${Hh}时` : `${Hh}时`)
              : bucket === 'minute' ? (big ? `${Hh}时${Mi}分` : `${Mi}分`)
                : (big ? `${Mi}分${Se}秒` : `${Se}秒`)
        if (bucket === 'second') {
          const k = Math.floor(e.TIMES[i] / 1000)
          if (secCount.get(k) > 1) {
            const n = (secSeen.get(k) || 0) + 1
            secSeen.set(k, n)
            text += '[' + n + ']'
          }
        }
        prevUp = up
        // 刻度对齐格子**中心**，正好落在那条记录的星点下面
        marks.push({ x: bx(e, 0, i) + e.unit / 2, s: text, big })
      }

      const vis = marks.filter(k => k.x >= -20 && k.x <= axisW + 20)
      const inkOfMark = big => inkA(big ? (dark ? 0.80 : 0.75) : (dark ? 0.52 : 0.42))
      // 每个刻度都留一根线（那个位置确实有记录），字才抽稀
      for (const mk of vis) { g.fillStyle = inkOfMark(mk.big); g.fillRect(mk.x, 1, 1, 5) }
      // ⭐ 大刻度先占位，且绝不被抽掉——它是跨月/跨天/跨时的唯一线索，掉了就会出现
      // 「26号 … 2号」中间凭空跨了个月却没人告诉你。
      const placed = []
      const far = (x, gap) => placed.every(px => Math.abs(px - x) >= gap)
      for (const mk of vis) {
        if (mk.big && far(mk.x, 26)) { placed.push(mk.x); g.fillStyle = inkOfMark(true); g.fillText(mk.s, mk.x + 4, 7) }
      }
      for (const mk of vis) {
        if (!mk.big && far(mk.x, 62)) { placed.push(mk.x); g.fillStyle = inkOfMark(false); g.fillText(mk.s, mk.x + 4, 7) }
      }
      g.restore()
    }

    /**
     * 命中测试：位置即身份，纯算术。
     * 打在**画出来的那个形状**上，不是打在整行上——星模式点星点之外＝空白，
     * 砖/岩点方块周围＝空白，都判定为取消。
     */
    function pickAt(e, px, py) {
      if (px < e.PADL || !e.T) return null
      for (let L = BASE; L < e.LAYERS; L++) {
        const y = yOf(e, L)
        if (py < y - 2 || py > y + e.ROW + 2) continue
        const i = Math.floor((px - e.offX) / bw(e, L))
        if (!exists(e, L, i)) return null
        const g = hitShape(e, L, i, morphOf(e, L, i, e.morph))
        // 亚像素块的形状比手指细，给一点点容差，否则永远点不中
        const padX = Math.max(0, (3 - g.w) / 2), padY = Math.max(0, (3 - g.h) / 2)
        if (px < g.cx - g.w / 2 - padX || px > g.cx + g.w / 2 + padX) return null
        if (py < g.cy - g.h / 2 - padY || py > g.cy + g.h / 2 + padY) return null
        return { L, i, lo: i * spanOf(L), hi: Math.min(e.T, (i + 1) * spanOf(L)) }
      }
      return null
    }

    /** 把后厨的两份返回值装成引擎认识的样子。换库＝这一批量全部重算。 */
    function loadWorld(e, state, bulk) {
      const total = state ? state.total : 0
      e.T = total
      e.COUNT = []
      e.HAVE = []
      for (let size = 1, L = 0; size <= Math.max(1, total); size *= 2, L++) {
        e.COUNT[L] = size === 1 ? total : Math.floor(total / size)
        e.HAVE[L] = size === 1 ? total : ((state && state.levels[size]) || 0)
      }
      // 只有一条记录时也得有第一层
      if (e.COUNT.length === 0) { e.COUNT = [total]; e.HAVE = [total] }
      e.LAYERS = e.COUNT.length
      e.NROWS = e.LAYERS + 1                       // 摘要 + 第一层 + 基底
      e.TIMES = (bulk ? unpack(bulk.times) : []).map(s => s * 1000)
      e.QUERY = bulk ? unpack(bulk.query) : []
      e.OPEN = bulk ? unpack(bulk.open) : []
      e.INJECT = []
      for (let size = 1, L = 0; L < e.LAYERS; size *= 2, L++) {
        e.INJECT[L] = bulk && bulk.inject ? unpack(bulk.inject[size]) : []
      }
      e.injLevel = levelerOf(e.INJECT.reduce((m, a) => Math.max(m, maxOf(a)), 1))
      e.qLevel = levelerOf(maxOf(e.QUERY))
      e.oLevel = levelerOf(maxOf(e.OPEN))
      // 亮区＝cover 本尊。基底不参与注入，所以这里只会有 L>=0 的块。
      e.COVER = ((state && state.wake.blocks) || []).map(([lo, hi]) => {
        const L = Math.log2(hi - lo)
        return { L, i: lo / (hi - lo), lo, hi }
      }).filter(b => Number.isInteger(b.L) && b.L < e.LAYERS && exists(e, b.L, b.i))
    }

    // ══ 主组件 ══════════════════════════════════════════════════════════════
    function MemoryPanel(props) {
      const [open, setOpen] = useState(false)
      const [state, setState] = useState(null)     // /state 的最近一次返回
      const [cfg, setCfg] = useState(null)         // 本地正在编辑的配置（滑块的即时值）
      const [sel, setSel] = useState(null)         // 选中块 {L, i, lo, hi}
      const [source, setSource] = useState(null)   // 正在看的基底快照
      const [msg, setMsg] = useState('')
      const [, bump] = useState(0)                 // 文本到货后重画下栏
      const [theme, setTheme] = useState('ink')
      const [mode, setMode] = useState(0)          // 0 星 / 1 砖 / 2 岩
      const [pack, setPack] = useState('')         // '' ＝ 本库；其余＝只读挂上来的参照库
      const [ballPos, setBallPos] = useState(null)
      const ballDrag = useRef(null)

      const cvRef = useRef(null)
      const axRef = useRef(null)
      const wrapRef = useRef(null)
      const dragRef = useRef(null)
      const postTimer = useRef(null)
      const texts = useRef(new Map())
      const inflight = useRef(new Set())
      const fitted = useRef('')

      /**
       * 引擎状态。**只放在 ref 里，不进 React state**：每帧都在变的量走 state 会
       * 让整棵树跟着重渲染，而画布本来就是自己重画的。
       */
      const e = useRef({
        W: 0, H: 0, dpr: 1, unit: 0, offX: 0, offY: 0, ROW: TYPO.row, PADL: PADX,
        T: 0, COUNT: [0], HAVE: [0], LAYERS: 1, NROWS: 2,
        TIMES: [], QUERY: [], OPEN: [], INJECT: [], COVER: [],
        injLevel: () => 0, qLevel: () => 0, oLevel: () => 0,
        morph: 0, morphFrom: 0, morphTo: 0, morphT0: 0,
        selGrow: 0, selFrom: 0, selTo: 0, selT0: 0,
        sel: null, hover: null, theme: 'ink',
        textOf: () => '',
      }).current

      // 塔上文字从懒取的缓存里拿。没到货就不画——不猜、不占位。
      e.textOf = useCallback((L, i) => {
        if (L === BASE) return ''                  // 基底正文在后厨的会话/架子里，点开才取
        const span = spanOf(L)
        const cached = texts.current.get(blockKey(i * span, Math.min(e.T, (i + 1) * span)))
        return cached && typeof cached.text === 'string' ? cached.text : ''
      }, [e])

      const kick = useCallback(() => {
        const canvas = cvRef.current, axis = axRef.current
        if (!canvas || !axis) return
        const ctx = canvas.getContext('2d')
        const axg = axis.getContext('2d')
        drawTower(e, ctx)
        drawAxis(e, axg, axis.width / e.dpr)
      }, [e])

      // ── 取数 ──
      const qs = useCallback(sep => (pack === '' ? '' : sep + 'pack=' + encodeURIComponent(pack)), [pack])
      const refresh = useCallback(async () => {
        try {
          const data = await getJson(API + '/state' + qs('?'))
          if (data && data.ok) {
            setState(data)
            setCfg(prev => (prev === null ? data.config : { ...data.config, wakeLines: prev.wakeLines, noteBytes: prev.noteBytes, liveView: data.config.liveView }))
          }
        } catch { /* 后厨不在（如插件半装）——面板保持上次画面，不编造 */ }
      }, [qs])

      /**
       * 重包（真用量 + 时间戳）。**不跟着 3 秒轮询走**：它是每格一个数，万条库约
       * 2 万格，跟着轮询就是一个定时的几十 KB 下载。只在开面板与总数变化时取。
       */
      const bulkRef = useRef(null)
      const bulkTag = useRef('')
      const loadBulk = useCallback(async (total) => {
        const tag = pack + ':' + total
        if (bulkTag.current === tag) return
        bulkTag.current = tag
        try {
          const data = await getJson(API + '/heat' + qs('?'))
          if (data && data.ok) { bulkRef.current = data; bump(n => n + 1) }
        } catch { /* 拿不到就全冷，不编造热度 */ }
      }, [pack, qs])

      useEffect(() => {
        if (!open) return undefined
        refresh()
        const timer = setInterval(refresh, 3000)
        return () => clearInterval(timer)
      }, [open, refresh])

      useEffect(() => {
        if (open && state) loadBulk(state.total)
      }, [open, state, loadBulk])

      // 挤压式布局（CEO 2026-08-16 定：并排不遮挡，跳转后不用来回点）：面板开着时把
      // 官方 #root 捏到 60vw，官方壳自己响应式回流；关闭复原。只动最外层容器宽度。
      useEffect(() => {
        const officialRoot = document.getElementById('root')
        if (!open || !officialRoot) return undefined
        const prev = officialRoot.style.width
        officialRoot.style.width = '60vw'
        return () => { officialRoot.style.width = prev }
      }, [open])

      // ── 尺寸与装载 ──
      const measure = useCallback(() => {
        const canvas = cvRef.current, axis = axRef.current, wrap = wrapRef.current
        if (!canvas || !axis || !wrap) return
        const r = wrap.getBoundingClientRect()
        e.dpr = window.devicePixelRatio || 1
        e.W = r.width; e.H = r.height
        canvas.width = Math.round(e.W * e.dpr); canvas.height = Math.round(e.H * e.dpr)
        canvas.getContext('2d').setTransform(e.dpr, 0, 0, e.dpr, 0, 0)
        const ar = axis.getBoundingClientRect()
        axis.width = Math.round(ar.width * e.dpr); axis.height = Math.round(AXIS_H * e.dpr)
        axis.getContext('2d').setTransform(e.dpr, 0, 0, e.dpr, 0, 0)
        // 左边槽宽＝最宽标签实测 + 两边留白，不写死（层数多了会有「13层」）
        if (TYPO.rowLabels) {
          const ctx = canvas.getContext('2d')
          ctx.font = TYPO.meta.s + 'px ' + TYPO.meta.f
          let wide = 0
          for (let L = BASE; L < e.LAYERS; L++) wide = Math.max(wide, ctx.measureText(rowLabel(L)).width)
          e.PADL = Math.ceil(wide) + 12
        } else e.PADL = PADX
        clampY(e)
        kick()
      }, [e, kick])

      useEffect(() => {
        if (!open) return undefined
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [open, measure])

      // 数据到货：装进引擎，必要时整塔取景
      useEffect(() => {
        if (!open || !state) return
        e.theme = theme
        loadWorld(e, state, bulkRef.current)
        const tag = state.total + ':' + Math.round(e.W)
        if (fitted.current !== tag && state.total > 0 && e.W > 0) {
          fitted.current = tag
          e.unit = plotW(e) / state.total
          e.offX = e.PADL
          e.offY = 0
        }
        measure()
      }, [open, state, theme, e, measure])

      // 形态与展开的缓动。⚠ 只在真的在动时才排下一帧，别让面板空转烧 CPU。
      const animRef = useRef(0)
      const animate = useCallback(() => {
        const now = performance.now()
        let moving = false
        if (e.morph !== e.morphTo) {
          const t = clamp01((now - e.morphT0) / MORPH_MS)
          const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
          e.morph = e.morphFrom + (e.morphTo - e.morphFrom) * k
          if (t >= 1) e.morph = e.morphTo
          moving = true
        }
        if (e.selGrow !== e.selTo) {
          const t = clamp01((now - e.selT0) / MORPH_MS)
          e.selGrow = e.selFrom + (e.selTo - e.selFrom) * t
          if (t >= 1) e.selGrow = e.selTo
          moving = true
        }
        kick()
        animRef.current = moving ? requestAnimationFrame(animate) : 0
      }, [e, kick])
      const startAnim = useCallback(() => {
        if (animRef.current === 0) animRef.current = requestAnimationFrame(animate)
      }, [animate])
      useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current) }, [])

      useEffect(() => {
        e.morphFrom = e.morph; e.morphTo = mode; e.morphT0 = performance.now()
        startAnim()
      }, [mode, e, startAnim])

      // 选中：星模式下被点的那一块自己展开成砖
      useEffect(() => {
        e.sel = sel
        e.selFrom = e.selGrow
        e.selTo = sel ? 1 : 0
        e.selT0 = performance.now()
        startAnim()
      }, [sel, e, startAnim])

      // ── 懒取正文：可见的砖 + 选中的那一块 ──
      useEffect(() => {
        if (!open || !state) return
        const want = []
        // 基底那一格也取同一条事实：基底的正文不在记忆库里，但**锚在事实行上**
        // ——要知道这一格该跳会话还是开快照，得先把那条事实读回来。
        if (sel) want.push([sel.lo, sel.hi])
        if (e.morph > 0.55) {
          for (let L = 0; L < e.LAYERS; L++) {
            const w = bw(e, L)
            if (w < 40) continue                       // 画不下字就不必取
            const first = Math.max(0, Math.floor((-e.offX) / w))
            const last = Math.min(countOf(e, L) - 1, Math.ceil((e.W - e.offX) / w))
            for (let i = first; i <= last && want.length < 80; i++) {
              if (isDebt(e, L, i)) continue
              want.push([i * spanOf(L), Math.min(e.T, (i + 1) * spanOf(L))])
            }
          }
        }
        let alive = true
        for (const [lo, hi] of want) {
          const key = blockKey(lo, hi)
          if (texts.current.has(key) || inflight.current.has(key)) continue
          inflight.current.add(key)
          getJson(`${API}/block?lo=${lo}&hi=${hi}${qs('&')}`).then((data) => {
            inflight.current.delete(key)
            if (!alive || !data || !data.ok) return
            texts.current.set(key, data.raw
              ? { raw: true, text: data.record ? data.record.text : '', record: data.record }
              : { raw: false, text: data.text, debt: data.debt })
            bump(n => n + 1)
            kick()
          }).catch(() => { inflight.current.delete(key) })
        }
        return () => { alive = false }
      }, [open, state, sel, e, kick, qs])

      // ── 聚光灯跟随：模型（或外部脚本）指过哪块，画面就带过去并选中 ──
      const lastSpotAt = useRef(0)
      useEffect(() => {
        const spot = state && state.spotlight
        if (!open || !spot || !(spot.at > lastSpotAt.current) || e.W === 0) return
        lastSpotAt.current = spot.at
        const span = spot.hi - spot.lo
        const aligned = span > 0 && Number.isInteger(Math.log2(span)) && spot.lo % span === 0
        if (aligned) setSel({ L: Math.log2(span), i: spot.lo / span, lo: spot.lo, hi: spot.hi })
        // 取景：让该块占画布宽的约六成、居中
        const unit = Math.max(1e-4, (plotW(e) * 0.6) / span)
        e.unit = unit
        e.offX = e.PADL + plotW(e) * 0.5 - (spot.lo + span / 2) * unit
        kick()
      }, [open, state, e, kick])

      // ── 滚轮：横向缩放；Shift＋滚轮：纵向行高 ──
      // ⚠ 走 ref 直挂原生监听而不是 React onWheel：①非被动才能 preventDefault 拦住
      //   页面滚动；②事件坐标必须在 setState 回调之外读完——React 18 批处理后事件
      //   对象已被清理（2026-08-16 实测 onWheel 静默不动的根因群）。
      useEffect(() => {
        const el = wrapRef.current
        if (!open || !el) return undefined
        const handler = (event) => {
          event.preventDefault()
          const rect = el.getBoundingClientRect()
          if (event.shiftKey) {
            // 纵向：行高。两轴不共用系数——横向线性、纵向对数，差两个数量级。
            const cy = event.clientY - rect.top
            const before = (e.H + e.offY - cy) / e.ROW
            e.ROW = Math.min(80, Math.max(2, e.ROW * Math.exp(-event.deltaY * 0.0012)))
            e.offY = cy - e.H + before * e.ROW
            clampY(e)
          } else {
            const cx = event.clientX - rect.left
            const at = (cx - e.offX) / e.unit
            const min = plotW(e) / Math.max(1, e.T) * 0.9   // 缩不过整塔视图
            const max = plotW(e)                            // 放大到一条正好占满画布宽
            e.unit = Math.min(max, Math.max(min, e.unit * Math.exp(-event.deltaY * 0.0012)))
            e.offX = cx - at * e.unit
          }
          kick()
        }
        el.addEventListener('wheel', handler, { passive: false })
        return () => el.removeEventListener('wheel', handler)
      }, [open, e, kick])

      // ── 平移：中键 / 空格＋左键。左键只管点选。 ──
      // ⚠ 不做 setPointerCapture：一捕获，松手后的 click 全落在画布上，块永远收不到
      //   点击（CEO 真机复现「点砖文字不更新」的根因）。
      const spaceHeld = useRef(false)
      const hoverDrawer = useRef(false)
      const suppressClick = useRef(false)
      useEffect(() => {
        if (!open) return undefined
        const editable = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        const down = (event) => {
          if (event.code !== 'Space' || editable(event.target)) return
          spaceHeld.current = true
          if (hoverDrawer.current) event.preventDefault()
        }
        const up = (event) => { if (event.code === 'Space') spaceHeld.current = false }
        window.addEventListener('keydown', down, true)
        window.addEventListener('keyup', up, true)
        return () => {
          spaceHeld.current = false
          window.removeEventListener('keydown', down, true)
          window.removeEventListener('keyup', up, true)
        }
      }, [open])

      const onPointerDown = useCallback((event) => {
        if (event.button === 1 || (event.button === 0 && spaceHeld.current)) {
          event.preventDefault()
          dragRef.current = { lx: event.clientX, ly: event.clientY, moved: false }
        }
      }, [])
      const onPointerMove = useCallback((event) => {
        const rect = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null
        const drag = dragRef.current
        if (drag) {
          const dx = event.clientX - drag.lx
          const dy = event.clientY - drag.ly
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
          drag.moved = true
          drag.lx = event.clientX
          drag.ly = event.clientY
          e.offX += dx
          e.offY -= dy
          clampY(e)
          kick()
          return
        }
        if (!rect) return
        const hit = pickAt(e, event.clientX - rect.left, event.clientY - rect.top)
        const changed = (hit ? hit.L + ':' + hit.i : '') !== (e.hover ? e.hover.L + ':' + e.hover.i : '')
        if (changed) { e.hover = hit; kick() }
      }, [e, kick])
      const onPointerUp = useCallback(() => {
        if (dragRef.current && dragRef.current.moved) {
          suppressClick.current = true
          setTimeout(() => { suppressClick.current = false }, 0)
        }
        dragRef.current = null
      }, [])
      const onPointerLeave = useCallback(() => {
        dragRef.current = null
        if (e.hover) { e.hover = null; kick() }
      }, [e, kick])

      const onCanvasClick = useCallback((event) => {
        if (suppressClick.current) return
        const rect = wrapRef.current.getBoundingClientRect()
        const hit = pickAt(e, event.clientX - rect.left, event.clientY - rect.top)
        setSource(null)
        setMsg('')
        setSel(hit)                                  // 点空白＝取消
      }, [e])
      const onCanvasDouble = useCallback(() => { setMode(m => (m + 1) % 3) }, [])

      /**
       * 换库。换的不只是数据量，是**塔的形状**——层数＝log2(条数)+2，70 条 7 行、
       * 一万条 15 行，连 `cover()` 的行为都不一样。所以缓存、选中、取景一律清零重来，
       * 跟后厨换了一个库没有区别。
       */
      const switchPack = useCallback((name) => {
        texts.current.clear()
        inflight.current.clear()
        bulkRef.current = null
        bulkTag.current = ''
        fitted.current = ''
        e.hover = null
        setSel(null)
        setSource(null)
        setMsg('')
        setPack(name)
      }, [e])

      // ── 配置 ──
      const postConfig = useCallback(async (patch) => {
        try {
          const data = await getJson(API + '/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (data && data.ok) setCfg(data.config)
        } catch { /* 后厨不在，保持本地值 */ }
      }, [])
      const slide = useCallback((patch) => {
        setCfg(prev => (prev === null ? prev : { ...prev, ...patch }))
        if (postTimer.current) clearTimeout(postTimer.current)
        postTimer.current = setTimeout(() => postConfig(patch), 350)
      }, [postConfig])

      // ── 跳转下钻两级：①官方正门 sessions.open ②事件史 id 对接 → 框选整轮。
      //    任何一步失败都如实收在「已打开会话、未定位」，不装样。 ──
      const jump = useCallback((record) => {
        let sessions
        try { sessions = props.ctx && typeof props.ctx.get === 'function' ? props.ctx.get('sessions') : undefined } catch { sessions = undefined }
        if (!sessions || typeof sessions.open !== 'function') {
          setMsg('拿不到官方 sessions 服务，无法跳转。')
          return
        }
        try {
          sessions.open(record.sessionId)
        } catch (error) {
          setMsg('打开会话失败（可能不在本实例）：' + String((error && error.message) || error))
          return
        }
        setMsg('')
        toast('已打开会话，正在定位 seq ' + record.seqLo + '→' + record.seqHi + ' …')
        locateInSession(sessions, record).then(result => toast(result))
      }, [props.ctx])

      // ── 另一种基底：架上的文本快照。整份原文就在后厨的架子上，取回来铺在文字区。 ──
      const openSource = useCallback(async (name, fact) => {
        setMsg('')
        try {
          const data = await getJson(`${API}/source?name=${encodeURIComponent(name)}&fact=${fact}${qs('&')}`)
          if (data && data.ok) setSource(data)
          else setMsg(data && data.error ? data.error : '取不到这份快照。')
        } catch {
          setMsg('后厨没有应答，取不到这份快照。')
        }
      }, [qs])

      // ── 悬浮球：可拖拽，松手吸附到最近的左右屏缘；没拖动就当点击开关抽屉 ──
      const currentBallPx = () => (ballPos !== null
        ? ballPos
        : { x: window.innerWidth - 22 - 46, y: window.innerHeight - 118 - 46 })
      const onBallDown = (event) => {
        ballDrag.current = { sx: event.clientX, sy: event.clientY, start: currentBallPx(), moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      const onBallMove = (event) => {
        const drag = ballDrag.current
        if (!drag) return
        const dx = event.clientX - drag.sx
        const dy = event.clientY - drag.sy
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
        drag.moved = true
        setBallPos({ x: drag.start.x + dx, y: drag.start.y + dy })
      }
      const onBallUp = () => {
        const drag = ballDrag.current
        ballDrag.current = null
        if (!drag) return
        if (!drag.moved) { setOpen(o => !o); return }
        setBallPos((pos) => {
          const p = pos || currentBallPx()
          const snapX = p.x + 23 < window.innerWidth / 2 ? 16 : window.innerWidth - 46 - 16
          const y = Math.min(window.innerHeight - 62, Math.max(16, p.y))
          return { x: snapX, y }
        })
      }
      const ball = h('div', {
        onPointerDown: onBallDown,
        onPointerMove: onBallMove,
        onPointerUp: onBallUp,
        title: '记忆金字塔（可拖动）',
        style: {
          position: 'fixed',
          ...(ballPos !== null ? { left: ballPos.x, top: ballPos.y } : { right: 22, bottom: 118 }),
          width: 46, height: 46, touchAction: 'none',
          borderRadius: '50%', cursor: 'pointer', pointerEvents: 'auto', zIndex: 2147482000,
          background: 'linear-gradient(135deg,#5b7cff,#3450e0)',
          boxShadow: '0 4px 14px rgba(52,80,224,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
      }, h('svg', { width: 22, height: 20, viewBox: '0 0 22 20', style: { pointerEvents: 'none' } },
        h('rect', { x: 8, y: 1, width: 6, height: 4.5, rx: 1, fill: '#fff', opacity: 0.95 }),
        h('rect', { x: 4.5, y: 7.5, width: 13, height: 4.5, rx: 1, fill: '#fff', opacity: 0.8 }),
        h('rect', { x: 1, y: 14, width: 20, height: 4.5, rx: 1, fill: '#fff', opacity: 0.65 })))

      if (!open) return h(React.Fragment, null, ball)

      const P = PAL[theme]
      const wakeText = state ? state.wake.text : ''
      // 基底那一格与它对应的第一层记忆是同一个 [lo,hi)＝[i,i+1)，所以取同一份缓存。
      const selData = sel ? texts.current.get(blockKey(sel.lo, sel.hi)) : undefined
      const btn = (primary, extra) => ({
        border: '1px solid ' + (primary ? P.hot : P.line),
        background: primary ? 'transparent' : 'transparent',
        color: primary ? P.hot : P.ink2,
        borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer',
        fontFamily: TYPO.ui.f, ...extra,
      })

      /** 选中那一块此刻该说什么。三种行三种身份，绝不混着说。 */
      function selTitle() {
        if (!sel) return '此刻的记忆（注入视图原文）'
        if (sel.L === BASE) {
          const record = texts.current.get(blockKey(sel.lo, sel.hi))
          const anchor = record && record.record ? readAnchor(record.record) : { kind: 'none' }
          return anchor.kind === 'source' ? '基底 · md 快照' : anchor.kind === 'session' ? '基底 · 会话原文' : '基底 · 无出处指针'
        }
        return sel.L === 0 ? 'LOG · 第一层记忆' : 'TREE/' + spanOf(sel.L) + ' · 摘要'
      }
      /** 这一块的真用量。两个数分开报，不合成一个「热度」糊过去。 */
      function selHeat() {
        if (!sel || !bulkRef.current) return ''
        const sum = (a, lo, hi) => { let s = 0; for (let k = lo; k < hi; k++) s += (a[k] || 0); return s }
        if (sel.L === BASE) return sum(e.OPEN, sel.lo, sel.hi) + ' 次打开'
        if (sel.L === 0) {
          return ((e.INJECT[0] || [])[sel.i] || 0) + ' 次注入 · ' + sum(e.QUERY, sel.lo, sel.hi) + ' 次查询命中'
        }
        return ((e.INJECT[sel.L] || [])[sel.i] || 0) + ' 次注入'
      }

      const selRecord = selData && selData.record ? selData.record : undefined
      const anchor = selRecord ? readAnchor(selRecord) : { kind: 'none', name: '' }

      const drawer = h('div', {
        onMouseEnter: () => { hoverDrawer.current = true },
        onMouseLeave: () => { hoverDrawer.current = false },
        style: {
          position: 'fixed', top: 0, right: 0, bottom: 0, width: '40vw', minWidth: 420,
          background: P.bg, color: P.ink, borderLeft: '1px solid ' + P.line,
          display: 'flex', flexDirection: 'column', pointerEvents: 'auto', zIndex: 2147481000,
          fontFamily: TYPO.ui.f, fontSize: TYPO.ui.s,
        },
      },
        // 头
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid ' + P.line } },
          h('b', null, '记忆金字塔'),
          h('span', { style: { color: P.ink2, fontSize: 12 } },
            state ? (state.total + ' 条事实 · 欠压缩 ' + state.pendingCount + ' 块') : '连接后厨…'),
          // 参照库切换。⚠ 只在真的挂了参照库时才出现——没挂就不该有这一排钮。
          ...(state && state.packs && state.packs.length > 0
            ? [h('span', { key: 'sep', style: { color: P.ink3, fontSize: 11 } }, '库'),
              h('button', {
                key: 'own',
                onClick: () => switchPack(''),
                style: btn(pack === ''),
                title: '你自己的记忆库',
              }, '本库'),
              ...state.packs.map(p => h('button', {
                key: p.name,
                onClick: () => switchPack(p.name),
                style: btn(pack === p.name),
                title: p.name + '：' + p.total + ' 条（只读参照，不是你的记忆）',
              }, p.total >= 1000 ? Math.round(p.total / 1000) + 'k' : String(p.total)))]
            : []),
          h('span', { style: { flex: 1 } }),
          h('button', {
            onClick: () => setMode(m => (m + 1) % 3),
            style: btn(false),
            title: '星 / 砖 / 岩 三态循环（双击画布同效）',
          }, ['星', '砖', '岩'][mode]),
          h('button', { onClick: () => setTheme(t => (t === 'ink' ? 'paper' : 'ink')), style: btn(false) }, theme === 'ink' ? '暗' : '亮'),
          h('button', {
            onClick: () => {
              if (!state || state.total === 0) return
              e.unit = plotW(e) / state.total; e.offX = e.PADL; e.offY = 0; e.ROW = TYPO.row
              measure()
            },
            style: btn(false),
            title: '整塔取景（拖丢了就按这个）',
          }, '复位'),
          h('button', { onClick: () => setOpen(false), style: btn(false) }, '关闭')),
        // ⛔ 看着别人的库时，这条**一直挂在画面上**：铁律是禁止编造未测到的数据，
        // 而「这座塔不是你的记忆」正是最容易被看漏的那一条。
        pack !== ''
          ? h('div', {
            style: {
              padding: '4px 12px', fontSize: 11.5, color: P.hot,
              borderBottom: '1px solid ' + P.line, background: 'rgba(247,107,21,0.07)',
            },
          }, '只读参照库「' + pack + '」——不是你的记忆，也没有被注入过。颜色因此一律最暗。')
          : null,
        // 塔（2/5 高）＋ 紧贴它下沿的时间轴
        h('div', { style: { height: '40%', minHeight: 180, background: P.card, position: 'relative' } },
          h('div', {
            ref: wrapRef,
            onPointerDown, onPointerMove, onPointerUp, onPointerLeave,
            onClick: onCanvasClick,
            onDoubleClick: onCanvasDouble,
            style: { position: 'absolute', inset: 0, touchAction: 'none' },
          }, h('canvas', { ref: cvRef, style: { display: 'block', width: '100%', height: '100%' } }))),
        h('canvas', { ref: axRef, style: { display: 'block', width: '100%', height: AXIS_H, background: P.bg } }),
        // 图例：只解释记忆层（基底那族色不进图例，多一族就成说明书了）
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, padding: '2px 12px 6px', fontSize: 11, color: P.ink3 } },
          h('span', null, 'Less'),
          ...P.mem.map((c, i) => h('span', { key: i, style: { width: 11, height: 11, borderRadius: 2, background: c, display: 'inline-block' } })),
          h('span', null, 'More')),
        // 文字区
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex', borderTop: '1px solid ' + P.line } },
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '8px 12px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: P.ink2, flexWrap: 'wrap' } },
              sel
                ? h(React.Fragment, null,
                  // 单条不是块：它的名字是 `#N`，与视图、与 memory_recall 的匹配面
                  // 说同一种话；`#N-N` 那种形状不存在。
                  h('b', { style: { color: P.ink } },
                    sel.hi - sel.lo === 1 ? '#' + sel.lo : '#' + sel.lo + '-' + (sel.hi - 1)),
                  h('span', null, selTitle()),
                  h('span', { style: { color: P.ink3 } }, selHeat()),
                  h('button', { onClick: () => { setSel(null); setSource(null); setMsg('') }, style: btn(false) }, '返回此刻的记忆'))
                : h('b', { style: { color: P.ink } }, '此刻的记忆（注入视图原文）')),
            h('pre', {
              style: {
                flex: 1, overflow: 'auto', margin: '6px 0 0', fontSize: TYPO.body.s, lineHeight: 1.55,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: P.ink,
                fontFamily: TYPO.body.f,
              },
            },
              source !== null
                ? sourceHeader(source) + source.text
                : sel
                  ? selBody(sel, selData, anchor)
                  : homeBody(pack, wakeText)),
            sel && selData
              ? h('div', { style: { paddingTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                // 基底那一格：会话锚跳会话，`md:` 锚开快照，无锚灰掉。三条路走同一个
                // 按钮位，说的话各不相同——够不着可以，但必须让人知道自己够不着。
                selData.raw ? sourceButton(anchor, selRecord, btn, jump, openSource, sel.lo) : null,
                source !== null
                  ? h('button', { onClick: () => setSource(null), style: btn(false) }, '返回这条记忆')
                  : null,
                typeof selData.text === 'string'
                  ? h('button', {
                    onClick: () => {
                      try {
                        navigator.clipboard.writeText(source !== null ? source.text : selData.text)
                        setMsg('已复制')
                      } catch { setMsg('剪贴板不可用') }
                    },
                    style: btn(false),
                  }, '复制文本')
                  : null,
                msg !== '' ? h('span', { style: { fontSize: 11, color: P.hot } }, msg) : null)
              : (msg !== '' ? h('div', { style: { fontSize: 11, color: P.hot, paddingTop: 4 } }, msg) : null)),
          // 右下控制角
          h('div', { style: { width: 232, borderLeft: '1px solid ' + P.line, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
            h('button', {
              onClick: () => cfg && postConfig({ liveView: !cfg.liveView }),
              style: btn(true),
              title: '冻结＝视图只在会话开局注入一次；实时＝每次写入后更新。当前会话从下一条消息起生效。',
            }, cfg ? ('视图注入：' + (cfg.liveView ? '实时' : '冻结')) : '…'),
            h('button', {
              disabled: true,
              style: btn(false, { opacity: 0.55, cursor: 'not-allowed' }),
              title: '并行（后台分身自动写记忆）尚未上线，这里先占位不冒充。',
            }, '写入：串行（并行开发中）'),
            cfg ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', null, '注入总数 ', h('b', null, String(cfg.wakeLines)), ' 行'),
              h('input', {
                type: 'range', min: 8, max: 256, step: 4, value: cfg.wakeLines,
                onChange: event => slide({ wakeLines: Number(event.target.value) }),
              })) : null,
            cfg ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', null, '每砖字节 ', h('b', null, String(cfg.noteBytes)), '（此后写入生效）'),
              h('input', {
                type: 'range', min: cfg.noteBytesMin, max: cfg.noteBytesMax, step: 1, value: cfg.noteBytes,
                onChange: event => slide({ noteBytes: Number(event.target.value) }),
              })) : null,
            h('div', { style: { marginTop: 'auto', color: P.ink2 } },
              '此刻注入 ≈ ', h('b', { style: { color: P.ink } }, String(estimateTokens(wakeText))),
              ' tok', h('div', { style: { fontSize: 10.5 } }, '（按 UTF-8 字节估算，非官方分词）')))))

      return h(React.Fragment, null, ball, drawer)
    }

    /**
     * 没选中任何一块时文字区说什么。
     *
     * 本库：模型此刻逐字看到的那份视图原文，一个字不多一个字不少。
     * 参照库：**它没有「此刻的记忆」**——注入视图说的是此刻正交给模型的那份东西，
     * 而这个库根本没被注入过。给它渲染一份就是编造一个不存在的当下。
     */
    function homeBody(pack, wakeText) {
      if (pack === '') return wakeText || ''
      return '只读参照库「' + pack + '」\n\n'
        + '它没有「此刻的记忆」可显示：注入视图指的是此刻正交给模型的那份东西，'
        + '而这个库从没被注入过。塔上的橘线是按当前预算算出来的覆盖——'
        + '**若它是你的库，开局会注入这些**。\n\n'
        + '颜色也一律最暗：用量账记的是真事件，这个库在这台机器上没有被用过。\n\n'
        + '摆它在这里，是因为 70 条与一万条的塔完全是两回事——小库时 cover() 直接把'
        + '整库原文放进上下文、摘要层一个块都用不上，橘线整整齐齐落在第一层那一排；'
        + '一万条才是那座十五层的塔。这件事光靠描述说不清，得看。'
    }

    /**
     * 选中那一块的正文。
     *
     * ⭐ 基底那一格**绝不拿第一层的正文来充数**——它们是两层东西，一条基底不限
     * 字数、住在会话日志或架子上，而第一层是从它蒸出来的那 ≤280 字节。把上面那行
     * 抄下来显示在基底格里，正是这次要修的那个病的另一种说法。基底的正文只有点开
     * 出处才拿得到，拿不到就说拿不到。
     */
    function selBody(sel, selData, anchor) {
      if (selData === undefined) return '（读取中…）'
      if (sel.L === BASE) {
        const head = anchor.kind === 'source'
          ? '这一格是 #' + sel.lo + ' 的基底：架上的文本快照 ' + anchor.name
          : anchor.kind === 'session'
            ? '这一格是 #' + sel.lo + ' 的基底：会话 ' + anchor.name
              + ' 的 seq ' + selData.record.seqLo + '→' + selData.record.seqHi + ' 那一段'
            : '这一格是 #' + sel.lo + ' 的基底，但这条记忆没有出处指针'
        const how = anchor.kind === 'none'
          ? '（写入时拿不到会话 id，也不是从架上文本导入的。够不着就是够不着。）'
          : '（原料不限字数、也不进上下文，所以不在这里铺开。按下面的按钮回到出处。）'
        return head + '\n' + how + '\n\n从它蒸出来的第一层记忆：\n' + selData.text
      }
      if (selData.debt) {
        return '（欠压缩——这块摘要还没被写出来。虚线是诚实的空位，不是丢数据：'
          + '它盖住的每一条第一层记忆都完好，逐条读得到。）'
      }
      if (selData.raw && selData.record) return factHeader(selData.record) + '\n\n' + selData.text
      return selData.text
    }

    /** 事实砖文字区的抬头：时间 + 这条记忆的出处。 */
    function factHeader(record) {
      const when = record.time.slice(0, 19).replace('T', ' ')
      const anchor = readAnchor(record)
      if (anchor.kind === 'session') {
        return when + ' · 会话 ' + anchor.name + ' · seq ' + record.seqLo + '→' + record.seqHi
      }
      if (anchor.kind === 'source') return when + ' · 出处快照 ' + anchor.name
      return when + ' · （无出处指针）'
    }

    /** 基底原文的抬头。改过的快照必须当场点破——拦不住，但不许没人知道。 */
    function sourceHeader(src) {
      return (src.tampered
        ? '注意：这份快照与入册时的指纹不符，导入之后被改过。'
          + '以下是它当前的内容，不一定是当初蒸出这条记忆的那份。\n\n'
        : '')
        + '=== ' + src.name + '（' + src.bytes + ' 字节 · 基底原文）===\n\n'
    }

    /**
     * 基底那一格的按钮。三种锚三条路，都占同一个位置：
     * 会话锚 → 开会话并框住出处区间；`md:` 锚 → 取回架上那份原文；无锚 → 灰掉。
     */
    function sourceButton(anchor, record, btn, jump, openSource, fact) {
      const h2 = React.createElement
      if (anchor.kind === 'session') {
        return h2('button', {
          onClick: () => jump(record),
          title: '用官方 sessions.open 打开来源会话，并框选这条记忆的出处区间',
          style: btn(true),
        }, '跳到源对话')
      }
      if (anchor.kind === 'source') {
        return h2('button', {
          onClick: () => openSource(anchor.name, fact),
          title: '打开这条记忆蒸馏自的那份文本快照（' + anchor.name + '）',
          style: btn(true),
        }, '打开出处原文')
      }
      return h2('button', {
        disabled: true,
        title: '这条记忆没有出处指针：写入时拿不到会话 id，也不是从架上文本导入的',
        style: btn(false, { opacity: 0.55, cursor: 'not-allowed' }),
      }, '打开出处')
    }

    /** 一条自动消失的浮动提示——跳转后可能看不见抽屉，回话不能没有着落。 */
    function toast(text) {
      const el = document.createElement('div')
      el.textContent = text
      el.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);'
        + 'background:rgba(28,37,64,0.92);color:#fff;padding:8px 16px;border-radius:8px;'
        + 'font-size:13px;z-index:2147483000;pointer-events:none;max-width:70vw'
      document.body.appendChild(el)
      setTimeout(() => el.remove(), 4500)
    }

    /**
     * 下钻二级：把目标 seq 拉进窗口并框住整轮。
     *
     * 官方没有定位 API（2026-08-16 源码探针结论），这里用的三件都是稳定契约层：
     * `binding(id).session` 与 `loadOlder()`、聊天行的官方 data 属性
     * `data-chat-anchor-key`、事件史里的真 seq。每一步拿不到就收在诚实的"未定位"，
     * 绝不假装定过位。
     */
    async function locateInSession(sessions, record) {
      const target = record.seqLo > 0 ? record.seqLo : record.seqHi
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      const deadline = Date.now() + 15000
      // 定位＝「事件史找 id → DOM 对 id」：`session.events` 是带**真 seq** 的完整事件
      // 数组；真人消息带 `data.id`、工具调用带 `data.callId`，而官方聊天行的
      // `data-chat-anchor-key` 里恰好嵌着同一个 id——两边拿 id 对接，seq 只从事件史读。
      // ⚠ 锚 key 前导数字**不是** seq（是节点序号；小会话里量级碰巧相同，曾用它蒙对过
      //   一次——判例，别改回去）。
      // ⚠ open 是异步的；DOM 里可能还留着上一个会话的行，不能拿"有行"当就绪。
      let session
      while (Date.now() < deadline) {
        try {
          const binding = typeof sessions.binding === 'function' ? sessions.binding(record.sessionId) : undefined
          session = binding && binding.session ? binding.session : undefined
        } catch { session = undefined }
        if (session && Array.isArray(session.events) && session.events.length > 0) break
        await sleep(250)
      }
      if (!session || !Array.isArray(session.events) || session.events.length === 0) {
        return '已打开会话，但读不到事件史——未定位'
      }
      const anchors = []
      for (const event of session.events) {
        if (event.type === 'user/message' && event.data && event.data.id !== undefined) {
          anchors.push({ seq: event.seq, needle: String(event.data.id) })
        } else if (event.type === 'tool/call' && event.data && event.data.callId !== undefined) {
          anchors.push({ seq: event.seq, needle: String(event.data.callId) })
        }
      }
      if (anchors.length === 0) return '已打开会话，事件史里没有可对接的锚——未定位'
      const findRow = (needle) => {
        for (const el of document.querySelectorAll('[data-chat-anchor-key]')) {
          if ((el.getAttribute('data-chat-anchor-key') || '').includes(needle)) return el
        }
        return undefined
      }
      // 首选：**框住整个来源区间**（CEO 定）——锚点的本义就是"这一段对话提炼出这条
      // 记忆"，把出处整片着色比指一行更诚实。
      const inRange = anchors.filter(a => a.seq >= record.seqLo && a.seq <= record.seqHi)
      const collect = (candidates) => {
        const out = []
        for (const cand of candidates) {
          const row = findRow(cand.needle)
          if (row !== undefined) out.push(row)
        }
        return out
      }
      // ⚠ 翻页循环由 **DOM 命中**驱动，不看事件覆盖：实测 `session.events` 一打开就是
      // 全量，按它判定会一页都不翻；而 DOM 行窗口只渲染尾页。
      let matched = []
      let prevCount = -1
      let olderTries = 0
      while (Date.now() < deadline && olderTries < 40) {
        matched = collect(inRange)
        if (matched.length > 0) break
        const count = document.querySelectorAll('[data-chat-anchor-key]').length
        if (count === prevCount) {
          if (typeof session.loadOlder !== 'function') break
          try { await session.loadOlder() } catch { break }
          olderTries += 1
        }
        prevCount = count
        await sleep(300)
      }
      if (matched.length > 0) {
        const rows = [...document.querySelectorAll('[data-chat-anchor-key]')]
        const indexes = matched.map(row => rows.indexOf(row))
        // 终点不取"区间内最后一个锚行"——LLM 输出行没有 id，落在最后一个锚之后会被
        // 漏掉（CEO 发现"怎么大多只框住用户消息"的根因）。终点取**区间之后第一个锚行
        // 的前一行**；找不到（区间在会话末尾）就框到底。
        let stop = rows.length
        const after = anchors.filter(a => a.seq > record.seqHi).sort((a, b) => a.seq - b.seq)
        for (const cand of after) {
          const row = findRow(cand.needle)
          if (row !== undefined) { stop = rows.indexOf(row); break }
        }
        const from = Math.min(...indexes)
        const slice = rows.slice(from, Math.max(stop, Math.max(...indexes) + 1))
        for (const el of slice) {
          el.__dmPrevBg = el.style.background
          el.style.background = 'rgba(247,107,21,0.14)'
          el.style.borderRadius = '6px'
        }
        slice[0].scrollIntoView({ block: 'center' })
        setTimeout(() => { for (const el of slice) el.style.background = el.__dmPrevBg || '' }, 6000)
        return '已框选来源区间 seq ' + record.seqLo + '→' + record.seqHi + '（着色 ' + slice.length + ' 行，滚动到区间开头）'
      }
      // 区间行都没渲染出来 → 落回就近单行：距目标近者优先（之前的优先于之后的）
      anchors.sort((a, b) => {
        const da = a.seq <= target ? target - a.seq : (a.seq - target) + 1e9
        const db = b.seq <= target ? target - b.seq : (b.seq - target) + 1e9
        return da - db
      })
      for (const cand of anchors.slice(0, 40)) {
        const row = findRow(cand.needle)
        if (row === undefined) continue
        row.scrollIntoView({ block: 'center' })
        const prevOutline = row.style.outline
        row.style.outline = '2px solid #f76b15'
        setTimeout(() => { row.style.outline = prevOutline }, 3000)
        return '已定位到 seq ' + cand.seq + '（记忆锚定区间 ' + record.seqLo + '→' + record.seqHi + '，就近对齐到最近的消息/工具行）'
      }
      return '已打开会话；锚点对应的聊天行未渲染出来——未定位'
    }

    // ── 装载（照 dsh-lab-ledger：自建根，退路 shell.overlay） ─────────
    const inject = []
    function apply(ctx) {
      let mounted = false
      try {
        const { createRoot } = require('react-dom/client')
        const host = document.createElement('div')
        host.id = 'dsh-memory-panel-root'
        host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147480000'
        document.body.appendChild(host)
        const root = createRoot(host)
        root.render(h(MemoryPanel, { ctx }))
        mounted = true
        ctx.effect(() => () => {
          try { root.unmount() } catch (error) { void error }
          try { host.remove() } catch (error) { void error }
        }, 'dsh-memory: panel react root')
      } catch (error) {
        void error
        mounted = false
      }
      if (!mounted && ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-memory-panel', order: 120, label: '记忆金字塔' },
            () => h(MemoryPanel, { ctx }),
          ))
      }
    }

    module.exports.apply = apply
    module.exports.inject = inject
    /**
     * 塔的纯数学，摊出来给自测用。**官方 harness 只认 `apply` / `inject`**，这一项
     * 对它是隐形的。
     *
     * 摊出来的理由：这一层全是「算得对不对」——分档、几何、命中测试——而验证它的
     * 唯一现实手段就是无头跑一遍。视觉稿那边踩过判例：**无头截图照不出交互 bug**
     * （它不移动鼠标、不点击），一个未定义的变量能让整个画布停止重绘，而截图全程绿灯。
     */
    module.exports.__engine = {
      BASE, spanOf, rowLabel, levelerOf, unpack, loadWorld,
      pickAt, hitShape, shapeOf, yOf, bw, bx, countOf, isDebt, levelAt, plotW, clampY, panYMax,
    }
    return module.exports
  },
})
