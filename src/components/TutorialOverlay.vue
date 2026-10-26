<script setup>
/**
 * 新手教程遮罩。
 *
 * 【实现方式：聚光灯挖洞，而不是"高亮框"】
 * 在目标元素上盖一个 `box-shadow: 0 0 0 9999px rgba(0,0,0,.6)` 的定位层：
 * 阴影本身把四周压暗，元素中间天然是"洞"。
 * 相比"四个遮罩块拼一个矩形"，这种做法在窗口缩放、目标移动时都不会漏缝。
 *
 * 【坐标必须逐帧跟随】
 * 设置抽屉滑出有 220ms 动画、窗口可缩放、字体加载后行高还会变，
 * 所以不能只在打开时测一次。这里同时用：
 *   - ResizeObserver 观察目标（尺寸变化）
 *   - 短时 rAF 轮询（位置变化，抽屉滑出属于这种）
 * 两者都便宜，且远比自己算动画曲线可靠。
 *
 * 【目标找不到时降级】
 * 第 4 步的目标藏在抽屉里，用户没打开抽屉时选择器会落空。
 * 此时**居中显示气泡**并提示用户"请先点设置"，而不是报错或卡住。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { useTutorialShared } from '@/composables/useTutorial'
import { tutorialKeyAction } from '@/core/tutorial'

const tut = useTutorialShared()

const rootRef = ref(/** @type {HTMLElement|null} */ (null))
/** 目标元素的视口矩形；null 表示没找到目标（降级为居中气泡） */
const rect = ref(/** @type {{top:number,left:number,width:number,height:number}|null} */ (null))
/**
 * 实际命中的目标选择器。
 *
 * 【为什么需要知道"命中哪一个"】
 * 第 4 步的候选是 [导出视频, 导出(分区), 设置]。
 * 抽屉没开时只有「设置」可见 —— 此时高亮了设置，
 * 但**必须额外告诉用户"点开它，再点导出"**，否则用户只看到一个
 * 孤零零的"设置"被框住，不知道教程想让他干什么。
 * 而抽屉开着时命中的是真正的"导出视频"，就不该再提示"请先点设置"。
 */
const hitSelector = ref(/** @type {string|null} */ (null))

/**
 * 正文。
 *
 * 【为什么要按视口取舍】
 * 某些步骤在窄屏上目标会被 CSS 收起（播放条的「打轴」按钮就是这样，
 * 见 PlayerBar 的 640px 断点）。此时原文案「点播放条上的打轴」
 * 会让用户对着一个不存在的按钮找半天。
 * 步骤里可以给一份 `narrowBody` 作为替代说法。
 */
const bodyText = computed(() => {
  const s = step.value
  if (!s) return ''
  // 目标不可见（被 CSS 收起）且有替代文案时，用替代文案
  if (usingFallbackTarget.value && s.narrowBody) return s.narrowBody
  return s.body
})

/**
 * 首选目标是否在当前视口下不可见。
 * 用于判断"是不是被窄屏的 CSS 收起来了"。
 */
const usingFallbackTarget = computed(() => {
  const list = step.value?.targets ?? []
  // 单目标且没找到 → 说明被隐藏了
  return list.length === 1 && rect.value === null
})

/**
 * 兜底引导文案 —— 按**实际命中的那个选择器**给不同的话。
 *
 * 【为什么要分情况】
 * 第 4 步的候选链是 [导出视频 → 导出(分区) → 设置]，
 * 用户所处的阶段不同，需要做的动作也不同：
 *   - 命中「设置」   → 还没开抽屉，要说"先点开设置"
 *   - 命中「导出」   → 抽屉开了但分区没展开，要说"再点一下导出展开"
 * 统一成一句话会出现"让你点设置，可设置明明已经开了"的错乱感。
 *
 * 返回空串表示命中的就是首选目标（不需要补充引导）。
 */
