<script setup>
/**
 * 歌词舞台 —— 自动滚动 + 当前行高亮。
 *
 * 【滚动实现：transform 而不是 scrollTop】
 * 容器 overflow:hidden，内部轨道用 translate3d 上移。
 * 理由：
 *  - scrollTop 赋值触发主线程布局/重绘，长歌词掉帧
 *  - transform 走 GPU 合成且不参与布局，因此当前行用 transform:scale 放大时
 *    相邻行位置完全不动（验收项）
 *
 * 【每帧只写不读】
 * 行几何（offsetTop/offsetHeight）只在歌词或排版设置变化时测量并缓存；
 * rAF 循环里只做纯数学 + 一次 style 写入，从不读布局属性，避免 layout thrashing。
 *
 * 【两种时间来源都支持】
 * 时间只来自 playerStore.currentTime，因此"真实音频"与"模拟时钟"自动都工作。
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useLyricsStore } from '@/stores/lyricsStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useLrcImport } from '@/composables/useLrcImport'
import { useAudioImport } from '@/composables/useAudioImport'
import { useAudioEngine } from '@/composables/useAudioEngine'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { useTappingStore } from '@/stores/tappingStore'
import { registerTappingAuto } from '@/composables/useTapping'
import { registerAutoScroll, registerTapping } from '@/devtools/diagHooks'
import { buildLogicalRows, createFadeEngine } from '@/core/fade'
import LyricLine from '@/components/LyricLine.vue'
import { charProgressAt, isCharTimed } from '@/core/charProgress'
import UntimedLine from '@/components/UntimedLine.vue'
import LyricsInfoPanel from '@/components/LyricsInfoPanel.vue'
import { DEFAULT_ASPECT, aspectCssValue, findAspect } from '@/core/settings'

const lyrics = useLyricsStore()
const player = usePlayerStore()
const settings = useSettingsStore()
const { onDrop, importing } = useLrcImport()
const { onAudioDrop } = useAudioImport()
const engine = useAudioEngine()

const containerRef = ref(/** @type {HTMLElement|null} */ (null))
const trackRef = ref(/** @type {HTMLElement|null} */ (null))

const auto = useAutoScroll({ containerRef, trackRef })
const { activeIndex, centerIndex, activeOffscreen, userScrolling, containerHeight } = auto

// 打轴模式（阶段 5 第 3 步）：
// - 这里只读 store，给「当前编辑行」加 .is-editing
// - 同时把**带 refs 的 auto 实例**注册给打轴单例，
//   否则 useTapping 自己 new 的 useAutoScroll 没有 DOM 引用，
//   程序滚动会静默失效（详见 useTapping 里 auto 的注释）。
registerTappingAuto(auto)

const tapping = useTappingStore()

// 开发模式下把控制器登记给验收脚本（生产构建会被 tree-shake 掉）
registerAutoScroll(auto)
registerTapping(tapping)

// 虚化的诊断信息：供验收脚本确认"只在换行/改配置时重算"与"中心行切换"
if (import.meta.env.DEV) {
  // @ts-expect-error 开发期挂载
  window.__lrcFadeDiag = {
    get computeCount() {
      return fadeEngine.computeCount()
    },
    get opacities() {
      const t = lineOpacities.value
      return t ? Array.from(t) : null
    },
    /** 虚化中心行（滚动回看时应变成视口中心行） */
    get centerIndex() {
      return centerIndex.value
    },
    /** 当前播放行 */
    get activeIndex() {
      return activeIndex.value
    },
  }
}

const hasLyrics = computed(() => lyrics.lines.length > 0)

// ────────────────────────────────────────────
// 歌词虚化
// ────────────────────────────────────────────

/**
 * 虚化计算引擎（带缓存）。
 *
 * 关键：computed 的依赖只有「歌词数组、当前播放行、虚化中心行、虚化配置」，
 * **不包含 currentTime**。因此播放过程中时间在行内推进时不会触发重算，
 * 只有真正换行（activeIndex/centerIndex 变化）或用户改设置时才计算一次。
 *
 * core/fade.js 的 createFadeEngine 还额外记账了计算次数，
 * 验收脚本可以直接证明"5 秒播放只重算了 5 次而不是 361 次"，
 * 以及"滚动过程中不是每帧重算"。
 */
const fadeEngine = createFadeEngine()

/*
 * 双语歌词的"放大"必须按逻辑行算，不能按物理行算。
 *
 * 【为什么】同时间的原文 + 翻译是**两个物理行**（各占一个 LyricLine），
 * 而 activeIndex 只指向其中一个。若 :active 用 i === activeIndex 判定，
 * 就变成"只有原文放大、翻译不动"，可 fade.js 早就规定双语算一行、
 * 一起淡出。放大与淡出用两套口径，观感上就是断的。
 *
 * 这里直接复用 fade.js 的 buildLogicalRows —— 它正是按「时间相同」归并，
 * 与淡出的口径完全一致，不另造一套判定。
 */
