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
