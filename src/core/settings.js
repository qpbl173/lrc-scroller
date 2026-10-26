// @ts-check
/**
 * 设置的默认值与字段元信息 —— 纯函数层，禁止 import vue。
 *
 * 这里是"唯一事实来源"：
 *  - settingsStore 用它做 localStorage 的逐字段兜底
 *  - CSS 变量映射用它决定哪些字段需要转成 --lrc-*
 *  - 设置面板的滑杆范围也从这里读，避免"UI 能拖到 3，逻辑只认到 1"的错位
 */
import { hexToHsl, hslToHex } from './color.js'

export const SETTINGS_VERSION = 1

/** @typedef {ReturnType<typeof createDefaultSettings>} Settings */

export function createDefaultSettings() {
  return {
    version: SETTINGS_VERSION,

    font: {
      family: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      /**
       * 用户上传的自定义字体名（会话内有效）。
       *
       * 【为什么单独一个字段，而不是写进 family】
       * family 会被 sanitizeSettings 按 FONT_FAMILY_PRESETS 白名单清洗，
       * 上传的字体名不在白名单里会被打回默认值。
       * 分开存既绕开白名单，也保留了"自定义优先、原字体兜底"的组合能力。
       * 刷新后会回到 ''（字体本身不持久化，见 core/fontLoader.js）。
       */
      customFamily: '',
      size: 40, // px（在 1080p 高度下的基准字号）
      weight: 600,
      letterSpacing: 0.02, // em
      lineHeight: 1.6, // 倍数
      scale: 1.35, // 当前行放大比例
    },

    color: {
      normal: '#9aa4b2',
      active: '#ffffff',
      /**
       * 刚打完的那一行（打轴模式的 is-tapped）。
       *
       * 取 UI accent 蓝 #4c8dff —— 与 active（白）、normal（灰）明显不同，
       * 蓝色也符合"刚操作完/待确认"的直觉。
       */
      tapped: '#4c8dff',
      /**
       * 逐字进度色：已唱过的那部分字符（从左往右线性推进）。
       *
       * 【为什么默认与 tapped 同为 accent 蓝】
       * 进度色表达的是"已经唱到这里"，与"刚打完轴"是两种不同的蓝色语义，
       * 但用户第一眼最需要的是能看见进度 —— 深色背景下灰色看不清，
       * 白色又会与 active 混淆，所以默认沿用 accent 蓝，允许单独改色。
       */
      charProgress: '#4c8dff',
      bg: '#0b0e14',
      bgMode: 'solid', // solid | green | black
    },

    /**
     * 文字描边。
     *
     * 【width 默认 0 = 关闭，为什么不做成单独的 enabled 开关】
     * 宽度为 0 时 CSS 与 canvas 天然不画描边，语义已经完整；
     * 再加一个布尔开关会出现"开着但宽度为 0"这种自相矛盾的状态，
     * 还要在 UI、校验、导出三处都判断一次。少一个状态就少一类 bug。
     *
     * 【默认关闭是为了老用户】
     * 升级后观感必须零变化，想要描边的人自己拖一下就好。
     */
    stroke: {
      /** 描边粗细，单位 em（相对字号）。0 = 关闭 */
      width: 0,
      /** 描边基色，只提供色相与饱和度；明暗由 brightness 决定 */
      color: '#000000',
      /**
       * 「明亮」：描边颜色的明度（0~100）。
       *
       * 【为什么是独立一项，而不是让用户直接在色轮上点】
       * 色轮负责选色相/饱和度，明度由这个滑杆单独控制 ——
       * 这样"换个颜色"不会把用户调好的明暗带跑，
       * 想从纯黑描边换成深灰描边也不需要重新找色。
       */
      brightness: 0,
      /**
       * 描边位置：'outer'（外侧，默认）| 'center'（居中，内外各半）。
       *
       * 【为什么没有「内侧」】
       * CSS 的 -webkit-text-stroke 线宽**永远以字形轮廓为中心**，
       * 没有任何属性能把描边推到内侧。SVG2 有 stroke-alignment: inner，
       * 但至今没有浏览器实现 —— 实测 Edge 155 的
       * CSS.supports('stroke-alignment','inner') 返回 false。
       * 唯一能"腐蚀"字形的是 SVG 滤镜 feMorphology erode，但它
       *   1. 会把填充一起吃掉（红色文字会整个消失）
       *   2. 半径是设备像素、不随字号缩放（与 em 语义冲突）
       *   3. 与 canvas 的结果对不上（实测绿色区域 IoU 仅 0.38）
       * 第 3 条直接破坏"导出 = 预览"这个核心契约，所以不做内侧。
       *
       * 外侧与居中两种都能在 CSS 与 canvas 上用同一条规则表达，天然一致：
       *   外侧：先画描边、再用不透明填充盖住内半 → paint-order: stroke fill
       *   居中：先画填充、再盖描边           → paint-order: fill stroke
       */
      position: 'outer',
    },

    layout: {
      align: 'center', // left | center | right
      padTop: 0.35, // 视口高度比例
      padBottom: 0.35,
      maxWidth: 0.9,
    },

    motion: {
      transitionMs: 260,
      activeFadeMs: 180,
      scrollMode: 'center', // center | golden
      followUser: 'resume', // resume | manual
      reduceMotion: false,
    },

    /**
     * 歌词虚化：以当前行为中心，距离越远的行越透明。
     * 规则与默认值详见 core/fade.js。
     */
    fade: {
      enabled: true,
      solidAbove: 2, // 当前行上方保持完全不透明的行数
      solidBelow: 2, // 当前行下方保持完全不透明的行数
      fadeRows: 5, // 实体区边缘往外渐变的行数
      mode: 'ease', // linear | ease | none
    },

    sync: {
      bpm: null,
      firstBeatMs: 0,
      snap: 'none', // none | nearest | next
    },

    export: {
      /** 画布比例 id：16:9 | 9:16 | 3:4（见 ASPECT_PRESETS） */
      aspect: '16:9',
      /**
       * 分辨率 preset id：480p | 720p | 1080p | 2k | 4k。
       * 具体尺寸由"比例 + 档位"现算（resolutionPresetsFor），竖版 1080p 是 1080×1920。
       */
      resolution: '720p',
      width: 1280,
      height: 720,
      fps: 30,
      bgMode: 'solid', // solid | green | black | transparent(实验占位)
      bitrateMbps: 8,
      watermark: '',
    },
  }
}

