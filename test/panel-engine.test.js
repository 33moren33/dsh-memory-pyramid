/**
 * 面板塔的纯数学自测：`node --test test/panel-engine.test.js`。
 *
 * ⚠ 为什么非有这一份不可：视觉稿那边踩过判例——**无头截图照不出交互 bug**
 * （它不移动鼠标、不点击）。一个删了定义没删引用的变量让整个画布停止重绘，
 * 而截图全程绿灯，直到人手动一悬停才炸。所以凡是算出来的东西都在这里测，
 * 剩下的「好不好看」才交给眼睛。
 *
 * 测的是三件会静默错掉的事：
 *   1. 分档必须**绝对**——按视野算分位数会让同一批数据缩得越小反而越亮；
 *   2. 三种行**同一套几何**——底排一旦被单独放大，人就会把第一层当成基底；
 *   3. 命中测试打在**画出来的形状**上，不是打在整行上。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 把浏览器 bundle 在 node 里跑起来，取出塔的纯数学。
 * @returns {any}
 */
function loadEngine() {
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def } } },
    document: { createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } },
    atob: b64 => Buffer.from(b64, 'base64').toString('binary'),
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'atob', src)(sandbox.window, sandbox.document, sandbox.atob)
  assert.equal(captured.id, 'dsh-memory-pyramid', 'bundle id 必须＝包名（client-modules 按此校验）')
  const react = {
    createElement: () => ({}),
    useState: () => [null, () => {}],
    useEffect() {}, useRef: () => ({ current: null }), useCallback: f => f, Fragment: 'F',
  }
  // 记录式 createElement：悬浮球图标是**算**出来的一堆 rect，坐标得看得见才测得了
  react.createElement = (type, props, ...kids) => ({ type, props, kids })
  return captured.factory(name => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  }).__engine
}

const E = loadEngine()

/** 一个装好数据的引擎状态。 */
function world(total, { levels = {}, cover = [], inject = {}, query = [], open = [] } = {}) {
  const e = {
    W: 600, H: 300, dpr: 1, unit: 1, offX: 0, offY: 0, ROW: 20, PADL: 30,
    morph: 0, sel: null, hover: null, theme: 'ink', selGrow: 0,
  }
  E.loadWorld(e, { total, levels, wake: { blocks: cover }, pendingCount: 0 }, {
    inject, query: pack(query), open: pack(open), times: pack([]),
  })
  return e
}
/** 计数打成 base64，与后厨 `pack()` 同一个编码。 */
function pack(counts) {
  const buffer = Buffer.alloc(counts.length * 4)
  for (let i = 0; i < counts.length; i++) buffer.writeUInt32LE(counts[i], i * 4)
  return buffer.toString('base64')
}

test('⭐ 分档是绝对的：阈值只跟数据走，跟视野一点关系都没有', () => {
  const level = E.levelerOf(100)
  assert.equal(level(0), 0, '没被用过就是第 0 档')
  assert.equal(level(100), 4, '最大值顶到最亮档')
  // 同一个值在任何缩放下都是同一档——分档器根本拿不到视野，也就骗不了人。
  assert.equal(level(10), E.levelerOf(100)(10))
  // 对数等分：注入次数跨三个数量级，线性分档会把上半座塔烧成同一色。
  assert.ok(level(3) < level(30), '一个数量级的差必须分得开')
})

test('⭐ 三种行共用同一套几何：底排不许被单独放大', () => {
  const e = world(64)
  // 行高、点尺寸、形状函数三行同一套——旧稿给底排 1.7 倍行高，
  // 于是「它看起来像地基是因为我们把它画成了地基」。
  const base = E.shapeOf(e, E.BASE, 0, 1)
  const first = E.shapeOf(e, 0, 0, 1)
  const summary = E.shapeOf(e, 3, 0, 1)
  assert.equal(base.h, first.h, '基底与第一层等高')
  assert.equal(base.h, summary.h, '与摘要层也等高')
  assert.equal(E.bw(e, E.BASE), E.bw(e, 0), '基底与第一层 1:1，块宽也相同')
  assert.equal(E.bw(e, 3), 8 * E.bw(e, 0), '摘要块宽＝它盖住的条数')
})

