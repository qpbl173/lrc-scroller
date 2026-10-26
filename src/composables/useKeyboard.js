// @ts-check
/**
 * 全局键盘快捷键。
 *
 * 阶段 2 范围：空格 播放/暂停、← → 快退/快进 5 秒、上下键调音量。
 * 阶段 4 追加：F 进入/退出展示模式、Esc 退出展示模式。
 *
 * 【必须做的输入保护】
 * 用户正在设置面板里输入数值或改文件名时，空格绝不能被当成"播放/暂停"。
 * 因此在处理前先判断事件目标是否为可输入元素。
 *
 * 【F 键的输入保护比别的键更严】
 * 用户正在 HEX 输入框里打 "ffffff" 时，按 F 必须是在**输入 f**，
 * 而不是切换全屏。所以除了可输入元素判断，还要额外排除修饰键。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { usePlayerStore } from '@/stores/playerStore'
import { useUiStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAudioEngine } from '@/composables/useAudioEngine'
import { useFullscreenShared } from '@/composables/useFullscreen'
import { useTappingShared, NUDGE_STEP_MS, NUDGE_STEP_BIG_MS } from '@/composables/useTapping'
import { useTutorialShared } from '@/composables/useTutorial'
import { CODES } from '@/core/errors'

/** 快退/快进步长（秒） */
const SEEK_STEP = 5

/**
 * 判断事件是否发生在可输入元素上。
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

/**
 * 判断事件是否发生在**交互控件**上（button / role="slider"）。
 *
 * 【为什么空格要专门避开它们 —— 优先级链第 2 档】
 * 焦点在播放按钮上按空格，用户的预期是"播放/暂停"（按钮的原生行为），
 * 不是"给歌词打一个时间点"。同理，进度条、音量条、色轮、明度条上
 * 按空格都是控件自己的语义。
 * 所以这些情况一律**不打轴**。
 *
 * 判据用 document.activeElement 而不是 e.target：
 * 焦点在控件上时，keydown 的 target 通常就是那个控件；
 * 但冒泡/重定向时可能落在 body 上，activeElement 更稳。
 *
 * @returns {boolean}
 */
function isInteractiveControl() {
  const el = typeof document === 'undefined' ? null : document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.tagName === 'BUTTON') return true
  if (el.getAttribute('role') === 'slider') return true
  return false
}

