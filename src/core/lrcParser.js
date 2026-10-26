// @ts-check
/**
 * LRC 解析器 —— 纯函数层，禁止 import vue。
 *
 * 设计要点（都是踩过坑之后的决定）：
 *
 * 1. **同时保留 rawT 与 t**。`t` 是最终生效时间，`rawT` 是文件里的原始时间。
 *    用户改 offset 时永远从 rawT 重算，绝不基于 t 二次偏移 —— 否则来回改几次 offset
 *    就会累积误差，这是 LRC 工具最常见也最难察觉的 bug。
 *
 * 2. **多标签展开**。`[00:12.00][01:20.00]歌词` 展开成两行，各自有稳定 id。
 *
 * 3. **重复时间不丢弃**。两行时间完全相同时也全部保留，只给警告。
 *    静默去重会让用户"少了一句歌词"却不知道原因。
 *
 * 4. **空行（有标签无正文）保留**。间奏占位行如果被删掉，滚动会在该处跳变。
 *
 * 5. **排序必须稳定**。相同时间保持文件中的原顺序，否则同一时间的多行会乱序闪烁。
 *
 * 6. **解析绝不抛异常**。任何脏输入都降级为"尽力解析 + 警告"，
 *    因为用户面对的是一首歌的歌词文件，宁可显示得难看也不能白屏。
 */

import { parseTimeTag, parseOffset, clamp, hasEnhancedTags } from './timeUtils.js'
import { CODES, makeMessage } from './errors.js'

/** 支持的元数据标签（不含 offset/length，它们需要数值解析） */
const META_TAGS = ['ti', 'ar', 'al', 'by', 're', 've', 'au']