/**
 * 导出画布比例预设。
 *
 * 【为什么比例要单独成一层，而不是塞进分辨率】
 * 预览舞台现在按"用户选的画布比例"做等比适配（见 StageView 的 --stage-aspect），
 * 导出则用同一份比例生成画布。比例一旦不同，换行位置、行高、滚动位移全都不同，
 * 所以它必须是一个**显式设置**，而不是从窗口尺寸临时推出来的东西 ——
 * 否则换台机器 / 换个窗口大小，导出的画面就跟预览对不上了。
 *
 * id 是展示与持久化用的字符串；真正参与计算的是 width:height 两个整数，
 * 保留为 16 / 9 这样的约分形式，避免 1.7778… 的浮点误差渗进布局公式。
 */
export const ASPECT_PRESETS = [
  { id: '16:9', label: '横屏 16:9', width: 16, height: 9 },
  { id: '9:16', label: '竖屏 9:16', width: 9, height: 16 },
  { id: '3:4', label: '竖版 3:4', width: 3, height: 4 },
]

/** 默认画布比例（找不到时一律回落到它） */
export const DEFAULT_ASPECT = '16:9'

/**
 * 导出分辨率预设。
 *
 * 【为什么档位由"短边"决定】
 * 16:9 下 480p/720p/1080p/2K/4K 的高度分别是 480/720/1080/1440/2160。
 * 竖版（9:16 / 3:4）的"短边"是宽度，所以按短边命名：1080×1920 就是 1080p。
 * 这样"1080p"在不同比例下表示的是同一档清晰度，而不是同一个高度。
 *
 * 预览舞台的宽高比跟着 export.aspect 走，导出也按同一比例生成画布，
 * 因此换行位置在任何比例下都与预览一致（见 renderFrame 的版心逻辑）。
 */
