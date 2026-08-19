/**
 * 挂载名单自测：`node --test test/mounts.test.js`。
 *
 * 这张名单的全部价值是「看得见别的库，且分得清哪些是合成的」。所以测的重点不是
 * 能不能挂上，而是三件容易悄悄出错的事：
 *
 *   1. **合成标记会不会被人填的类别盖掉**——包自报必须最权威，否则把测试包拷个名字
 *      挂进来就变成"真库"，而它的时间戳热度基底全是算出来的。
 *   2. **挂载会不会写到被挂的库里**——承诺是一个字节都不写。
 *   3. **卸载会不会给一个下次重启就复活的假按钮**——约定目录里的东西划不掉，要老实说。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { MOUNTS_FILE, PACKS_DIR, SAMPLE_PACKS_DIR } from '../lib/mounts.js'
import { openDataDir } from '../lib/store.js'

/** @returns {string} 用完即弃的数据目录。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mounts-'))
  openDataDir(dir, { subdirs: ['TREE'], migrate: false })
  return dir
}

/**
 * 造一个"别人的库"：几条事实，可选地自报是合成的。
 * @param {string} where - 目录。
 * @param {number} count - 条数。
 * @param {object} [synthetic] - 自报家门，给了就写进 meta.json。
 * @returns {Promise<string>}
 */
async function foreignLibrary(where, count, synthetic) {
  fs.mkdirSync(where, { recursive: true })
  openDataDir(where, { subdirs: ['TREE'], migrate: false })
  const { tools } = mount(where)
  for (let i = 0; i < count; i++) await tools.get('memory_note').execute({ text: `参照 ${i}` }, {})
  if (synthetic !== undefined) {
    const file = path.join(where, 'meta.json')
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    meta.synthetic = synthetic
    fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n')
  }
  return where
}

/** 装一份完整实例，把工具与面板路由接出来。 */
function mount(dir, extra = {}) {
  const tools = new Map()
  const routes = new Map()
  const scoped = {
    get: () => ({ register: (route) => { routes.set(route.path, route.handler); return () => {} } }),
    effect: () => {},
  }
  apply({
    get: () => undefined,
    inject: (_names, ready) => ready(scoped),
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {}, context() {} },
  }, { dataDir: dir, migrate: false, ...extra })
  return { tools, routes }
}

/** 走一次路由。`body` 给了就走 POST。 */
function callRoute(routes, url, body) {
  const handler = routes.get(url.split('?')[0])
  assert.equal(typeof handler, 'function', `路由 ${url} 没挂上`)
  return new Promise((resolve) => {
    const req = {
      url,
      method: body === undefined ? 'GET' : 'POST',
      on(event, fn) {
        if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body), 'utf8'))
        if (event === 'end') fn()
      },
    }
    handler(req, { writeHead() {}, end(text) { resolve(JSON.parse(text)) } })
  })
}

/**
 * 清单里除掉随包发布的示例库之后剩下的那些。
 *
 * 示例库在任何一个实例上都挂着，所以「挂了几个」这类断言必须先把它们摘掉，否则测的
 * 就不是这个用例造出来的那批库了。**摘的是断言不是行为**——示例库确实在那儿。
 * @param {Array<{ bundled?: boolean }>} packs - 面板清单。
 * @returns {Array<object>}
 */
function others(packs) {
  return packs.filter(pack => pack.bundled !== true)
}

/** 目录里每个文件的 mtime + 大小，用来证明"一个字节都没写"。 */
function snapshot(dir) {
  const out = {}
  const walk = (at, prefix) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      const key = prefix + entry.name
      if (entry.isDirectory()) walk(full, key + '/')
      else out[key] = fs.statSync(full).size + '@' + fs.statSync(full).mtimeMs
    }
  }
  walk(dir, '')
  return out
}

