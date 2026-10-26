<script setup>
/**
 * 播放条：播放/暂停、进度、时间、音量、倍速。
 *
 * 阶段 2 起接入真实音频引擎。要点：
 *  - 拖动进度条使用 beginScrub / scrubTo / endScrub 三段式，
 *    拖动中不碰 <audio>，松手才真正 seek → 跟手且无爆音、无回弹。
 *  - 无音频时同一个引擎走模拟时钟（需求 N1），UI 无需分支。
 */
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { usePlayerStore } from '@/stores/playerStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioEngine } from '@/composables/useAudioEngine'
import { useTappingShared } from '@/composables/useTapping'
import { attachPointerDrag } from '@/composables/pointerDrag'
import { formatClock } from '@/core/timeUtils'
import { CODES } from '@/core/errors'

const player = usePlayerStore()
const ui = useUiStore()
const engine = useAudioEngine()
// 单例：与 useKeyboard 共享同一份打轴状态
const tappingAPI = useTappingShared()
const tapping = tappingAPI.tapping

const { playing, currentTime, duration, volume, muted, rate, fileName, loading } = storeToRefs(player)

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

const seekRef = ref(/** @type {HTMLElement|null} */ (null))
const volumeRef = ref(/** @type {HTMLElement|null} */ (null))

const timeText = computed(() => formatClock(currentTime.value))
const durationText = computed(() => (duration.value > 0 ? formatClock(duration.value) : '--:--'))
const progressPercent = computed(() => `${(player.progress * 100).toFixed(3)}%`)
const volumePercent = computed(() => `${((muted.value ? 0 : volume.value) * 100).toFixed(1)}%`)

/** 打轴总行数（按**目标行数组**算：纯 txt 打无时间行，纯 lrc 打有时间行） */
const tappingTotal = computed(() => tapping.tapTarget.length)

/**
 * 要显示节拍序号的行的 beat；没有则 null。
 *
 * 【用 lastTappedIndex 而不是 editingIndex】
 * 打完一行后 editingIndex 会**前进到下一行**，那一行还没打、必然没有 beat，
 * 用它的话「第 N 拍」几乎永远不显示，功能等于没有。
 * 用户刚打完、想确认"吸到第几拍"的那一行是 lastTappedIndex。
 *
 * 三种情况都返回 null（整块不渲染）：
 *   未进打轴模式 / 还没打过任何行 / 那一行没吸附上（beat 为 null）
 */
const editingBeat = computed(() => {
  if (!tapping.enabled) return null
  const i = tapping.lastTappedIndex
  if (i < 0) return null
  const rec = tapping.tapped[i]
  if (!rec || rec.beat === null || rec.beat === undefined) return null
  return rec.beat
})

function onTogglePlay() {
  if (!player.canPlay) {
    ui.pushCode(CODES.AUDIO_NOT_LOADED)
    return
  }
  engine.toggle()
}

/**
 * 打轴模式开关（阶段 5 第 3 步）。
 *
 * 【提示文案统一由 useTapping.setEnabled 负责，这里不再推 toast】
 * 进入时它可能要报"歌词已更换，草稿已重置"，
 * 退出时它要报"已打 N 行草稿（已自动保存）"——
 * 那两条都需要读 store 里的最新状态，只有它知道。
 * 如果这里再推一条"已进入/已退出"，用户会看到两条重复提示。
 */
function onToggleTapping() {
  tappingAPI.toggle()
}

/** 把打轴结果应用到歌词（阶段 5 应用出口） */
function onApplyTapping() {
  tappingAPI.apply()
}

// ── 逐字打轴（增强 LRC）──────────────────────

/**
 * 逐字模式开关。
 *
 * 【与「打轴」按钮并列，而不是二合一】
 * 两套草稿是并存的（先逐行打完时间轴，再挑几行逐字精修），
 * 合成一个按钮的话，用户切模式就会以为前一份草稿被丢了。
 * 两个独立开关能把这个事实直接摆在界面上。
 */
function onToggleChar() {
  tappingAPI.toggleChar()
}

function onApplyChars() {
  tappingAPI.applyChars()
}

/** 逐字模式下 ←/→ 挪光标（按钮版，供触摸设备用） */
function onCharStep(dir) {
  tappingAPI.charStepCursor(dir)
}

/** 逐字倍速：只在 0.5/0.75/1/1.25/1.5 五档里循环 */
function cycleCharRate() {
  tappingAPI.cycleCharRate(1)
}

