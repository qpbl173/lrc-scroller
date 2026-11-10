// @ts-check
/**
 * 歌词虚化（按与当前行的距离渐变透明度）—— 纯函数层，禁止 import vue。
 *
 * 【需求与实现对应】
 *  - 实体区：当前行上下各 N 行完全不透明（上下可分别设置）→ solidAbove / solidBelow
 *  - 过渡区：实体区边缘往外 M 行，透明度 1 → 0 → fadeRows
 *  - 虚化模式：linear / ease / none（默认 ease）→ mode
 *  - 当前行永远 opacity=1 → distance 0 直接返回 1，且最终与基准权重相乘时仍为 1
 *  - 双语歌词"算一行" → 时间相同的连续行归为同一个「逻辑行」，距离按逻辑行算
 *  - 空行按同样规则 → 不做特殊处理，走同一条距离计算
 *
 * 【为什么要「逻辑行」这个概念】
 * 中文 LRC 里原文与译文时间完全相同（`[00:05.00]原文` + `[00:05.00]译文`）。
 * 若按物理行号算距离，译文会白白多占一格，导致上下不对称、观感错乱。
 * 归组之后，原文与译文属于同一逻辑行，距离相同、一起淡出，符合需求。
 *
 * 【性能设计】
 * 距离只取决于「逻辑行序号之差」，与时间无关，因此每次重算都是 O(n) 的纯算术，
 * 不做任何 DOM 读取。配合 createFadeEngine 的缓存，只有 activeIndex 或配置变化时才重算，
 * 播放过程中（同一行内时间推进）完全不会触发。
 */

/** 虚化模式白名单 */
export const FADE_MODES = ['linear', 'ease', 'none']

/**
 * 非虚化因素造成的基准透明度。
 * 这些原本由 CSS 类控制；现在改为与虚化值相乘后统一用内联 opacity 输出，
 * 好处：只有一个透明度来源，不会出现"CSS 类与内联样式互相覆盖"的怪现象。
 */
export const BASE_OPACITY = {
  active: 1,
  past: 0.38,
  upcoming: 0.55,
}

/**
 * 虚化的默认设置。
 *
 * 默认开启：这是用户明确要求的功能，默认关闭会让"做完却看不到效果"。
 * 但保留 enabled 开关，方便一键关闭回到纯粹的按行显示。
 */
export function createDefaultFade() {
  return {
    enabled: true,
    /** 当前行上方保持完全不透明的行数 */
    solidAbove: 2,
    /** 当前行下方保持完全不透明的行数 */
    solidBelow: 2,
    /** 实体区之外向外渐变的行数（线性/ease 模式生效） */
    fadeRows: 5,
    /** linear | ease | none */
    mode: 'ease',
  }
}

/**
 * 把物理行按「时间相同」归并为逻辑行。
 *
 * @param {Array<{t:number}>} lines 必须已按时间升序（歌词始终满足）
 * @returns {{rowOf:Int32Array, rowCount:number, rowSize:Int32Array}}
 *   rowOf[i]   = 第 i 个物理行所属的逻辑行序号
 *   rowSize[r] = 第 r 个逻辑行包含几个物理行（用于诊断与测试）
 */
export function buildLogicalRows(lines) {
  const n = lines.length
  const rowOf = new Int32Array(n)
  /** @type {number[]} */
  const sizes = []

  let row = -1
  /** @type {number|null} */
  let lastT = null

  for (let i = 0; i < n; i++) {
    const t = lines[i]?.t
    if (lastT === null || t !== lastT) {
      row++
      sizes.push(0)
      lastT = t
    }
    rowOf[i] = row
    sizes[row]++
  }

  return {
    rowOf,
    rowCount: row + 1,
    rowSize: Int32Array.from(sizes),
  }
}

/**
 * 标记「双语组内、位于第一行之后」的物理行。
 *
 * 【为什么需要它】
 * 双语行间距设置只该压紧「同一时间轴的原文/译文」这一对之间的空隙，
 * 不能碰双语组与双语组之间、以及普通单语行之间的行距。
 * 判定必须是"组内非首行"而不是"isTranslation"：
 *   - 文件顺序可能是「译文、原文」，此时第二行是主行（isTranslation=false），
 *     按 isTranslation 判定会漏掉这一组；
 *   - 组内首行前面接的是别的组，若给它加负间距，就会把组间距也一起压缩。
 *
 * 组的归并与虚化完全一致（buildLogicalRows，按时间相同归并）；
 * 只有组内**至少有一行**被解析器标记为翻译行，才算双语组
 * （见 lrcParser 的 looksLikeTranslationGroup / isTranslation）。
 *
 * @param {Array<{t:number, isTranslation?:boolean}>} lines 必须已按时间升序
 * @returns {Uint8Array} 1 = 该行是双语组内的第二行及以后（应用双语间距）
 */
