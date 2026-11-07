// @ts-check
/**
 * 逐字（增强 LRC）数据层纯函数 —— 禁止 import vue。
 *
 * 【为什么单独成一个模块】
 * 逐字进度有两个消费者：预览（LyricLine 的 background-clip:text 渐变）与
 * 导出（renderFrame 的 clip 重绘）。两边必须落在**同一个**几何公式上，
 * 否则「预览亮到这儿、导出亮到别处」这种偏差肉眼几乎无法验收。
 * 把公式放在一处、两边都 import，是从结构上保证一致 —— 而不是两边各写一遍再对齐。
 *
 * 本文件同时承载逐字打轴的**规则**（拆字 / 标点跟随 / 状态机 / 持久化）。
 * 理由相同：规则只能有一份实现。而且 store 依赖 pinia 与 @ 别名，
 * Node 里 import 不进来；规则放在纯函数层，scripts/test-core.mjs 才能断言
 * **真实代码**，而不是断言一份在测试里复刻的镜像。
 *
 * 【对外契约（渲染侧只认这两个）】
 *   charProgressAt(chars, timeSec) -> 0..1
 *   isCharTimed(line)             -> boolean
 * 其余导出都是打轴层的辅助函数，渲染侧不要用它们。
 */

/** 逐字撤销栈上限（与逐行打轴同量级，逐字步长更小所以同样够用） */
export const CHAR_UNDO_LIMIT = 100

/** 逐字草稿的 localStorage 键（与逐行的 sessionStorage 键完全分开） */
export const CHAR_STORAGE_KEY = 'lrc-scroller:charTapping:v1'

/** 持久化结构版本：将来改形状时可以按版本迁移，而不是让老草稿炸掉 */
export const CHAR_STORAGE_VERSION = 1

/**
 * 由纯标点/空白组成的片段。
 *
 * 【为什么在这里再写一遍，而不是从 lrcParser 引】
 * lrcParser 没有导出它的这个正则，而「标点跟随前一个字」是**同一条规则**：
 * 解析器用它把增强标签里的标点并进前一段，逐字打轴用它把标点并进前一个字。
 * 两边必须是同一份字符集，否则同一个全角逗号在解析器里跟随、在打轴里却独立成字。
 * 这里逐字复制 lrcParser.FOLLOWING_PUNCT_RE 的字符集并注明来源，
 * 改动时两处一起改（有测试盯着：见 charTapping 拆字组）。
 */