export const RESOLUTION_PRESETS = [
  { id: '480p', label: '480p', width: 854, height: 480 },
  { id: '720p', label: '720p', width: 1280, height: 720 },
  { id: '1080p', label: '1080p', width: 1920, height: 1080 },
  { id: '2k', label: '2K', width: 2560, height: 1440 },
  { id: '4k', label: '4K', width: 3840, height: 2160 },
]

/**
 * 竖版分辨率预设（9:16 与 3:4 共用一张表）。
 *
 * 【为什么 9:16 和 3:4 能共用】
 * 竖版的分辨率档位看的是**短边**（也就是宽度）：1080 宽在 9:16 下是 1080×1920，
 * 在 3:4 下是 1080×1440。两档共享同一组短边值，只是长边按比例换算，
 * 用户切换比例时分辨率档位不会突然失效，也少维护一张表。
 *
 * 尺寸约定（短边 = 宽，长边 = 宽 × 比例，即"竖起来的同名档位"）：
 *  - 9:16 → 1080p 是 1080×1920
 *  - 3:4  → 1080p 是 1080×1440，480p 是 480×640
 * 全部是 4 的倍数：H.264 编码器普遍要求偶数，4 的倍数在部分硬件编码器上更稳。
 */
const VERTICAL_SHORT_SIDES = [
  { id: '480p', label: '480p', short: 480 },
  { id: '720p', label: '720p', short: 720 },
  { id: '1080p', label: '1080p', short: 1080 },
  { id: '2k', label: '2K', short: 1440 },
  { id: '4k', label: '4K', short: 2160 },
]

/**
 * 按比例算出"全部可选分辨率"。
 *
 * 16:9 直接返回 RESOLUTION_PRESETS（它就是历史表，尺寸不能动 ——
 * 改了会让老设置的成品尺寸悄悄变化）。其余比例按短边现算，保证：
 *  - 全部是 4 的倍数（H.264 的编码器对奇数尺寸很不友好）
 *  - 宽高比与 ASPECT_PRESETS 里声明的 16/9、3/4 **完全相等**，不是近似
 *
 * @param {string} aspectId
 * @returns {{id:string,label:string,width:number,height:number,aspect:string}[]}
 */
export function resolutionPresetsFor(aspectId) {
  const aspect = findAspect(aspectId)
  if (aspect.id === DEFAULT_ASPECT) {
    return RESOLUTION_PRESETS.map((p) => ({ ...p, aspect: aspect.id }))
  }
  return VERTICAL_SHORT_SIDES.map((entry) => {
    const short = entry.short
    // 短边固定是宽（竖版），长边 = 短边 × 比例，再补齐到 4 的倍数
    const long = roundTo4((short * aspect.height) / aspect.width)
    return { id: entry.id, label: entry.label, width: short, height: long, aspect: aspect.id }
  })
}

/** 补齐到最近的 4 的倍数（编码器友好，且不改变比例到肉眼可辨的程度） */
function roundTo4(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.max(4, Math.round(v / 4) * 4)
}

/**
 * 按 id 取画布比例；未知 id 回落 16:9。
 * @param {string} id
 */
export function findAspect(id) {
  return ASPECT_PRESETS.find((p) => p.id === id) ?? ASPECT_PRESETS[0]
}

/**
 * 按画布尺寸反推它属于哪个比例（取比值最接近的一档）。
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function aspectOfSize(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return DEFAULT_ASPECT
  const ratio = w / h
  let best = ASPECT_PRESETS[0]
  let bestDiff = Infinity
  for (const p of ASPECT_PRESETS) {
    const d = Math.abs(ratio - p.width / p.height)
    if (d < bestDiff) {
      bestDiff = d
      best = p
    }
  }
  return best.id
}

/** 导出帧率预设 */
export const FPS_PRESETS = [
  { value: 24, label: '24 帧（电影感）' },
  { value: 30, label: '30 帧（常用）' },
  { value: 60, label: '60 帧（顺滑）' },
]

