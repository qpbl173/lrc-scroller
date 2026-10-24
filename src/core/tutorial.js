// @ts-check
/**
 * 新手教程的步骤定义与推进逻辑 —— 纯函数层，禁止 import vue / 不碰 DOM。
 *
 * 【为什么步骤表放在 core 而不是组件里】
 * "第几步、共几步、能不能下一步、哪个键翻了页"这些是纯逻辑，
 * 抽出来就能在 Node 里断言（`scripts/test-core.mjs`），
 * 组件只剩"把当前步骤画出来"这一件事。
 * 教程最容易出的问题是**索引越界**（在最后一步点"下一步"）和
 * **首次判定写坏**（每次刷新都弹），两者都靠单测拦住。
 *
 * 【为什么用 data-tour 属性找目标】
 * 组件里的 class 是样式用的，改样式时很容易被顺手改掉；
 * `data-tour="xxx"` 只服务于教程，语义稳定，
 * 也让"教程要指向哪几个元素"一眼可查（grep data-tour 即可）。
 */

/** 记住"已经看过教程"的 localStorage 键（带版本，将来改版可重新引导） */
export const TUTORIAL_STORAGE_KEY = 'lrc-scroller:tutorial-seen:v1'

/**
 * 教程步骤。
 *
 * 字段说明：
 *   id        稳定标识（测试与埋点用，不参与显示）
 *   title     标题
 *   body      正文
 *   keys      可选的快捷键说明列表（第 2 步用）
 *   warn      可选的强调提示（第 2 步的"暂停要用鼠标"）
 *   targets   候选目标选择器，**按顺序取第一个存在的**；
 *             第 3/4 步的目标藏在设置抽屉里，用户没打开时自动回落到「设置」按钮
 *   place     气泡相对目标的位置：'bottom' | 'top' | 'center'
 */
export const TUTORIAL_STEPS = [
  {
    id: 'import',
    title: '第 1 步 · 导入音频和歌词',
    body: '先点「导入音频」选你的音乐，再点「导入 txt / lrc」选歌词文件。',
    hint: '也可以直接把这两个文件拖进画面中间，效果一样。',
    targets: ['[data-tour="import-audio"]', '[data-tour="import-lyric"]'],
    place: 'bottom',
  },
  {
    id: 'tapping',
    title: '第 2 步 · 打轴：给歌词标上时间',
    body: '点播放条上的「打轴」进入打轴模式，然后播放音乐 —— 每听到一句的开头，就按一下空格。',
    // 窄屏下播放条会隐藏「打轴」按钮（只留快捷键），给一句替代说明
    narrowBody: '播放条较窄时「打轴」按钮会收起，按 T 键一样能进入打轴模式。播放音乐后，每听到一句的开头就按一下空格。',
    keys: [
      ['空格', '给当前编辑行打时间点'],
      ['Z', '撤销上一行'],
      ['← / →', '微调刚打完的那行（按住 Shift 幅度更大）'],
      ['T', '进入 / 退出打轴模式'],
    ],
    warn: '注意：打轴时空格被用来打点，所以要暂停请用鼠标点播放条左边的暂停键。',
    targets: ['[data-tour="tap"]'],
    place: 'top',
  },
  {
    id: 'settings',
    title: '第 3 步 · 自定义你的画面',
    body: '点「设置」可以调整字体、字号、行距、字间距、颜色、背景和虚化效果。',
    hint: '改动会立刻反映到画面上，并自动保存在本机浏览器里。',
    targets: ['[data-tour="settings"]'],
    place: 'bottom',
  },
  {
    id: 'export',
    title: '第 4 步 · 导出视频',
    body: '在设置面板里点「导出」，选择普通 MP4 或透明 MOV，选好分辨率和帧率，再点「导出视频」。',
    hint: '导出的是无声视频，音频请在自己的剪辑软件里对齐。',
    // 抽屉开着就指向真正的按钮，否则回落到「设置」（用户选了不自动开抽屉）
    targets: ['[data-tour="export-video"]', '[data-tour="export-toggle"]', '[data-tour="settings"]'],
    place: 'bottom',
  },
]

/** 步骤总数 */
export function stepCount() {
  return TUTORIAL_STEPS.length
}

