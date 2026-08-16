/**
 * 零依赖自测：`node --test test/memory.test.js`。
 *
 * 只测「算错了不会报错、只会悄悄变笨」的地方：覆盖挑选的完整性与预算、
 * 稠密前缀这条不变量、连坐丢弃、以及定宽日志的一次寻址与崩溃修复。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, pickFrozenWake } from '../lib/index.js'
import { FixedWidthLog, RECORD_SIZE } from '../lib/log.js'
import { cover, nodeName, parseNode, Pyramid, tile, TREE_REC } from '../lib/pyramid.js'
import { openDataDir } from '../lib/store.js'

/**
 * 开一个用完即弃的数据目录。
 * @returns {string} 目录路径。
 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-'))
  openDataDir(dir, { subdirs: ['TREE'], migrate: false })
  return dir
}

/**
 * 造一份写满事实、并把所有欠账都补上的记忆。
 * @param {number} n - 事实条数。
 * @returns {{ dir: string, log: FixedWidthLog, pyramid: Pyramid }}
 */
function filled(n) {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  const pyramid = new Pyramid(dir)
  for (let i = 0; i < n; i++) log.append({ text: `事实 ${i}` })
  for (const [lo, hi] of pyramid.pending(n)) pyramid.put(lo, hi, `摘要 ${nodeName(lo, hi)}`)
  return { dir, log, pyramid }
}

/**
 * 断言一组块首尾相接地盖满 [0,T)，无缝也无叠。
 * @param {Array<[number, number]>} blocks - 块。
 * @param {number} T - 记录总数。
 * @returns {void}
 */
function assertCovers(blocks, T) {
  let cursor = 0
  for (const [lo, hi] of blocks) {
    assert.equal(lo, cursor, `块 ${lo}-${hi - 1} 与前一块之间有缝或重叠`)
    cursor = hi
  }
  assert.equal(cursor, T, '必须一直盖到 T')
}

test('覆盖永远盖满全部历史，从不截断', () => {
  // 预算远小于记录数时，老记忆只会变粗，不会消失。
  for (const T of [1, 2, 7, 40, 64, 1000, 4097]) {
    const blocks = cover(T, 96)
    assertCovers(blocks, T)
    assert.ok(blocks.length <= 96, `T=${T} 时用了 ${blocks.length} 行，超预算`)
  }
})

test('装得下就一点不压缩', () => {
  const blocks = cover(40, 96)
  assert.equal(blocks.length, 40)
  assert.ok(blocks.every(([lo, hi]) => hi - lo === 1), 'T ≤ 预算时必须全是原文')
})

test('装不下时越老越粗，最近的仍是原文', () => {
  const blocks = cover(1000, 96)
  assertCovers(blocks, 1000)
  assert.equal(blocks.at(-1)[1] - blocks.at(-1)[0], 1, '最新的一块必须是单条原文')
  assert.ok(
    blocks[0][1] - blocks[0][0] > blocks.at(-1)[1] - blocks.at(-1)[0],
    '最老的一块必须比最新的粗',
  )
  // 粗细应当单调不增：越靠近现在越细。
  let previous = Infinity
  for (const [lo, hi] of blocks) {
    const size = hi - lo
    assert.ok(size <= previous, `块 ${lo}-${hi - 1} 比它前面的还粗，粗细不单调`)
    previous = size
  }
})

test('预算花得尽：把余额用在最近处', () => {
  // 光靠 alpha 会低于预算（块大小按 2 的幂跳），补细分之后应当贴着预算。
  const blocks = cover(5000, 96)
  assert.ok(blocks.length > 96 - 2, `只用了 ${blocks.length} 行，预算 96 没花掉`)
  assert.ok(blocks.length <= 96)
})

test('alpha 越大越粗', () => {
  const fine = tile(1024, 0.05).length
  const coarse = tile(1024, 0.5).length
  assert.ok(coarse < fine, `alpha 大反而更细：${coarse} vs ${fine}`)
})

