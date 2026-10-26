<script setup>
import { computed } from 'vue'
/**
 * 单行歌词。
 *
 * 【核心约束：放大必须用 transform: scale】
 * 不能用改 font-size 实现放大 —— 那会改变行高、触发重排，
 * 导致滚动抖动，也会让"相邻行位置不动"的验收项失败。
 * transform 不参与布局计算，所以放大到 2 倍时相邻行纹丝不动。
 *
 * 【透明度：单一来源】
 * 虚化开启后，opacity 由父级通过 --line-opacity 传入（内联样式），
 * 此时组件内的 .is-past / .is-empty / .is-translation 都不再写 opacity，
 * 否则会出现"CSS 类与内联样式互相覆盖"的优先级混乱。
 * 虚化关闭时，则由 CSS 类按原有规则控制。
 */
const props = defineProps({
  /** @type {import('vue').PropType<{id:string,t:number,text:string,empty:boolean,isTranslation?:boolean}>} */
  line: { type: Object, required: true },
  /** 在完整歌词数组中的下标（几何测量需要） */
  index: { type: Number, required: true },
  active: { type: Boolean, default: false },
  past: { type: Boolean, default: false },
  /**
   * 是否是打轴模式的「当前编辑行」（阶段 5 第 3 步）。
   *
   * 【active / editing / tapped 是三回事】
   * active  = 正在播放的那一行（--lrc-color-active + 放大）
   * editing = 下一行要打时间点的那一行（**只用左侧竖条**，不改颜色与大小）
   * tapped  = **刚**打完的那一行（--lrc-color-tapped + 放大）
   * 三者可以同时出现在不同行上。
   */
  editing: { type: Boolean, default: false },
  /** 是否是打轴模式下「刚打完」的那一行 */
  tapped: { type: Boolean, default: false },
  /**
   * 虚化计算出的最终透明度（含 active/past 基准）。
   * 为 null 表示虚化未启用，交由 CSS 类决定。
   * @type {import('vue').PropType<number|null>}
   */
  opacity: { type: Number, default: null },
  /**
   * 逐字进度 0~1；null = 这一行没有逐字时间（不显示进度色）。
   * @type {import('vue').PropType<number|null>}
   */
  charProgress: { type: Number, default: null },
})

const label = () => (props.line.empty ? '（间奏）' : props.line.text)

/**
 * 逐字进度（0~1）：这一行已经被"唱过"的比例。
 *
 * 【为什么由父级传进来，而不是在这里读 playerStore】
 * 每行都订阅 currentTime 会让播放时每一帧触发 N 个组件的更新；
 * StageView 只有一个 currentTime 依赖，算好再分发，开销是 O(1) 而不是 O(N)。
 * 而且传值让这个组件保持纯输入，测试可以直接喂值。
 *
 * null 表示这一行没有逐字时间 —— 此时**不输出任何进度样式**，
 * 渲染结果与没有逐字功能时逐字节一致。
 */
const progress = computed(() => {
  const p = props.charProgress
  if (p === null || p === undefined) return null
  const n = Number(p)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
})

/** 虚化启用时用内联透明度；关闭时不设，让 CSS 类生效 */
const style = () => {
  if (props.opacity === null || props.opacity === undefined) return undefined
  return { opacity: String(props.opacity) }
}
</script>

<template>
  <div
    class="lyric-line"
    :class="{
      'is-active': active,
      'is-editing': editing,
      'is-tapped': tapped,
      'is-past': past && !active,
      'is-empty': line.empty,
      'is-translation': line.isTranslation,
      'has-fade': opacity !== null && opacity !== undefined,
    }"
    :style="style()"
    :data-line-id="line.id"
    :data-line-index="index"
    :data-opacity="opacity === null || opacity === undefined ? undefined : opacity.toFixed(4)"
  >
    <span
      class="lyric-line__text"
      :class="{ 'has-char-progress': progress !== null }"
      :style="progress !== null ? { '--char-progress': String(progress) } : undefined"
      :data-char-progress="progress === null ? undefined : progress.toFixed(4)"
      >{{ label() }}</span>
  </div>
</template>

<style scoped>
.lyric-line {
  /* 固定行高容器：普通行高度只由字号与行距决定，放大不参与布局 */
  display: flex;
  align-items: center;
  justify-content: var(--lrc-align);
  min-height: calc(var(--lrc-font-size) * var(--lrc-line-height));
  padding: calc(var(--lrc-font-size) * 0.18) 0;

  color: var(--lrc-color-normal);
  font-family: var(--lrc-font-family);
  font-size: var(--lrc-font-size);
  font-weight: var(--lrc-font-weight);
  letter-spacing: var(--lrc-letter-spacing);
  line-height: var(--lrc-line-height);
  text-align: var(--lrc-align);

  opacity: 0.55;
  transition: color var(--lrc-fade) ease, opacity var(--lrc-fade) ease,
    transform var(--lrc-transition) cubic-bezier(0.22, 1, 0.36, 1);
  /*
    这里**刻意不写 will-change: transform**。
    2000 行歌词若每行都声明 will-change，浏览器会为每一行建立独立合成层，
    内存暴涨且合成时间剧增（实测会直接掉到个位数帧率）。
    整个轨道由 .stage__track 统一提升为合成层即可。
  */
}

