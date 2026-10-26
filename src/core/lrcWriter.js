// @ts-check
/**
 * LRC 文本生成 —— 纯函数层，禁止 import vue / 不碰 DOM。
 *
 * 【为什么单独成文件，而不是塞进 lrcParser.js】
 * 解析与生成是两个方向、两套关注点：
 * 解析的核心价值是**容忍脏输入**，生成的核心价值是**输出精确**。
 * 混在一起会让这两件事互相干扰，也没法各自单测 ——
 * 而导出最容易犯的错（少一位小数、扩展名重复、时间被重复偏移）
 * 恰恰都是"肉眼看文件很难发现"的那类问题。
 *
 * 【时间标签写 t（最终时间），并且**刻意不写 [offset:]】—— 关键决定】
 * 解析器的规则是 `t = rawT - offsetMs/1000`。
 * 若导出时写 rawT 又同时写 [offset:500]，别人重新导入会**再减一次**，
 * 整首歌的时间偏移变成两倍，而且不会有任何报错 —— 静默错误最难查。
 * 只写 t、不写 offset 的好处：
 *   - 重新导入本应用完全一致（offset 缺省为 0）
 *   - 拿到任何第三方播放器里，时间都是"已与音频对齐"的正确值
 * 代价是"原始文件里的数字"不再保留 —— 但那本来就不是用户要的东西，
 * 用户要的是**能正常跟着歌走的歌词**。
 */
import { formatTimeTag } from './timeUtils.js'

/** 标题与音频名都取不到时使用的文件名主干 */
export const DEFAULT_LRC_BASE = 'lyrics'

/** 输出扩展名 */
export const LRC_EXT = '.lrc'

/**
 * 文件名非法字符。
 * 覆盖 Windows 保留的 `\ / : * ? " < > |` 以及控制字符 ——
 * 导出文件名里带这些字符时，Windows 会直接拒绝保存或者静默改名。
 */
const ILLEGAL_FILENAME_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

/**
 * Windows 保留设备名。
 * `CON`、`NUL`、`COM1` 这类名字即使带扩展名，在某些路径下依然无法创建。
 */
const RESERVED_FILENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 已知扩展名：实现"避免重复扩展名"。
 *
 * 【为什么只剥这些，而不是"最后一个点后面全删"】
 * 歌名里合法地包含点号很常见（`Hello.World`、`Op.10 No.3`）。
 * 用"最后一个点"的通用规则会把 `.World`、`.10 No` 当成扩展名误删，
 * 导出的文件名会缺一块。只剥**已知的**扩展名就不会误伤。
 */
const KNOWN_EXTS = [
  '.lrc',
  '.txt',
  '.text',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.wma',
  '.mp4',
  '.webm',
  '.mkv',
]

/**
 * 文件名主干长度上限（按**字符**数，不是字节数）。
 * UTF-8 下中文一个字 3 字节，多数文件系统的上限是 255 字节，
 * 80 个中文 ≈ 240 字节，留得出余量。
 */
export const MAX_BASE_LENGTH = 80

/**
 * 判断一行是否"可导出"（有可用的时间）。
 *
 * 【为什么不能直接写 Number.isFinite(Number(line.t))】
 * `Number(null) === 0`、`Number('') === 0`、`Number(false) === 0`
 * —— 用 Number() 强转会把"没有时间"的行**静默当成 0 秒**导出，
 * 于是文件开头莫名其妙多出一行，而用户完全不知道发生了什么。
 * 这类"脏值被悄悄转成合法值"正是最难发现的错误。
 *
 * 所以这里显式分类型判断：
 *   - number  → 必须是有限数（挡掉 NaN / Infinity）
 *   - string  → 非空且能转成有限数才认（容忍 "12.5" 这种写法）
 *   - 其余（null / undefined / boolean / object）→ 一律不可导出
 *
 * @param {{t?:unknown}} line
 * @returns {boolean}
 */
export function isExportableLine(line) {
  if (!line || typeof line !== 'object') return false
  const t = /** @type {any} */ (line).t
  if (typeof t === 'number') return Number.isFinite(t)
  if (typeof t === 'string') {
    const s = t.trim()
    if (s === '') return false
    return Number.isFinite(Number(s))
  }
  return false
}

