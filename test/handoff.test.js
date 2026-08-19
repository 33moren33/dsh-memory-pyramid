/**
 * 出生册（memory_handoff）自测：`node --test test/handoff.test.js`。
 *
 * 入口＝文件夹本身（没有写入工具）：放文件＝上架。只测会悄悄变坏的地方：
 * 巡架补登的幂等、锚点字段的宽度与合法性、「先有原文后有指针」、
 * memory_open 三种锚的分流、待导入提醒的集合减法、改动检测。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import {
  fitShelfName, listShelf, pendingImports, readJournal, shelfNameFromAnchor,
  shelfPath, sweepShelf,
} from '../lib/handoff.js'
import { FixedWidthLog } from '../lib/log.js'
import { openDataDir } from '../lib/store.js'

/** @returns {string} 用完即弃的数据目录。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-'))
  openDataDir(dir, { subdirs: ['TREE'], migrate: false })
  return dir
}

/**
 * 手动上架：往出生册文件夹里放一个文件——用户就是这么干的。
 * @param {string} dir - 数据目录。
 * @param {string} name - 文件名。
 * @param {string} content - 内容。
 */
function place(dir, name, content) {
  fs.mkdirSync(shelfPath(dir), { recursive: true })
  fs.writeFileSync(path.join(shelfPath(dir), name), content)
}

/**
 * 装出一个只有工具面的插件实例。
 * @param {string} dir - 数据目录。
 * @returns {Map<string, any>} name → tool。
 */
function mountedTools(dir) {
  const tools = new Map()
  const ctx = {
    get: () => undefined,
    inject: () => {},
    tools: { register: t => tools.set(t.name, t) },
    systemPrompt: { section: () => {}, context: () => {} },
  }
  apply(ctx, { dataDir: dir, migrate: false })
  return tools
}

/**
 * 装一份带面板的实例，把注册出来的路由接住。
 * @param {string} dir - 数据目录。
 * @returns {Map<string, Function>} path → handler。
 */