/* 虚化接管透明度时，用内联值（权重已由 JS 相乘算好），CSS 类不再写 opacity */
.lyric-line.has-fade {
  /* 内联 style 优先级高于类，这里只是显式声明"透明度由 JS 负责" */
  transition: color var(--lrc-fade) ease, opacity var(--lrc-fade) ease,
    transform var(--lrc-transition) cubic-bezier(0.22, 1, 0.36, 1);
}

/*
 * 打轴模式的「当前编辑行」（阶段 5 第 3 步）。
 *
 * 【为什么只用左侧竖条，不改颜色也不改大小】
 * 需求明确：与 .is-active（播放高亮，颜色 + 放大）必须一眼能区分。
 * 如果编辑行也改颜色/大小，它就和"正在播放"混淆了 ——
 * 而打轴时两者本来就可以出现在不同行上。
 * 左侧竖条是纯附加的定位标记，不影响该行原有的任何视觉。
 *
 * 用 border-left 而不是 ::before 伪元素：
 * 伪元素在 .lyric-line 有 transform 缩放时会被一起放大，
 * border-left 不受影响，位置永远稳定在行的左缘。
 * 加 padding-left 是为了不让竖条压住文字，
 * 但会改变该行的内容宽度 —— 所以用 margin 让竖条占"行外"的位置。
 */
.lyric-line.is-editing {
  border-left: 3px solid var(--ui-accent);
  padding-left: 12px;
  /* 行高不变，避免与 .is-active 的放大叠加导致跳动 */
  transform: none;
}

/* 编辑行恰好也是播放行时，保留 active 的放大，竖条依然可见 */
.lyric-line.is-editing.is-active {
  transform: scale(var(--lrc-active-scale));
}

.lyric-line__text {
  display: block;
  max-width: var(--lrc-max-width);
  word-break: break-word;

  /*
   * 文字描边。
   *
   * 【为什么写在 span 上，而不是 .lyric-line 容器上】
   * em 依赖 font-size。写在容器上会继承容器的 --lrc-font-size（基准字号），
   * 而翻译行是 `.is-translation .lyric-line__text { font-size: 0.62em }` ——
   * span 自己的字号更小。写在 span 上，em 自动按 span 的字号解析，
   * 于是翻译行的描边同比更细，与主歌词的视觉比例一致。
   * （实测确认：字号 20px 的 span 上 1em 描边 = 20px，而不是容器的 40px。）
   *
   * 【paint-order 由「描边位置」决定，不能写死】
   * 变量 --lrc-stroke-order 由 core/settings.js 的 toCssVars 产出：
   *   outer  → 'stroke fill'  描边画在填充下面，内半被填充盖住 → 向外
   *   center → 'fill stroke'  描边压在填充上面，内外各半       → 居中
   * 早先写死 stroke fill，选了"居中"预览也不会变。canvas 侧用同一套顺序
   * （见 core/renderFrame.js 的 paint()），两边天然一致。
   *
   * 【为什么没有「内侧」】
   * CSS 无法把描边推到字形内侧：-webkit-text-stroke 的线宽永远以轮廓为中心，
   * 而 SVG2 的 stroke-alignment: inner 至今无浏览器实现（实测 Edge 155
   * CSS.supports 返回 false）。唯一能"腐蚀"字形的是 SVG 滤镜 feMorphology
   * erode，但它会把填充一起吃掉、半径不随字号缩放，且与 canvas 的结果对不上
   * （实测绿色区域 IoU 仅 0.38）—— 那会破坏"导出 = 预览"这个核心契约。
   * 详见 core/settings.js 里 stroke.position 的说明。
   *
   * 【width 为 0 时】
   * 0em 是合法的 CSS 长度，浏览器不会画描边，所以"默认关闭"不需要额外的开关，
   * 也不需要在模板里加条件判断。
   *
   * 【em 与 transform 的关系（与导出对齐的关键）】
   * 实测：父级 transform: scale(2) 时，2em 描边的 computed 值仍是 80px
   * （基于**未缩放**的 font-size 40px 解析），随后被 transform 一起放大。
   * 这正是 canvas 的行为 —— ctx.scale(scale) 之后 lineWidth = em × 未缩放字号，
   * 描边随 transform 缩放。两条路径数学上完全一致。
   */
  -webkit-text-stroke-width: var(--lrc-stroke-width);
  -webkit-text-stroke-color: var(--lrc-stroke-color);
  paint-order: var(--lrc-stroke-order, stroke fill);
}