test('稠密前缀：待办由层文件长度推出，不需要单独的队列', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  const pyramid = new Pyramid(dir)
  for (let i = 0; i < 8; i++) log.append({ text: `f${i}` })

  // 8 条 → 第 2 层 4 块、第 4 层 2 块、第 8 层 1 块 = 7 块待办，最小的在前。
  assert.deepEqual(pyramid.pending(8), [[0, 2], [2, 4], [4, 6], [6, 8], [0, 4], [4, 8], [0, 8]])
  assert.equal(pyramid.pendingCount(8), 7)

  pyramid.put(0, 2, 'a')
  assert.equal(pyramid.pendingCount(8), 6)
  assert.equal(pyramid.have(2), 1)
  // 层文件就是一份稠密前缀：一条记录一块。
  assert.equal(fs.statSync(pyramid.levelPath(2)).size, TREE_REC)
  assert.equal(pyramid.get(0, 2), 'a')
  assert.equal(pyramid.get(2, 4), undefined)
})

test('乱序写被拒绝，稠密前缀不能有洞', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  const pyramid = new Pyramid(dir)
  for (let i = 0; i < 4; i++) log.append({ text: `f${i}` })

  assert.equal(pyramid.put(2, 4, '跳着写'), false, '第 0 块还没写，不该收下第 1 块')
  assert.equal(pyramid.have(2), 0)
  assert.equal(pyramid.put(0, 2, '按顺序'), true)
  assert.equal(pyramid.put(2, 4, '现在可以了'), true)
  assert.equal(pyramid.get(2, 4), '现在可以了')
})

test('丢弃一块摘要会连坐所有由它建起来的块，但原文一条不动', () => {
  const { log, pyramid } = filled(8)
  assert.equal(pyramid.pendingCount(8), 0)

  const names = pyramid.drop(2, 4).map(([lo, hi]) => nodeName(lo, hi))
  assert.ok(names.includes('2-3'), '被点名的那块要没')
  assert.ok(names.includes('0-3'), '由它建起来的 #0-3 也要没')
  assert.ok(names.includes('0-7'), '再上一层的 #0-7 同样要没')
  assert.equal(pyramid.get(0, 2), '摘要 0-1', '同层更早的块不受影响')
  assert.equal(log.count(), 8, '原文一条都不能少')
  assert.ok(pyramid.pendingCount(8) > 0, '丢掉的块必须重新变成待办')
})

test('摘要缺失时拒绝渲染并点名那一块，绝不显示一块不存在的摘要', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  const pyramid = new Pyramid(dir)
  for (let i = 0; i < 8; i++) log.append({ text: `f${i}` })
  pyramid.put(0, 2, '只写了这一块')

  const { blocks, missing } = pyramid.expand(log, 8, 4)
  assert.notEqual(missing, undefined, '必须点名缺的那一块，而不是默默绕开或拆细')
  assert.equal(pyramid.get(missing[0], missing[1]), undefined, '点名的那一块必须真的没有摘要')
  assert.ok(missing[1] - missing[0] >= 2, '点名的必须是需要摘要的块，不是单条原文')
  for (const block of blocks) {
    if (block.raw) continue
    assert.notEqual(pyramid.get(block.lo, block.hi), undefined, `#${nodeName(block.lo, block.hi)} 必须真的存在`)
  }
})

test('⭐ 预算是硬的：欠债再多也不超行数，而不是铺成原文', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  for (let i = 0; i < 400; i++) log.append({ text: `事实 ${i}` })
  // 一条摘要都不写。旧实现会就地拆细，铺出 400 行（预算 96）——四倍超支且无上限，
  // 正好是「记忆再多、读它的成本恒定」这句承诺要防的那件事。
  const empty = new Pyramid(dir)
  const a = empty.expand(log, 400, 96)
  assert.notEqual(a.missing, undefined, '缺摘要必须报出来')
  assert.ok(a.blocks.length <= 96, `实际 ${a.blocks.length} 行，预算 96`)

  // 债还清之后，正好用满预算且盖满全程。
  for (const [lo, hi] of empty.pending(400)) empty.put(lo, hi, `摘要 ${nodeName(lo, hi)}`)
  const b = empty.expand(log, 400, 96)
  assert.equal(b.missing, undefined)
  assert.ok(b.blocks.length <= 96, `实际 ${b.blocks.length} 行，预算 96`)
  assertCovers(b.blocks.map(x => [x.lo, x.hi]), 400)
})

