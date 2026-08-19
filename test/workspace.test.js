/**
 * 工作区路由自测：`node --test test/workspace.test.js`。
 *
 * 治的病：记忆库从前绑在 `dsh web` 那个**服务进程的 cwd** 上，那是"你从哪个目录
 * 敲的 dsh"，跟用户在界面里选哪个工作区毫无关系。后果不是帮不上忙，是**主动说
 * 错话**——现场实证过 dsh 自己说"一个工作区都没有"，面板同时报着一万条。
 *
 * ⚠️ 这套病之所以能潜伏这么久，是因为一个坑爹的巧合：会话头里那个字段名就叫
 * `cwd`。做实验时人 `cd` 进工作区再启动，于是 `session.header.cwd` **恰好等于**
 * `process.cwd()`，两个完全不同来源的量碰巧相等，错误绑定看起来一切正常。
 * **要证伪只需挂第二个工作区**——所以本文件里的每一条都至少有两个工作区。
 *
 * 测的四件事：
 *   1. 两个工作区各写各的，互不可见（这条一失守，v2 空闲补漏就会静默串库）。
 *   2. 拿不到工作区时**什么都不给**，且说清楚为什么——不许兜底到某个库。
 *   3. `dataDir` 是逃生口，给了就压过工作区。
 *   4. 官方 `workspaceRegistry` 认规范路径：同一个目录的不同拼法只能开出一个库。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, canonicalWorkspace } from '../lib/index.js'

/** @returns {string} 用完即弃的**工作区**目录（不是数据目录——库由插件自己建）。 */
function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-'))
}

/**
 * 装一份实例。
 *
 * `registry` 就是官方 `ctx.workspaceRegistry` 的替身：一个只有 `list()` 的对象。
 * 官方那份是同步的纯缓存读，所以替身也同步——形状照 `docs/subsystems/workspace.md`。
 *
 * @param {object} [options] - 选项。
 * @param {object} [options.config] - 插件配置。
 * @param {Array<{id: string, path: string, sessionIds: string[]}>} [options.spaces] - 注册表内容。
 * @returns {{ tools: Map<string, any>, routes: Map<string, Function>, wake: Function, logged: string[] }}
 */
function mount(options = {}) {
  const tools = new Map()
  const routes = new Map()
  const logged = []
  let wake = () => ''
  const scoped = {
    get: () => ({ register: (route) => { routes.set(route.path, route.handler); return () => {} } }),
    effect: () => {},
  }
  const registry = options.spaces === undefined ? undefined : { list: () => options.spaces }
  // 服务一律走 `ctx.get(名字)`——`workspaceRegistry` 与 `logger` 都是这么取的。
  const services = { workspaceRegistry: registry, logger: { info: message => logged.push(message) } }
  apply({
    get: name => services[name],
    inject: (_names, ready) => ready(scoped),
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {}, context(def) { wake = def.text } },
  }, { migrate: false, ...options.config })
  return { tools, routes, wake, logged }
}

/** 一个假的工具调用上下文：`execute(args, exec)` 的第二参。 */
function callIn(root, sessionId = 'session-x') {
  return { agent: { session: { id: sessionId, seq: 1, header: { cwd: root } } } }
}

/** 一次路由调用，拿回它写出的 JSON。 */
function callRoute(routes, url) {
  const handler = routes.get(url.split('?')[0])
  assert.equal(typeof handler, 'function', `路由 ${url} 没挂上`)
  return new Promise((resolve) => {
    handler({ url, method: 'GET' }, { writeHead() {}, end: body => resolve(JSON.parse(body)) })
  })
}

test('⭐ 两个工作区各写各的，互不可见', async () => {
  const one = workspace()
  const two = workspace()
  const { tools } = mount()
  const note = tools.get('memory_note')

  await note.execute({ text: '甲工作区的事实' }, callIn(one, 'session-a'))
  await note.execute({ text: '乙工作区的事实一' }, callIn(two, 'session-b'))
  await note.execute({ text: '乙工作区的事实二' }, callIn(two, 'session-b'))

  const fromOne = await tools.get('memory_recall').execute({}, callIn(one, 'session-a'))
  const fromTwo = await tools.get('memory_recall').execute({}, callIn(two, 'session-b'))
  assert.equal(fromOne.total, 1)
  assert.equal(fromTwo.total, 2)
  assert.equal(fromOne.records[0].text, '甲工作区的事实')
  // 库真的落在各自工作区旁边，不是落在进程目录里。
  assert.ok(fs.existsSync(path.join(one, 'dsh_memory', 'LOG.txt')))
  assert.ok(fs.existsSync(path.join(two, 'dsh_memory', 'LOG.txt')))
})

