// @ts-check
/**
 * 统一错误码与用户可读文案。
 * 原则：面向用户的文案必须说"怎么办"，而不是抛技术名词。
 */

/** @typedef {{ code: string, level: 'error'|'warn'|'info', message: string, detail?: string, hint?: string }} AppMessage */

export const CODES = {
  // 文件 / 导入
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_READ_FAIL: 'FILE_READ_FAIL',
  FILE_TYPE_UNSUPPORTED: 'FILE_TYPE_UNSUPPORTED',
  NO_FILE: 'NO_FILE',
  // LRC
  LRC_EMPTY: 'LRC_EMPTY',
  LRC_NO_TIME_TAGS: 'LRC_NO_TIME_TAGS',
  LRC_DUPLICATE_TIME: 'LRC_DUPLICATE_TIME',
  LRC_TRANSLATION_DETECTED: 'LRC_TRANSLATION_DETECTED',
  LRC_NEGATIVE_TIME: 'LRC_NEGATIVE_TIME',
  LRC_COUNT_MISMATCH: 'LRC_COUNT_MISMATCH',
  LRC_ENCODING_FALLBACK: 'LRC_ENCODING_FALLBACK',
  LRC_ENHANCED_DROPPED: 'LRC_ENHANCED_DROPPED',
  LRC_ENHANCED_MISMATCH: 'LRC_ENHANCED_MISMATCH',
  // 音频
  AUDIO_DECODE_FAIL: 'AUDIO_DECODE_FAIL',
  AUDIO_NOT_LOADED: 'AUDIO_NOT_LOADED',
  // 设置 / 项目
  SETTINGS_CORRUPT: 'SETTINGS_CORRUPT',
  SETTINGS_UNAVAILABLE: 'SETTINGS_UNAVAILABLE',
  SETTINGS_SAVE_FAILED: 'SETTINGS_SAVE_FAILED',
  PROJECT_SCHEMA_INVALID: 'PROJECT_SCHEMA_INVALID',
  PROJECT_NOT_OBJECT: 'PROJECT_NOT_OBJECT',
  // 导出
  MEDIATYPE_UNSUPPORTED: 'MEDIATYPE_UNSUPPORTED',
  TRANSPARENT_UNSUPPORTED: 'TRANSPARENT_UNSUPPORTED',
  RECORD_ABORTED: 'RECORD_ABORTED',
  // 通用
  UNKNOWN: 'UNKNOWN',
}

