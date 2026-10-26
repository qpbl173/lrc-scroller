// @ts-check
/**
 * 单帧渲染 —— 纯函数层，禁止 import vue。
 *
 * 【本文件的核心契约：导出 = 预览】
 *
 * 预览是 DOM + CSS 排版，导出是 canvas 重画。两者是两套实现，
 * 因此**每一条会动、可自定义的视觉属性都必须在这里逐条复刻**，
 * 否则用户一改设置就会出现"导出和预览不一样"。
 *
 * 已被对齐的属性（每条都对应预览里的一条 CSS，改动前请先看 LyricLine.vue）：
 *   font.family / size / weight / letterSpacing / lineHeight / scale
 *   color.normal / active / bg / bgMode
 *   layout.align / maxWidth / padTop
 *   motion.transitionMs（缩放过渡）/ activeFadeMs（颜色与透明度过渡）
 *   motion.scrollMode（center / golden 锚点）/ reduceMotion（不做动效）
 *   fade.*（交给 core/fade.js，与预览同一个函数）
 *
 * 【为什么行几何要"逐行算"而不是一个统一 lineH】
 * 预览的 useAutoScroll.measure() 读的是每一行的 offsetTop/offsetHeight，
 * 而**自动换行的行长高了**（`.lyric-line__text` 有 max-width + break-word）。
 * 早先导出假设所有行等高：只要有一句换行，后面每一行都会越偏越多
 * （实测单行换行使后续行偏移 64px）。
 * 现在 measureRowLayout 逐行算高度，字号/行距/字间距/maxWidth 怎么改都能跟上。
 *
 * 【坐标系：预览舞台 → 画布 的等比缩放】
 * 预览把 font.size 当**绝对像素**（40px 就是 40px），能看到几行由舞台高度决定。
 * 导出分辨率由用户选（480p~4K），所以所有尺寸都乘 scale = 画布高 / 舞台高，
 * 使字号、行距、留白**占画面的比例**与预览一致。
 * 横向同理按 scale 缩放舞台宽度，于是换行位置也与预览一致 ——
 * 画布比舞台"更宽"时多出来的部分用背景色补边（用户看不到接缝）。
 */
import { charProgressAt, isCharTimed } from './charProgress.js'
import { hexToRgb } from './color.js'
import { computeRenderOpacities, createDefaultFade } from './fade.js'
import { smoothTowards, computeCenteringOffset } from './scroll.js'
import { findLineIndexAt } from './timeUtils.js'
import { easeCurve, transitionCurve, progress, lerp } from './motion.js'
import { resolveStrokeColor } from './settings.js'

/** 设计基准高度（px）：字号以这个高度为准定义 */
export const BASE_HEIGHT = 1080

/** 行高兜底值：settings.font 缺失时用它，避免除零/NaN 崩溃 */
export const FALLBACK_LINE_H = 60

/** 滚动过渡的半衰期（毫秒），与 useAutoScroll 的默认值一致 */
export const SCROLL_SETTLE_MS = 90

/**
 * `.lyric-line` 的上下 padding，单位 em（见 LyricLine.vue 的
 * `padding: calc(var(--lrc-font-size) * 0.18) 0`）。
 */
export const LINE_PADDING_EM = 0.18

/**
 * 翻译行的字号比例（见 LyricLine.vue 的
 * `.lyric-line.is-translation .lyric-line__text { font-size: 0.62em }`）。
 */
export const TRANSLATION_FONT_EM = 0.62

/**
 * 间奏空行的占位文字（见 LyricLine.vue 的 `label()`）。
 *
 * 预览对空行显示「（间奏）」而不是留白，导出若跳过空行，
 * 就会在间奏处突然空掉一整行 —— 画面与预览对不上。
 */
export const EMPTY_LABEL = '（间奏）'

/** 左/右对齐时文字与版心边缘的距离比例（预览是贴边，所以是 0） */
export const EDGE_INSET = 0

/** 虚化关闭时，预览由 CSS 类附加的子元素透明度系数 */
export const CSS_OPACITY = {
  empty: 0.35,
  translation: 0.72,
  translationActive: 0.9,
}

/**
 * 画布相对参考高度的缩放系数。
 *
 * @param {number} canvasHeight
 * @param {number} referenceHeight 预览舞台高度
 * @returns {number}
 */
export function scaleFactor(canvasHeight, referenceHeight) {
  const h = Number(canvasHeight)
  const r = Number(referenceHeight)
  if (!Number.isFinite(h) || h <= 0) return 1
  if (!Number.isFinite(r) || r <= 0) return h / BASE_HEIGHT
  return h / r
}

/**
 * 按最大宽度把文字拆成多行（等价于 CSS 的 `word-break: break-word`）。
 *
 * @param {string} text
 * @param {number} maxW 换行宽度上限（px）
 * @param {(s:string)=>number} measure 文本宽度测量函数
 * @returns {string[]}
 */