/** 当前逐字行的字表长度（未拆字时为 0） */
const charLineTotal = computed(() => tapping.charChars.length)

/** 当前行内已打字数 */
const charLineTimed = computed(() => tapping.charTimedCount)

/** 逐字可应用的行数（每个字都有时间才算完整） */
const charApplicableCount = computed(() => {
  const drafts = tapping.charDraft
  let n = 0
  for (const key of Object.keys(drafts)) {
    const chars = drafts[key]
    if (!Array.isArray(chars) || chars.length === 0) continue
    if (chars.every((ch) => ch && Number.isFinite(ch.t))) n++
  }
  return n
})

// ── 进度条：三段式拖动 ──────────────────────────
/**
 * 开启一次进度条拖动会话。
 *
 * 抽成独立函数是为了给「pointercancel 后无感续接」复用：
 * 取消后若用户在 200ms 内继续移动指针，onResume 会以那个事件为起点
 * 重新调用本函数 → 无缝继续拖动，用户感觉不到浏览器抢过一次指针。
 * @param {PointerEvent} e
 */
function startSeekDrag(e) {
  const el = /** @type {HTMLElement} */ (e.currentTarget ?? e.target)
  engine.beginScrub()
  attachPointerDrag(e, {
    el,
    label: '进度条',
    onMove: (ratio) => engine.scrubTo(ratio * duration.value),
    // ratio 为 undefined 表示松手/取消时坐标不可用 → 沿用当前位置，不要跳变
    onEnd: (ratio) => engine.endScrub(typeof ratio === 'number' ? ratio * duration.value : undefined),
    // 防卡死：取消后 200ms 内继续移动 → 无感续接
    onResume: (ev) => startSeekDrag(/** @type {PointerEvent} */ (ev)),
  })
}

function onSeekPointerDown(e) {
  if (duration.value <= 0) return
  startSeekDrag(e)
}

/** 键盘可访问：方向键精调进度（1%，Shift 为 5%） */
function onSeekKeydown(e) {
  if (duration.value <= 0) return
  const step = (e.shiftKey ? 0.05 : 0.01) * duration.value
  if (e.key === 'ArrowLeft') engine.seek(currentTime.value - step)
  else if (e.key === 'ArrowRight') engine.seek(currentTime.value + step)
  else if (e.key === 'Home') engine.seek(0)
  else if (e.key === 'End') engine.seek(duration.value)
  else return
  e.preventDefault()
}

// ── 音量 ───────────────────────────────────────
function onVolumePointerDown(e) {
  const el = /** @type {HTMLElement} */ (e.currentTarget)
  attachPointerDrag(e, {
    el,
    label: '音量',
    onMove: (ratio) => engine.setVolume(ratio),
    onEnd: (ratio) => {
      // 音量没有"拖动中/落点"之分，移动时即已生效。
      // 这里只处理坐标有效的情况；undefined 表示取消或坐标不可用，保持现状。
      if (typeof ratio === 'number' && Number.isFinite(ratio)) engine.setVolume(ratio)
    },
  })
}

function onVolumeKeydown(e) {
  const step = e.shiftKey ? 0.1 : 0.05
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') engine.setVolume(volume.value - step)
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') engine.setVolume(volume.value + step)
  else return
  e.preventDefault()
}

function cycleRate() {
  const i = RATES.indexOf(rate.value)
  engine.setRate(RATES[(i + 1) % RATES.length])
}
</script>