export function markBilingualSeconds(lines) {
  const arr = Array.isArray(lines) ? lines : []
  const n = arr.length
  const out = new Uint8Array(n)
  if (n < 2) return out

  const { rowOf, rowCount } = buildLogicalRows(arr)
  /** 每个逻辑行是否为双语组 */
  const bilingual = new Uint8Array(rowCount)
  for (let i = 0; i < n; i++) {
    if (arr[i]?.isTranslation) bilingual[rowOf[i]] = 1
  }

  for (let i = 1; i < n; i++) {
    if (rowOf[i] === rowOf[i - 1] && bilingual[rowOf[i]]) out[i] = 1
  }
  return out
}

/**
 * 应用缓动曲线。
 *
 * @param {number} p 归一化进度 0~1
 * @param {'linear'|'ease'|'none'} mode
 * @returns {number}
 */
export function applyFadeEasing(p, mode) {
  const x = p < 0 ? 0 : p > 1 ? 1 : p
  if (mode === 'linear') return x
  if (mode === 'none') return x >= 1 ? 1 : x
  // ease：smoothstep。两端平缓、中间变化快，观感比线性柔和，
  // 也让"刚离开实体区"和"即将完全消失"的过渡不那么突兀。
  return x * x * (3 - 2 * x)
}

/**
 * 计算某个逻辑行距离对应的虚化透明度（仅虚化因素，不含 active/past 基准）。
 *
 * 【过渡区的精确语义（重要，避免歧义）】
 * 过渡区是一条跨度 fadeRows 行的斜坡：
 *   - 实体区边缘（over = 0）        → 透明度 1
 *   - over = fadeRows（斜坡末端）   → 透明度 0
 *   - over > fadeRows               → 透明度 0
 * 即 fadeRows = 5 时，第 1~4 行是部分可见的渐变行，**第 5 行正好降到 0**。
 * 这样斜坡宽度就等于用户设置的数值，且到边界恰好归零、不留"半透明幽灵行"。
 * 若希望"5 行都还看得见"，把过渡行数设为 6 即可。
 *
 * @param {number} distance 逻辑行距离：负数=在当前行上方，正数=下方，0=当前行
 * @param {{solidAbove:number, solidBelow:number, fadeRows:number, mode:string, enabled?:boolean}} cfg
 * @returns {number} 0~1
 */
export function fadeOpacityForDistance(distance, cfg) {
  if (cfg.enabled === false) return 1
  if (!Number.isFinite(distance)) return 1

  // 当前行永远完全可见（需求明确要求）
  if (distance === 0) return 1

  const above = distance < 0
  const solid = above ? Math.max(0, cfg.solidAbove | 0) : Math.max(0, cfg.solidBelow | 0)
  const abs = Math.abs(distance)

  // 实体区内：完全不透明
  if (abs <= solid) return 1

  // none 模式：实体区外直接不可见（不做渐变）
  if (cfg.mode === 'none') return 0

  const fadeRows = Math.max(0, cfg.fadeRows | 0)
  if (fadeRows === 0) return 0

  const over = abs - solid
  if (over > fadeRows) return 0

  const p = over / fadeRows
  return 1 - applyFadeEasing(p, cfg.mode)
}

/**
 * 计算每一行的最终渲染透明度。
 *
 * 【虚化开启时：透明度完全由距离决定】
 * 需求原文是"实体区保持**完全不透明**"、"过渡区透明度**从 1 渐变到 0**"，
 * 因此开启虚化时：
 *    |距离| ≤ 实体行数        → 1（包括已唱过的行）
 *    实体行数 < |距离| ≤ 实体+过渡 → 从 1 渐变到 0
 *    |距离| > 实体+过渡       → 0
 * 当前行距离为 0，天然为 1。
 *
 * 这里**不再**乘以阶段 3 的 past(0.38)/upcoming(0.55) 基准 ——
 * 那会让"实体区"实际显示为 0.38，与"完全不透明"的字面要求冲突。
 * 虚化的距离层次本身就提供了视觉纵深，无需再叠加一层明暗区分。
 *
 * 虚化关闭时才回落到阶段 3 的基准透明度（已唱过的行更暗）。
 *
 * 【虚化中心：不必是"当前播放行"】
 * 需求：用户滚轮回看时，虚化中心应跟随**视口中心**那一行，
 * 否则用户翻看上下文的歌词会整片糊掉看不清。
 * 因此中心行由调用方通过 centerIndex 指定：
 *   - 自动跟随状态 → 传 activeIndex（当前播放行）
 *   - 用户滚动中   → 传视口中心行
 * 注意：**中心行不一定是正在播放的那一行**。
 * 此时"正在播放的行"不再保持 opacity=1，它的突出由 is-active 类负责
 * （放大 + 变色），不依赖透明度 —— 这样语义统一，不会出现两个"亮点"。
 *
 * @param {Array<{t:number}>} lines
 * @param {number} activeIndex 当前物理行下标（-1 表示尚未开始）；虚化关闭时用于 past/upcoming 判定
 * @param {{solidAbove:number, solidBelow:number, fadeRows:number, mode:string, enabled?:boolean}} cfg
 * @param {{active:number,past:number,upcoming:number}} [base] 仅在虚化关闭时使用
 * @param {number} [centerIndex] 虚化中心行下标；省略时等于 activeIndex
 * @returns {Float64Array} 与 lines 等长
 */
