<script setup>
/**
 * 设置抽屉。
 *
 * 阶段 3 范围：全部可视化设置项接通 CSS 变量并实时预览，
 * 接入 localStorage 持久化（防抖写入）与"重置"。
 *
 * 所有数值控件都从 core/settings.js 的 FIELD_META 读取范围，
 * 避免"UI 能拖到 3，逻辑只认到 1"这类两处硬编码不一致的问题。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUiStore } from '@/stores/uiStore'
import { FONT_FAMILY_PRESETS, FIELD_META, createDefaultSettings, resolveStrokeColor } from '@/core/settings'
import { makeMessage } from '@/core/errors'
import ColorPicker from '@/components/settings/ColorPicker.vue'
import ExportPanel from '@/components/ExportPanel.vue'
import { useTappingShared } from '@/composables/useTapping'
import { registerCustomFont, unregisterCustomFont } from '@/core/fontLoader'

const settings = useSettingsStore()
const ui = useUiStore()
// 单例：与 useKeyboard / PlayerBar 共享同一份打轴状态
const tappingAPI = useTappingShared()

const s = computed(() => settings.settings)
const META = FIELD_META

/**
 * 描边位置选项。
 *
 * 【为什么没有「内侧」】
 * CSS 的 -webkit-text-stroke 线宽永远以字形轮廓为中心，没有属性能推到内侧；
 * SVG2 的 stroke-alignment: inner 至今无浏览器实现（实测 Edge 155 → false）。
 * 唯一近似手段是 SVG 滤镜 feMorphology erode，但它会把填充一起吃掉、
 * 半径不随字号缩放，且与 canvas 的结果对不上（实测 IoU 仅 0.38）——
 * 那会破坏本项目的核心契约「导出 = 预览」，所以不做。
 * 外侧与居中都能在 CSS 与 canvas 上用同一套绘制顺序表达，天然一致。
 */
const STROKE_POSITIONS = [
  { value: 'outer', label: '外侧（默认）' },
  { value: 'center', label: '居中（内外各半）' },
]

// ── 自定义字体（会话内）──
/** 字体加载中：字体文件可能几 MB，加载要几秒，必须给反馈 */
const fontLoading = ref(false)
const fontFileRef = ref(/** @type {HTMLInputElement|null} */ (null))
/** 上传时的原始文件名，仅用于界面显示（字体名是内部生成的唯一名） */
const fontFileName = ref('')

/** 界面上显示的名字：优先原始文件名，刷新后没有文件名则显示"已上传字体" */
const customFontLabel = computed(() => fontFileName.value || '已上传字体')
/** 超过这个大小就提示（但仍允许继续） */
const FONT_SIZE_WARN_MB = 30

function pickFontFile() {
  fontFileRef.value?.click()
}

/** @param {Event} e */
async function onFontFileChange(e) {
  const input = /** @type {HTMLInputElement} */ (e.target)
  const file = input.files?.[0]
  // 立即清空，否则连续选同一个文件不会触发 change
  input.value = ''
  if (!file) return

  if (file.size > FONT_SIZE_WARN_MB * 1024 * 1024) {
    ui.push({
      level: 'warn',
      message: `字体文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB，超过 ${FONT_SIZE_WARN_MB}MB），可能加载缓慢`,
      hint: '仍会继续加载，请稍候',
    })
  }

  fontLoading.value = true
  try {
    const family = await registerCustomFont(file)
    // 换字体前先卸掉上一个，避免同一会话里堆积多个 FontFace
    const prev = s.value.font.customFamily
    if (prev && prev !== family) unregisterCustomFont(prev)
    settings.set('font.customFamily', family)
    fontFileName.value = file.name
    ui.push({ level: 'info', message: '自定义字体已生效', hint: `仅本次会话有效：${file.name}` })
  } catch {
    ui.push({
      level: 'error',
      message: '这个字体文件浏览器无法识别，试试 .ttf 或 .otf 格式',
      hint: '.ttc 字体包在 Safari / Firefox 上可能不被支持',
    })
  } finally {
    fontLoading.value = false
  }
}

function removeCustomFont() {
  const cur = s.value.font.customFamily
  if (cur) unregisterCustomFont(cur)
  settings.set('font.customFamily', '')
  fontFileName.value = ''
}

