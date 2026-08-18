/**
 * 用量账自测：`node --test test/heat.test.js`。
 *
 * 这份账的全部价值是「数是真的」。所以测的不是它会不会加一，而是它**会不会
 * 在没人用的时候自己涨**——面板轮询、上下文重复装配、被截断没交出去的命中，
 * 三条都会长出一块看起来完全合理的假数据。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HeatLedger, OPEN, QUERY } from '../lib/heat.js'
import { apply } from '../lib/index.js'
import { openDataDir } from '../lib/store.js'

/** @returns {string} 用完即弃的数据目录。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-heat-'))
  openDataDir(dir, { subdirs: ['TREE'], migrate: false })
  return dir
}

/**
 * 装一份完整实例：工具、面板路由、注入回调都接出来。
 * @param {string} dir - 数据目录。
 * @param {object} [extra] - 追加配置。
 * @returns {{ tools: Map<string, any>, routes: Map<string, Function>, wake: any }}
 */
function mount(dir, extra = {}) {
  const tools = new Map()
  const routes = new Map()
  let wake
  const scoped = {
    get: () => ({ register: (route) => { routes.set(route.path, route.handler); return () => {} } }),
    effect: () => {},
  }
  apply({
    get: () => undefined,
    inject: (_names, ready) => ready(scoped),
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {}, context(def) { wake = def } },
  }, { dataDir: dir, migrate: false, ...extra })
  return { tools, routes, wake }
}

/**
 * 走一次路由，拿回它写出的 JSON。
 * @param {Map<string, Function>} routes - 路由表。
 * @param {string} url - 带查询串的路径。
 * @returns {Promise<any>}
 */
function callRoute(routes, url) {
  const handler = routes.get(url.split('?')[0])
  assert.equal(typeof handler, 'function', `路由 ${url} 没挂上`)
  return new Promise((resolve) => {
    handler({ url, method: 'GET' }, { writeHead() {}, end(body) { resolve(JSON.parse(body)) } })
  })
}

/**
 * base64 的 32 位小端数组解回数字。
 * @param {string} packed - 编码。
 * @returns {number[]}
 */
function unpack(packed) {
  const buffer = Buffer.from(packed ?? '', 'base64')
  const out = []
  for (let i = 0; i + 4 <= buffer.length; i += 4) out.push(buffer.readUInt32LE(i))
  return out
}

test('位置即身份第三次成立：没记过的一律 0，不必初始化也不必知道总长', () => {
  const heat = new HeatLedger(scratch())
  assert.deepEqual(heat.read(QUERY, 0, 4), [0, 0, 0, 0], '文件都还不存在，读出来也是 0 不是报错')

  heat.bump(QUERY, 1000)
  assert.equal(heat.read(QUERY, 1000, 1001)[0], 1, '越过末尾写，中间的洞由文件系统补零')
  assert.deepEqual(heat.read(QUERY, 998, 1000), [0, 0])

  heat.bumpMany(QUERY, [3, 3, 3, 7])
  assert.equal(heat.read(QUERY, 3, 4)[0], 3, '一批里重复的格子累加')
  assert.equal(heat.read(QUERY, 7, 8)[0], 1)
})

test('⭐ 面板轮询不算注入：只有视图真的交给模型才记一笔', async () => {
  const dir = scratch()
  const { tools, routes, wake } = mount(dir, { liveView: true })
  for (let i = 0; i < 3; i++) await tools.get('memory_note').execute({ text: `事实 ${i}` }, {})

  // 面板开着就每 3 秒来一次 /state，而它内部要调 renderWake() 拿视图原文。
  // 记账若接在 renderWake 上，这里五次轮询就会把颜色自己刷亮。
  for (let i = 0; i < 5; i++) await callRoute(routes, '/dsh-memory/panel/state')
  const idle = await callRoute(routes, '/dsh-memory/panel/heat')
  assert.deepEqual(idle.inject, {}, '轮询五次，一笔都不该记')

  wake.text({ scope: { session: { id: 'session-a' } } })
  const after = await callRoute(routes, '/dsh-memory/panel/heat')
  assert.deepEqual(unpack(after.inject['1']), [1, 1, 1], '三条事实各被注入一次')
})

test('⭐ 同一会话反复装配只算一次；换个会话才是又一次注入', async () => {
  const dir = scratch()
  const { tools, wake, routes } = mount(dir, { liveView: true })
  await tools.get('memory_note').execute({ text: '唯一的一条' }, {})

  const same = { scope: { session: { id: 'session-a' } } }
  // 上下文在一轮里可能被装配不止一次，而模型只看见了一份。
  for (let i = 0; i < 4; i++) wake.text(same)
  assert.deepEqual(unpack((await callRoute(routes, '/dsh-memory/panel/heat')).inject['1']), [1])

  wake.text({ scope: { session: { id: 'session-b' } } })
  assert.deepEqual(unpack((await callRoute(routes, '/dsh-memory/panel/heat')).inject['1']), [2])
})