test('节点名与区间双向一致，且拒绝不对齐的区间', () => {
  for (const [lo, hi] of [[0, 1], [0, 2], [10, 12], [64, 128]]) {
    const parsed = parseNode(nodeName(lo, hi))
    assert.equal(parsed.lo, lo)
    assert.equal(parsed.hi, hi)
  }
  assert.equal(nodeName(0, 4), '0-3')
  assert.equal(nodeName(64, 128), '64-127')
  assert.equal(parseNode('#0-3').lo, 0, '带 # 前缀也要认')
  assert.throws(() => parseNode('0-2'), /not a real block/) // 长度不是 2 的幂
  assert.throws(() => parseNode('1-2'), /not a real block/) // 长度对但没对齐
  assert.throws(() => parseNode('nope'), /must look like/)
})

test('定宽日志：位置即身份，一次寻址', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  for (let i = 0; i < 50; i++) {
    log.append({ text: `事实 ${i}`, sessionId: `sess-${i}`, seqLo: i * 2, seqHi: i * 2 })
  }
  // 文件长度恰好是条数 × 定宽——这条等式就是 O(1) 寻址的全部依据。
  assert.equal(fs.statSync(path.join(dir, 'LOG.txt')).size, 50 * RECORD_SIZE)

  const record = log.read(37)
  assert.equal(record.seq, 37)
  assert.equal(record.text, '事实 37')
  assert.equal(record.sessionId, 'sess-37')
  assert.equal(record.seqLo, 74)
  assert.equal(log.read(50), undefined)
  assert.deepEqual(log.search('事实 4', 3).map(h => h.seq), [49, 48, 47], '搜索由新到旧')
})

test('中文按字节计数，不按字符', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  const text = '一'.repeat(93) // 279 字节，正好在 280 之内
  log.append({ text })
  assert.equal(log.read(0).text, text)
})

test('崩溃留下的半条记录被掐掉，而不是让此后每条都错位', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  log.append({ text: '完整的一条' })
  fs.appendFileSync(path.join(dir, 'LOG.txt'), 'crash')

  const revived = new FixedWidthLog(dir)
  assert.equal(revived.repaired, 5, '要如实报告掐掉了几字节')
  assert.equal(revived.count(), 1)
  assert.equal(revived.read(0).text, '完整的一条', '已确认的记录必须完好')
  revived.append({ text: '接着写' })
  assert.equal(revived.read(1).text, '接着写', '修复后偏移必须回到正轨')
})

test('OptMem 的记忆库被认出来并拒绝，绝不对它动刀', () => {
  // 一份 OptMem 的 LOG：320 字节定宽，与我们的 384 混读会整体错位。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optmem-'))
  fs.mkdirSync(path.join(dir, 'TREE'))
  const record = (i, text) => Buffer.concat([
    Buffer.from(`#${i} 2026-08-15 ${text}`.padEnd(319, ' '), 'utf8').subarray(0, 319),
    Buffer.from('\n'),
  ])
  fs.writeFileSync(path.join(dir, 'LOG.txt'), Buffer.concat([record(0, 'first'), record(1, 'second')]))
  assert.equal(fs.statSync(path.join(dir, 'LOG.txt')).size, 640)

  // 目录里只有 LOG.txt 和 TREE，正好落在「看起来是本插件残留」那条分支上
  // ——必须改口，而不是建议人家补 meta.json 来接管。
  assert.throws(() => openDataDir(dir, { migrate: false }), /OptMem/)
  assert.throws(() => openDataDir(dir, { migrate: false }), /不要手工补 meta\.json/)

  // 就算有人硬绕过目录检查，日志层也必须拒绝——否则 repair 会掐掉 383 字节，
  // 也就是别人一到两条真实记忆。
  assert.throws(() => new FixedWidthLog(dir), /OptMem/)
  assert.equal(fs.statSync(path.join(dir, 'LOG.txt')).size, 640, '一个字节都不许动')
})