const logicalRowOf = computed(() => {
  const lines = lyrics.lines
  if (!Array.isArray(lines) || lines.length === 0) return null
  return buildLogicalRows(lines).rowOf
})

/** 第 i 个物理行是否属于"当前逻辑行"（双语时原文与翻译同时成立） */
function isActiveRow(i) {
  if (i !== activeIndex.value) {
    const rowOf = logicalRowOf.value
    if (!rowOf) return false
    if (activeIndex.value < 0 || i < 0) return false
    return rowOf[i] === rowOf[activeIndex.value]
  }
  return true
}

const fadeConfig = computed(() => settings.settings.fade)

/**
 * 每行的最终透明度；虚化关闭时返回 null，交给 CSS 类处理。
 *
 * 中心行取 auto.centerIndex：
 *  - 自动跟随时 = 当前播放行
 *  - 用户滚动回看时 = 视口中心那一行（需求：虚化跟随用户视角）
 */
const lineOpacities = computed(() => {
  const cfg = fadeConfig.value
  if (!cfg.enabled) return null
  return fadeEngine.get(lyrics.lines, activeIndex.value, cfg, centerIndex.value)
})

/** 取某行的透明度（虚化关闭时返回 null） */
function opacityOf(index) {
  const table = lineOpacities.value
  if (!table) return null
  const v = table[index]
  return Number.isFinite(v) ? v : null
}

/**
 * 某一行的逐字进度（0~1），null 表示这行没有逐字时间。
 *
 * 【为什么在这里算，而不是每行自己读 playerStore】
 * 播放时 currentTime 每帧都变。若每个 LyricLine 各自订阅，
 * 一屏 20 行就是 20 个组件的更新；在父级算一次再分发，只有一个依赖。
 *
 * 【为什么用 charProgressAt 而不是自己插值】
 * 导出侧（renderFrame）调的是同一个函数。两处共用一份公式，
 * 才谈得上"预览几何 = 导出几何"。
 * @param {number} i
 * @returns {number|null}
 */
function charProgressOf(i) {
  const line = lyrics.lines[i]
  if (!line || !isCharTimed(line)) return null
  return charProgressAt(line.chars, player.currentTime)
}

/*
  关于"快速拖动进度条时虚化状态立即跟上，不能滞后"：

  lineOpacities 是 computed，依赖 activeIndex —— 而 activeIndex 又是基于
  playerStore.currentTime 的 computed。Vue 的 computed 在渲染时**同步**求值，
  所以 seek 后同一帧内就会用新的 activeIndex 重算，不存在"等一秒才更新"的滞后。

  这里刻意不额外加 watch + 手动刷新：那反而会引入一个"何时刷新"的时序问题，
  并且可能造成重复计算。用依赖关系表达，比用命令式同步更可靠。
*/

/**
 * 上下留白占位块的高度（像素）。
 *
 * 必须是像素而不是百分比：轨道的 height 由内容决定（auto），
 * 百分比高度在 auto 高度的父元素上无法解析，会退化成 0，
 * 于是首行就永远无法停在容器中心。
 * 图省事用 vh 也不行 —— 舞台高度不等于视口高度（要减去顶栏与播放条）。
 */
const padTopPx = computed(() => Math.round(containerHeight.value * settings.settings.layout.padTop))
const padBottomPx = computed(() => Math.round(containerHeight.value * settings.settings.layout.padBottom))

/**
 * 画布比例适配（9:16 / 3:4 / 16:9）。
 *
 * 【比例必须落在 .stage 身上，而不是只落在外壳上】
 * 导出的几何全部来自 .stage 的实测尺寸（core/stageGeometry 读的就是它），
 * 如果只把外面那层做成竖屏、让 .stage 继续铺满宽屏区域，
 * 预览看起来是竖版、导出的版心却按宽屏算 —— 换行与行高全部对不上。
 * 所以外层 .stage-frame 只做"信箱底"（居中 + 留白上色），
 * 真正的比例写在 .stage 上：这样 k = 画布高 / .stage 高，
 * 比例一致时 k 在横竖两个方向上相同，导出与预览才是同一套几何。
 *
 * 尺寸怎么定（见下方 .stage-frame 的样式）：
 *   width = min(可用宽, 可用高 × 比例)，高度由 aspect-ratio 反推。
 * 两个方向同时确定，比例严格成立且永不溢出可用区域。
 * 容器查询单位（cqw/cqh）拿到的正是"舞台可用区域" —— 它已经扣掉了
 * 顶栏、播放条与抽屉避让，用 vw/vh 会算错。
 */
