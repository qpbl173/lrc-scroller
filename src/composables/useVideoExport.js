// @ts-check
/**
 * 视频导出：H.264 MP4，或逐帧 PNG 封装的透明 QuickTime MOV。
 *
 * 【导出不含音频轨】
 * 用户自己有音频，会在剪辑软件里对齐。所以这里**刻意不做**任何音频处理：
 * 没有 OfflineAudioContext、没有 AudioEncoder、没有音画对齐。
 * 产出的是无声视频，音轨由用户的剪辑软件补。
 *
 * 【核心契约：导出 = 预览】
 * 预览走 DOM + CSS，导出走 canvas。要"完全一致"，
 * 关键在于**导出必须读预览实测出来的几何**，而不是自己另算一套：
 *   - 舞台宽高        → 决定字号/行距/留白的缩放比例与换行宽度
 *   - 每行实测高度    → 换行后的真实行距（自己算会差几十像素）
 *   - 上下留白        → 首行/末行能否停在中心
 *   - 每一行的时间    → 与预览同一个 findLineIndexAt
 *
 * 动效（缩放过渡、变色、虚化、滚动缓动）也全部由 core/renderFrame.js
 * 与 core/motion.js 逐帧重放，与预览的 CSS 时长/曲线一一对应。
 * 详见 renderFrame.js 文件头的对照表。
 *
 * 【为什么用 mp4-muxer 而不是作者推荐的 Mediabunny】
 * mp4-muxer 已被标记 deprecated，但 5.2.x 稳定可用且 API 简单得多
 * （本项目只需要"视频轨 + 下载"这一种用法）。这是明确的项目决策。
 *
 * 【为什么是单例】
 * ExportPanel 与将来的导出流程共享同一份状态。若各自 new 一个，
 * "导出中"标志会出现两个互不相通的副本。
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { PngMovWriter } from '@/core/pngMov'
import {
  renderFrame,
  buildOffsetTimeline,
  measureRowLayout,
  anchorRatio,
  centeringOffsetFor,
} from '@/core/renderFrame'
import { readStageGeometry, waitForFonts } from '@/core/stageGeometry'
import { findResolution } from '@/core/settings'
import { useLyricsStore } from '@/stores/lyricsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { usePlayerStore } from '@/stores/playerStore'
import { findLineIndexAt } from '@/core/timeUtils'
import { resolveFontFamily } from '@/core/settings'

/** 默认帧率（settings.export.fps 缺失或非法时用它） */
export const DEFAULT_FPS = 30

/**
 * 导出流水线的阶段标记。
 *
 * 【为什么要它】
 * 进度条走到 100% 之后还有三步（flush / finalize / download）才真正开始下载。
 * 之前这三步对外完全不可见，用户看到"100% 但没文件"无法判断卡在哪里。
 * 阶段名只做标记，不改变任何 await 顺序。
 *
 * @typedef {'render'|'flush'|'finalize'|'download'} ExportPhase
 */

/**
 * 视频编码候选，按 level 从高到低排列（探测会自动挑第一个支持的）。
 *   avc1.640034  High 5.2  4K
 *   avc1.640033  High 5.1  2K60 / 4K30
 *   avc1.640032  High 5.0  2K30
 *   avc1.64002A  High 4.2  1080p60
 *   avc1.640029  High 4.1  1080p60
 *   avc1.640028  High 4.0  1080p30
 *   avc1.4D401F  Main 3.1  720p30
 *   avc1.42001E  Baseline 3.0  兜底（兼容性最广：老设备/软件解码器）
 *
 * 【为什么必须按 level 分档，不能只留一个 High 4.0】
 * codec string 末两位是 level，level 直接决定**单帧像素上限**：
 * level 4.0 约 2MP，2K(3.69MP) 与 4K(8.29MP) 都超出，
 * 于是 isConfigSupported 对高分辨率全部返回 false —— 表现就是
 * "720p/1080p 能导，2K/4K 报无法编码"，与浏览器新旧无关。
 * 高分辨率必须用高 level 的 codec string。
 *
 * 【为什么要探测而不是写死一个】
 * 各设备的硬件编码器能力不同，实测本机 Edge 支持 High 却**不支持** Baseline，
 * 而老设备可能恰好相反。项目要发给别人用，写死任何一个都会让一部分人导不出。
 * 顺序不能改：按 level 从高到低，High 优先（压缩效率最好，画面只有文字但文件仍小得多），
 * 低 level 与 Baseline 在末尾兜底；对某个分辨率，第一个"既支持又够用"的会被选中。
 */