const FOLLOWING_PUNCT_RE =
  /^[\s\u3000.,!?;:'"()\[\]{}<>《》〈〉「」『』【】、。，；：！？…—–·・~～_“”‘’\-]+$/u

/** 单个字符是否为空白（空格不单独成字） */
const BLANK_CHAR_RE = /^[\s\u3000]$/u

/**
 * 「不按空格分词」的文字：中日韩 + 泰/老/缅。
 *
 * 【为什么用这个集合判定"要不要按词"
 * 逐字打轴的粒度必须跟着**书写系统**走：
 *   中文「今天很好」— 一个字一个节奏，按词打会漏掉字内的拍点；
 *   英文「Hello world」— 字母没有独立节奏，按字母打只会得到一串
 *   几乎等间隔的假时间点，用户还得按 11 次空格。
 * 所以判定不是"是不是英文"，而是"这种文字有没有词间空格"。
 *
 * 【为什么不把 CJK 标点（\u3000-\u303F）算进来】
 * 英文行里偶尔混一个全角逗号（"Hello，world"），标点不该让整行退回逐字。
 * 这里只收真正的文字区段（含假名、谚文、注音、CJK 扩展）。
 */
const NO_WORD_SPACE_RE =
  /[\u0E00-\u0EFF\u1000-\u109F\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/

/** 按空格分词的文字（拉丁 / 希腊 / 西里尔）。没有这些字母就谈不上"按词" */
const WORD_LETTER_RE = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/

/**
 * 逐字进度的插值模式。
 *
 * 【为什么要留这个开关，而不是写死平滑插值】
 * 两种都有人要：平滑插值观感顺，整字跳变边界绝对清晰。
 * 现在选平滑（默认），但把整字跳变实现好放在这里 ——
 * 将来想换，改的是**调用方传参**，不是重写公式。
 * 若写死在函数体里，将来切换就得同时改预览、导出、测试三处。
 *
 * smooth：字与字之间按时间线性渐变（当前默认）
 * step  ：到达某字时间点才整字变色
 */
export const CHAR_PROGRESS_MODES = /** @type {const} */ (['smooth', 'step'])

export const DEFAULT_CHAR_PROGRESS_MODE = /** @type {const} */ ('smooth')

/**
 * 逐字进度：时间点在 chars 上的位置，0..1。
 *
 * 【为什么用 (i + ratio) / chars.length】
 * 每个字占 1/n 的宽度。t 落在第 i 个字与第 i+1 个字之间时，
 * 已经唱完 i 个字，再加这**一个字内部**的比例 ratio —— 于是进度是连续的，
 * 且 t 到达末字时间时恰好等于 1（不是 1 再多一点）。
 *
 * 【step 模式与 smooth 的唯一差别】
 * ratio 恒为 0：第 i 个字的时间点一到，进度就跳到 (i+1)/n 之外的下一个字之前，
 * 即"整字变色"。公式骨架完全相同，只差 ratio 一项 —— 所以两种模式
 * 不可能在边界处理（首字前 / 末字后 / 相等时间）上产生分歧。
 *
 * 【末字之后为什么直接 1】
 * 逐字高亮的语义是「唱到哪个字」。末字唱完就整行全亮，
 * 不该把最后一个字的时长硬拉到行尾（行尾可能是 5 秒后的间奏）——
 * 那会让整行颜色在半句之后一直空转。
 *
 * 【weights 只给「按词打轴」用】
 * 默认等权（每个单元 1/n 宽度）—— 中文逐字正好成立，一个字一格。
 * 英文按词打轴时等权就错了：「I」和「extraordinary」各占 1/n，
 * 扫色会在长词上突然变慢、在 "I" 上瞬间跳过。传 weights（= 每个单元的
 * 宽度份额，见 unitWeights）就把份额按宽度分配，扫色速度才是均匀的。
 * 不传 = 原有等权行为，一个像素都不变。
 *
 * @param {Array<{c:string, t:number}>|null|undefined} chars
 * @param {number} timeSec
 * @param {"smooth"|"step"} [mode] 缺省 smooth（保持既有调用方行为不变）
 * @param {number[]|null} [weights] 每个单元的宽度份额；缺省/长度不符时等权
 * @returns {number} 0..1
 */
export function charProgressAt(chars, timeSec, mode = DEFAULT_CHAR_PROGRESS_MODE, weights = null) {
  if (!Array.isArray(chars) || chars.length === 0) return 0
  if (!Number.isFinite(timeSec)) return 0

  const n = chars.length
  if (timeSec <= chars[0].t) return 0
  if (timeSec >= chars[n - 1].t) return 1

  /*
   * 二分找「最后一个 t <= timeSec 的下标」。
   * 【为什么取最后一个而不是第一个】
   * 相邻两个字时间完全相等是合法的（手打轴很容易按出同一个时间）。
   * 若取第一个，i 与 i+1 的时间相同 → 区间宽度为 0 → 除零。
   * 取最后一个的话，只有 chars[i+1].t > timeSec 的区间才会被选中，
   * 区间宽度必然 > 0，除零从数据上就不可能出现。
   */
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (chars[mid].t <= timeSec) lo = mid
    else hi = mid - 1
  }

  // 权重表必须与 chars 等长，否则一律退回等权（脏数据不能改变进度口径）
  const useWeights = Array.isArray(weights) && weights.length === n

  /** 取第 i 个单元的权重；0/负数/非数都退回 1，绝不产生除零 */
  const weightOf = (i) => {
    if (!useWeights) return 1
    const v = Number(/** @type {number[]} */ (weights)[i])
    return Number.isFinite(v) && v > 0 ? v : 1
  }

  // step 模式：不做字内插值，落在第 lo 个字就算 lo 个字已唱完
  if (mode === 'step') {
    if (!useWeights) return lo / n
    let done = 0
    let sum = 0
    for (let i = 0; i < n; i++) {
      const w = weightOf(i)
      sum += w
      if (i < lo) done += w
    }
    return sum > 0 ? done / sum : 0
  }

  const span = chars[lo + 1].t - chars[lo].t
  // 防御：脏数据（NaN 时间）也可能走到这里，宁可退化成「整字完成」也不要 NaN
  const ratio = span > 0 ? (timeSec - chars[lo].t) / span : 0

  if (!useWeights) return (lo + ratio) / n

  // 加权：已完成单元的份额 + 当前单元按 ratio 折进来的那一部分
  let done = 0
  let sum = 0
  let curWeight = 1
  for (let i = 0; i < n; i++) {
    const w = weightOf(i)
    sum += w
    if (i < lo) done += w
    else if (i === lo) curWeight = w
  }
  return sum > 0 ? (done + ratio * curWeight) / sum : 0
}

/**
 * 打轴单元的宽度份额（词级进度用）。
 *
 * 【为什么用「码点数」近似宽度】
 * 逐字进度是一个**百分比**，渲染层再把它乘成像素宽。要让扫色看起来匀速，
 * 份额就得跟着文字的实际横向占位走。而这里拿不到字体度量
 * （纯函数层，预览与导出必须共用同一份，不能在浏览器里测量），
 * 码点数是最便宜且足够准的近似：等宽字体下精确，比例字体下
 * 长词/短词的误差也远小于「等权」造成的错误（"I" 与 "extraordinary" 同权）。
 *
 * 尾随空格也算一份 —— 它确实占了行内的一段宽度；
 * 不计入的话每个词的结束位置都会比实际略早一点，累积起来就是可见的偏移。
 *
 * @param {Array<{c:string}>} chars
 * @returns {number[]}
 */
export function unitWeights(chars) {
  const n = Array.isArray(chars) ? chars.length : 0
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const c = chars[i] && typeof chars[i].c === 'string' ? chars[i].c : ''
    const w = [...c].length
    out[i] = w > 0 ? w : 1
  }
  return out
}

/**
 * 这一行是否有可用的逐字时间。
 *
 * 【为什么要求「全是有限数」】
 * 只要有一个 t 是 null/NaN，进度公式就会算出 NaN，
 * 而 NaN 传给 CSS 的 background-size 或 canvas 的 clip 宽度会**静默失效**：
 * 进度色整块不显示，也不报错。这种「看起来只是没生效」的故障最难查，
 * 所以在入口处一次性判掉。
 *
 * @param {{chars?:Array<{t:unknown}>|null}|null|undefined} line
 * @returns {boolean}
 */
