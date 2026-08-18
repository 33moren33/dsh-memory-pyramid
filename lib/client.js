/**
 * dsh-memory 前厅半边 —— 记忆金字塔面板。
 *
 * 形态（CEO 2026-08-16 定）：右下悬浮球 → 占右半屏的抽屉；上半是金字塔画布
 * （真实方块堆砌，可平移缩放，放大到能读字时砖面显字），下半是文字区（默认
 * 显示「此刻的记忆」＝当前注入给模型的视图原文，点砖切换为该块内容），右下角
 * 是开关与滑块。
 *
 * 视觉语言：
 * - 在注入视图里的砖＝亮＝DeepSeek 主题蓝；其余＝**冷却**（半透明浅白蓝）——
 *   不叫"死"，因为任何一层都能下钻取到。
 * - 欠压缩的空位＝虚线描边＋柔光。
 * - 点击一块砖＝它覆盖的下层基座整片用亮蓝线带包住。
 * - 位置即身份直接投影成画面：块 [lo,hi) 的横坐标就是 lo×单位宽，零布局算法。
 *
 * 装载方式照官方判例 @deepseek-ai/dsh-client-ui-trajectory（同 dsh-lab-ledger）：
 * 经典 <script> → window.__ModuleLoader__ 注册 factory → 导出 { inject, apply }。
 * 手写纯 JS，无打包器。自建 React 根挂 document.body（官方树塌方波及不到面板），
 * 拿不到 react-dom/client 时退回 shell.overlay 座位。
 *
 * 诚实纪律：画面上每块砖的颜色与文字都来自后厨路由的实时返回值（panel.js），
 * 亮区与模型收到的视图同源同算法；token 数标明是字节估算，不冒充分词器。
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

    // ── 视觉常量（数值可调，语言不可变） ─────────────────────────────
    const BLUE = '#4D6BFE'
    const COOL_FILL = 'rgba(100,140,220,0.10)'
    const COOL_STROKE = 'rgba(100,140,220,0.45)'
    const DEBT_STROKE = '#e8a23c'
    const DEBT_FILL = 'rgba(232,162,60,0.07)'
    const SELECT_STROKE = '#2947e0'
    const SELECT_BAND = 'rgba(77,107,254,0.08)'
    /** 选中砖本体的填色：另一种灰蓝（CEO 定），与亮蓝/冷色都区分开。 */
    const SELECT_FILL = '#8494c7'

    const BRICK_H = 22
    const GAP = 2
    const BASE_UNIT = 26
    /** 屏幕上砖宽超过它才画 #编号。 */
    const LABEL_PX = 88
    /** 屏幕上砖宽超过它才取正文上砖。 */
    const SNIPPET_PX = 200
    /** 单层砖在屏幕上窄于它就聚合成整条画（万砖档的救命阀）。 */
    const MERGE_PX = 2

    /** 每砖字节 → 砖宽系数（±1/4 的表现，CEO 定）。 */
    function widthFactor(noteBytes, min, max) {
      const t = (noteBytes - min) / Math.max(1, max - min)
      return 0.75 + 0.5 * t
    }

    function utf8Bytes(text) {
      try { return new TextEncoder().encode(text).length } catch { return text.length * 3 }
    }
    /** 粗估：中文 3 字节≈1 字≈1 token 量级。只做量级显示，界面上标明"字节估算"。 */
    function estimateTokens(text) {
      return Math.round(utf8Bytes(text) / 3)
    }
    function blockKey(lo, hi) { return lo + '-' + hi }

    /** 文本锚前缀，与后厨 `handoff.js` 的 HANDOFF_ANCHOR_PREFIX 同一个字面量。 */
    const SOURCE_PREFIX = 'md:'

    /**
     * 认锚 —— 一条第一层记忆的**基底**在哪。
     *
     * 两种出生册共用 sid 这一个字段，靠前缀分辨：`md:<名字>` 是架上的文本快照，
     * 其余非空值是会话 id。曾经这里只有"非空就是会话"一种解释，于是 md 导入的
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

    async function getJson(url, init) {
      const res = await fetch(url, init)
      return res.json()
    }

    // ── 主组件 ───────────────────────────────────────────────────────
    function MemoryPanel(props) {
      const [open, setOpen] = useState(false)
      const [state, setState] = useState(null)     // /state 的最近一次返回
      const [cfg, setCfg] = useState(null)         // 本地正在编辑的配置（滑块的即时值）
      const [sel, setSel] = useState(null)         // 选中块 {lo, hi}
      const [source, setSource] = useState(null)   // 正在看的基底快照 {name, bytes, text, tampered}
      const [msg, setMsg] = useState('')           // 跳转等操作的如实回话
      const [, bump] = useState(0)                 // 文本缓存到货后重画
      const [view, setView] = useState({ x: 24, y: 420, k: 1 })
      const [dims, setDims] = useState({ w: 800, h: 420 })
      const [ballPos, setBallPos] = useState(null)  // null＝默认右下；拖过后记像素坐标
      const ballDrag = useRef(null)
      const dimsRef = useRef({ w: 800, h: 420 })    // 给 useCallback([]) 的手柄读最新尺寸
      const minKRef = useRef(0.0008)                // 缩放下限＝复位取景的 k（CEO 定：不能比整塔视图更小）

      const texts = useRef(new Map())              // blockKey → {raw, text, record?, debt?}
      const inflight = useRef(new Set())
      const fitted = useRef('')                    // 已按此 total 自动取景过
      const postTimer = useRef(null)
      const svgRef = useRef(null)
      const dragRef = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const data = await getJson(API + '/state')
          if (data && data.ok) {
            setState(data)
            setCfg(prev => prev === null ? data.config : { ...data.config, wakeLines: prev.wakeLines, noteBytes: prev.noteBytes, liveView: data.config.liveView })
          }
        } catch { /* 后厨不在（如插件半装）——面板保持上次画面，不编造 */ }
      }, [])

      // 打开时取数并每 3s 轻刷（state 只有形状没有正文，很小；
      // 轻刷同时兼作聚光灯的跟随通道，太慢会显得"指了没反应"）
      useEffect(() => {
        if (!open) return undefined
        refresh()
        const timer = setInterval(refresh, 3000)
        return () => clearInterval(timer)
      }, [open, refresh])

      // 挤压式布局（CEO 2026-08-16 定：并排不遮挡，跳转后不用来回点）：
      // 面板开着时把官方 #root 捏到 60vw，官方壳自己响应式回流（实测侧边栏
      // 收成图标栏）；关闭复原。只动最外层容器宽度，不碰官方内部 grid/类名。
      useEffect(() => {
        const officialRoot = document.getElementById('root')
        if (!open || !officialRoot) return undefined
        const prev = officialRoot.style.width
        officialRoot.style.width = '60vw'
        return () => { officialRoot.style.width = prev }
      }, [open])

      // 量画布尺寸
      useEffect(() => {
        if (!open) return undefined
        const measure = () => {
          const el = svgRef.current
          if (el) {
            const next = { w: el.clientWidth || 800, h: el.clientHeight || 420 }
            dimsRef.current = next
            setDims(next)
          }
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [open])

      const total = state ? state.total : 0
      const wf = cfg ? widthFactor(cfg.noteBytes, cfg.noteBytesMin, cfg.noteBytesMax) : 1
      const unit = BASE_UNIT * wf

      // 整塔取景。首次拿到数据/换包后自动做一次；头部「复位」按钮随时可再来。
      const fitView = useCallback(() => {
        if (total === 0) return
        const k = Math.min(3, Math.max(0.0008, (dims.w * 0.92) / (total * unit)))
        setView({ x: dims.w * 0.04, y: dims.h - BRICK_H - 5, k })
      }, [total, dims, unit])
      useEffect(() => {
        if (total > 0) {
          minKRef.current = Math.min(3, Math.max(0.0008, (dims.w * 0.92) / (total * unit)))
        }
      }, [total, dims, unit])
      useEffect(() => {
        if (!state || total === 0) return
        const tag = total + ':' + dims.w
        if (fitted.current === tag) return
        fitted.current = tag
        fitView()
      }, [state, total, dims, unit, fitView])

      // 聚光灯跟随：模型（或外部脚本）指过哪块，画面就带过去并选中。
      // 只认"比上次新"的指令，面板自己拖动/点选不受打扰。
      // ⚠ 本 effect 必须放在 `unit` 声明之后——依赖数组在渲染期求值，放前面是 TDZ。
      const lastSpotAt = useRef(0)
      useEffect(() => {
        const spot = state && state.spotlight
        if (!spot || !(spot.at > lastSpotAt.current)) return
        lastSpotAt.current = spot.at
        const span = spot.hi - spot.lo
        const aligned = span > 0 && Number.isInteger(Math.log2(span)) && spot.lo % span === 0
        if (aligned) setSel({ lo: spot.lo, hi: spot.hi })
        // 取景：让该块占画布宽的约六成、居中
        const k = Math.min(60, Math.max(0.0008, (dims.w * 0.6) / (span * unit)))
        setView(v => ({ ...v, k, x: dims.w * 0.5 - (spot.lo + span / 2) * unit * k }))
      }, [state, dims, unit])

      // ── 交互：滚轮缩放（火焰图语义：只缩 X 轴、行高恒定，13 层塔永远读得清；
      //    对准光标缩放）、拖拽平移 ──
      // 滚轮走 ref 直挂原生监听而不是 React onWheel：①非被动才能 preventDefault
      // 拦住页面滚动；②事件坐标必须在 setState 回调之外读完——React 18 批处理后
      // 事件对象已被清理（2026-08-16 实测 onWheel 静默不动的根因群）。
      useEffect(() => {
        const el = svgRef.current
        if (!open || !el) return undefined
        const handler = (event) => {
          event.preventDefault()
          const rect = el.getBoundingClientRect()
          const cx = event.clientX - rect.left
          const factor = Math.exp(-event.deltaY * 0.0012)
          setView(v => {
            const k = Math.min(60, Math.max(minKRef.current, v.k * factor))
            return { ...v, k, x: cx - (cx - v.x) * (k / v.k) }
          })
        }
        el.addEventListener('wheel', handler, { passive: false })
        return () => el.removeEventListener('wheel', handler)
      }, [open])
      // ⚠ 拖拽**不做 setPointerCapture**：一捕获，松手后的 click 全落在画布上，
      // 砖的 onClick 永远收不到（CEO 真机复现"点砖文字不更新"的根因）。
      // 平移用**中键**（CEO 定：左键拖出画布会框选页面文本）；左键只管点选。
      const suppressClick = useRef(false)
      // 空格＋左键＝平移（行业公约数兜底，触控板友好；中键仍是主方式）。
      // 空格状态走 window 级监听（同 document 无围栏）；焦点在输入框时放行打字；
      // 只在鼠标悬停本抽屉时拦空格的页面滚动默认行为。
      const spaceHeld = useRef(false)
      const hoverDrawer = useRef(false)
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
        const panButton = event.button === 1 || (event.button === 0 && spaceHeld.current)
        if (!panButton) return
        event.preventDefault()
        dragRef.current = { lx: event.clientX, ly: event.clientY, moved: false }
      }, [])
      const onPointerMove = useCallback((event) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = event.clientX - drag.lx
        const dy = event.clientY - drag.ly
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
        drag.moved = true
        drag.lx = event.clientX
        drag.ly = event.clientY
        // 垂直夹取（CEO 定，2026-08-16 二次纠正方向）：**视野最下缘不越过基座**
        // ——基座可以往下沉出画布（看高塔上层），但不能被拖着升上来露出基座
        // 下面的空白。即 y 只许 ≥ 取景位。第一版 Math.min 夹反了，判例勿回退。
        setView(v => ({
          ...v,
          x: v.x + dx,
          y: Math.max(v.y + dy, dimsRef.current.h - BRICK_H - 5),
        }))
      }, [])
      const onPointerUp = useCallback(() => {
        if (dragRef.current?.moved) {
          suppressClick.current = true
          setTimeout(() => { suppressClick.current = false }, 0)
        }
        dragRef.current = null
      }, [])

      // ── 几何：算出当前视口里要画的砖 ──
      const bright = new Set()
      if (state) for (const [lo, hi] of state.wake.blocks) bright.add(blockKey(lo, hi))

      const bricks = []       // 单独画的砖
      const bars = []         // 聚合画的整条（砖太窄时）
      let topY = 0
      if (state && total > 0) {
        const xMin = (0 - view.x) / view.k
        const xMax = (dims.w - view.x) / view.k
        let level = 0
        for (let size = 1; size <= total; size *= 2, level += 1) {
          const needed = size === 1 ? total : Math.floor(total / size)
          if (needed === 0) break
          const have = size === 1 ? total : (state.levels[size] || 0)
          const uw = unit * size
          const y = -level * (BRICK_H + GAP)
          topY = y
          const px = uw * view.k
          if (px < MERGE_PX) {
            // 聚合：本层画成两段整条（已建＝冷色实条，欠压缩尾巴＝虚线条），
            // 亮块因为数量 ≤ 预算，仍逐块画得起。
            bars.push({ level, y, x0: 0, x1: have * uw, debt: false })
            if (needed > have) bars.push({ level, y, x0: have * uw, x1: needed * uw, debt: true })
            for (const [lo, hi] of (state.wake.blocks || [])) {
              if (hi - lo === size) {
                bricks.push({ lo, hi, size, x: lo * unit, y, w: uw, debt: false, bright: true, px })
              }
            }
            continue
          }
          const k0 = Math.max(0, Math.floor(xMin / uw))
          const k1 = Math.min(needed, Math.ceil(xMax / uw))
          for (let k = k0; k < k1; k++) {
            const lo = k * size
            const hi = lo + size
            bricks.push({
              lo, hi, size, x: lo * unit, y, w: uw, px,
              debt: size > 1 && k >= have,
              bright: bright.has(blockKey(lo, hi)),
            })
          }
        }
      }

      // ── 懒取砖面/下栏正文 ──
      useEffect(() => {
        if (!state) return
        const wanted = []
        for (const b of bricks) {
          if (b.px >= SNIPPET_PX && !b.debt && !texts.current.has(blockKey(b.lo, b.hi))) wanted.push(b)
        }
        if (sel && !texts.current.has(blockKey(sel.lo, sel.hi))) wanted.unshift(sel)
        let budget = 24
        for (const b of wanted) {
          const key = blockKey(b.lo, b.hi)
          if (inflight.current.has(key) || budget <= 0) continue
          inflight.current.add(key)
          budget -= 1
          getJson(API + '/block?lo=' + b.lo + '&hi=' + b.hi).then((data) => {
            inflight.current.delete(key)
            if (!data || data.ok !== true) return
            texts.current.set(key, data.raw
              ? { raw: true, text: data.record.text, record: data.record }
              : { raw: false, text: data.text, debt: data.debt === true })
            bump(n => n + 1)
          }).catch(() => inflight.current.delete(key))
        }
      })

      // ── 配置旋钮 ──
      const postConfig = useCallback((patch) => {
        getJson(API + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }).then(() => refresh()).catch(() => {})
      }, [refresh])
      const slide = useCallback((patch) => {
        setCfg(prev => ({ ...prev, ...patch }))
        if (postTimer.current) clearTimeout(postTimer.current)
        postTimer.current = setTimeout(() => postConfig(patch), 350)
      }, [postConfig])

      // ── 跳转下钻两级：①官方正门 sessions.open ②自建"拉页到 seq 进窗 →
      //    anchorSeq→data-chat-anchor-key → scrollIntoView"。任何一步失败都
      //    如实收在"已打开会话、未定位"，不装样。 ──
      const jump = useCallback((record) => {
        if (!record.sessionId) {
          setMsg('这条记忆没有会话指针（写入时拿不到会话 id）。')
          return
        }
        let sessions
        try { sessions = props.ctx && typeof props.ctx.get === 'function' ? props.ctx.get('sessions') : undefined } catch { sessions = undefined }
        if (!sessions || typeof sessions.open !== 'function') {
          setMsg('拿不到官方 sessions 服务，无法跳转。')
          return
        }
        try {
          sessions.open(record.sessionId)
        } catch (error) {
          setMsg('打开会话失败（可能不在本实例）：' + String(error && error.message || error))
          return
        }
        // 并排布局下面板不收起——左边对话、右边砖，同屏互指
        setMsg('')
        toast('已打开会话，正在定位 seq ' + record.seqLo + '→' + record.seqHi + ' …')
        locateInSession(sessions, record).then(result => toast(result))
      }, [props.ctx])

      // ── 另一种基底：架上的文本快照。它够不到会话那套 DOM 定位，也不需要——
      //    整份原文本来就在后厨的架子上，取回来铺在文字区即可。 ──
      const openSource = useCallback(async (name) => {
        setMsg('')
        try {
          const data = await getJson(API + '/source?name=' + encodeURIComponent(name))
          if (data && data.ok) setSource(data)
          else setMsg(data && data.error ? data.error : '取不到这份快照。')
        } catch {
          setMsg('后厨没有应答，取不到这份快照。')
        }
      }, [])

      // 换一块砖就丢掉正在看的基底——文字区永远只有一个当前对象。
      useEffect(() => { setSource(null) }, [sel])

      /**
       * 基底那一格的按钮。三种锚三条路，都占同一个位置：
       * 会话锚 → 开会话并框住出处区间；`md:` 锚 → 取回架上那份原文；无锚 → 灰掉。
       */
      function sourceButton(anchor, record) {
        if (anchor.kind === 'session') {
          return h('button', {
            onClick: () => jump(record),
            title: '用官方 sessions.open 打开来源会话，并框选这条记忆的出处区间',
            style: btnStyle(true),
          }, '跳到源对话')
        }
        if (anchor.kind === 'source') {
          return h('button', {
            onClick: () => openSource(anchor.name),
            title: '打开这条记忆蒸馏自的那份文本快照（' + anchor.name + '）',
            style: btnStyle(true),
          }, '打开出处原文')
        }
        return h('button', {
          disabled: true,
          title: '这条记忆没有出处指针：写入时拿不到会话 id，也不是从架上文本导入的',
          style: { ...btnStyle(false), opacity: 0.55, cursor: 'not-allowed' },
        }, '打开出处')
      }

      // ── 悬浮球：可拖拽，松手吸附到最近的左右屏缘；没拖动就当点击开关抽屉 ──
      const currentBallPx = () => ballPos !== null
        ? ballPos
        : { x: window.innerWidth - 22 - 46, y: window.innerHeight - 118 - 46 }
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
        if (!drag.moved) {
          setOpen(o => !o)
          return
        }
        setBallPos(pos => {
          const p = pos ?? currentBallPx()
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
        h('rect', { x: 1, y: 14, width: 20, height: 4.5, rx: 1, fill: '#fff', opacity: 0.65 }),
      ))

      if (!open) return h(React.Fragment, null, ball)

      const wakeText = state ? state.wake.text : ''
      const selData = sel ? texts.current.get(blockKey(sel.lo, sel.hi)) : undefined
      /** 世界 X → 屏幕 X。Y 不缩放（火焰图语义），行位置＝view.y + 行偏移。 */
      const sx = (x) => view.x + x * view.k

      const canvasChildren = []
      canvasChildren.push(h('defs', { key: 'defs' },
        h('filter', { id: 'dm-debt-glow', x: '-40%', y: '-40%', width: '180%', height: '180%' },
          h('feDropShadow', { dx: 0, dy: 0, stdDeviation: 3, floodColor: DEBT_STROKE, floodOpacity: 0.7 }))))

      // 选中覆盖带：从**选中块那一层**起向下包到地基（CEO 纠正：不往上窜，
      // 高度就是选中块到基座这一段）
      if (sel && state) {
        const selLevel = Math.round(Math.log2(sel.hi - sel.lo))
        canvasChildren.push(h('rect', {
          key: 'band',
          x: sx(sel.lo * unit), y: view.y - selLevel * (BRICK_H + GAP),
          width: (sel.hi - sel.lo) * unit * view.k,
          height: selLevel * (BRICK_H + GAP) + BRICK_H,
          fill: SELECT_BAND, stroke: SELECT_STROKE, strokeWidth: 1.5,
        }))
      }
      for (const bar of bars) {
        canvasChildren.push(h('rect', {
          key: 'bar' + bar.level + ':' + bar.debt,
          x: sx(bar.x0), y: view.y + bar.y, width: (bar.x1 - bar.x0) * view.k, height: BRICK_H,
          fill: bar.debt ? DEBT_FILL : COOL_FILL,
          stroke: bar.debt ? DEBT_STROKE : COOL_STROKE,
          strokeWidth: 1,
          strokeDasharray: bar.debt ? '6 4' : undefined,
        }))
      }
      for (const b of bricks) {
        const key = blockKey(b.lo, b.hi)
        const inSel = sel && b.lo >= sel.lo && b.hi <= sel.hi
        const isSel = sel && b.lo === sel.lo && b.hi === sel.hi
        const inset = Math.min(1.2, b.px * 0.03)
        canvasChildren.push(h('rect', {
          key: 'b' + key,
          x: sx(b.x) + inset, y: view.y + b.y + 1, width: Math.max(0.5, b.px - inset * 2), height: BRICK_H - 2,
          rx: Math.min(3, b.px * 0.08),
          fill: isSel ? SELECT_FILL : (b.debt ? DEBT_FILL : (b.bright ? BLUE : COOL_FILL)),
          stroke: isSel ? '#2b3862' : (inSel ? SELECT_STROKE : (b.debt ? DEBT_STROKE : (b.bright ? BLUE : COOL_STROKE))),
          strokeWidth: isSel ? 2.5 : inSel ? 2 : 1,
          strokeDasharray: b.debt ? '5 3.5' : undefined,
          filter: b.debt ? 'url(#dm-debt-glow)' : undefined,
          style: { cursor: 'pointer' },
          onClick: (event) => {
            event.stopPropagation()
            if (suppressClick.current) return
            setSel({ lo: b.lo, hi: b.hi })
            setMsg('')
          },
        }))
        if (b.px >= LABEL_PX) {
          const cached = texts.current.get(key)
          // 底排是单条事实，名字是 `#N`——与视图、与 memory_recall 的匹配面一致。
          const label = b.hi - b.lo === 1 ? '#' + b.lo : '#' + b.lo + '-' + (b.hi - 1)
          // 按砖的**实际屏宽**截字，且宁短勿溢：字与字重叠比缺字更不可读。
          const capacity = Math.floor((b.px - 10) / 12)
          const full = b.px >= SNIPPET_PX && cached && typeof cached.text === 'string'
            ? label + ' ' + cached.text
            : label
          const shown = full.length > capacity ? full.slice(0, Math.max(0, capacity - 1)) + '…' : full
          if (capacity >= label.length) {
            canvasChildren.push(h('text', {
              key: 't' + key,
              x: sx(b.x) + 4, y: view.y + b.y + BRICK_H - 7,
              fontSize: 11,
              fill: (b.bright || isSel) ? '#fff' : '#3a4a6b',
              style: { pointerEvents: 'none', userSelect: 'none' },
            }, shown))
          }
        }
      }

      const drawer = h('div', {
        style: {
          position: 'fixed', top: 0, right: 0, bottom: 0, width: '40vw',
          background: '#f7f9ff', borderLeft: '1px solid #d6ddf0',
          boxShadow: '-8px 0 30px rgba(30,50,120,0.18)', zIndex: 2147481000,
          display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
          fontFamily: 'system-ui, "Segoe UI", sans-serif', color: '#1c2540',
        },
        // 中键（或空格＋左键）拖画布在**整个右侧界面**有效（CEO 定），不只画布区
        onPointerDown, onPointerMove, onPointerUp,
        onPointerEnter: () => { hoverDrawer.current = true },
        onPointerLeave: (event) => { hoverDrawer.current = false; onPointerUp(event) },
        onMouseDown: (event) => { if (event.button === 1) event.preventDefault() },
      },
        // 头部
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #e2e8f6' } },
          h('b', { style: { fontSize: 14 } }, '记忆金字塔'),
          h('span', { style: { fontSize: 12, color: '#5a6788' } },
            state ? (state.total + ' 条事实 · 欠压缩 ' + state.pendingCount + ' 块') : '连接后厨…'),
          h('span', { style: { flex: 1 } }),
          h('button', { onClick: fitView, style: btnStyle(), title: '整塔取景（拖丢了就按这个）' }, '复位'),
          h('button', { onClick: refresh, style: btnStyle() }, '刷新'),
          h('button', { onClick: () => setOpen(false), style: btnStyle() }, '关闭'),
        ),
        // 图例
        h('div', { style: { display: 'flex', gap: 14, padding: '4px 14px', fontSize: 11, color: '#5a6788', borderBottom: '1px solid #eef1fa' } },
          legend(BLUE, '在注入视图（亮）'),
          legend(COOL_STROKE, '冷却（可下钻）'),
          legend(DEBT_STROKE, '欠压缩（虚线）'),
        ),
        // 画布
        h('div', { style: { flex: 1, minHeight: 0, position: 'relative' } },
          h('svg', {
            ref: svgRef,
            width: '100%', height: '100%',
            style: { display: 'block', touchAction: 'none', background: '#fbfcff' },
            onClick: () => { if (!suppressClick.current) { setSel(null); setMsg('') } },
          },
            state && total > 0
              ? h('g', null, canvasChildren)
              : h('text', { x: 20, y: 40, fontSize: 13, fill: '#5a6788' },
                state ? '（还没有任何记忆）' : '（后厨未应答——确认插件已在本实例装载）'),
          ),
        ),
        // 下半：文字区 + 控制角
        h('div', { style: { height: '38%', minHeight: 180, display: 'flex', borderTop: '1px solid #d6ddf0', background: '#fff' } },
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '8px 12px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5a6788' } },
              sel
                ? h(React.Fragment, null,
                  // 单条不是块：它的名字是 `#N`，与视图、与 memory_recall 的匹配面
                  // 说同一种话；`#N-N` 那种形状不存在。
                  h('b', { style: { color: '#1c2540' } },
                    sel.hi - sel.lo === 1 ? '#' + sel.lo : '#' + sel.lo + '-' + (sel.hi - 1)),
                  // 底排不是原料。它是受 280 字节封顶的第一层记忆，原料在它下面
                  // ——事实行带着锚指回去（会话原文或架上快照）。
                  h('span', null, (sel.hi - sel.lo) + ' 条'
                    + (sel.hi - sel.lo === 1 ? '（事实砖 · 第一层记忆）' : '（摘要砖）')),
                  h('button', { onClick: () => { setSel(null); setMsg('') }, style: btnStyle() }, '返回此刻的记忆'))
                : h('b', { style: { color: '#1c2540' } }, '此刻的记忆（注入视图原文）'),
            ),
            h('pre', {
              style: {
                flex: 1, overflow: 'auto', margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.55,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#232c48',
                fontFamily: 'ui-monospace, Consolas, monospace',
              },
            },
              source !== null
                ? sourceHeader(source) + source.text
                : sel
                  ? (selData === undefined
                    ? '（读取中…）'
                    : selData.debt
                      ? '（欠压缩——这块摘要还没被写出来。虚线砖是诚实的空位，不是丢数据：'
                        + '它盖住的每一条第一层记忆都完好，逐条读得到。）'
                      : (selData.raw && selData.record
                        ? factHeader(selData.record) + '\n\n' + selData.text
                        : selData.text))
                  : (wakeText || ''),
            ),
            sel && selData
              ? h('div', { style: { paddingTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                // 基底那一格：会话锚跳会话，`md:` 锚开快照，无锚灰掉。
                // 三条路走同一个按钮位，说的话各不相同——够不着可以，但必须让人
                // 知道自己够不着，不许亮着一个点下去必然失败的按钮。
                selData.raw ? sourceButton(readAnchor(selData.record), selData.record) : null,
                source !== null
                  ? h('button', { onClick: () => setSource(null), style: btnStyle() }, '返回这条记忆')
                  : null,
                typeof selData.text === 'string'
                  ? h('button', {
                    onClick: () => {
                      try {
                        navigator.clipboard.writeText(selData.text)
                        setMsg('已复制本块文本')
                      } catch { setMsg('剪贴板不可用') }
                    },
                    style: btnStyle(),
                  }, '复制本块文本')
                  : null,
                msg !== '' ? h('span', { style: { fontSize: 11, color: '#b0541f' } }, msg) : null)
              : (msg !== '' ? h('div', { style: { fontSize: 11, color: '#b0541f', paddingTop: 4 } }, msg) : null),
          ),
          // 右下控制角
          h('div', { style: { width: 232, borderLeft: '1px solid #eef1fa', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 } },
            h('button', {
              onClick: () => cfg && postConfig({ liveView: !cfg.liveView }),
              style: btnStyle(true),
              title: '冻结＝视图只在会话开局注入一次；实时＝每次写入后更新。当前会话从下一条消息起生效。',
            }, cfg ? ('视图注入：' + (cfg.liveView ? '实时' : '冻结')) : '…'),
            h('button', {
              disabled: true,
              style: { ...btnStyle(false), opacity: 0.55, cursor: 'not-allowed' },
              title: '并行（后台分身自动写记忆）尚未上线，这里先占位不冒充。',
            }, '写入：串行（并行开发中）'),
            cfg ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', null, '注入总数 ', h('b', null, String(cfg.wakeLines)), ' 行'),
              h('input', {
                type: 'range', min: 8, max: 256, step: 4, value: cfg.wakeLines,
                onChange: (event) => slide({ wakeLines: Number(event.target.value) }),
              })) : null,
            cfg ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', null, '每砖字节 ', h('b', null, String(cfg.noteBytes)), '（此后写入生效）'),
              h('input', {
                type: 'range', min: cfg.noteBytesMin, max: cfg.noteBytesMax, step: 1, value: cfg.noteBytes,
                onChange: (event) => slide({ noteBytes: Number(event.target.value) }),
              })) : null,
            h('div', { style: { marginTop: 'auto', color: '#5a6788' } },
              '此刻注入 ≈ ', h('b', { style: { color: '#1c2540' } }, String(estimateTokens(wakeText))),
              ' tok', h('div', { style: { fontSize: 10.5 } }, '（按 UTF-8 字节估算，非官方分词）')),
          ),
        ),
      )

      return h(React.Fragment, null, ball, drawer)
    }

    /** 一条自动消失的浮动提示——跳转后抽屉已关，回话不能没有着落。 */
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
     * 下钻二级：把目标 seq 拉进窗口并滚过去。
     * 官方没有定位 API（2026-08-16 源码探针结论），这里用的三件都是稳定契约层：
     * `binding(id).session` 与 `loadOlder()`（官方 rename 同级）、聊天行的官方
     * data 属性 `data-chat-anchor-key`、节点上的 `anchorSeq` 排序键。
     * 每一步拿不到就收在诚实的"未定位"，绝不假装定过位。
     */
    async function locateInSession(sessions, record) {
      const target = record.seqLo > 0 ? record.seqLo : record.seqHi
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      const deadline = Date.now() + 15000
      // 定位＝「事件史找 id → DOM 对 id」（2026-08-16 两轮活体探明后的定稿）：
      // - `session.events` 是带**真 seq** 的完整事件数组；真人消息带 `data.id`、
      //   工具调用带 `data.callId`，而官方聊天行的 `data-chat-anchor-key` 里
      //   恰好嵌着同一个 id —— 两边拿 id 对接，seq 只从事件史读。
      // - ⚠ 锚 key 前导数字**不是** seq（是节点序号；小会话里量级碰巧相同，
      //   曾用它蒙对过一次——判例，别改回去）。
      // ⚠ open 是异步的；DOM 里可能还留着上一个会话的行，不能拿"有行"当就绪。
      // 就绪判据＝目标会话的 binding 存在且事件窗非空。
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
      // 收集可对接的锚：{seq, 可在 DOM key 里找到的 id}
      const anchors = []
      for (const event of session.events) {
        if (event.type === 'user/message' && event.data?.id !== undefined) {
          anchors.push({ seq: event.seq, needle: String(event.data.id) })
        } else if (event.type === 'tool/call' && event.data?.callId !== undefined) {
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
      // 首选：**框住整个来源区间**（CEO 定）——锚点的本义就是"这一段对话提炼出
      // 这条记忆"，把出处整片着色比指一行更诚实。区间内已渲染的首尾行之间全部
      // 着色 6 秒；没渲染到的部分不假装框住了。
      const inRange = anchors.filter(a => a.seq >= record.seqLo && a.seq <= record.seqHi)
      const collect = (candidates) => {
        const out = []
        for (const cand of candidates) {
          const row = findRow(cand.needle)
          if (row !== undefined) out.push(row)
        }
        return out
      }
      // ⚠ 翻页循环由 **DOM 命中**驱动，不看事件覆盖：实测 `session.events` 一
      // 打开就是全量，按它判定会一页都不翻；而 DOM 行窗口只渲染尾页——跳进
      // 没打开过的会话时目标行还没画出来（CEO 复现"行数没出来跳不了"的根因）。
      // 锚行没出现就：等渲染 → 行数不再涨就 loadOlder → 再等，直到命中或到底。
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
        // 终点不取"区间内最后一个锚行"——LLM 输出行没有 id，落在最后一个锚
        // 之后会被漏掉（CEO 发现"怎么大多只框住用户消息"的根因）。终点取
        // **区间之后第一个锚行的前一行**；找不到（区间在会话末尾）就框到底。
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
          el.style.background = 'rgba(77,107,254,0.12)'
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
        row.style.outline = '2px solid #4D6BFE'
        setTimeout(() => { row.style.outline = prevOutline }, 3000)
        return '已定位到 seq ' + cand.seq + '（记忆锚定区间 ' + record.seqLo + '→' + record.seqHi + '，就近对齐到最近的消息/工具行）'
      }
      return '已打开会话；锚点对应的聊天行未渲染出来——未定位'
    }

    function btnStyle(primary) {
      return {
        border: '1px solid ' + (primary ? BLUE : '#c9d2ea'),
        background: primary ? 'rgba(77,107,254,0.08)' : '#fff',
        color: primary ? '#2947e0' : '#3a4a6b',
        borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer',
      }
    }
    function legend(color, label) {
      return h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('span', { style: { width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' } }), label)
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
    return module.exports
  },
})
