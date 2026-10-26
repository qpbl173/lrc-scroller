<script setup>
/**
 * 歌词信息面板：显示解析结果、警告、编码信息，并提供 offset 实时调节。
 *
 * 这个面板是阶段 1 的"验收窗口"—— 解析器的所有行为（警告、丢弃行、编码回退、
 * offset 重算）都在这里可视化，用户不需要打开控制台就能判断歌词是否正确载入。
 *
 * offset 调节刻意放在这里（而不是设置抽屉）：它是**歌词文件属性**，
 * 不是视觉偏好；阶段 3 的设置面板只放外观相关的项。
 */
import { computed } from 'vue'
import { useLyricsStore } from '@/stores/lyricsStore'
import { formatTimeTag } from '@/core/timeUtils'

const lyrics = useLyricsStore()

/**
 * 直接读 store 里的 lastImport，而不是从 useLrcImport() 拿。
 * 后者每个组件各持一份局部状态，会导致这里的诊断区永远空白（已被 e2e 抓出过）。
 */
const lastImport = computed(() => lyrics.lastImport)

const collapsed = defineModel('collapsed', { type: Boolean, default: true })

const offsetValue = computed({
  get: () => lyrics.meta.offsetMs,
  set: (v) => lyrics.setOffset(Number(v)),
})

const LEVEL_LABEL = { info: '提示', warn: '注意', error: '错误' }

function nudgeOffset(delta) {
  lyrics.setOffset(lyrics.meta.offsetMs + delta)
}

function resetOffset() {
  lyrics.setOffset(0)
}

/** 预览前几行，方便肉眼确认时间是否正确 */
const preview = computed(() => lyrics.lines.slice(0, 6))

/** 同时间的多行组（双语）——只有存在这种组时才显示调换按钮 */
const bilingualGroups = computed(() => {
  const groups = []
  const lines0 = lyrics.lines
  let i = 0
  while (i < lines0.length) {
    let j = i
    while (j < lines0.length && lines0[j].t === lines0[i].t) j++
    if (j - i > 1) {
      const seg = lines0.slice(i, j)
      // 两行都非空才算真正的双语组（排除间奏空行凑数）
      if (seg.filter((l) => !l.empty).length >= 2) groups.push(seg)
    }
    i = j
  }
  return groups
})

const hasBilingual = computed(() => bilingualGroups.value.length > 0)
const bilingualCount = computed(() => bilingualGroups.value.length)

/** 一键调换：把同时间各行的正文互换 */
function onSwapBilingual() {
  lyrics.swapBilingualLines()
}

/**
 * 切换双语组的放大规则。
 *
 * auto 会交回解析器的内容判断，所以它需要重走一遍 offset 重算；
 * top / bottom 只是改 isTranslation 标记，直接重算即可。
 *
 * @param {"auto"|"top"|"bottom"} mode
 */
function onPrimaryMode(mode) {
  lyrics.setPrimaryMode(mode)
}
</script>