export function isCharTimed(line) {
  if (!line || typeof line !== 'object') return false
  const chars = /** @type {any} */ (line).chars
  if (!Array.isArray(chars) || chars.length === 0) return false
  return chars.every((ch) => ch && Number.isFinite(/** @type {any} */ (ch).t))
}

/**
 * 双语组里「主行」的下标（同时间、非翻译的那一行）。
 *
 * 【为什么需要这个】
 * 双语歌词里原文与翻译是同一时间的两个物理行。打轴只该打原文 ——
 * 翻译行的内容就是原文的译文，它没有自己的节奏，硬拆成两行去打只会得到
 * 两个几乎相同的时间点（用户实测的痛点）。
 * 所以翻译行一律"跟随主行"：时间跟随、逐字覆盖百分比也跟随。
 *
 * @param {Array<any>} lines 已按时间升序的歌词
 * @param {number} index
 * @returns {number} 主行下标；不是翻译行或找不到同组主行时返回自身
 */
export function mainLineIndexOf(lines, index) {
  const arr = Array.isArray(lines) ? lines : []
  const n = arr.length
  const i = Number.isFinite(index) ? Math.trunc(index) : -1
  if (i < 0 || i >= n) return -1

  const line = arr[i]
  if (!line || !line.isTranslation) return i

  const t = /** @type {any} */ (line).t
  // 同组的定义与 buildLogicalRows 一致：时间完全相同、且相邻
  for (let k = i - 1; k >= 0; k--) {
    if (/** @type {any} */ (arr[k]).t !== t) break
    if (!/** @type {any} */ (arr[k]).isTranslation) return k
  }
  for (let k = i + 1; k < n; k++) {
    if (/** @type {any} */ (arr[k]).t !== t) break
    if (!/** @type {any} */ (arr[k]).isTranslation) return k
  }
  return i
}

/**
 * 可打轴的「行下标」列表 —— 双语时翻译行不参与。
 *
 * 【为什么放在 core 而不是 store】
 * 这条规则有两个消费者：打轴 store（决定"下一行打哪"）与界面（显示"第几/共几"）。
 * 规则一旦分两处写，就会出现"光标跳到翻译行、但进度只算 9 行"这种自相矛盾的界面。
 *
 * @param {Array<any>} lines
 * @returns {number[]} 可打轴的行下标；输入非法时返回空数组
 */
export function tapSlotIndexes(lines) {
  const arr = Array.isArray(lines) ? lines : []
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const line = arr[i]
    if (!line || line.isTranslation) continue
    out.push(i)
  }
  // 整份文件都是翻译行（数据异常）→ 退回全部行，否则一行都打不了
  return out.length ? out : arr.map((_, i) => i)
}

/**
 * 与第 index 行同组、需要跟随它的翻译行下标。
 *
 * "同组"与 buildLogicalRows / 渲染层同口径：时间相同且相邻。
 * 判定用的是**行当前的时间**（打轴草稿不会改 lines），所以反复打轴也稳定。
 *
 * @param {Array<any>} lines
 * @param {number} index
 * @returns {number[]}
 */
export function partnerIndexesOf(lines, index) {
  const arr = Array.isArray(lines) ? lines : []
  const line = arr[index]
  if (!line) return []
  // 只有主行才能"带动"同组：翻译行不驱动任何人，避免误用后互相覆盖
  if (/** @type {any} */ (line).isTranslation) return []
  const t = /** @type {any} */ (line).t
  const out = []
  for (let k = index - 1; k >= 0 && arr[k] && /** @type {any} */ (arr[k]).t === t; k--) {
    if (/** @type {any} */ (arr[k]).isTranslation) out.push(k)
  }
  for (let k = index + 1; k < arr.length && arr[k] && /** @type {any} */ (arr[k]).t === t; k++) {
    if (/** @type {any} */ (arr[k]).isTranslation) out.push(k)
  }
  return out
}

/**
 * 某一行应当显示的逐字进度（0~1）；null 表示这行没有逐字数据。
 *
 * 【翻译行的进度从哪来】
 * 翻译行自己通常没有逐字时间（打轴只打原文），若返回 null，它就会一直
 * 停在当前行色、与原文脱节。这里让它**跟随同组主行的百分比**：
 * 原文唱到 40%，翻译行就从左往右覆盖 40% —— 这就是预览与导出共同的口径。
 *
 * 翻译行如果有自己的 chars（历史数据/手动补过），优先用自己那份，
 * 不覆盖用户已有的精确数据。
 *
 * 【词级行为什么要传权重】
 * 英文行的单元是"词"，等权会让长短词的扫色速度差好几倍（"I" 瞬间跳过、
 * "extraordinary" 拖得很慢）。词级行按宽度份额算，扫色才匀速。
 * 判定用的是**行正文**而不是 chars 的形状：从增强 LRC 解析回来的词级
 * 字表没有额外标记，靠正文才能认出"这是一行英文"。
 *
 * @param {Array<any>} lines
 * @param {number} index
 * @param {number} timeSec
 * @param {'smooth'|'step'} [mode]
 * @returns {number|null}
 */
export function charProgressForLine(lines, index, timeSec, mode = DEFAULT_CHAR_PROGRESS_MODE) {
  const arr = Array.isArray(lines) ? lines : []
  const line = arr[index]
  if (!line) return null

  if (isCharTimed(line)) return charProgressAt(line.chars, timeSec, mode, weightsForLine(line))

  const main = mainLineIndexOf(arr, index)
  if (main >= 0 && main !== index) {
    const target = arr[main]
    if (target && isCharTimed(target)) {
      return charProgressAt(target.chars, timeSec, mode, weightsForLine(target))
    }
  }
  return null
}

