import { defineStore } from 'pinia'
import { useLyricsStore } from './lyricsStore'
import { useSettingsStore } from './settingsStore'
import { validateBpm, beatTimes, nearestBeat } from '@/core/beat'
import {
  CHAR_STORAGE_KEY,
  alignSavedDrafts,
  charDraftTextHash,
  charRelocateCursor,
  charTapStep,
  charUndoStep,
  countTimedChars,
  parseCharState,
  serializeCharState,
  splitChars,
} from '@/core/charProgress'

/**
 * 打轴（快速打时间点）的会话状态。
 *
 * 【为什么 tapped 与 lyrics.lines 分开存，而不是直接改 lines】
 * 打轴是**草稿编辑**：用户打一半可能想放弃、可能导入新歌词重来。
 * 直接写 lines 会污染正在播放/正在滚动的歌词（当前行索引会变），
 * 而且"放弃"就没有退路。tapped 是与 lines 平行的一份草稿，
 * 由后续的「应用」动作（第 5 步）统一写回。
 *
 * 【editingIndex 不是 DOM 焦点】
 * 它只是 store 里的一个整数下标，不调用 el.focus()、
 * 不触发 :focus-visible、不依赖 document.activeElement。
 * 键盘事件始终由 useKeyboard 在 window 上统一处理。
 * 视觉上用 .is-editing 标记，与播放高亮的 .is-active 是两回事，
 * 同一时刻可以出现在不同行上。
 */

/** 撤销栈上限 */
export const UNDO_LIMIT = 100

/** 每次 Z 撤销时播放头回滚的秒数 */
export const ROLLBACK_SEC = 5

/** 吸附容差（毫秒）：手打时间离拍点超过这个距离就不吸 */
export const SNAP_TOLERANCE_MS = 50

/**
 * 生成的节拍数。
 * 取 512 拍：BPM=120 时覆盖 256 秒，远超常见歌曲长度；
 * 打轴时每次按键重算一遍，512 个数的成本实测可忽略。
 */
const BEAT_GRID_SIZE = 512

const STORAGE_KEY = 'lrc-scroller:tapping:v1'

/**
 * @typedef {object} TapRecord
 * @property {number} t 记录的时间（秒）
 * @property {number|null} beat 吸附到的第几拍（0 起）；未吸附为 null（第 6 步用）
 * @property {boolean} locked 用户手动 ←/→ 微调过（true 时吸附不得覆盖）
 */

/** @type {TapRecord|null} */
const EMPTY = null