const aspectId = computed(() => settings.settings.export?.aspect ?? DEFAULT_ASPECT)
const aspectRatioCss = computed(() => aspectCssValue(aspectId.value))
const aspectLabel = computed(() => findAspect(aspectId.value).label)
/** 宽 / 高 的纯数值（0.5625 这样的），CSS 的 min()/calc 里要用 */
const aspectNum = computed(() => {
  const p = findAspect(aspectId.value)
  return p.width / p.height
})

/**
 * 需求 N1：无音频时用歌词时间轴作为模拟时钟时长。
 * 歌词清空且无音频时必须归零，否则会出现"不出声不报错、时间却在走"的空转播放态。
 */
watch(
  () => [lyrics.count, lyrics.lastTime, player.fileName],
  () => {
    if (player.fileName) {
      player.simMode = false
      return
    }
    if (lyrics.count > 0) {
      engine.setSimDuration(lyrics.lastTime + 3)
      player.simMode = true
    } else {
      engine.setSimDuration(0)
      player.simMode = false
      player.setDuration(0)
      player.playing = false
      player.currentTime = 0
    }
  },
  { immediate: true },
)

// ────────────────────────────────────────────
// 测量与生命周期
// ────────────────────────────────────────────

async function measureAndAlign() {
  await nextTick()
  // 等一帧，确保 CSS 变量已应用、留白高度已写入
  await new Promise((r) => requestAnimationFrame(r))
  auto.measure()
  auto.snapToTarget()
}

onMounted(async () => {
  await measureAndAlign()
  auto.observe()

  // 字体加载完成后行高可能变化，需要重新测量
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      auto.measure()
      if (!userScrolling.value) auto.snapToTarget()
    })
  }

  if (player.playing) auto.startLoop()
})

// 留白变化也要重新测量（否则几何缓存过期）
watch([padTopPx, padBottomPx], async () => {
  await new Promise((r) => requestAnimationFrame(r))
  auto.measure()
  if (!userScrolling.value) auto.snapToTarget()
})

/*
 * 画布比例变化也要重新测量。
 *
 * ResizeObserver 虽然也会观察到 .stage 变窄变高，但它只在尺寸真正变化时触发；
 * 比例切换的同一帧里 CSS 变量刚刚生效，缓存里的行宽/位移已经过期。
 * 这里显式等一帧再量，和留白变化走同一条路径 —— 几何只有一个入口，
 * 导出读到的也就永远是"当前比例下的真实几何"。
 */
watch(aspectId, async () => {
  await new Promise((r) => requestAnimationFrame(r))
  auto.measure()
  if (!userScrolling.value) auto.snapToTarget()
})

onBeforeUnmount(() => auto.unobserve())

// ────────────────────────────────────────────
// 用户手动滚动（滚轮 / 触摸 / 按键）
// ────────────────────────────────────────────

/**
 * 滚轮回看。
 *
 * 【边界处理：夹取，而不是整次忽略】
 * 早期写法是"如果这次滚动会越过边界，就直接 return 不处理"。
 * 那会导致很别扭的体验：还剩 314px 可回看空间时，
 * 一次 -400px 的滚动会被**整个丢弃**，用户觉得"滚了没反应"。
 * 正确做法：只要当前位置还没贴到边界，就接管这次滚动并夹取到边界；
 * 只有在**已经贴着边界**且继续往外滚时，才把控制权交还给页面（不 preventDefault）。
 *
 * 不 preventDefault 的必要性：否则舞台会把滚轮全部吞掉，
 * 设置抽屉等其它区域的滚动就失效了。
 */
function onWheel(e) {
  const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY
  if (delta === 0) return

  const bounds = auto.getBounds()
  const current = auto.currentOffset.value

  // 已贴边界且继续往外滚 → 交给外层页面处理
  const atTop = current <= bounds.min + 0.5
  const atBottom = current >= bounds.max - 0.5
  if ((atTop && delta < 0) || (atBottom && delta > 0)) return

  e.preventDefault()
  // scrollBy 内部会夹取到合法区间，超出的部分自然收敛到边界
  auto.scrollBy(delta)
}

/** 触摸拖动 */
let touchStartY = 0
let touchStartOffset = 0

function onTouchStart(e) {
  if (e.touches.length !== 1) return
  touchStartY = e.touches[0].clientY
  touchStartOffset = auto.currentOffset.value
}

function onTouchMove(e) {
  if (e.touches.length !== 1) return
  const dy = touchStartY - e.touches[0].clientY
  auto.scrollTo(touchStartOffset + dy)
}