/**
 * 某一行的进度权重：词级行给宽度份额，其余返回 null（= 等权）。
 *
 * 权重按 chars 数组缓存：播放时每帧都会为可见的每一行调用一次，
 * 而 chars 数组在一次播放里是不变的（改歌词会换新数组）——
 * 缓存掉的不只是 allocation，还有每帧 O(n) 的重新计算。
 * 用 WeakMap 是为了让旧歌词的缓存随数组一起被回收，不需要手动清理。
 * @type {WeakMap<object, number[]>}
 */
const weightCache = new WeakMap()

/**
 * @param {any} line
 * @returns {number[]|null} null = 用等权
 */
function weightsForLine(line) {
  const chars = line && line.chars
  if (!Array.isArray(chars) || chars.length === 0) return null

  // 行正文缺失（只解析出 chars 的极老数据）→ 用字表拼回来判定，结论一样
  const text =
    typeof line.text === 'string' ? line.text : chars.map((ch) => (ch && typeof ch.c === 'string' ? ch.c : '')).join('')
  if (tapUnitModeOf(text) !== 'word') return null

  const hit = weightCache.get(chars)
  if (hit && hit.length === chars.length) return hit
  const w = unitWeights(chars)
  weightCache.set(chars, w)
  return w
}

// ── 拆字（标点跟随前字，空格不单独成字）──────────

/**
 * 一个打轴单元是否可以单独打轴（纯空白不算）。
 * 拆字结果里本来就不该出现纯空白单元（空格都被并进前一个字了），
 * 这个判断是为「恢复出来的脏草稿」和「整行全是空格」准备的兜底。
 * @param {string} c
 * @returns {boolean}
 */
export function isTappableChar(c) {
  if (typeof c !== 'string' || c === '') return false
  return !/^[\s\u3000]+$/u.test(c)
}

/**
 * 这一行该按「字」还是按「词」打轴。
 *
 * 【规则：跟书写系统走，而不是跟"语言"标签走】
 * - 纯英文/西文（有空格分词、无中日韩泰缅文字）→ 'word'
 *   一次空格吃下一个整词，标点并进词里（"world!" 是一个单元）。
 * - 含中文/日文/韩文/泰文，或者一个字母都没有（纯符号）→ 'char'
 *   一个字一次按键，与既有行为完全一致。
 *
 * 【为什么不用"是否全 ASCII"】
 * 英文歌词里常带重音字母（café、naïve）与弯引号，/^[\x00-\x7F]*$/ 会把
 * 它们判成中文模式，白拆一堆字母。这里只排除"真正的非分词文字"。
 *
 * @param {unknown} text
 * @returns {'char'|'word'}
 */
export function tapUnitModeOf(text) {
  if (typeof text !== 'string' || text === '') return 'char'
  if (NO_WORD_SPACE_RE.test(text)) return 'char'
  if (!WORD_LETTER_RE.test(text)) return 'char'
  return 'word'
}

/**
 * 按「词」拆分（纯英文行用）：一个空格分隔的整词是一个打轴单元。
 *
 * 【三条规则（与逐字版同构，只是把"字"换成"词"】
 * 1. 空白是最强的词边界：遇到空白就把当前词闭合，空白本身并进这个词
 *    （"Hello " 是一个单元）。并进而不是丢掉，是因为渲染层依赖
 *    「所有单元的 c 拼起来 === line.text」这个等式 —— 丢了空格，
 *    预览的换行位置与导出就对不上了。
 * 2. 词内字符（撇号、连字符、词尾标点）一律留在词里：
 *    "don't" / "well-known" / "world!" 都各自是一个单元，不拆开。
 * 3. 纯标点单元没有自己的节奏 → 并进前一个词；行首的并进后一个词。
 *    绝不单独要求用户给一个破折号按一次空格。
 *
 * @param {string} text
 * @returns {Array<{c:string, t:number|null}>}
 */
export function splitWords(text) {
  /** @type {Array<{c:string, t:number|null}>} */
  const out = []
  if (typeof text !== 'string' || text === '') return out

  /** 行首的空白，等第一个词来了并进去 */
  let pending = ''
  /** 当前词是否还"开着"（上一个字符不是空白） */
  let open = false

  for (const ch of text) {
    if (BLANK_CHAR_RE.test(ch)) {
      if (out.length > 0) {
        // 规则 1/2：空白并进前一个词，并把那个词闭合
        out[out.length - 1].c += ch
        open = false
      } else {
        pending += ch
      }
      continue
    }
    if (open) {
      // 规则 2：词内字符（含撇号/连字符/词尾标点）继续挂在当前词上
      out[out.length - 1].c += ch
      continue
    }
    out.push({ c: pending + ch, t: null })
    pending = ''
    open = true
  }

  if (out.length === 0) {
    // 整行只有空白（词模式下实际不会发生，兜底保证不丢内容）
    out.push({ c: pending, t: null })
    return out
  }

  /*
   * 规则 3：合并纯标点单元。
   * 两遍处理是必要的：行首的标点要并进**后**一个词，
   * 而这一步在单遍里还不知道"后面还有没有词"。
   */
  const merged = []
  for (const unit of out) {
    if (FOLLOWING_PUNCT_RE.test(unit.c)) {
      if (merged.length > 0) {
        merged[merged.length - 1].c += unit.c
        continue
      }
      // 还没有前一个词 → 先占位，等下一个词来把它吃掉
      merged.push(unit)
      continue
    }
    if (merged.length === 1 && FOLLOWING_PUNCT_RE.test(merged[0].c)) {
      merged[0].c += unit.c
      continue
    }
    merged.push(unit)
  }
  // 整行全是标点（没有任何词）→ 全并进第一个单元，只留一次按键
  if (merged.length > 1 && merged.every((u) => FOLLOWING_PUNCT_RE.test(u.c))) {
    const all = merged.map((u) => u.c).join('')
    return [{ c: all, t: null }]
  }
  return merged
}