<template>
  <section class="info" :class="{ 'is-collapsed': collapsed }" aria-label="歌词信息">
    <button class="info__head" data-tour="lyrics-info" type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
      <span class="info__chevron" :class="{ 'is-open': !collapsed }" aria-hidden="true">▸</span>
      <span class="info__title">歌词信息</span>

      <span class="info__stats">
        <span>{{ lyrics.count }} 行</span>
        <span v-if="lyrics.droppedLines.length" class="info__stat-warn">
          跳过 {{ lyrics.droppedLines.length }}
        </span>
        <span v-if="lyrics.warnings.length" class="info__stat-warn">
          {{ lyrics.warnings.length }} 条提示
        </span>
        <span v-if="lyrics.meta.offsetMs !== 0" class="info__stat-offset">
          offset {{ lyrics.meta.offsetMs > 0 ? '+' : '' }}{{ lyrics.meta.offsetMs }}ms
        </span>
      </span>
    </button>

    <div v-show="!collapsed" class="info__body scroll-thin">
      <!-- 警告列表：解析器的所有提示都在这里，逐条可读 -->
      <div v-if="lyrics.warnings.length" class="info__block">
        <h3 class="info__label">解析提示</h3>
        <ul class="info__warnings">
          <li v-for="(w, i) in lyrics.warnings" :key="i" class="warn" :class="`warn--${w.level}`">
            <span class="warn__tag">{{ LEVEL_LABEL[w.level] ?? w.level }}</span>
            <div class="warn__text">
              <p class="warn__message">{{ w.message }}</p>
              <p v-if="w.detail" class="warn__detail">{{ w.detail }}</p>
              <p v-if="w.hint" class="warn__hint">{{ w.hint }}</p>
            </div>
          </li>
        </ul>
      </div>

      <!-- 被跳过的行：让用户知道"少了什么"，而不是静默丢弃 -->
      <div v-if="lyrics.droppedLines.length" class="info__block">
        <h3 class="info__label">没有时间标签的行（已跳过）</h3>
        <ul class="info__dropped">
          <li v-for="d in lyrics.droppedLines.slice(0, 8)" :key="d.line">
            <span class="info__lineno">第 {{ d.line }} 行</span>
            <span class="info__dropped-text">{{ d.text }}</span>
          </li>
        </ul>
        <p v-if="lyrics.droppedLines.length > 8" class="info__more">
          还有 {{ lyrics.droppedLines.length - 8 }} 行未列出
        </p>
      </div>

      <!-- offset 实时调节 -->
      <div v-if="lyrics.count > 0" class="info__block">
        <h3 class="info__label">
          整体偏移 (offset)
          <span class="info__hint-inline">正数 = 歌词提前</span>
        </h3>

        <div class="info__offset">
          <button class="btn btn--icon" type="button" aria-label="偏移减 100 毫秒" @click="nudgeOffset(-100)">−100</button>
          <input
            v-model.number="offsetValue"
            class="info__offset-input"
            type="number"
            step="10"
            aria-label="整体偏移毫秒"
          />
          <span class="info__unit">ms</span>
          <button class="btn btn--icon" type="button" aria-label="偏移加 100 毫秒" @click="nudgeOffset(100)">+100</button>
          <button class="btn btn--ghost" type="button" :disabled="lyrics.meta.offsetMs === 0" @click="resetOffset">
            归零
          </button>
        </div>

        <p class="info__note">
          修改偏移时，全部时间都从文件的<strong>原始时间</strong>重新计算，反复调整不会累积误差。
        </p>

        <!--
          双语歌词：放大哪一行可以自定义。

          【为什么需要】解析器按启发式挑「原文」（含中日韩文字优先），
          所以「英文原文 + 中文翻译」的文件会被判反 —— 原文被缩小。
          这里给两个入口：换规则（放大上行/下行）或换内容（调换上下行）。
        -->
        <div v-if="hasBilingual" class="info__block" data-tour="bilingual">
          <h3 class="info__label">
            双语歌词
            <span class="info__hint-inline">共 {{ bilingualCount }} 组</span>
          </h3>

          <div class="info__mode">
            <span class="info__mode-label">放大哪一行</span>
            <select class="info__select" :value="lyrics.primaryMode" @change="onPrimaryMode($event.target.value)">
              <option value="auto">自动判断（按内容）</option>
              <option value="top">放大上行</option>
              <option value="bottom">放大下行</option>
            </select>
          </div>

          <button class="info__swap-btn" type="button" @click="onSwapBilingual">
            调换上下行内容
          </button>

          <p class="info__note">
            <strong>放大上行/下行</strong>改的是规则：组内第一行或最后一行放大，与内容无关。
            <strong>调换上下行内容</strong>改的是数据：把正文互换，规则不变。
          </p>
        </div>
        <!-- 时间预览：改 offset 时这里会立刻变化，方便肉眼验证 -->
        <div class="info__preview">
          <div v-for="l in preview" :key="l.id" class="preview-row">
            <span class="preview-time">{{ formatTimeTag(l.t) }}</span>
            <span class="preview-tag" :title="`原始时间 ${formatTimeTag(l.rawT)}`">
              raw {{ formatTimeTag(l.rawT) }}
            </span>
            <span class="preview-text">{{ l.empty ? '（间奏）' : l.text }}</span>
          </div>
          <p v-if="lyrics.count > preview.length" class="info__more">
            仅预览前 {{ preview.length }} 行
          </p>
        </div>
      </div>

      <!-- 编码诊断 -->
      <div v-if="lastImport" class="info__block">
        <h3 class="info__label">文件诊断</h3>
        <dl class="info__dl">
          <dt>文件名</dt>
          <dd>{{ lastImport.name }}</dd>
          <dt>文件大小</dt>
          <dd>{{ (lastImport.bytes / 1024).toFixed(1) }} KB</dd>
          <dt>探测编码</dt>
          <dd>
            {{ lastImport.encoding.toUpperCase() }}
            <span v-if="lastImport.fellBack" class="info__tag">自动回退</span>
            <span v-else class="info__tag info__tag--ok">直接识别</span>
          </dd>
          <dt>判定依据</dt>
          <dd class="info__dd-wrap">{{ lastImport.reason }}</dd>
          <dt v-if="lyrics.stats.totalRows">原始行数</dt>
          <dd v-if="lyrics.stats.totalRows">{{ lyrics.stats.totalRows }}</dd>
          <dt v-if="lyrics.meta.length">音频长度标签</dt>
          <dd v-if="lyrics.meta.length">{{ formatTimeTag(lyrics.meta.length) }}</dd>
        </dl>
      </div>

      <!--
        歌词操作区。
        「恢复为内置示例歌词」必须**始终可用** —— 歌词清空后正是需要它的场景，
        所以它不能跟着别的按钮一起被 v-if 掉。
        （「导出 LRC」已移到导出面板，与「导出视频」并排。）
      -->
      <div class="info__actions">
        <button class="btn btn--ghost info__demo" type="button" @click="lyrics.loadDemo()">
          恢复为内置示例歌词
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.info {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 20;
  width: min(420px, 92vw);
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  border-bottom-right-radius: var(--ui-radius);
  background: color-mix(in srgb, var(--ui-panel) 96%, transparent);
  backdrop-filter: blur(8px);
}