function onScrollKeydown(e) {
  const bounds = auto.getBounds()
  const step = containerHeight.value * 0.8
  switch (e.key) {
    case 'PageUp':
      auto.scrollBy(-step)
      break
    case 'PageDown':
      auto.scrollBy(step)
      break
    case 'Home':
      auto.scrollTo(bounds.min)
      break
    case 'End':
      auto.scrollTo(bounds.max)
      break
    default:
      return
  }
  e.preventDefault()
}

// ────────────────────────────────────────────
// 拖拽导入
// ────────────────────────────────────────────

const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)

function onDragEnter(e) {
  e.preventDefault()
  dragDepth.value++
}
function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}
async function onDropInternal(e) {
  e.preventDefault()
  dragDepth.value = 0
  const handledAsAudio = await onAudioDrop(e)
  if (!handledAsAudio) await onDrop(e)
}

function pickDemo() {
  lyrics.loadDemo()
}

// ────────────────────────────────────────────
// N3 · 无时间标签的文本行
// ────────────────────────────────────────────

/**
 * 需求 N3：导入无时间标签的 .txt 后，先把文本按换行铺到舞台上，
 * 供用户进入打轴模式补时间。
 *
 * 【为什么是独立容器，而不是塞进轨道】
 * useAutoScroll.measure() 用 `track.querySelectorAll('[data-line-index]')`
 * 收集行几何，并**按 dataset.lineIndex 的值写入数组下标**。
 * 这意味着：
 *   - 塞进轨道但不给 data-line-index → 测量时数组出现空洞，
 *     而空洞会被补成 { top:0, height:0 }，可能污染边界计算；
 *   - 给负数或特殊索引 → 数组长度变成 lines+untimed，
 *     getBounds / findRowAtViewportCenter 的假设全部要改，风险最大。
 * 分开容器后，轨道里**永远只有有时间标签的行**，
 * 阶段 3 的滚动逻辑一行都不用改 —— 这是风险最低的方案。
 */
const untimedRows = computed(() => lyrics.droppedLines)

/** 只要有就显示：纯 .txt 导入后 lines 为空，此时也应看到文字 */
const showUntimed = computed(() => untimedRows.value.length > 0)

/**
 * 打轴模式是否作用于"没时间的行"（方案 C）。
 *
 * 为 true 时 `.stage__untimed` 会切成**打轴面板**形态：
 * 撑满舞台、字号切正常、编辑行/刚打完的行高亮。
 * 为 false 时保持原来的"底部小字区"形态。
 */
const isTappingUntimed = computed(() => tapping.enabled && tapping.tapTargetKind === 'dropped')

/**
 * 打轴模式是否作用于**轨道里的行**（纯 lrc 场景）。
 *
 * 与 isTappingUntimed 互斥：目标要么是 dropped、要么是 lines。
 * 分成两个 computed 而不是各写一遍条件，是为了让"哪一块被高亮"始终只有一个为真 ——
 * 混合文件下目标是 dropped，此时轨道里的行**不该**出现编辑行竖条，
 * 否则用户会看到两个地方都标着"下一行在这里"。
 */
const isTappingLines = computed(() => tapping.enabled && tapping.tapTargetKind === 'lines')

/**
 * 是否显示"还没有歌词"空状态。
 *
 * 【为什么 untimedRows 存在时就不显示空状态】
 * 空状态里有"还没有歌词 / 把 .lrc 文件拖到这里"这类引导，
 * 而用户刚导入了一个纯文本文件、已经能看到歌词内容了，
 * 再显示"还没有歌词"是自相矛盾的。
 *
 * 【打轴模式下必须强制隐藏 —— 显式写出来，不靠巧合】
 * 纯 txt 场景下 lines 为空（hasLyrics=false），打轴面板是唯一内容。
 * 若两者同时出现，用户会看到"还没有歌词"压在打轴面板上。
 * 目前 `!showUntimed` 恰好也能压住它，但那是**隐式依赖**：
 * 一旦将来打轴面板改成不依赖 showUntimed（比如独立渲染），
 * 这个依赖就断了且不会报错。所以这里显式再排除一次。
 */
const showEmpty = computed(() => !hasLyrics.value && !showUntimed.value && !tapping.enabled)
</script>

