/**
 * 数据目录的定位、认领与迁移。
 *
 * 纪律（本项目两条硬约束）：
 *   1. 运行时数据一律落在工作区里，不写 ~/.dsh、不写 C 盘。
 *   2. 发现目录已存在时**提示并合并**，禁止静默覆盖。
 *      —— 这是插件的运行时行为，不是建仓时的一次性检查。
 *
 * 四种落点（前端选项框将来直接映射到它们）：
 *
 * | 选项 | 配置 | 结果 |
 * |---|---|---|
 * | 1 直接放工作区 | 都不填 | `<工作区>/dsh_memory` |
 * | 2 公共区 | `namespace: myspace` | `<工作区>/myspace/dsh_memory` |
 * | 3 自命名公共区 | `namespace: 随便什么` | `<工作区>/<名字>/dsh_memory` |
 * | 4 完全自定义 | `dataDir: 路径` | 就是那个路径 |
 *
 * @module dsh-memory/store
 */

import fs from 'node:fs'
import path from 'node:path'

/** 数据目录的固定名字。变的是它的上级，不是它自己。 */
export const DIR_NAME = 'dsh_memory'
/** 目录身份标记文件。 */
export const META_FILE = 'meta.json'
/** 身份标记里的 kind，用来区分「我们的目录」与「同名的别人家目录」。 */
export const META_KIND = 'dsh-memory'
/**
 * 磁盘格式版本。**两个方向都拒绝，不猜。**
 *
 * - 2：LOG 记录不再存 `seq`，序号由位置决定（见 `log.js` 抬头）。
 * - 1：LOG 记录头 9 字节是 `seq|`。**用 v2 的偏移去读会整体错位 9 字节**，
 *   而且错得很安静——时间戳读成半截、正文读成半截，看着仍然像数据。
 */
export const META_VERSION = 2
/** 本插件还能正确读写的最低磁盘格式版本。 */
export const MIN_META_VERSION = 2

/**
 * 服务进程自己所在的目录。取值顺序照抄官方约定
 * （`config/agent-presets/minimal/agent.cordis.yml` 的
 * `process.env.DSH_CWD ?? process.cwd()`）。
 *
 * ⚠️ **这不是"用户在 dsh 里选的工作区"**，是「敲 `dsh` 时人在哪个目录」，
 * 在浏览器打开之前就定死了。记忆的落点**不该**由它决定（那正是 2026-08-19
 * 修掉的病），它现在只剩两个用途：解析 `config.dataDir` 里的相对路径，
 * 以及没有任何工作区信息时的最后退路。
 * @returns {string}
 */
export function workspaceRoot() {
  return process.env.DSH_CWD ?? process.cwd()
}

/**
 * 按配置解析数据目录。
 * @param {{ dataDir?: string, namespace?: string }} [config] - 落点配置。
 * @param {string} [root] - 工作区根。缺省退回进程自己的目录，**调用方应当显式给出**
 *   ——记忆跟工作区走，而一台服务同时看得见多个工作区。
 * @returns {string} 绝对路径。
 */
export function resolveDataDir(config = {}, root = workspaceRoot()) {
  if (typeof config.dataDir === 'string' && config.dataDir !== '') {
    return path.resolve(root, config.dataDir)
  }
  if (typeof config.namespace === 'string' && config.namespace !== '') {
    return path.join(root, sanitizeSegment(config.namespace), DIR_NAME)
  }
  return path.join(root, DIR_NAME)
}

/**
 * 把用户给的名字收成一个安全的单层目录名。
 *
 * 只收一层：`../` 之类的穿越、盘符、分隔符全部拒收。名字是用来分格子的，
 * 不是用来当路径用的——想指任意路径请用选项 4（`dataDir`）。
 *
 * @param {string} value - 用户命名。
 * @returns {string}
 * @throws {Error} 名字里带路径分隔符或路径穿越。
 */