/**
 * 按 id 取分辨率预设；未知 id 回落到 720p。
 *
 * 带 aspect 参数时在该比例的候选表里找（竖版 1080p 是 1080×1920 而不是 1920×1080），
 * 不带时在 16:9 表里找 —— 保持老调用的行为不变。
 *
 * @param {string} id
 * @param {string} [aspectId]
 * @returns {{id:string,label:string,width:number,height:number}}
 */
export function findResolution(id, aspectId) {
  const list = aspectId ? resolutionPresetsFor(aspectId) : resolutionPresetsFor(DEFAULT_ASPECT)
  return list.find((p) => p.id === id) ?? list[1] ?? list[0]
}

/**
 * 按画布高宽推断最接近的分辨率 preset id（用于设置面板回显）。
 *
 * 先用 aspectOfSize 判断这个尺寸属于哪个比例，再在该比例的候选表里找最近的档位。
 * 反查通常发生在导入/迁移场景（只有尺寸、没有比例），所以判比例这一步必须内置，
 * 否则 1080×1920 会被当成"比 2K 横屏矮一截"而错配到 1440p。
 * 确定档位之后，精确尺寸仍要用 findResolution(id, aspect) 取 —— 那才是唯一出处。
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function nearestResolutionId(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return '720p'
  const aspectId = aspectOfSize(w, h)
  let best = findResolution('720p', aspectId)
  let bestDiff = Infinity
  for (const p of resolutionPresetsFor(aspectId)) {
    const d = Math.abs(p.height - h) + Math.abs(p.width - w)
    if (d < bestDiff) {
      bestDiff = d
      best = p
    }
  }
  return best.id
}

/**
 * 把画布比例算成 CSS 的 aspect-ratio 值（形如 '9 / 16'）。
 * 预览舞台直接吃这个值做等比适配，导出再用同一份比例生成画布，
 * 两边共用一处来源，不存在"CSS 写 9/16、导出写 0.5625"的漂移。
 * @param {string} aspectId
 */
export function aspectCssValue(aspectId) {
  const p = findAspect(aspectId)
  return `${p.width} / ${p.height}`
}

/**
 * 字段元信息：范围 + 步长 + 单位。
 * UI 控件与校验都从这里取值，防止两处硬编码不一致。
 */
export const FIELD_META = {
  'font.size': { min: 12, max: 160, step: 1, unit: 'px' },
  'font.weight': { min: 100, max: 900, step: 100, unit: '' },
  'font.letterSpacing': { min: -0.1, max: 1, step: 0.01, unit: 'em' },
  'font.lineHeight': { min: 1, max: 4, step: 0.05, unit: '倍' },
  'font.scale': { min: 1, max: 3, step: 0.01, unit: '倍' },
  // 描边：宽度上限 0.3em —— 再粗就会糊住字形，尤其在小字号下
  'stroke.width': { min: 0, max: 0.3, step: 0.005, unit: 'em' },
  'stroke.brightness': { min: 0, max: 100, step: 1, unit: '%' },
  'layout.padTop': { min: 0, max: 0.5, step: 0.01, unit: '' },
  'layout.padBottom': { min: 0, max: 0.5, step: 0.01, unit: '' },
  'layout.maxWidth': { min: 0.3, max: 1, step: 0.01, unit: '' },
  'motion.transitionMs': { min: 0, max: 2000, step: 10, unit: 'ms' },
  'motion.activeFadeMs': { min: 0, max: 2000, step: 10, unit: 'ms' },
  'sync.bpm': { min: 20, max: 300, step: 0.01, unit: 'BPM' },
  'sync.firstBeatMs': { min: -5000, max: 5000, step: 1, unit: 'ms' },
  // 虚化
  'fade.solidAbove': { min: 0, max: 20, step: 1, unit: '行' },
  'fade.solidBelow': { min: 0, max: 20, step: 1, unit: '行' },
  'fade.fadeRows': { min: 0, max: 30, step: 1, unit: '行' },
  // 上限按最长边的最大预设走：4K 横屏宽 3840、4K 竖屏高 3840，两者都要能存下来
  'export.width': { min: 320, max: 3840, step: 2, unit: 'px' },
  'export.height': { min: 240, max: 3840, step: 2, unit: 'px' },
  'export.fps': { min: 10, max: 60, step: 1, unit: 'fps' },
  'export.bitrateMbps': { min: 1, max: 50, step: 1, unit: 'Mbps' },
}