<template>
  <!--
    外层只是"信箱底"：负责居中、给留白区域上色，本身不是被测量的舞台。
    真舞台 .stage 居中放在里面，比例由 --stage-aspect 决定。
    e2e 脚本与 .app-stage 的测量都不受影响（.stage 仍然只有一个）。
  -->
  <div
    class="stage-frame"
    :class="{ 'is-ratio-fit': aspectId !== DEFAULT_ASPECT }"
    :style="{ '--stage-aspect': aspectRatioCss, '--stage-ratio': String(aspectNum) }"
    :data-aspect="aspectId"
    :data-aspect-label="aspectLabel"
  >
    <section
      ref="containerRef"
      class="stage"
      aria-label="歌词舞台"
      tabindex="0"
      @dragenter="onDragEnter"
      @dragover.prevent
      @dragleave="onDragLeave"
      @drop="onDropInternal"
      @wheel="onWheel"
      @touchstart.passive="onTouchStart"
      @touchmove="onTouchMove"
      @keydown="onScrollKeydown"
    >
      <LyricsInfoPanel />

      <Transition name="toast">
        <div v-if="dragging" class="stage__drop" aria-hidden="true">
          <div class="stage__drop-inner">
            <p class="stage__drop-title">{{ importing ? '正在解析…' : '松开即可导入' }}</p>
            <p class="stage__drop-hint">支持音频与 .lrc / .txt 歌词，全程本地处理，不会上传</p>
          </div>
        </div>
      </Transition>

      <div v-if="showEmpty" class="stage__empty">
        <p class="stage__empty-title">还没有歌词</p>
        <p class="stage__empty-hint">把 .lrc 文件拖到这里，或点击顶部「导入 LRC」。</p>
        <div class="stage__empty-actions">
          <button class="btn btn--primary" type="button" @click="pickDemo">载入内置示例</button>
        </div>
        <p v-if="lyrics.droppedLines.length" class="stage__empty-note">
          这份文件里有 {{ lyrics.droppedLines.length }} 行文本没有时间标签，因此无法滚动同步。
          可在阶段 5 的快速打轴模式中补时间。
        </p>
      </div>

      <template v-else>
        <!-- 轨道：唯一被 translate3d 移动的元素 -->
        <div v-if="hasLyrics" ref="trackRef" class="stage__track" :class="{ 'is-masked': isTappingUntimed }">
          <!--
            上下留白占位块（像素高度，由舞台高度 × 用户比例算出）。
            它们让"首行/末行也能停在容器中心"成为可能；
            测量时会被跳过（measure() 只取带 data-line-index 的元素）。
          -->
          <div class="stage__pad" :style="{ height: `${padTopPx}px` }" aria-hidden="true" />

          <LyricLine
            v-for="(line, i) in lyrics.lines"
            :key="line.id"
            :line="line"
            :index="i"
            :active="isActiveRow(i)"
            :past="activeIndex >= 0 && i < activeIndex"
            :editing="isTappingLines && i === tapping.editingIndex"
            :tapped="isTappingLines && i === tapping.lastTappedIndex"
            :opacity="opacityOf(i)"
            :char-progress="charProgressOf(i)"
          />

          <div class="stage__pad" :style="{ height: `${padBottomPx}px` }" aria-hidden="true" />
        </div>

        <!--
          N3 · 无时间标签的文本行。
          刻意放在轨道**之后**、且**不带 data-line-index**：
            - 不在轨道内 → 不会被 translate3d 搬动，也不进入 rowMetrics；
            - 不带 data-line-index → 即便将来有人移动了 DOM，也不会被 measure() 误收。
          它们不参与播放定位（没有时间，无法计算 activeIndex），只做静态铺开。
        -->
        <div
          v-if="showUntimed"
          class="stage__untimed"
          :class="{ 'is-tapping': isTappingUntimed }"
          data-testid="untimed-rows"
        >
          <!--
            标题在打轴模式下变成进度指示。
            原来的"N 行文本没有时间标签"是**说明**，
            打轴时用户需要的是**进度**（打到第几行了）。
          -->
          <p class="stage__untimed-head">
            <template v-if="isTappingUntimed">
              打轴中 · 第 {{ tapping.editingIndex + 1 }}/{{ tapping.totalCount }} 行
              <span class="stage__untimed-hint">空格打点 · ←/→ 微调 · Z 撤销</span>
            </template>
            <template v-else>{{ untimedRows.length }} 行文本没有时间标签</template>
          </p>
          <div class="stage__untimed-body">
            <UntimedLine
              v-for="(row, i) in untimedRows"
              :key="`u-${row.line}-${i}`"
              :row="row"
              :index="i"
              :editing="isTappingUntimed && i === tapping.editingIndex"
              :tapped="isTappingUntimed && i === tapping.lastTappedIndex"
            />
          </div>
        </div>

        <!-- 回看提示：用户滚走后提供一键回到当前行 -->
        <Transition name="toast">
          <button
            v-if="userScrolling || activeOffscreen"
            class="stage__resume"
            type="button"
            @click="auto.resumeFollow()"
          >
            <span class="stage__resume-dot" aria-hidden="true" />
            回到当前行
          </button>
        </Transition>
      </template>
    </section>
  </div>
</template>

