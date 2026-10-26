// @ts-check
/**
 * 预览舞台几何采集 —— 唯一依赖 DOM 的一小块，与纯函数层分开。
 *
 * 【为什么需要它】
 * `core/renderFrame.js` 被规定为纯函数层（禁止碰 DOM），
 * 但它必须知道"预览当前排版长什么样"才能让导出与预览一致：
 *   舞台宽 / 舞台高 / 每行实测高度 / 上下留白
 *
 * 于是把 DOM 读取收在这个文件里，renderFrame 只接收数字。
 * 好处：renderFrame 仍然可以在 Node 里单测，而这里可以单独替换/打桩。
 *
 * 【为什么行高要实测而不是自己算】
 * 预览的行高是浏览器排版的结果：字体回退、字间距舍入、超长英文单词的
 * 断行位置都可能与 canvas 的估算差几个像素。逐行实测 offsetHeight
 * 是唯一能保证"像素级一致"的做法（useAutoScroll.measure() 也是这么做的）。
 */

/**
 * 读取预览舞台的几何。
 *
 * 【全部字段都在"舞台像素"坐标系里】
 * 调用方负责乘缩放系数（画布高 / 舞台高）换算到画布像素。
 *
 * 【为什么宽度要"还原抽屉造成的收窄"】
 * 导出面板本身就在设置抽屉里，而抽屉打开时 `.app-shell` 会加
 * `padding-right: var(--drawer-shift)`（需求 N2 的避让），舞台因此变窄。
 * 若直接用它当版心宽度，导出的换行会比"用户平时看到的预览"窄一大截。
 * 所以这里把避让量加回去，得到**抽屉关闭时的自然宽度** ——
 * 那才是用户播放/展示时看到的排版。
 *
 * @returns {{
 *   width:number,
 *   height:number,
 *   rowHeights:number[]|null,
 *   padTopPx:number,
 *   padBottomPx:number,
 *   drawerShift:number,
 *   fontReady:boolean
 * }}
 */
export function readStageGeometry() {
  /** @type {any} */
  const fallback = {
    width: 0,
    height: 0,
    rowHeights: null,
    padTopPx: 0,
    padBottomPx: 0,
    drawerShift: 0,
    fontReady: false,
  }
  if (typeof document === 'undefined') return fallback

  const stage = document.querySelector('.stage')
  const rect = stage?.getBoundingClientRect?.()
  const height = Number(rect?.height)

  /*
   * 抽屉避让量：直接读 .app-shell 的实际 padding-right。
   * 不用 --drawer-shift 是因为它在窄屏会被媒体查询改成 0，
   * 读实际值才能同时覆盖"窄屏抽屉铺满"这种情况（那时舞台本来就没被压缩）。
   */
  const shell = document.querySelector('.app-shell')
  let paddingRight = 0
  if (shell && typeof getComputedStyle === 'function') {
    const v = Number.parseFloat(getComputedStyle(shell).paddingRight)
    if (Number.isFinite(v) && v > 0) paddingRight = v
  }
  const stageWidth = Number(rect?.width)
  /*
   * 【什么时候才把抽屉避让量加回去】
   * 16:9 时舞台铺满可用宽度，抽屉打开会把它挤窄，而导出不该跟着变窄
   * （否则"开抽屉量和关抽屉导出"会得到不同换行）—— 所以要加回 padding。
   *
   * 竖版 / 3:4 时舞台宽度是 **比例算出来的**（见 StageView 的 aspect-ratio），
   * 左右留白是画面的一部分，跟抽屉毫无关系。这时再加回 padding，
   * 量出来的版心会比真实舞台宽，导出就会用错宽度算换行 —— 必须跳过。
   *
   * 判据直接用"舞台自己有没有声明 aspect-ratio"，而不是靠视口宽度去猜：
   * 猜法在"窗口刚好比 stage 宽一点点"时会误判，而 aspect-ratio 是确定信号。
   * computed 值形如 '16 / 9'；没有声明时是 'auto'。
   */
  let ratioDriven = false
  if (stage && typeof getComputedStyle === 'function') {
    const ar = String(getComputedStyle(stage).aspectRatio ?? '')
    ratioDriven = ar !== '' && ar !== 'auto'
  }
  const naturalWidth = Number.isFinite(stageWidth) && stageWidth > 0 ? stageWidth + paddingRight : 0
  const width = ratioDriven ? stageWidth : naturalWidth

  /*
   * 逐行高度：按 data-line-index 归位（与 useAutoScroll.measure() 的假设一致）。
   * 出现空洞（尚未渲染的行）就整体作废 —— 半份几何会把画面算歪，
   * 退回调用方的公式估算反而更安全。
   */
  let rowHeights = null
  const track = document.querySelector('.stage__track')
  if (track) {
    const nodes = track.querySelectorAll('[data-line-index]')
    if (nodes.length > 0) {
      const arr = new Array(nodes.length).fill(0)
      for (const el of nodes) {
        const node = /** @type {HTMLElement} */ (el)
        const idx = Number(node.dataset.lineIndex)
        if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) continue
        arr[idx] = node.offsetHeight
      }
      rowHeights = arr.every((h) => Number.isFinite(h) && h > 0) ? arr : null
    }
  }

  // 上下留白占位块：预览用像素高度写进内联 style（见 StageView 的 padTopPx）
  const pads = stage?.querySelectorAll?.('.stage__pad')
  const padTopPx = pads?.[0] ? /** @type {HTMLElement} */ (pads[0]).offsetHeight : 0
  const padBottomPx = pads?.[1] ? /** @type {HTMLElement} */ (pads[1]).offsetHeight : 0

  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
    rowHeights,
    padTopPx: Number.isFinite(padTopPx) ? padTopPx : 0,
    padBottomPx: Number.isFinite(padBottomPx) ? padBottomPx : 0,
    drawerShift: paddingRight,
    fontReady: typeof document.fonts?.status === 'string' ? document.fonts.status === 'loaded' : false,
  }
}

/**
 * 等字体加载完成。
 *
 * 【为什么必须等】
 * 行高与换行宽度都取决于最终生效的字体。若在 webfont 尚未就绪时读取几何，
 * 拿到的是回退字体的排版，导出出来的行距会和用户看到的预览不一致。
 * 页面里已有几处 document.fonts.ready 的用法，这里是同一套约定。
 *
 * @returns {Promise<void>}
 */
export async function waitForFonts() {
  if (typeof document === 'undefined') return
  try {
    await document.fonts?.ready
  } catch {
    // 字体 API 不可用/被拒绝时继续 —— 用当前可用字体导出，总比整个导出失败好
  }
}