/**
 * 统计可导出行数与被跳过的行数（供界面提示用）。
 *
 * 【为什么不写成 (lines) => lines.filter(isExportableLine).length】
 * 那个表达式会在调用方重新实现一遍"什么算有效行"，
 * 一旦规则变化（比如将来允许负时间）两处就会走偏。
 * 这里与 buildLrcText 共用同一个判据函数。
 *
 * @param {Array<any>} lines
 * @returns {{exportable:number, skipped:number}}
 */
export function summarizeLrcLines(lines) {
  const arr = Array.isArray(lines) ? lines : []
  let exportable = 0
  for (const line of arr) {
    if (isExportableLine(line)) exportable++
  }
  return { exportable, skipped: arr.length - exportable }
}

/**
 * 清理元数据值。
 *
 * 【为什么必须去换行与方括号】
 * 元数据的结构是 `[tag:value]`，value 里只要出现 `]` 就会提前闭合标签，
 * 出现换行则会把一条记录劈成两行 —— 两者都会生成无法解析的 LRC。
 *
 * @param {unknown} value
 * @returns {string} 清理后的值；无内容时返回空串
 */
export function sanitizeMetaValue(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\r\n]+/g, ' ') // 换行 → 空格
    .replace(/[[\]]/g, '') // 方括号去掉（会破坏 [tag:value] 结构）
    .trim()
}

/**
 * 清理单行正文。
 *
 * 【为什么正文里的换行要去掉】
 * LRC 是"一行一条"的格式，正文里如果混进换行，
 * 后半截就会变成一行没有时间标签的散字，重新导入时被丢进 droppedLines。
 * 换行替换成空格，内容不丢。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeLineText(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/[\r\n]+/g, ' ').trim()
}

/**
 * 把元数据渲染成 `[tag:value]` 行。
 *
 * 只输出**有内容**的标签；未知标签（re / ve 等）也原样保留，
 * 与解析器"未识别标签进 meta.raw，导出时不丢信息"的设计对齐。
 *
 * @param {any} meta
 * @returns {string[]}
 */