const fallbackHint = computed(() => {
  const list = step.value?.targets ?? []
  // 只有"多候选 + 命中的不是首选"才算兜底
  if (!hitSelector.value || list.length <= 1 || hitSelector.value === list[0]) return ''
  switch (hitSelector.value) {
    case '[data-tour="settings"]':
      return '请先点开被框住的「设置」按钮，教程会继续指引里面的入口。'
    case '[data-tour="export-toggle"]':
      return '再点一下被框住的「导出」按钮展开面板，就能看到「导出视频」。'
    case '[data-tour="lyrics-info"]':
      return '先点一下被框住的「歌词信息」展开面板，双语歌词的调换按钮就在里面。'
    default:
      return ''
  }
})

const step = computed(() => tut.current())
const stepNo = computed(() => tut.index.value + 1)
const isLast = computed(() => tut.index.value >= tut.total - 1)

/** 聚光灯内边距：让高亮区域比元素本身稍大，视觉上更"包得住" */
const PAD = 6

/**
 * 找到当前步骤要指向的元素。
 * targets 是候选列表，取第一个**真实存在且可见**的 ——
 * 抽屉关着时里面的按钮虽然存在于 DOM，但尺寸为 0，必须排除。
 * @returns {{el:HTMLElement, selector:string}|null}
 */