/**
 * 按索引取步骤；越界返回 null（调用方据此结束教程）。
 * @param {number} index
 * @returns {(typeof TUTORIAL_STEPS)[number]|null}
 */
export function stepAt(index) {
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= TUTORIAL_STEPS.length) return null
  return TUTORIAL_STEPS[i]
}

/** 是否是最后一步（决定按钮文案是"完成"还是"下一步"） */
export function isLastStep(index) {
  return Number(index) >= TUTORIAL_STEPS.length - 1
}

/**
 * 下一步的索引。
 * 【为什么到末尾返回 null 而不是夹住】
 * 夹住会让"最后一步点下一步"变成一个静默无操作，
 * 用户不知道是点坏了还是结束了。返回 null 让调用方明确地结束教程。
 * @param {number} index
 * @returns {number|null}
 */
export function nextStepIndex(index) {
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0) return null
  const n = i + 1
  return n < TUTORIAL_STEPS.length ? n : null
}

/**
 * 上一步的索引；已在第一步返回 null（按钮应禁用）。
 * @param {number} index
 * @returns {number|null}
 */
export function prevStepIndex(index) {
  const i = Number(index)
  if (!Number.isInteger(i) || i <= 0) return null
  return i < TUTORIAL_STEPS.length ? i - 1 : TUTORIAL_STEPS.length - 2
}

/**
 * 把任意输入夹到合法步骤范围。
 * @param {unknown} index
 * @returns {number}
 */
export function clampStepIndex(index) {
  const i = Math.floor(Number(index))
  if (!Number.isFinite(i) || i < 0) return 0
  const max = TUTORIAL_STEPS.length - 1
  return i > max ? max : i
}

/**
 * 键盘事件 → 教程动作（纯函数，便于单测）。
 *
 * 【为什么要单独抽出来】
 * 教程进行中必须**独占键盘**：否则 ←/→ 翻页会同时触发快进、
 * 空格翻页会同时打轴或播放。这层判断放在 useKeyboard 里，
 * 但"哪个键做什么"是纯映射，抽出来就能直接断言。
 *
 * @param {string} key KeyboardEvent.key
 * @param {{shiftKey?:boolean}} [mods]
 * @returns {'next'|'prev'|'close'|null} null 表示不认识这个键
 */
export function tutorialKeyAction(key, mods = {}) {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      return 'next'
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      return 'prev'
    case 'Enter':
      // Shift+Enter 回退一步，符合表单里的常见习惯
      return mods?.shiftKey ? 'prev' : 'next'
    case 'Escape':
    case 'Esc':
      return 'close'
    default:
      return null
  }
}

/**
 * "已看过教程"标记的读写。
 *
 * 【为什么自己包一层而不是直接用 localStorage】
 * 隐私模式下 localStorage 会抛异常。教程只是引导，
 * 存不下时**绝不能影响主流程** —— 这里读失败当作"没看过"（会再弹一次），
 * 写失败静默忽略。与 core/persist.js 的容错思路一致。
 *
 * @param {Storage|null} storage
 * @returns {{seen:()=>boolean, markSeen:()=>void, reset:()=>void, available:boolean}}
 */
export function createTutorialFlags(storage) {
  let available = false
  try {
    if (storage) {
      const probe = '__lrc_tut_probe__'
      storage.setItem(probe, '1')
      storage.removeItem(probe)
      available = true
    }
  } catch {
    available = false
  }

  return {
    available,

    /** 是否已经看过（读不到 → false，即"没看过"，会再弹一次） */
    seen() {
      if (!available) return false
      try {
        return storage.getItem(TUTORIAL_STORAGE_KEY) === '1'
      } catch {
        return false
      }
    },

    /** 标记为已看过（失败静默忽略） */
    markSeen() {
      if (!available) return
      try {
        storage.setItem(TUTORIAL_STORAGE_KEY, '1')
      } catch {
        /* 配额满/隐私模式：不影响使用，只是下次可能再弹一次 */
      }
    },

    /** 清除标记（"重置"或调试用） */
    reset() {
      if (!available) return
      try {
        storage.removeItem(TUTORIAL_STORAGE_KEY)
      } catch {
        /* 忽略 */
      }
    },
  }
}