export const useTappingStore = defineStore('tapping', {
  state: () => ({
    /** 打轴模式开关 */
    enabled: false,

    /** 当前编辑行（下一行要打哪行） */
    editingIndex: 0,

    /** 刚打完的那一行；←/→ 微调的是它 */
    lastTappedIndex: -1,

    /**
     * 已打的时间表，与**目标行数组**的下标平行。
     * 没打的行是 null。
     * @type {Array<TapRecord|null>}
     */
    tapped: [],

    /**
     * 当前 tapped 对应的是哪个目标（'dropped' | 'lines'）。
     *
     * 【为什么必须记这个 —— 实测过的真 bug】
     * ensureSize 原本只比较**长度**。而
     *   文件1（纯 lrc）: lines=2 → 目标 lines，草稿长度 2
     *   文件2（纯 txt）: dropped=2 → 目标 dropped，长度也是 2
     * 长度相等 → 旧的判断"已对齐"→ **不重置** →
     * 文件2 的 droppedLines[0] 拿到文件1 的 lines[0] 的草稿时间。
     * 用户表现为"导入新文件后某些行莫名已经有时间了"。
     * 所以必须同时比较"目标是谁 + 长度"。
     */
    tappedKind: /** @type {'dropped'|'lines'} */ ('lines'),

    /** 全部行都打完 */
    done: false,

    /**
     * 撤销栈：每项记录一次"打轴前后的状态"。
     * 退出打轴模式后**保留**（用户可能是临时去看别处）。
     * @type {Array<{index:number, prev:TapRecord|null, prevEditing:number, prevLast:number}>}
     */
    undoStack: [],

    // ── 逐字打轴（增强 LRC）──────────────────────
    /*
     * 【为什么整块另起一套字段，而不是复用 tapped】
     * 逐行与逐字是两套完全不同的草稿：
     *   逐行 = 每行一个时间点（Array<TapRecord|null>）
     *   逐字 = 每行一串字时间（Record<行下标, Array<{c,t}>>）
     * 复用同一份 tapped 的话，切一次模式就会互相覆盖 ——
     * 而用户常常是"先逐行打完、再挑几行逐字精修"，两份草稿都要留着。
     * 字段名也刻意不复用（charMode / charDraft / charUndoStack），
     * 这样任何一处误写都能被读代码的人一眼看出来。
     */

    /** 逐字模式开关（与逐行的 enabled 相互独立） */
    charMode: false,

    /** 逐字打轴当前行（tapTarget 的下标） */
    charLineIndex: 0,

    /** 当前行内的光标：下一个要打轴的字 */
    charCursor: 0,

    /**
     * 逐字草稿：行下标 → 完整字表 [{c, t}]。
     * 未打的字 t 为 null（字表始终完整，光标才不会跳过未打的字）。
     * @type {Record<number, Array<{c:string, t:number|null}>>}
     */
    charDraft: {},

    /**
     * 逐字撤销栈。
     * @type {Array<{lineIndex:number, cursor:number, prevT:number|null, prevLineIndex:number, prevCursor:number}>}
     */
    charUndoStack: [],

    /**
     * 逐字草稿对应的目标类型（'dropped' | 'lines'）。
     * 与 tappedKind 同理：只比长度会张冠李戴，必须连"目标是谁"一起比。
     */
    charTargetKind: /** @type {'dropped'|'lines'} */ ('lines'),

    /** 建立 charDraft 时的目标行数（判断"歌词换了"的第二个依据） */
    charTargetCount: 0,
  }),

  getters: {
    /**
     * **打轴的目标行数组** —— 方案 C 的核心。
     *
     * 规则：打轴永远作用于"没有时间的行"；如果所有行都有时间，才作用于 lines。
     *
     * 【为什么这样定】
     * 打轴的主用户是没有 lrc 的人（有 lrc 的人时间已经定了，不需要打轴）：
     *   - 纯 txt：lines 空、dropped 有内容 → 必须打 dropped（否则完全打不了）
     *   - 纯 lrc：dropped 空 → 落到 lines
     *   - 混合：dropped 才是"缺时间的行"，正是需要补的
     *
     * 【已知代价（用户已确认接受）】
     * 混合文件里**无法重打已经有时间的那几行**，想改只能手改文件。
     * 替代方案（两段都打）会覆盖既有时间，代价更大，已否决。
     *
     * 【已知代价二：混合文件下会"跳行"】
     * droppedLines 只含没时间的行，所以混合文件下的打轴顺序会跳过
     * 中间那些有时间标签的行。例：
     *   [00:12]第一句 / 第二句 / [00:30]第三句 / 第四句
     *   → 目标 = [第二句(line2), 第四句(line4)]
     * 即 line2 → line4，**跳过了 line3**。
     * 这是 B 方案的固有代价，用户已确认接受 ——
     * 选 B 的理由是"不覆盖已有时间"，不是"顺序连续"。
     */
    tapTarget() {
      const lyrics = useLyricsStore()
      return lyrics.droppedLines.length > 0 ? lyrics.droppedLines : lyrics.lines
    },

    /** 目标的类型标识，用于 ensureSize 判断"目标切换了" */
    tapTargetKind() {
      return useLyricsStore().droppedLines.length > 0 ? 'dropped' : 'lines'
    },

    /** 应打的总行数（按目标数组算，不再固定用 lines） */
    totalCount() {
      return this.tapTarget.length
    },

    /** 已打行数 */
    tappedCount(state) {
      return state.tapped.filter(Boolean).length
    },

    /** 打轴进度 0~1；没有可打的行时返回 0 */
    progress(state) {
      const total = this.tapTarget.length
      if (total === 0) return 0
      return state.tapped.filter(Boolean).length / total
    },

    /** 某一行的记录（未打为 null） */
    recordAt(state) {
      return (i) => (i >= 0 && i < state.tapped.length ? state.tapped[i] : null)
    },

    /** 是否还能撤销 */
    canUndo: (state) => state.undoStack.length > 0,

    // ── 逐字（增强 LRC）────────────────────────

    /** 当前逐字行的完整字表（未拆过则空数组） */
    charChars(state) {
      const chars = state.charDraft[state.charLineIndex]
      return Array.isArray(chars) ? chars : []
    },

    /** 当前逐字行已打轴的字数 */
    charTimedCount(state) {
      const chars = state.charDraft[state.charLineIndex]
      return countTimedChars(chars)
    },

    /**
     * 逐字打轴的进度 0~1（当前行内）。
     *
     * 【为什么按"字"而不是按"行"】
     * 逐字模式下用户关心的就是这一行还剩几个字，按行算会一直停在 0。
     * 全曲进度由 charOverallProgress 另给。
     */
    charLineProgress() {
      const total = this.charChars.length
      if (total === 0) return 0
      return this.charTimedCount / total
    },

    /** 全曲逐字进度：已打字数 / 总字数 */
    charOverallProgress(state) {
      let timed = 0
      let total = 0
      for (const key of Object.keys(state.charDraft)) {
        const chars = state.charDraft[key]
        if (!Array.isArray(chars)) continue
        total += chars.length
        timed += countTimedChars(chars)
      }
      if (total === 0) return 0
      return timed / total
    },

    /** 逐字草稿是否为空（决定要不要提示"已保存"） */
    charHasDraft(state) {
      return Object.keys(state.charDraft).length > 0
    },

    /** 逐字是否还能撤销 */
    charCanUndo: (state) => state.charUndoStack.length > 0,

    /** 当前逐字行是否已经打完（光标停在末尾之后） */
    charLineDone() {
      const chars = this.charChars
      if (chars.length === 0) return false
      return this.charTimedCount >= chars.length
    },
  },

  actions: {
    /**
     * 打开打轴模式。
     * 首次进入时按**目标行数组**预填 tapped。
     * @returns {boolean} ensureSize 是否发生了重置（供调用方提示用户）
     */
    enable() {
      const didReset = this.ensureSize()
      this.enabled = true
      this.done = false
      this._save()
      return didReset
    },

    /** 关闭打轴模式（**保留** editingIndex / tapped / undoStack） */
    disable() {
      this.enabled = false
      this._save()
    },

    /** 切换打轴模式 */
    toggle() {
      if (this.enabled) this.disable()
      else this.enable()
      return this.enabled
    },

    /**
     * 确保 tapped 数组与**目标行数组**对齐。
     *
     * 【为什么必须同时比较 kind 与长度 —— 实测过的真 bug】
     * 旧实现只比较长度：
     *   文件1（纯 lrc）: lines=2  → 目标 lines，草稿长度 2
     *   文件2（纯 txt）: dropped=2 → 目标 dropped，长度也是 2
     *   2 === 2 → 判定"已对齐" → **不重置** →
     *   文件2 的 droppedLines[0] 拿到文件1 的 lines[0] 的草稿时间。
     * 所以 kind 变了就一定要重置。
     *
     * 【为什么目标变了是"重新开草稿"而不是"截断保留"】
     * lines[0] 与 droppedLines[0] 是**完全不同的两行**，
     * 保留下标相同的旧记录等于张冠李戴。
     * 旧实现那种"保留 min(n, old) 项"在单一目标下没问题，
     * 换成可切换目标后就是错的。
     *
     * @returns {boolean} 是否发生了重置（供调用方弹提示）
     */
    ensureSize() {
      const n = this.tapTarget.length
      const kind = this.tapTargetKind
      if (this.tapped.length === n && this.tappedKind === kind) return false

      // 目标切换（或行数变化）→ 重新开一份干净草稿
      this.tapped = new Array(n).fill(EMPTY)
      this.tappedKind = kind
      this.editingIndex = 0
      this.lastTappedIndex = -1
      this.undoStack = []
      this.done = false
      this._save()
      return true
    },

    /**
     * 吸附容差（毫秒）。超出这个距离就不吸，原样记录。
     * 导出让验收脚本与将来的批量吸附共用同一个值。
     */
    snapToleranceMs() {
      return SNAP_TOLERANCE_MS
    },

    /**
     * 按当前 settings.sync 把秒数吸附到最近的节拍上。
     *
     * 【不碰 locked】
     * locked 的含义是"用户手动 ←/→ 微调过"。它只在**批量重吸附**时有意义，
     * 而本轮没有批量重吸附。用户重新按空格覆盖一行 = 用户主动重打这一行，
     * 本来就该按吸附规则重新处理，所以这里**完全不读 locked**。
     * （beat.js 里的 canSnap 同理，本轮不调用。）
     *
     * @param {number} tSec 原始时间（秒）
     * @returns {{t:number, beat:number|null}}
     */
    snapToGrid(tSec) {
      const none = { t: tSec, beat: null }
      const sync = useSettingsStore().settings.sync
      if (sync.snap === 'none') return none

      const v = validateBpm(sync.bpm)
      if (!v.ok) return none

      const grid = beatTimes({
        bpm: v.value,
        firstBeatMs: Number(sync.firstBeatMs) || 0,
        beats: BEAT_GRID_SIZE,
      })
      if (grid.length === 0) return none

      const tMs = tSec * 1000

      if (sync.snap === 'next') {
        /*
         * 只往后看：找第一个 >= t 的拍点。
         * 【不能直接用 nearestBeat】它前后都看，会把 1.26s 往回吸到 1.25s，
         * 与「下一拍」的语义相反（实测：1.26s 被吸回 1.25s）。
         * 这里手写一次前向二分，不改 beat.js 的算法。
         */
        let lo = 0
        let hi = grid.length - 1
        let pos = grid.length
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (grid[mid] >= tMs) {
            pos = mid
            hi = mid - 1
          } else {
            lo = mid + 1
          }
        }
        if (pos >= grid.length) return none
        const delta = grid[pos] - tMs
        if (delta >= SNAP_TOLERANCE_MS) return none
        return { t: grid[pos] / 1000, beat: pos }
      }

      const hit = nearestBeat(tMs, grid, SNAP_TOLERANCE_MS)
      if (!hit) return none
      return { t: hit.t / 1000, beat: hit.index }
    },

    /**
     * 空格：给当前编辑行打一个时间点，然后编辑行 +1。
     * @param {number} t 当前播放头（秒）
     * @returns {{index:number, t:number, nextIndex:number, isNew:boolean}}
     */
    record(t) {
      this.ensureSize()
      const n = this.tapped.length
      if (n === 0) return { index: -1, t, nextIndex: 0, isNew: false }

      // 越界保护：editingIndex 必须在范围内
      if (this.editingIndex < 0) this.editingIndex = 0
      if (this.editingIndex > n - 1) this.editingIndex = n - 1

      const i = this.editingIndex
      const prev = this.tapped[i]
      const isNew = prev === null

      // 记撤销点（覆盖也进栈 —— 用户可能想退回"没打"的状态）
      this.undoStack.push({
        index: i,
        prev: prev ? { ...prev } : null,
        prevEditing: this.editingIndex,
        prevLast: this.lastTappedIndex,
      })
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()

      // 吸附（可能改写 t，并给出节拍序号）
      const snapped = this.snapToGrid(t)
      this.tapped[i] = { t: snapped.t, beat: snapped.beat, locked: false }
      this.lastTappedIndex = i

      // 编辑行前进；**末行之后不越界**，停在末行
      // （再次按空格会覆盖末行 —— 需求明确要求"不能没反应"）
      if (i < n - 1) {
        this.editingIndex = i + 1
      }

      this.done = this.tapped.every(Boolean)
      this._save()
      return { index: i, t: snapped.t, nextIndex: this.editingIndex, isNew }
    },

    /**
     * 撤销一步。
     * @returns {{index:number, t:number|null}|null} 被撤销的那行；无可撤销时 null
     */
    undo() {
      this.ensureSize()
      const snap = this.undoStack.pop()
      if (!snap) return null
      this.tapped[snap.index] = snap.prev ? { ...snap.prev } : null
      this.editingIndex = snap.prevEditing
      this.lastTappedIndex = snap.prevLast
      this.done = this.tapped.length > 0 && this.tapped.every(Boolean)
      this._save()
      return { index: snap.index, t: snap.prev ? snap.prev.t : null }
    },

    /**
     * ←/→ 微调**刚打完那行**（lastTappedIndex）的时间。
     * 微调过的行标 locked，之后的吸附不得覆盖。
     * @param {number} deltaMs 毫秒（负=提前）
     * @returns {{index:number, t:number}|null}
     */
    nudge(deltaMs) {
      this.ensureSize()
      const i = this.lastTappedIndex
      if (i < 0) return null
      const rec = this.tapped[i]
      if (!rec) return null

      // 记录撤销点（撤销后应回到微调前的值）
      this.undoStack.push({
        index: i,
        prev: { ...rec },
        prevEditing: this.editingIndex,
        prevLast: this.lastTappedIndex,
      })
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()

      const next = Math.max(0, (rec.t + deltaMs / 1000))
      this.tapped[i] = { ...rec, t: next, locked: true }
      this._save()
      return { index: i, t: next }
    },

    /**
     * 撤销时按"固定 5 秒"把播放头往后拉。
     * 基准是**当前播放头**，不是被撤销行的时间 ——
     * 需求已明确改为固定 5 秒（N4 原方案里的"被撤销行前 1 秒"作废）。
     *
     * 注意：不能写成 `static` 方法 —— Pinia 的 actions 是普通对象，
     * `static` 在对象字面量里不是合法语法。
     *
     * @param {number} currentTime 当前播放头（秒）
     * @returns {number} 回滚后的播放头
     */
    rollbackTarget(currentTime) {
      return Math.max(0, currentTime - ROLLBACK_SEC)
    },

    /**
     * 清空全部草稿（应用之后调用）。
     *
     * 【tappedKind 设成 tapTargetKind，而不是固定 'lines'】
     * 应用后 droppedLines 可能仍非空（还有没打完的行）。
     * 若把 kind 归成 'lines'，下次进打轴时 ensureSize 会发现
     * kind 从 'lines' 变成 'dropped' → 误判"歌词已更换"→ 弹出错误文案的 toast。
     * 设成当前真实目标就等价于"已经对齐好了"。
     */
    consumeAll() {
      this.tapped = new Array(this.tapTarget.length).fill(EMPTY)
      this.tappedKind = this.tapTargetKind
      this.undoStack = []
      this.editingIndex = 0
      this.lastTappedIndex = -1
      this.done = false
      this.enabled = false
      this._save()
    },

    /**
     * 用快照整体还原（应用撤销用）。
     * @param {{tapped:any[], tappedKind:string, undoStack:any[], editingIndex:number, lastTappedIndex:number}} snap
     */
    restoreSnapshot(snap) {
      if (!snap) return
      this.tapped = snap.tapped
      this.tappedKind = snap.tappedKind
      this.undoStack = snap.undoStack
      this.editingIndex = snap.editingIndex
      this.lastTappedIndex = snap.lastTappedIndex
      this.done = this.tapped.length > 0 && this.tapped.every(Boolean)
      this.enabled = true
      this._save()
    },

    /** 清空全部草稿（换歌词重来时用） */
    reset() {
      this.editingIndex = 0
      this.lastTappedIndex = -1
      // 按**目标数组**长度预填，不再是固定用 lines
      this.tapped = new Array(this.tapTarget.length).fill(EMPTY)
      this.tappedKind = this.tapTargetKind
      this.done = false
      this.undoStack = []
      this._save()
    },

// ── 逐字打轴（增强 LRC）────────────────────
    /*
     * 【这一整块为什么不碰任何逐行字段】
     * 逐行与逐字必须能并存：用户常常先逐行打完时间轴，
     * 再挑几行做逐字精修。只要有一个函数顺手写了 tapped/editingIndex，
     * 逐行草稿就会被逐字动作污染 —— 而这种污染极难在界面上发现。
     * 所以下面每个动作都只读写 char* 字段，并且各自存各自的键。
     */

    /**
     * 打开逐字模式。
     *
     * 【为什么打开前先 restore】
     * 草稿在 localStorage 里，可能是上次会话存的。
     * 先恢复再判断"目标是否变了"，才能把不匹配的草稿一次性丢掉，
     * 而不是让用户看到一半打过的字、一半没打。
     *
     * @returns {{restored:boolean, discarded:'hash-mismatch'|'corrupt'|'empty'|null}}
     */
    charEnable() {
      const r = this.charRestore()
      this.charMode = true
      this.charEnsureSize()
      return r
    },

    /** 关闭逐字模式（**保留** charDraft / charCursor / charUndoStack） */
    charDisable() {
      this.charMode = false
      this.charSave()
    },

    /** 切换逐字模式 */
    charToggle() {
      if (this.charMode) this.charDisable()
      else this.charEnable()
      return this.charMode
    },

    /**
     * 确保逐字草稿与当前目标行数组对齐。
     *
     * 与 ensureSize 同理：只比长度不够，必须连"目标是谁"一起比 ——
     * 纯 lrc 的 lines 与纯 txt 的 droppedLines 是两批完全不同的行。
     * @returns {boolean} 是否发生了重置
     */
    charEnsureSize() {
      const n = this.tapTarget.length
      const kind = this.tapTargetKind
      if (this.charTargetCount === n && this.charTargetKind === kind) return false

      this.charDraft = {}
      this.charUndoStack = []
      this.charLineIndex = 0
      this.charCursor = 0
      this.charTargetKind = kind
      this.charTargetCount = n
      this.charSave()
      return true
    },

    /**
     * 把 store 的 char* 字段适配成 charProgress 纯函数认识的形状。
     *
     * 【为什么用 defineProperty 而不是传普通对象】
     * 纯函数是**就地改写** state 的（见 charTapStep 注释）。
     * 传普通对象的话，改写落在临时对象上，store 一点没变 —— 界面不会更新，
     * 而纯函数却返回了 ok:true，是最难查的一类"看起来成功了"的失败。
     * 用存取器把读和写都接到 store 上，改写直接落到响应式字段。
     * @returns {any}
     */
    _charStateRef() {
      const self = this
      const ref = {}
      Object.defineProperty(ref, 'drafts', {
        get: () => self.charDraft,
        set: (v) => {
          self.charDraft = v
        },
      })
      Object.defineProperty(ref, 'lineIndex', {
        get: () => self.charLineIndex,
        set: (v) => {
          self.charLineIndex = v
        },
      })
      Object.defineProperty(ref, 'cursor', {
        get: () => self.charCursor,
        set: (v) => {
          self.charCursor = v
        },
      })
      Object.defineProperty(ref, 'undo', {
        get: () => self.charUndoStack,
        set: (v) => {
          self.charUndoStack = v
        },
      })
      return ref
    },

    /**
     * 空格：给光标处的字打一个时间点。
     *
     * 【t 只能来自音频真实播放位置】
     * 调用方传的是 player.currentTime。这里绝不读 performance.now / Date.now，
     * 也绝不按按键间隔累加 —— 变速播放时按键间隔与音频时间不是一回事。
     *
     * @param {number} t 播放头（秒）
     * @returns {{ok:boolean, blocked?:boolean, reason?:string, lineIndex?:number, charIndex?:number, c?:string, t?:number, isNew?:boolean, nextLineIndex?:number, nextCursor?:number}}
     */
    charRecord(t) {
      this.charEnsureSize()
      const r = charTapStep(this._charStateRef(), this.tapTarget, t)
      if (r.ok) this.charSave()
      return r
    },

    /**
     * 撤销一步逐字打轴（连光标一起还原）。
     * @returns {{lineIndex:number, charIndex:number, t:number|null}|null}
     */
    charUndo() {
      const r = charUndoStep(this._charStateRef())
      if (r) this.charSave()
      return r
    },

    /**
     * 重新定位到某一行（用户点行 / 跳转用）。
     * 光标落到"第一个还没打过的字"；都打过了就回到 0（通常是想重打）。
     * @param {number} lineIndex
     * @returns {{lineIndex:number, cursor:number}|null}
     */
    charRelocate(lineIndex) {
      const n = this.tapTarget.length
      if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= n) return null
      const chars = Array.isArray(this.charDraft[lineIndex])
        ? this.charDraft[lineIndex]
        : /** @type {any} */ (this._charBuildDraft(lineIndex))
      const cursor = charRelocateCursor(chars)
      this.charLineIndex = lineIndex
      this.charCursor = cursor
      this.charSave()
      return { lineIndex, cursor }
    },

    /**
     * 把"当前行"展开成字表（进入逐字模式时调用）。
     *
     * 【为什么需要它】
     * charEnsureSize 只保证 charDraft 的**行数**对齐，不建任何一行的字表；
     * 而界面读的是 charChars（= charDraft[charLineIndex]），
     * 未展开时恒为空 → 界面显示"该行无字可打"、光标按钮点了没反应，
     * 用户必须先盲按一次空格界面才活过来。这是实测到的可用性缺陷。
     *
     * 只展开当前一行，不预先拆全曲：2000 行的歌全拆会在进入模式时卡一下，
     * 而用户此刻只看得到当前行。
     *
     * @returns {number} 展开后的字数（0 表示当前行不可打）
     */
    charEnsureCurrentLine() {
      this.charEnsureSize()
      const n = this.tapTarget.length
      if (n === 0) return 0
      // 恢复草稿后 charLineIndex 可能越界（歌词变短了）
      const idx = Math.min(Math.max(0, this.charLineIndex), n - 1)
      this.charLineIndex = idx
      const chars = this._charBuildDraft(idx)
      // 光标落在第一个没打过的字；全打过则回 0（通常是想重打）
      if (!Number.isFinite(this.charCursor) || this.charCursor > chars.length - 1) {
        this.charCursor = charRelocateCursor(chars)
      }
      return chars.length
    },

    /**
     * 建（或取）某一行的完整字表。
     * 单独抽出来，是为了让"只是把某行展开成字"与"打一个时间点"分开：
     * 界面在逐字模式下要显示每行的字，不能靠按空格来触发。
     * @param {number} lineIndex
     * @returns {Array<{c:string, t:number|null}>}
     */
    _charBuildDraft(lineIndex) {
      const line = this.tapTarget[lineIndex]
      if (!line || typeof line.text !== 'string') return []
      const existing = this.charDraft[lineIndex]
      if (Array.isArray(existing) && existing.length > 0) return existing
      const chars = splitChars(line.text)
      this.charDraft[lineIndex] = chars
      return chars
    },

    /**
     * 清空逐字草稿（"重新打这一行/全部"用）。
     * @param {'line'|'all'} scope
     */
    charReset(scope) {
      if (scope === 'line') {
        delete this.charDraft[this.charLineIndex]
        this.charCursor = 0
      } else {
        this.charDraft = {}
        this.charLineIndex = 0
        this.charCursor = 0
      }
      this.charUndoStack = []
      this.charSave()
    },

    // ── 逐字草稿持久化（localStorage）──────────

    /**
     * 存逐字草稿到 localStorage。
     *
     * 【为什么逐字用 localStorage，逐行用 sessionStorage】
     * 逐字是**精修**：一行十几个字，打错一个要重来十几次，
     * 用户很可能分几次做完，关掉标签页也要留着。
     * 逐行是粗打，一次能打完，sessionStorage 的"关掉就干净"更合适。
     * 两者的键也完全不同，互不影响。
     */
    charSave() {
      try {
        localStorage.setItem(
          CHAR_STORAGE_KEY,
          serializeCharState(
            { drafts: this.charDraft, lineIndex: this.charLineIndex, cursor: this.charCursor },
            charDraftTextHash(this.tapTarget),
          ),
        )
      } catch {
        /* 隐私模式等场景写不进去就算了，不影响功能 */
      }
    },

    /**
     * 从 localStorage 恢复逐字草稿。
     *
     * 【指纹不符必须整份丢弃】
     * 逐字时间的下标含义完全由正文决定。歌词改过一个字，
     * 旧草稿套上去就是错位的，而错位的时间轴比没有时间轴更难查 ——
     * 所以宁可丢掉并明确告诉用户，也不做"尽力匹配"。
     *
     * @returns {{restored:boolean, discarded:'hash-mismatch'|'corrupt'|'empty'|'invalid'|null}}
     */
    charRestore() {
      let raw = null
      try {
        raw = localStorage.getItem(CHAR_STORAGE_KEY)
      } catch {
        return { restored: false, discarded: null }
      }
      const parsed = parseCharState(raw, charDraftTextHash(this.tapTarget))
      if (!parsed.ok) {
        return { restored: false, discarded: parsed.reason === 'empty' ? null : /** @type {any} */ (parsed.reason) }
      }

      const aligned = alignSavedDrafts(parsed.drafts, this.tapTarget)
      if (Object.keys(aligned).length === 0) return { restored: false, discarded: null }

      this.charDraft = aligned
      this.charTargetKind = this.tapTargetKind
      this.charTargetCount = this.tapTarget.length
      // 恢复的光标可能指到不存在的行/字上（歌词变短），夹回合法范围
      const li = Number.isFinite(parsed.lineIndex) ? Math.trunc(parsed.lineIndex) : 0
      this.charLineIndex = Math.min(Math.max(0, li), Math.max(0, this.tapTarget.length - 1))
      const chars = aligned[this.charLineIndex]
      const cur = Number.isFinite(parsed.cursor) ? Math.trunc(parsed.cursor) : 0
      this.charCursor = Array.isArray(chars) ? Math.min(Math.max(0, cur), chars.length) : 0
      return { restored: true, discarded: null }
    },

    // ── sessionStorage 持久化 ────────────────────
    // 为什么用 sessionStorage 而不是 localStorage：
    // 打轴是临时工作，"刷新不丢"但"关掉标签页就干净"最符合直觉。
    // 存 localStorage 会让半成品草稿跨会话残留，几天后回来看到一堆莫名其妙的打点。

    _save() {
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            editingIndex: this.editingIndex,
            lastTappedIndex: this.lastTappedIndex,
            tapped: this.tapped,
            tappedKind: this.tappedKind,
            undoStack: this.undoStack,
          }),
        )
      } catch {
        /* 隐私模式等场景写不进去就算了，不影响功能 */
      }
    },

    /**
     * 从 sessionStorage 恢复（enabled 不恢复：刷新后不进打轴模式）。
     *
     * 【lastTappedIndex 故意不恢复】
     * 它是"刚刚打完的那一行"这种**瞬时**状态，刷新后不该还亮着 ——
     * 否则用户刷新一下，看到的是一行莫名其妙的蓝色，
     * 而自己完全没印象刚打过它。
     * 刷新后回到 -1（没有任何行高亮）才是对的。
     *
     * 【tappedKind 必须恢复，且与当前目标不一致时丢弃草稿】
     * 用户可能在上次会话打了纯 txt 的草稿，这次打开的是另一个 lrc 文件 ——
     * 那份草稿的下标含义完全不同，套上去就是张冠李戴。
     */
    restore() {
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        if (!raw) return
        const d = JSON.parse(raw)
        // 先把 kind 写进去，好让后面的 ensureSize 能正确判断"目标是否变了"
        if (d.tappedKind === 'dropped' || d.tappedKind === 'lines') this.tappedKind = d.tappedKind
        if (Array.isArray(d.tapped)) this.tapped = d.tapped
        if (Number.isFinite(d.editingIndex)) this.editingIndex = d.editingIndex
        if (Array.isArray(d.undoStack)) this.undoStack = d.undoStack
        this.lastTappedIndex = -1

        // 目标与恢复的草稿不匹配时，ensureSize 会重置（长度或 kind 任一不符）
        this.ensureSize()
        this.done = this.tapped.length > 0 && this.tapped.every(Boolean)
      } catch {
        /* 数据损坏就当没有，从头开始 */
      }
    },
  },
})