test('数据目录：已存在就认领，绝不静默覆盖', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  log.append({ text: '开张第一条' })

  const again = openDataDir(dir, { subdirs: ['TREE'], migrate: false })
  assert.equal(again.status, 'adopted')
  assert.equal(new FixedWidthLog(dir).count(), 1)

  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-'))
  fs.writeFileSync(path.join(foreign, 'important.txt'), 'someone else lives here')
  assert.throws(() => openDataDir(foreign, { migrate: false }), /拒绝在别人的目录上写入/)
  assert.ok(fs.existsSync(path.join(foreign, 'important.txt')), '别人的文件必须完好无损')

  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'))
  fs.writeFileSync(path.join(other, 'meta.json'), JSON.stringify({ kind: 'something-else', version: 1 }))
  assert.throws(() => openDataDir(other, { migrate: false }), /拒绝接管/)
})

test('序号不入盘：两个写者交替追加，编号仍然连续无重复', () => {
  const dir = scratch()
  // 两个独立实例 = headless 模式下两个 dsh 进程共写一个工作区。
  // 旧格式在这里会写出重复的 seq（各自先 stat 再写）；现在序号由位置决定，
  // 盘上根本没有可以写错的那个字段。
  const a = new FixedWidthLog(dir)
  const b = new FixedWidthLog(dir)
  for (let i = 0; i < 8; i++) {
    a.append({ text: `A${i}` })
    b.append({ text: `B${i}` })
  }
  assert.equal(fs.statSync(path.join(dir, 'LOG.txt')).size, 16 * RECORD_SIZE)
  const all = a.readRange(0, 16)
  assert.deepEqual(all.map(r => r.seq), [...Array(16).keys()], '编号严格等于位置')
  assert.deepEqual(all.map(r => r.text), ['A0', 'B0', 'A1', 'B1', 'A2', 'B2', 'A3', 'B3',
    'A4', 'B4', 'A5', 'B5', 'A6', 'B6', 'A7', 'B7'], '两个写者的记录都完好，无交错无覆盖')
})

test('真实长度的会话 id 完整存下；装不下时留空而不是留半截', () => {
  const dir = scratch()
  const log = new FixedWidthLog(dir)
  // dsh 真机上的形状：`session-` + uuid = 44 字符。第一次实测时字段只有 32 字节，
  // 每条记录都存下一个被切掉 12 字符的 id——照样像 id，却指不回任何目录。
  const real = 'session-cafa66e3-309b-472b-8c66-f22167a54730'
  assert.equal(real.length, 44)
  log.append({ text: '带真实会话指针的一条', sessionId: real, seqLo: 302, seqHi: 302 })
  assert.equal(log.read(0).sessionId, real, '会话指针必须逐字完整，截断等于作废')

  log.append({ text: '指针装不下的一条', sessionId: `${real}-and-then-some` })
  assert.equal(log.read(1).sessionId, '', '装不下就留空——半截 id 是会骗人的死指针')
  assert.equal(log.read(1).text, '指针装不下的一条', '正文不受影响')
})

test('数据目录自带 .gitattributes，但绝不覆盖已有的那份', () => {
  const dir = scratch()
  const file = path.join(dir, '.gitattributes')
  // core.autocrlf 是在 checkout 时改磁盘文件的，跟我们用什么 API 写无关。
  // 定宽记录每行多一个字节就全盘错位，且读出来仍像数据。
  assert.match(fs.readFileSync(file, 'utf8'), /^LOG\.txt -text$/m)

  fs.writeFileSync(file, '# 用户自己写的\n')
  openDataDir(dir, { subdirs: ['TREE'], migrate: false })
  assert.equal(fs.readFileSync(file, 'utf8'), '# 用户自己写的\n', '别人的文件一个字节都不动')
})

/**
 * 装一份插件，把注册出来的工具拿到手。
 * @returns {{ tools: Map<string, any>, dir: string }}
 */
function mounted() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-'))
  const tools = new Map()
  apply({
    get: name => (name === 'logger' ? { info() {} } : undefined),
    systemPrompt: { section() {}, context() {} },
    tools: { register(def) { tools.set(def.name, def) } },
  }, { dataDir: dir })
  return { tools, dir }
}

