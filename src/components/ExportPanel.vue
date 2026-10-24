<script setup>
/**
 * 导出面板：歌词导出（LRC）+ 视频导出（渲染 / 编码 / 下载 / 兼容性提示）。
 *
 * 【两个导出入口并排】
 * 「导出 LRC」与「导出视频」放在同一行，用户不必在两个地方找"导出"。
 *   - 导出 LRC：把**已应用**的歌词写成 .lrc 文件（纯文本，瞬间完成）
 *   - 导出视频：普通 MP4 / 透明 MOV（均无声）
 *
 * 产出的 MP4 **不含音频轨** —— 音频由用户在自己的剪辑软件里对齐。
 * 「渲染当前帧」/「渲染全部帧」是预览（只画不编码），「导出视频」才真的产出文件。
 *
 * 【分辨率与帧率由用户选】
 * 480p / 720p / 1080p / 2K / 4K，24 / 30 / 60 帧。
 * 分辨率与帧率都写进 settings.export，因此会被持久化（刷新后仍是用户选的那档）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { usePlayerStore } from '@/stores/playerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useLyricsStore } from '@/stores/lyricsStore'
import { useVideoExportShared, DEFAULT_FPS } from '@/composables/useVideoExport'
import { useLrcExportShared } from '@/composables/useLrcExport'
import { RESOLUTION_PRESETS, FPS_PRESETS, findResolution } from '@/core/settings'
import { summarizeLrcLines } from '@/core/lrcWriter'

const player = usePlayerStore()
const settings = useSettingsStore()
const lyrics = useLyricsStore()
const exporter = useVideoExportShared()

/**
 * 导出 LRC（与「导出视频」并排）。
 *
 * 【为什么放在这里而不是歌词信息面板】
 * 两个导出入口并排，用户不用在两个地方找"导出"。
 * 这个 composable 只读已应用的歌词 —— 不碰打轴草稿、不改任何状态；
 * 有未应用草稿时它会提示用户先去点「应用到歌词」。
 */
const lrcExport = useLrcExportShared()

/**
 * 可导出行数：用 core/lrcWriter 的同一个判据，避免这里另写一套"什么算有效行"。
 * 为 0 时按钮禁用（不下载空文件）。
 */
const lrcStats = computed(() => summarizeLrcLines(lyrics.lines))
const canExportLrc = computed(() => lrcStats.value.exportable > 0)

/** 预览画布。尺寸由用户选的分辨率决定 */
const canvasRef = ref(/** @type {HTMLCanvasElement|null} */ (null))

/** 最近一次渲染的时间，画在按钮下方便于确认"画的是哪一刻" */
const lastRendered = ref(/** @type {number|null} */ (null))

// ── 逐帧渲染的本地状态（需求：不进 store）──
const rendering = ref(false)
/** 当前跑的是"导出视频"（而非仅渲染），用于按钮文案与进度显示 */
const exporting = ref(false)
const done = ref(0)
const total = ref(0)
/**
 * 当前阶段：'render' | 'flush' | 'finalize' | 'download' | ''
 *
 * 【为什么要显示它】
 * 进度条到 100% 后还要 flush/finalize/download 三步才真正出现下载。
 * 只显示"100%"会让用户以为已经结束 —— 卡住时也无从判断卡在哪一步。
 */
const phase = ref('')
const resultText = ref('')
/** @type {import('vue').Ref<AbortController|null>} */
const controller = ref(null)

/**
 * 编码能力探测结果。
 *   'probing'     还在探测
 *   'supported'   至少有一个候选 codec 可用
 *   'unsupported' 都不支持，导出按钮禁用
 */
const codecState = ref(/** @type {'probing'|'supported'|'unsupported'} */ ('probing'))
const format = computed(() => settings.settings.export?.format ?? 'mp4')
const transparent = computed(() => format.value === 'mov-alpha')
let probeVersion = 0

/** 当前选中的分辨率预设 */
const resolution = computed(() => settings.settings.export?.resolution ?? '720p')
const size = computed(() => findResolution(resolution.value))
const fpsi = computed(() => {
  const v = Number(settings.settings.export?.fps)
  return v > 0 ? v : DEFAULT_FPS
})

