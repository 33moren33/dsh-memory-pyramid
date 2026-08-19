/**
 * 挂载名单 —— 面板上除本库之外还看得见哪些记忆库。
 *
 * ## 为什么需要它
 *
 * `cover()` 在 70 条与一万条上给出的塔**形状完全是两回事**——70 条时整库原文全进
 * 上下文、摘要层一个块都用不上；一万条时才是那座十五层的塔。这件事光靠描述说不清，
 * 得看。而一个刚装上插件的人手里一条记忆都没有。所以要能挂别人的库来看。
 *
 * 更远一点，这张名单也是**多记忆库合并**的地基：合并的第一步永远是「知道有哪几个库」，
 * 而那句话必须由后厨说得出来，不能只活在某个浏览器的 localStorage 里。
 *
 * ## 三条不可动的纪律
 *
 * 1. **挂上来的库一个字节都不写。** 不记它的用量账、不补它的摘要、不 `openDataDir`
 *    （那会建目录、写标记文件）。认库只看 `LOG.txt` 在不在。
 * 2. **名单写在本库自己的数据目录里**（{@link MOUNTS_FILE}），不写进被挂的库。
 *    名单丢了只丢「挂过谁」，任何一个库的内容一条不少。
 * 3. **挂载失败只是少一个参照，绝不打断记忆本体。** 每一条各自 try，一条炸不连累其余。
 *
 * ## 真库 vs 合成测试包：判据长在包身上
 *
 * 测试包的时间戳、热度、基底都是算法生成的。把合成数当真账看会得出错误结论，所以
 * 必须标出来——而标记**不能靠挂载时手填**，手填的东西会跟着包被拷来拷去然后对不上号。
 * 判据顺序（后一条覆盖前一条）：
 *
 * | 优先级 | 判据 | 说明 |
 * |---|---|---|
 * | 低 | 挂载时填的类别 | 人说了算的那一半 |
 * | 中 | 住在 `<数据目录>/packs/` 下 | 约定目录，扔进去就是测试包 |
 * | **高** | 包的 `meta.json` 里有 `synthetic` | **包自报，最权威**——拷到哪都跟着 |
 *
 * 于是「填路径」是新增能力，「自动识别」永远能覆盖它。
 *
 * @module dsh-memory/mounts
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HeatLedger } from './heat.js'
import { FixedWidthLog } from './log.js'
import { Pyramid } from './pyramid.js'
import { META_FILE, workspaceRoot } from './store.js'

/** 手工挂载名单的文件名，住在本库数据目录里。 */
export const MOUNTS_FILE = 'mounts.json'
/** 约定目录：扔进去的库自动挂上，且默认按合成测试包对待。 */
export const PACKS_DIR = 'packs'

/**
 * 随包发布的示例记忆库所在目录。
 *
 * **从本文件的位置算出来，不从工作区算。** 示例库是插件自带的只读资产，它跟着安装
 * 的包走，而不是跟着你打开哪个工作区走——所以任何工作区里都看得见同一批示例，且
 * 磁盘上不会多出任何东西。用 `import.meta.url` 而不是写死路径，是为了让两种安装
 * 方式都成立：从 npm 装时它在 `node_modules` 里，用 `link:` 装时它在你克隆的仓库
 * 里，两处都能被正确解析。
 *
 * 目录不存在时（例如只取了 `lib/` 一层来用）自动降级为「没有示例库」，不报错。
 */
export const SAMPLE_PACKS_DIR = fileURLToPath(new URL('../packs-sample/', import.meta.url))

/**
 * 一个目录像不像记忆库 —— 只看 `LOG.txt`，且**一个字节都不写**。
 * @param {string} dir - 目录。
 * @returns {boolean}
 */
function looksLikeLibrary(dir) {
  try {
    return fs.statSync(path.join(dir, 'LOG.txt')).isFile()
  } catch {
    return false
  }
}

/**
 * 读一个库的自报家门（`meta.json` 里的 `synthetic`）。读不到就当没有——文件缺失、
 * 坏了、不是 JSON，都只影响「标不标测试包」这一件事，不影响能不能读这个库。
 *
 * ⭐ **本库也要走这一遭**：把一个合成测试包直接当成自己的数据目录用是很自然的
 * 事（想看看一万条的塔长什么样），而那时它照样是合成的。只给挂上来的库判定、
 * 本库一律当真账，就会在最容易误读的那个位置上不吭声。
 *
 * @param {string} dir - 库目录。
 * @returns {object | undefined}
 */
export function selfReport(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')).synthetic
  } catch {
    return undefined
  }
}

/**
 * 把一个路径解成一批待挂的库。
 *
 * **父目录一次挂一批**：指到一个放了若干档测试包的文件夹时，不该
 * 逼人一条条填五次。规则简单到不用记——目录自己是库就挂它自己，否则看它的直接子目录。
 *
 * @param {string} full - 已解析的绝对路径。
 * @returns {string[]} 库目录，可能为空。
 */