test('⭐ 随包发布的示例库：零配置就挂上，且不往工作区里拷东西', async () => {
  const dir = scratch()
  const before = snapshot(SAMPLE_PACKS_DIR)
  const { routes } = mount(dir)

  const state = await callRoute(routes, '/dsh-memory/panel/state')
  const samples = state.packs.filter(pack => pack.bundled)
  assert.ok(samples.length > 0, '装完就该有得看——不需要建目录、不需要改配置')
  assert.ok(samples.every(pack => pack.total > 0), '每个示例库都读得出条数')
  assert.ok(
    samples.every(pack => pack.dir.startsWith(SAMPLE_PACKS_DIR)),
    '⭐ 示例库住在插件自己的目录里，不是从工作区拷来的',
  )

  // 挨个读一遍：塔的形状、某一块的正文、热度。
  for (const pack of samples) {
    await callRoute(routes, `/dsh-memory/panel/state?pack=${pack.name}`)
    await callRoute(routes, `/dsh-memory/panel/heat?pack=${pack.name}`)
  }
  assert.ok(!fs.existsSync(path.join(dir, PACKS_DIR)), '⭐ 工作区里没多出 packs/ 目录——换个工作区不用再准备一遍')
  assert.deepEqual(snapshot(SAMPLE_PACKS_DIR), before, '⭐ 读了一圈，示例库一个字节都没动')
})

test('⭐ 示例库自报 synthetic，不会被当成真账读', async () => {
  const { routes } = mount(scratch())
  const samples = (await callRoute(routes, '/dsh-memory/panel/state')).packs.filter(pack => pack.bundled)
  // 合成数长得跟真账一模一样，不点名就会被当真账读——所以判据必须长在包身上。
  assert.ok(samples.every(pack => pack.synthetic !== null), '每个示例库都得自报是合成的')
})

test('⛔ 示例库卸不掉，且说清为什么——它不住在你的工作区里', async () => {
  const { routes } = mount(scratch())
  const state = await callRoute(routes, '/dsh-memory/panel/state')
  const sample = state.packs.find(pack => pack.bundled)
  assert.equal(sample.removable, false)

  const gone = await callRoute(routes, '/dsh-memory/panel/mounts', { remove: sample.name })
  assert.equal(gone.ok, false)
  assert.match(gone.error, /自带/)
  assert.ok(gone.packs.some(pack => pack.name === sample.name), '拒绝之后它还在，界面不会骗人')
})

test('约定目录 packs/ 下的库自动挂上，且默认按合成测试包对待', async () => {
  const dir = scratch()
  await foreignLibrary(path.join(dir, PACKS_DIR, 'borrowed-50'), 3)
  const { routes } = mount(dir)

  const state = others(await callRoute(routes, '/dsh-memory/panel/state').then(body => body.packs))
  assert.equal(state.length, 1, '扔进约定目录就该被扫到，不用任何配置')
  assert.equal(state[0].name, 'borrowed-50')
  assert.equal(state[0].total, 3)
  assert.ok(state[0].synthetic !== null, '住在 packs/ 下＝按合成测试包对待')
})

test('⭐ 包自报 synthetic 压过人填的类别：拷个名字挂进来也变不成真库', async () => {
  const dir = scratch()
  const outside = await foreignLibrary(path.join(dir, '..', path.basename(dir) + '-ref'), 2, {
    note: '合成测试包：时间戳、热度、基底均为算法生成',
  })
  const { routes } = mount(dir)

  // 人手填的时候明说「这是真库」（synthetic: false）——包自报仍然作数。
  const added = await callRoute(routes, '/dsh-memory/panel/mounts', { dir: outside, synthetic: false })
  assert.equal(added.ok, true, added.error)
  const mine = others(added.packs)
  assert.equal(mine.length, 1)
  assert.ok(mine[0].synthetic !== null, '⭐ 判据长在包身上，不长在挂载表单里')
  assert.match(mine[0].synthetic.note, /算法生成/)
})

test('挂载写在本库的名单里，被挂的库一个字节都不写', async () => {
  const dir = scratch()
  const outside = await foreignLibrary(path.join(dir, '..', path.basename(dir) + '-ro'), 2)
  const before = snapshot(outside)

  const { routes } = mount(dir)
  const added = await callRoute(routes, '/dsh-memory/panel/mounts', { dir: outside, synthetic: true })
  assert.equal(added.ok, true, added.error)
  const name = others(added.packs)[0].name
  await callRoute(routes, `/dsh-memory/panel/state?pack=${name}`)
  await callRoute(routes, `/dsh-memory/panel/heat?pack=${name}`)

  assert.deepEqual(snapshot(outside), before, '⭐ 读了一圈，被挂的库一个字节没动')
  const list = JSON.parse(fs.readFileSync(path.join(dir, MOUNTS_FILE), 'utf8'))
  assert.equal(list.length, 1, '名单落在本库自己的数据目录里')
  assert.equal(path.resolve(list[0].dir), path.resolve(outside))
})