/** 用户没显式改过码率（仍是默认 8）时，显示按分辨率推荐的值 */
const bitrate = computed(() => {
  const configured = Number(settings.settings.export?.bitrateMbps)
  return configured > 0 && configured !== 8 ? configured : exporter.recommendBitrate(size.value.height)
})

/**
 * 把画布尺寸同步到所选分辨率。
 * 必须在渲染前完成，否则编码器配置与实际画布不一致会直接失败。
 */
function syncCanvasSize() {
  const c = canvasRef.value
  if (!c) return
  if (c.width !== size.value.width || c.height !== size.value.height) {
    c.width = size.value.width
    c.height = size.value.height
  }
}

/**
 * 探测一次编码能力。
 *
 * 用画布的实际尺寸（而不是写死 720p）—— 有些编码器只在特定分辨率下可用，
 * 探测用的参数必须和真正导出时一致，否则会得到"探测说行、导出却失败"。
 */
async function probe() {
  const version = ++probeVersion
  if (transparent.value) {
    codecState.value = typeof canvasRef.value?.toBlob === 'function' ? 'supported' : 'unsupported'
    return
  }
  const c = canvasRef.value
  const w = c?.width || 1280
  const h = c?.height || 720
  const bitrateBps = Math.round(bitrate.value * 1_000_000)
  try {
    const codec = await exporter.pickSupportedCodec(w, h, bitrateBps, fpsi.value)
    if (version === probeVersion) codecState.value = codec ? 'supported' : 'unsupported'
  } catch {
    if (version === probeVersion) codecState.value = 'unsupported'
  }
}

onMounted(async () => {
  syncCanvasSize()
  await probe()
})

// 切换格式立即更新预览，避免透明模式仍显示上一次 MP4 的实心背景。
watch([resolution, fpsi, format], async ([, , nextFormat], [, , prevFormat]) => {
  codecState.value = 'probing'
  lastRendered.value = null
  syncCanvasSize()
  if (nextFormat !== prevFormat && !rendering.value) onRenderFrame()
  await probe()
})

const percent = computed(() => (total.value > 0 ? Math.round((done.value / total.value) * 100) : 0))

/**
 * 进度行的文案。
 *
 * 【为什么非 render 阶段要换文案】
 * 这三步都在 100% 之后、下载之前，耗时可能是秒级（flush 要等编码器吐完）。
 * 只显示"100%"用户会以为卡死。写明当前动作，至少能判断卡在哪一步。
 */
const progressText = computed(() => {
  switch (phase.value) {
    case 'flush':
      return '正在写入编码器…'
    case 'finalize':
      return '正在生成文件…'
    case 'download':
      return '正在触发下载…'
    default:
      return `${done.value} / ${total.value} 帧（${percent.value}%）`
  }
})

function onRenderFrame() {
  syncCanvasSize()
  const ok = exporter.renderPreview(canvasRef.value, player.currentTime)
  if (ok) lastRendered.value = player.currentTime
}

/** 共用外壳：置位状态、跑一个导出动作、按 reason 出文案 */
async function run(task) {
  if (rendering.value) return
  rendering.value = true
  done.value = 0
  total.value = 0
  phase.value = ''
  resultText.value = ''

  const ctrl = new AbortController()
  controller.value = ctrl

  try {
    const r = await task(ctrl.signal)
    resultText.value = describe(r)
  } catch (e) {
    // 未捕获的异常（编码器崩、内存不足、a.click 抛错）
    resultText.value = `导出失败：${e?.message || e?.name || '未知错误'}`
    console.error('[export] 未捕获异常', e)
  } finally {
    rendering.value = false
    exporting.value = false
    controller.value = null
  }
}

/** 把返回值翻成一句人话 */
function describe(r) {
  if (r.ok) {
    if (r.bytes !== undefined) {
      return `已导出 ${r.frames} 帧，文件 ${(r.bytes / 1024 / 1024).toFixed(1)} MB，耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒`
    }
    return `共 ${r.frames} 帧，耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒`
  }
  switch (r.reason) {
    case 'codec-unsupported':
      return '当前浏览器不支持该分辨率的 H.264 编码，请改用 Chrome / Edge 或降低分辨率'
    case 'no-timeline':
      return '没有可渲染的时间轴'
    case 'aborted':
      return '已取消'
    case 'encode-failed':
      return '编码失败：画面数据无法编码，请重试'
    case 'mov-too-large':
      return '透明视频超过 512 MB 内存上限，请降低分辨率，或使用支持直接保存文件的 Chrome / Edge 重新导出'
    default:
      return '导出未能开始'
  }
}