function expand(full) {
  if (looksLikeLibrary(full)) return [full]
  let entries = []
  try {
    entries = fs.readdirSync(full, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(full, entry.name))
    .filter(looksLikeLibrary)
    .sort()
}

/**
 * 面板看得见的那几个只读库。
 *
 * 名单 ＝ 随包发布的示例库 ＋ 自动扫出来的（`<数据目录>/packs/*`）＋ profile 里配的
 * ＋ 面板手工挂的。四处来源合并后**按目录去重**，重复时保留**先出现**的那条，而顺序
 * 就是上面这个顺序——所以自动识别永远压过手填，这正是「填路径可以被自动识别覆盖」。
 */
export class MountTable {
  /**
   * @param {string} dir - 本库数据目录。名单文件与约定目录都相对它。
   * @param {(message: string) => void} [report] - 报信口，挂不上时说一声。
   */
  constructor(dir, report) {
    /** @type {string} */
    this.dir = dir
    /** @type {(message: string) => void} */
    this.report = typeof report === 'function' ? report : () => {}
    /** @type {Array<string | { name?: string, dir: string, synthetic?: boolean }>} profile 里配的。 */
    this.configured = []
    /** @type {Array<{ name: string, dir: string, log: any, pyramid: any, heat: any, own: boolean, bundled: boolean, synthetic: object | undefined }>} */
    this.entries = []
  }

  /** 手工名单文件的路径。 */
  get file() {
    return path.join(this.dir, MOUNTS_FILE)
  }

  /** 约定目录的路径。 */
  get packsDir() {
    return path.join(this.dir, PACKS_DIR)
  }

  /**
   * 读手工名单。**读不出来就当空的**——名单是可丢的便签，不是账本；
   * 为了一个坏掉的 JSON 让整个面板起不来是本末倒置。
   * @returns {Array<{ name?: string, dir: string, synthetic?: boolean }>}
   */
  readManual() {
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.report(`dsh-memory: ⚠ 读不了挂载名单：${String(error?.message ?? error)}`)
      return []
    }
    try {
      const list = JSON.parse(raw)
      return Array.isArray(list) ? list.filter(entry => typeof entry?.dir === 'string' && entry.dir !== '') : []
    } catch {
      this.report(`dsh-memory: ⚠ ${MOUNTS_FILE} 不是 JSON，已按空名单处理（文件没动）`)
      return []
    }
  }

  /**
   * 写手工名单。写失败只是这次挂载不持久，本次会话照样看得见。
   * @param {Array<{ name?: string, dir: string, synthetic?: boolean }>} list - 名单。
   * @returns {void}
   */
  writeManual(list) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(list, null, 2) + '\n')
    } catch (error) {
      this.report(`dsh-memory: ⚠ 挂载名单没写下去（本次仍然生效）：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 重扫一遍，重建 {@link entries}。装载时跑一次，每次增删也跑一次。
   * @returns {void}
   */
  reload() {
    /** @type {Map<string, { name: string, dir: string, bundled: boolean, synthetic: object | undefined }>} */
    const claimed = new Map()
    const take = (full, name, fallbackSynthetic, bundled = false) => {
      const key = path.resolve(full)
      if (claimed.has(key)) return // 先到先得＝自动识别压过手填
      const reported = selfReport(key)
      claimed.set(key, {
        name,
        dir: key,
        bundled,
        // 包自报最权威；没自报才退到「住在 packs/ 下」或挂载时填的那个。
        synthetic: reported ?? fallbackSynthetic,
      })
    }

    // ① 随包发布的示例库：装完就有得看。
    //
    // 这一条排在最前，因为它是唯一「不需要任何人做任何事」就成立的来源。一个刚装上
    // 插件的人手里一条记忆都没有，而塔在几十条与几千条上的形状完全是两回事——不给
    // 几个现成的库，这件事光靠文字说不清。示例库只读、不拷贝到任何工作区，因此换
    // 工作区也不需要重新准备一遍。
    for (const full of expand(SAMPLE_PACKS_DIR)) {
      take(full, path.basename(full), { note: '插件自带的合成示例库' }, true)
    }
    // ② 约定目录：扔进去就挂上，默认按合成测试包对待。
    for (const full of expand(this.packsDir)) {
      take(full, path.basename(full), { note: '住在 packs/ 约定目录下，按合成测试包对待' })
    }
    // ③ profile 里配的。
    for (const entry of this.configured) {
      const where = typeof entry === 'string' ? entry : entry?.dir
      if (typeof where !== 'string' || where === '') continue
      const full = path.resolve(workspaceRoot(), where)
      const label = (typeof entry === 'object' && entry?.name) || undefined
      for (const one of expand(full)) {
        take(one, label ?? path.basename(one), entry?.synthetic === true ? { note: '配置里标为合成测试包' } : undefined)
      }
    }
    // ④ 面板手工挂的。
    for (const entry of this.readManual()) {
      const full = path.resolve(workspaceRoot(), entry.dir)
      for (const one of expand(full)) {
        take(one, entry.name ?? path.basename(one), entry.synthetic === true ? { note: '挂载时标为合成测试包' } : undefined)
      }
    }

    const out = []
    const used = new Set()
    for (const item of claimed.values()) {
      try {
        // 重名只改显示名，不改身份——身份是目录。
        let name = item.name
        for (let n = 2; used.has(name); n++) name = `${item.name}#${n}`
        used.add(name)
        const log = new FixedWidthLog(item.dir)
        out.push({
          name,
          dir: item.dir,
          log,
          pyramid: new Pyramid(item.dir),
          heat: new HeatLedger(item.dir),
          own: false,
          bundled: item.bundled,
          synthetic: item.synthetic,
        })
      } catch (error) {
        this.report(`dsh-memory: ⚠ 参照库 '${item.name}' 挂不上：${String(error?.message ?? error)}`)
      }
    }
    this.entries = out
  }

  /**
   * 挂一个路径。
   *
   * @param {string} where - 路径，相对工作区根解析。可以指到单个库，也可以指到装着
   *   若干库的父目录（后者一次挂一批）。
   * @param {boolean} synthetic - 人填的类别：true ＝ 合成测试包。**包自报会覆盖它。**
   * @returns {{ ok: boolean, error?: string, mounted?: string[] }}
   */
  add(where, synthetic) {
    if (typeof where !== 'string' || where.trim() === '') return { ok: false, error: '路径是空的' }
    const full = path.resolve(workspaceRoot(), where.trim())
    const found = expand(full)
    if (found.length === 0) {
      return {
        ok: false,
        error: `${full} 下没找到记忆库（认库只看 LOG.txt 在不在；指到装着若干个库的父目录也可以）`,
      }
    }
    const list = this.readManual()
    const already = new Set(list.map(entry => path.resolve(workspaceRoot(), entry.dir)))
    // ⭐ 名单里记**展开后的每一个库**，不记你填的那个父目录。填父目录只是「一次少打
    // 几遍字」的便利，不该让六个库从此绑成一捆。记父目录的话每个库的 dir 都对不上名单，
    // `removable` 全成 false，卸载还会理直气壮地说「它在 packs/ 或 profile 里」——而那
    // 是假话。挂一个装着六个库的父目录时当场撞见。
    for (const one of found) {
      const resolved = path.resolve(one)
      if (!already.has(resolved)) list.push({ dir: resolved, synthetic: synthetic === true })
    }
    this.writeManual(list)
    this.reload()
    const mounted = new Set(found.map(one => path.resolve(one)))
    return { ok: true, mounted: this.entries.filter(entry => mounted.has(entry.dir)).map(entry => entry.name) }
  }

  /**
   * 卸一个。**只从名单上划掉，不碰那个目录一个字节。**
   *
   * 自动扫出来的（随包发布的示例库、`packs/` 下、profile 里配的）划不掉——它们不在
   * 名单上，而"卸载"一个约定目录里的东西该去挪文件，不该在面板上做一个只在本次进程
   * 里有效的假动作。老实说不行，别给一个下次重启就复活的按钮。
   *
   * @param {string} name - 显示名。
   * @returns {{ ok: boolean, error?: string }}
   */
  remove(name) {
    const target = this.entries.find(entry => entry.name === name)
    if (target === undefined) return { ok: false, error: `没有挂着叫 '${name}' 的库` }
    const list = this.readManual()
    const kept = list.filter(entry => path.resolve(workspaceRoot(), entry.dir) !== target.dir)
    if (kept.length === list.length) {
      return {
        ok: false,
        error: target.bundled
          ? `'${name}' 是插件自带的示例库，随包发布、不住在你的工作区里，所以面板上没法卸`
          : `'${name}' 不是从面板挂上来的（它在 ${PACKS_DIR}/ 约定目录下或写在 profile 里），`
            + '要拿掉请挪走那个文件夹或改配置',
      }
    }
    this.writeManual(kept)
    this.reload()
    return { ok: true }
  }

  /**
   * 给面板看的清单。
   * @returns {Array<{ name: string, dir: string, total: number, synthetic: object | null, bundled: boolean, removable: boolean }>}
   */
  list() {
    const manual = new Set(this.readManual().map(entry => path.resolve(workspaceRoot(), entry.dir)))
    return this.entries.map(entry => ({
      name: entry.name,
      dir: entry.dir,
      total: entry.log.count(),
      synthetic: entry.synthetic ?? null,
      bundled: entry.bundled === true,
      removable: manual.has(entry.dir),
    }))
  }
}