export const VIDEO_CODECS = [
  'avc1.640034', // High 5.2  4K
  'avc1.640033', // High 5.1  2K60 / 4K30
  'avc1.640032', // High 5.0  2K30
  'avc1.64002A', // High 4.2  1080p60
  'avc1.640029', // High 4.1  1080p60
  'avc1.640028', // High 4.0  1080p30
  'avc1.4D401F', // Main 3.1  720p30
  'avc1.42001E', // Baseline 3.0  兜底
]

/**
 * 关键帧间隔（帧）。每 30 帧一个（按 30fps 折合 1 秒），方便剪辑软件拖动定位。
 * 用 `${fps}` 换算而不是写死 30 —— 60fps 导出时也该每秒一个关键帧。
 */
export const KEYFRAME_SECONDS = 1

/**
 * 各分辨率下的推荐码率（Mbps）。
 *
 * 【为什么要分档】
 * 画面只有文字，但 4K 的像素量是 720p 的 9 倍。用同一个码率，
 * 4K 会糊、720p 会白白浪费体积。这组值按"每百万像素约 1.6Mbps"估，
 * 再对极小/极大分辨率做夹取。
 */
export const BITRATE_BY_HEIGHT = [
  { maxHeight: 480, mbps: 4 },
  { maxHeight: 720, mbps: 8 },
  { maxHeight: 1080, mbps: 14 },
  { maxHeight: 1440, mbps: 24 },
  { maxHeight: Infinity, mbps: 40 },
]

/**
 * 按画布高度推荐码率（Mbps）。
 * @param {number} height
 * @returns {number}
 */
export function recommendBitrate(height) {
  const h = Number(height)
  if (!Number.isFinite(h) || h <= 0) return 8
  for (const row of BITRATE_BY_HEIGHT) {
    if (h <= row.maxHeight) return row.mbps
  }
  return 8
}