export function sanitizeSegment(value) {
  const name = value.trim()
  if (name === '' || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
    throw new Error(
      `dsh-memory: namespace ${JSON.stringify(value)} 不是合法的单层目录名。`
      + ' 它只用来分格子；要指定任意路径请改用 dataDir。',
    )
  }
  return name
}

/**
 * 在工作区里找出所有可能存放着旧记忆的位置。
 *
 * 用途是迁移：换落点之后，我们不靠指针文件记住「上次在哪」，而是直接去所有
 * 候选位置看一眼——发现了就搬过来。少一个需要维护同步的状态。
 *
 * @param {string} exclude - 排除的路径（通常是本次的目标）。
 * @param {string} [root] - 在哪个工作区里找。**必须与目标同一个工作区**，
 *   否则会把别的工作区的记忆搬过来——那是串库，不是迁移。
 * @returns {string[]} 找到的旧数据目录，绝对路径。
 */
export function findExistingDataDirs(exclude, root = workspaceRoot()) {
  const found = []
  const consider = (dir) => {
    if (path.resolve(dir) === path.resolve(exclude)) return
    if (readMeta(dir)?.kind === META_KIND) found.push(dir)
  }
  consider(path.join(root, DIR_NAME))
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.isDirectory()) consider(path.join(root, entry.name, DIR_NAME))
  }
  return found
}

/**
 * 把一份记忆整体搬到新位置。
 *
 * **绝不合并两份非空记忆。** 这不是保守，是这套数据结构的硬约束：记录用
 * **位置即身份**寻址（第 N 条住在第 N×384 字节），把两份 LOG 拼起来，后一份的
 * 每条记录都会换号，而 `TREE/` 里所有摘要引用的区间会**整体指错**——
 * 得到的会是一份看着自洽、其实全是错位的记忆。宁可拒绝。
 *
 * @param {string} from - 旧目录。
 * @param {string} to - 新目录。
 * @returns {string} 说给部署者听的一行结论。
 * @throws {Error} 目标已有记忆。
 */
export function migrateDataDir(from, to) {
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0) {
    throw new Error(
      `dsh-memory: 想把记忆从 ${from} 搬到 ${to}，但目标已经有内容了。`
      + ' 两份记忆不能拼接——记录靠位置寻址，拼起来会让所有摘要指错区间。'
      + ' 请人工确认后保留一份、移走另一份。',
    )
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
    return `dsh-memory: 记忆已搬迁 ${from} → ${to}`
  } catch (error) {
    // 跨盘 rename 会得到 EXDEV，退回复制+校验+删除。
    if (error.code !== 'EXDEV') throw error
    fs.cpSync(from, to, { recursive: true })
    const source = fs.statSync(path.join(from, 'LOG.txt')).size
    const target = fs.statSync(path.join(to, 'LOG.txt')).size
    if (source !== target) {
      throw new Error(
        `dsh-memory: 跨盘搬迁校验失败（LOG.txt 源 ${source} 字节，目标 ${target} 字节）。`
        + ` 源目录 ${from} 原样保留，未删除任何东西。`,
      )
    }
    fs.rmSync(from, { recursive: true, force: true })
    return `dsh-memory: 记忆已跨盘搬迁 ${from} → ${to}（${target} 字节校验通过）`
  }
}

/** 目录里出现下列名字时，视为「本插件先前留下的」。 */
const OWNED_ENTRIES = new Set([META_FILE, 'LOG.txt', 'TREE', '.gitattributes'])

/**
 * 记忆目录自带的 git 属性声明。
 *
 * **为什么必须是文件、而不是写入时小心一点就够了**：`core.autocrlf=true`
 * （Windows 上的常见默认）是在 **checkout 时改磁盘文件**，跟当初用什么 API
 * 写进去的完全无关。我们的记录是定宽的——第 N 条住在第 N×384 字节——
 * 每个 `\n` 被换成 `\r\n` 就多一个字节，**从第一条起全盘错位，而且是静默的**：
 * 读出来的东西看着仍然像数据。
 *
 * 本仓自己的 `.gitignore` 排除了数据目录，所以风险不在我们这边，
 * **在用户把自己的记忆目录提交进自己的仓库**。那份仓库的 `.gitattributes`
 * 只能由我们在建目录时顺手放进去。
 */