test('⭐ 库不存在就当场建一个——0 条不是"记忆丢了"，是另一个项目', async () => {
  const fresh = workspace()
  const { tools } = mount()
  assert.ok(!fs.existsSync(path.join(fresh, 'dsh_memory')), '装载时不该预热任何库')

  const got = await tools.get('memory_recall').execute({}, callIn(fresh))
  assert.equal(got.total, 0)
  assert.ok(fs.existsSync(path.join(fresh, 'dsh_memory')), '第一次用到才建，建了就该在')
})

test('⛔ 装载时一个库都不开：还没选工作区的实例不该在任何地方建目录', () => {
  const before = workspace()
  const { logged } = mount()
  assert.deepEqual(fs.readdirSync(before), [], '装载不该在任何工作区里留下东西')
  assert.deepEqual(logged, [], '一个库都没开，就没有"当前多少条"可报')
})

test('⛔ 拿不到工作区：工具抛错并说清楚记忆住在哪，不兜底到任何库', async () => {
  const { tools } = mount()
  for (const name of ['memory_note', 'memory_recall', 'memory_zoom', 'memory_open', 'memory_summarize', 'memory_forget']) {
    await assert.rejects(
      async () => tools.get(name).execute({ text: 'x', node: '0-2', fact: 0 }, {}),
      /no workspace/,
      `${name} 在没有工作区时必须抛错`,
    )
  }
})

test('⛔ 拿不到工作区：视图一个字都不注入', () => {
  const { wake } = mount()
  assert.equal(wake({ scope: { session: undefined } }), '')
  assert.equal(wake({}), '')
})

test('⛔ 面板不带 root：如实回"还没选工作区"，不显示任何库', async () => {
  const busy = workspace()
  const { tools, routes } = mount()
  await tools.get('memory_note').execute({ text: '有人在别的工作区写了东西' }, callIn(busy))

  const state = await callRoute(routes, '/dsh-memory/panel/state')
  assert.equal(state.ok, false)
  assert.equal(state.noWorkspace, true)
  assert.match(state.error, /还没选工作区/)
  // ⭐ 病的原形：一万条那次，面板就是在这种时候照报不误。
  assert.equal(state.total, undefined, '没选工作区时连条数都不许报')
})

test('面板带上 root 就看得见那个工作区的塔', async () => {
  const one = workspace()
  const two = workspace()
  const { tools, routes } = mount()
  await tools.get('memory_note').execute({ text: '甲' }, callIn(one, 'session-a'))
  await tools.get('memory_note').execute({ text: '乙一' }, callIn(two, 'session-b'))
  await tools.get('memory_note').execute({ text: '乙二' }, callIn(two, 'session-b'))

  const first = await callRoute(routes, `/dsh-memory/panel/state?root=${encodeURIComponent(one)}`)
  const second = await callRoute(routes, `/dsh-memory/panel/state?root=${encodeURIComponent(two)}`)
  assert.equal(first.total, 1)
  assert.equal(second.total, 2)
  // 后厨认的是规范路径，可能与前端手上那个拼法不同字——所以它自报落在哪。
  assert.equal(first.root, path.join(one, 'dsh_memory'))
})

test('⭐ dataDir 是逃生口：给了就压过工作区，谁来问都是同一个库', async () => {
  const pinned = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pin-'))
  const one = workspace()
  const two = workspace()
  const { tools, routes } = mount({ config: { dataDir: pinned } })

  await tools.get('memory_note').execute({ text: '甲写的' }, callIn(one, 'session-a'))
  await tools.get('memory_note').execute({ text: '乙写的' }, callIn(two, 'session-b'))

  const fromOne = await tools.get('memory_recall').execute({}, callIn(one, 'session-a'))
  assert.equal(fromOne.total, 2, '钉死之后两个工作区写进同一个库')
  assert.ok(!fs.existsSync(path.join(one, 'dsh_memory')), '钉死之后不许在工作区旁边另建库')
  // 面板也一样：钉死时压根不该要 root。
  const state = await callRoute(routes, '/dsh-memory/panel/state')
  assert.equal(state.total, 2)
})