<template>
  <footer class="playerbar">
    <!-- 播放/暂停 -->
    <button
      class="playerbar__play"
      type="button"
      :aria-label="playing ? '暂停' : '播放'"
      :aria-pressed="playing"
      @click="onTogglePlay"
    >
      <svg v-if="loading" class="playerbar__spin" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="30 20" />
      </svg>
      <svg v-else-if="!playing" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M8 5.5v13l11-6.5z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
      </svg>
    </button>

    <!-- 打轴模式开关（阶段 5 第 3 步） -->
    <button
      class="playerbar__tap"
      :class="{ 'is-on': tapping.enabled }"
      type="button"
      data-tour="tap"
      :aria-label="tapping.enabled ? '退出打轴模式' : '进入打轴模式'"
      :aria-pressed="tapping.enabled"
      title="打轴模式：空格给歌词打时间点（快捷键 T）"
      @click="onToggleTapping"
    >
      打轴
    </button>

    <!-- 应用到歌词（阶段 5 应用出口）：只在打轴模式下显示 -->
    <button
      v-if="tapping.enabled"
      class="playerbar__tap playerbar__apply"
      type="button"
      :disabled="tapping.tappedCount === 0"
      :title="
        tapping.tappedCount === 0
          ? '还没有打任何时间点'
          : `把已打的 ${tapping.tappedCount} 行时间合并到歌词`
      "
      @click="onApplyTapping"
    >
      应用到歌词
    </button>

    <!-- 逐字打轴开关（增强 LRC）。与「打轴」并列：两套草稿并存 -->
    <button
      class="playerbar__tap playerbar__char"
      :class="{ 'is-on': tapping.charMode }"
      type="button"
      :aria-label="tapping.charMode ? '退出逐字打轴' : '进入逐字打轴'"
      :aria-pressed="tapping.charMode"
      title="逐字打轴：空格给当前字打时间点（标点跟随前一个字）"
      @click="onToggleChar"
    >
      逐字
    </button>

    <!--
      逐字模式下的操作条：倍速 + 光标 + 进度。
      整块只在逐字模式显示 —— 非逐字时它一个字的信息都没有，
      留着只会把播放条挤满（窄屏尤其明显）。
    -->
    <template v-if="tapping.charMode">
      <button
        class="playerbar__tap playerbar__char-rate"
        type="button"
        :aria-label="`逐字打轴倍速 ${rate} 倍，点击切换`"
        title="逐字打轴倍速（只用 0.5/0.75/1/1.25/1.5，慢速更好跟）"
        @click="cycleCharRate"
      >
        {{ rate }}×
      </button>

      <button
        class="playerbar__tap playerbar__char-step"
        type="button"
        aria-label="光标退一个字"
        title="← 光标退一个字（重打打错的字）"
        @click="onCharStep(-1)"
      >
        ←
      </button>
      <button
        class="playerbar__tap playerbar__char-step"
        type="button"
        aria-label="光标进一个字"
        title="→ 光标进一个字"
        @click="onCharStep(1)"
      >
        →
      </button>

      <button
        v-if="charApplicableCount > 0"
        class="playerbar__tap playerbar__apply"
        type="button"
        :title="`把 ${charApplicableCount} 行的完整逐字时间应用到歌词`"
        @click="onApplyChars"
      >
        应用逐字
      </button>
    </template>

    <!--
      "打轴中"标记。
      需求明确要求开启后有可见标记 —— 否则用户忘了自己开着模式，
      按空格没反应会以为功能坏了。
      同时显示进度（第几行 / 共几行），打轴时能知道还剩多少。
      （本轮只做行为断言，几何断言第 7 步统一补）

      totalCount === 0（没有任何行可打）时**不显示 "1/0"** ——
      那个数字自相矛盾：既说"第 1 行"又说"共 0 行"。
      纯 .txt 打不了轴的 bug 修好后这种情况已很少，
      但"空文件进打轴模式"仍会走到这里，所以必须处理。
    -->
    <span v-if="tapping.enabled" class="playerbar__tapping" role="status">
      <template v-if="tappingTotal > 0">打轴中 {{ tapping.editingIndex + 1 }}/{{ tappingTotal }}</template>
      <template v-else>打轴中 · 无行可打</template>
    </span>

    <!--
      当前编辑行的节拍序号（吸附命中时才有）。
      只在打轴模式 + 该行已打 + 吸附命中时显示，其余情况整块不渲染。
    -->
    <span v-if="editingBeat !== null" class="playerbar__beat">
      第 {{ editingBeat + 1 }} 拍
    </span>

    <!--
      逐字进度标记：第几行 / 共几行 + 行内已打字数。
      与逐行的「打轴中 N/M」并列存在时可能同时出现（两套草稿并存），
      所以文案必须能区分，不能都叫"打轴中"。
    -->
    <span v-if="tapping.charMode" class="playerbar__tapping playerbar__char-progress" role="status">
      <template v-if="charLineTotal > 0">
        逐字 {{ tapping.charLineIndex + 1 }}/{{ tappingTotal }} · {{ charLineTimed }}/{{ charLineTotal }} 字
      </template>
      <template v-else>逐字 · 该行无字可打</template>
    </span>

    <span class="playerbar__time">{{ timeText }}</span>

    <!-- 进度条 -->
    <div
      ref="seekRef"
      class="playerbar__seek"
      role="slider"
      tabindex="0"
      aria-label="播放进度"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(duration)"
      :aria-valuenow="Math.round(currentTime)"
      :aria-valuetext="`${timeText} / ${durationText}`"
      :aria-disabled="duration <= 0"
      @pointerdown="onSeekPointerDown"
      @keydown="onSeekKeydown"
    >
      <div class="playerbar__seek-track">
        <div class="playerbar__seek-fill" :style="{ width: progressPercent }" />
        <div class="playerbar__seek-knob" :style="{ left: progressPercent }" />
      </div>
    </div>

    <span class="playerbar__time">{{ durationText }}</span>

    <!-- 音量 -->
    <button
      class="btn btn--ghost btn--icon"
      type="button"
      :aria-label="muted ? '取消静音' : '静音'"
      :aria-pressed="muted"
      @click="engine.toggleMute()"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="currentColor" d="M4 9h3l4-3.5v13L7 15H4z" />
        <path v-if="!muted && volume > 0" fill="currentColor" d="M14.5 8.5a4 4 0 0 1 0 7v-1.6a2.4 2.4 0 0 0 0-3.8z" />
        <path
          v-if="muted || volume === 0"
          fill="currentColor"
          d="M15.2 9.6l1.1 1.1-1.6 1.6 1.6 1.6-1.1 1.1-1.6-1.6-1.6 1.6-1.1-1.1 1.6-1.6-1.6-1.6 1.1-1.1 1.6 1.6z"
        />
      </svg>
    </button>

    <div
      ref="volumeRef"
      class="playerbar__volume"
      role="slider"
      tabindex="0"
      aria-label="音量"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="Math.round((muted ? 0 : volume) * 100)"
      @pointerdown="onVolumePointerDown"
      @keydown="onVolumeKeydown"
    >
      <div class="playerbar__seek-track">
        <div class="playerbar__seek-fill" :style="{ width: volumePercent }" />
        <div class="playerbar__seek-knob" :style="{ left: volumePercent }" />
      </div>
    </div>

    <!--
      倍速。
      逐字模式下换成上面那个 char-rate 按钮：播放器的档位含 2x，
      而 2x 打逐字根本跟不上，两个按钮同时存在还会互相打架
      （点一个换档，另一个的显示跟着变，用户会以为点错了）。
    -->
    <button
      v-if="!tapping.charMode"
      class="btn btn--ghost btn--icon playerbar__rate"
      type="button"
      aria-label="播放速度"
      @click="cycleRate"
    >
      {{ rate }}×
    </button>

    <!-- 模式标识：明确当前是模拟时钟还是真实音频 -->
    <span v-if="player.isSimulated" class="playerbar__hint" title="未导入音频，正在用内置时钟按歌词时间轴走">
      模拟时钟
    </span>
    <span v-else-if="fileName" class="playerbar__filename" :title="fileName">{{ fileName }}</span>
  </footer>