/**
 * 把一行正文拆成**打轴单元**（未打轴时 t 全为 null）。
 *
 * 【粒度按行决定】
 * 纯英文行按词（见 splitWords），其余按字（见 splitLetters）。
 * 上层（store / 应用 / 持久化）只认这一个函数，所以"英文按词"
 * 这条规则只存在一份实现 —— 不会出现"打轴按词、渲染按字母"的错位。
 *
 * @param {string} text
 * @returns {Array<{c:string, t:number|null}>}
 */
export function splitChars(text) {
  if (tapUnitModeOf(text) === 'word') return splitWords(text)
  return splitLetters(text)
}

/**
 * 把一行正文按「字」拆开（中文/混排行的粒度）。
 *
 * 【三条规则（与解析器产出的 chars 语义一致）】
 * 1. 标点跟随前一个字：你好，世界 → ['你','好，','世','界']。
 *    拆出来会让标点比字早亮一次，看起来像闪烁；所以并进前一个字。
 * 2. 空格不单独成字：空格并进**前一个字**，所以它不占一次打轴，
 *    同时 chars 拼起来仍然严格等于 line.text（渲染与导出都依赖这个等式）。
 * 3. 行首的空白/标点没有「前一个字」可跟 → 先暂存，等第一个字来了并进去。
 *    绝不为它单独造一个字，否则首字之前会凭空多出一次空格。
 *
 * @param {string} text
 * @returns {Array<{c:string, t:number|null}>}
 */
export function splitLetters(text) {
  /** @type {Array<{c:string, t:number|null}>} */
  const out = []
  if (typeof text !== 'string' || text === '') return out

  let pending = ''

  for (const ch of text) {
    if (BLANK_CHAR_RE.test(ch)) {
      // 规则 2/3：空格并进前一个字；没有前一个字就先存着
      if (out.length > 0) out[out.length - 1].c += ch
      else pending += ch
      continue
    }
    if (out.length > 0 && FOLLOWING_PUNCT_RE.test(ch)) {
      // 规则 1：标点跟随前一个字
      out[out.length - 1].c += ch
      continue
    }
    out.push({ c: pending + ch, t: null })
    pending = ''
  }

  // 整行只有空白/标点：仍然造一个字，保证 chars 拼回来等于原文（不会静默丢字）
  if (out.length === 0 && pending !== '') out.push({ c: pending, t: null })
  return out
}

/**
 * 光标落到「第一个还没打过的字」（重新定位时用）。
 * 全都打过了就回到 0 —— 用户定位回来通常是想重打这一行。
 * @param {Array<{t:number|null}>} chars
 * @returns {number}
 */
export function charRelocateCursor(chars) {
  if (!Array.isArray(chars)) return 0
  for (let i = 0; i < chars.length; i++) {
    if (!Number.isFinite(chars[i].t)) return i
  }
  return 0
}

/**
 * 取（或建）某一行的逐字草稿。
 * @param {{drafts:Record<string, any>}} state
 * @param {number} lineIndex
 * @param {string} text
 * @returns {Array<{c:string, t:number|null}>}
 */
function ensureDraft(state, lineIndex, text) {
  const existing = state.drafts[lineIndex]
  if (Array.isArray(existing) && existing.length > 0) return existing
  const chars = splitChars(text)
  state.drafts[lineIndex] = chars
  return chars
}

/**
 * 这一行现在能不能逐字打轴；能则返回 null，不能则返回给用户看的原因。
 *
 * 【为什么必须有这道闸】
 * 逐字时间是**行时间的细化**：没有行时间，字时间就没有参照系
 * （整行在时间轴上的位置都不确定）。静默接受会让歌词的时间轴自相矛盾，
 * 所以宁可拒绝并说清楚，也不能悄悄记一个孤儿时间。
 *
 * @param {{t?:unknown, text?:unknown}|null|undefined} line
 * @returns {string|null}
 */
export function charTapRefusal(line) {
  if (!line || typeof line !== 'object') return '这一行不存在，无法逐字打轴'
  /*
   * 【为什么不能只写 Number.isFinite(Number(line.t))】
   * Number(null) === 0 且是有限数 —— 于是 t:null 的「没有行时间」会被误判成
   * 「行时间 = 0 秒」而放行。必须要求它本来就是 number 且有限。
   */
  const t = /** @type {any} */ (line).t
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    return '请先给该行打行时间，再做逐字打轴'
  }
  const text = /** @type {any} */ (line).text
  if (typeof text !== 'string' || splitChars(text).length === 0) return '该行没有可打轴的字'
  return null
}

// ── 逐字打轴状态机（纯数据，不读任何时钟）─────────