const progressOpts = (signal) => ({
  signal,
  // renderAll 不发 phase，缺省按 'render' 处理，两种任务共用同一套进度显示
  onProgress: (d, tt, ph) => {
    done.value = d
    total.value = tt
    phase.value = ph || 'render'
  },
})

function onRenderAll() {
  return run((signal) => {
    syncCanvasSize()
    return exporter.renderAll(canvasRef.value, progressOpts(signal))
  })
}

function onExportVideo() {
  exporting.value = true
  return run((signal) => {
    syncCanvasSize()
    return exporter.exportVideo(canvasRef.value, progressOpts(signal))
  })
}

function onCancel() {
  controller.value?.abort()
}
</script>

<template>
  <div class="export-panel">
    <!-- 分辨率 / 帧率：改完立刻反映到画布与编码探测 -->
    <div class="export-panel__settings">
      <label class="export-panel__field">
        <span class="export-panel__label">视频格式</span>
        <select
          class="export-panel__control"
          :value="format"
          :disabled="rendering"
          @change="settings.set('export.format', $event.target.value)"
        >
          <option value="mp4">MP4（普通背景）</option>
          <option value="mov-alpha">MOV（透明背景，无损）</option>
        </select>
      </label>
      <label class="export-panel__field">
        <span class="export-panel__label">分辨率</span>
        <select
          class="export-panel__control"
          :value="resolution"
          :disabled="rendering"
          @change="settings.set('export.resolution', $event.target.value)"
        >
          <option v-for="p in RESOLUTION_PRESETS" :key="p.id" :value="p.id">
            {{ p.label }}（{{ p.width }}×{{ p.height }}）
          </option>
        </select>
      </label>

      <label class="export-panel__field">
        <span class="export-panel__label">帧率</span>
        <select
          class="export-panel__control"
          :value="fpsi"
          :disabled="rendering"
          @change="settings.set('export.fps', Number($event.target.value))"
        >
          <option v-for="f in FPS_PRESETS" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
      </label>
    </div>

    <p class="export-panel__note">
      画布 {{ size.width }}×{{ size.height }} · {{ fpsi }} 帧
      <template v-if="!transparent"> · 约 {{ bitrate }} Mbps</template>
      ——画面按预览舞台等比缩放，动效、行距、字距、字体与配色都与预览一致。
    </p>
    <p v-if="transparent" class="export-panel__note">
      透明 MOV 保留歌词渐隐和半透明边缘，无需抠像。文件较大，建议先用 720p / 30 帧试导出。
      支持时会先选择保存位置并直接写入磁盘；其它浏览器使用内存下载，上限 512 MB。
      PNG 编码的 MOV 请导入支持该格式的剪辑软件，网页播放器可能无法预览。
    </p>

    <!--
      按钮分两组：
        预览组（渲染当前帧 / 渲染全部帧）—— 只看不下载
        导出组（导出视频 / 导出 LRC）—— 真正产出文件，并排放

      【为什么要分组而不是排成一行】
      抽屉宽 360px，四个按钮加起来约 380px 放不下，会自动折到第二行。
      折行后「导出 LRC」跑到「渲染当前帧」下面，与「导出视频」被隔开 ——
      而这两个恰恰是用户要找的同一类动作。
      用 nowrap 的子容器把"导出组"绑定在一起，
      折行时它俩作为一个整体换行，永远相邻。
    -->
    <div class="export-panel__row">
      <button class="btn" type="button" :disabled="rendering" @click="onRenderFrame">渲染当前帧</button>
      <button class="btn" type="button" :disabled="rendering" @click="onRenderAll">渲染全部帧</button>

      <!-- 导出组：两个出口紧挨在一起，不与上面的预览按钮拆散 -->
      <div class="export-panel__group">
        <button
          class="btn btn--primary"
          type="button"
          data-tour="export-video"
          :disabled="rendering || codecState === 'unsupported' || codecState === 'probing'"
          @click="onExportVideo"
        >
          {{ exporting ? '导出中…' : '导出视频' }}
        </button>

        <!--
          导出 LRC：与「导出视频」并排。
          只读已应用的歌词；有未应用的打轴草稿时会提示先去应用。
        -->
        <button
          class="btn"
          type="button"
          data-tour="export-lrc"
          :disabled="!canExportLrc"
          :title="
            canExportLrc
              ? `导出 ${lrcStats.exportable} 行歌词为 .lrc 文件`
              : '当前歌词没有有效的时间，无法导出'
          "
          @click="lrcExport.exportLrc()"
        >
          导出 LRC
        </button>
      </div>

      <button v-if="rendering" class="btn" type="button" @click="onCancel">取消</button>
    </div>

    <!--
      导出的 .lrc 是纯文本，可以直接用记事本改。
      本应用只能改时间轴（打轴/微调），改不了歌词文字本身，
      所以这里明确告诉用户"改字要用记事本" —— 否则他会一直在界面里找编辑入口。
    -->
    <p class="export-panel__note">
      如果要编辑 LRC 内的文字，可以自行用记事本打开 .lrc 文件修改。
    </p>

    <!-- 编码不可用时给出明确指引（预览仍可用，所以只禁「导出视频」） -->
    <p v-if="codecState === 'unsupported'" class="export-panel__warn">
      {{ transparent ? '当前浏览器无法生成 PNG 视频帧，请使用最新版 Chrome / Edge。' : '当前分辨率/帧率组合无法编码，请换一档分辨率或帧率，或改用最新版 Chrome / Edge。' }}
    </p>
    <p v-else-if="codecState === 'probing'" class="export-panel__note">正在检测编码能力…</p>

    <p v-if="lastRendered !== null && !rendering" class="export-panel__note">
      已渲染 {{ lastRendered.toFixed(2) }}s 处的画面
    </p>

    <!-- 用原生 <progress>，不自造进度条样式 -->
    <template v-if="rendering || total > 0">
      <progress class="export-panel__progress" :value="done" :max="total || 1" />
      <p class="export-panel__note">
        <template v-if="rendering">{{ progressText }}</template>
        <template v-else>{{ resultText }}</template>
      </p>
    </template>
    <p v-else-if="resultText" class="export-panel__note">{{ resultText }}</p>

    <p class="export-panel__note">
      导出时请保持页面在前台，否则浏览器会节流后台标签页。
    </p>

    <canvas ref="canvasRef" class="export-panel__canvas" :class="{ 'export-panel__canvas--transparent': transparent }" width="1280" height="720" />
    <p class="export-panel__note">
      导出的视频不含音频轨，请在剪辑软件里对齐你的音频文件。
    </p>
  </div>