export const FONT_FAMILY_PRESETS = [
  { label: '系统默认', value: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' },
  { label: '黑体 / 无衬线', value: '"Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif' },
  { label: '宋体 / 衬线', value: '"Songti SC", SimSun, Georgia, serif' },
  { label: '等宽', value: 'Consolas, "Courier New", ui-monospace, monospace' },
  { label: '楷体', value: 'KaiTi, "Kaiti SC", STKaiti, serif' },
  { label: '圆体', value: '"Yuanti SC", "Hiragino Maru Gothic ProN", "Microsoft YaHei", sans-serif' },
]

/**
 * 取值 + 兜底：类型不符或越界就回到默认值。
 * 这是 localStorage 容错的核心 —— 任何脏数据都不该让页面白屏。
 * @param {any} obj 源对象
 * @param {string} path 形如 'font.size'
 * @param {any} fallback
 */
export function pick(obj, path, fallback) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return fallback
    cur = cur[p]
  }
  if (cur === undefined || cur === null) return fallback

  if (typeof fallback === 'number') {
    const n = Number(cur)
    if (!Number.isFinite(n)) return fallback
    const meta = FIELD_META[path]
    if (meta) {
      if (n < meta.min) return fallback
      if (n > meta.max) return fallback
    }
    return n
  }
  if (typeof fallback === 'string') {
    return typeof cur === 'string' && cur.length > 0 ? cur : fallback
  }
  if (typeof fallback === 'boolean') {
    return typeof cur === 'boolean' ? cur : fallback
  }
  return cur
}

/**
 * 用默认值逐字段兜底任意输入，产出一个一定合法的 Settings。
 * 绝不抛异常 —— 坏数据只会被静默替换成默认值。
 * @param {any} raw
 * @returns {Settings}
 */