/**
 * 新建一份逐字状态。
 *
 * 【字段名故意与逐行的 tapped/editingIndex/undoStack 完全不同】
 * 两套草稿必须能被静态区分：看一眼字段就知道在改哪一套，
 * 也就不可能出现「逐字写入把逐行草稿覆盖了」这类跨模式污染。
 *
 * @returns {{drafts:Record<number, Array<{c:string, t:number|null}>>, lineIndex:number, cursor:number, undo:Array<any>}}
 */
export function createCharTapState() {
  return { drafts: {}, lineIndex: 0, cursor: 0, undo: [] }
}

/**
 * 记录一次逐字打轴：给当前光标处的字写上 t，然后前进。
 *
 * 【时间从哪来】
 * 只认调用方传进来的 t（浏览器里就是 player.currentTime，音频真实播放位置）。
 * 这里绝不读 performance.now / Date.now，也绝不按「两次按键的间隔」累加 ——
 * 变速播放时按键间隔与音频时间不是同一回事，累加法会得到一条越走越偏的时间轴。
 *
 * 【就地改写 state】
 * state.drafts / state.undo 是调用方持有的对象引用（在 store 里是响应式对象）。
 * 返回新对象会让 Pinia 丢掉引用、界面不更新；所以规则是「就地改 + 返回结果」。
 *
 * @param {{drafts:Record<number, any>, lineIndex:number, cursor:number, undo:Array<any>}} state
 * @param {Array<{t:number, text:string}>} lines 打轴目标行（tapTarget）
 * @param {number} t 音频真实播放位置（秒）
 * @returns {{ok:boolean, blocked?:boolean, reason?:string, lineIndex?:number, charIndex?:number, c?:string, t?:number, isNew?:boolean, nextLineIndex?:number, nextCursor?:number}}
 */
/**
 * 从 from 之后找下一行「可逐字打轴的主行」。
 * 跳过翻译行（跟随主行），也跳过没有正文的行（空行/间奏）。
 * @param {Array<any>} lines
 * @param {number} from
 * @returns {number} 下标；没有则 -1
 */
function nextTappableLineIndex(lines, from) {
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.isTranslation) continue
    if (charTapRefusal(line)) continue
    return i
  }
  return -1
}

export function charTapStep(state, lines, t) {
  if (!state || typeof state !== 'object' || !state.drafts) {
    return { ok: false, blocked: true, reason: '逐字打轴状态缺失' }
  }
  const list = Array.isArray(lines) ? lines : []

  // 行下标越界保护：歌词变少（重新导入）时不要访问不存在的行
  const origLine = state.lineIndex
  const origCursor = state.cursor
  let li = Number.isFinite(origLine) ? Math.trunc(origLine) : 0
  if (li < 0) li = 0
  if (li > list.length - 1) li = Math.max(0, list.length - 1)

  const refuse = charTapRefusal(list[li])
  if (refuse) {
    state.lineIndex = li
    return { ok: false, blocked: true, reason: refuse }
  }
  if (!Number.isFinite(t)) {
    state.lineIndex = li
    return { ok: false, blocked: true, reason: '播放头时间不可用，无法记录' }
  }

  const chars = ensureDraft(state, li, /** @type {any} */ (list[li]).text)

  /*
   * 越界保护：光标可能等于 chars.length —— 那是「这一行已经打完」的正常状态
   * （末行末字打完后停在这里）。此时再按空格必须**覆盖末字**，
   * 不能毫无反应：用户按下去了就得有结果，否则会以为功能坏了。
   */
  let cur = Number.isFinite(origCursor) ? Math.trunc(origCursor) : 0
  if (cur < 0) cur = 0
  if (cur > chars.length - 1) cur = chars.length - 1

  // 空格落在纯空白字上（脏草稿/全空格行）→ 跳过，不记录也不推进
  if (!isTappableChar(chars[cur].c)) {
    state.lineIndex = li
    state.cursor = cur
    return { ok: false, blocked: true, reason: '这一处是空白，不单独打轴' }
  }

  const prevT = Number.isFinite(chars[cur].t) ? chars[cur].t : null
  const isNew = prevT === null

  state.undo.push({ lineIndex: li, cursor: cur, prevT, prevLineIndex: origLine, prevCursor: origCursor })
  if (state.undo.length > CHAR_UNDO_LIMIT) state.undo.shift()

  chars[cur].t = t

  // 前进到下一个可打轴的字
  let next = cur + 1
  while (next < chars.length && !isTappableChar(chars[next].c)) next++

  if (next >= chars.length) {
    /*
     * 本行打完：换到**下一行可打轴的主行**。
     *
     * 【为什么要跳过翻译行】
     * 双语歌词里翻译行紧跟着原文，它没有自己的节奏 —— 让光标停到它上面，
     * 用户就得给译文也逐字打一遍，得到的是与原文几乎重复的一串时间。
     * 翻译行的进度改为跟随主行百分比（见 charProgressForLine），所以这里直接跳过。
     */
    const nextLine = nextTappableLineIndex(list, li)
    if (nextLine >= 0) {
      state.lineIndex = nextLine
      state.cursor = 0
    } else {
      state.lineIndex = li
      state.cursor = chars.length
    }
  } else {
    state.lineIndex = li
    state.cursor = next
  }

  return {
    ok: true,
    lineIndex: li,
    charIndex: cur,
    c: chars[cur].c,
    t,
    isNew,
    nextLineIndex: state.lineIndex,
    nextCursor: state.cursor,
  }
}

