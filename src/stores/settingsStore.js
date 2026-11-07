import { defineStore } from 'pinia'
import { createDefaultSettings, migrateLegacyBackground, sanitizeSettings, toCssVars } from '@/core/settings'
import { createSettingsStorage, createSettingsWriter } from '@/core/persist'
import { CODES } from '@/core/errors'

/**
 * 设置中心。
 *
 * 阶段 3 起接入 localStorage 持久化：
 *  - 读取时逐字段兜底（sanitizeSettings），任何脏数据都不会白屏
 *  - 写入做 300ms 防抖，避免拖滑杆时把 localStorage 写爆
 *  - 隐私模式/配额满时静默降级为"不持久化"，并通过 toast 告知一次
 */
export const useSettingsStore = defineStore('settings', {
  state: () => {
    const storage = createSettingsStorage(typeof localStorage !== 'undefined' ? localStorage : null)

    const read = storage.read()
    /** 读取失败的原因，供 UI 提示（empty 是正常的首次访问，不提示） */
    const loadIssue = read.ok ? '' : read.reason === 'empty' ? '' : read.reason

    return {
      /**
       * @type {import('@/core/settings').Settings}
       *
       * 【为什么要再过一次 migrateLegacyBackground】
       * 默认值只对首次使用的人生效；老用户的 localStorage 里存的是旧默认
       * （深空蓝 #0b0e14），不清洗就永远看不到"默认改成纯黑"这件事。
       */
      settings: read.ok ? migrateLegacyBackground(sanitizeSettings(read.value)) : createDefaultSettings(),

      /** 设置抽屉开关 */
      drawerOpen: false,

      /** 持久化存储包装（含 available 标志） */
      _storage: storage,
      /** 防抖写入器（首次保存时创建） */
      _writer: null,

      /** 最近一次持久化是否失败，供 UI 提示 */
      persistError: '',
      /** 载入时发现的问题（corrupt / unavailable） */
      loadIssue,
    }
  },

  getters: {
    cssVars(state) {
      return toCssVars(state.settings)
    },
    reduceMotion(state) {
      return state.settings.motion.reduceMotion
    },
    /** 持久化是否可用（隐私模式会不可用） */
    persistAvailable(state) {
      return state._storage.available
    },
  },

  actions: {
    /** 懒创建写入器（Pinia state 里不适合放闭包，首次保存时再建） */
    _ensureWriter() {
      if (this._writer) return this._writer
      this._writer = createSettingsWriter(this._storage, {
        debounceMs: 300,
        onResult: (result) => {
          this.persistError = result.reason ?? 'failed'
        },
      })
      return this._writer
    },

    /** 请求保存（防抖） */
    _persist() {
      if (!this._storage.available) return
      this._ensureWriter().save(this.settings)
    },

    /**
     * 按路径改单个字段，例如 set('font.size', 48)。
     * 走 sanitize 兜底，保证任何输入都落回合法范围。
     * @param {string} path
     * @param {any} value
     */
    set(path, value) {
      const parts = path.split('.')
      const draft = JSON.parse(JSON.stringify(this.settings))
      let cur = draft
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
        cur = cur[parts[i]]
      }
      cur[parts.at(-1)] = value
      this.settings = sanitizeSettings(draft)
      this._persist()
    },

    /** 批量改多个字段（一次 sanitize、一次持久化） */
    setMany(patch) {
      const draft = JSON.parse(JSON.stringify(this.settings))
      for (const [path, value] of Object.entries(patch)) {
        const parts = path.split('.')
        let cur = draft
        for (let i = 0; i < parts.length - 1; i++) {
          if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
          cur = cur[parts[i]]
        }
        cur[parts.at(-1)] = value
      }
      this.settings = sanitizeSettings(draft)
      this._persist()
    },

    /** 整体替换（导入项目时用）。 */
    replace(raw) {
      this.settings = sanitizeSettings(raw)
      this._persist()
    },

    /**
     * 恢复默认值，并**清空 localStorage**。
     * 验收要求"重置后 localStorage 被清空"，因此必须真正 removeItem，
     * 而不是写一份默认值进去。
     */
    reset() {
      // 先取消待写的防抖任务，否则重置后旧值会被写回去
      this._writer?.cancel()
      this.settings = createDefaultSettings()
      const result = this._storage.remove()
      this.persistError = result.ok ? '' : (result.reason ?? 'failed')
    },

    /** 立即落盘（页面隐藏/关闭前调用） */
    flush() {
      this._writer?.flushNow()
    },

    openDrawer() {
      this.drawerOpen = true
    },
    closeDrawer() {
      this.drawerOpen = false
    },
    toggleDrawer() {
      this.drawerOpen = !this.drawerOpen
    },

    /** 取载入问题的提示消息码（供组件转成 toast） */
    loadIssueCode() {
      if (this.loadIssue === 'corrupt') return CODES.SETTINGS_CORRUPT
      if (this.loadIssue === 'unavailable') return CODES.SETTINGS_UNAVAILABLE
      return ''
    },

    /** 已提示过就清掉，避免重复弹 */
    clearLoadIssue() {
      this.loadIssue = ''
    },
  },
})