export function sanitizeSettings(raw) {
  const d = createDefaultSettings()
  if (!raw || typeof raw !== 'object') return d

  /** @type {any} */
  const out = createDefaultSettings()

  out.version = SETTINGS_VERSION
  out.font.family = pick(raw, 'font.family', d.font.family)
  // 自定义字体名不做白名单校验（用户上传的名字无法预知），只要求是非空字符串
  out.font.customFamily = typeof raw?.font?.customFamily === 'string' ? raw.font.customFamily : d.font.customFamily
  out.font.size = pick(raw, 'font.size', d.font.size)
  out.font.weight = pick(raw, 'font.weight', d.font.weight)
  out.font.letterSpacing = pick(raw, 'font.letterSpacing', d.font.letterSpacing)
  out.font.lineHeight = pick(raw, 'font.lineHeight', d.font.lineHeight)
  out.font.scale = pick(raw, 'font.scale', d.font.scale)

  out.color.normal = normalizeColor(pick(raw, 'color.normal', d.color.normal), d.color.normal)
  out.color.active = normalizeColor(pick(raw, 'color.active', d.color.active), d.color.active)
  out.color.tapped = normalizeColor(pick(raw, 'color.tapped', d.color.tapped), d.color.tapped)
  out.color.charProgress = normalizeColor(pick(raw, 'color.charProgress', d.color.charProgress), d.color.charProgress)
  out.color.bg = normalizeColor(pick(raw, 'color.bg', d.color.bg), d.color.bg)
  out.color.bgMode = pickEnum(pick(raw, 'color.bgMode', d.color.bgMode), ['solid', 'green', 'black'], d.color.bgMode)

  out.stroke.width = pick(raw, 'stroke.width', d.stroke.width)
  out.stroke.color = normalizeColor(pick(raw, 'stroke.color', d.stroke.color), d.stroke.color)
  out.stroke.brightness = pick(raw, 'stroke.brightness', d.stroke.brightness)
  out.stroke.position = pickEnum(pick(raw, 'stroke.position', d.stroke.position), ['outer', 'center'], d.stroke.position)

  out.layout.align = pickEnum(pick(raw, 'layout.align', d.layout.align), ['left', 'center', 'right'], d.layout.align)
  out.layout.padTop = pick(raw, 'layout.padTop', d.layout.padTop)
  out.layout.padBottom = pick(raw, 'layout.padBottom', d.layout.padBottom)
  out.layout.maxWidth = pick(raw, 'layout.maxWidth', d.layout.maxWidth)

  out.motion.transitionMs = pick(raw, 'motion.transitionMs', d.motion.transitionMs)
  out.motion.activeFadeMs = pick(raw, 'motion.activeFadeMs', d.motion.activeFadeMs)
  out.motion.scrollMode = pickEnum(pick(raw, 'motion.scrollMode', d.motion.scrollMode), ['center', 'golden'], d.motion.scrollMode)
  out.motion.followUser = pickEnum(pick(raw, 'motion.followUser', d.motion.followUser), ['resume', 'manual'], d.motion.followUser)
  out.motion.reduceMotion = pick(raw, 'motion.reduceMotion', d.motion.reduceMotion)

  // 虚化
  out.fade.enabled = pick(raw, 'fade.enabled', d.fade.enabled)
  out.fade.solidAbove = pick(raw, 'fade.solidAbove', d.fade.solidAbove)
  out.fade.solidBelow = pick(raw, 'fade.solidBelow', d.fade.solidBelow)
  out.fade.fadeRows = pick(raw, 'fade.fadeRows', d.fade.fadeRows)
  out.fade.mode = pickEnum(pick(raw, 'fade.mode', d.fade.mode), ['linear', 'ease', 'none'], d.fade.mode)

  const bpm = pick(raw, 'sync.bpm', d.sync.bpm)
  out.sync.bpm = bpm === null ? null : bpm
  out.sync.firstBeatMs = pick(raw, 'sync.firstBeatMs', d.sync.firstBeatMs)
  out.sync.snap = pickEnum(pick(raw, 'sync.snap', d.sync.snap), ['none', 'nearest', 'next'], d.sync.snap)

  out.export.aspect = pickEnum(
    pick(raw, 'export.aspect', d.export.aspect),
    ASPECT_PRESETS.map((p) => p.id),
    d.export.aspect,
  )
  out.export.resolution = pickEnum(
    pick(raw, 'export.resolution', d.export.resolution),
    resolutionPresetsFor(out.export.aspect).map((p) => p.id),
    d.export.resolution,
  )
  out.export.width = pick(raw, 'export.width', d.export.width)
  out.export.height = pick(raw, 'export.height', d.export.height)
  out.export.fps = pick(raw, 'export.fps', d.export.fps)
  out.export.bgMode = pickEnum(pick(raw, 'export.bgMode', d.export.bgMode), ['solid', 'green', 'black'], d.export.bgMode)
  out.export.bitrateMbps = pick(raw, 'export.bitrateMbps', d.export.bitrateMbps)
  out.export.watermark = typeof raw?.export?.watermark === 'string' ? raw.export.watermark : d.export.watermark

  return out
}

/** 只接受白名单里的字符串，否则回默认。 */
export function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * 颜色归一化：只接受 #rgb / #rrggbb / #rrggbbaa。
 * @param {any} value
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback
  const v = value.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(v)) {
    // #abc → #aabbcc，便于统一处理
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  }
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  if (/^#[0-9a-f]{8}$/.test(v)) return v
  return fallback
}

/**
 * 解析最终的 font-family 字符串（自定义优先，原字体兜底）。
 *
 * 【为什么单独抽出来】
 * 有两处消费方：
 *   1. toCssVars → 预览的 CSS 变量
 *   2. renderFrame → canvas 的 ctx.font（通过 useVideoExport 传入）
 * 两边必须是同一个字符串，否则预览和导出会用不同字体。
 * 收在一处就不会出现"只改了 CSS、忘了 canvas"的偏差。
 *
 * @param {Settings} s
 * @returns {string}
 */
export function resolveFontFamily(s) {
  const custom = typeof s?.font?.customFamily === 'string' ? s.font.customFamily.trim() : ''
  const base = s?.font?.family || ''
  return custom ? `"${custom}", ${base}` : base
}