<style scoped>
/*
 * 信箱底：整块可用区域的背景 —— 也就是导出画面**之外**的部分。
 *
 * 这里铺棋盘格而不是沿用 --lrc-bg，是为了让画布边界在视觉上明确可辨：
 * 竖版时两侧留白若与舞台同色，用户无法一眼看出哪部分会进导出，
 * 容易误判行宽（看着像放得下，其实已超出画布）。
 *
 * 棋盘画在 --lrc-bg 之上（background-image 叠加在 background-color 上），
 * 两格都用半透明色：用户改歌词背景色时棋盘随底色一起变，
 * 而不会像不透明棋盘那样把背景整个盖掉，制造出背景改了却看不出的假象。
 */
.stage-frame {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background-image: repeating-conic-gradient(
    var(--checker-a) 0% 25%,
    var(--checker-b) 0% 50%
  );
  /* 一个视觉格子 = --checker-size。repeating-conic-gradient 的 50% 只走半格，
     故背景尺寸取两倍，最终格边长才等于 --checker-size。 */
  background-size: calc(var(--checker-size) * 2) calc(var(--checker-size) * 2);
  background-color: var(--lrc-bg);
  transition: background-color var(--lrc-fade) ease;
  /*
   * 让内部可以用 cq 单位按"这块区域的实际尺寸"算舞台宽高。
   * 用 vw/vh 不行：可用区域还要减掉顶栏、播放条，以及抽屉打开时的避让。
   */
  container-type: size;
}

.stage {
  position: relative;
  /*
   * width:100% 是必须写出来的：.stage-frame 是 flex 容器，
   * 不写的话舞台会按内容收缩（横屏时右侧突然多出一条背景带），
   * 只有竖版那条 ratio-fit 规则才该覆盖它。
   */
  width: 100%;
  height: 100%;
  overflow: hidden; /* 滚动由 transform 接管，不使用原生滚动 */
  background: var(--lrc-bg);
  transition: background var(--lrc-fade) ease;
  /* 可聚焦以支持键盘滚动，但鼠标用户不该看到焦点框 */
  outline: none;
  flex: none;
}

/*
 * 竖版 / 3:4：舞台收窄成目标比例并居中。
 *
 * 16:9 不套这条规则 —— 横屏时舞台就该铺满（那是历史行为，
 * 窗口比例千变万化，强行锁 16:9 只会平白损失可视面积）。
 * 竖版则必须锁死比例：9:16 的换行位置和横屏完全不同，
 * 不锁的话"预览里一行放得下、导出里放不下"。
 *
 * 宽度取"可用宽"与"可用高 × 比例"的较小值，高度由 aspect-ratio 反推。
 * 这样两个方向同时被确定，且永远不会溢出可用区域（等比收缩，不留畸变）。
 * 用 cq 单位而不是 vw/vh：可用区域已经扣掉了顶栏、播放条与抽屉避让。
 */
.stage-frame.is-ratio-fit .stage {
  /*
   * 兜底（浏览器不支持 cq 单位时）：宽度铺满、高度按比例反推。
   * 刻意不加 max-height —— 一旦同时给"确定高度 + 最大高度 + aspect-ratio"，
   * 浏览器会遵守 max-height 而丢弃比例，画面被压扁。
   * 宁可让 .stage-frame 的 overflow:hidden 裁掉一点底部：比例仍是准的，
   * 量化出来的几何也仍然与导出同源，只是预览少看几行。
   */
  width: 100%;
  height: auto;
  max-width: 100%;
  aspect-ratio: var(--stage-aspect);
}

@supports (width: 1cqw) {
  .stage-frame.is-ratio-fit .stage {
    width: min(100cqw, calc(100cqh * var(--stage-ratio)));
    height: auto;
    max-width: none;
  }
}

.stage:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: -2px;
}

/*
 * 只在舞台被收窄成目标比例时画这条边界线 —— 它就是导出画面的真实边界。
 * 16:9 铺满时不画：此时边界与窗口重合，描边只是无意义的框。
 *
 * 刻意用 box-shadow 而不是 border / outline：
 *   · border 参与盒模型，会让 stageGeometry 量到的宽高少 2px，
 *     缩放系数随之算错，破坏"预览几何 = 导出几何"这条核心契约；
 *   · outline 会被下面 .stage:focus-visible 的焦点框整条覆盖，
 *     而舞台是 tabindex="0"，键盘用户一聚焦就看不到画布边界了。
 * box-shadow 既不占布局，也不受 outline 覆盖影响。
 */
.stage-frame.is-ratio-fit .stage {
  box-shadow: 0 0 0 1px rgb(255 255 255 / 22%);
}

/* 轨道：唯一被 transform 的元素 */
.stage__track {
  position: relative;
  width: 100%;
  /* 提示浏览器这层会被频繁变换，提前提升为合成层。
     注意只在这一层声明 —— 若给每一行都加 will-change，会建立上千个合成层而严重掉帧。 */
  will-change: transform;
}