export function useVideoExport() {
  const lyrics = useLyricsStore()
  const settings = useSettingsStore()
  const player = usePlayerStore()

  /**
   * 当前导出该用的画布尺寸。
   *
   * 分辨率由 `settings.export.resolution` 决定（480p~4K），
   * 直接用预设的 width/height，保证是标准的 16:9 成品尺寸。
   * @returns {{width:number, height:number}}
   */
  function exportSize() {
    const p = findResolution(settings.settings.export?.resolution)
    return { width: p.width, height: p.height }
  }

  /**
   * 采集一次"导出用的预览几何"。
   *
   * 【为什么只采集一次】
   * 导出期间舞台尺寸是稳定的（抽屉开关会改宽度，但导出时用户不会去开抽屉），
   * 逐帧读 DOM 会触发强制同步布局，长歌词下会明显拖慢导出。
   * 采集失败（拿不到舞台/行高）时返回 null，调用方退回纯公式估算。
   *
   * @param {HTMLCanvasElement} canvasEl
   * @returns {{refW:number, refH:number, layout:any}|null}
   */
  function collectGeometry(canvasEl) {
    const geo = readStageGeometry()
    if (!(geo.width > 0) || !(geo.height > 0)) return null

    const k = canvasEl.height / geo.height
    const layoutWidth = geo.width * k

    // 用临时 2D context 做文本测量（与正式渲染同一个 API，结果才可比）
    const probe = document.createElement('canvas').getContext('2d')
    if (!probe) return null

    const font = settings.settings.font
    // 用 resolveFontFamily 而不是 font.family：自定义上传的字体要一起参与测量，
    // 否则算出的换行宽度与实际渲染字体不符，导出的折行位置会偏
    const familyStr = resolveFontFamily(settings.settings)
    const measure = (s, size) => {
      probe.font = `${font.weight ?? 400} ${size}px ${familyStr || 'sans-serif'}`
      const base = probe.measureText(s).width
      const ls = Number(font.letterSpacing)
      if (!Number.isFinite(ls) || ls === 0) return base
      return base + Math.max(0, [...s].length - 1) * size * ls
    }

    const layout = measureRowLayout({
      lines: lyrics.lines,
      settings: settings.settings,
      scale: k,
      layoutWidth,
      measure,
      padTopPx: geo.padTopPx * k,
      // 预览实测的行高直接用 —— 这是"像素级一致"的关键
      domHeights: geo.rowHeights,
    })

    return { refW: geo.width, refH: geo.height, layout }
  }

  /**
   * 依次探测候选 codec，返回第一个被支持的。
   *
   * 【每次导出都探测，不做缓存】
   * 探测是一次很轻的异步调用（不进编码管线），
   * 而缓存要处理"分辨率/帧率变了要失效"这类边界，不值当。
   *
   * @param {number} width
   * @param {number} height
   * @param {number} bitrate
   * @param {number} fps
   * @returns {Promise<string|null>} 可用的 codec string；都不支持返回 null
   */
  async function pickSupportedCodec(width, height, bitrate, fps) {
    if (typeof VideoEncoder === 'undefined') return null
    for (const codec of VIDEO_CODECS) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps })
        if (r?.supported) return codec
      } catch {
        // 这个候选不合法就试下一个，不让单个异常中断整条探测
      }
    }
    return null
  }

  /**
   * 把时间 t 处的一帧画到 canvas 上（导出面板的「渲染当前帧」）。
   *
   * 【为什么不能传 scrollOffset: 0】
   * 行位置里含顶部留白（padTop），传 0 会让当前行停偏。
   * 单帧预览要的是"当前行精确停在锚点位置上"，所以用
   * centeringOffsetFor 算出与预览一致的位移（等于滚动已收敛的稳态）。
   *
   * @param {HTMLCanvasElement|null} canvasEl
   * @param {number} t 时间（秒）
   * @returns {boolean} 是否成功画了一帧
   */
  function renderPreview(canvasEl, t) {
    if (!canvasEl) return false
    const geo = collectGeometry(canvasEl)
    const lines = lyrics.lines
    const lineIndex = findLineIndexAt(lines, t)
    // 与 renderAll / exportVideo 一致：让自定义上传的字体也参与这一帧
    const cfg = withCustomFont(settings.settings)

    const layout = geo?.layout
    const off = layout ? centeringOffsetFor(layout, lineIndex, canvasEl.height, anchorRatio(cfg)) : 0

    return renderFrame({
      lineIndex,
      lines,
      settings: cfg,
      t,
      canvas: canvasEl,
      scrollOffset: off,
      referenceHeight: geo?.refH,
      referenceWidth: geo?.refW,
      rowLayout: layout,
    })
  }

  /**
   * 把设置里的 font.family 换成"自定义字体优先"的合并字符串。
   *
   * 【为什么要这一层】
   * renderFrame 读的是 `settings.font.family`，而用户上传的字体存在
   * `font.customFamily` 里（单独一个字段是刻意的：family 会被白名单清洗）。
   * 不改 renderFrame 的前提下，这里做一次浅合并把两者拼起来，
   * 让 canvas 也用上自定义字体 —— 否则会出现"预览是新字体、导出是旧字体"
   * 且**没有任何报错**的静默偏差。
   *
   * 返回新对象，不改 store（store.settings 是响应式的，直接改会污染预览状态）。
   *
   * @param {any} cfg
   * @returns {any}
   */
  function withCustomFont(cfg) {
    const merged = resolveFontFamily(cfg)
    if (!merged || merged === cfg?.font?.family) return cfg
    return { ...cfg, font: { ...cfg.font, family: merged } }
  }

  /**
   * 逐帧渲染整条时间轴（不编码、不含音频）。
   *
   * @param {HTMLCanvasElement|null} canvasEl
   * @param {Object} [opts]
   * @param {(done:number, total:number)=>void} [opts.onProgress]
   * @param {AbortSignal} [opts.signal]
   * @param {(canvas:HTMLCanvasElement, index:number)=>Promise<void>} [opts.onFrame] 等待每帧写入后再继续，避免堆积画面数据
   * @returns {Promise<{ok:true, frames:number, elapsedMs:number} | {ok:false, reason:string, frames?:number}>}
   */
  async function renderAll(canvasEl, { onProgress, signal, onFrame } = {}) {
    if (!canvasEl) return { ok: false, reason: 'no-canvas' }

    // 时长来源：有音频是音频长度；无音频时是"歌词末行 + 3 秒"
    const duration = player.duration
    if (!(duration > 0)) return { ok: false, reason: 'no-timeline' }

    const fps = Number(settings.settings.export?.fps) > 0 ? Number(settings.settings.export.fps) : DEFAULT_FPS
    const total = Math.max(1, Math.round(duration * fps))

    const lines = lyrics.lines
    const cfg = withCustomFont(settings.settings)
    const startedAt = performance.now()

    // 字体必须先就绪：行高与换行宽度都取决于最终生效的字体
    await waitForFonts()

    const geo = collectGeometry(canvasEl)
    const refH = geo?.refH
    const H = canvasEl.height

    const layout =
      geo?.layout ??
      measureRowLayout({
        lines,
        settings: cfg,
        scale: 1,
        layoutWidth: canvasEl.width,
        measure: fallbackMeasure(canvasEl, cfg),
        padTopPx: 0,
      })

    /*
     * 滚动时间轴：循环外算一次，循环里只查表。
     * 放进循环会让每帧都重跑一遍逐帧累积（O(n²)），且每次都从 0 开始 —— 得不到过渡。
     */
    const offsets = buildOffsetTimeline({
      lines,
      fps,
      layout,
      containerHeight: H,
      anchor: anchorRatio(cfg),
      reduce: !!cfg.motion?.reduceMotion,
      duration,
    })

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) return { ok: false, reason: 'aborted', frames: i }

      const t = i / fps
      renderFrame({
        lineIndex: findLineIndexAt(lines, t),
        lines,
        settings: cfg,
        t,
        canvas: canvasEl,
        scrollOffset: offsets[i] ?? 0,
        referenceHeight: refH,
        referenceWidth: geo?.refW,
        rowLayout: layout,
      })
      if (onFrame) await onFrame(canvasEl, i)
      onProgress?.(i + 1, total)

      /*
       * 让出主线程。
       *
       * 【为什么用 setTimeout(0) 而不是 requestAnimationFrame】
       * rAF 在**后台标签页会被浏览器暂停** —— 用户切到别的窗口，
       * 导出就永远卡在那里（既不前进也不报错，看起来像死了）。
       * setTimeout(0) 虽然也会被节流（后台最小 1 秒），但不会完全停下，
       * 而且我们能靠 onProgress 让用户看到"还在动"。
       */
      await new Promise((r) => setTimeout(r, 0))
    }

    return { ok: true, frames: total, elapsedMs: performance.now() - startedAt }
  }

  /**
   * 无法读到预览 DOM 时的文本测量兜底。
   * @param {HTMLCanvasElement} canvasEl
   * @param {any} cfg
   * @returns {(s:string, size:number)=>number}
   */
  function fallbackMeasure(canvasEl, cfg) {
    const ctx = canvasEl.getContext('2d')
    const font = cfg?.font ?? {}
    return (s, size) => {
      if (!ctx) return [...s].length * size * 0.9
      ctx.font = `${font.weight ?? 400} ${size}px ${font.family ?? 'sans-serif'}`
      const base = ctx.measureText(s).width
      const ls = Number(font.letterSpacing)
      return Number.isFinite(ls) && ls !== 0 ? base + Math.max(0, [...s].length - 1) * size * ls : base
    }
  }

  /**
   * 渲染 + 编码 + 封装 + 下载一条完整流水线（无声视频）。
   *
   * @param {HTMLCanvasElement|null} canvasEl
   * @param {Object} [opts]
   * @param {(done:number, total:number, phase?:ExportPhase)=>void} [opts.onProgress]
   *   进度回调。phase 让调用方能区分"进度条 100% 之后卡在哪一步"：
   *   render（逐帧渲染）→ flush（写入编码器）→ finalize（生成文件）→ download（触发下载）
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<
   *   {ok:true, frames:number, bytes:number, elapsedMs:number} |
   *   {ok:false, reason:string, frames?:number}
   * >}
   */
  async function exportVideo(canvasEl, { onProgress, signal } = {}) {
    if (!canvasEl) return { ok: false, reason: 'no-canvas' }

    if (settings.settings.export?.format === 'mov-alpha') {
      return exportTransparentVideo(canvasEl, { onProgress, signal })
    }

    const duration = player.duration
    if (!(duration > 0)) return { ok: false, reason: 'no-timeline' }

    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      return { ok: false, reason: 'codec-unsupported' }
    }

    const fps = Number(settings.settings.export?.fps) > 0 ? Number(settings.settings.export.fps) : DEFAULT_FPS
    const total = Math.max(1, Math.round(duration * fps))

    // 分辨率跟着用户选的预设走（480p~4K）
    const size = exportSize()
    if (canvasEl.width !== size.width || canvasEl.height !== size.height) {
      canvasEl.width = size.width
      canvasEl.height = size.height
    }
    const W = canvasEl.width
    const H = canvasEl.height

    // 码率：用户没显式改过（还等于默认 8）时，按分辨率推荐；改过就尊重用户
    const configured = Number(settings.settings.export?.bitrateMbps)
    const mbps = configured > 0 && configured !== 8 ? configured : recommendBitrate(H)
    const bitrate = Math.round(mbps * 1_000_000)

    /*
     * 选一个本机支持的 codec。
     * 都不支持就**直接返回，不做降级** —— 明确要求：不做 WebM 兜底。
     */
    const codec = await pickSupportedCodec(W, H, bitrate, fps)
    if (!codec) return { ok: false, reason: 'codec-unsupported' }

    /** @type {VideoEncoderConfig} */
    const encoderConfig = { codec, width: W, height: H, bitrate, framerate: fps }

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H, frameRate: fps },
      // 不传 audio —— 本导出无声
      fastStart: 'in-memory',
    })

    /** @type {Error|null} */
    let encoderError = null

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        encoderError = e instanceof Error ? e : new Error(String(e))
      },
    })
    encoder.configure(encoderConfig)

    const lines = lyrics.lines
    const cfg = withCustomFont(settings.settings)
    const startedAt = performance.now()
    const microsPerFrame = 1e6 / fps
    const keyframeInterval = Math.max(1, Math.round(fps * KEYFRAME_SECONDS))

    // 与 renderAll 同一套几何采集
    await waitForFonts()
    const geo = collectGeometry(canvasEl)
    const refH = geo?.refH

    const layout =
      geo?.layout ??
      measureRowLayout({
        lines,
        settings: cfg,
        scale: 1,
        layoutWidth: W,
        measure: fallbackMeasure(canvasEl, cfg),
        padTopPx: 0,
      })

    const offsets = buildOffsetTimeline({
      lines,
      fps,
      layout,
      containerHeight: H,
      anchor: anchorRatio(cfg),
      reduce: !!cfg.motion?.reduceMotion,
      duration,
    })

    for (let i = 0; i < total; i++) {
      /*
       * 中止与编码器错误要分开报：
       * 混在一起会让用户以为"是自己取消的"，而实际是编码失败。
       */
      if (signal?.aborted || encoderError) {
        // 不留垃圾：关掉编码器，丢弃已编码但未封装的 chunk
        try {
          encoder.close()
        } catch {
          /* 已经关了就忽略 */
        }
        return encoderError
          ? { ok: false, reason: 'encode-failed', frames: i }
          : { ok: false, reason: 'aborted', frames: i }
      }

      const t = i / fps
      renderFrame({
        lineIndex: findLineIndexAt(lines, t),
        lines,
        settings: cfg,
        t,
        canvas: canvasEl,
        scrollOffset: offsets[i] ?? 0,
        referenceHeight: refH,
        referenceWidth: geo?.refW,
        rowLayout: layout,
      })

      const frame = new VideoFrame(canvasEl, {
        timestamp: Math.round(i * microsPerFrame),
        duration: Math.round(microsPerFrame),
      })
      encoder.encode(frame, { keyFrame: i % keyframeInterval === 0 })
      frame.close()

      onProgress?.(i + 1, total, 'render')

      // 与 renderAll 一致：setTimeout(0) 而非 rAF（rAF 在后台标签页会暂停）
      await new Promise((r) => setTimeout(r, 0))
    }

    // 冲刷编码器：不加这步，最后几帧的 chunk 还没吐出来就被 finalize，会丢帧
    onProgress?.(total, total, 'flush')
    try {
      await encoder.flush()
    } catch (e) {
      encoderError = e instanceof Error ? e : new Error(String(e))
    }
    try {
      encoder.close()
    } catch {
      /* 忽略重复关闭 */
    }

    if (encoderError) return { ok: false, reason: 'encode-failed', frames: total }

    onProgress?.(total, total, 'finalize')
    muxer.finalize()
    const buffer = muxer.target.buffer
    const blob = new Blob([buffer], { type: 'video/mp4' })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = `lrc-${Date.now()}.mp4`
    document.body.appendChild(a)
    onProgress?.(total, total, 'download')
    a.click()
    a.remove()
    // 延迟回收：立即 revoke 在部分浏览器上会让下载中断
    setTimeout(() => URL.revokeObjectURL(url), 1000)

    return {
      ok: true,
      frames: total,
      bytes: blob.size,
      elapsedMs: performance.now() - startedAt,
    }
  }

  /**
   * PNG/MOV 不使用 VideoEncoder；PNG 的 RGBA 数据直接成为视频帧。
   * 支持文件选择器时逐帧写磁盘，取消/失败时 abort 回滚未提交的写入。
   * 其它浏览器使用有上限的 Blob，避免长视频耗尽浏览器内存。
   */
  async function exportTransparentVideo(canvasEl, { onProgress, signal } = {}) {
    if (!(player.duration > 0)) return { ok: false, reason: 'no-timeline' }
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    const startedAt = performance.now()
    const fps = Number(settings.settings.export?.fps) || DEFAULT_FPS
    const size = exportSize()
    const name = `lrc-transparent-${Date.now()}.mov`
    let writer = null
    let writable = null
    let frames = 0
    try {
      // 必须在字体等待等异步操作前打开选择器，保留按钮点击的用户激活。
      if (typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: '透明 QuickTime 视频（PNG）', accept: { 'video/quicktime': ['.mov'] } }],
        })
        writable = await handle.createWritable()
      }
      writer = new PngMovWriter({ ...size, fps, writable })
      await writer.start()
      canvasEl.width = size.width
      canvasEl.height = size.height
      const result = await renderAll(canvasEl, {
        signal,
        onProgress,
        onFrame: async (canvas) => {
          const png = await new Promise((resolve, reject) => canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error('无法生成透明视频帧')),
            'image/png',
          ))
          if (signal?.aborted) return
          await writer.addFrame(png)
          frames++
        },
      })
      if (!result.ok || signal?.aborted) {
        await writer.abort()
        return { ok: false, reason: signal?.aborted ? 'aborted' : result.reason, frames }
      }
      onProgress?.(frames, frames, 'finalize')
      const output = await writer.finalize()
      if (output.blob) {
        const url = URL.createObjectURL(output.blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        onProgress?.(frames, frames, 'download')
        try { a.click() } finally {
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
      }
      return { ok: true, frames, bytes: output.bytes, elapsedMs: performance.now() - startedAt }
    } catch (e) {
      try {
        if (writer) await writer.abort()
        else if (writable) await writable.abort()
      } catch { /* 保留原始错误 */ }
      if (signal?.aborted || e?.name === 'AbortError') return { ok: false, reason: 'aborted', frames }
      if (e?.name === 'MovMemoryLimitError') return { ok: false, reason: 'mov-too-large', frames }
      throw e
    }
  }

  return {
    renderPreview,
    renderAll,
    exportVideo,
    pickSupportedCodec,
    exportSize,
    collectGeometry,
    recommendBitrate,
  }
}

/** @type {{current: ReturnType<typeof useVideoExport>|null}} */
const singleton = { current: /** @type {any} */ (null) }

/**
 * 取得全局唯一的导出控制器（首次调用时创建）。
 * @returns {ReturnType<typeof useVideoExport>}
 */
export function useVideoExportShared() {
  if (!singleton.current) {
    singleton.current = useVideoExport()
  }
  return singleton.current
}