/* 已唱过的行更暗，形成进度感（虚化关闭时才生效） */
.lyric-line.is-past:not(.has-fade) {
  opacity: 0.38;
}

/*
  当前行：放大 + 变色 + 完全不透明。
  放大走 transform，不改变布局；透明度在虚化开启时由 JS 保证为 1。
*/
.lyric-line.is-active {
  color: var(--lrc-color-active);
  transform: scale(var(--lrc-active-scale));
  transform-origin: var(--lrc-align) center;
}

.lyric-line.is-active:not(.has-fade) {
  opacity: 1;
}

/*
  刚打完的那一行（打轴模式）。
  与 .is-active 一样放大 + 变色，用 --lrc-color-tapped（默认 accent 蓝）。
*/
.lyric-line.is-tapped {
  color: var(--lrc-color-tapped);
  transform: scale(var(--lrc-active-scale));
  transform-origin: var(--lrc-align) center;
}

.lyric-line.is-tapped:not(.has-fade) {
  opacity: 1;
}

/*
  【同一行既是播放行又是刚打完的行：active 胜出】

  选 active 胜出而不是"叠加"，理由：
  - 放大只能有一次。两个类各写一遍 `transform: scale(...)` 不会叠加
    （后写的覆盖前面的），但会让读者以为"两次放大"，
    将来有人改成 `scale(a) scale(b)` 就会真的叠成两倍。
    显式让 active 胜出，语义更清楚。
  - 颜色上，播放头所在的那一行是**用户此刻真正在听的**内容，
    视觉优先级应高于"刚打完"这个操作痕迹。
  - "刚打完"这个信息不会丢失：它通过**编辑行的竖条**位置已经表达出来了
    （editingIndex 正好是 lastTappedIndex + 1）。
*/
.lyric-line.is-active.is-tapped {
  color: var(--lrc-color-active);
  transform: scale(var(--lrc-active-scale));
}

/*
  翻译行：同时间的第二行（双语歌词）。
  缩小字号并降低不透明度，让主歌词保持视觉主导。
*/
.lyric-line.is-translation .lyric-line__text {
  font-size: 0.62em;
}

.lyric-line.is-translation:not(.has-fade) .lyric-line__text {
  opacity: 0.72;
}

.lyric-line.is-translation.is-active:not(.has-fade) .lyric-line__text {
  opacity: 0.9;
}

/* 空行（间奏）用更弱的视觉，但仍然占位，避免滚动跳变 */
.lyric-line.is-empty:not(.has-fade) .lyric-line__text {
  opacity: 0.35;
}

/* 减少动态效果时不做缩放，避免前庭不适 */
.reduce-motion .lyric-line.is-active {
  transform: none;
}

/*
  逐字进度色：从左往右按进度线性覆盖。

  【为什么用 background-clip:text + 渐变，而不是叠一个伪元素】
  渐变直接在文字上"切"出两种颜色，边界就是字形本身 ——
  不需要量文字宽度、不需要处理换行，几何天然正确。
  伪元素方案要自己算宽度，多行换行时必然出错。

  【为什么用 --char-progress 变量而不是直接算渐变】
  进度每帧都变，写在内联样式里就是每帧重算整个 gradient 字符串；
  用变量让浏览器只更新插值，且样式规则本身是静态的。

  【null 时不生效】
  没有逐字时间的行根本没有 has-char-progress 类，
  下面所有规则都不匹配 —— 渲染结果与没有逐字功能时一致。
*/
.lyric-line__text.has-char-progress {
  /*
   * 双层背景，都裁到字形上：
   *   第 1 层：进度色，只到进度停靠点，右边透明
   *   第 2 层：当前文字色，整行铺满
   * 上层透明处露出下层 → 已唱段是进度色，未唱段是原色。
   *
   * 【为什么下层用 currentColor 而不是 --lrc-color-normal】
   * 当前行 / 刚打完行的 color 会被 .is-active / .is-tapped 改成别的颜色。
   * currentColor 自动跟随，未唱段永远与该行"本来该有的颜色"一致 ——
   * 写死 normal 会让高亮行的未唱段突然变成灰色。
   */
  background-image:
    linear-gradient(
      to right,
      var(--lrc-color-char-progress) 0%,
      var(--lrc-color-char-progress) calc(var(--char-progress) * 100%),
      transparent calc(var(--char-progress) * 100%),
      transparent 100%
    ),
    linear-gradient(currentColor, currentColor);
  -webkit-background-clip: text, text;
  background-clip: text, text;
  /*
   * 【为什么填充必须透明】
   * 文字填充色是画在背景**之上**的。留着 currentColor 会把渐变整块盖住，
   * 进度色一点都看不见 —— 这是 background-clip:text 最常见的踩坑点。
   * 描边（-webkit-text-stroke）不受影响，仍然正常绘制。
   */
  -webkit-text-fill-color: transparent;
}
</style>