test('行从底往上排：基底在最下，摘要越高越上', () => {
  const e = world(64)
  const yBase = E.yOf(e, E.BASE)
  const yFirst = E.yOf(e, 0)
  const yTop = E.yOf(e, 3)
  assert.ok(yBase > yFirst, '基底在第一层下面')
  assert.ok(yFirst > yTop, '第一层在摘要层下面')
  assert.ok(yBase + e.ROW <= e.H + 0.001, 'offY=0 时基底贴着卡片底沿')
})

test('⭐ 命中测试打在画出来的形状上，不是打在整行上', () => {
  const e = world(8)
  e.unit = 40; e.offX = e.PADL; e.morph = 1        // 砖模式，一块 40px
  const y = E.yOf(e, 0)
  const hit = E.pickAt(e, e.PADL + 20, y + e.ROW / 2)
  assert.deepEqual([hit.L, hit.i, hit.lo, hit.hi], [0, 0, 0, 1])

  assert.equal(E.pickAt(e, e.PADL - 5, y + e.ROW / 2), null, '左边槽是纵轴层标签，不是塔')
  // 塔顶之上是空的。⚠ 行与行之间那 2px 缝隙**故意**算命中——形状比手指细时不给
  // 容差就永远点不中，所以缝隙由相邻行的 ±2 容差吃掉，这是有意的，不是漏判。
  assert.equal(E.pickAt(e, e.PADL + 20, E.yOf(e, 3) - 20), null, '塔顶之上没有块')
  assert.equal(E.pickAt(e, e.PADL + 20, E.yOf(e, E.BASE) + e.ROW + 20), null, '基底之下没有块')
  // 星模式：星点只有 10px 宽而块有 40px，**点星点之外＝空白**，判定取消
  // （整块都能点就没法「点空白取消」了）。星点在块的正中。
  e.morph = 0
  assert.ok(E.pickAt(e, e.PADL + 20, y + e.ROW / 2), '块正中就是星点本体，点得中')
  assert.equal(E.pickAt(e, e.PADL + 36, y + e.ROW / 2), null, '同一块里、星点之外是空白')
})

test('⭐ 交互形状 ≠ 绘制形状：密层里指的是那条缝，不是胖方点', () => {
  const e = world(10000)
  e.unit = 0.05                                    // 一条记录 0.05px：万条档的真实密度
  const drawn = E.shapeOf(e, 0, 500, 0)
  const hit = E.hitShape(e, 0, 500, 0)
  assert.ok(drawn.w > hit.w, '画的时候点尺寸恒定（挨近了就该叠起来）')
  assert.ok(hit.w <= Math.max(1, E.bw(e, 0)) + 1e-9, '指的时候夹回这块自己的宽度')
  assert.equal(hit.cx, drawn.cx, '夹宽度不挪位置')
})

test('欠压缩＝诚实的空位：该有摘要却还没写的块，认得出来', () => {
  // 8 条事实、TREE/2 只建了 2 块（该有 4 块）
  const e = world(8, { levels: { 2: 2, 4: 0, 8: 0 } })
  assert.equal(E.isDebt(e, 1, 1), false, '已建的块不是欠账')
  assert.equal(E.isDebt(e, 1, 3), true, '没建的块是欠账')
  assert.equal(E.isDebt(e, 0, 5), false, '第一层是事实，永远不欠')
  assert.equal(E.isDebt(e, E.BASE, 5), false, '基底是原料，更不欠')
})