</template>

<style scoped>
.playerbar {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 0 14px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-panel);
}

.playerbar__play {
  display: grid;
  flex: none;
  place-items: center;
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 50%;
  background: var(--ui-accent);
  color: #fff;
  transition: background 140ms ease, transform 100ms ease;
}

.playerbar__play:hover {
  background: var(--ui-accent-hover);
}

/* 打轴模式开关（阶段 5 第 3 步） */
.playerbar__tap {
  flex: none;
  padding: 4px 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  color: var(--ui-text-dim);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}

.playerbar__tap:hover {
  color: var(--ui-text);
}

/* 开启态：必须一眼看出"现在空格不是播放/暂停" */
.playerbar__tap.is-on {
  border-color: var(--ui-accent);
  background: color-mix(in srgb, var(--ui-accent) 22%, transparent);
  color: var(--ui-accent);
}

/* 「应用到歌词」：实心强调，是本模式的主要出口 */
.playerbar__apply {
  border-color: var(--ui-accent);
  background: var(--ui-accent);
  color: #fff;
}

.playerbar__apply:hover:not(:disabled) {
  background: var(--ui-accent-hover);
  color: #fff;
}

.playerbar__apply:disabled {
  border-color: var(--ui-border);
  background: var(--ui-panel-2);
  color: var(--ui-text-dim);
  opacity: 0.6;
  cursor: not-allowed;
}