test('⭐ 认官方规范路径：同一个目录的不同拼法只开出一个库', async () => {
  const root = workspace()
  const registered = [{ id: 'w1', path: root, sessionIds: ['session-a'] }]
  const { tools } = mount({ spaces: registered })

  // 前端/会话手上的拼法可能是正斜杠、带尾斜杠——官方的唯一性判据是 realpath 后
  // 的字符串相等，不跟这个口径就会开出两个库（软链更隐蔽）。
  await tools.get('memory_note').execute({ text: '第一条' }, callIn(root, 'session-a'))
  await tools.get('memory_note').execute({ text: '第二条' }, callIn(`${root.replace(/\\/g, '/')}/`, 'session-a'))

  const got = await tools.get('memory_recall').execute({}, callIn(root, 'session-a'))
  assert.equal(got.total, 2, '两种拼法必须落进同一个库')
})

test('⭐ 归属先认名册再认路径——官方口径：真相是 sessionIds，不是从 cwd 反推', () => {
  const spaces = [{ id: 'w1', path: '/srv/alpha', sessionIds: ['session-a'] }]
  const registry = { list: () => spaces }
  // 名册上有这条会话 → 认名册给的规范路径，哪怕 header 里那个拼法不同字。
  assert.equal(
    canonicalWorkspace(registry, { sessionId: 'session-a', cwd: '/srv/alpha/' }),
    '/srv/alpha',
  )
  // 名册上没有（CLI 起的会话还没入册）→ 退回按路径比对。
  assert.equal(
    canonicalWorkspace(registry, { sessionId: 'session-zzz', cwd: '/srv/beta' }),
    '/srv/beta',
  )
  // 没有注册表（极简 profile 根本没装 dsh-workspace）→ 降级用原始拼法，不是失败。
  assert.equal(canonicalWorkspace(undefined, { cwd: '/srv/gamma' }), '/srv/gamma')
  // 注册表出问题也不许让记忆连带失效。
  assert.equal(
    canonicalWorkspace({ list() { throw new Error('还没 active') } }, { cwd: '/srv/delta' }),
    '/srv/delta',
  )
  // 两条线索都空 → 老实说不知道，绝不猜一个。
  assert.equal(canonicalWorkspace(registry, {}), undefined)
})

test('⭐ 视图缓存与聚光灯都跟着库走，不会把甲工作区的画面端给乙', async () => {
  const one = workspace()
  const two = workspace()
  const { tools, wake, routes } = mount()
  await tools.get('memory_note').execute({ text: '只有甲有这句话' }, callIn(one, 'session-a'))
  await tools.get('memory_note').execute({ text: '只有乙有这句话' }, callIn(two, 'session-b'))

  const seenByOne = wake({ scope: { session: { id: 'session-a', header: { cwd: one } } } })
  const seenByTwo = wake({ scope: { session: { id: 'session-b', header: { cwd: two } } } })
  assert.match(seenByOne, /只有甲有这句话/)
  assert.ok(!seenByOne.includes('只有乙'), '甲的视图里不许出现乙的记忆')
  assert.match(seenByTwo, /只有乙有这句话/)

  // 聚光灯同理：甲指过的块，画在乙的塔上就是一个错的高亮。
  await tools.get('memory_recall').execute({ query: '只有甲' }, callIn(one, 'session-a'))
  const first = await callRoute(routes, `/dsh-memory/panel/state?root=${encodeURIComponent(one)}`)
  const second = await callRoute(routes, `/dsh-memory/panel/state?root=${encodeURIComponent(two)}`)
  assert.ok(first.spotlight !== null, '甲刚被指过')
  assert.equal(second.spotlight, null, '乙从没被指过')
})

test('⭐ 每个库第一次落地时各报一次账，行首点名是哪个目录', async () => {
  const one = workspace()
  const two = workspace()
  const { tools, logged } = mount()
  await tools.get('memory_note').execute({ text: '甲' }, callIn(one, 'session-a'))
  await tools.get('memory_note').execute({ text: '乙' }, callIn(two, 'session-b'))

  const counts = logged.filter(line => line.includes('条事实'))
  assert.equal(counts.length, 2, '两个库各报一次，"哪个库有多少条"是分别成立的事实')
  assert.ok(counts.some(line => line.includes(path.join(one, 'dsh_memory'))))
  assert.ok(counts.some(line => line.includes(path.join(two, 'dsh_memory'))))
})