/** @type {Record<string, Omit<AppMessage,'code'|'detail'>>} */
const TEMPLATES = {
  [CODES.FILE_TOO_LARGE]: {
    level: 'warn',
    message: '文件较大，解析可能需要几秒钟',
    hint: '期间页面可能短暂无响应，请勿关闭标签页。',
  },
  [CODES.FILE_READ_FAIL]: {
    level: 'error',
    message: '文件读取失败',
    hint: '请确认文件未被其他程序占用，然后重试。',
  },
  [CODES.FILE_TYPE_UNSUPPORTED]: {
    level: 'error',
    message: '不支持这种文件类型',
    hint: '音频请选择 mp3 / m4a / wav / ogg / flac；歌词请选择 .lrc 或 .txt。',
  },
  [CODES.NO_FILE]: {
    level: 'info',
    message: '尚未选择文件',
  },
  [CODES.LRC_EMPTY]: {
    level: 'warn',
    message: '这个歌词文件是空的',
    hint: '请检查文件内容，或换一个文件。',
  },
  [CODES.LRC_NO_TIME_TAGS]: {
    level: 'warn',
    message: '没有找到任何时间标签',
    hint: '已按纯文本载入。你可以进入"快速打轴"模式，边听边按空格补上时间。',
  },
  [CODES.LRC_DUPLICATE_TIME]: {
    level: 'warn',
    message: '有歌词行时间完全重复',
    hint: '重复行已全部保留，不会丢失内容；可在打轴模式中微调。',
  },
  [CODES.LRC_TRANSLATION_DETECTED]: {
    level: 'info',
    message: '检测到双语歌词（原文 + 翻译）',
    hint: '同一时间的两行会一起显示，翻译行用较小的字号，不会影响滚动同步。',
  },
  [CODES.LRC_NEGATIVE_TIME]: {
    level: 'warn',
    message: '有歌词行的时间是负数',
    hint: '通常是 offset 设置过大导致，已把这些行对齐到 0 秒。',
  },
  [CODES.LRC_COUNT_MISMATCH]: {
    level: 'warn',
    message: '歌词行数和音频时长看起来不太匹配',
    hint: '可能是歌词与歌曲不是同一份，请确认后再继续。',
  },
  [CODES.LRC_ENCODING_FALLBACK]: {
    level: 'info',
    message: '已按 GBK 编码读取歌词',
    hint: '原文件不是 UTF-8，已自动兼容，中文应显示正常。',
  },
  [CODES.LRC_ENHANCED_DROPPED]: {
    level: 'warn',
    message: '有行的逐字时间无法读取，已按整行歌词显示',
    hint: '这些行的 <mm:ss.xx> 标签写得不规范（例如超出 59 秒）。歌词文字没有丢失，但这一行不会有逐字高亮。',
  },
  [CODES.LRC_ENHANCED_MISMATCH]: {
    level: 'warn',
    message: '有行的逐字时间与歌词字数对不上',
    hint: '已保留解析出来的逐字时间。若高亮位置看着不对，可在打轴模式里重新对齐这一行。',
  },
  [CODES.AUDIO_DECODE_FAIL]: {
    level: 'error',
    message: '这个音频无法播放',
    hint: '浏览器可能不支持该编码。建议改用 mp3 或 m4a 格式。',
  },
  [CODES.AUDIO_NOT_LOADED]: {
    level: 'info',
    message: '请先导入音频',
    hint: '点击顶部的"导入音频"选择你的歌曲文件。',
  },
  [CODES.SETTINGS_CORRUPT]: {
    level: 'warn',
    message: '保存的设置已损坏，已恢复为默认值',
    hint: '这不影响你的音频和歌词文件。',
  },
  [CODES.SETTINGS_UNAVAILABLE]: {
    level: 'warn',
    message: '当前浏览器不允许保存设置',
    hint: '可能开启了隐私模式。本次改动仍然生效，但刷新后会回到默认值。',
  },
  [CODES.SETTINGS_SAVE_FAILED]: {
    level: 'warn',
    message: '设置保存失败',
    hint: '可能是浏览器存储空间已满。本次改动仍然生效，但刷新后可能丢失。',
  },
  [CODES.PROJECT_SCHEMA_INVALID]: {
    level: 'error',
    message: '项目文件格式不正确',
    hint: '请确认选择的是本应用导出的 .json 项目文件。当前内容未被改动。',
  },
  [CODES.PROJECT_NOT_OBJECT]: {
    level: 'error',
    message: '项目文件内容无法识别',
    hint: '文件可能已损坏。当前内容未被改动。',
  },
  [CODES.MEDIATYPE_UNSUPPORTED]: {
    level: 'warn',
    message: '浏览器不支持首选的视频格式，已自动降级',
    hint: '导出结果仍可正常播放，可能体积更大。',
  },
  [CODES.TRANSPARENT_UNSUPPORTED]: {
    level: 'warn',
    message: '透明通道导出在当前浏览器上不可用',
    hint: '这是实验功能：多数浏览器录制时会丢弃透明信息。请改用绿幕或黑幕。',
  },
  [CODES.RECORD_ABORTED]: {
    level: 'info',
    message: '录制已取消',
  },
  [CODES.UNKNOWN]: {
    level: 'error',
    message: '出现了一个未预期的问题',
    hint: '请刷新页面重试。若问题持续，请把控制台报错反馈给我。',
  },
}

/**
 * 由错误码生成标准消息对象。
 * @param {string} code
 * @param {string} [detail] 追加的具体信息，如文件名、行号
 * @returns {AppMessage}
 */
export function makeMessage(code, detail) {
  const tpl = TEMPLATES[code] ?? TEMPLATES[CODES.UNKNOWN]
  /** @type {AppMessage} */
  const msg = { code, level: tpl.level, message: tpl.message }
  if (tpl.hint) msg.hint = tpl.hint
  if (detail) msg.detail = detail
  return msg
}

/**
 * 把任意异常转成用户可读消息。
 * @param {unknown} err
 * @param {string} [fallbackCode]
 * @returns {AppMessage}
 */
export function fromError(err, fallbackCode = CODES.UNKNOWN) {
  const detail = err instanceof Error ? err.message : String(err ?? '')
  return makeMessage(fallbackCode, detail)
}