test('⭐ 记的是模型此刻真看到的那几块，不是此刻算出来的那几块', async () => {
  const dir = scratch()
  const { tools, wake, routes } = mount(dir) // 默认冻结
  for (let i = 0; i < 3; i++) await tools.get('memory_note').execute({ text: `事实 ${i}` }, {})

  // 冻结命中：模型看到的是会话开局那份旧视图，里面只有 #0 一条。
  // 按当前 cover() 记账就会把 #1 #2 也记上——它们此刻并没有出现在模型眼前。
  const frozen = '### Memory view (1 facts, oldest first)\n\n#0 2026-08-18 事实 0'
  const snapshot = {
    seq: 2,
    type: 'user/message',
    data: {
      source: {
        kind: 'plugin',
        plugin: '@deepseek-ai/dsh-system-prompt',
        form: 'snapshot',
        sections: [{ name: 'dsh-memory:wake', text: frozen }],
      },
    },
  }
  const ac = {
    scope: { session: { id: 'session-frozen', events: [snapshot], surface: { nodes: [2] } } },
  }
  assert.equal(wake.text(ac), frozen, '前提：这一次确实走的是冻结底')
  assert.deepEqual(
    unpack((await callRoute(routes, '/dsh-memory/panel/heat')).inject['1']),
    [1, 0, 0],
    '只记 #0 —— #1 #2 虽然此刻的 cover() 会算出来，但它们没出现在模型眼前',
  )
})

test('⭐ 被截断压下的命中不记账：它们没到模型面前', async () => {
  const dir = scratch()
  const { tools, routes } = mount(dir)
  for (let i = 0; i < 12; i++) await tools.get('memory_note').execute({ text: `第 ${i} 条事实` }, {})

  const cut = await tools.get('memory_recall').execute({ query: '事实', limit: 3 })
  assert.equal(cut.matched, 12, '前提：命中 12 条，只交出去 3 条')

  const counts = unpack((await callRoute(routes, '/dsh-memory/panel/heat')).query)
  assert.deepEqual(counts.slice(9), [1, 1, 1], '交出去的最新三条各记一次')
  assert.deepEqual(counts.slice(0, 9), new Array(9).fill(0), '压下的九条一笔都不记')
})

test('时间轴要的时间戳逐条给出，不插值', async () => {
  const dir = scratch()
  const { tools, routes } = mount(dir)
  for (let i = 0; i < 3; i++) await tools.get('memory_note').execute({ text: `事实 ${i}` }, {})

  const times = unpack((await callRoute(routes, '/dsh-memory/panel/heat')).times)
  assert.equal(times.length, 3, '一条记录一个时刻——刻度只能锚在真实记录上')
  const now = Math.floor(Date.now() / 1000)
  for (const at of times) assert.ok(Math.abs(at - now) < 120, `${at} 应当就是刚才`)
  assert.ok(times[0] <= times[1] && times[1] <= times[2], '入库钟天然单调')
})

test('打开基底记在那条事实上；人从面板点开与模型走 memory_open 记同一笔', async () => {
  const dir = scratch()
  fs.mkdirSync(path.join(dir, 'memory_handoff'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'memory_handoff', 'origin.md'), '基底原文')
  const { tools, routes } = mount(dir)

  await tools.get('memory_note').execute({ text: '一条提炼', source: 'origin.md' }, {})
  await tools.get('memory_open').execute({ fact: 0 })
  assert.deepEqual(unpack((await callRoute(routes, '/dsh-memory/panel/heat')).open), [1])

  await callRoute(routes, '/dsh-memory/panel/source?name=origin.md&fact=0')
  assert.deepEqual(unpack((await callRoute(routes, '/dsh-memory/panel/heat')).open), [2])

  // 没带 fact 就记不到任何一格上——宁可不记，也不挑一格编上去。
  await callRoute(routes, '/dsh-memory/panel/source?name=origin.md')
  assert.deepEqual(unpack((await callRoute(routes, '/dsh-memory/panel/heat')).open), [2])
})

test('⭐ 用量账是可丢的：整个 HEAT 删掉，记忆一条不少', async () => {
  const dir = scratch()
  const { tools, routes } = mount(dir)
  for (let i = 0; i < 4; i++) await tools.get('memory_note').execute({ text: `事实 ${i}` }, {})
  await tools.get('memory_recall').execute({ query: '事实' })
  assert.ok(fs.existsSync(path.join(dir, 'HEAT')), '前提：账真的落了盘')

  fs.rmSync(path.join(dir, 'HEAT'), { recursive: true })
  const heat = await callRoute(routes, '/dsh-memory/panel/heat')
  assert.deepEqual(heat.inject, {})
  assert.deepEqual(unpack(heat.query), [0, 0, 0, 0], '颜色回到全冷，不是报错')
  const back = await tools.get('memory_recall').execute({ query: '事实' })
  assert.equal(back.records.length, 4, '事实一条不少')
})