.stage__pad {
  width: 100%;
  pointer-events: none;
}

/*
 * N3 · 无时间标签的文本行。
 *
 * 【为什么不复用 LyricLine】
 * LyricLine 带 data-line-index 且有 is-active / is-past / opacity 等状态，
 * 那些状态全都建立在"有时间轴"的前提上。给没有时间的行套用它，
 * 会让 measure() 收进没有意义的 index、让 activeIndex 有机会指向它。
 * 这里用一套独立的静态样式：位置、字号都跟正常歌词一致，
 * 但颜色更暗 —— 视觉上明确表达"这些行还不能跟着歌走"。
 */
/*
 * 只有无时间行时（没有滚动轨道），容器撑满整个舞台 ——
 * 否则底部 45% 的高度里挤着几行字，上面留出大片空白。
 * 有轨道时保持贴底，避免盖住正在滚动的歌词。
 */
.stage:not(:has(.stage__track)) .stage__untimed {
  top: 0;
  max-height: none;
}

.stage:not(:has(.stage__track)) .stage__untimed-body {
  /* 纯文本场景：内容在撑满的容器里垂直居中。
     用 margin-block:auto 而不是 justify-content:center，
     因为 justify-content 会把 sticky 标题一起顶走。 */
  margin-top: auto;
  margin-bottom: auto;
}

.stage__untimed {
  display: flex;
  flex-direction: column;
  /*
   * 必须显式 stretch。
   * 改成 flex 容器后，子元素默认 align-items:stretch 会被
   * "shrink-to-fit" 行为取代 —— 实测标题被压到 151px、文本区 150px，
   * 文字全部竖排。flex 布局下这类"宽度塌陷"是静默的，
   * 不会报错、不会警告，只会看起来很怪。
   */
  align-items: stretch;
  /* 贴在舞台底部，不占据滚动区 */
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  max-height: 45%;
  overflow-y: auto;
  /*
   * 必须显式裁掉横向溢出。
   * 无时间行可能很长（长句歌词），若让它撑开宽度，
   * 整个 .stage 会出现横向滚动条 —— 而舞台在阶段 3 的设计里
   * 是"容器 overflow:hidden + 轨道 transform"的二维封闭空间，
   * 多出的横向滚动条是纯粹的破坏。
   */
  overflow-x: hidden;
  padding: 16px 0 20px;
  background: color-mix(in srgb, var(--lrc-bg) 88%, transparent);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  /* 顶边一条淡线，与轨道内容区分开 */
  border-top: 1px solid color-mix(in srgb, var(--lrc-color-normal) 22%, transparent);
  overscroll-behavior: contain;
}

.stage__untimed-head {
  position: sticky;
  top: 0;
  margin: 0 auto;
  padding: 0 16px 10px;
  color: color-mix(in srgb, var(--lrc-color-normal) 72%, transparent);
  font-size: 12px;
  text-align: center;
  background: color-mix(in srgb, var(--lrc-bg) 88%, transparent);
}

.stage__untimed-body {
  max-width: var(--lrc-max-width);
  margin-inline: auto;
  padding-inline: 16px;
}

.stage__untimed-line {
  margin: 0 0 0.5em;
  color: color-mix(in srgb, var(--lrc-color-normal) 78%, transparent);
  font-family: var(--lrc-font-family);
  font-size: calc(var(--lrc-font-size) * 0.72);
  font-weight: var(--lrc-font-weight);
  letter-spacing: var(--lrc-letter-spacing);
  line-height: var(--lrc-line-height);
  text-align: var(--lrc-align);
  transition: color var(--lrc-fade) ease, opacity var(--lrc-fade) ease,
    transform var(--lrc-transition) cubic-bezier(0.22, 1, 0.36, 1);
}

/*
 * 无时间行的「下一行要打哪里」标记：左侧竖条。
 * 与 .lyric-line.is-editing 用同一套视觉语言（同色同宽），
 * 让用户在两块区域之间不需要重新学习符号。
 */
.stage__untimed-line.is-editing {
  border-left: 3px solid var(--ui-accent);
  padding-left: 12px;
}

/* 「刚打完」的行：颜色 + 放大，与 .lyric-line.is-tapped 一致 */
.stage__untimed-line.is-tapped {
  color: var(--lrc-color-tapped);
  opacity: 1;
  transform: scale(var(--lrc-active-scale));
  transform-origin: var(--lrc-align) center;
}

/*
 * 同时是 editing 与 tapped 时（打完一行后编辑行前进，正常不会同时，
 * 但撤销/跳转可能造成）：保持 tapped 的视觉，竖条仍在。
 * 与 LyricLine 的处理一致 —— 竖条是定位信息，不该被覆盖。
 */