export function wrapText(text, maxW, measure) {
  const s = typeof text === 'string' ? text : ''
  if (s === '') return ['']
  if (!(maxW > 0)) return [s]
  if (measure(s) <= maxW) return [s]

  const out = []
  let cur = ''
  for (const ch of s) {
    const next = cur + ch
    if (cur !== '' && measure(next) > maxW) {
      out.push(cur)
      cur = ch
    } else {
      cur = next
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

/**
 * 把文字拆成**至少 `targetLines` 行**，且在不违反行数的前提下用尽量宽的版心。
 *
 * 【为什么需要它】
 * canvas 的 `measureText` 与 DOM 的实际排版存在差异（字体回退、字距调整、
 * letter-spacing 取整）。实测过一个长句在 DOM 里换成 2 行（行高 142px），
 * canvas 却算出"一行装得下" —— 导出会把整句画成一行，**横向溢出到行外**。
 *
 * 只靠"测得准"解决很脆（换台机器/换个字体就又不准）。而 DOM 已经把答案
 * 给了我们：**行高就代表它换了几行**。于是这里反推行数，再找出"仍能断出
 * 这么多行"的最大宽度 —— 断行位置与预览一致，且不依赖测量精度。
 *
 * 【单调性（二分的前提）】
 * 可用宽度越大 → 每行装得越多 → 行数**越少**（单调不增）。
 * 所以"行数 ≥ target"这个谓词在宽度上是**左侧为真**（[0, w*]），
 * 要找的是满足它的**最大**宽度 w*（这样文字不会被挤得比预览更窄）。
 *
 * @param {string} text
 * @param {number} targetLines 期望行数（>=1）；为 1 时等价于按宽度自然换行
 * @param {number} maxW 版心宽度上限
 * @param {(s:string)=>number} measure
 * @returns {string[]}
 */
export function wrapToLineCount(text, targetLines, maxW, measure) {
  const s = typeof text === 'string' ? text : ''
  const n = Math.max(1, Math.round(Number(targetLines) || 1))
  const limit = Number(maxW)
  if (!(limit > 0)) return [s]

  // 目标 1 行且本来放得下 —— 直接返回，省掉二分
  if (n <= 1) return wrapText(s, limit, measure)
  if (s === '') return ['']

  /*
   * 二分：找满足"行数 ≥ n"的最大宽度。
   * mid 用 max(mid, 极小值) 避免踩到 wrapText 对 width<=0 的"整段返回"分支
   * （那会让行数在 0 附近不单调）。
   */
  let lo = 0
  let hi = limit
  const enough = (w) => wrapText(s, Math.max(w, 1e-6), measure).length >= n

  // 连最窄宽度都断不出 n 行（字符数不够）→ 按自然换行返回，不硬凑
  if (!enough(1e-6)) return wrapText(s, limit, measure)

  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (enough(mid)) lo = mid
    else hi = mid
  }

  const out = wrapText(s, Math.max(lo, 1e-6), measure)
  return out.length > 0 ? out : [s]
}

/**
 * 逐行计算排版几何 —— 与 LyricLine.vue 的 CSS 逐项对应。
 *
 * 高度公式：
 *   minH     = baseSize × lineHeight            // min-height
 *   padding  = 2 × baseSize × 0.18              // 上下 padding
 *   contentH = nLines × drawSize × lineHeight   // 文字块自身高度
 *   height   = max(minH, contentH + padding)    // box-sizing: border-box
 *
 * 其中 drawSize 对翻译行是 baseSize × 0.62。实测：
 *   baseSize=40, lh=1.6 → 单行 78.4px、双行 142.4px，与浏览器 measure() 一致。
 *
 * 【domHeights：优先用浏览器实测的行高】
 * 调用方若能从预览 DOM 读到每行的 offsetHeight，就传进来。
 * 这样行位置与预览**逐像素一致**，canvas 只负责决定行内怎么断行。
 * 拿不到 DOM 时才退回上面的公式（单测与无 DOM 环境走这条路）。
 *
 * @param {Object} p
 * @param {Array<any>} p.lines
 * @param {any} p.settings
 * @param {number} p.scale 画布/舞台 缩放系数
 * @param {number} p.layoutWidth 版心宽度（画布像素 = 舞台宽 × scale）
 * @param {(s:string, size:number)=>number} p.measure 文本宽度测量函数
 * @param {number} [p.padTopPx=0] 顶部留白占位块高度（画布像素）
 * @param {number[]|null} [p.domHeights] 预览实测的每行高度（舞台像素）
 * @returns {{rows:Array<any>, contentHeight:number, padTop:number, baseFontSize:number}}
 */
export function measureRowLayout({
  lines,
  settings,
  scale,
  layoutWidth,
  measure,
  padTopPx = 0,
  domHeights = null,
}) {
  const arr = Array.isArray(lines) ? lines : []
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1
  const size = Number(settings?.font?.size)
  const lh = Number(settings?.font?.lineHeight)

  // 字号/行距非法时用兜底值，避免 NaN 传遍整条渲染链
  const baseFontSize = (Number.isFinite(size) && size > 0 ? size : FALLBACK_LINE_H) * k
  const lineHeight = Number.isFinite(lh) && lh > 0 ? lh : 1.6

  const minH = baseFontSize * lineHeight
  const padding = baseFontSize * LINE_PADDING_EM * 2
  const mw = Number(settings?.layout?.maxWidth)
  const maxW = layoutWidth * (Number.isFinite(mw) && mw > 0 ? mw : 0.9)

  const useDom = Array.isArray(domHeights) && domHeights.length === arr.length

  /** @type {Array<any>} */
  const rows = []
  let top = Number.isFinite(padTopPx) ? padTopPx : 0

  for (let i = 0; i < arr.length; i++) {
    const line = arr[i] || {}
    const isTranslation = !!line.isTranslation
    const isEmpty = !!line.empty
    const drawSize = isTranslation ? baseFontSize * TRANSLATION_FONT_EM : baseFontSize

    // 空行走预览的 label()：画占位文字而不是留白。
    // 占位文字用正文尺寸排版（预览的 label() 就在 .lyric-line__text 里，
    // 只有翻译行才缩小），所以不因 isEmpty 调小字号。
    const text = isEmpty ? EMPTY_LABEL : typeof line.text === 'string' ? line.text : ''

    const textLines = (() => {
      /*
       * 换行行数优先由 DOM 实测行高反推 —— 见 wrapToLineCount 的说明。
       * canvas 与 DOM 的字宽存在差异，只信 canvas 会把该换行的长句
       * 画成一行并横向溢出到相邻行上。
       *
       * 【为什么先比 minH】
       * CSS 的 min-height 用的是**正文字号**（`font-size × line-height`），
       * 而翻译行的绘制字号只有 0.62 倍。若行高恰好等于 min-height
       * （即内容本来就装得下、高度由 min-height 决定），
       * 用翻译行的字号去反推会得出"2 行"这种错误结论，
       * 进而把一句短翻译硬拆成两行。所以只有**超过** min-height 时才反推。
       */
      let target = 1
      if (useDom) {
        const dh = Number(domHeights[i])
        const perLine = drawSize * lineHeight
        const hCanvas = dh * k
        if (Number.isFinite(hCanvas) && hCanvas > minH + 1e-6 && perLine > 0) {
          target = Math.max(1, Math.round((hCanvas - padding) / perLine))
        }
      }
      return wrapToLineCount(text, target, maxW, (s) => measure(s, drawSize))
    })()

    let height
    if (useDom) {
      const dh = Number(domHeights[i])
      height = Number.isFinite(dh) && dh > 0 ? dh * k : Math.max(minH, textLines.length * drawSize * lineHeight + padding)
    } else {
      height = Math.max(minH, textLines.length * drawSize * lineHeight + padding)
    }

    rows.push({ top, height, textLines, drawSize, isEmpty, isTranslation })
    top += height
  }

  return {
    rows,
    contentHeight: top,
    padTop: Number.isFinite(padTopPx) ? padTopPx : 0,
    baseFontSize,
  }
}

/**
 * 滚动锚点比例（当前行停在可视高度的哪个位置）。
 * 与 useAutoScroll 的 getBounds/computeTarget 用同一个判据。
 * @param {any} settings
 * @returns {number}
 */
export function anchorRatio(settings) {
  return settings?.motion?.scrollMode === 'golden' ? 0.38 : 0.5
}

/**
 * 让第 `index` 行精确停在锚点位置所需的滚动位移。
 *
 * 【为什么单独导出】
 * `renderPreview`（导出面板的「渲染当前帧」）只需要画一帧，
 * 不能传 `scrollOffset: 0` —— 行位置里含了顶部留白，
 * 传 0 会让当前行停偏（预览里当前行是**居中**的）。
 * 这里复用与 buildOffsetTimeline 完全相同的公式，保证两者一致。
 *
 * @param {{rows:Array<{top:number,height:number}>}} layout
 * @param {number} index
 * @param {number} containerHeight
 * @param {number} [anchor=0.5]
 * @returns {number}
 */
export function centeringOffsetFor(layout, index, containerHeight, anchor = 0.5) {
  const rows = layout?.rows ?? []
  const H = Number(containerHeight)
  if (rows.length === 0 || !(H > 0)) return 0
  const i = index < 0 ? 0 : index >= rows.length ? rows.length - 1 : index
  const a = Number.isFinite(anchor) ? anchor : 0.5

  // 与预览一致地夹取到 [首行居中, 末行居中]，避免露出过多空白
  const o1 = computeCenteringOffset(rows[0], H, a)
  const o2 = computeCenteringOffset(rows[rows.length - 1], H, a)
  const lo = Math.min(o1, o2)
  const hi = Math.max(o1, o2)
  const v = computeCenteringOffset(rows[i], H, a)
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 预计算每一帧的滚动位移（复刻屏幕预览的平滑滚动）。
 *
 * 【存的是"位移"，不是滞后量】
 * 绘制时行中心 y = rowCenter - offset。预览的 rAF 每帧先平滑再写 transform，
 * 所以这里也**先更新再存** —— 早先存更新前的值会让导出稳定滞后一帧
 * （实测切行瞬间导出画面 = 预览的上一帧）。
 *
 * 【初值 = 首行居中】
 * 预览挂载时调用 snapToTarget()，位移直接落在"首行居中"上；
 * 视频第一帧也必须如此，否则开头会有一段本不该有的滑入。
 *
 * @param {Object} p
 * @param {Array<{t:number}>} p.lines 已按时间升序
 * @param {number} p.fps
 * @param {{rows:Array<{top:number,height:number}>}} p.layout 逐行几何
 * @param {number} p.containerHeight 可视高度（画布像素）
 * @param {number} [p.anchor=0.5]
 * @param {boolean} [p.reduce] 减少动态效果：直接对齐，不做补间
 * @param {number} [p.settleMs]
 * @param {number} [p.duration] 总时长（秒）
 * @returns {Float32Array} 与帧数等长
 */
export function buildOffsetTimeline({
  lines,
  fps,
  layout,
  containerHeight,
  anchor = 0.5,
  reduce = false,
  settleMs = SCROLL_SETTLE_MS,
  duration,
}) {
  const arr = Array.isArray(lines) ? lines : []
  const f = Number(fps) > 0 ? Number(fps) : 30
  const rows = layout?.rows ?? []
  const H = Number(containerHeight)

  const dur =
    Number.isFinite(duration) && duration > 0
      ? Number(duration)
      : arr.length > 0
        ? Number(arr[arr.length - 1].t) || 0
        : 0

  const total = Math.max(0, Math.round(dur * f))
  const out = new Float32Array(total)
  if (total === 0 || arr.length === 0 || rows.length === 0 || !(H > 0)) return out

  // 与预览 getBounds() 同一套语义：按"居中几何"算区间（不是 [0, content-H]）
  const a = Number.isFinite(anchor) ? anchor : 0.5
  const targetFor = (idx) => centeringOffsetFor(layout, idx, H, a)

  // 每帧真实时长：smoothTowards 按 dt 做幂运算实现帧率无关，
  // 写死 16.7 会让 30fps 导出的过渡时长变成 60fps 预览的两倍（对不上）。
  const dt = 1000 / f

  // 挂载时预览已经 snapToTarget()，所以初值就是首帧的目标
  let smoothPos = targetFor(findLineIndexAt(arr, 0))

  for (let i = 0; i < total; i++) {
    const target = targetFor(findLineIndexAt(arr, i / f))
    // 先更新再存：与预览"同帧生效"一致（存更新前的值会滞后一帧）
    smoothPos = reduce ? target : smoothTowards(smoothPos, target, dt, settleMs)
    out[i] = smoothPos
  }

  return out
}

/**
 * 背景色（bgMode 优先于自定义色）。
 * 与 core/settings.js 的 toCssVars / StageView 的 --lrc-bg 保持同一套规则 ——
 * 用户改了背景色，导出必须跟着变。
 * @param {{bgMode:string, bg:string}} color
 * @returns {string}
 */
export function resolveBgColor(color) {
  if (color?.bgMode === 'green') return '#00b140'
  if (color?.bgMode === 'black') return '#000000'
  return color?.bg || '#000000'
}

/**
 * 把颜色按透明度合成到画布可用的 rgba 字符串。
 * @param {string} hex
 * @param {number} alpha 0~1
 * @returns {string}
 */
export function rgba(hex, alpha) {
  const c = hexToRgb(hex)
  const a = Number.isFinite(alpha) ? (alpha < 0 ? 0 : alpha > 1 ? 1 : alpha) : 1
  if (!c) return `rgba(255,255,255,${a})`
  return `rgba(${c.r},${c.g},${c.b},${a})`
}

/**
 * 两个 hex 颜色之间的线性混合（用于当前行变色过渡）。
 * 预览的 color 过渡是 CSS 在两端颜色间插值，这里做同一件事。
 * @param {string} from @param {string} to @param {number} x 0~1
 * @returns {{r:number,g:number,b:number}}
 */
export function mixHex(from, to, x) {
  const a = hexToRgb(from) ?? { r: 255, g: 255, b: 255 }
  const b = hexToRgb(to) ?? a
  const t = Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 1
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  }
}

/** 把 RGB 三元组按透明度输出为 rgba 字符串。 */
export function rgbaOf(c, alpha) {
  const a = Number.isFinite(alpha) ? (alpha < 0 ? 0 : alpha > 1 ? 1 : alpha) : 1
  return `rgba(${c.r},${c.g},${c.b},${a})`
}

/**
 * 找出"切换前的当前行"。
 *
 * 同时间的多行（原文 + 翻译）里只有最后一行是 is-active，
 * 所以要跳过整组同时间的行，取**时间严格更小**的最后一行。
 *
 * @param {Array<{t:number}>} lines
 * @param {number} cur
 * @returns {number} 上一个当前行；没有则 -1
 */
export function previousActiveIndex(lines, cur) {
  if (!Array.isArray(lines) || !(cur > 0)) return -1
  const t = lines[cur]?.t
  let j = cur - 1
  while (j >= 0 && lines[j]?.t === t) j--
  return j
}

/**
 * 计算"当前行的缩放/颜色过渡进度"。
 *
 * 预览靠 CSS transition 做到：换行瞬间新行从 1 放大到 scale、旧行缩回 1。
 * 导出必须逐帧重放同一条曲线，否则换行会"啪"地跳变。
 *
 * 【单位换算：t 与 lines[].t 是秒，过渡时长是毫秒】
 * 忘了乘 1000 会让过渡在 0.2 秒后还几乎没开始（进度≈0），
 * 表现为导出画面**永远没有过渡** —— 正是本次要修的 bug 本身。
 *
 * @param {Object} p
 * @param {number} p.t 当前时间（秒）
 * @param {Array<{t:number}>} p.lines
 * @param {number} p.cur 当前行下标
 * @param {number} p.transitionMs transform 过渡时长（毫秒）
 * @param {number} p.fadeMs 颜色/透明度过渡时长（毫秒）
 * @param {boolean} p.reduce 减少动态效果 → 不做过渡
 * @returns {{prev:number, scaleProg:number, colorProg:number}}
 */
export function activeTransition({ t, lines, cur, transitionMs, fadeMs, reduce }) {
  const prev = previousActiveIndex(lines, cur)
  /*
   * 没有上一行（视频从首行开始）时预览不存在过渡 ——
   * 首帧元素就带着 .is-active 渲染，CSS 不会为"创建时就有的类"跑过渡，
   * 所以这里直接算作已完成。
   */
  if (prev < 0 || reduce) return { prev, scaleProg: 1, colorProg: 1 }

  const elapsedMs = (Number(t) - Number(lines[cur]?.t)) * 1000
  return {
    prev,
    scaleProg: progress(elapsedMs, transitionMs, transitionCurve),
    colorProg: progress(elapsedMs, fadeMs, easeCurve),
  }
}

/**
 * 把"距离决定的基础透明度"叠加预览里由 CSS 类负责的额外系数。
 *
 * 虚化开启时预览的透明度**只**来自 fade.js（内联 opacity）；
 * 关闭时才回落到 CSS 类，此时翻译行/空行还有一层子元素透明度：
 *   .lyric-line.is-empty:not(.has-fade) .lyric-line__text { opacity: .35 }
 *   .lyric-line.is-translation:not(.has-fade) .lyric-line__text { opacity: .72 }
 *   .lyric-line.is-translation.is-active:not(.has-fade) .lyric-line__text { opacity: .9 }
 *
 * @param {number} base 行透明度
 * @param {{isTranslation:boolean, isEmpty:boolean}} row
 * @param {boolean} isActive
 * @param {boolean} fadeOn
 * @returns {number}
 */
export function applyCssOpacityFactors(base, row, isActive, fadeOn) {
  if (fadeOn) return base
  let v = Number.isFinite(base) ? base : 1
  if (row?.isEmpty) v *= CSS_OPACITY.empty
  if (row?.isTranslation) v *= isActive ? CSS_OPACITY.translationActive : CSS_OPACITY.translation
  return v
}

/**
 * 在 canvas 上渲染一帧歌词。
 *
 * @param {Object} p
 * @param {number} p.lineIndex 当前行下标（-1 表示还没到第一行）
 * @param {Array<any>} p.lines 已按时间升序
 * @param {any} p.settings
 * @param {number} p.t 当前时间（秒）
 * @param {HTMLCanvasElement} p.canvas 目标画布
 * @param {number} [p.scrollOffset=0] 滚动位移，由 buildOffsetTimeline 提供
 * @param {number} [p.referenceHeight=BASE_HEIGHT] 预览舞台高度
 * @param {number} [p.referenceWidth] 预览舞台宽度；给出时按同一 scale 缩放版心，
 *   使换行位置与预览一致（画布更宽时用背景色补边）
 * @param {ReturnType<typeof measureRowLayout>} [p.rowLayout] 预计算的逐行几何
 * @param {number} [p.padTopRatio] 覆盖顶部留白比例（默认读 settings.layout.padTop）
 * @returns {boolean} 是否真的画了内容
 */
export function renderFrame({
  lineIndex,
  lines,
  settings,
  t,
  canvas,
  scrollOffset = 0,
  referenceHeight = BASE_HEIGHT,
  referenceWidth,
  rowLayout,
  padTopRatio,
}) {
  if (!canvas || typeof canvas.getContext !== 'function') return false
  const ctx = canvas.getContext('2d')
  if (!ctx) return false

  const W = canvas.width
  const H = canvas.height
  if (!(W > 0) || !(H > 0)) return false

  const font = settings?.font ?? {}
  const color = settings?.color ?? {}
  const layoutCfg = settings?.layout ?? {}
  const motion = settings?.motion ?? {}

  // ── 1. 背景（铺满，绿幕/黑幕要覆盖；补边也用它） ──
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = resolveBgColor(color)
  ctx.fillRect(0, 0, W, H)

  if (!Array.isArray(lines) || lines.length === 0) return true

  const k = scaleFactor(H, referenceHeight)

  /*
   * 版心宽度：预览的换行宽度 = 舞台宽 × maxWidth。
   * 这里按同一个 scale 把舞台宽换算到画布像素，于是**换行位置与预览一致**，
   * 与画布自身宽高比无关（画布更宽时多出的部分被背景色填充，用户不可见）。
   */
  const refW = Number(referenceWidth)
  const stageW = Number.isFinite(refW) && refW > 0 ? refW : W / k
  const layoutWidth = stageW * k
  const offsetX = (W - layoutWidth) / 2

  const sizeCfg = Number(font.size)
  const baseFontSize = (Number.isFinite(sizeCfg) && sizeCfg > 0 ? sizeCfg : FALLBACK_LINE_H) * k
  const lhCfg = Number(font.lineHeight)
  const lineHeight = Number.isFinite(lhCfg) && lhCfg > 0 ? lhCfg : 1.6
  const lsCfg = Number(font.letterSpacing)

  // ── 字体与测量（先定义，后面 measureRowLayout 会用到） ──
  let ctxFont = ''
  function setFont(size) {
    const f = `${font.weight ?? 400} ${size}px ${font.family ?? 'sans-serif'}`
    if (f !== ctxFont) {
      ctxFont = f
      ctx.font = f
    }
  }

  /**
   * 文本宽度：canvas 的 measureText + 字间距。
   * CSS 的 letter-spacing 会在每个字后加间距，canvas 的 letterSpacing 行为一致，
   * 所以这里按字符数近似（略保守，宁可可换行也不要溢出）。
   */
  function measureWidth(s) {
    const base = ctx.measureText(s).width
    if (!Number.isFinite(lsCfg) || lsCfg === 0) return base
    const m = ctxFont.match(/(\d+(?:\.\d+)?)px/)
    const size = m ? Number(m[1]) : baseFontSize
    const n = [...s].length
    return base + Math.max(0, n - 1) * size * lsCfg
  }

  const measure = (s, size) => {
    setFont(size)
    return measureWidth(s)
  }

  // 顶部留白：预览是 round(舞台高 × padTop)，这里换算到画布像素
  const padRatio = Number.isFinite(padTopRatio) ? padTopRatio : Number(layoutCfg.padTop)
  const padTopPx = Number.isFinite(padRatio) ? Math.round(referenceHeight * padRatio) * k : 0

  const layout =
    rowLayout && Array.isArray(rowLayout.rows)
      ? rowLayout
      : measureRowLayout({
          lines,
          settings,
          scale: k,
          layoutWidth,
          measure,
          padTopPx,
        })

  const rows = layout.rows
  const align = layoutCfg.align
  const isLeft = align === 'left'
  const isRight = align === 'right'
  /*
   * 锚点 x 必须夹取到画布内。
   *
   * stageW 用的是舞台宽（预览舞台的实测宽度），画布比例由用户选的 export.aspect 决定。
   * 两者比例一致时 layoutWidth 恰好等于 W；但仍有两条路径会让它溢出：
   *   1. 舞台被窗口压窄（用户把窗口拖得非常窄），比例已经不是设置里的那个；
   *   2. 舞台还没重排完就点了导出，读到的还是上一个比例的宽度。
   * 这两种情况下 layoutWidth > W，offsetX = (W - layoutWidth)/2 为负 ——
   * 左右对齐的锚点会落到画布外，文字被裁掉一半。居中恰好被 layoutWidth/2 抵消，
   * 所以只有左右对齐暴露。
   * layoutWidth 本身**不能改**：换行宽度按预览等比才是换行位置正确的关键，
   * 这里只夹取绘制锚点。
   */
  const rawX = isLeft
    ? offsetX + layoutWidth * EDGE_INSET
    : isRight
      ? offsetX + layoutWidth * (1 - EDGE_INSET)
      : offsetX + layoutWidth / 2
  const anchorX = Math.max(0, Math.min(W, rawX))

  ctx.textBaseline = 'middle'
  ctx.textAlign = isLeft ? 'left' : isRight ? 'right' : 'center'

  /*
   * 描边参数（在 drawRow 之前算好，逐行复用）。
   *
   * width 为 0 或非法即视为关闭 —— 与预览一致：CSS 里 0em 不画描边，
   * 不需要单独的开关，也不需要在循环里反复判断设置对象。
   */
  const strokeCfg = settings?.stroke ?? {}
  const strokeWidthEm = Number(strokeCfg.width)
  const strokeOn = Number.isFinite(strokeWidthEm) && strokeWidthEm > 0
  // 与预览共用同一个颜色字符串（含「明亮」换算），避免两边算两套
  const strokeColor = strokeOn ? resolveStrokeColor(settings) : '#000000'
  /*
   * 描边位置。'center' 时填充先画、描边压在上面（paint-order: fill stroke）；
   * 否则向外（paint-order: stroke fill）。与 toCssVars 的 --lrc-stroke-order 同源。
   * 非 'center' 的一切取值都按向外处理 —— 与 pickEnum 的白名单兜底一致。
   */
  const strokeCenter = strokeCfg.position === 'center'

/**
 * 逐字进度色。
 *
 * 与预览的 --lrc-color-char-progress 同一个设置项（settings.color.charProgress），
 * 所以预览与导出必然同色 —— 不存在"预览蓝、导出绿"的可能。
 * 兜底值与 settings.js 的默认值一致，设置缺省时观感不变。
 */
const charProgressColor = settings?.color?.charProgress ?? '#4c8dff'

  /**
   * 画一行的文字块（已换好的行数组），整体以 cy 为中心。
   * @param {any} row
   * @param {number} cy
   * @param {string} fill 已算好的填充色
   * @param {number} scale
   */
  function drawRow(row, cy, fill, scale, charProgress = null) {
    const size = row.drawSize
    setFont(size)

    // 字间距：CSS 的 em 相对**该元素自己的字号**，翻译行缩小后间距也同比缩小
    ctx.letterSpacing = Number.isFinite(lsCfg) && lsCfg !== 0 ? `${(size * lsCfg).toFixed(3)}px` : '0px'
    ctx.fillStyle = fill

    /*
     * 描边设置。
     *
     * 【为什么用 row.drawSize（而不是 baseFontSize）】
     * CSS 的 em 按**元素自己的字号**解析：翻译行 `font-size: 0.62em`，
     * 它的描边也同比更细。row.drawSize 已经含了翻译行的缩小，
     * 所以这里乘出来的线宽与预览逐行对齐。
     *
     * 【线宽以字形轮廓为中心，内外各半】
     * CSS 的 -webkit-text-stroke 与 canvas 的 strokeText 都是这个语义，
     * 所以不需要补偿，也不要乘 2。
     *
     * 【lineJoin='round' 与 CSS 对齐】
     * canvas 默认 miter 在尖角会甩出长刺；CSS 描边的转角是圆滑的。
     * 取 round 让两者观感一致（miterLimit 一并收紧，避免个别字形出刺）。
     */
    const strokeWidth = strokeOn ? strokeWidthEm * size : 0
    if (strokeOn) {
      ctx.strokeStyle = strokeColor
      ctx.lineWidth = strokeWidth
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
    }

    const parts = row.textLines
    const total = parts.length

    /**
     * 画一个字形：顺序由「描边位置」决定。
     *
     * 【这就是 canvas 侧的 paint-order】
     * canvas 没有 paint-order 属性，只能靠绘制顺序表达：
     *   outer  → 先 strokeText 再 fillText：填充盖住内侧一半 → 只露外侧
     *   center → 先 fillText 再 strokeText：描边压在填充上   → 内外各半
     * 与预览的 CSS `paint-order` 一一对应（值由 toCssVars 的
     * --lrc-stroke-order 产出），所以两边天然一致。
     *
     * 【为什么必须分两种顺序，不能统一成先描后填】
     * 只支持"向外"时先描后填是对的（实测反序会让白色像素只剩 1/16，
     * 描边吃掉字形内部）。但"居中"恰恰要求描边压在填充上面 ——
     * 写死一种顺序，另一种位置就没法实现。
     *
     * @param {string} s
     * @param {number} x
     * @param {number} y
     */
    function paint(s, x, y) {
      if (!strokeOn) {
        ctx.fillText(s, x, y)
        return
      }
      if (strokeCenter) {
        ctx.fillText(s, x, y)
        ctx.strokeText(s, x, y)
      } else {
        ctx.strokeText(s, x, y)
        ctx.fillText(s, x, y)
      }
    }

    if (Number.isFinite(scale) && scale !== 1) {
      /*
       * 与预览的 `transform: scale()` 一致：以锚点为原点整体缩放，
       * 把**字间距、行内间距**一起缩放，而不是只放大字号
       * （只放大字号会让字间距仍是原比例，观感偏松散）。
       *
       * 描边也一并被 ctx.scale 放大，且 lineWidth 是按**未缩放**的 size 算的 ——
       * 与 CSS 实测行为完全一致（父级 scale(2) 时 2em 仍按未缩放字号解析）。
       */
      ctx.save()
      ctx.translate(anchorX, cy)
      ctx.scale(scale, scale)
      for (let j = 0; j < total; j++) {
        const y = (j - (total - 1) / 2) * size * lineHeight
        paint(parts[j], 0, y)
      }
      ctx.restore()
    } else {
      for (let j = 0; j < total; j++) {
        const y = cy + (j - (total - 1) / 2) * size * lineHeight
        paint(parts[j], anchorX, y)
      }
    }


    /*
     * ── 逐字进度色：从左往右按进度覆盖 ──
     *
     * 【与预览的对应关系】
     * 预览用 background-clip:text 的双层渐变（见 LyricLine.vue）。
     * canvas 没有 background-clip，等价做法是：
     *   裁剪出一个宽 = 文字宽度 × progress 的矩形，再重画一遍文字。
     * 两者覆盖的都是「从行首到进度点的字形」，几何上等价。
     *
     * 【进度值必须来自同一个函数】
     * charProgressAt 由调用方（StageView / 导出循环）算好后传进来，
     * 这里不自己插值 —— 否则两处公式一旦漂移，预览与导出就对不上。
     */
    if (charProgress !== null && charProgress > 0 && parts.length > 0) {
      const p = Math.min(1, Math.max(0, charProgress))

      ctx.save()

      /*
       * 裁剪矩形覆盖整行文字的垂直范围。
       * 高度取 size * lineHeight * total，并把多行换行的间距也算进去，
       * 这样多行歌词也能被同一条竖线切齐。
       */
      const clipTop = cy - size * lineHeight * 1.2
      const clipHeight = size * lineHeight * (total + 1.4)

      // 逐行裁剪：每一行文字各自从它的起点量宽度，多行时进度按行分别应用
      for (let j = 0; j < total; j++) {
        const y = Number.isFinite(scale) && scale !== 1
          ? (j - (total - 1) / 2) * size * lineHeight
          : cy + (j - (total - 1) / 2) * size * lineHeight

        const w = measureWidth(parts[j])
        if (!(w > 0)) continue

        ctx.beginPath()
        ctx.rect(anchorX, clipTop, w * p, clipHeight)
        ctx.clip()

        /*
         * 用进度色重画一遍。
         * 描边顺序沿用 paint() 的既有约定（outer 先描后填 / center 先填后描），
         * 否则进度段的描边会与未进度段呈现不同的内外比例。
         */
        ctx.fillStyle = charProgressColor
        if (strokeOn) ctx.strokeStyle = strokeColor

        if (Number.isFinite(scale) && scale !== 1) {
          ctx.translate(anchorX, cy)
          ctx.scale(scale, scale)
          if (strokeOn && strokeCenter) {
            ctx.fillText(parts[j], 0, y)
            ctx.strokeText(parts[j], 0, y)
          } else if (strokeOn) {
            ctx.strokeText(parts[j], 0, y)
            ctx.fillText(parts[j], 0, y)
          } else {
            ctx.fillText(parts[j], 0, y)
          }
          ctx.translate(-anchorX, -cy)
          ctx.scale(1 / scale, 1 / scale)
        } else {
          if (strokeOn && strokeCenter) {
            ctx.fillText(parts[j], anchorX, y)
            ctx.strokeText(parts[j], anchorX, y)
          } else if (strokeOn) {
            ctx.strokeText(parts[j], anchorX, y)
            ctx.fillText(parts[j], anchorX, y)
          } else {
            ctx.fillText(parts[j], anchorX, y)
          }
        }
      }

      ctx.restore()
    }
    // 描边状态是 ctx 上的全局属性，不还原会污染下一行的绘制
    if (strokeOn) ctx.lineWidth = 0
  }

  const off = Number.isFinite(scrollOffset) ? scrollOffset : 0

  /*
   * ── 2. 当前行 / 过渡状态 ──
   *
   * hasActive=false（还没到第一行）时预览**没有任何行**带 .is-active：
   * 不放大、不变色。早先导出强行把第 0 行当当前行放大，与预览不符。
   */
  const hasActive = lineIndex >= 0
  const cur = hasActive ? lineIndex : 0

  const fadeCfg = settings?.fade ?? createDefaultFade()
  const fadeOn = fadeCfg.enabled !== false

  const trans = activeTransition({
    t,
    lines,
    cur,
    transitionMs: Number(motion.transitionMs),
    fadeMs: Number(motion.activeFadeMs),
    reduce: !!motion.reduceMotion,
  })

  /*
   * 透明度表：预览在换行时用 CSS 把每行的 opacity 在 activeFadeMs 内过渡到新值。
   * 因此过渡期间要在"上一张表"和"当前表"之间插值 ——
   * 否则换行瞬间整屏明暗会跳一下。
   *
   * 两张表的中心行不同（= 各自的当前行），中心行由 fade.js 保证为 1。
   */
  const tableNow = computeRenderOpacities(lines, hasActive ? cur : -1, fadeCfg, undefined, hasActive ? cur : -1)
  let opacities = tableNow
  if (trans.colorProg < 1 && trans.prev >= 0) {
    const tablePrev = computeRenderOpacities(lines, trans.prev, fadeCfg, undefined, trans.prev)
    const mixed = new Float64Array(lines.length)
    for (let i = 0; i < lines.length; i++) mixed[i] = lerp(tablePrev[i], tableNow[i], trans.colorProg)
    opacities = mixed
  }

  /*
   * ── 3. 逐行绘制 ──
   *
   * y = 行中心 - 滚动位移（与预览"轨道被上移 offset"的语义完全一致）
   */
  const activeColor = color.active ?? '#ffffff'
  const normalColor = color.normal ?? '#9aa4b2'
  const scaleCfg = Number(font.scale)
  const scale = Number.isFinite(scaleCfg) && scaleCfg > 0 ? scaleCfg : 1.35
  // 减少动态效果时预览不做缩放（.reduce-motion .lyric-line.is-active { transform: none }）
  const effectiveScale = motion.reduceMotion ? 1 : scale
  /**
   * 第 i 行的逐字进度（0~1）；没有逐字时间返回 null。
   *
   * 【rows[i] 与 lines[i] 是一对一的】
   * 上面的排版循环按 arr 顺序 push rows，没有合并或重排，
   * 所以这里直接用 i 取 lines[i] 是安全的。
   *
   * 【与预览调用同一个函数】
   * StageView.charProgressOf 也调 charProgressAt。同一个公式、同一个时间源，
   * 预览与导出才谈得上几何一致。
   */
  function charProgressOf(i) {
    const line = lines[i]
    if (!line || !isCharTimed(line)) return null
    return charProgressAt(line.chars, t)
  }


  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue

    // 真正没有内容的行才跳过（空行要画「（间奏）」）
    if (row.textLines.length === 1 && row.textLines[0] === '' && !row.isEmpty) continue

    const cy = row.top + row.height / 2 - off
    // 完全在画布外就不必画（长歌词下能省掉大量 fillText）
    if (cy + row.height < 0 || cy - row.height > H) continue

    const isActive = hasActive && i === cur
    const isOutgoing = trans.prev >= 0 && i === trans.prev && trans.scaleProg < 1

    if (isActive) {
      /*
       * 当前行：颜色 normal → active、缩放 1 → scale、透明度 → 虚化表的中心值(1)。
       *
       * 【为什么透明度也走插值】
       * 预览给每行写的是内联 opacity，换行时 CSS 会在 activeFadeMs 内
       * 把它从"上一张虚化表的值"过渡到"新表的值"。
       * 而 mixed/tableNow 里中心行恒为 1，所以直接取 opacities[i]
       * 就已经是"从旧值平滑升到 1"，不要再写死 1（那会让当前行突然亮起）。
       *
       * 【两条过渡时长不同】
       * transform 用 transitionMs、颜色与透明度用 activeFadeMs ——
       * 与预览 CSS 完全一致，所以分开插值。
       */
      const c = mixHex(normalColor, activeColor, trans.colorProg)
      const a = applyCssOpacityFactors(opacities[i], row, true, fadeOn)
      drawRow(row, cy, rgbaOf(c, a), lerp(1, effectiveScale, trans.scaleProg), charProgressOf(i))
    } else if (isOutgoing) {
      // 上一行：颜色 active → normal，缩放 scale → 1
      const c = mixHex(activeColor, normalColor, trans.colorProg)
      const a = applyCssOpacityFactors(opacities[i], row, false, fadeOn)
      drawRow(row, cy, rgbaOf(c, a), lerp(effectiveScale, 1, trans.scaleProg), charProgressOf(i))
    } else {
      const alpha = applyCssOpacityFactors(opacities[i], row, false, fadeOn)
      if (!(alpha > 0)) continue
      drawRow(row, cy, rgba(normalColor, alpha), 1, charProgressOf(i))
    }
  }

  return true
}

/**
 * 等高假设下的行距。
 *
 * 【保留原因】单行歌词（不换行）时它与 `measureRowLayout` 的单行高度一致，
 * 且已有文档/测试引用它。新代码请优先用 `measureRowLayout`。
 *
 * @param {any} settings
 * @param {number} canvasHeight
 * @param {number} [referenceHeight=BASE_HEIGHT]
 * @returns {number}
 */
export function computeLineH(settings, canvasHeight, referenceHeight = BASE_HEIGHT) {
  const k = scaleFactor(canvasHeight, referenceHeight)
  const size = Number(settings?.font?.size)
  const lh = Number(settings?.font?.lineHeight)
  if (!Number.isFinite(size) || !Number.isFinite(lh)) return FALLBACK_LINE_H
  const v = size * k * (lh + LINE_PADDING_EM * 2)
  return Number.isFinite(v) && v > 0 ? v : FALLBACK_LINE_H
}