/**
 * 撤销一步逐字打轴。
 *
 * 【为什么连光标一起还原】
 * 撤销的语义是「回到按下那次空格之前」。只把 t 清掉、光标却留在下一个字上，
 * 用户再按一次空格就会跳过刚撤销的那个字 —— 撤销变得没用。
 *
 * @param {{drafts:Record<number, any>, lineIndex:number, cursor:number, undo:Array<any>}} state
 * @returns {{lineIndex:number, charIndex:number, t:number|null}|null} 无可撤销时 null
 */
export function charUndoStep(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.undo)) return null
  const snap = state.undo.pop()
  if (!snap) return null

  const chars = state.drafts[snap.lineIndex]
  if (Array.isArray(chars) && chars[snap.cursor]) {
    chars[snap.cursor].t = snap.prevT
  }
  state.lineIndex = Number.isFinite(snap.prevLineIndex) ? snap.prevLineIndex : snap.lineIndex
  state.cursor = Number.isFinite(snap.prevCursor) ? snap.prevCursor : snap.cursor
  return { lineIndex: snap.lineIndex, charIndex: snap.cursor, t: snap.prevT }
}

// ── 持久化（localStorage + textHash 指纹）──────────

/**
 * FNV-1a 32 位字符串哈希。
 *
 * 【为什么不用 crypto.subtle】
 * 它是异步的，而保存动作发生在按键的同步路径上（一次按键存一次）；
 * 引异步会带来「存到一半又按了一下」的竞态。这个哈希只用来判「歌词有没有被改过」，
 * 32 位足够（错判概率 1/2^32，且错了只是丢草稿，不会错位）。
 *
 * @param {string} str
 * @returns {string} 8 位十六进制
 */