.stage__untimed-line.is-editing.is-tapped {
  transform: scale(var(--lrc-active-scale));
}

/*
 * ── 打轴面板形态（方案 C：打轴作用于无时间行时）────────────────
 *
 * 【为什么撑满整个舞台】
 * 纯 txt 场景下舞台里**只有**这块内容，只占底部 45% 会让用户
 * 对着一条窄缝打轴；混合场景下打轴时也不该同时盯滚动歌词。
 * 撑满 + 把轨道遮住，视线自然集中到正在打的那一块。
 */
.stage__untimed.is-tapping {
  position: absolute;
  inset: 0;
  max-height: none;
  height: 100%;
  padding-top: 56px;
  padding-bottom: 32px;
  background: var(--lrc-bg);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-top: none;
  /*
   * 必须高于 .stage::after 的遮罩层。
   * ::after 是 .stage 的最后一个子元素，默认会盖在 .stage__untimed 之上 ——
   * 不抬这一层的话，打轴面板会被自己的遮罩压暗（面板是给用户看的，
   * 遮罩是给轨道用的，两者目标相反）。
   */
  z-index: 2;
}

/* 打轴面板里的行切到正常歌词字号，盯着看不费眼 */
.stage__untimed.is-tapping .stage__untimed-line {
  color: var(--lrc-color-normal);
  font-size: var(--lrc-font-size);
}

.stage__untimed.is-tapping .stage__untimed-head {
  color: var(--lrc-color-normal);
  font-size: 13px;
  background: var(--lrc-bg);
}

.stage__untimed-hint {
  display: block;
  margin-top: 4px;
  color: color-mix(in srgb, var(--lrc-color-normal) 62%, transparent);
  font-size: 11px;
}

/*
 * 打轴作用于无时间行时，把轨道压暗并盖一层遮罩。
 *
 * 【为什么用伪元素而不是 ::after 挂在轨道上】
 * .stage__track 本身有 translate3d（滚动位移），
 * 遮罩若跟着它移动，滚动时会露出没盖住的部分。
 * 挂在 .stage 的伪元素上位置固定，始终覆盖整个可视区。
 */
.stage:has(.stage__untimed.is-tapping) .stage__track {
  opacity: 0.18;
  filter: blur(1px);
  pointer-events: none;
}

/* 遮罩层：明确的"这块现在不参与操作"信号 */
.stage:has(.stage__untimed.is-tapping)::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--lrc-bg) 72%, transparent),
    color-mix(in srgb, var(--lrc-bg) 92%, transparent)
  );
  pointer-events: none;
}

/*
 * 有歌词轨道时才给底部留出空间，避免无时间文本压住末行歌词。
 *
 * 【为什么用固定 120px 而不是 vh】
 * 试过 22vh，结果在 900px 高的窗口下留出 198px，
 * 而无时间行容器实际只有 147px 高 —— 中间出现大片空白，
 * 歌词区被推得过高、末行不再居中。
 * 容器本身有 max-height:45%，所以这里只需覆盖"最矮的那档"。
 */
.stage:has(.stage__untimed) .stage__track {
  padding-bottom: 120px;
}

.stage__empty {
  display: grid;
  place-content: center;
  height: 100%;
  padding: 24px;
  color: var(--lrc-color-normal);
  text-align: center;
}

.stage__empty-title {
  margin: 0 0 6px;
  color: var(--lrc-color-active);
  font-size: 20px;
  font-weight: 600;
}

.stage__empty-hint {
  margin: 0;
  font-size: 13px;
}

.stage__empty-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin-top: 14px;
}

.stage__empty-note {
  max-width: 420px;
  margin: 18px auto 0;
  color: var(--lrc-color-normal);
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.8;
}

/* 拖拽遮罩 */
.stage__drop {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--ui-accent) 18%, rgb(0 0 0 / 55%));
  backdrop-filter: blur(2px);
}

.stage__drop-inner {
  padding: 22px 28px;
  border: 2px dashed var(--ui-accent);
  border-radius: var(--ui-radius);
  background: color-mix(in srgb, var(--ui-panel) 92%, transparent);
  text-align: center;
}

.stage__drop-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}

.stage__drop-hint {
  margin: 0;
  color: var(--ui-text-dim);
  font-size: 12px;
}

/* 回到当前行 */
.stage__resume {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 25;
  display: inline-flex;
  gap: 7px;
  align-items: center;
  padding: 8px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-panel) 92%, transparent);
  backdrop-filter: blur(8px);
  color: var(--ui-text);
  font-size: var(--ui-font-xs);
  box-shadow: var(--ui-shadow);
  cursor: pointer;
}

.stage__resume:hover {
  border-color: var(--ui-accent);
}

.stage__resume-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-accent);
}
</style>