const GITATTRIBUTES = `# dsh-memory 的数据是定宽记录：第 N 条固定住在第 N×384 字节。
# 任何行尾转换都会让每条记录多出一个字节，从此全盘错位——而且读出来仍像数据。
# 若把这个目录提交进仓库，下面两行是防止 core.autocrlf 毁掉它的唯一保险。
LOG.txt -text
TREE/** -text
`

/**
 * 开启数据目录：不存在就建，已存在就认领，别处有旧记忆就搬过来。
 *
 * @param {string} dir - 目标数据目录绝对路径。
 * @param {object} [options] - 行为开关。
 * @param {string[]} [options.subdirs] - 需要一并保证存在的子目录名。
 * @param {boolean} [options.migrate] - 是否自动搬迁别处的旧记忆，默认 true。
 * @param {string} [options.root] - 找旧记忆时限定的工作区根，见 `findExistingDataDirs`。
 * @returns {{ dir: string, status: 'created' | 'adopted' | 'migrated', notices: string[] }}
 * @throws {Error} 目录被别的东西占着、版本不兼容、或有多份旧记忆无法自动裁决。
 */
export function openDataDir(dir, options = {}) {
  const notices = []
  let migrated = false

  if (options.migrate !== false && !fs.existsSync(dir)) {
    const stale = findExistingDataDirs(dir, options.root)
    if (stale.length > 1) {
      throw new Error(
        `dsh-memory: 工作区里发现 ${stale.length} 份旧记忆（${stale.join('、')}），`
        + ' 无法自动判断该搬哪一份。请人工保留一份后重启。',
      )
    }
    if (stale.length === 1) {
      notices.push(migrateDataDir(stale[0], dir))
      migrated = true
    }
  }

  let stat
  try {
    stat = fs.statSync(dir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    stat = undefined
  }

  let status
  if (stat === undefined) {
    fs.mkdirSync(dir, { recursive: true })
    writeMeta(dir)
    status = 'created'
    notices.push(`dsh-memory: 新建记忆目录 ${dir}`)
  } else if (!stat.isDirectory()) {
    throw new Error(`dsh-memory: ${dir} 已存在但不是目录。请改落点配置，或先把它移开。`)
  } else {
    const meta = readMeta(dir)
    const entries = fs.readdirSync(dir)
    if (meta !== undefined) {
      if (meta.kind !== META_KIND) {
        throw new Error(
          `dsh-memory: ${dir} 里的 ${META_FILE} 属于 "${String(meta.kind)}"，不是 dsh-memory。`
          + ' 拒绝接管——请换一个落点。',
        )
      }
      if (!Number.isInteger(meta.version) || meta.version > META_VERSION) {
        throw new Error(
          `dsh-memory: ${dir} 的磁盘格式版本是 ${String(meta.version)}，本插件只认到 ${META_VERSION}。`
          + ' 拒绝以旧代码写新格式——请升级插件。',
        )
      }
      if (meta.version < MIN_META_VERSION) {
        throw new Error(
          `dsh-memory: ${dir} 是磁盘格式 v${meta.version} 的记忆库，本插件已升到 v${META_VERSION}。`
          + ' v1 的每条记录以 9 字节的 `seq|` 开头，v2 删掉了它（序号改由位置决定）。'
          + ' **用现在的偏移去读 v1 会整体错位 9 字节，而且是静默的**'
          + '——时间戳与正文都会读成半截，看上去仍然像数据。已拒绝任何读写。'
          + ' 每条记录去掉开头 9 字节即可升级；TREE/ 不受影响，原样保留。',
        )
      }
      status = migrated ? 'migrated' : 'adopted'
      if (!migrated) {
        notices.push(`dsh-memory: 认领既有记忆目录 ${dir}（建立于 ${String(meta.createdAt)}），既有记录原样保留`)
      }
    } else if (entries.length === 0) {
      writeMeta(dir)
      status = 'created'
      notices.push(`dsh-memory: 空目录 ${dir} 已初始化为记忆目录`)
    } else {
      const unknown = entries.filter(entry => !OWNED_ENTRIES.has(entry))
      throw new Error(
        `dsh-memory: ${dir} 已存在、非空、且没有 ${META_FILE} 身份标记`
        + `（里面有：${entries.slice(0, 8).join('、')}${entries.length > 8 ? ' …' : ''}）。`
        + (looksLikeOptMem(dir)
          ? ' 从 LOG.txt 的长度看，这是一份 **OptMem** 记忆库：它的记录是 320 字节定宽，'
            + '本插件是 384（多出来的是 dsh 的会话指针）。**不要手工补 meta.json 去接管**'
            + '——两种格式混读会让每一条记录整体错位。TREE/ 两边格式相同，只需转换 LOG.txt。'
          : unknown.length === 0
            ? ' 看起来是本插件的残留但缺标记；确认无误后手工补一个 meta.json 即可接管。'
            : ' 拒绝在别人的目录上写入——请改落点配置。'),
      )
    }
  }

  for (const sub of options.subdirs ?? []) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  ensureGitAttributes(dir)
  return { dir, status, notices }
}

/**
 * 放一份 `.gitattributes` 进数据目录，若那里还没有的话。
 *
 * **已存在就一个字节都不改**：那可能是用户自己写的，里面还有别的规则。
 * 这条纪律与本模块其余部分一致——宁可什么都不做，也不动别人的文件。
 *
 * @param {string} dir - 数据目录。
 * @returns {void}
 */
function ensureGitAttributes(dir) {
  const file = path.join(dir, '.gitattributes')
  if (fs.existsSync(file)) return
  fs.writeFileSync(file, GITATTRIBUTES, 'utf8')
}

/**
 * 这个目录看着像不像一份 **OptMem** 的记忆库。
 *
 * 判据只用长度：OptMem 的 LOG 是 320 字节定宽，我们是 384。一份长度恰为 320
 * 整数倍、却不是 384 整数倍的 LOG，几乎不可能是我们写崩的。
 *
 * 这个判断存在的意义是**别给出会毁数据的建议**：这两种目录长得很像（都是
 * `LOG.txt` + `TREE/`），而「补个 meta.json 就能接管」在这里是彻头彻尾的错误。
 *
 * @param {string} dir - 候选目录。
 * @returns {boolean}
 */
function looksLikeOptMem(dir) {
  try {
    const size = fs.statSync(path.join(dir, 'LOG.txt')).size
    return size > 0 && size % 320 === 0 && size % 384 !== 0
  } catch {
    return false
  }
}

/**
 * 读身份标记。文件缺失返回 undefined；文件坏了直接抛，不当作缺失处理
 * ——「读不出来」和「没有」是两件事，混为一谈就会覆盖别人的数据。
 * @param {string} dir - 数据目录。
 * @returns {{ kind: string, version: number, createdAt: string } | undefined}
 */
function readMeta(dir) {
  let raw
  try {
    raw = fs.readFileSync(path.join(dir, META_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`dsh-memory: ${path.join(dir, META_FILE)} 不是合法 JSON，拒绝接管。`)
  }
}

/**
 * 写下身份标记。
 * @param {string} dir - 数据目录。
 * @returns {void}
 */
function writeMeta(dir) {
  const meta = { kind: META_KIND, version: META_VERSION, createdAt: new Date().toISOString() }
  fs.writeFileSync(path.join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}