test('⭐ 橘线永远落不到基底行上：原料不进上下文，是数据自己说的', () => {
  const e = world(8, { levels: { 2: 4, 4: 2, 8: 1 }, cover: [[0, 4], [4, 6], [6, 7], [7, 8]] })
  assert.equal(e.COVER.length, 4)
  for (const b of e.COVER) assert.ok(b.L >= 0, '注入覆盖里根本没有 L=-1 的块')
  assert.deepEqual(e.COVER.map(b => b.L), [2, 1, 0, 0])
  assert.deepEqual(e.COVER.map(b => b.i), [0, 2, 6, 7])
})

test('第一层的热度是两笔取大：注入垫底，查询命中顶尖', () => {
  // 4 条事实：#0 只被注入过、#3 只被查询命中过，两条都不该是最暗
  const e = world(4, {
    levels: { 2: 2, 4: 1 },
    inject: { 1: pack([9, 0, 0, 0]), 2: pack([0, 0]), 4: pack([0]) },
    query: [0, 0, 0, 9],
  })
  assert.ok(E.levelAt(e, 0, 0) > 0, '只被注入过也算被用到')
  assert.ok(E.levelAt(e, 0, 3) > 0, '只被查询命中过更算被用到')
  assert.equal(E.levelAt(e, 0, 1), 0, '两样都没有才是第 0 档')
})

test('纵向平移只有下界：塔塞得进卡片时也拖得动', () => {
  const e = world(64)
  e.ROW = 10                                       // 塔很矮，整座都塞得进卡片
  assert.ok(E.panYMax(e) > 0, '上界不许跟着下界一起夹死——夹死了纵向就是死功能')
  e.offY = -50; E.clampY(e)
  assert.equal(e.offY, 0, '下界锁死：基底不能升起来露出白边')
})

test('base64 的计数解得回来，与后厨的编码对得上', () => {
  assert.deepEqual(E.unpack(pack([0, 1, 70000, 4294967295])), [0, 1, 70000, 4294967295])
  assert.deepEqual(E.unpack(''), [], '没有这份账就是空，不是崩')
  assert.deepEqual(E.unpack(undefined), [])
})

test('层的名字按三层结构定格，「地基/基座」不许再出现', () => {
  assert.equal(E.rowLabel(E.BASE), '基底')
  assert.equal(E.rowLabel(0), '1层')
  assert.equal(E.rowLabel(3), '4层')
})

// ══ 悬浮球图标 ════════════════════════════════════════════════════════════
// 它是「面板复位后那张图」的等比缩小版，所以错法与塔同族、而且更难看出来——
// 图标只有 46px，粗一圈、少一行、右边该空没空，肉眼都只觉得"有点怪"。