export function useKeyboard() {
  const player = usePlayerStore()
  const ui = useUiStore()
  const engine = useAudioEngine()
  const settings = useSettingsStore()
  // 单例：与 App.vue / TopBar 共享同一份展示模式状态
  const full = useFullscreenShared()
  // 阶段 5 第 3 步：打轴模式（单例，与 PlayerBar 共享）
  const tappingAPI = useTappingShared()
  const tapping = tappingAPI.tapping
  // 新手教程（单例，与 TopBar / App.vue 的遮罩共享）
  const tut = useTutorialShared()

  /**
   * 切换展示模式。
   *
   * onBeforeEnter 关抽屉：抽屉开着时按 F 进全屏会让 .app-shell
   * 留一条 padding-right 避让，舞台右侧露出浏览器白底（真机 BUG）。
   *
   * @param {KeyboardEvent} e
   */
  function onTogglePresent(e) {
    e.preventDefault()
    full.toggle(document.querySelector('.app-shell') ?? document.documentElement, {
      onBeforeEnter: () => settings.closeDrawer(),
    })
  }

  /**
   * 空格的分派（四档优先级，从高到低）。
   *
   * 1. 输入框 / contenteditable → 打一个空格字符（第一档在 onKeydown 开头就 return 了）
   * 2. **打轴模式开启** → 打轴（并 preventDefault）
   * 3. 焦点在交互控件（button / role=slider）→ 交给控件自身
   * 4. 其余 → 播放/暂停
   *
   * 【第 2 档为什么排在"焦点在控件"之前 —— 真机 BUG】
   * 用户点「打轴」按钮进入打轴后，**焦点就留在那个按钮上**
   * （点击按钮不会把焦点移走）。此时按空格：
   *   若先判"焦点在控件上"就跳过 → 没有 preventDefault
   *   → 浏览器执行按钮的默认行为 → 空格"激活"按钮 → click
   *   → toggle() → **退出了打轴模式**。
   * 实测复现：真实点击按钮后 activeElement 就是 .playerbar__tap，
   * 按一次空格 enabled 立刻变 false、且什么都没打上。
   *
   * 顺序对调后：用户主动进了打轴模式，按空格的意图 100% 是打轴；
   * 此时"焦点在按钮上"只是点按钮的副产品，不是用户意图。
   * 而非打轴模式下焦点在控件上的行为完全不变（仍是控件自己的语义）。
   *
   * @param {KeyboardEvent} e
   */
  function onSpace(e) {
    /*
     * 第 1.5 档：逐字打轴 —— 比逐行更优先。
     *
     * 【为什么逐字必须排在逐行之前】
     * 两套模式理论上不会同时开，但用户完全可能"逐行打完后忘了关、
     * 又开了逐字"（两套草稿是并存的，所以两个 enabled 能同时为 true）。
     * 此时按空格的意图一定是逐字 —— 那是更细的一层。
     * 反过来先判逐行的话，空格会去改 tapped，逐字草稿一个字都不动，
     * 而界面上逐字光标明明亮着，用户完全看不出发生了什么。
     *
     * 【必须 preventDefault】
     * 与逐行同理：焦点可能还停在「逐字」按钮上，
     * 不拦的话空格会激活按钮 → 退出逐字模式。
     */
    if (tapping.charMode) {
      e.preventDefault()
      tappingAPI.charTap()
      return
    }

    // 第 2 档：打轴模式 —— 空格永远是打轴，不管焦点在哪
    if (tapping.enabled) {
      // 【必须 preventDefault】
      // 否则焦点在「打轴」按钮上时，空格会触发按钮的默认 click
      // → toggle() → 退出打轴模式（真机 BUG）。
      // 不 preventDefault 的话，这里就等于"帮用户把模式关掉了"。
      e.preventDefault()
      // 打轴不需要音频：没有音频时模拟时钟照样能走时间轴
      // （阶段 1 的能力），所以这里**不弹**"请先导入音频"——
      // 那会打断连续打轴的节奏。
      tappingAPI.tap()
      return
    }

    // 第 3 档：焦点在按钮/滑杆上 —— 交给控件自己（播放/暂停等）
    if (isInteractiveControl()) {
      // 不 preventDefault：让按钮的原生空格激活照常发生
      return
    }

    e.preventDefault()

    // 第 4 档：播放/暂停
    if (!player.canPlay) {
      ui.pushCode(CODES.AUDIO_NOT_LOADED)
      return
    }
    engine.toggle()
  }

  /**
   * @param {KeyboardEvent} e
   */
  function onKeydown(e) {
    if (isTypingTarget(e.target)) return

    /*
     * 教程进行中：全局快捷键**全部让位**。
     *
     * 【为什么必须最先判断】
     * 教程用 ←/→/↑/↓/PageUp/PageDown/Enter/Esc 翻页。
     * 若这里不让位，按一下 → 会同时"翻到下一步"和"快进 5 秒"，
     * 按空格会同时"翻页"和"打轴/播放" —— 用户会以为程序疯了。
     *
     * 【为什么不是简单 return，而要 preventDefault】
     * 教程遮罩自己挂在 window 的**捕获阶段**（capture: true）处理翻页并
     * preventDefault，正常情况下事件到不了这里。
     * 但焦点若落在遮罩内的按钮上（Tab 之后），事件路径可能绕过捕获监听，
     * 那时这里的 return 就是兜底 —— 至少不执行播放/打轴这些破坏性动作。
     *
     * 注意 Esc 也不放行：教程里 Esc 的语义是"关闭教程"，
     * 不是"退出全屏/关抽屉"。教程关闭后下一次按键恢复正常。
     */
    if (tut.active.value) {
      e.preventDefault()
      return
    }

    /*
     * Ctrl/Cmd+Z：撤销。
     *
     * 【必须放在"带修饰键就放行"之前】
     * 下面那行 `if (e.ctrlKey || ...) return` 会把 Ctrl+Z 交给浏览器。
     * 但应用后的 3 秒撤销窗口要靠它，所以先在这里拦掉。
     * 只认 ctrl/meta + z，其余修饰组合（Ctrl+Shift+Z 重做等）仍放行。
     */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      // 逐字优先：两套草稿并存时，用户眼前的是逐字光标
      const charWhat = tappingAPI.charUndoAny()
      if (charWhat) {
        e.preventDefault()
        return
      }
      const what = tappingAPI.undoAny()
      // 什么都没撤销时不该抢浏览器/输入框的原生撤销
      if (what) {
        e.preventDefault()
        return
      }
      return
    }

    // 带修饰键的组合留给浏览器（如 Ctrl+R 刷新）
    if (e.ctrlKey || e.metaKey || e.altKey) return

    switch (e.key) {
      // ── 阶段 4：展示模式 ──
      case 'f':
      case 'F': {
        onTogglePresent(e)
        break
      }

      case 'Escape':
      case 'Esc': {
        // 只在展示模式下拦截 Esc：正常编辑界面里 Esc 应该还给浏览器
        // （比如关闭设置抽屉、退出原生全屏），不要抢。
        if (full.isPresenting.value) {
          e.preventDefault()
          void full.leavePresentation()
        }
        break
      }

      // ── 阶段 2/5：播放控制 or 打轴（四档优先级，见 onSpace）──
      case ' ':
      case 'Spacebar': {
        onSpace(e)
        break
      }

      // ── 阶段 5 第 3 步：打轴模式开关 ──
      case 't':
      case 'T': {
        e.preventDefault()
        tappingAPI.toggle()
        break
      }

      // ── 阶段 5 第 3 步：撤销 + 播放头固定回滚 5 秒 ──
      case 'z':
      case 'Z': {
        /*
         * 逐字模式下的 Z 是逐字撤销（不改播放头：逐字是原地精修）。
         * 必须排在逐行之前，理由同 onSpace。
         */
        if (tapping.charMode) {
          e.preventDefault()
          tappingAPI.charUndo()
          return
        }
        // 只在打轴模式生效；非打轴模式不响应（避免和浏览器的撤销习惯冲突）
        if (!tapping.enabled) return
        e.preventDefault()
        tappingAPI.undo()
        break
      }

      case 'ArrowLeft': {
        /*
         * 逐字模式：←/→ 用于在字之间挪光标，而不是微调时间。
         * 【为什么不让它微调时间】逐字已经有 Z 撤销这条"重打"路径，
         * 而逐字时间是以"跟着音频按下空格"为准的，手改 ±10ms 意义不大；
         * 更需要的是"我打错了哪个字，让我退回去"。
         */
        if (tapping.charMode) {
          e.preventDefault()
          tappingAPI.charStepCursor(-1)
          return
        }
        // 打轴模式：微调**刚打完那行**（lastTappedIndex）
        if (tapping.enabled) {
          e.preventDefault()
          tappingAPI.nudge(-(e.shiftKey ? NUDGE_STEP_BIG_MS : NUDGE_STEP_MS))
          return
        }
        if (!player.canPlay) return
        e.preventDefault()
        engine.seek(player.currentTime - SEEK_STEP)
        break
      }

      case 'ArrowRight': {
        if (tapping.charMode) {
          e.preventDefault()
          tappingAPI.charStepCursor(1)
          return
        }
        if (tapping.enabled) {
          e.preventDefault()
          tappingAPI.nudge(e.shiftKey ? NUDGE_STEP_BIG_MS : NUDGE_STEP_MS)
          return
        }
        if (!player.canPlay) return
        e.preventDefault()
        engine.seek(player.currentTime + SEEK_STEP)
        break
      }

      case 'ArrowUp': {
        e.preventDefault()
        engine.setVolume(player.volume + 0.05)
        break
      }

      case 'ArrowDown': {
        e.preventDefault()
        engine.setVolume(player.volume - 0.05)
        break
      }

      case 'm':
      case 'M': {
        engine.toggleMute()
        break
      }

      default:
        break
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

  return { SEEK_STEP }
}