/** 标准时间标签：[mm:ss.xx] 等。全局，需每次重置 lastIndex */
const TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** 元数据标签：[ti:xxx] 形式（时间标签不会匹配，因为要求含冒号且值非纯数字结构） */
const META_TAG_RE = /^\[([a-zA-Z#]+):\s*(.*?)\s*\]$/

/** 增强型逐字标签 <mm:ss.xx>（带捕获组，便于取时间） */
const ENHANCED_TAG_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g

/**
 * 由纯标点/空白组成的片段。
 *
 * 【为什么必须单独定义】
 * 增强 LRC 的每段文本是"一个字 + 它后面的标点"，但不少文件会把标点单独打一个标签
 * （`你<1.0>好<1.2>，`）。渲染时再去猜"这个标点该跟谁"必然出错且无法测试，
 * 所以**解析阶段**就把标点并进前一个字 —— 数据层一次性做对。
 */
const FOLLOWING_PUNCT_RE =
  /^[\s\u3000.,!?;:'"()\[\]{}<>《》〈〉「」『』【】、。，；：！？…—–·・~～_“”‘’\-]+$/u

/** 无增强标签时共用的空段数组（避免每行都新建数组） */
const EMPTY_SEGMENTS = []

/**
 * 逐字（增强 LRC）数据。
 *
 * 【格式约定】
 * `c` 是**一个字**（遇到标点时，标点跟随前一个字一起放进同一个 `c`），
 * `t` 是这个字开始唱的**秒**（浮点，与 line.t 同一单位）。
 *
 * 例：`[00:01.00]<00:01.00>你好,<00:01.50>世界`
 *   → `[{c:'你好,', t:1}, {c:'世界', t:1.5}]`
 *
 * 【为什么 c 不是严格的"单字符"】
 * 卡拉 OK 高亮的粒度是"一个字"，但中文标点（，。！？）在视觉上属于前一个字，
 * 单独拆出来会让标点比字还早亮一次，看起来像闪烁。
 * 所以标点**跟随前一个字**，在解析阶段归组 —— 渲染层不需要再猜。
 *
 * @typedef {Object} LyricChar
 * @property {string} c  一个字（可含跟随其后的标点）
 * @property {number} t  该字开始的时间（秒）
 */

/**
 * @typedef {Object} LyricLine
 * @property {string} id      稳定唯一 id
 * @property {number} t       最终生效时间（秒）= rawT - offsetMs/1000
 * @property {number} rawT    原始标签时间（秒），offset 重算的唯一依据
 * @property {string} text    正文（已剥离标签）
 * @property {LyricChar[]|null} chars 逐字时间（仅增强 LRC 有）；无增强标签时为 null
 * @property {boolean} [hasEnhanced] 该行是否来自带增强标签的原文
 * @property {boolean} empty  是否为空行（间奏占位）
 * @property {number|null} beat 吸附到的节拍序号（阶段 5 用）
 * @property {boolean} locked 是否被手动微调过（阶段 5 用，吸附时不覆盖）
 * @property {number} sourceLine 在原始文件中的行号（从 1 开始，便于报错定位）
 * @property {string[]} duplicateOf 与之时间重复的其他行 id
 * @property {boolean} [isTranslation] 是否为翻译行（同时间多行时的次要行）
 */

/**
 * @typedef {Object} LyricsDoc
 * @property {number} version
 * @property {{title:string,artist:string,album:string,by:string,length:number|null,offsetMs:number,raw:Record<string,string>}} meta
 * @property {LyricLine[]} lines
 * @property {Array<ReturnType<typeof makeMessage>>} warnings
 * @property {Array<{line:number,text:string,reason:string}>} droppedLines
 * @property {{totalRows:number, parsedLines:number, offsetApplied:boolean, encoding:string, translationGroups?:number}} stats
 */

// ── 逐字时间（增强 LRC）────────────────────────

/**
 * 把带增强标签的一行切成「段」。
 *
 * 输入：`[00:01.00]<00:01.00>你<00:01.50>好`
 * 输出：`[{text:'你', t:1}, {text:'好', t:1.5}]`
 *
 * 【为什么用 exec 循环而不是 split】
 * split 会丢掉标签本身的位置与内容，而我们需要的是「标签 → 它后面那截文本」的配对。
 * exec 循环能同时拿到 lastIndex 与各捕获组，是最直接的写法。
 *
 * 解析不出时间的标签（如 `<99:99>`）会被跳过：
 * 它后面的文本并入前一段 —— 宁可字多一点，也不静默丢字。
 *
 * @param {string} row 原始行文本
 * @returns {Array<{text:string, t:number}>}
 */
export function splitEnhancedSegments(row) {
  /** @type {Array<{text:string, t:number|null}>} */
  const out = []
  if (typeof row !== 'string') return out

  ENHANCED_TAG_RE.lastIndex = 0
  let cursor = 0
  let last = null
  let m

  while ((m = ENHANCED_TAG_RE.exec(row)) !== null) {
    // 两个增强标签之间的这段文本里可能混着标准时间标签（复制粘贴造成的脏文件），
    // 先剥掉再拼接，否则 `[00:01.00]` 会被当成歌词正文。
    const before = stripStandardTags(row.slice(cursor, m.index))
    const t =
      m[3] != null
        ? parseTimeTag(`${m[1]}:${m[2]}.${m[3]}`)
        : parseTimeTag(`${m[1]}:${m[2]}`)

    if (t === null) {
      // 标签无效（如 <00:99.00>）：它前面的文本并入上一个有效段，绝不丢字
      if (last !== null) last.text += before
      cursor = m.index + m[0].length
      continue
    }

    if (last !== null) {
      // 增强 LRC 的惯例：标签写在它所标注的字**前面**。
      // 所以两个有效标签之间的文本属于**前一个**标签（<00:01.00>你<00:01.50>好）。
      last.text += before
    } else if (before !== '') {
      // 第一个增强标签之前就有正文（如 `[00:01.00]前奏<00:01.50>好`）→
      // 它没有自己的逐字时间，记为 t:null，由行的起始时间兜底。
      // 以前的写法会把"前奏"直接丢掉 ——这正是要修的静默丢失。
      out.push({ text: before, t: null })
    }
    last = { text: '', t }
    out.push(last)
    cursor = m.index + m[0].length
  }

  // 行尾剩余文本（无尾随标签）→ 归到最后一段
  if (last !== null) last.text += stripStandardTags(row.slice(cursor))

  return out
}

/**
 * 数出一行里"看起来是增强标签、但时间解析不出来"的标签个数。
 *
 * 【为什么单独有个函数】
 * splitEnhancedSegments 会把这种标签跳过、把它后面的文本并入前一段 ——
 * 结果是**正文没丢但逐字粒度退化成了一整段**。
 * 这属于降级，用户必须知道，所以需要一个能独立判定的计数函数。
 *
 * @param {string} row
 * @returns {number}
 */
export function countInvalidEnhancedTags(row) {
  if (typeof row !== 'string') return 0
  ENHANCED_TAG_RE.lastIndex = 0
  let n = 0
  let m
  while ((m = ENHANCED_TAG_RE.exec(row)) !== null) {
    const t =
      m[3] != null
        ? parseTimeTag(m[1] + ':' + m[2] + '.' + m[3])
        : parseTimeTag(m[1] + ':' + m[2])
    if (t === null) n++
  }
  return n
}

/**
 * 去掉片段里的标准时间标签 `[mm:ss.xx]`（行 headline 在第一个增强标签之前那截用）。
 * @param {string} s
 * @returns {string}
 */
function stripStandardTags(s) {
  TIME_TAG_RE.lastIndex = 0
  return s.replace(TIME_TAG_RE, '')
}

/**
 * 把「段」压缩成逐字数组 `chars`（标点跟随前一个字）。
 *
 * 【三条规则】
 * 1. 纯标点/空白的段 → 并进前一个字的 `c`（这就是"标点跟随"）。
 *    例：`你`(1.0) + `，`(1.2) → `{c:'你，', t:1.0}`
 * 2. 多字一段（`<1.0>你好`）→ 整段作为一个 `c`，不做猜测拆分。
 *    增强 LRC 里"一个标签后面跟多个字"是完全合法的写法，
 *    强行按字符均分时间会给出看起来精确、实际错误的结果。
 * 3. 段自身没有时间（`t: null`，即正文长在第一个增强标签之前）→ 用 `fallbackT`。
 *    宁可用整行的起始时间，也不把这截字丢掉。
 *
 * @param {Array<{text:string, t:number|null}>} segments
 * @param {number} fallbackT 没有逐字时间时使用的兜底时间（通常取行的 t）
 * @returns {LyricChar[]}
 */
export function toChars(segments, fallbackT = 0) {
  /** @type {LyricChar[]} */
  const chars = []
  if (!Array.isArray(segments)) return chars

  for (const seg of segments) {
    const raw = typeof seg.text === 'string' ? seg.text : ''
    /*
     * 【为什么这里不能 trim】
     * 空格在逐字数据里是有意义的分隔：拆字时"o "表示 o 后面那个空格。
     * 若 trim 掉，增强 LRC 往返一次 "Hello world" 就变成 "Helloworld"，
     * 原文的空格永久丢失（实测复现）。
     * 只把换行替换成空格，首尾空白原样保留。
     */
    const segText = raw.replace(/[\r\n]+/g, ' ')
    // 整段全是空白 → 这一段没有内容（增强标签后面什么都没写），跳过。
    // 注意判的是「全是空白」而不是「空串」：尾随空格（'o '）是有意义的，必须留。
    if (segText.trim() === '') continue
    const rawT = seg.t == null ? fallbackT : Number(seg.t)
    const t = Number.isFinite(rawT) ? rawT : fallbackT

    if (chars.length > 0 && FOLLOWING_PUNCT_RE.test(segText)) {
      chars[chars.length - 1].c += segText
      continue
    }
    chars.push({ c: segText, t })
  }

  return chars
}

/**
 * 解析 LRC 文本。
 *
 * @param {string} raw LRC 文本内容
 * @param {Object} [options]
 * @param {string} [options.encoding='utf-8'] 实际使用的编码，仅用于统计/提示
 * @param {number} [options.maxLines=50000] 安全上限，防止异常文件撑爆内存
 * @returns {LyricsDoc}
 */
export function parseLrc(raw, options = {}) {
  const { encoding = 'utf-8', maxLines = 50000 } = options
  /** @type {LyricsDoc} */
  const doc = {
    version: 1,
    meta: {
      title: '',
      artist: '',
      album: '',
      by: '',
      length: null,
      offsetMs: 0,
      raw: {},
    },
    lines: [],
    warnings: [],
    droppedLines: [],
    stats: { totalRows: 0, parsedLines: 0, offsetApplied: false, encoding },
  }

  // ── 输入防御 ──────────────────────────────────
  if (typeof raw !== 'string') {
    doc.warnings.push(makeMessage(CODES.LRC_EMPTY))
    return doc
  }

  // 去 BOM。带 BOM 的文件第一行标签常常解析不出来，这是中文 LRC 的高频问题
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  if (text.trim() === '') {
    doc.warnings.push(makeMessage(CODES.LRC_EMPTY))
    return doc
  }

  // ── 第一遍：扫描元数据（包括 offset）────────────
  // 必须先扫完 offset 再算时间，因为 offset 可能出现在文件任意位置
  const rows = text.split(/\r\n|\r|\n/)
  doc.stats.totalRows = rows.length

  /** 原始时间 + 正文的中间结果，等 offset 确定后再算 t */
  /** @type {Array<{rawT:number, text:string, sourceLine:number, hasEnhanced:boolean, segments:Array<{text:string, t:number}>}>} */
  const pending = []

  /** @type {string[]} */
  const untimedTexts = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const sourceLine = i + 1

    // ── 逐字段：先在原行上把 <mm:ss.xx> 切成 [{text, t}] 段 ──
    // 顺序很重要：**必须在剥离之前提取**，剥离后文本里已经没有时间可猜。
    const hasEnhanced = hasEnhancedTags(row)
    const segments = hasEnhanced ? splitEnhancedSegments(row) : EMPTY_SEGMENTS

    // 行里有增强标签却一段都没解出来、或有标签被判定无效 —— 都是降级。
    // 以前这些情况会被 replace 直接抹平且没有任何提示（典型的静默丢失）。
    const invalidTags = hasEnhanced ? countInvalidEnhancedTags(row) : 0
    if (hasEnhanced && (segments.length === 0 || invalidTags > 0)) {
      doc.warnings.push(
        makeMessage(
          CODES.LRC_ENHANCED_DROPPED,
          "第 " + sourceLine + " 行" + (invalidTags > 0 ? "（" + invalidTags + " 个标签无法解析）" : ""),
        ),
      )
    }

    // 去掉增强型逐字标签，只保留正文（无增强标签时这一句等价于原行为）
    const withoutEnhanced = row.replace(ENHANCED_TAG_RE, '')

    // 提取本行所有标准时间标签
    TIME_TAG_RE.lastIndex = 0
    /** @type {number[]} */
    const times = []
    let m
    while ((m = TIME_TAG_RE.exec(withoutEnhanced)) !== null) {
      const t = parseTimeTag(`${m[1]}:${m[2]}${m[3] != null ? `.${m[3]}` : ''}`)
      if (t !== null) times.push(t)
    }

    // 正文 = 去掉所有时间标签后的内容
    TIME_TAG_RE.lastIndex = 0
    const body = withoutEnhanced.replace(TIME_TAG_RE, '').trim()

    if (times.length > 0) {
      if (pending.length + times.length > maxLines) {
        // 超出上限：停止追加，但不报错中断，保留已解析部分
        break
      }
      // 一行多标签 → 展开成多行，共享同一份正文（与逐字段）
      for (const rawT of times) {
        pending.push({ rawT, text: body, sourceLine, hasEnhanced, segments })
      }
      continue
    }

    // 没有时间标签：可能是元数据，也可能是纯文本歌词
    const metaMatch = META_TAG_RE.exec(row.trim())
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase()
      const value = metaMatch[2]

      if (key === 'offset') {
        doc.meta.offsetMs = parseOffset(value)
        continue
      }
      if (key === 'length') {
        const secs = parseTimeTag(value) ?? (/^\d+$/.test(value) ? Number(value) : null)
        doc.meta.length = secs
        continue
      }
      applyMeta(doc, key, value)
      continue
    }

    // 既无时间标签也非元数据：记录为被丢弃的文本
    if (row.trim() !== '') {
      untimedTexts.push(row.trim())
      doc.droppedLines.push({
        line: sourceLine,
        text: row.trim(),
        reason: '没有时间标签',
      })
    }
  }

  // ── 第二遍：应用 offset，得到最终时间 ──────────
  const offsetSec = doc.meta.offsetMs / 1000
  doc.stats.offsetApplied = doc.meta.offsetMs !== 0

  let negativeCount = 0
  let enhancedLines = 0
  for (const p of pending) {
    // 社区约定：最终时间 = 原时间 - offset/1000（正数 offset 表示歌词整体提前）
    let t = p.rawT - offsetSec
    if (t < 0) {
      t = 0
      negativeCount++
    }

    // ── 逐字时间：随行一起偏移，避免"行对了、字还停在原地" ──
    /** @type {LyricChar[]|null} */
    let chars = null
    if (p.hasEnhanced) {
      const built = toChars(p.segments, p.rawT)
        .map((ch) => ({
          c: ch.c,
          t: Math.max(0, ch.t - offsetSec),
        }))
      if (built.length > 0) {
        chars = built
        enhancedLines++
      }
    }

    doc.lines.push({
      id: '', // 排序后再分配，保证 id 与最终顺序一致
      t,
      rawT: p.rawT,
      text: p.text,
      chars,
      empty: p.text === '',
      beat: null,
      locked: false,
      sourceLine: p.sourceLine,
      duplicateOf: [],
    })
  }

  // ── 第三遍：稳定排序 ──────────────────────────
  // 用 sourceLine 作为次级键，保证相同时间的行维持文件原顺序（稳定排序）
  doc.lines.sort((a, b) => (a.t - b.t) || (a.sourceLine - b.sourceLine))

  // 排序后分配 id
  for (let i = 0; i < doc.lines.length; i++) {
    doc.lines[i].id = `L${i}`
  }

  // ── 统计与警告 ────────────────────────────────
  doc.stats.parsedLines = doc.lines.length

  if (doc.lines.length === 0) {
    // 没有任何时间标签：区分"完全空文件"与"有文字但没时间"
    if (untimedTexts.length > 0) {
      doc.warnings.push(makeMessage(CODES.LRC_NO_TIME_TAGS, `共 ${untimedTexts.length} 行文本`))
    } else {
      doc.warnings.push(makeMessage(CODES.LRC_EMPTY))
    }
  }

  if (negativeCount > 0) {
    doc.warnings.push(makeMessage(CODES.LRC_NEGATIVE_TIME, `${negativeCount} 行被对齐到 0 秒`))
  }

  if (enhancedLines > 0) {
    doc.stats.enhancedLines = enhancedLines
  }

  // ── 降级不静默：chars 覆盖不了整行正文时给明确警告 ──
  // 这里只做"长度够不够"的检查：chars 拼回来缺了字，说明有内容被降级丢掉。
  const mismatch = checkCharsCoverage(doc.lines)
  if (mismatch > 0) {
    doc.warnings.push(
      makeMessage(CODES.LRC_ENHANCED_MISMATCH, `${mismatch} 行的逐字时间与正文不一致`),
    )
  }

  // 检测重复时间。注意要区分两种情况（中文 LRC 里非常关键）：
  //   a) 同一时间的多行是「原文 + 翻译」—— 这是正常且常见的格式，不该报警吓用户
  //   b) 同一时间出现内容相同或无关的多行 —— 这才是真需要提醒的
  const dupGroups = findDuplicateTimes(doc.lines)
  const realDupGroups = []
  const translationGroups = []

  for (const g of dupGroups) {
    for (const line of g) {
      line.duplicateOf = g.filter((x) => x.id !== line.id).map((x) => x.id)
    }
    if (looksLikeTranslationGroup(g)) translationGroups.push(g)
    else realDupGroups.push(g)
  }

  // 记录每行是否属于"翻译行"，供 UI 用更弱的样式显示（不抢主歌词的视觉）
  for (const g of translationGroups) {
    const primary = pickPrimaryLine(g)
    for (const line of g) {
      line.isTranslation = line.id !== primary.id
    }
  }

  if (translationGroups.length > 0) {
    doc.stats.translationGroups = translationGroups.length
  }

  if (realDupGroups.length > 0) {
    const detail = realDupGroups
      .slice(0, 3)
      .map((g) => `${formatSec(g[0].t)} 秒处有 ${g.length} 行`)
      .join('；')
    doc.warnings.push(
      makeMessage(
        CODES.LRC_DUPLICATE_TIME,
        realDupGroups.length > 3 ? `${detail} 等 ${realDupGroups.length} 处` : detail,
      ),
    )
  }
  // 翻译行属于正常格式，只作信息提示，不作为警告
  if (translationGroups.length > 0) {
    doc.warnings.push(
      makeMessage(CODES.LRC_TRANSLATION_DETECTED, `${translationGroups.length} 处`),
    )
  }

  return doc
}

/**
 * 把一段逐字时间整体平移 offsetSec 秒（负数会被夹到 0，与整行时间的处理一致）。
 *
 * @param {LyricChar[]|null} chars
 * @param {number} rawT 该行的原始时间，用于 chars 缺失时间时兜底
 * @param {number} offsetSec
 * @returns {LyricChar[]|null}
 */
export function offsetChars(chars, rawT, offsetSec) {
  if (!Array.isArray(chars) || chars.length === 0) return chars ?? null
  const base = Number.isFinite(Number(rawT)) ? Number(rawT) : 0
  return chars.map((ch) => {
    const from = Number.isFinite(Number(ch.t)) ? Number(ch.t) : base
    return { c: ch.c, t: Math.max(0, from - offsetSec) }
  })
}

/**
 * 逐字数据是否覆盖得住整行正文。
 *
 * 【为什么需要】
 * 增强 LRC 是"尽力解析"的格式：标签数、正文长度都由外部文件决定。
 * 若 chars 拼回来比正文少字，说明有字被降级掉了 —— 必须让用户知道，
 * 不能只在渲染时"看起来差不多"。
 *
 * 判定：把 chars 的 c 全部去掉空白后与正文去空白比较（长度不同即报警）。
 * 用长度而不是严格相等，是因为标点跟随会让内容拼接顺序有细微差异。
 *
 * @param {LyricLine[]} lines
 * @returns {number} 覆盖不足的行数
 */
function checkCharsCoverage(lines) {
  let n = 0
  for (const line of lines) {
    if (!line.chars || line.chars.length === 0) continue
    const fromChars = line.chars.map((c) => c.c).join('').replace(/\s+/g, '')
    const fromText = String(line.text).replace(/\s+/g, '')
    if (fromChars.length < fromText.length) n++
  }
  return n
}

/**
 * 取一段文本的"书写系统特征"，用于区分双语歌词与真重复。
 *
 * 为什么需要：同时间的多行到底是「原文 + 翻译」还是「时间写重复了」，
 * 单看"文本不同"判断不出来。但书写系统能给出强信号 ——
 * 日文原文含平假名/片假名，而中文译文只有汉字；
 * 中文原文是汉字，英文译文是拉丁字母。特征不同 → 几乎可以确定是双语。
 *
 * 反之，两行都是纯汉字，则更像时间写重复或排版问题，应当提醒用户。
 *
 * @param {string} text
 * @returns {string} 形如 'han' 或 'han+hiragana' 或 'latin'
 */
function scriptSignature(text) {
  /** @type {Set<string>} */
  const sig = new Set()
  if (/[A-Za-z]/.test(text)) sig.add('latin')
  if (/[\u3040-\u309f]/.test(text)) sig.add('hiragana')
  if (/[\u30a0-\u30ff]/.test(text)) sig.add('katakana')
  if (/[\uac00-\ud7af]/.test(text)) sig.add('hangul')
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) sig.add('han')
  if (/[\u0400-\u04ff]/.test(text)) sig.add('cyrillic')
  if (/[\u0600-\u06ff]/.test(text)) sig.add('arabic')
  if (/[\u0e00-\u0e7f]/.test(text)) sig.add('thai')
  return [...sig].sort().join('+') || 'other'
}

/**
 * 判断一组同时间的行是否是「原文 + 翻译」。
 *
 * 判定依据（按重要性排序）：
 *  1. 若存在完全相同的文本 → 判定为真重复（复制粘贴造成），不是双语
 *  2. 各行的**书写系统特征必须不同** → 这是双语的核心信号
 *  3. 全部非空、长度适中
 *
 * 只有 (2) 成立才认为是双语；两行同为纯汉字会被判为需要提醒的重复时间。
 *
 * @param {LyricLine[]} group
 * @returns {boolean}
 */
function looksLikeTranslationGroup(group) {
  if (group.length < 2) return false

  const texts = group.map((l) => l.text)

  // 1. 有完全相同的文本 → 真重复
  if (new Set(texts).size !== texts.length) return false

  // 2. 必须全部非空
  if (!texts.every((t) => t.trim() !== '')) return false

  // 3. 书写系统特征必须存在差异（双语的核心判据）
  const sigs = new Set(texts.map(scriptSignature))
  if (sigs.size < 2) return false

  // 4. 长度适中（排除"两句完整长歌词挤在同一时刻"这种明显异常）
  const allReasonable = texts.every((t) => t.length <= 120)
  if (!allReasonable) return false

  return group.length <= 4
}

/**
 * 在翻译组里挑出"主歌词"行。
 *
 * 优先选：
 *  1. 含中日韩文字的（原文通常是中文/日文）
 *  2. 文本更长的（翻译一般比原文短或等长）
 *  3. 原始行号更小的（保持文件里的先后）
 * @param {LyricLine[]} group
 * @returns {LyricLine}
 */
function pickPrimaryLine(group) {
  const hasCJK = (s) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)
  const scored = group.map((line) => ({
    line,
    score: (hasCJK(line.text) ? 100 : 0) + Math.min(line.text.length, 60) - line.sourceLine * 0.001,
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored[0].line
}


/**
 * 写入元数据。未识别的标签进 meta.raw，保证导出时不丢信息。
 * @param {LyricsDoc} doc
 * @param {string} key
 * @param {string} value
 */
function applyMeta(doc, key, value) {
  switch (key) {
    case 'ti':
      doc.meta.title = value
      break
    case 'ar':
      doc.meta.artist = value
      break
    case 'al':
      doc.meta.album = value
      break
    case 'by':
      doc.meta.by = value
      break
    default:
      // re / ve 以及任何未知标签都原样保留
      doc.meta.raw[key] = value
      break
  }
}

/**
 * 找出时间完全重复的行分组。
 * @param {LyricLine[]} lines 已排序
 * @returns {LyricLine[][]}
 */
function findDuplicateTimes(lines) {
  /** @type {LyricLine[][]} */
  const groups = []
  let i = 0
  while (i < lines.length) {
    let j = i + 1
    while (j < lines.length && lines[j].t === lines[i].t) j++
    if (j - i > 1) groups.push(lines.slice(i, j))
    i = j
  }
  return groups
}

function formatSec(t) {
  return t.toFixed(2)
}

/**
 * 把 offset 应用到一组歌词行，返回全新数组。
 *
 * **这是 offset 正确性的唯一实现**（reapplyOffset 也走它，避免两份逻辑走偏）。
 *
 * 关键：时间永远从 `rawT` 重算，绝不在现有 `t` 上叠加增量。
 * 因此 +500 → -300 → +500 的结果与直接设 +500 完全一致，不存在累积误差。
 *
 * @param {LyricLine[]} lines
 * @param {number} offsetMs
 * @returns {{lines: LyricLine[], negativeCount:number}}
 */
export function withOffset(lines, offsetMs) {
  const offsetSec = (Number.isFinite(Number(offsetMs)) ? Number(offsetMs) : 0) / 1000
  let negativeCount = 0

  // 1) 基于 rawT 重算时间，并**清空**所有依赖 id/顺序的派生字段，
  //    因为重排后 id 会变，旧的 duplicateOf / isTranslation 会失效变脏。
  const out = lines.map((line) => {
    let t = line.rawT - offsetSec
    if (t < 0) {
      t = 0
      negativeCount++
    }
    return {
      ...line,
      t,
      // 逐字时间跟着一起偏移：否则"行时间点对了、字还停在原处"
      chars: offsetChars(line.chars, line.rawT, offsetSec),
      duplicateOf: [],
      isTranslation: false,
    }
  })

  // 2) 稳定排序（相同时间保持文件原顺序）
  out.sort((a, b) => (a.t - b.t) || (a.sourceLine - b.sourceLine))

  // 3) 排序确定后再分配 id，保证 id 与最终顺序一致
  for (let i = 0; i < out.length; i++) out[i].id = `L${i}`

  // 4) 用最终 id 重建重复/翻译关系
  const dupGroups = findDuplicateTimes(out)
  for (const g of dupGroups) {
    for (const line of g) {
      line.duplicateOf = g.filter((x) => x.id !== line.id).map((x) => x.id)
    }
    if (looksLikeTranslationGroup(g)) {
      const primary = pickPrimaryLine(g)
      for (const line of g) line.isTranslation = line.id !== primary.id
    }
  }

  return { lines: out, negativeCount }
}

/**
 * 重新应用 offset（保留此名以表达语义：offset 变化后重算）。
 * @param {LyricsDoc} doc
 * @param {number} offsetMs
 */
export function reapplyOffset(doc, offsetMs) {
  return withOffset(doc.lines, offsetMs)
}