export function fnv1a(str) {
  let h = 0x811c9dc5
  const s = typeof str === 'string' ? str : ''
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // 乘 16777619，用移位实现，避免 32 位乘法溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 歌词指纹：把打轴目标行（tapTarget）的正文按顺序拼起来再哈希。
 *
 * 【为什么用正文而不是行数/文件内容】
 * 行数相同但文字改了（改错别字、换翻译）时，下标含义已经变了，
 * 旧草稿套上去就是张冠李戴。正文指纹能把这种改动一次判死。
 *
 * @param {Array<{text?:unknown}>|null|undefined} lines
 * @returns {string}
 */
export function charDraftTextHash(lines) {
  if (!Array.isArray(lines)) return fnv1a('')
  return fnv1a(lines.map((l) => (l && typeof l.text === 'string' ? l.text : '')).join('\n'))
}

/**
 * 把逐字状态序列化成 localStorage 里的字符串。
 *
 * 【只存已打过的字，不存整张字表】
 * 字表可以随时由 line.text 用 splitChars 重建（确定性函数），
 * 存整表只会让草稿随歌词长度膨胀，还多一份「字表和正文不一致」的隐患。
 *
 * @param {{drafts:Record<number, any>, lineIndex:number, cursor:number}} state
 * @param {string} textHash
 * @returns {string}
 */
export function serializeCharState(state, textHash) {
  /** @type {Record<string, Array<{c:string, t:number}>>} */
  const drafts = {}
  const src = state && state.drafts ? state.drafts : {}
  for (const key of Object.keys(src)) {
    const chars = src[key]
    if (!Array.isArray(chars)) continue
    const timed = chars.filter((ch) => ch && typeof ch.c === 'string' && Number.isFinite(ch.t))
    if (timed.length === 0) continue
    drafts[key] = timed.map((ch) => ({ c: ch.c, t: ch.t }))
  }
  return JSON.stringify({
    v: CHAR_STORAGE_VERSION,
    textHash: typeof textHash === 'string' ? textHash : '',
    drafts,
    charLineIndex: Number.isFinite(state && state.lineIndex) ? state.lineIndex : 0,
    charCursor: Number.isFinite(state && state.cursor) ? state.cursor : 0,
  })
}

/**
 * 解析 localStorage 里的逐字草稿。
 *
 * @param {string|null|undefined} raw
 * @param {string} expectedHash 当前歌词的指纹
 * @returns {{ok:true, drafts:Record<number, Array<{c:string,t:number}>>, lineIndex:number, cursor:number}
 *          | {ok:false, reason:'empty'|'corrupt'|'invalid'|'hash-mismatch'}}
 */
export function parseCharState(raw, expectedHash) {
  if (typeof raw !== 'string' || raw === '') return { ok: false, reason: 'empty' }
  let d
  try {
    d = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  if (!d || typeof d !== 'object') return { ok: false, reason: 'invalid' }

  /*
   * 指纹不符 = 歌词被改过/换过 → 草稿作废。
   * 【为什么整份丢弃而不是逐行尽力匹配】
   * 逐字时间的下标含义完全由正文决定，正文变了，行内字符的对应关系就不可信；
   * 半份草稿会让用户看到「有些字莫名其妙已经打过」，且没有任何办法自查。
   * 宁可整份丢掉并明确提示（需求 7 的安全处理）。
   */
  if (typeof d.textHash === 'string' && d.textHash !== (typeof expectedHash === 'string' ? expectedHash : '')) {
    return { ok: false, reason: 'hash-mismatch' }
  }

  /** @type {Record<number, Array<{c:string,t:number}>>} */
  const drafts = {}
  if (d.drafts && typeof d.drafts === 'object') {
    for (const key of Object.keys(d.drafts)) {
      const arr = d.drafts[key]
      if (!Array.isArray(arr)) continue
      const clean = arr
        .filter((ch) => ch && typeof ch.c === 'string' && Number.isFinite(Number(ch.t)))
        .map((ch) => ({ c: ch.c, t: Number(ch.t) }))
      if (clean.length > 0) drafts[key] = clean
    }
  }

  return {
    ok: true,
    drafts,
    lineIndex: Number.isFinite(d.charLineIndex) ? d.charLineIndex : 0,
    cursor: Number.isFinite(d.charCursor) ? d.charCursor : 0,
  }
}

/**
 * 把保存下来的「已打字的稀疏表」补回**完整字表**。
 *
 * 【为什么必须补】
 * 保存时只存了打过时间的字。恢复时如果直接拿它当字表，
 * 未打的字就不见了 —— 光标会跳过它们，用户再按空格会直接落到后面的字上。
 *
 * 【按顺序 + 文字相同对齐，而不是按位置硬塞】
 * 文本一旦有细微变化（多个空格、少个标点），按位置塞就是错位。
 * 按顺序对齐，对不上的字自然回到未打状态 —— 这正好是
 * 需求 6 要的「文本变了 → chars 置 null，不静默错位」。
 *
 * 【粒度改过怎么办（字母草稿 → 词级单元）】
 * 英文从"按字母打"改成"按词打"之后，老草稿里存的是 'H','e','l','l','o '…
 * 而当前单元是 'Hello '。同粒度对齐会一个字都对不上，整行草稿就白丢了。
 * 所以同粒度对齐一条都没命中时，再试一次「按文字拼接对齐」：
 * 把若干个旧片段拼成一个当前单元，词的时间取它**第一个**片段的
 * （第一个字母开口的时刻，正是这个词开始唱的时刻）。
 * 拼接必须严格逐字相等才接受 —— 只要有一处拼不上，就退回"整行未打"，
 * 绝不为了多救几个字而错位。
 *
 * @param {string} text 当前行的正文
 * @param {Array<{c:string, t:number}>|null|undefined} saved
 * @returns {Array<{c:string, t:number|null}>}
 */
export function hydrateCharDraft(text, saved) {
  const chars = splitChars(text)
  if (!Array.isArray(saved) || saved.length === 0) return chars

  let j = 0
  for (let i = 0; i < chars.length && j < saved.length; i++) {
    if (chars[i].c === saved[j].c && !Number.isFinite(chars[i].t)) {
      chars[i].t = saved[j].t
      j++
    }
  }
  // 同粒度已经对上（至少一条）→ 就用它，不再做拼接推断
  if (chars.some((ch) => Number.isFinite(ch.t))) return chars

  return hydrateByConcat(chars, saved) ?? chars
}

/**
 * 把「更细粒度的旧草稿」按文字拼接对齐到当前单元上（见 hydrateCharDraft 说明）。
 * @param {Array<{c:string, t:number|null}>} units 当前单元（会被就地写入 t）
 * @param {Array<{c:string, t:number}>} saved 旧草稿（已按顺序）
 * @returns {Array<{c:string, t:number|null}>|null} 拼不齐 → null
 */
function hydrateByConcat(units, saved) {
  let j = 0
  for (const unit of units) {
    if (j >= saved.length) return null
    const start = j
    let acc = ''
    while (j < saved.length && acc.length < unit.c.length) {
      acc += saved[j].c
      j++
    }
    if (acc !== unit.c) return null
    unit.t = Number.isFinite(saved[start].t) ? saved[start].t : null
  }
  // 旧草稿还剩着 → 说明根本没对齐（例如正文变长了），整行不可信
  return j === saved.length ? units : null
}

/**
 * 把恢复出来的草稿对齐到当前歌词上（行数变了 → 多出的草稿丢弃）。
 *
 * @param {Record<string, Array<{c:string, t:number}>>} savedDrafts
 * @param {Array<{text?:unknown}>} lines 当前 tapTarget
 * @returns {Record<number, Array<{c:string, t:number|null}>>}
 */
export function alignSavedDrafts(savedDrafts, lines) {
  /** @type {Record<number, Array<{c:string, t:number|null}>>} */
  const drafts = {}
  const list = Array.isArray(lines) ? lines : []
  const src = savedDrafts && typeof savedDrafts === 'object' ? savedDrafts : {}

  for (const key of Object.keys(src)) {
    const i = Number(key)
    // 行数变少 → 这一行的草稿没有归属了，直接丢
    if (!Number.isInteger(i) || i < 0 || i >= list.length) continue
    const text = typeof list[i].text === 'string' ? list[i].text : ''
    const hydrated = hydrateCharDraft(text, src[key])
    // 一个字都对不上（正文被改过）→ 这一行视为没有草稿，不要留一堆 null 占位
    if (hydrated.some((ch) => Number.isFinite(ch.t))) drafts[i] = hydrated
  }
  return drafts
}

/**
 * 数一份草稿里已经打过时间的字数（界面进度用）。
 * @param {Array<{t:number|null}>|null|undefined} chars
 * @returns {number}
 */
export function countTimedChars(chars) {
  if (!Array.isArray(chars)) return 0
  let n = 0
  for (const ch of chars) if (ch && Number.isFinite(ch.t)) n++
  return n
}