.info__head {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  text-align: left;
}

.info__chevron {
  flex: none;
  color: var(--ui-text-dim);
  font-size: 10px;
  transition: transform 160ms ease;
}

.info__chevron.is-open {
  transform: rotate(90deg);
}

.info__title {
  flex: none;
  font-size: var(--ui-font-sm);
  font-weight: 600;
}

.info__stats {
  display: flex;
  flex: 1 1 auto;
  gap: 8px;
  justify-content: flex-end;
  color: var(--ui-text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.info__stat-warn {
  color: var(--ui-warn);
}

.info__stat-offset {
  color: var(--ui-accent);
}

.info__body {
  max-height: min(58vh, 520px);
  overflow-y: auto;
  padding: 0 12px 12px;
}

.info__block {
  padding: 10px 0;
  border-top: 1px solid var(--ui-border);
}

.info__label {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin: 0 0 8px;
  color: var(--ui-text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.info__hint-inline {
  color: var(--ui-text-dim);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  opacity: 0.8;
}

.info__warnings {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.warn {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-left: 2px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-panel-2);
}

.warn--info {
  border-left-color: var(--ui-accent);
}

.warn--warn {
  border-left-color: var(--ui-warn);
}

.warn--error {
  border-left-color: var(--ui-error);
}

.warn__tag {
  flex: none;
  padding-top: 1px;
  color: var(--ui-text-dim);
  font-size: 10px;
}

.warn__text {
  min-width: 0;
}

.warn__message {
  margin: 0;
  font-size: var(--ui-font-xs);
}

.warn__detail,
.warn__hint {
  margin: 3px 0 0;
  color: var(--ui-text-dim);
  font-size: 11px;
  line-height: 1.45;
}

.info__dropped {
  padding: 0;
  margin: 0;
  list-style: none;
}

.info__dropped li {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  font-size: 11px;
}

.info__lineno {
  flex: none;
  color: var(--ui-text-dim);
  font-variant-numeric: tabular-nums;
}

.info__dropped-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.info__more {
  margin: 6px 0 0;
  color: var(--ui-text-dim);
  font-size: 11px;
}

.info__offset {
  display: flex;
  gap: 6px;
  align-items: center;
}

.info__offset-input {
  width: 84px;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  font-size: var(--ui-font-sm);
  font-variant-numeric: tabular-nums;
}

.info__unit {
  color: var(--ui-text-dim);
  font-size: 11px;
}

.info__mode {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

.info__mode-label {
  color: var(--ui-text-dim);
  font-size: 11px;
  white-space: nowrap;
}

.info__select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  color: inherit;
  font-size: var(--ui-font-sm);
}

/*
  调换按钮做成圆角灰底：
  它原本是 btn--ghost（透明底），用户反馈「没看见」——
  双语区不是高频操作，但一旦需要就找不到，代价很高。
  给它一块实体底色，让它在面板里先被看见。
*/
.info__swap-btn {
  width: 100%;
  margin-top: 8px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  color: inherit;
  font-size: var(--ui-font-sm);
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.info__swap-btn:hover {
  background: var(--ui-panel-3, var(--ui-panel-2));
  border-color: var(--ui-accent, var(--ui-border));
}

.info__swap-btn:active {
  transform: translateY(1px);
}

.info__note {
  margin: 8px 0;
  color: var(--ui-text-dim);
  font-size: 11px;
  line-height: 1.5;
}

.info__preview {
  padding: 6px 8px;
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  font-size: 11px;
}

.preview-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 0;
}

.preview-time {
  flex: none;
  color: var(--ui-accent);
  font-variant-numeric: tabular-nums;
}

.preview-tag {
  flex: none;
  color: var(--ui-text-dim);
  font-size: 10px;
  opacity: 0.75;
}

.preview-text {
  overflow: hidden;
  color: var(--ui-text);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.info__dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  margin: 0;
  font-size: 11px;
}

.info__dl dt {
  color: var(--ui-text-dim);
}

.info__dl dd {
  margin: 0;
  word-break: break-all;
}

.info__dd-wrap {
  overflow-wrap: anywhere;
}

.info__tag {
  padding: 0 5px;
  margin-left: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-warn) 22%, transparent);
  color: var(--ui-warn);
  font-size: 10px;
}

.info__tag--ok {
  background: color-mix(in srgb, var(--ui-ok) 20%, transparent);
  color: var(--ui-ok);
}

.info__demo {
  margin-top: 0;
  font-size: 11px;
}

/* 导出区：按钮与示例按钮并排 */
.info__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 0;
  border-top: 1px solid var(--ui-border);
}

.info__actions .btn {
  font-size: 11px;
}

@media (width <= 640px) {
  .info {
    width: 100%;
    border-radius: 0;
  }
}
</style>