/**
 * 解析最终的描边颜色：取用户选色的**色相与饱和度**，明度用「明亮」滑杆。
 *
 * 【为什么拆成"色相/饱和度"与"明度"两段】
 * 这是"颜色 + 明亮"两个设置项的语义分工：
 *   - 颜色   → 决定是什么色（红/蓝/青…）
 *   - 明亮   → 决定这个色有多亮（0 = 纯黑，50 = 原色，100 = 纯白）
 * 若直接用用户选的色值，调「明亮」就得改写色值本身，
 * 换个颜色又会把用户调好的明暗带跑，两条设置互相打架。
 *
 * 【边界行为（与 CSS 的 hsl() 一致）】
 * HSL 里 s=0 或 l=0/100 时输出灰阶，色相自然"失效"：
 *   - brightness=0   → #000000（纯黑，无论选了什么色）
 *   - brightness=100 → #ffffff（纯白）
 * 这是符合直觉的：把明度拉到底/顶，颜色本来就应该被冲掉。
 *
 * 【与预览共用】
 * toCssVars（预览的 CSS 变量）与 renderFrame（canvas 的 strokeStyle）
 * 都调这个函数，保证两边是同一个字符串 —— 与 resolveFontFamily 同一套路，
 * 从根上避免"只改了 CSS、忘了 canvas"。
 *
 * @param {Settings} s
 * @returns {string} #rrggbb
 */
export function resolveStrokeColor(s) {
  const base = normalizeColor(s?.stroke?.color, '#000000')
  const raw = Number(s?.stroke?.brightness)
  const l = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0
  const { h, s: sat } = hexToHsl(base)
  return hslToHex(h, sat, l)
}

/**
 * 把设置翻译成 CSS 变量对象（供 :style 绑定）。
 * 好处：改一个设置只触发一次样式重算，且全局所有行共享同一套变量。
 * @param {Settings} s
 * @returns {Record<string,string>}
 */
export function toCssVars(s) {
  const bgModeColor =
    s.color.bgMode === 'green' ? '#00b140' : s.color.bgMode === 'black' ? '#000000' : s.color.bg

  // 自定义字体优先，原字体作为回退 —— 自定义字体只在会话内存在，
  // 刷新后名字还在但字体已卸载，后面的 family 能保证仍有可用的字体渲染
  const fontFamily = resolveFontFamily(s)

  return {
    '--lrc-font-family': fontFamily,
    '--lrc-font-size': `${s.font.size}px`,
    '--lrc-font-weight': String(s.font.weight),
    '--lrc-letter-spacing': `${s.font.letterSpacing}em`,
    '--lrc-line-height': String(s.font.lineHeight),
    '--lrc-active-scale': String(s.font.scale),
    '--lrc-color-normal': s.color.normal,
    '--lrc-color-active': s.color.active,
    '--lrc-color-tapped': s.color.tapped,
    '--lrc-color-char-progress': s.color.charProgress,
    // 描边：宽度是 em 值（相对字号），颜色已经过「明亮」换算
    '--lrc-stroke-width': `${s.stroke.width}em`,
    '--lrc-stroke-color': resolveStrokeColor(s),
    /*
     * 位置 → paint-order。
     * outer  = 描边先画、填充盖住内半 → 只留外半
     * center = 填充先画、描边压在上面 → 内外各半
     * canvas 侧用同一套顺序（见 renderFrame 的 paint()），两边天然一致。
     */
    '--lrc-stroke-order': s.stroke.position === 'center' ? 'fill stroke' : 'stroke fill',
    '--lrc-bg': bgModeColor,
    '--lrc-align': s.layout.align,
    '--lrc-pad-top': `${s.layout.padTop * 100}%`,
    '--lrc-pad-bottom': `${s.layout.padBottom * 100}%`,
    '--lrc-max-width': `${s.layout.maxWidth * 100}%`,
    '--lrc-transition': `${s.motion.transitionMs}ms`,
    '--lrc-fade': `${s.motion.activeFadeMs}ms`,
  }
}