export function buildMetaTags(meta) {
  if (!meta || typeof meta !== 'object') return []

  /** @type {string[]} */
  const out = []

  /** @type {Array<[string, unknown]>} */
  const known = [
    ['ti', meta.title],
    ['ar', meta.artist],
    ['al', meta.album],
    ['by', meta.by],
  ]
  for (const [tag, value] of known) {
    const v = sanitizeMetaValue(value)
    if (v) out.push(`[${tag}:${v}]`)
  }

  // 音频长度标签：解析器能识别，保留它 round-trip 才完整
  const len = Number(meta.length)
  if (Number.isFinite(len) && len > 0) {
    out.push(`[length:${formatTimeTag(len)}]`)
  }

  // 未知标签原样带出（标签名只允许字母与 #，避免写出畸形标签）
  const raw = meta.raw
  if (raw && typeof raw === 'object') {
    for (const [tag, value] of Object.entries(raw)) {
      if (!/^[a-zA-Z#]+$/.test(tag)) continue
      // offset 由解析器单独处理、不会进 raw；这里再挡一次，
      // 万一手工塞进来也不会写出会引发双重偏移的标签
      if (tag.toLowerCase() === 'offset') continue
      const v = sanitizeMetaValue(value)
      if (v) out.push(`[${tag}:${v}]`)
    }
  }

  return out
}

/**
 * 把歌词行转换为 LRC 文本。
 *
 * 输出示例：
 * ```
 * [ti:示例歌曲]
 * [ar:歌手]
 * [00:12.35]第一句歌词
 * [00:16.80]第二句歌词
 * ```
 *
 * 【纯读操作】
 * 只读取传入的数组，不修改任何一行、不重排顺序、不改时间轴。
 * 顺序完全按传入顺序（调用方保证已按时间升序）。
 *
 * 【空行（间奏）保留时间标签】
 * `empty: true` 的行会输出成 `[00:50.00]`（有时间、无正文）。
 * 直接丢掉它会让间奏处的滚动节奏改变，而且 round-trip 会少一行。
 *
 * @param {Array<any>} lines 已按时间升序的歌词行
 * @param {Object} [options]
 * @param {any} [options.meta] 元数据（title/artist/album/by/length/raw）
 * @param {boolean} [options.includeMeta=true] 是否输出元数据标签
 * @param {number} [options.precision=2] 小数位数（2 = 百分秒，即 `mm:ss.cc`）
 * @returns {string} LRC 文本；没有任何可导出行时返回空串
 */
export function buildLrcText(lines, options = {}) {
  const { meta = null, includeMeta = true, precision = 2, enhanced = false } = options
  const arr = Array.isArray(lines) ? lines : []

  /** @type {string[]} */
  const out = []

  if (includeMeta) {
    out.push(...buildMetaTags(meta))
  }

  for (const line of arr) {
    // 无效时间的行直接跳过：写出去只会变成坏数据
    // （注意判断用的是 isExportableLine，不能用 Number() 强转 —— 见那里的说明）
    if (!isExportableLine(line)) continue

    const t = Number(/** @type {any} */ (line).t)
    // formatTimeTag 已负责四舍五入与进位（如 59.999 → 01:00.00），
    // 这里不重复实现时间格式化 —— 那是 core/timeUtils 的职责
    const tag = formatTimeTag(t, precision)

    if (enhanced) {
      out.push(buildEnhancedLine(line, tag, precision))
      continue
    }

    const text = sanitizeLineText(/** @type {any} */ (line).text)
    out.push(`[${tag}]${text}`)
  }

  return out.join('\n')
}

/**
 * 清洗一个**字符片段**（逐字数据里的单个字，可能带尾随标点或空格）。
 *
 * 【为什么不能复用 sanitizeLineText】
 * 那个函数是给"整行正文"设计的，末尾有 .trim() —— 对整行是对的
 * （LRC 正文首尾空白没有意义），但对**片段**是错的：
 * 逐字拆字时空格被并进前一个字（"o " 表示 o 后面那个空格），
 * trim 掉之后增强 LRC 就写成 <..>o<..>w，重新解析得到 "Helloworld"，
 * 原文的空格永久丢失。实测就是这个 bug。
 *
 * 所以这里只处理换行（LRC 一行一条，换行必须消灭），
 * 首尾空白原样保留。
 *
 * @param {unknown} seg
 * @returns {string}
 */
function sanitizeCharSegment(seg) {
  if (typeof seg !== 'string') return ''
  return seg.replace(/[\r\n]+/g, ' ')
}

/**
 * 造一行的增强 LRC 文本：`[mm:ss.cc]<mm:ss.cc>字<mm:ss.cc>字…`
 *
 * 【标准标签先写】
 * 增强 LRC 里 `<…>` 只是一段注释性的补充，`[…]` 才是行的 anchor。
 * 先写标准标签保证任何不支持增强格式的播放器都能正常滚动，
 * 这正是"双写"里"主输出必须可播"的要求。
 *
 * 【为什么需要】
 * 标准 LRC 无法表达逐字时间。若只写标准 LRC，逐字数据会在一次导出后彻底丢失；
 * 若只写增强 LRC（不写 `[…]`），老播放器会整行不显示。
 *
 * @param {any} line
 * @param {string} lineTag 已格式化的标准时间标签内容（不含方括号）
 * @param {number} precision
 * @returns {string}
 */
function buildEnhancedLine(line, lineTag, precision) {
  const head = `[${lineTag}]`
  const chars = /** @type {any} */ (line).chars
  const t = Number(/** @type {any} */ (line).t)

  if (!Array.isArray(chars) || chars.length === 0) {
    // 这一行没有逐字数据（标准 LRC 打轴出来的行）→ 原样输出正文，不伪造逐字时间
    return head + sanitizeLineText(/** @type {any} */ (line).text)
  }

  let body = ''
  for (const ch of chars) {
    if (!ch || typeof ch !== 'object') continue
    const c = sanitizeCharSegment(ch.c)
    // 纯空白的片段没有内容，跳过；但 'o ' 这种带尾随空格的有意义，保留
    if (c.trim() === '') continue
    // 字自己的时间无效 → 退回整行时间，绝不用 NaN 造出 `<NaN>`
    const ct = Number.isFinite(Number(ch.t)) ? Number(ch.t) : t
    body += `<${formatTimeTag(ct, precision)}>${c}`
  }

  if (body === '') {
    // chars 全是空的：正文不能凭空消失，退回标准写法
    return head + sanitizeLineText(/** @type {any} */ (line).text)
  }

  // 校验：逐字拼回来若比正文少字，补一个尾段，保证 round-trip 不丢字
  const joined = body.replace(/<[^>]*>/g, '')
  const full = sanitizeLineText(/** @type {any} */ (line).text)
  if (joined.length < full.replace(/\s/g, '').length) {
    body += full.slice(joined.length)
  }

  return head + body
}

/**
 * 判断一组歌词行是否带有逐字数据。
 *
 * 调用方用它决定要不要额外产出增强 LRC —— 没有逐字数据时再写一个增强文件
 * 只会得到一份与标准 LRC 字节相同的副本，没有意义。
 *
 * @param {Array<any>} lines
 * @returns {boolean}
 */
export function hasAnyChars(lines) {
  const arr = Array.isArray(lines) ? lines : []
  for (const line of arr) {
    if (line && Array.isArray(/** @type {any} */ (line).chars) && line.chars.length > 0) return true
  }
  return false
}

/**
 * 双写：一次导出同时产出标准 LRC 与增强 LRC。
 *
 * 【为什么两个都要】
 *   - 标准 LRC：任何播放器都能用（主输出，必须可播）
 *   - 增强 LRC：保留 `<mm:ss.xx>` 逐字时间，重新导入本应用不丢数据
 * 二者内容完全一致，只是增强版多了逐字标签。
 *
 * @param {Array<any>} lines
 * @param {Object} [options] 同 buildLrcText，另见 enhancedSuffix
 * @param {string} [options.enhancedSuffix=''] 增强文件名的后缀（写在扩展名之前）
 * @returns {{standard:string, enhanced:string}}
 */
export function buildLrcDual(lines, options = {}) {
  return {
    standard: buildLrcText(lines, options),
    enhanced: buildLrcText(lines, { ...options, enhanced: true }),
  }
}

/**
 * 去掉文件名里的已知扩展名。
 * @param {unknown} name
 * @returns {string}
 */
export function stripKnownExtension(name) {
  const s = typeof name === 'string' ? name.trim() : ''
  if (s === '') return ''
  const lower = s.toLowerCase()
  for (const ext of KNOWN_EXTS) {
    if (lower.endsWith(ext)) return s.slice(0, s.length - ext.length)
  }
  return s
}

/**
 * 清理文件名主干：去非法字符、去首尾点与空白、避开保留名、限长。
 *
 * @param {unknown} raw
 * @returns {string} 清理后的主干；无有效内容时返回空串
 */
export function sanitizeBaseName(raw) {
  let s = typeof raw === 'string' ? raw : ''

  // 1) 非法字符 → 下划线（保留"这里原本有分隔"的视觉信息）
  s = s.replace(ILLEGAL_FILENAME_RE, '_')
  // 2) 折叠连续下划线，"Song: Part 1" 不会变成 "Song__ Part 1"
  s = s.replace(/_{2,}/g, '_')
  // 3) 开头的点/空白/下划线去掉（避免生成隐藏文件或怪名字）
  s = s.replace(/^[.\s_]+/, '')
  // 4) 结尾的点与空白去掉：Windows 会静默丢弃结尾的点，导致名字与预期不符
  s = s.replace(/[.\s]+$/, '')
  s = s.trim()

  // 5) 保留设备名：加下划线让它变成普通名字
  if (RESERVED_FILENAME_RE.test(s)) s = `${s}_`

  // 6) 限长（按字符数，避免中文名超出文件系统字节上限）
  const chars = [...s]
  if (chars.length > MAX_BASE_LENGTH) {
    s = chars.slice(0, MAX_BASE_LENGTH).join('').replace(/[.\s_]+$/, '')
  }

  return s
}

/**
 * 生成导出文件名。
 *
 * 优先级：歌曲标题 → 音频文件名 → `lyrics.lrc`
 * 并保证：不重复扩展名、无非法字符、始终以 `.lrc` 结尾。
 *
 * @param {Object} [options]
 * @param {unknown} [options.title] 歌曲标题（meta.title）
 * @param {unknown} [options.audioFileName] 音频文件名（player.fileName）
 * @param {string} [options.fallback=DEFAULT_LRC_BASE] 兜底主干
 * @returns {string} 形如 `示例歌曲.lrc`
 */
export function buildLrcFileName(options = {}) {
  const { title = '', audioFileName = '', fallback = DEFAULT_LRC_BASE } = options

  // 标题优先；标题取不到才用音频文件名
  const fromTitle = sanitizeBaseName(stripKnownExtension(title))
  const fromAudio = sanitizeBaseName(stripKnownExtension(audioFileName))
  const fromFallback = sanitizeBaseName(fallback) || DEFAULT_LRC_BASE

  const base = fromTitle || fromAudio || fromFallback
  return `${base}${LRC_EXT}`
}