/** 仅在 ?dragdebug=1 时显示的「下载诊断日志」按钮 */
const showDiagButton = (() => {
  try {
    return /[?&]dragdebug=1/.test(window.location.search)
  } catch {
    return false
  }
})()

/**
 * 哪些颜色项展开了调色盘。
 * 默认只展开当前行颜色（最常调的一项）；描边颜色默认收起 ——
 * 描边整体默认关闭，没必要一进面板就展开一个空的调色盘。
 */
const openPicker = ref(/** @type {Record<string, boolean>} */ ({ active: true, stroke: false }))

/** 导出面板默认收起（骨架阶段，避免占满抽屉） */
const showExport = ref(false)

function togglePicker(key) {
  openPicker.value[key] = !openPicker.value[key]
}

/**
 * 打包并下载诊断日志（.txt）。
 *
 * 【为什么做这个】
 * 排查真机拖动问题时，用户此前需要打开控制台、逐条复制日志，
 * 折腾且容易漏。做成一键下载，用户点一下把文件发来即可。
 *
 * 内容包含：环境信息、拖动诊断日志、捕获事件时序、当前设置与状态快照。
 */
function downloadDiagnostics() {
  const d = settings
  const diag = /** @type {any} */ (window).__lrcDiag
  const captureLog = /** @type {any} */ (window).__lrcCaptureLog

  const lines = [
    '════════════════════════════════════════',
    'LRC 歌词滚动字幕 · 诊断日志',
    `导出时间: ${new Date().toISOString()}`,
    `User Agent: ${navigator.userAgent}`,
    `页面: ${window.location.href}`,
    `视口: ${window.innerWidth} x ${window.innerHeight}  DPR: ${window.devicePixelRatio}`,
    '════════════════════════════════════════',
    '',
    '── 播放器状态 ──',
    JSON.stringify(
      {
        playing: d.player?.playing,
        currentTime: d.player?.currentTime,
        duration: d.player?.duration,
        fileName: d.player?.fileName,
        lyricsCount: d.lyrics?.count,
        mode: diag?.engine?.diagnostics?.mode,
        scrubbing: diag?.engine?.diagnostics?.scrubbing,
        seekGuardActive: diag?.engine?.diagnostics?.seekGuardActive,
      },
      null,
      2,
    ),
    '',
    '── 滚动状态 ──',
    diag?.auto
      ? JSON.stringify(
          {
            activeIndex: diag.auto.activeIndex,
            centerIndex: diag.auto.centerIndex,
            userScrolling: diag.auto.userScrolling,
            currentOffset: diag.auto.currentOffset,
            containerHeight: diag.auto.containerHeight,
            rowCount: diag.auto.rowCount,
          },
          null,
          2,
        )
      : '(未挂载)',
    '',
    '── 指针捕获事件时序（gotpointercapture / lostpointercapture）──',
    captureLog?.length ? captureLog.map((e) => JSON.stringify(e)).join('\n') : '(无记录)',
    '',
    '── 当前设置 ──',
    JSON.stringify(d.settings, null, 2),
    '',
  ]

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `lrc-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  a.click()
  // 下载已触发，立即回收
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const ALIGNS = [
  { label: '左对齐', value: 'left' },
  { label: '居中', value: 'center' },
  { label: '右对齐', value: 'right' },
]

const BG_MODES = [
  { label: '自定义', value: 'solid' },
  { label: '绿幕', value: 'green' },
  { label: '黑幕', value: 'black' },
]

const SCROLL_MODES = [
  { label: '当前行居中', value: 'center' },
  { label: '黄金分割位', value: 'golden' },
]

const FOLLOW_MODES = [
  { label: '3 秒后自动恢复跟随', value: 'resume' },
  { label: '只在我点击时恢复', value: 'manual' },
]

/** 虚化模式（需求：linear / ease / none 三选一，默认 ease） */
const FADE_MODES = [
  { label: '柔和（ease）', value: 'ease' },
  { label: '匀速（linear）', value: 'linear' },
  { label: '直接隐藏（none）', value: 'none' },
]

/** 有改动过的字段，用于"重置"按钮的可用态与提示 */
const isDefault = computed(() => {
  const d = createDefaultSettings()
  return JSON.stringify(d) === JSON.stringify(s.value)
})

function onReset() {
  settings.reset()
  ui.push({
    level: 'info',
    message: '已恢复默认设置',
    hint: '本地保存的设置已清空。',
  })
}

// 页面隐藏/关闭前把待写的防抖内容落盘，避免最后一次改动丢失
function onVisibilityChange() {
  if (document.visibilityState === 'hidden') settings.flush()
}

/**
 * pagehide 的落盘处理。
 *
 * 必须用具名函数：原写法是 `window.addEventListener('pagehide', settings.flush)` ——
 * 传入的是 Pinia action 的引用（每次访问 settings.flush 可能得到不同的包装函数），
 * 卸载时无法用同一个引用移除，属于"加了删不掉"的同一类问题。
 * 这里固定在模块级函数上，add/remove 用同一个引用。
 */
function onPageHide() {
  settings.flush()
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)

  // 载入时若发现设置损坏/不可用，提示一次
  const code = settings.loadIssueCode()
  if (code) {
    ui.push(makeMessage(code))
    settings.clearLoadIssue()
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('pagehide', onPageHide)
})

/** hex 输入非法时的回调（ColorPicker 已阻止生效，这里只做提示） */
function onColorInvalid(key, raw) {
  ui.push({
    level: 'warn',
    message: `颜色值「${raw}」格式不正确`,
    hint: '请输入 3 位或 6 位十六进制，如 #f00 或 #ff0000。改动未生效。',
  })
  void key
}

/**
 * 打开打轴模式（阶段 5 第 3 步）。
 *
 * 【为什么放在设置面板里】
 * 打轴的主用户是**没有 lrc 的人**（有 lrc 的人时间已经定了）。
 * 他们导入 .txt 后，最显眼的入口就是设置面板这一项；
 * 播放条左下角那个「打轴」按钮比较小，不一定被注意到。
 *
 * 顺手关闭抽屉：打轴面板在舞台上，抽屉开着会挡住它。
 */
function onOpenTapping() {
  settings.closeDrawer()
  const on = tappingAPI.setEnabled(true)
  void on
}
</script>

<template>
  <Transition name="drawer">
    <aside v-if="settings.drawerOpen" id="settings-drawer" class="drawer" aria-label="设置面板">
      <header class="drawer__head">
        <h2 class="drawer__title">设置</h2>
        <div class="drawer__head-actions">
          <button
            v-if="showDiagButton"
            class="btn btn--ghost drawer__diag"
            type="button"
            title="把拖动诊断日志导出为 .txt 文件"
            @click="downloadDiagnostics"
          >
            下载诊断日志
          </button>
          <button
            class="btn btn--ghost drawer__reset"
            type="button"
            :disabled="isDefault"
            :title="isDefault ? '当前已是默认设置' : '恢复默认并清空本地保存'"
            @click="onReset"
          >
            重置
          </button>
          <button class="btn btn--ghost btn--icon" type="button" aria-label="关闭设置" @click="settings.closeDrawer()">
            ✕
          </button>
        </div>
      </header>

      <div class="drawer__body scroll-thin">
        <!-- ============ 字体 ============ -->
        <section class="group">
          <h3 class="group__title">字体</h3>

          <label class="field">
            <span class="field__label">字体族</span>
            <select
              class="field__control"
              :value="s.font.family"
              @change="settings.set('font.family', $event.target.value)"
            >
              <option v-for="f in FONT_FAMILY_PRESETS" :key="f.value" :value="f.value">{{ f.label }}</option>
            </select>
          </label>

          <!--
            自定义字体：只在本会话有效，刷新后需重新上传。
            不做持久化是有意的 —— 中文字体 10~25MB，localStorage 装不下（实测配额 4.75MB），
            而 IndexedDB 在存储压力下可能被浏览器清除，会给出"存住了却丢了"的错误预期。
          -->
          <div class="field">
            <span class="field__label">自定义字体</span>
            <input
              ref="fontFileRef"
              class="font-upload__input"
              type="file"
              accept=".ttf,.otf,.woff,.woff2,.ttc"
              @change="onFontFileChange"
            />
            <div class="font-upload">
              <button class="btn" type="button" :disabled="fontLoading" @click="pickFontFile">
                {{ fontLoading ? '加载中…' : '上传字体文件' }}
              </button>
              <template v-if="s.font.customFamily">
                <span class="font-upload__name" :title="s.font.customFamily">{{ customFontLabel }}</span>
                <button class="btn" type="button" @click="removeCustomFont">移除</button>
              </template>
            </div>
            <p class="font-upload__note">
              支持 .ttf / .otf / .woff / .woff2 / .ttc，仅本次会话有效（刷新后需重新上传）。
            </p>
          </div>

          <label class="field">
            <span class="field__label">
              字号
              <em class="field__value">{{ s.font.size }}{{ META['font.size'].unit }}</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['font.size'].min"
              :max="META['font.size'].max"
              :step="META['font.size'].step"
              :value="s.font.size"
              @input="settings.set('font.size', Number($event.target.value))"
            />
          </label>

          <label class="field">
            <span class="field__label">
              字间距
              <em class="field__value">{{ s.font.letterSpacing }}{{ META['font.letterSpacing'].unit }}</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['font.letterSpacing'].min"
              :max="META['font.letterSpacing'].max"
              :step="META['font.letterSpacing'].step"
              :value="s.font.letterSpacing"
              @input="settings.set('font.letterSpacing', Number($event.target.value))"
            />
          </label>

          <label class="field">
            <span class="field__label">
              行间距
              <em class="field__value">{{ s.font.lineHeight }}{{ META['font.lineHeight'].unit }}</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['font.lineHeight'].min"
              :max="META['font.lineHeight'].max"
              :step="META['font.lineHeight'].step"
              :value="s.font.lineHeight"
              @input="settings.set('font.lineHeight', Number($event.target.value))"
            />
          </label>

          <label class="field">
            <span class="field__label">
              当前行放大
              <em class="field__value">{{ s.font.scale }}{{ META['font.scale'].unit }}</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['font.scale'].min"
              :max="META['font.scale'].max"
              :step="META['font.scale'].step"
              :value="s.font.scale"
              @input="settings.set('font.scale', Number($event.target.value))"
            />
          </label>
        </section>

        <!-- ============ 颜色 ============ -->
        <section class="group">
          <h3 class="group__title">颜色</h3>

          <div class="field">
            <button class="field__toggle" type="button" :aria-expanded="openPicker.active" @click="togglePicker('active')">
              <span class="field__chevron" :class="{ 'is-open': openPicker.active }" aria-hidden="true">▸</span>
              当前行颜色
              <span class="field__dot" :style="{ background: s.color.active }" />
            </button>
            <div v-show="openPicker.active" class="field__panel">
              <ColorPicker
                :model-value="s.color.active"
                label="当前行颜色"
                @update:model-value="settings.set('color.active', $event)"
                @invalid="onColorInvalid('active', $event)"
              />
            </div>
          </div>

          <div class="field">
            <button class="field__toggle" type="button" :aria-expanded="openPicker.tapped" @click="togglePicker('tapped')">
              <span class="field__chevron" :class="{ 'is-open': openPicker.tapped }" aria-hidden="true">▸</span>
              刚打轴行颜色
              <span class="field__dot" :style="{ background: s.color.tapped }" />
            </button>
            <div v-show="openPicker.tapped" class="field__panel">
              <ColorPicker
                :model-value="s.color.tapped"
                label="刚打轴行颜色"
                @update:model-value="settings.set('color.tapped', $event)"
                @invalid="onColorInvalid('tapped', $event)"
              />
            </div>
          </div>

          <div class="field">
            <button class="field__toggle" type="button" :aria-expanded="openPicker.charProgress" @click="togglePicker('charProgress')">
              <span class="field__chevron" :class="{ 'is-open': openPicker.charProgress }" aria-hidden="true">▸</span>
              逐字进度色
              <span class="field__dot" :style="{ background: s.color.charProgress }" />
            </button>
            <div v-show="openPicker.charProgress" class="field__panel">
              <ColorPicker
                :model-value="s.color.charProgress"
                label="逐字进度色"
                @update:model-value="settings.set('color.charProgress', $event)"
                @invalid="onColorInvalid('charProgress', $event)"
              />
            </div>
          </div>

          <div class="field">
            <button class="field__toggle" type="button" :aria-expanded="openPicker.normal" @click="togglePicker('normal')">
              <span class="field__chevron" :class="{ 'is-open': openPicker.normal }" aria-hidden="true">▸</span>
              普通行颜色
              <span class="field__dot" :style="{ background: s.color.normal }" />
            </button>
            <div v-show="openPicker.normal" class="field__panel">
              <ColorPicker
                :model-value="s.color.normal"
                label="普通行颜色"
                @update:model-value="settings.set('color.normal', $event)"
                @invalid="onColorInvalid('normal', $event)"
              />
            </div>
          </div>

          <label class="field">
            <span class="field__label">背景</span>
            <select class="field__control" :value="s.color.bgMode" @change="settings.set('color.bgMode', $event.target.value)">
              <option v-for="m in BG_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
          </label>

          <div class="field">
            <button class="field__toggle" type="button" :aria-expanded="openPicker.bg" @click="togglePicker('bg')">
              <span class="field__chevron" :class="{ 'is-open': openPicker.bg }" aria-hidden="true">▸</span>
              背景颜色
              <span class="field__dot" :style="{ background: s.color.bg }" />
            </button>
            <div v-show="openPicker.bg" class="field__panel">
              <ColorPicker
                :model-value="s.color.bg"
                label="背景颜色"
                @update:model-value="settings.set('color.bg', $event)"
                @invalid="onColorInvalid('bg', $event)"
              />
            </div>
          </div>
        </section>

        <!-- ============ 文字描边 ============ -->
        <section class="group">
          <h3 class="group__title">文字描边</h3>

          <label class="field">
            <span class="field__label">
              描边粗细
              <em class="field__value">{{ s.stroke.width }}{{ META['stroke.width'].unit }}</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['stroke.width'].min"
              :max="META['stroke.width'].max"
              :step="META['stroke.width'].step"
              :value="s.stroke.width"
              @input="settings.set('stroke.width', Number($event.target.value))"
            />
          </label>

          <p class="group__note">
            拖到 0 即关闭描边（默认关闭）。单位 em 随字号等比缩放，改字号或换分辨率都不用重调。
          </p>

          <!--
            描边位置。
            【为什么只有外侧和居中】
            内侧在 CSS 里做不到（stroke-alignment: inner 无浏览器实现），
            唯一近似手段 erode 滤镜会吃掉填充、且与导出对不上 ——
            会破坏"导出 = 预览"。这里只给两种真正能做一致的选项。
          -->
          <label class="field">
            <span class="field__label">描边位置</span>
            <select
              class="field__control"
              :value="s.stroke.position"
              @change="settings.set('stroke.position', $event.target.value)"
            >
              <option v-for="p in STROKE_POSITIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </label>

          <div class="field">
            <button class="field__toggle" type="button" :aria-expanded="openPicker.stroke" @click="togglePicker('stroke')">
              <span class="field__chevron" :class="{ 'is-open': openPicker.stroke }" aria-hidden="true">▸</span>
              描边颜色
              <span class="field__dot" :style="{ background: resolveStrokeColor(s) }" />
            </button>
            <div v-show="openPicker.stroke" class="field__panel">
              <ColorPicker
                :model-value="s.stroke.color"
                label="描边颜色"
                @update:model-value="settings.set('stroke.color', $event)"
                @invalid="onColorInvalid('strokeColor', $event)"
              />
            </div>
          </div>

          <label class="field">
            <span class="field__label">
              描边明亮
              <em class="field__value">{{ s.stroke.brightness }}{{ META['stroke.brightness'].unit }}</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['stroke.brightness'].min"
              :max="META['stroke.brightness'].max"
              :step="META['stroke.brightness'].step"
              :value="s.stroke.brightness"
              @input="settings.set('stroke.brightness', Number($event.target.value))"
            />
          </label>

          <p class="group__note">
            「颜色」决定色相（红/蓝/青…），「明亮」单独决定明暗：0 = 纯黑，100 = 纯白。
          </p>
        </section>

        <!-- ============ 布局 ============ -->
        <section class="group">
          <h3 class="group__title">布局</h3>

          <label class="field">
            <span class="field__label">对齐方式</span>
            <select class="field__control" :value="s.layout.align" @change="settings.set('layout.align', $event.target.value)">
              <option v-for="a in ALIGNS" :key="a.value" :value="a.value">{{ a.label }}</option>
            </select>
          </label>

          <label class="field">
            <span class="field__label">
              上方留白
              <em class="field__value">{{ Math.round(s.layout.padTop * 100) }}%</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['layout.padTop'].min"
              :max="META['layout.padTop'].max"
              :step="META['layout.padTop'].step"
              :value="s.layout.padTop"
              @input="settings.set('layout.padTop', Number($event.target.value))"
            />
          </label>

          <label class="field">
            <span class="field__label">
              下方留白
              <em class="field__value">{{ Math.round(s.layout.padBottom * 100) }}%</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['layout.padBottom'].min"
              :max="META['layout.padBottom'].max"
              :step="META['layout.padBottom'].step"
              :value="s.layout.padBottom"
              @input="settings.set('layout.padBottom', Number($event.target.value))"
            />
          </label>

          <label class="field">
            <span class="field__label">
              文本最大宽度
              <em class="field__value">{{ Math.round(s.layout.maxWidth * 100) }}%</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['layout.maxWidth'].min"
              :max="META['layout.maxWidth'].max"
              :step="META['layout.maxWidth'].step"
              :value="s.layout.maxWidth"
              @input="settings.set('layout.maxWidth', Number($event.target.value))"
            />
          </label>
        </section>

        <!-- ============ 动效与跟随 ============ -->
        <section class="group">
          <h3 class="group__title">滚动与动效</h3>

          <label class="field">
            <span class="field__label">当前行位置</span>
            <select class="field__control" :value="s.motion.scrollMode" @change="settings.set('motion.scrollMode', $event.target.value)">
              <option v-for="m in SCROLL_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
          </label>

          <label class="field">
            <span class="field__label">手动滚动后</span>
            <select class="field__control" :value="s.motion.followUser" @change="settings.set('motion.followUser', $event.target.value)">
              <option v-for="m in FOLLOW_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
          </label>

          <label class="field">
            <span class="field__label">
              过渡时长
              <em class="field__value">{{ s.motion.transitionMs }}{{ META['motion.transitionMs'].unit }}</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['motion.transitionMs'].min"
              :max="META['motion.transitionMs'].max"
              :step="META['motion.transitionMs'].step"
              :value="s.motion.transitionMs"
              @input="settings.set('motion.transitionMs', Number($event.target.value))"
            />
          </label>

          <label class="field">
            <span class="field__label">
              颜色渐变时长
              <em class="field__value">{{ s.motion.activeFadeMs }}{{ META['motion.activeFadeMs'].unit }}</em>
            </span>
            <input
              class="field__control"
              type="range"
              :min="META['motion.activeFadeMs'].min"
              :max="META['motion.activeFadeMs'].max"
              :step="META['motion.activeFadeMs'].step"
              :value="s.motion.activeFadeMs"
              @input="settings.set('motion.activeFadeMs', Number($event.target.value))"
            />
          </label>

          <label class="field field--row">
            <span class="field__label">减少动态效果</span>
            <input
              type="checkbox"
              :checked="s.motion.reduceMotion"
              @change="settings.set('motion.reduceMotion', $event.target.checked)"
            />
          </label>
        </section>

        <!-- ============ 虚化 ============ -->
        <section class="group">
          <h3 class="group__title">虚化</h3>
          <p class="group__note">
            以当前行为中心，距离越远的行越透明；超过过渡范围完全不可见。
          </p>

          <label class="field field--row">
            <span class="field__label">启用虚化</span>
            <input
              type="checkbox"
              :checked="s.fade.enabled"
              @change="settings.set('fade.enabled', $event.target.checked)"
            />
          </label>

          <template v-if="s.fade.enabled">
            <label class="field">
              <span class="field__label">
                实体行数（上）
                <em class="field__value">{{ s.fade.solidAbove }}{{ META['fade.solidAbove'].unit }}</em>
              </span>
              <input
                class="field__control"
                type="range"
                :min="META['fade.solidAbove'].min"
                :max="META['fade.solidAbove'].max"
                :step="META['fade.solidAbove'].step"
                :value="s.fade.solidAbove"
                @input="settings.set('fade.solidAbove', Number($event.target.value))"
              />
            </label>

            <label class="field">
              <span class="field__label">
                实体行数（下）
                <em class="field__value">{{ s.fade.solidBelow }}{{ META['fade.solidBelow'].unit }}</em>
              </span>
              <input
                class="field__control"
                type="range"
                :min="META['fade.solidBelow'].min"
                :max="META['fade.solidBelow'].max"
                :step="META['fade.solidBelow'].step"
                :value="s.fade.solidBelow"
                @input="settings.set('fade.solidBelow', Number($event.target.value))"
              />
            </label>

            <label class="field">
              <span class="field__label">
                过渡行数
                <em class="field__value">{{ s.fade.fadeRows }}{{ META['fade.fadeRows'].unit }}</em>
              </span>
              <input
                class="field__control"
                type="range"
                :min="META['fade.fadeRows'].min"
                :max="META['fade.fadeRows'].max"
                :step="META['fade.fadeRows'].step"
                :value="s.fade.fadeRows"
                @input="settings.set('fade.fadeRows', Number($event.target.value))"
              />
            </label>

            <label class="field">
              <span class="field__label">虚化模式</span>
              <select
                class="field__control"
                :value="s.fade.mode"
                @change="settings.set('fade.mode', $event.target.value)"
              >
                <option v-for="m in FADE_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
              </select>
            </label>

            <p class="group__note">
              当前行本身永远完全不透明；双语歌词的原文与翻译算作一行，一起淡出。
            </p>
          </template>
        </section>

        <!-- ============ 导出与打轴 ============ -->
        <section class="group">
          <h3 class="group__title">导出与打轴</h3>
          <div class="later">
            <button class="btn" type="button" @click="onOpenTapping">
              打开打轴模式
            </button>
            <button
              class="btn"
              type="button"
              data-tour="export-toggle"
              :aria-expanded="showExport"
              @click="showExport = !showExport"
            >
              导出
            </button>
          </div>

          <ExportPanel v-if="showExport" />
          <p class="group__note" style="margin-top: 8px">
            <template v-if="settings.persistAvailable">设置会自动保存在本机浏览器中。</template>
            <template v-else>当前浏览器不允许保存设置，刷新后会回到默认值。</template>
          </p>
        </section>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  /* 宽度取自全局变量：抽屉自身与"主内容避让量"共用同一个值 */
  width: var(--drawer-w);
  height: 100%;
  border-left: 1px solid var(--ui-border);
  background: var(--ui-panel);
  box-shadow: var(--ui-shadow);
}

.drawer__head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border);
}

.drawer__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.drawer__head-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.drawer__diag {
  color: var(--ui-accent);
  font-size: 12px;
}

.drawer__reset {
  font-size: 12px;
}

.drawer__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 12px 28px;
}

.group {
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border);
}

.group:last-child {
  border-bottom: none;
}

.group__title {
  margin: 0 0 10px;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.group__note {
  margin: 0;
  color: var(--ui-text-dim);
  font-size: 11px;
  line-height: 1.5;
}

.field {
  display: block;
  margin-bottom: 12px;
}

.field:last-child {
  margin-bottom: 0;
}

.field--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field__label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 5px;
  font-size: var(--ui-font-sm);
}

.field--row .field__label {
  margin-bottom: 0;
}

.field__value {
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  font-style: normal;
  font-variant-numeric: tabular-nums;
}

.field__control {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  font-size: var(--ui-font-sm);
}

input[type='range'].field__control {
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--ui-accent);
}

input[type='checkbox'] {
  width: 18px;
  height: 18px;
  accent-color: var(--ui-accent);
}

/* 可折叠的颜色项 */
.field__toggle {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  font-size: var(--ui-font-sm);
  text-align: left;
}

.field__chevron {
  flex: none;
  color: var(--ui-text-dim);
  font-size: 10px;
  transition: transform 160ms ease;
}

.field__chevron.is-open {
  transform: rotate(90deg);
}

.field__dot {
  flex: none;
  width: 18px;
  height: 18px;
  margin-left: auto;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
}

.field__panel {
  padding: 10px;
  margin-top: 6px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: color-mix(in srgb, var(--ui-panel-2) 60%, transparent);
}

.later {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.later .btn {
  font-size: 12px;
}

/* ── 自定义字体上传 ── */
.font-upload__input {
  display: none;
}

.font-upload {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.font-upload .btn {
  font-size: 12px;
}

/* 字体名可能很长（内部名带时间戳），截断并用 title 展示完整值 */
.font-upload__name {
  overflow: hidden;
  max-width: 160px;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.font-upload__note {
  margin: 4px 0 0;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  line-height: 1.45;
}
</style>