export function computeRenderOpacities(lines, activeIndex, cfg, base = BASE_OPACITY, centerIndex = activeIndex) {
  const n = lines.length
  const out = new Float64Array(n)
  if (n === 0) return out

  const fadeOn = cfg.enabled !== false
  const { rowOf, rowCount } = buildLogicalRows(lines)

  // 中心行所在逻辑行：下标无效时按"尚未开始"处理，
  // 此时把第 0 个逻辑行当作中心，避免整屏全透明。
  let centerRow
  if (centerIndex >= 0 && centerIndex < n) {
    centerRow = rowOf[centerIndex]
  } else {
    centerRow = 0
  }

  // 预先算好每个逻辑行的虚化值，避免逐行重复调用
  const fadeByRow = new Float64Array(rowCount)
  for (let r = 0; r < rowCount; r++) {
    fadeByRow[r] = fadeOpacityForDistance(r - centerRow, cfg)
  }

  for (let i = 0; i < n; i++) {
    const fade = fadeByRow[rowOf[i]]

    if (fadeOn) {
      // 虚化开启：透明度就是虚化值本身，保证实体区真的为 1
      out[i] = fade
    } else {
      // 虚化关闭：回落到阶段 3 的按行明暗区分
      let weight
      if (i === activeIndex) weight = base.active
      else if (activeIndex >= 0 && i < activeIndex) weight = base.past
      else weight = base.upcoming
      out[i] = weight
    }
  }

  // 只把**虚化中心行**强制为 1（距离 0 已保证，这里是显式兜底）。
  //
  // 刻意不强制 activeIndex 为 1：
  // 用户回看时中心是视口那行，正在播放的行如果还在别处，
  // 它就该按自己的距离正常淡出，而不是留一个孤立的亮点。
  // "正在播放"的视觉突出由 is-active 类（放大 + 变色）负责。
  if (centerIndex >= 0 && centerIndex < n) out[centerIndex] = 1

  return out
}

/**
 * 创建带缓存的虚化计算器。
 *
 * 【为什么需要显式缓存】
 * 组件里用 computed 也能做到"只在 activeIndex 变化时重算"，
 * 但那样无法从外部**证明**它真的没有逐帧重算。
 * 这里显式记账，验收脚本可以直接读 computeCount：
 * 播放 5 秒但当前行只变 2 次时，computeCount 应只增加 2，而不是增加 300（帧数）。
 *
 * 【用户滚动时也只在"中心行变化"时重算】
 * 缓存键包含 centerIndex，因此滚动过程中：
 *   - 同一行内滚动 → 键不变 → 命中缓存，不重算
 *   - 跨过一行     → 键变化 → 重算一次
 * 实测 1000 行滚动时重算次数与"跨过的行数"同量级，不是帧数。
 *
 * @returns {{get:(lines:any[], activeIndex:number, cfg:any, centerIndex?:number)=>Float64Array, computeCount:()=>number, invalidate:()=>void}}
 */
export function createFadeEngine() {
  let cachedKey = ''
  let cached = new Float64Array(0)
  let computeCount = 0

  /**
   * @param {Array<{t:number}>} lines
   * @param {number} activeIndex
   * @param {any} cfg
   * @param {number} [centerIndex] 虚化中心行；省略时等于 activeIndex
   */
  function get(lines, activeIndex, cfg, centerIndex = activeIndex) {
    const key = [
      lines.length,
      activeIndex,
      centerIndex,
      cfg.enabled === false ? 'off' : 'on',
      cfg.solidAbove,
      cfg.solidBelow,
      cfg.fadeRows,
      cfg.mode,
      // 用首行时间做轻量校验：歌词被替换时（行数可能相同）也能失效
      lines.length ? lines[0].t : '',
      lines.length ? lines[lines.length - 1].t : '',
    ].join('|')

    if (key === cachedKey) return cached

    computeCount++
    cached = computeRenderOpacities(lines, activeIndex, cfg, BASE_OPACITY, centerIndex)
    cachedKey = key
    return cached
  }

  return {
    get,
    computeCount: () => computeCount,
    invalidate: () => {
      cachedKey = ''
    },
  }
}