function findTarget() {
  const list = step.value?.targets ?? []
  for (const sel of list) {
    const el = document.querySelector(sel)
    if (!(el instanceof HTMLElement)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return { el, selector: sel }
  }
  return null
}

/**
 * 把目标滚动到可见区域内。
 *
 * 【为什么必须有这一步 —— 像素与截图都证实过的真实问题】
 * 第 4 步的目标在设置抽屉里，而抽屉是可滚动的（`overflow-y: auto`），
 * 「导出」分区正好在**首屏之下**。实测 rect.top ≈ 2181px，
 * 而视口只有约 850px —— 聚光灯画在屏幕外，
 * 用户看到的是"教程说要点导出，可我什么都看不到"。
 *
 * 【为什么自己算而不用 scrollIntoView({block:'center'})】
 * scrollIntoView 会连带滚动**所有**可滚动的祖先，在 fixed 布局的抽屉里
 * 有时会把整页也带偏；而且它的滚动是即时的，聚光灯的过渡会与它打架。
 * 这里只处理"最近的可滚动祖先"，语义明确、可控。
 *
 * @param {HTMLElement} el
 */
function scrollTargetIntoView(el) {
  let node = el.parentElement
  while (node && node !== document.body) {
    const cs = getComputedStyle(node)
    const scrollable = /(auto|scroll|overlay)/.test(cs.overflowY)
    if (scrollable && node.scrollHeight > node.clientHeight + 1) {
      const nr = node.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      // 已经在可视范围内就不动它（避免每次换步都跳一下）
      if (er.top >= nr.top && er.bottom <= nr.bottom) return
      // 让目标大致居中：接近 scrollIntoView({block:'center'}) 的效果
      const delta = er.top + er.height / 2 - (nr.top + nr.height / 2)
      node.scrollTop += delta
      return
    }
    node = node.parentElement
  }
  /*
   * 没有可滚动的祖先时退回视口滚动（例如目标在长页面里）。
   * 先判断是否真的在视口外，避免无谓跳动。
   */
  const r = el.getBoundingClientRect()
  if (r.top < 0 || r.bottom > window.innerHeight) {
    el.scrollIntoView?.({ block: 'center' })
  }
}

/**
 * 重新测量目标位置。
 *
 * 【为什么值没变就不写回】
 * 这个函数被 rAF 逐帧调用（要跟住抽屉滑出的动画）。
 * 若每帧都写一个新对象，Vue 会以为依赖变了、每帧重跑一次渲染；
 * 更糟的是 `.tut__spot` 上有 `transition: top 160ms`，
 * 逐帧写入会不断重置过渡，聚光灯反而抖。
 * 只在数值真的变化时才写回，动画交给 CSS 过渡去补间。
 */
function syncRect() {
  const hit = findTarget()
  if (!hit) {
    if (rect.value !== null) rect.value = null
    if (hitSelector.value !== null) hitSelector.value = null
    return
  }
  if (hitSelector.value !== hit.selector) hitSelector.value = hit.selector

  const r = hit.el.getBoundingClientRect()
  const cur = rect.value
  // 亚像素变化不写回：1/3 像素的抖动肉眼不可见，却足以触发渲染
  if (
    cur &&
    Math.abs(cur.top - r.top) < 0.34 &&
    Math.abs(cur.left - r.left) < 0.34 &&
    Math.abs(cur.width - r.width) < 0.34 &&
    Math.abs(cur.height - r.height) < 0.34
  ) {
    return
  }
  rect.value = { top: r.top, left: r.left, width: r.width, height: r.height }
}

/**
 * 短时 rAF 轮询，覆盖"目标位置在动"的场景（抽屉滑出、窗口缩放）。
 * 只在教程打开期间跑，关闭立刻停 —— 不做常驻轮询。
 */
let rafId = 0
function startTracking() {
  stopTracking()
  const tick = () => {
    syncRect()
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
}
function stopTracking() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

let ro = null
let observed = null
function observeTarget() {
  if (typeof ResizeObserver === 'undefined') return
  if (!ro) ro = new ResizeObserver(() => syncRect())
  const hit = findTarget()
  const el = hit?.el ?? null
  if (el === observed) return
  if (observed) ro.unobserve(observed)
  observed = el
  if (el) ro.observe(el)
}

/** 高亮洞的样式 */
const spotStyle = computed(() => {
  const r = rect.value
  if (!r) return { display: 'none' }
  return {
    top: `${r.top - PAD}px`,
    left: `${r.left - PAD}px`,
    width: `${r.width + PAD * 2}px`,
    height: `${r.height + PAD * 2}px`,
  }
})

/**
 * 气泡位置。
 *
 * 【为什么用 fixed + 计算好的坐标，而不是 CSS 锚点】
 * 目标可能贴在视口顶部（顶栏）或底部（播放条），
 * 单纯"目标下方居中"会跑出视口。这里把气泡夹在视口内，
 * 上下空间都不够时退化为居中。
 */
const BUBBLE_W = 380
const BUBBLE_GAP = 14

const bubbleStyle = computed(() => {
  const r = rect.value
  if (!r) return {} // 降级：交给 CSS 居中
  const vw = window.innerWidth
  const vh = window.innerHeight

  // 水平：优先与目标左对齐，但夹在视口内
  let left = r.left + r.width / 2 - BUBBLE_W / 2
  left = Math.max(12, Math.min(left, vw - BUBBLE_W - 12))

  const spaceBelow = vh - (r.top + r.height)
  const place = step.value?.place ?? 'bottom'
  // 期望位置放不下就翻到另一侧
  let top
  if (place === 'top' || spaceBelow < 220) {
    top = r.top - BUBBLE_GAP
    return { left: `${left}px`, bottom: `${Math.max(12, vh - top)}px`, width: `${BUBBLE_W}px` }
  }
  top = r.top + r.height + BUBBLE_GAP
  return { left: `${left}px`, top: `${top}px`, width: `${BUBBLE_W}px` }
})

/** 是否处于"没找到目标"的降级状态 */
const degraded = computed(() => rect.value === null)

// 换步时：先滚动到目标，再测量并重新观察
watch(
  () => tut.index.value,
  async () => {
    rect.value = null
    hitSelector.value = null
    await nextTick()
    const hit = findTarget()
    if (hit) scrollTargetIntoView(hit.el)
    // 等一帧让滚动生效后再测量，否则量到的是滚动前的位置
    await new Promise((r) => requestAnimationFrame(r))
    syncRect()
    observeTarget()
  },
)

/*
 * 目标本身变了也要滚进视野。
 *
 * 典型场景：第 4 步进行中，用户按提示打开了设置抽屉，
 * 有效目标从「设置」变成抽屉深处的「导出」—— 而它在首屏之下。
 * 不滚过去的话，聚光灯画在屏幕外，用户完全看不到高亮。
 *
 * 只在**选择器换了**时触发，所以不会跟用户自己的滚动打架。
 */
watch(hitSelector, async (sel) => {
  if (!sel || !tut.active.value) return
  await nextTick()
  const hit = findTarget()
  if (hit) scrollTargetIntoView(hit.el)
  // 等滚动落定再测一次，聚光灯的过渡会平滑补上这一跳
  await new Promise((r) => requestAnimationFrame(r))
  syncRect()
  observeTarget()
})

watch(
  () => tut.active.value,
  (on) => {
    if (on) {
      syncRect()
      observeTarget()
      startTracking()
    } else {
      stopTracking()
      if (ro && observed) ro.unobserve(observed)
      observed = null
      rect.value = null
    }
  },
)

/**
 * 判断事件是否发生在可输入元素上。
 *
 * 【为什么教程也要做这个判断】
 * 第 3 步会引导用户打开设置面板，那里有 HEX 输入框。
 * 用户在里面打字时按 ←/→ 应该是在**移动光标**，
 * 若被教程抢去翻页（还 preventDefault），光标就动不了 —— 很别扭。
 * 所以输入状态下一律不拦，让按键回到输入框。
 *
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

/** 键盘：教程进行中独占（useKeyboard 会让位，见那里的说明） */
function onKeydown(e) {
  if (!tut.active.value) return
  // 正在输入框里打字 —— 把按键还给输入框
  if (isTypingTarget(e.target)) return
  const action = tutorialKeyAction(e.key, { shiftKey: e.shiftKey })
  if (!action) return
  // 必须阻止默认行为：否则 ←/→ 会同时快进、空格会同时打轴/播放
  e.preventDefault()
  e.stopPropagation()
  if (action === 'next') tut.next()
  else if (action === 'prev') tut.prev()
  else tut.close()
}

/** 点遮罩空白处不关闭（避免误触丢失进度），只由按钮/Esc 关闭 */

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  // 目标位置可能因窗口缩放改变（rAF 轮询已覆盖，这里补一次立即同步）
  window.addEventListener('resize', syncRect)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', syncRect)
  stopTracking()
  ro?.disconnect()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="tut">
      <div v-if="tut.active.value" ref="rootRef" class="tut" role="dialog" aria-modal="true"
        :aria-label="`新手教程，第 ${stepNo} 步，共 ${tut.total} 步`">
        <!-- 压暗层：点它不关闭（防止误触丢失进度） -->
        <div class="tut__scrim" />

        <!-- 聚光灯：用超大 box-shadow 把四周压暗，中间留洞 -->
        <div class="tut__spot" :style="spotStyle" aria-hidden="true" />

        <!-- 气泡 -->
        <div class="tut__bubble" :class="{ 'is-center': degraded }" :style="bubbleStyle">
          <div class="tut__head">
            <span class="tut__stepno">{{ stepNo }} / {{ tut.total }}</span>
            <button class="tut__close" type="button" aria-label="关闭教程" @click="tut.close()">✕</button>
          </div>

          <h2 class="tut__title">{{ step.title }}</h2>
          <p class="tut__body">{{ bodyText }}</p>

          <!-- 快捷键表（第 2 步） -->
          <ul v-if="step.keys" class="tut__keys">
            <li v-for="k in step.keys" :key="k[0]" class="tut__key-row">
              <kbd class="tut__kbd">{{ k[0] }}</kbd>
              <span class="tut__key-desc">{{ k[1] }}</span>
            </li>
          </ul>

          <!-- 强调提示（第 2 步的"暂停要用鼠标"） -->
          <p v-if="step.warn" class="tut__warn">{{ step.warn }}</p>
          <p v-if="step.hint" class="tut__hint">{{ step.hint }}</p>

          <!--
            只找到兜底目标时的补充引导。
            第 4 步的目标藏在设置抽屉里：用户没打开抽屉时，
            高亮只能落在「设置」上 —— 必须说清楚"点它、再点导出"，
            否则用户只看到一个被框住的「设置」，不知道下一步做什么。
          -->
          <p v-if="fallbackHint" class="tut__hint">{{ fallbackHint }}</p>
          <!--
            完全找不到目标时的兜底说明。
            但如果这个步骤已经因为窄屏换用了 narrowBody（那段文案本身
            就解释了"按钮收起了、改用快捷键"），就不要再叠一句，
            否则同一件事说两遍，气泡又长又啰嗦。
          -->
          <p v-else-if="degraded && !(usingFallbackTarget && step.narrowBody)" class="tut__hint">
            这一步的目标暂时不可见，你可以先继续，稍后在界面里找到对应入口。
          </p>

          <div class="tut__actions">
            <button class="btn btn--ghost tut__skip" type="button" @click="tut.close()">跳过</button>
            <span class="tut__spacer" />
            <button class="btn" type="button" :disabled="tut.index.value === 0" @click="tut.prev()">
              上一步
            </button>
            <button class="btn btn--primary" type="button" @click="tut.next()">
              {{ isLast ? '完成' : '下一步' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tut {
  position: fixed;
  inset: 0;
  z-index: 90;
}

/*
 * 压暗层。
 * 透明度刻意比聚光灯的阴影浅一些：聚光灯负责"把非目标压暗"，
 * 这一层只负责"整屏都能接住点击、且不影响目标可读性"。
 */
.tut__scrim {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 18%);
}

/*
 * 聚光灯。
 *
 * 【为什么用 box-shadow 而不是 border + outline】
 * `0 0 0 9999px` 的阴影铺满整个视口，中间那块自然就是"洞"——
 * 目标元素透出来，其余全暗。缩放/移动时不会出现接缝。
 * pointer-events:none 让用户仍能点到被高亮的按钮（教程不阻断操作）。
 */
.tut__spot {
  position: fixed;
  border-radius: 10px;
  box-shadow:
    0 0 0 2px var(--ui-accent),
    0 0 0 9999px rgb(0 0 0 / 62%);
  pointer-events: none;
  transition: top 160ms ease, left 160ms ease, width 160ms ease, height 160ms ease;
}

.tut__bubble {
  position: fixed;
  padding: 14px 16px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-panel);
  box-shadow: var(--ui-shadow);
  max-width: calc(100vw - 24px);
}

/* 找不到目标时居中 */
.tut__bubble.is-center {
  top: 50%;
  left: 50%;
  width: min(380px, calc(100vw - 24px));
  transform: translate(-50%, -50%);
}

.tut__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.tut__stepno {
  color: var(--ui-accent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
}

.tut__close {
  padding: 0 2px;
  border: none;
  background: transparent;
  color: var(--ui-text-dim);
  font-size: 12px;
}

.tut__close:hover {
  color: var(--ui-text);
}

.tut__title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
}

.tut__body {
  margin: 0;
  font-size: var(--ui-font-sm);
  line-height: 1.6;
}

.tut__keys {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  list-style: none;
}

.tut__key-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: var(--ui-font-xs);
  line-height: 1.9;
}

.tut__kbd {
  flex: none;
  min-width: 52px;
  padding: 1px 6px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-panel);
  color: var(--ui-text);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  text-align: center;
}

.tut__key-desc {
  color: var(--ui-text-dim);
}

.tut__warn {
  margin: 10px 0 0;
  padding: 7px 10px;
  border-left: 3px solid var(--ui-warn);
  border-radius: 4px;
  background: color-mix(in srgb, var(--ui-warn) 12%, transparent);
  font-size: var(--ui-font-xs);
  line-height: 1.55;
}

.tut__hint {
  margin: 8px 0 0;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  line-height: 1.5;
}

.tut__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 14px;
}

.tut__spacer {
  flex: 1 1 auto;
}

.tut__skip {
  padding-left: 0;
  border-color: transparent;
  background: transparent;
  color: var(--ui-text-dim);
}

.tut__skip:hover {
  color: var(--ui-text);
}

/* 进出场 */
.tut-enter-active,
.tut-leave-active {
  transition: opacity 160ms ease;
}

.tut-enter-from,
.tut-leave-to {
  opacity: 0;
}

/* 减少动态效果：不做过渡 */
.reduce-motion .tut-enter-active,
.reduce-motion .tut-leave-active,
.reduce-motion .tut__spot {
  transition: none;
}
</style>