</template>

<style scoped>
.export-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  margin-top: 8px;
}

.export-panel__settings {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  width: 100%;
}

.export-panel__field {
  display: flex;
  flex: 1 1 140px;
  flex-direction: column;
  gap: 4px;
}

.export-panel__label {
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
}

.export-panel__control {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  color: var(--ui-text);
  font-size: var(--ui-font-xs);
}

.export-panel__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/*
 * 导出组：「导出视频」+「导出 LRC」。
 *
 * 【为什么要包一层】
 * 抽屉只有 360px 宽，四个按钮加起来约 380px，必然折行。
 * 若让它们平铺，折行后「导出 LRC」会被推到下一行、和「导出视频」分开 ——
 * 而这两个是用户要找的同一类动作（真正产出文件）。
 * 这一层用 `flex-wrap: nowrap` 把它俩绑成整体：
 * 折行时一起换行，**永远保持相邻**，间距也与其它按钮一致。
 */
.export-panel__group {
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  align-items: center;
}

.export-panel__progress {
  width: 100%;
  height: 10px;
}

.export-panel__canvas {
  width: 100%;
  height: auto;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: #000;
}

.export-panel__note {
  margin: 0;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  line-height: 1.45;
}

.export-panel__canvas--transparent {
  background-color: #d4d4d4;
  background-image: conic-gradient(#a3a3a3 25%, transparent 0 50%, #a3a3a3 0 75%, transparent 0);
  background-size: 16px 16px;
}

.export-panel__warn {
  margin: 0;
  color: var(--ui-warn);
  font-size: var(--ui-font-xs);
  line-height: 1.45;
}
</style>