test('名单能重启后复原：新实例读同一份 mounts.json', async () => {
  const dir = scratch()
  const outside = await foreignLibrary(path.join(dir, '..', path.basename(dir) + '-keep'), 5)
  {
    const { routes } = mount(dir)
    const added = await callRoute(routes, '/dsh-memory/panel/mounts', { dir: outside })
    assert.equal(added.ok, true, added.error)
  }
  const { routes } = mount(dir) // ← 相当于重启
  const state = await callRoute(routes, '/dsh-memory/panel/state')
  const kept = others(state.packs)
  assert.equal(kept.length, 1, '重启后还挂着')
  assert.equal(kept[0].total, 5)
})

test('父目录一次挂一批：指到装着若干个库的文件夹', async () => {
  const dir = scratch()
  const parent = path.join(dir, '..', path.basename(dir) + '-many')
  await foreignLibrary(path.join(parent, 'a'), 2)
  await foreignLibrary(path.join(parent, 'b'), 3)
  const { routes } = mount(dir)

  const added = await callRoute(routes, '/dsh-memory/panel/mounts', { dir: parent })
  assert.equal(added.ok, true, added.error)
  assert.deepEqual(others(added.packs).map(p => p.name).sort(), ['a', 'b'], '一次填一个父目录，两个库都上来了')

  // ⛔ 曾经名单里记的是父目录本身，于是每个库的 dir 都对不上名单：`removable` 全成
  //   false，卸载还会理直气壮地说「它在 packs/ 约定目录或 profile 里」——那是假话。
  //   挂一个装着六个包的父目录时撞见：六个全卸不掉。
  assert.ok(others(added.packs).every(p => p.removable), '⛔ 从面板挂的就得卸得掉，填的是父目录也一样')
  const gone = await callRoute(routes, '/dsh-memory/panel/mounts', { remove: 'a' })
  assert.equal(gone.ok, true, gone.error)
  assert.deepEqual(others(gone.packs).map(p => p.name), ['b'], '一次挂一批，但卸的时候一个是一个，不绑成一捆')
})

test('⛔ 约定目录里的库卸不掉，且老实说明原因——不给一个重启就复活的假按钮', async () => {
  const dir = scratch()
  await foreignLibrary(path.join(dir, PACKS_DIR, 'fixture'), 2)
  const { routes } = mount(dir)

  const gone = await callRoute(routes, '/dsh-memory/panel/mounts', { remove: 'fixture' })
  assert.equal(gone.ok, false)
  assert.match(gone.error, /约定目录|profile/)
  assert.equal(others(gone.packs).length, 1, '拒绝之后它还在，界面不会骗人')
})

test('面板挂上来的卸得掉，且只从名单上划掉、不碰那个目录', async () => {
  const dir = scratch()
  const outside = await foreignLibrary(path.join(dir, '..', path.basename(dir) + '-drop'), 2)
  const { routes } = mount(dir)
  const added = await callRoute(routes, '/dsh-memory/panel/mounts', { dir: outside })
  const name = others(added.packs)[0].name
  assert.equal(others(added.packs)[0].removable, true)

  const gone = await callRoute(routes, '/dsh-memory/panel/mounts', { remove: name })
  assert.equal(gone.ok, true, gone.error)
  assert.equal(others(gone.packs).length, 0)
  assert.ok(fs.existsSync(path.join(outside, 'LOG.txt')), '卸载只动名单，那个库还好好的')
})

test('挂一个不是记忆库的路径：当场说清怎么算库，不静默失败', async () => {
  const dir = scratch()
  const { routes } = mount(dir)
  const nope = await callRoute(routes, '/dsh-memory/panel/mounts', { dir: os.tmpdir() + '/dsh-not-a-library-xyz' })
  assert.equal(nope.ok, false)
  assert.match(nope.error, /LOG\.txt/)
})

test('坏掉的 mounts.json 不许把面板拖垮：按空名单处理，文件不动', async () => {
  const dir = scratch()
  fs.writeFileSync(path.join(dir, MOUNTS_FILE), '{ 这不是 JSON')
  const { routes } = mount(dir)
  const state = await callRoute(routes, '/dsh-memory/panel/state')
  assert.deepEqual(others(state.packs), [], '名单是可丢的便签，不是账本')
  assert.equal(fs.readFileSync(path.join(dir, MOUNTS_FILE), 'utf8'), '{ 这不是 JSON', '没去"修"它')
})