function mountPanelRoutes(dir) {
  const routes = new Map()
  const scoped = {
    get: () => ({ register: (route) => { routes.set(route.path, route.handler); return () => {} } }),
    effect: () => {},
  }
  apply({
    get: () => undefined,
    inject: (_names, ready) => ready(scoped),
    tools: { register: () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
  }, { dataDir: dir, migrate: false })
  return routes
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

test('巡架补登：手动放入的文件登上流水，幂等不重记，点文件不算快照', () => {
  const dir = scratch()
  place(dir, 'a.md', '甲')
  place(dir, 'b.md', '乙')
  const first = sweepShelf(dir)
  assert.deepEqual(first.registered.map(r => r.name).sort(), ['a.md', 'b.md'])
  assert.equal(first.invalid.length, 0)
  const journal = readJournal(dir)
  assert.ok(journal.get('a.md').sha.length === 16)
  assert.ok(journal.get('a.md').mtime !== '')
  const second = sweepShelf(dir)
  assert.equal(second.registered.length, 0)
  assert.ok(!listShelf(dir).includes('.journal'))
})

test('名字校验：路径件/非 ASCII/超宽拒绝，41 字符放行；巡架把非法名点出来', () => {
  assert.throws(() => fitShelfName('a/b.md'), /no path parts/)
  assert.throws(() => fitShelfName('..'), /no path parts/)
  assert.throws(() => fitShelfName('笔记.md'), /ASCII only/)
  assert.throws(() => fitShelfName('x'.repeat(42)), /holds 41/)
  assert.equal(fitShelfName('x'.repeat(41)), 'x'.repeat(41))

  const dir = scratch()
  place(dir, '中文名.md', '内容')
  const swept = sweepShelf(dir)
  assert.equal(swept.registered.length, 0)
  assert.equal(swept.invalid[0].name, '中文名.md')
  assert.deepEqual(pendingImports(dir, new Set()), [])
})

test('note 带 source：锚落 sid 字段，盘上可回读；不存在的 source 当场拒绝', async () => {
  const dir = scratch()
  place(dir, 'origin.md', '原文全文')
  const tools = mountedTools(dir)

  await tools.get('memory_note').execute({ text: '一条提炼', source: 'origin.md' }, {})
  const record = new FixedWidthLog(dir).read(0)
  assert.equal(record.sessionId, 'md:origin.md')
  assert.equal(shelfNameFromAnchor(record.sessionId), 'origin.md')
  assert.equal(record.seqLo, 0)
  assert.equal(record.seqHi, 0)

  await assert.rejects(
    async () => tools.get('memory_note').execute({ text: '指向不存在的原文', source: 'ghost.md' }, {}),
    /no snapshot named 'ghost.md'/,
  )
})

test('待导入提醒：集合减法，回执点名，导完即静默', async () => {
  const dir = scratch()
  place(dir, 'a.md', '甲文')
  place(dir, 'b.md', '乙文')
  const tools = mountedTools(dir)

  const first = await tools.get('memory_note').execute({ text: '甲的提炼', source: 'a.md' }, {})
  assert.equal(first.dueImport.count, 1)
  assert.deepEqual(first.dueImport.names, ['b.md'])
  const rendered = tools.get('memory_note').output.render({}, first)[0].text
  assert.match(rendered, /1 imported text\(s\) on the shelf have no memories yet: b\.md/)

  const second = await tools.get('memory_note').execute({ text: '乙的提炼', source: 'b.md' }, {})
  assert.equal(second.dueImport, undefined)
})

test('memory_open：按 fact 顺锚开原文；无锚与会话锚各给诚实的错', async () => {
  const dir = scratch()
  place(dir, 'origin.md', '原文全文，细节都在这里。')
  const tools = mountedTools(dir)

  await tools.get('memory_note').execute({ text: '带锚的', source: 'origin.md' }, {})
  await tools.get('memory_note').execute({ text: '无锚的' }, {})
  await tools.get('memory_note').execute(
    { text: '会话锚的' },
    { agent: { session: { id: 'session-0000-0000', seq: 7 } } },
  )

  const opened = await tools.get('memory_open').execute({ fact: 0 })
  assert.equal(opened.name, 'origin.md')
  assert.equal(opened.truncated, false)
  assert.notEqual(opened.tampered, true)
  assert.match(opened.text, /细节都在这里/)

  await assert.rejects(async () => tools.get('memory_open').execute({ fact: 1 }), /carries no anchor/)
  await assert.rejects(async () => tools.get('memory_open').execute({ fact: 2 }), /anchored to a conversation/)
  await assert.rejects(async () => tools.get('memory_open').execute({ fact: 99 }), /no fact #99/)
  await assert.rejects(async () => tools.get('memory_open').execute({}), /give `fact`.*or `source`/)
})

test('memory_open 超长快照整齐收口，不吐半个 UTF-8 字符', async () => {
  const dir = scratch()
  place(dir, 'big.md', '汉'.repeat(9000)) // 27000 字节 > 20000
  const tools = mountedTools(dir)
  const opened = await tools.get('memory_open').execute({ source: 'big.md' })
  assert.equal(opened.truncated, true)
  assert.ok(Buffer.byteLength(opened.text) <= 20000)
  assert.ok(!opened.text.includes('\uFFFD'))
})

test('改动检测：上架后被就地编辑的快照，open 点破而不是照吐', async () => {
  const dir = scratch()
  place(dir, 'origin.md', '入册时的版本')
  const tools = mountedTools(dir)
  // 巡架（指纹入流水）发生在**这个库第一次被用到**的时候，不是装载的时候——
  // 记忆按工作区分库之后，装载那一刻还不知道会用到哪个库，也不该去建目录。
  // 所以先随便读一下把库开起来，再改文件，才是这条断言想验的那个先后。
  await tools.get('memory_recall').execute({})
  fs.writeFileSync(path.join(shelfPath(dir), 'origin.md'), '事后被改过的版本')

  const opened = await tools.get('memory_open').execute({ source: 'origin.md' })
  assert.equal(opened.tampered, true)
  const rendered = tools.get('memory_open').output.render({}, opened)[0].text
  assert.match(rendered, /WARNING: 'origin\.md' no longer matches its check-in record/)
})

test('⭐ 面板也够得着基底：/panel/source 交出架上原文，改过的照样点破', async () => {
  const dir = scratch()
  place(dir, 'origin.md', '基底原文，' + '细节'.repeat(9000)) // 远超模型那 20000 字节的收口值
  const routes = mountPanelRoutes(dir)

  const got = await callRoute(routes, '/dsh-memory/panel/source?name=origin.md')
  assert.equal(got.ok, true)
  assert.equal(got.name, 'origin.md')
  assert.equal(got.tampered, false)
  // 人在面板里滚动看不花阅读预算，所以不掐——那个上限是给模型留的。
  assert.equal(got.text.length, '基底原文，'.length + '细节'.repeat(9000).length, '整份交出，不截断')

  const missing = await callRoute(routes, '/dsh-memory/panel/source?name=ghost.md')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /架上没有名为 'ghost\.md' 的快照/)

  fs.writeFileSync(path.join(shelfPath(dir), 'origin.md'), '事后被改过的版本')
  const edited = await callRoute(routes, '/dsh-memory/panel/source?name=origin.md')
  assert.equal(edited.tampered, true, '拦不住有人改架上的文件，但改过必须被看见')
})

test('⭐ recall 被截断时自报截断：不给一个自洽到无从起疑的数', async () => {
  const dir = scratch()
  const tools = mountedTools(dir)
  for (let i = 0; i < 12; i++) await tools.get('memory_note').execute({ text: `第 ${i} 条事实` }, {})

  const cut = await tools.get('memory_recall').execute({ query: '事实', limit: 3 })
  assert.equal(cut.matched, 12, '命中总数如实回报')
  assert.equal(cut.records.length, 3)
  const shortened = tools.get('memory_recall').output.render({}, cut)[0].text
  assert.match(shortened, /Newest 3 of 12 matches/)
  assert.match(shortened, /9 older matches are not shown/)

  const whole = await tools.get('memory_recall').execute({ query: '事实' })
  const complete = tools.get('memory_recall').output.render({}, whole)[0].text
  assert.ok(!/not shown/.test(complete), '没截断就别喊截断')

  // 区间读取是同一个病的另一半：旧写法 slice(-limit) 也会悄悄扔掉前面的。
  const ranged = await tools.get('memory_recall').execute({ from: 0, to: 12, limit: 2 })
  assert.equal(ranged.matched, 12)
  assert.match(tools.get('memory_recall').output.render({}, ranged)[0].text, /Newest 2 of 12/)
})

test('⭐ 正则编译不了就直说，不要静默当成零命中', async () => {
  const tools = mountedTools(scratch())
  await tools.get('memory_note').execute({ text: '用 C++ 写的' }, {})
  // 与 memory_open 同一个约定：参数不成立当场抛，不做成一个空结果。
  assert.throws(
    () => tools.get('memory_recall').execute({ query: 'C++' }),
    /regular expression, and this one does not compile/,
  )
  const escaped = await tools.get('memory_recall').execute({ query: 'C\\+\\+' })
  assert.equal(escaped.matched, 1)
})

test('recall 渲染带出文本锚，模型看得见才跟得过去', async () => {
  const dir = scratch()
  place(dir, 'origin.md', '原文')
  const tools = mountedTools(dir)
  await tools.get('memory_note').execute({ text: '带锚', source: 'origin.md' }, {})
  await tools.get('memory_note').execute({ text: '无锚' }, {})

  const value = await tools.get('memory_recall').execute({ from: 0, to: 2 })
  const rendered = tools.get('memory_recall').output.render({}, value)[0].text
  assert.match(rendered, /#0 .* 带锚 \[source: origin\.md\]/)
  assert.ok(!/#1 .* 无锚 \[source/.test(rendered))
})