const HOT = '#f76b15'
/** 图标里的那些 rect（按 y 分行）。 */
function ballRows(state) {
  const svg = E.ballIcon(state, HOT)
  const rows = new Map()
  for (const kid of svg.kids) {
    if (kid.type !== 'rect') continue
    const list = rows.get(kid.props.y) || []
    list.push(kid.props)
    rows.set(kid.props.y, list)
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}
/** 后厨 `/state` 的最小样子。 */
function panelState(total, blocks = []) {
  return { total, levels: {}, wake: { blocks }, pendingCount: 0 }
}

test('⭐ 悬浮球图标：没有数据就画空，不画一座假塔', () => {
  assert.equal(E.ballIcon(null, HOT).kids.length, 0)
  assert.equal(E.ballIcon(panelState(0), HOT).kids.length, 0, '零条记忆时一格都不画')
})

test('⭐ 悬浮球图标：画全部层，一层不抽稀一层不封顶', () => {
  // 层数＝log2(条数)+1 摘要/事实层，再加基底那一行
  assert.equal(ballRows(panelState(70)).length, 8, '70 条 → 7 层 + 基底')
  assert.equal(ballRows(panelState(10020)).length, 15, '10020 条 → 14 层 + 基底')
  assert.equal(ballRows(panelState(1000000)).length, 21, '一百万条也照画，不封顶')
})

test('⭐ 悬浮球图标：塔尖那层右边该空一截（位置按 2^L/T 算，不是按 n 等分）', () => {
  const rows = ballRows(panelState(10020))
  const inner = E.BALL_BOX - E.BALL_PAD * 2
  const top = rows[0].reduce((w, r) => w + r.width, 0)
  assert.ok(top < inner * 0.9,
    '最上面那层只盖到 2^L×n，右边必须留空——按 (i+.5)/n 等分就会铺满，那是编造')
  const bottom = rows[rows.length - 1][0]
  assert.ok(Math.abs(bottom.width - inner) < 0.01, '基底与第一层 1:1，铺满整幅')
})

test('⛔ 悬浮球图标：注入那截与灰底的带子**等高**，且宽度按真值不被兜底撑大', () => {
  // 万条档一个 128 宽的块画出来才 0.49px。曾经用 max(.8, 真宽) 兜底，于是 +65%，
  // 挨着的几十块各自撑大再叠起来，橘色那截就比灰带粗一圈（CEO 一眼看出来的）。
  const total = 10020
  const rows = ballRows(panelState(total, [[0, 128], [128, 256], [4096, 4224]]))
  const inner = E.BALL_BOX - E.BALL_PAD * 2
  const hot = rows.flat().filter(r => r.fill === HOT)
  const grey = rows.flat().filter(r => r.fill !== HOT)
  assert.ok(hot.length > 0, '给了 cover 就得画出来')
  for (const r of hot) {
    assert.ok(grey.some(g => g.height === r.height), '注入段的高度必须等于灰带的高度')
  }
  // [0,128) 与 [128,256) 是连着的两块 → 并成一段，宽度＝256/T
  const merged = hot.find(r => Math.abs(r.x - E.BALL_PAD) < 0.01)
  assert.ok(merged, '第一段从最左边起画')
  assert.ok(Math.abs(merged.width - (256 / total) * inner) < 0.01,
    '连着的块并成一段、宽度按真值——不是一块一个 rect 各自兜底再叠')
})

test('⭐ 悬浮球图标：块还分得开时一块一颗点，且只有被注入的那颗换色', () => {
  // ⚠ "分得开"是算出来的，不是想当然：70 条铺在 38px 里，第一层一条才 0.54px，
  //   早就叠成带了。真正还看得见一颗颗的是上面几层——TREE/8 有 8 个块、每块 4.3px。
  const rows = ballRows(panelState(70, [[8, 16]]))  // TREE/8 的第 1 块被注入
  const row = rows[3]                               // r=3 → L = NROWS-2-r = 3
  assert.equal(row.length, 8, 'TREE/8 有 8 个块，分得开就该是 8 颗点')
  assert.equal(row.filter(r => r.fill === HOT).length, 1, '只有那一颗是注入色')
  assert.equal(row[1].fill, HOT, '换色的必须正是第 2 颗')
})

test('⭐ 时间轴左端锚点：永远比刻度粗一级，绝不跟刻度说同一句话', () => {
  // 病在这儿：刻度是**相对**的，只有跨上一级那一刻才升格成两级，而一屏之内不跨级
  // 时一次都不升格（第一个刻度更是天生不可能升格）。于是轴上只剩「16分 36分 40分」
  // 这样的裸数字，没有一个字说这是哪天哪个小时。锚点把绝对坐标钉在起点。
  //
  // ⭐ 但锚点**不许说到刻度那一级**：分档的刻度本来就写着「16分」，锚点再写一个
  //    「16分」是同一件事说两遍，白占一行还让人以为那是另一个时刻。
  const at = new Date(2026, 7, 16, 17, 16, 7).getTime()   // 2026-08-16 17:16:07
  assert.deepEqual(E.anchorLines(at, 'month'), ['26年'])
  assert.deepEqual(E.anchorLines(at, 'day'), ['26年8月'])
  assert.deepEqual(E.anchorLines(at, 'hour'), ['26年8月', '16号'])
  assert.deepEqual(E.anchorLines(at, 'minute'), ['26年8月', '16号17时'])
  assert.deepEqual(E.anchorLines(at, 'second'), ['26年8月', '16号17时', '16分'])

  // 反向钉死这条规则：刻度在说的那一级，锚点末尾一个字都不许碰。
  const tickUnit = { month: '月', day: '号', hour: '时', minute: '分', second: '秒' }
  for (const [bucket, unit] of Object.entries(tickUnit)) {
    const tail = E.anchorLines(at, bucket).at(-1)
    assert.ok(!tail.endsWith(unit), `${bucket} 档的锚点说到了刻度那一级（${tail}）`)
  }
})

test('⭐ 刻度一个字都没画出来时，锚点补到刻度那一级——轴上永远有一个可读的绝对时刻', () => {
  // 判例（CEO 2026-08-19 现场）：三条记忆写在同一秒，第一条被推到屏幕外、
  // 第二条被它的避让占位挤掉，于是**刻度轴一个字都没有**，而锚点还按"粗一级"
  // 的规矩只说到「时」——分和秒都没人说，等于什么都没说。
  // 「粗一级」的前提是**刻度在说那一级**；前提没了，规矩就不该照用。
  const at = new Date(2026, 7, 16, 17, 36, 34).getTime()
  assert.deepEqual(E.anchorLines(at, 'second', true), ['26年8月', '16号17时', '36分34秒'])
  assert.deepEqual(E.anchorLines(at, 'minute', true), ['26年8月', '16号17时', '36分'])
  assert.deepEqual(E.anchorLines(at, 'hour', true), ['26年8月', '16号17时'])
  assert.deepEqual(E.anchorLines(at, 'day', true), ['26年8月', '16号'])
  assert.deepEqual(E.anchorLines(at, 'month', true), ['26年8月'])

  // 补齐之后仍不许超过三行——轴条高度是按三行让的。
  for (const bucket of ['month', 'day', 'hour', 'minute', 'second']) {
    assert.ok(E.anchorLines(at, bucket, true).length <= 3, `${bucket} 档补齐后超过三行`)
    // 补齐版必须**真的比常规版多说一级**，否则这条退出口是摆设。
    const normal = E.anchorLines(at, bucket).join('')
    const full = E.anchorLines(at, bucket, true).join('')
    assert.ok(full.length > normal.length, `${bucket} 档补齐后没多说任何东西`)
  }
})

test('锚点最多三行——轴条高度是按三行让的，多一行就会被切掉', () => {
  const at = Date.now()
  for (const bucket of ['month', 'day', 'hour', 'minute', 'second']) {
    assert.ok(E.anchorLines(at, bucket).length <= 3, `${bucket} 档超过三行`)
  }
})

test('⭐ 当前工作区：先拿选中会话去名册反查，查不到才退到最近用过的那个', () => {
  // 官方口径（docs/subsystems/workspace.md）：归属的真相是那份有序 sessionIds，
  // **不是从路径反推**。所以反查名册优先，别倒过来。
  const list = {
    items: [
      { workspaceId: 'w1', path: '/srv/alpha', sessionIds: ['session-a'] },
      { workspaceId: 'w2', path: '/srv/beta', sessionIds: ['session-b'] },
    ],
    recentWorkspaceId: 'w2',
  }
  assert.equal(E.workspaceRootOf(list, { sessionId: 'session-a' }), '/srv/alpha')
  // 选中的会话不属于任何已登记工作区（Ungrouped）→ 退到 recent
  assert.equal(E.workspaceRootOf(list, { sessionId: 'session-zzz' }), '/srv/beta')
  // 一个工作区都没有 → 老实答"没选"，绝不随便挑一个
  assert.equal(E.workspaceRootOf({ items: [] }, { sessionId: 'session-a' }), null)
  assert.equal(E.workspaceRootOf(undefined, undefined), null)
})