/* "打轴中"进度标记 */
.playerbar__tapping {
  flex: none;
  color: var(--ui-accent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ── 逐字打轴（增强 LRC）────────────────── */

/*
 * 逐字开关与逐行开关长得一样（复用 .playerbar__tap），
 * 只加一个色相区分：逐字是"更细的一层"，用青色而不是强调蓝，
 * 免得用户把两个按钮看串（它们紧挨着）。
 */
.playerbar__char.is-on {
  border-color: #2ec4b6;
  background: color-mix(in srgb, #2ec4b6 22%, transparent);
  color: #2ec4b6;
}

/* 逐字模式下的倍速与光标按钮：比开关更窄，不抢视觉重心 */
.playerbar__char-rate,
.playerbar__char-step {
  padding: 4px 7px;
  font-variant-numeric: tabular-nums;
}

.playerbar__char-step {
  min-width: 26px;
  text-align: center;
}

/* 逐字进度标记：与逐行进度同色，但内容不同（字数 vs 行数） */
.playerbar__char-progress {
  color: #2ec4b6;
}

/* 当前编辑行的节拍序号 */
.playerbar__beat {
  flex: none;
  color: var(--lrc-color-tapped);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.playerbar__play:active {
  transform: scale(0.94);
}

.playerbar__spin {
  animation: lrc-pulse 1s linear infinite;
}

@media (pointer: coarse) {
  /* 触摸设备放大播放键，保证 ≥44px 可点区域（本元素不是 .btn，需单独声明） */
  .playerbar__play {
    width: 44px;
    height: 44px;
  }

  /* 打轴开关同理：触摸设备上的可点区域不得小于 44px */
  .playerbar__tap {
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
}

.playerbar__time {
  flex: none;
  min-width: 42px;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.playerbar__seek {
  flex: 1 1 auto;
  min-width: 60px;
  padding: 8px 0;
  cursor: pointer;
  touch-action: none; /* 拖动进度条时不要触发页面滚动 */
  /* 纵深防御：即使 pointerdown 的 preventDefault 失效，
     也不给浏览器留下"从这里可以开始文本选择拖拽"的机会。
     这是"快速拖动后第二次卡死"问题的第四层保护。 */
  user-select: none;
  -webkit-user-select: none;
}

.playerbar__volume {
  flex: none;
  width: 84px;
  padding: 8px 0;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.playerbar__seek-track {
  position: relative;
  height: 5px;
  border-radius: 999px;
  background: var(--ui-panel-2);
}

.playerbar__seek-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--ui-accent);
}

.playerbar__seek-knob {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgb(0 0 0 / 40%);
  transform: translate(-50%, -50%);
  transition: transform 120ms ease;
}

.playerbar__seek:hover .playerbar__seek-knob,
.playerbar__volume:hover .playerbar__seek-knob {
  transform: translate(-50%, -50%) scale(1.15);
}

.playerbar__rate {
  flex: none;
  min-width: 46px;
  font-variant-numeric: tabular-nums;
}

.playerbar__hint {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  color: var(--ui-text-dim);
  font-size: 11px;
}

.playerbar__filename {
  flex: 0 1 auto;
  max-width: 160px;
  overflow: hidden;
  color: var(--ui-text-dim);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

@media (width <= 640px) {
  .playerbar {
    gap: 6px;
    padding: 0 8px;
  }

  .playerbar__volume,
  .playerbar__hint,
  .playerbar__filename {
    display: none;
  }

  /*
   * 窄屏隐藏打轴开关与「打轴中」标记。
   *
   * 【为什么窄屏要藏起来，而不是缩小】
   * 播放条在 375px 下已经排得很满（播放键 + 时间 + 进度 + 倍速 + 文件名）。
   * 加上打轴按钮后整条会横向溢出（实测 13px）——
   * 而"打轴中"这个标记在窄屏上也没地方放，会把进度条挤扁。
   * 窄屏用户仍可以用 T 快捷键切换打轴模式，功能不受影响。
   */
  .playerbar__tap,
  .playerbar__tapping {
    display: none;
  }

  /*
   * 窄屏同样藏掉逐字那一组（开关/倍速/光标/应用/进度）。
   * 理由与上面一致：播放条在 375px 下已经溢出。
   * 逐字仍可用快捷键（T 切逐行、逐字开关走设置抽屉），
   * 功能不受影响；应用逐字这一步窄屏上确实没有按钮入口，
   * 这是有意的取舍 —— 逐字精修本来就不适合手机屏。
   */
  .playerbar__char,
  .playerbar__char-rate,
  .playerbar__char-step,
  .playerbar__char-progress {
    display: none;
  }
}
</style>