test('⭐ 还债必须按全局顺序：塔基没压完，不许先盖塔身', async () => {
  const { tools, dir } = mounted()
  const note = tools.get('memory_note')
  const summarize = tools.get('memory_summarize')
  const exec = { agent: { session: { id: 'session-test', seq: 1 } } }
  for (let i = 0; i < 4; i++) await note.execute({ text: `事实 ${i}` }, exec)

  // 4 条事实的全局顺序是 #0-1 → #2-3 → #0-3。
  // 旧实现只校验「本层的下一块」，于是 #0-3（层 4 的第一块）会被放行——
  // 塔基还空着，塔身先盖上去了。OptMem 的 cmd_nap 不允许，我们现在也不允许。
  // 校验是同步抛的（dsh 会把它归一化成 isError 结果），
  // 所以这里用 assert.throws —— assert.rejects 不接同步抛出。
  assert.throws(
    () => summarize.execute({ node: '0-3', text: '越级压缩' }),
    /wrong node[\s\S]*#0-1/,
    '跨层抢跑必须被拒，并点名下一块是谁',
  )

  await summarize.execute({ node: '0-1', text: '前两条' })
  await summarize.execute({ node: '2-3', text: '后两条' })
  const done = await summarize.execute({ node: '0-3', text: '四条合一' })
  assert.equal(done.remaining, 0, '按顺序还完，债清零')

  // 重复提交已还的那块：不报错、也不覆盖（照 OptMem 的「already settled」）。
  const again = await summarize.execute({ node: '0-1', text: '想覆盖' })
  assert.equal(again.alreadySettled, true)
  assert.equal(new Pyramid(dir).get(0, 2), '前两条', '已还的摘要不许被后来的调用改写')
})

test('区间锚点：串行记录的区间 = 上一条记忆的位置 → 它自己的位置', async () => {
  const { tools, dir } = mounted()
  const note = tools.get('memory_note')
  const sid = 'session-cafa66e3-309b-472b-8c66-f22167a54730'
  const at = seq => ({ agent: { session: { id: sid, seq } } })

  await note.execute({ text: '会话首条' }, at(120))
  await note.execute({ text: '同会话第二条' }, at(250))
  const log = new FixedWidthLog(dir)
  assert.deepEqual([log.read(0).seqLo, log.read(0).seqHi], [0, 120], '会话首条的区间从会话开头起')
  assert.deepEqual([log.read(1).seqLo, log.read(1).seqHi], [120, 250], '后续记录从上一条的位置接续')

  // 换了会话：区间回到新会话的开头，绝不把别人会话的 seq 接续过来。
  const other = `session-${'b'.repeat(36)}`
  await note.execute({ text: '新会话首条' }, { agent: { session: { id: other, seq: 40 } } })
  assert.deepEqual([log.read(2).seqLo, log.read(2).seqHi], [0, 40], '换会话后区间重新从 0 起')
})

test('v1 记忆库被拒绝，而不是用错位 9 字节的偏移去读它', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-'))
  fs.writeFileSync(path.join(dir, 'meta.json'),
    JSON.stringify({ kind: 'dsh-memory', version: 1, createdAt: '2026-08-15T00:00:00.000Z' }))
  fs.writeFileSync(path.join(dir, 'LOG.txt'), Buffer.alloc(RECORD_SIZE, 0x20))
  assert.throws(() => openDataDir(dir, { migrate: false }), /错位 9 字节/)
})

// ── 冻结开关（v0.1.1）：视图开局注入一次，会话内不再更新 ──────────────────

/**
 * 伪造一条官方 runtime-context 快照事件。
 * @param {number} seq - 事件号。
 * @param {Array<{name: string, text: string}> | undefined} sections - 分段；省略＝清空墓碑。
 * @returns {object}
 */
function snapshotEvent(seq, sections) {
  return {
    seq,
    type: 'user/message',
    data: {
      source: {
        kind: 'plugin',
        plugin: '@deepseek-ai/dsh-system-prompt',
        ...sections === undefined ? {} : { form: 'snapshot', sections },
      },
    },
  }
}

test('冻结：找回本会话最后一份快照里自己那段原文', () => {
  const session = {
    events: [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' } } },
      snapshotEvent(2, [{ name: 'sandbox:policy', text: 'S' }, { name: 'dsh-memory:wake', text: '开局视图' }]),
      snapshotEvent(9, [{ name: 'dsh-memory:wake', text: '第二份视图' }]),
    ],
    surface: { nodes: [1, 2, 9] },
  }
  assert.equal(pickFrozenWake(session), '第二份视图', '要最新那份，不是最老那份')
})

test('冻结：最新快照被 compaction 换掉时跳过它、继续找更老的（镜像官方判据）', () => {
  const session = {
    events: [
      snapshotEvent(2, [{ name: 'dsh-memory:wake', text: '仍在 surface 的老快照' }]),
      snapshotEvent(9, [{ name: 'dsh-memory:wake', text: '已被压掉的新快照' }]),
    ],
    surface: { nodes: [2] },
  }
  assert.equal(pickFrozenWake(session), '仍在 surface 的老快照')
})

test('冻结：全场没有 surface 上的快照 → 没有底，交回全量渲染', () => {
  // 新会话（从没注入过）与快照被压光，都落在这里。
  assert.equal(pickFrozenWake({ events: [], surface: { nodes: [] } }), undefined)
  const compactedAway = {
    events: [snapshotEvent(5, [{ name: 'dsh-memory:wake', text: '孤本' }])],
    surface: { nodes: [] },
  }
  assert.equal(pickFrozenWake(compactedAway), undefined)
})

test('冻结：快照在但没有我们那段（清空墓碑/别家专场）→ 同样交回全量渲染', () => {
  const tombstone = { events: [snapshotEvent(3)], surface: { nodes: [3] } }
  assert.equal(pickFrozenWake(tombstone), undefined)
  const othersOnly = {
    events: [snapshotEvent(4, [{ name: 'sandbox:policy', text: 'S' }])],
    surface: { nodes: [4] },
  }
  assert.equal(pickFrozenWake(othersOnly), undefined)
})

test('冻结：摸不到会话时降级，绝不冻错（版本脆弱性的安全阀）', () => {
  assert.equal(pickFrozenWake(undefined), undefined)
  assert.equal(pickFrozenWake({}), undefined)
  assert.equal(pickFrozenWake({ events: 'not-an-array', surface: { nodes: [] } }), undefined)
  assert.equal(pickFrozenWake({ events: [] }), undefined, 'surface 缺席也降级')
  // 非官方署名的 user/message 不许被当成快照。
  const impostor = {
    events: [{
      seq: 7,
      type: 'user/message',
      data: { source: { kind: 'plugin', plugin: 'someone-else', sections: [{ name: 'dsh-memory:wake', text: '冒名' }] } },
    }],
    surface: { nodes: [7] },
  }
  assert.equal(pickFrozenWake(impostor), undefined)
})

test('冻结接线：默认冻结有底照抄；liveView:true 恢复实时渲染', async () => {
  /** 装载一次插件，截获 context() 的注册。 @param {object} extra */
  const mountPrompt = (extra) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-'))
    const tools = new Map()
    let wake
    apply({
      get: () => undefined,
      systemPrompt: { section() {}, context(def) { wake = def } },
      tools: { register(def) { tools.set(def.name, def) } },
    }, { dataDir: dir, ...extra })
    return { tools, wake }
  }

  const frozen = mountPrompt({})
  const note = frozen.tools.get('memory_note')
  await note.execute({ text: '写入后视图本该变' }, { agent: { session: { id: 'session-x', seq: 1 } } })
  const base = snapshotEvent(2, [{ name: 'dsh-memory:wake', text: '开局那份' }])
  const ac = { scope: { session: { events: [base], surface: { nodes: [2] } } } }
  assert.equal(frozen.wake.text(ac), '开局那份', '默认冻结：写入后仍照抄开局原文')
  assert.match(frozen.wake.text({ scope: {} }), /写入后视图本该变/, '摸不到会话 → 降级实时渲染')

  const live = mountPrompt({ liveView: true })
  await live.tools.get('memory_note').execute({ text: '实时可见' }, { agent: { session: { id: 'session-y', seq: 1 } } })
  assert.match(live.wake.text(ac), /实时可见/, 'liveView:true：无视冻结底，永远渲染当前')
})
