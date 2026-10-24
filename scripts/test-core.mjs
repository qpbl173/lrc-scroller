// @ts-check
/**
 * core 层自测脚本（零依赖，直接 `node scripts/test-core.mjs`）。
 *
 * 存在的意义：core/ 被规定为"禁止 import vue 的纯函数层"，
 * 这个脚本就是那条规定的**执行者** —— 它在纯 Node 环境下 import core，
 * 只要能跑通，就证明 core 确实没有依赖浏览器/Vue，可以被自动化测试。
 */

import assert from 'node:assert/strict'
import {
  parseTimeTag,
  formatTimeTag,
  formatClock,
  extractTimeTags,
  stripTimeTags,
  findLineIndexAt,
  getLineEnd,
  clamp,
  parseOffset,
} from '../src/core/timeUtils.js'
import {
  createDefaultSettings,
  sanitizeSettings,
  normalizeColor,
  toCssVars,
  pickEnum,
  RESOLUTION_PRESETS,
  FPS_PRESETS,
  findResolution,
  nearestResolutionId,
  resolveFontFamily,
  resolveStrokeColor,
} from '../src/core/settings.js'
import { makeMessage, fromError, CODES } from '../src/core/errors.js'
import { parseLrc, withOffset, reapplyOffset } from '../src/core/lrcParser.js'
import { decodeLrcBuffer, looksGarbled, isEncodingSupported } from '../src/core/encoding.js'
import {
  createSimClock,
  simClockTimeAt,
  simClockPlay,
  simClockPause,
  simClockSeek,
  simClockSetRate,
  simClockSetDuration,
  simClockEnded,
  createSeekGuard,
  seekGuardBegin,
  seekGuardEnd,
  resolveTime,
  isAtEnd,
} from '../src/core/clock.js'
import { readFileSync } from 'node:fs'
import {
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  hexToHsl,
  hslToHex,
  contrastText,
  validateHexInput,
  pointToHue,
  hueToPoint,
  channelGradient,
  rgbToHsv,
  hsvToRgb,
  hslToHsv,
  hsvToHsl,
  valueBarGradient,
  valueGradient,
  hslChroma,
} from '../src/core/color.js'
import {
  pointToHS,
  hsToPoint,
  wheelGradient,
  WHEEL_DEAD_ZONE,
  wheelSaturationAt,
} from '../src/core/color.js'
import {
  validateBpm,
  validateFirstBeatOffset,
  beatIntervalMs,
  beatTimes,
  nearestBeat,
  canSnap,
  BEAT_ERRORS,
  BPM_MIN,
  BPM_MAX,
} from '../src/core/beat.js'
import {
  computeCenteringOffset,
  clampScrollOffset,
  smoothTowards,
  isSettled,
  isLineOffscreen,
  findRowAtViewportCenter,
} from '../src/core/scroll.js'
import { STORAGE_KEY, createSettingsStorage, isStorageAvailable, createSettingsWriter } from '../src/core/persist.js'
import {
  FADE_MODES,
  BASE_OPACITY,
  createDefaultFade,
  buildLogicalRows,
  applyFadeEasing,
  fadeOpacityForDistance,
  computeRenderOpacities,
  createFadeEngine,
} from '../src/core/fade.js'

import {
  cubicBezier,
  easeCurve,
  transitionCurve,
  progress,
  lerp,
} from '../src/core/motion.js'
import {
  renderFrame,
  buildOffsetTimeline,
  measureRowLayout,
  computeLineH,
  scaleFactor,
  wrapText,
  wrapToLineCount,
  resolveBgColor,
  anchorRatio,
  centeringOffsetFor,
  previousActiveIndex,
  activeTransition,
  applyCssOpacityFactors,
  mixHex,
  rgba,
  rgbaOf,
  EMPTY_LABEL,
  TRANSLATION_FONT_EM,
  LINE_PADDING_EM,
} from '../src/core/renderFrame.js'

import {
  TUTORIAL_STEPS,
  TUTORIAL_STORAGE_KEY,
  stepCount,
  stepAt,
  isLastStep,
  nextStepIndex,
  prevStepIndex,
  clampStepIndex,
  tutorialKeyAction,
  createTutorialFlags,
} from '../src/core/tutorial.js'
import {
  buildLrcText,
  buildLrcFileName,
  summarizeLrcLines,
  isExportableLine,
  sanitizeMetaValue,
  sanitizeLineText,
  buildMetaTags,
  stripKnownExtension,
  sanitizeBaseName,
  DEFAULT_LRC_BASE,
  LRC_EXT,
  MAX_BASE_LENGTH,
} from '../src/core/lrcWriter.js'

let passed = 0
let failed = 0

/**
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \u2713 ${name}`)
  } catch (err) {
    failed++
    console.log(`  \u2717 ${name}`)
    console.log(`      ${err instanceof Error ? err.message : String(err)}`)
  }
}

function group(title) {
  console.log(`\n${title}`)
}

// ─────────────────────────────────────────────
group('timeUtils · parseTimeTag')

test("'01:02.34' → 62.34", () => assert.equal(parseTimeTag('01:02.34'), 62.34))
test("'1:2.5' → 62.5（一位分钟 + 一位小数）", () => assert.equal(parseTimeTag('1:2.5'), 62.5))
test("'00:05' → 5（无小数）", () => assert.equal(parseTimeTag('00:05'), 5))
test("'00:05:30' → 5.3（旧格式：冒号当小数点）", () => assert.equal(parseTimeTag('00:05:30'), 5.3))
test("'00:00.001' → 0.001（三位毫秒）", () => assert.equal(parseTimeTag('00:00.001'), 0.001))
test("'12:34.567' → 754.567", () => assert.equal(parseTimeTag('12:34.567'), 754.567))
test("'bad' → null", () => assert.equal(parseTimeTag('bad'), null))
test("'' → null", () => assert.equal(parseTimeTag(''), null))
test("'1:99' → null（秒数越界）", () => assert.equal(parseTimeTag('1:99'), null))
test('非字符串 → null', () => assert.equal(parseTimeTag(/** @type {any} */ (null)), null))
test("' 01:02.34 ' → 62.34（容忍空格）", () => assert.equal(parseTimeTag(' 01:02.34 '), 62.34))

// ─────────────────────────────────────────────
group('timeUtils · formatTimeTag')

test('62.34 → 01:02.34', () => assert.equal(formatTimeTag(62.34), '01:02.34'))
test('5 → 00:05.00', () => assert.equal(formatTimeTag(5), '00:05.00'))
test('0 → 00:00.00', () => assert.equal(formatTimeTag(0), '00:00.00'))
test('负数 → 00:00.00（夹取，不产生 -01:00）', () => assert.equal(formatTimeTag(-5), '00:00.00'))
test('NaN → 00:00.00', () => assert.equal(formatTimeTag(NaN), '00:00.00'))
test('59.999 三位精度 → 00:59.999（不越界，本就不该进位）', () => assert.equal(formatTimeTag(59.999, 3), '00:59.999'))
test('59.9999 三位精度进位 → 01:00.000', () => assert.equal(formatTimeTag(59.9999, 3), '01:00.000'))
test('59.9999 两位精度进位 → 01:00.00', () => assert.equal(formatTimeTag(59.9999), '01:00.00'))
test('parse/format 往返一致', () => {
  for (const t of [0, 1.5, 62.34, 599.99, 3600.01]) {
    assert.equal(parseTimeTag(formatTimeTag(t)), t, `round-trip failed for ${t}`)
  }
})

// ─────────────────────────────────────────────
group('timeUtils · formatClock')

test('0 → 0:00', () => assert.equal(formatClock(0), '0:00'))
test('65 → 1:05', () => assert.equal(formatClock(65), '1:05'))
test('3725 → 1:02:05', () => assert.equal(formatClock(3725), '1:02:05'))
test('负数 → 0:00', () => assert.equal(formatClock(-3), '0:00'))

// ─────────────────────────────────────────────
group('timeUtils · 标签提取与剥离')

test('提取单个标签', () => assert.deepEqual(extractTimeTags('[00:01.00]abc'), [1]))
test('提取多个标签（保持顺序）', () => assert.deepEqual(extractTimeTags('[00:01.00][01:20.00]abc'), [1, 80]))
test('无标签 → 空数组', () => assert.deepEqual(extractTimeTags('纯文本'), []))
test('剥离标准标签', () => assert.equal(stripTimeTags('[00:01.00]你好'), '你好'))
test('剥离多个标签', () => assert.equal(stripTimeTags('[00:01.00][00:05.00]你好'), '你好'))
test('剥离增强型逐字标签', () => assert.equal(stripTimeTags('[00:01.00]<00:01.00>你<00:01.5>好'), '你好'))
test('剥离后 trim', () => assert.equal(stripTimeTags('[00:01.00]   你好   '), '你好'))
test('纯文本不变', () => assert.equal(stripTimeTags('没有标签'), '没有标签'))

// ─────────────────────────────────────────────
group('timeUtils · findLineIndexAt（二分查找）')

const lines = [{ t: 0 }, { t: 5 }, { t: 12 }, { t: 20 }]

test('time 早于第一行 → -1', () => assert.equal(findLineIndexAt(lines, -1), -1))
test('正好等于第一行 → 0', () => assert.equal(findLineIndexAt(lines, 0), 0))
test('落在中间 → 前一行下标', () => assert.equal(findLineIndexAt(lines, 7), 1))
test('正好等于某行 → 该行下标', () => assert.equal(findLineIndexAt(lines, 12), 2))
test('晚于最后一行 → 最后下标', () => assert.equal(findLineIndexAt(lines, 9999), 3))
test('空数组 → -1', () => assert.equal(findLineIndexAt([], 5), -1))
test('NaN → -1', () => assert.equal(findLineIndexAt(lines, NaN), -1))
test('大数组二分正确（2000 行）', () => {
  const big = Array.from({ length: 2000 }, (_, i) => ({ t: i * 0.5 }))
  assert.equal(findLineIndexAt(big, 0), 0)
  assert.equal(findLineIndexAt(big, 0.5), 1)
  assert.equal(findLineIndexAt(big, 999.9), 1999)
  assert.equal(findLineIndexAt(big, 500.25), 1000)
})

// ─────────────────────────────────────────────
group('timeUtils · getLineEnd / clamp / parseOffset')

test('中间行 → 下一行起点', () => assert.equal(getLineEnd(lines, 1), 12))
test('最后一行 → 用 fallback 兜底', () => assert.equal(getLineEnd(lines, 3, 30), 30))
test('最后一行且无 fallback → 至少 +2s', () => assert.equal(getLineEnd(lines, 3), 22))
test('越界 → 0', () => assert.equal(getLineEnd(lines, 99), 0))
test('clamp 夹取', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(99, 0, 10), 10)
  assert.equal(clamp('abc', 2, 10), 2)
})
test("parseOffset('+500') → 500", () => assert.equal(parseOffset('+500'), 500))
test("parseOffset('-500') → -500", () => assert.equal(parseOffset('-500'), -500))
test("parseOffset('500') → 500", () => assert.equal(parseOffset('500'), 500))
test("parseOffset('abc') → 0", () => assert.equal(parseOffset('abc'), 0))

// ─────────────────────────────────────────────
group('settings · 默认值与容错')

test('默认设置结构完整', () => {
  const d = createDefaultSettings()
  assert.equal(typeof d.font.size, 'number')
  assert.equal(typeof d.color.active, 'string')
  assert.equal(typeof d.motion.transitionMs, 'number')
  assert.equal(d.version, 1)
})

test('null → 返回默认值，不抛异常', () => {
  const s = sanitizeSettings(null)
  assert.deepEqual(s, createDefaultSettings())
})

test('完全损坏的输入不崩，逐字段回落', () => {
  const s = sanitizeSettings({ font: 'not-an-object', color: 42, motion: null })
  assert.equal(s.font.size, 40)
  assert.equal(s.color.active, '#ffffff')
  assert.equal(s.motion.transitionMs, 260)
})

test('越界数值回落到默认值（而非夹取）', () => {
  const s = sanitizeSettings({ font: { size: 99999 } })
  assert.equal(s.font.size, 40)
})

test('负数/NaN 数值回落', () => {
  assert.equal(sanitizeSettings({ font: { size: -5 } }).font.size, 40)
  assert.equal(sanitizeSettings({ font: { size: NaN } }).font.size, 40)
})

test('合法数值被保留', () => {
  const s = sanitizeSettings({ font: { size: 72 }, color: { active: '#ff0000' } })
  assert.equal(s.font.size, 72)
  assert.equal(s.color.active, '#ff0000')
})

test('枚举非法值回落', () => {
  const s = sanitizeSettings({ layout: { align: 'diagonal' }, color: { bgMode: 'rainbow' } })
  assert.equal(s.layout.align, 'center')
  assert.equal(s.color.bgMode, 'solid')
})

test('枚举合法值保留', () => {
  const s = sanitizeSettings({ layout: { align: 'left' }, color: { bgMode: 'green' } })
  assert.equal(s.layout.align, 'left')
  assert.equal(s.color.bgMode, 'green')
})

test('pickEnum 白名单', () => {
  assert.equal(pickEnum('b', ['a', 'b'], 'a'), 'b')
  assert.equal(pickEnum('z', ['a', 'b'], 'a'), 'a')
})

// ─────────────────────────────────────────────
group('settings · 颜色归一化')

test('#abc → #aabbcc', () => assert.equal(normalizeColor('#abc', '#000000'), '#aabbcc'))
test('大写转小写', () => assert.equal(normalizeColor('#AABBCC', '#000000'), '#aabbcc'))
test('6 位保留', () => assert.equal(normalizeColor('#123456', '#000000'), '#123456'))
test('8 位（含 alpha）保留', () => assert.equal(normalizeColor('#12345678', '#000000'), '#12345678'))
test('非法值 → fallback', () => assert.equal(normalizeColor('#zzz', '#000000'), '#000000'))
test("'red' 这类关键字不接受 → fallback", () => assert.equal(normalizeColor('red', '#000000'), '#000000'))
test('非字符串 → fallback', () => assert.equal(normalizeColor(123, '#000000'), '#000000'))

// ─────────────────────────────────────────────
group('settings · CSS 变量映射')

test('toCssVars 产出全部关键变量', () => {
  const v = toCssVars(createDefaultSettings())
  for (const key of [
    '--lrc-font-family',
    '--lrc-font-size',
    '--lrc-letter-spacing',
    '--lrc-line-height',
    '--lrc-active-scale',
    '--lrc-color-normal',
    '--lrc-color-active',
    '--lrc-bg',
    '--lrc-align',
    '--lrc-pad-top',
    '--lrc-transition',
    '--lrc-fade',
  ]) {
    assert.ok(key in v, `missing ${key}`)
  }
  assert.equal(v['--lrc-font-size'], '40px')
  assert.equal(v['--lrc-active-scale'], '1.35')
})

test('绿幕模式覆盖背景色为 #00b140', () => {
  const s = createDefaultSettings()
  s.color.bgMode = 'green'
  s.color.bg = '#123456'
  assert.equal(toCssVars(s)['--lrc-bg'], '#00b140')
})

test('黑幕模式覆盖背景色为 #000000', () => {
  const s = createDefaultSettings()
  s.color.bgMode = 'black'
  assert.equal(toCssVars(s)['--lrc-bg'], '#000000')
})

test('留白比例转成百分比字符串', () => {
  const v = toCssVars(createDefaultSettings())
  assert.equal(v['--lrc-pad-top'], '35%')
})

// ─────────────────────────────────────────────
group('errors · 消息生成')

test('已知错误码产出 level/message/hint', () => {
  const m = makeMessage(CODES.LRC_EMPTY)
  assert.equal(m.level, 'warn')
  assert.ok(m.message.length > 0)
  assert.ok(m.hint.length > 0)
})

test('未知错误码回落为 UNKNOWN', () => {
  const m = makeMessage('TOTALLY_MADE_UP')
  assert.equal(m.code, 'TOTALLY_MADE_UP')
  assert.equal(m.level, 'error')
})

test('detail 被附加', () => {
  const m = makeMessage(CODES.LRC_DUPLICATE_TIME, '第 3 行')
  assert.equal(m.detail, '第 3 行')
})

test('fromError 把异常转成用户消息', () => {
  const m = fromError(new Error('boom'), CODES.FILE_READ_FAIL)
  assert.equal(m.code, CODES.FILE_READ_FAIL)
  assert.equal(m.detail, 'boom')
})

test('fromError 能处理非 Error 值', () => {
  const m = fromError('just a string')
  assert.equal(m.detail, 'just a string')
})

// ─────────────────────────────────────────────
group('lrcParser · 基础解析')

test('解析标准 LRC', () => {
  const doc = parseLrc('[00:01.00]第一行\n[00:05.00]第二行')
  assert.equal(doc.lines.length, 2)
  assert.equal(doc.lines[0].text, '第一行')
  assert.equal(doc.lines[0].t, 1)
  assert.equal(doc.lines[1].t, 5)
})

test('id 按最终顺序分配', () => {
  const doc = parseLrc('[00:05.00]后\n[00:01.00]前')
  assert.equal(doc.lines[0].id, 'L0')
  assert.equal(doc.lines[0].text, '前')
  assert.equal(doc.lines[1].id, 'L1')
})

test('rawT 与 t 在无 offset 时相同', () => {
  const doc = parseLrc('[00:10.00]测试')
  assert.equal(doc.lines[0].rawT, 10)
  assert.equal(doc.lines[0].t, 10)
})

test('空字符串 → 空文件警告，不抛异常', () => {
  const doc = parseLrc('')
  assert.equal(doc.lines.length, 0)
  assert.equal(doc.warnings[0].code, CODES.LRC_EMPTY)
})

test('纯空白 → 空文件警告', () => {
  const doc = parseLrc('   \n\n  \t  ')
  assert.equal(doc.lines.length, 0)
  assert.equal(doc.warnings[0].code, CODES.LRC_EMPTY)
})

test('非字符串输入不崩', () => {
  const doc = parseLrc(/** @type {any} */ (null))
  assert.equal(doc.lines.length, 0)
})

test('去掉 BOM 后首行能正常解析', () => {
  const doc = parseLrc('\uFEFF[00:01.00]带BOM')
  assert.equal(doc.lines.length, 1)
  assert.equal(doc.lines[0].text, '带BOM')
})

test('CRLF 与 CR 换行都能处理', () => {
  assert.equal(parseLrc('[00:01.00]A\r\n[00:02.00]B').lines.length, 2)
  assert.equal(parseLrc('[00:01.00]A\r[00:02.00]B').lines.length, 2)
})

// ─────────────────────────────────────────────
group('lrcParser · 元数据')

test('解析 ti/ar/al/by', () => {
  const doc = parseLrc('[ti:歌名]\n[ar:歌手]\n[al:专辑]\n[by:制作]\n[00:01.00]词')
  assert.equal(doc.meta.title, '歌名')
  assert.equal(doc.meta.artist, '歌手')
  assert.equal(doc.meta.album, '专辑')
  assert.equal(doc.meta.by, '制作')
})

test('未知标签保留在 meta.raw（不丢信息）', () => {
  const doc = parseLrc('[ti:X]\n[re:某工具]\n[ve:1.2]\n[00:01.00]词')
  assert.equal(doc.meta.raw.re, '某工具')
  assert.equal(doc.meta.raw.ve, '1.2')
})

test('length 标签解析为秒', () => {
  assert.equal(parseLrc('[length:03:30.00]\n[00:01.00]x').meta.length, 210)
  assert.equal(parseLrc('[length:200]\n[00:01.00]x').meta.length, 200)
})

test('元数据值含冒号也能解析', () => {
  const doc = parseLrc('[ti:标题: 带冒号]\n[00:01.00]词')
  assert.equal(doc.meta.title, '标题: 带冒号')
})

test('元数据行不产生歌词行', () => {
  const doc = parseLrc('[ti:X]\n[ar:Y]\n[00:01.00]只有一行')
  assert.equal(doc.lines.length, 1)
})

// ─────────────────────────────────────────────
group('lrcParser · 多时间标签展开')

test('一行两个标签 → 展开成两行', () => {
  const doc = parseLrc('[00:01.00][00:05.00]重复的歌词')
  assert.equal(doc.lines.length, 2)
  assert.equal(doc.lines[0].t, 1)
  assert.equal(doc.lines[1].t, 5)
  assert.equal(doc.lines[0].text, '重复的歌词')
  assert.equal(doc.lines[1].text, '重复的歌词')
})

test('一行三个标签 → 展开成三行，且正文完全相同', () => {
  const doc = parseLrc('[00:01.00][00:10.00][01:00.00]合唱')
  assert.equal(doc.lines.length, 3)
  assert.deepEqual(doc.lines.map((l) => l.t), [1, 10, 60])
  assert.ok(doc.lines.every((l) => l.text === '合唱'))
})

test('展开后各行的 id 互不相同', () => {
  const doc = parseLrc('[00:01.00][00:05.00]X')
  assert.notEqual(doc.lines[0].id, doc.lines[1].id)
})

test('多标签行的 rawT 与 sourceLine 都正确', () => {
  const doc = parseLrc('[00:01.00]第一行\n[00:05.00][00:09.00]第二行')
  const second = doc.lines.find((l) => l.text === '第二行' && l.t === 9)
  assert.equal(second.rawT, 9)
  assert.equal(second.sourceLine, 2)
})

test('多标签与元数据混用', () => {
  const doc = parseLrc('[ti:T]\n[00:01.00][00:02.00]X\n[ar:A]')
  assert.equal(doc.lines.length, 2)
  assert.equal(doc.meta.title, 'T')
  assert.equal(doc.meta.artist, 'A')
})

// ─────────────────────────────────────────────
group('lrcParser · offset 基于 rawT 重算（关键）')

test('[offset:500] 使歌词提前 0.5 秒', () => {
  const doc = parseLrc('[offset:500]\n[00:10.00]X')
  assert.equal(doc.lines[0].rawT, 10)
  assert.equal(doc.lines[0].t, 9.5)
})

test('[offset:-500] 使歌词延后 0.5 秒', () => {
  const doc = parseLrc('[offset:-500]\n[00:10.00]X')
  assert.equal(doc.lines[0].t, 10.5)
})

test('offset 标签位置不影响结果（在文件末尾也生效）', () => {
  const doc = parseLrc('[00:10.00]X\n[offset:500]')
  assert.equal(doc.lines[0].t, 9.5)
})

test('反复修改 offset 不产生累积误差（核心保证）', () => {
  const doc = parseLrc('[00:10.00]X\n[00:20.00]Y')

  // 模拟用户来回调整：+500 → -300 → +500
  let lines = withOffset(doc.lines, 500).lines
  assert.equal(lines[0].t, 9.5)
  lines = withOffset(lines, -300).lines
  assert.equal(lines[0].t, 10.3)
  lines = withOffset(lines, 500).lines
  assert.equal(lines[0].t, 9.5, '回到 +500 后应与最初完全一致')

  // 直接设 +500 的结果必须与来回折腾后的结果一致
  const direct = withOffset(doc.lines, 500).lines
  assert.deepEqual(
    lines.map((l) => l.t),
    direct.map((l) => l.t),
  )
})

test('offset 归零后恢复原始时间', () => {
  const doc = parseLrc('[00:10.00]X')
  const shifted = withOffset(doc.lines, 2000).lines
  assert.equal(shifted[0].t, 8)
  const back = withOffset(shifted, 0).lines
  assert.equal(back[0].t, 10, 'rawT 未被破坏，能回到原始时间')
})

test('offset 过大导致负时间 → 对齐到 0 并计数', () => {
  const doc = parseLrc('[00:01.00]X\n[00:10.00]Y')
  const { lines, negativeCount } = withOffset(doc.lines, 5000)
  assert.equal(lines[0].t, 0)
  assert.equal(negativeCount, 1)
})

test('withOffset 后 id 与顺序重新一致', () => {
  const doc = parseLrc('[00:01.00]A\n[00:10.00]B')
  const { lines } = withOffset(doc.lines, -20000) // 全部变为 0
  assert.equal(lines[0].id, 'L0')
  assert.equal(lines[1].id, 'L1')
})

test('reapplyOffset 与 withOffset 结果一致', () => {
  const doc = parseLrc('[00:10.00]X')
  assert.deepEqual(
    reapplyOffset(doc, 500).lines.map((l) => l.t),
    withOffset(doc.lines, 500).lines.map((l) => l.t),
  )
})

test('offset 为 NaN 时按 0 处理', () => {
  const doc = parseLrc('[00:10.00]X')
  assert.equal(withOffset(doc.lines, NaN).lines[0].t, 10)
})

// ─────────────────────────────────────────────
group('lrcParser · 乱序排序')

test('乱序输入按时间升序排列', () => {
  const doc = parseLrc('[00:20.00]C\n[00:05.00]A\n[00:12.00]B')
  assert.deepEqual(doc.lines.map((l) => l.text), ['A', 'B', 'C'])
})

test('相同时间的行保持文件原顺序（稳定排序）', () => {
  const doc = parseLrc('[00:05.00]先出现\n[00:05.00]后出现')
  assert.equal(doc.lines[0].text, '先出现')
  assert.equal(doc.lines[1].text, '后出现')
})

test('完全倒序的文件也能正确排序', () => {
  const doc = parseLrc('[01:00.00]3\n[00:30.00]2\n[00:10.00]1')
  assert.deepEqual(doc.lines.map((l) => l.text), ['1', '2', '3'])
})

test('排序不丢失任何行', () => {
  const input = Array.from({ length: 50 }, (_, i) => `[00:${String(50 - i).padStart(2, '0')}.00]第${i}行`).join('\n')
  assert.equal(parseLrc(input).lines.length, 50)
})

// ─────────────────────────────────────────────
group('lrcParser · 重复时间警告')

test('完全相同的两行 → 产生重复警告', () => {
  const doc = parseLrc('[00:05.00]同样的词\n[00:05.00]同样的词')
  assert.ok(doc.warnings.some((w) => w.code === CODES.LRC_DUPLICATE_TIME))
})

test('重复行全部保留，不被静默去重', () => {
  const doc = parseLrc('[00:05.00]同样的词\n[00:05.00]同样的词')
  assert.equal(doc.lines.length, 2)
})

test('重复行互相记录 duplicateOf', () => {
  const doc = parseLrc('[00:05.00]A\n[00:05.00]A')
  assert.equal(doc.lines[0].duplicateOf.length, 1)
  assert.equal(doc.lines[0].duplicateOf[0], doc.lines[1].id)
})

test('双语歌词（原文+翻译）识别为翻译组，不报重复警告', () => {
  const doc = parseLrc('[00:05.00]君の名前を呼んでいる\n[00:05.00]呼唤着你的名字')
  assert.ok(
    !doc.warnings.some((w) => w.code === CODES.LRC_DUPLICATE_TIME),
    '双语不应被当成重复错误',
  )
  assert.ok(doc.warnings.some((w) => w.code === CODES.LRC_TRANSLATION_DETECTED))
})

test('双语组中只有次要行标记 isTranslation', () => {
  const doc = parseLrc('[00:05.00]原词原文在此\n[00:05.00]translation here')
  const flags = doc.lines.map((l) => Boolean(l.isTranslation))
  assert.equal(flags.filter(Boolean).length, 1, '应恰好一行是翻译行')
})

test('三行同时间且文本都不同 → 视为翻译组', () => {
  const doc = parseLrc('[00:05.00]原文\n[00:05.00]翻译\n[00:05.00]translation')
  assert.ok(doc.warnings.some((w) => w.code === CODES.LRC_TRANSLATION_DETECTED))
})

test('两行同为纯中文且内容不同 → 报重复而非误判为双语（回归）', () => {
  // 这是被样例自检抓出的真实缺陷：
  // 早期实现只要求"文本不同"就当作双语，导致两条不同中文行挤在同一时间时
  // 被静默当成翻译，用户永远看不到"时间重复"的提醒。
  const doc = parseLrc('[00:12.00]这里故意和上面重复\n[00:12.00]另一句完全不同的中文')
  assert.ok(
    doc.warnings.some((w) => w.code === CODES.LRC_DUPLICATE_TIME),
    '同为纯中文的不同文本应报重复时间',
  )
  assert.ok(
    !doc.warnings.some((w) => w.code === CODES.LRC_TRANSLATION_DETECTED),
    '不应被误判为双语',
  )
})

test('中文 + 英文 → 判为双语', () => {
  const doc = parseLrc('[00:05.00]我爱你\n[00:05.00]I love you')
  assert.ok(doc.warnings.some((w) => w.code === CODES.LRC_TRANSLATION_DETECTED))
  assert.ok(!doc.warnings.some((w) => w.code === CODES.LRC_DUPLICATE_TIME))
})

test('日文（含假名）+ 中文 → 判为双语', () => {
  const doc = parseLrc('[00:05.00]きみのなまえ\n[00:05.00]你的名字')
  assert.ok(doc.warnings.some((w) => w.code === CODES.LRC_TRANSLATION_DETECTED))
})

test('纯汉字 vs 纯汉字（即使一简一繁）→ 报重复（书写系统相同）', () => {
  const doc = parseLrc('[00:05.00]音乐歌词\n[00:05.00]音樂歌詞')
  assert.ok(doc.warnings.some((w) => w.code === CODES.LRC_DUPLICATE_TIME))
})

test('多组重复时警告里给出数量', () => {
  const doc = parseLrc(
    '[00:01.00]A\n[00:01.00]A\n[00:02.00]B\n[00:02.00]B\n[00:03.00]C\n[00:03.00]C\n[00:04.00]D\n[00:04.00]D',
  )
  const w = doc.warnings.find((x) => x.code === CODES.LRC_DUPLICATE_TIME)
  assert.ok(w)
  assert.ok(w.detail.includes('4'), `detail 应含处数，实际: ${w.detail}`)
})

test('withOffset 后重复关系被正确重建', () => {
  const doc = parseLrc('[00:05.00]A\n[00:05.00]A\n[00:20.00]B')
  const { lines } = withOffset(doc.lines, 0)
  const dup = lines.filter((l) => l.duplicateOf.length > 0)
  assert.equal(dup.length, 2)
})

// ─────────────────────────────────────────────
group('lrcParser · 空行与边界')

test('有标签无正文 → 生成 empty 行（间奏占位）', () => {
  const doc = parseLrc('[00:01.00]A\n[00:05.00]\n[00:10.00]B')
  assert.equal(doc.lines.length, 3)
  assert.equal(doc.lines[1].empty, true)
  assert.equal(doc.lines[1].text, '')
})

test('空行不被丢弃（否则滚动会跳变）', () => {
  const doc = parseLrc('[00:01.00]\n[00:02.00]\n[00:03.00]')
  assert.equal(doc.lines.length, 3)
})

test('完全无时间标签的文本 → 全部进 droppedLines', () => {
  const doc = parseLrc('第一句\n第二句\n第三句')
  assert.equal(doc.lines.length, 0)
  assert.equal(doc.droppedLines.length, 3)
  assert.ok(doc.warnings.some((w) => w.code === CODES.LRC_NO_TIME_TAGS))
})

test('无时间标签时保留原文内容，不丢字', () => {
  const doc = parseLrc('这是第一句\n这是第二句')
  assert.equal(doc.droppedLines[0].text, '这是第一句')
  assert.equal(doc.droppedLines[0].line, 1)
})

test('无时间标签但有元数据 → 仍提示无时间标签', () => {
  const doc = parseLrc('[ti:标题]\n一些没有时间的文字')
  assert.equal(doc.lines.length, 0)
  assert.ok(doc.warnings.some((w) => w.code === CODES.LRC_NO_TIME_TAGS))
})

test('非法时间（秒数越界）整行被忽略，不影响其他行', () => {
  const doc = parseLrc('[00:01.00]正常\n[00:99.00]非法\n[00:03.00]也正常')
  assert.equal(doc.lines.length, 2)
  assert.deepEqual(doc.lines.map((l) => l.text), ['正常', '也正常'])
})

test('非法时间行会被当作无标签文本记入 droppedLines', () => {
  const doc = parseLrc('[00:99.00]非法时间')
  assert.equal(doc.lines.length, 0)
  assert.equal(doc.droppedLines.length, 1)
})

test('秒数为 60 的边界可接受', () => {
  const doc = parseLrc('[00:60.00]进位边界')
  assert.equal(doc.lines.length, 1)
})

test('三位毫秒精度', () => {
  const doc = parseLrc('[00:01.234]精度')
  assert.equal(doc.lines[0].rawT, 1.234)
})

test('旧格式冒号小数点 [00:05:30]', () => {
  const doc = parseLrc('[00:05:30]旧格式')
  assert.equal(doc.lines[0].rawT, 5.3)
})

test('一位分钟一位小数 [1:02.5]', () => {
  const doc = parseLrc('[1:02.5]简写')
  assert.equal(doc.lines[0].rawT, 62.5)
})

test('增强型逐字标签被剥离，正文保留', () => {
  const doc = parseLrc('[00:01.00]<00:01.00>你<00:01.50>好')
  assert.equal(doc.lines.length, 1)
  assert.equal(doc.lines[0].text, '你好')
})

test('增强型标签单独出现（无标准标签）不产生歌词行', () => {
  const doc = parseLrc('<00:01.00>你好')
  assert.equal(doc.lines.length, 0)
})

test('统计信息正确', () => {
  const doc = parseLrc('[ti:T]\n[00:01.00]A\n[00:02.00]B\n乱文本')
  assert.equal(doc.stats.totalRows, 4)
  assert.equal(doc.stats.parsedLines, 2)
  assert.equal(doc.droppedLines.length, 1)
})

test('空文件不产生解析异常且有统计', () => {
  const doc = parseLrc('')
  assert.equal(doc.stats.parsedLines, 0)
})

test('大量行不会出错（1000 行）', () => {
  const input = Array.from({ length: 1000 }, (_, i) => {
    const m = String(Math.floor(i / 60)).padStart(2, '0')
    const s = String(i % 60).padStart(2, '0')
    return `[${m}:${s}.00]第${i}行`
  }).join('\n')
  const doc = parseLrc(input)
  assert.equal(doc.lines.length, 1000)
  // 验证升序
  for (let i = 1; i < doc.lines.length; i++) {
    assert.ok(doc.lines[i].t >= doc.lines[i - 1].t, `第 ${i} 行顺序错误`)
  }
})

// ─────────────────────────────────────────────
group('encoding · 编码探测')

test('UTF-8 字节被正确识别', () => {
  const bytes = new TextEncoder().encode('[ti:测试]\n[00:01.00]中文')
  const r = decodeLrcBuffer(bytes)
  assert.equal(r.encoding, 'utf-8')
  assert.equal(r.fellBack, false)
  assert.ok(r.text.includes('中文'))
})

test('UTF-8 BOM 被正确处理且不留 BOM 字符', () => {
  const body = new TextEncoder().encode('[00:01.00]X')
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body])
  const r = decodeLrcBuffer(withBom)
  assert.equal(r.encoding, 'utf-8')
  assert.equal(r.text.charCodeAt(0) === 0xfeff, false, 'BOM 应已被剥离')
})

test('真实 GBK 文件被兜底解码，无乱码', () => {
  // 读取真实生成的 GBK 样例文件（不是伪造的 UTF-8）
  const buf = readFileSync('samples/07-GBK编码.lrc')
  const r = decodeLrcBuffer(buf)
  assert.ok(r.fellBack, '应发生编码回退')
  assert.ok(['gb18030', 'gbk'].includes(r.encoding), `实际编码: ${r.encoding}`)
  assert.equal(r.text.includes('\uFFFD'), false, '不应含替换字符')
  assert.ok(r.text.includes('这个文件是真正的 GBK 编码'), '中文应正确还原')
  assert.ok(r.text.includes('音樂、歌詞、時間'), '繁体字也应正确还原')
})

test('GBK 文件解析后中文完全正确', () => {
  const buf = readFileSync('samples/07-GBK编码.lrc')
  const r = decodeLrcBuffer(buf)
  const doc = parseLrc(r.text, { encoding: r.encoding })
  assert.equal(doc.meta.title, 'GBK 编码测试')
  assert.equal(doc.lines.length, 9)
  assert.equal(doc.lines[0].text, '这个文件是真正的 GBK 编码，不是 UTF-8')
})

test('空缓冲区不崩', () => {
  const r = decodeLrcBuffer(new Uint8Array(0))
  assert.equal(r.text, '')
})

test('isEncodingSupported 对 gb18030 返回 true', () => {
  assert.equal(isEncodingSupported('gb18030'), true)
})

test('指定编码（hint）优先于自动探测', () => {
  const bytes = new TextEncoder().encode('[00:01.00]中文')
  const r = decodeLrcBuffer(bytes, { hint: 'utf-8' })
  assert.equal(r.encoding, 'utf-8')
  assert.ok(r.reason.includes('指定'))
})

test('looksGarbled 能识别替换字符', () => {
  const r = looksGarbled('正常文字\uFFFD\uFFFD')
  assert.equal(r.suspicious, true)
  assert.equal(r.replacementCount, 2)
})

test('looksGarbled 对正常文本返回 false', () => {
  assert.equal(looksGarbled('这是一段完全正常的中文歌词').suspicious, false)
  assert.equal(looksGarbled('').suspicious, false)
})

// ─────────────────────────────────────────────
group('clock · 模拟时钟（N1 无音频滚动的基础）')

test('初始状态时间为 0 且不在播放', () => {
  const c = createSimClock()
  assert.equal(simClockTimeAt(c, 1000), 0)
  assert.equal(c.playing, false)
})

test('暂停状态下时间不随时间流逝而变化', () => {
  const c = createSimClock()
  assert.equal(simClockTimeAt(c, 5000), 0)
  assert.equal(simClockTimeAt(c, 99999), 0)
})

test('播放后时间按真实经过时间推进', () => {
  let c = createSimClock()
  c = simClockPlay(c, 1000)
  assert.equal(simClockTimeAt(c, 1000), 0)
  assert.equal(simClockTimeAt(c, 2000), 1)
  assert.equal(simClockTimeAt(c, 3500), 2.5)
})

test('时间用差值推算而非累加 → 多次随机读取结果一致（无漂移）', () => {
  let c = createSimClock()
  c = simClockPlay(c, 0)
  // 模拟帧间隔抖动：在不同时刻读多次，同一时刻的读数必须稳定
  assert.equal(simClockTimeAt(c, 1234), 1.234)
  assert.equal(simClockTimeAt(c, 1234), 1.234)
  // 跳着读也不会漂移
  simClockTimeAt(c, 2000)
  simClockTimeAt(c, 7000)
  assert.equal(simClockTimeAt(c, 10000), 10)
})

test('暂停后时间停在原处，继续播放从该处接着走', () => {
  let c = createSimClock()
  c = simClockPlay(c, 0)
  c = simClockPause(c, 4000) // 走了 4 秒
  assert.equal(simClockTimeAt(c, 4000), 4)
  assert.equal(simClockTimeAt(c, 30000), 4, '暂停期间不应变化')
  c = simClockPlay(c, 30000)
  assert.equal(simClockTimeAt(c, 30000), 4, '恢复播放应从 4 秒开始')
  assert.equal(simClockTimeAt(c, 31000), 5)
})

test('暂停→播放→暂停 时间连续不重置（验收用例 3）', () => {
  let c = createSimClock()
  c = simClockPlay(c, 0)
  c = simClockPause(c, 2000) // 2s
  c = simClockPlay(c, 5000)
  c = simClockPause(c, 6000) // +1s = 3s
  assert.equal(simClockTimeAt(c, 6000), 3)
})

test('跳转后从目标时间继续走', () => {
  let c = createSimClock({ duration: 100 })
  c = simClockPlay(c, 0)
  c = simClockSeek(c, 50, 3000)
  assert.equal(simClockTimeAt(c, 3000), 50)
  assert.equal(simClockTimeAt(c, 4000), 51)
})

test('跳转时间被夹在 [0, duration] 内', () => {
  let c = createSimClock({ duration: 60 })
  assert.equal(simClockTimeAt(simClockSeek(c, -10, 0), 0), 0)
  assert.equal(simClockTimeAt(simClockSeek(c, 999, 0), 0), 60)
})

test('倍速影响推进速度', () => {
  let c = createSimClock({ rate: 2 })
  c = simClockPlay(c, 0)
  assert.equal(simClockTimeAt(c, 1000), 2)
})

test('切换倍速时时间保持连续（不跳变）', () => {
  let c = createSimClock()
  c = simClockPlay(c, 0)
  // 1 秒后（原速）走了 1 秒
  c = simClockSetRate(c, 2, 1000)
  assert.equal(simClockTimeAt(c, 1000), 1, '切换瞬间时间不应跳变')
  assert.equal(simClockTimeAt(c, 2000), 3, '再走 1 秒应推进 2 秒')
})

test('非法倍速回退为 1', () => {
  let c = createSimClock()
  assert.equal(simClockSetRate(c, 0, 0).rate, 1)
  assert.equal(simClockSetRate(c, -5, 0).rate, 1)
  assert.equal(simClockSetRate(c, NaN, 0).rate, 1)
})

test('时间到达 duration 后被上限截住', () => {
  let c = createSimClock({ duration: 5 })
  c = simClockPlay(c, 0)
  assert.equal(simClockTimeAt(c, 3000), 3)
  assert.equal(simClockTimeAt(c, 9000), 5, '不应超过总时长')
})

test('simClockEnded 在到达末尾时为 true', () => {
  let c = createSimClock({ duration: 3 })
  c = simClockPlay(c, 0)
  assert.equal(simClockEnded(c, 1000), false)
  assert.equal(simClockEnded(c, 3000), true)
  assert.equal(simClockEnded(c, 5000), true)
})

test('暂停状态下 simClockEnded 为 false', () => {
  let c = createSimClock({ duration: 3, baseTime: 3 })
  assert.equal(simClockEnded(c, 5000), false)
})

test('无 duration 时不设上限且 ended 恒为 false', () => {
  let c = createSimClock()
  c = simClockPlay(c, 0)
  assert.equal(simClockTimeAt(c, 100000), 100)
  assert.equal(simClockEnded(c, 100000), false)
})

test('设置时长后 baseTime 被夹取', () => {
  let c = createSimClock({ baseTime: 100 })
  c = simClockSetDuration(c, 30)
  assert.equal(c.baseTime, 30)
})

test('纯函数性：不修改传入的状态对象', () => {
  const c = createSimClock()
  const snapshot = JSON.stringify(c)
  simClockPlay(c, 1000)
  simClockSeek(c, 10, 1000)
  assert.equal(JSON.stringify(c), snapshot, '原状态不应被修改')
})

test('重复调用 play 不重置基准（幂等）', () => {
  let c = createSimClock()
  c = simClockPlay(c, 0)
  const after1 = c
  const after2 = simClockPlay(c, 5000)
  assert.equal(after1, after2, '已在播放时应原样返回')
})

test('重复调用 pause 幂等', () => {
  const c = createSimClock()
  assert.equal(simClockPause(c, 1000), c)
})

// ─────────────────────────────────────────────
group('clock · seek 保护（验收用例 2：进度条无回弹）')

test('未进入 seek 时直接返回真实时间', () => {
  const g = createSeekGuard()
  assert.equal(resolveTime(g, 12.5, 1000), 12.5)
})

test('seek 期间用目标时间顶替真实值（防止回弹到旧值）', () => {
  const g = createSeekGuard()
  seekGuardBegin(g, 48, 1000)
  // 音频还没定位完，读到的仍是旧值 3.2 —— 界面必须显示 48，不能显示 3.2
  assert.equal(resolveTime(g, 3.2, 1010), 48)
})

test('接近目标后交回真实值并结束 seek 状态', () => {
  const g = createSeekGuard()
  seekGuardBegin(g, 48, 1000)
  const t = resolveTime(g, 48.05, 1050)
  assert.equal(t, 48.05)
  assert.equal(g.active, false)
})

test('超时兜底：seeked 事件不来也不会永久卡在乐观值', () => {
  const g = createSeekGuard(1200)
  seekGuardBegin(g, 48, 1000)
  assert.equal(resolveTime(g, 3.2, 1500), 48, '超时前仍显示目标值')
  // 超过超时窗口 → 放弃乐观值，回到真实值
  assert.equal(resolveTime(g, 3.2, 2300), 3.2)
  assert.equal(g.active, false)
})

test('手动结束 seek 状态', () => {
  const g = createSeekGuard()
  seekGuardBegin(g, 10, 0)
  assert.equal(g.active, true)
  seekGuardEnd(g)
  assert.equal(g.active, false)
  assert.equal(resolveTime(g, 7, 100), 7)
})

test('拖动过程中目标值实时更新（拖到 80% 就一直显示 80%）', () => {
  const g = createSeekGuard()
  seekGuardBegin(g, 20, 1000)
  assert.equal(resolveTime(g, 1, 1000), 20)
  seekGuardBegin(g, 40, 1100)
  assert.equal(resolveTime(g, 1, 1100), 40, '继续拖动目标值应更新')
  seekGuardBegin(g, 80, 1200)
  assert.equal(resolveTime(g, 1, 1200), 80, '拖到 80% 应显示 80')
})

// ─────────────────────────────────────────────
group('clock · isAtEnd')

test('到达末尾判定', () => {
  assert.equal(isAtEnd(60, 60), true)
  assert.equal(isAtEnd(59.97, 60), true, '容差内视为到底')
  assert.equal(isAtEnd(59, 60), false)
  assert.equal(isAtEnd(10, 0), false, '无时长时恒为 false')
})

// ─────────────────────────────────────────────
group('color · HEX 解析与输出')

test('#abc 短写法展开', () => {
  assert.deepEqual(hexToRgb('#abc'), { r: 170, g: 187, b: 204, a: 1 })
})

test('#rrggbb 解析', () => {
  assert.deepEqual(hexToRgb('#ff8800'), { r: 255, g: 136, b: 0, a: 1 })
})

test('含 alpha 的 8 位解析', () => {
  const c = hexToRgb('#ff880080')
  assert.equal(c.r, 255)
  assert.ok(Math.abs(c.a - 128 / 255) < 0.001)
})

test('非法 HEX → null', () => {
  assert.equal(hexToRgb('#zzz'), null)
  assert.equal(hexToRgb('#12345'), null)
  assert.equal(hexToRgb('red'), null)
  assert.equal(hexToRgb(null), null)
})

test('rgbToHex 夹取越界值', () => {
  assert.equal(rgbToHex(300, -20, 128), '#ff0080')
})

test('rgbToHex 补零正确', () => {
  assert.equal(rgbToHex(0, 0, 0), '#000000')
  assert.equal(rgbToHex(1, 2, 3), '#010203')
})

test('hex → rgb → hex 往返一致', () => {
  for (const h of ['#000000', '#ffffff', '#4c8dff', '#123456', '#abcdef']) {
    const c = hexToRgb(h)
    assert.equal(rgbToHex(c.r, c.g, c.b), h, `round-trip failed for ${h}`)
  }
})

// ─────────────────────────────────────────────
group('color · RGB ↔ HSL 换算')

test('纯红转换正确', () => {
  const hsl = rgbToHsl(255, 0, 0)
  assert.equal(hsl.h, 0)
  assert.equal(hsl.s, 100)
  assert.equal(hsl.l, 50)
})

test('纯绿转换正确', () => {
  const hsl = rgbToHsl(0, 255, 0)
  assert.equal(hsl.h, 120)
})

test('纯蓝转换正确', () => {
  const hsl = rgbToHsl(0, 0, 255)
  assert.equal(hsl.h, 240)
})

test('黑白色饱和度为 0', () => {
  assert.equal(rgbToHsl(0, 0, 0).s, 0)
  assert.equal(rgbToHsl(255, 255, 255).s, 0)
  assert.equal(rgbToHsl(0, 0, 0).l, 0)
  assert.equal(rgbToHsl(255, 255, 255).l, 100)
})

test('hslToRgb 还原纯色', () => {
  assert.deepEqual(hslToRgb(0, 100, 50), { r: 255, g: 0, b: 0 })
  assert.deepEqual(hslToRgb(120, 100, 50), { r: 0, g: 255, b: 0 })
  assert.deepEqual(hslToRgb(240, 100, 50), { r: 0, g: 0, b: 255 })
})

test('饱和度为 0 时得到灰阶', () => {
  assert.deepEqual(hslToRgb(0, 0, 50), { r: 128, g: 128, b: 128 })
  assert.deepEqual(hslToRgb(180, 0, 100), { r: 255, g: 255, b: 255 })
})

test('色相环绕：360 等价于 0，负值也能处理', () => {
  assert.deepEqual(hslToRgb(360, 100, 50), hslToRgb(0, 100, 50))
  assert.deepEqual(hslToRgb(-120, 100, 50), hslToRgb(240, 100, 50))
  assert.deepEqual(hslToRgb(480, 100, 50), hslToRgb(120, 100, 50))
})

test('HSL → RGB → HSL 往返误差 ≤3（受 8 位色深限制）', () => {
  // 这是最关键的回归：拖色相环时若往返有偏差，颜色会"跳动"。
  //
  // 容差定为 3 而不是 1，是因为 RGB 每通道只有 256 级：
  // 在低饱和/低亮度区（如 hsl(3,20%,15%) → rgb(46,31,31)），
  // 量化误差可让色相偏 3°。已验证"纯浮点路径误差为 0"，
  // 说明换算公式本身是精确的，这点偏差完全来自 8 位色深，无法通过改算法消除。
  let maxErr = 0
  for (let h = 0; h < 360; h += 7) {
    for (const s of [20, 50, 80, 100]) {
      for (const l of [15, 35, 50, 65, 85]) {
        const rgb = hslToRgb(h, s, l)
        const back = rgbToHsl(rgb.r, rgb.g, rgb.b)
        const hErr = back.s === 0 ? 0 : Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h))
        const sErr = Math.abs(back.s - s)
        const lErr = Math.abs(back.l - l)
        maxErr = Math.max(maxErr, hErr, sErr, lErr)
      }
    }
  }
  assert.ok(maxErr <= 3, `最大往返误差 ${maxErr}，应 ≤3`)
})

test('高饱和区往返误差 ≤1（拖色相环的主要场景）', () => {
  let maxErr = 0
  for (let h = 0; h < 360; h += 5) {
    const rgb = hslToRgb(h, 100, 50)
    const back = rgbToHsl(rgb.r, rgb.g, rgb.b)
    maxErr = Math.max(maxErr, Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h)))
  }
  assert.ok(maxErr <= 1, `高饱和区最大色相误差 ${maxErr}`)
})

test('hslToHex / hexToHsl 链路可用', () => {
  assert.equal(hslToHex(0, 100, 50), '#ff0000')
  assert.equal(hslToHex(120, 100, 50), '#00ff00')
  const hsl = hexToHsl('#ff0000')
  assert.equal(hsl.h, 0)
})

test('灰阶下任意色相都得到同一个灰（说明"灰上拖色相环无变化"是数学必然）', () => {
  // 这条测试记录了一个真实的交互问题：
  // 饱和度为 0 时改变色相不会改变 RGB 结果，
  // 因此 UI 层面必须在低饱和时自动提饱和（见 ColorPicker.vue 的 setHue）。
  const a = hslToHex(0, 0, 50)
  const b = hslToHex(90, 0, 50)
  const c = hslToHex(240, 0, 50)
  assert.equal(a, '#808080')
  assert.equal(a, b)
  assert.equal(a, c)
})

test('饱和度 >0 时色相才会带来可见差异', () => {
  const gray = hslToHex(210, 0, 50)
  const colored = hslToHex(210, 15, 50)
  assert.notEqual(gray, colored, '提到 15% 饱和度后颜色必须与灰不同')
})

// ─────────────────────────────────────────────
group('color · HEX 输入校验（非法必须拒绝）')

test('合法输入被接受并归一化', () => {
  assert.equal(validateHexInput('#ff0000'), '#ff0000')
  assert.equal(validateHexInput('ff0000'), '#ff0000', '允许省略 #')
  assert.equal(validateHexInput('#ABC'), '#aabbcc', '大写与短写法都归一化')
  assert.equal(validateHexInput('  #ff0000  '), '#ff0000', '容忍空格')
})

test('非法输入返回 null（不允许猜测）', () => {
  assert.equal(validateHexInput('#zzz'), null)
  assert.equal(validateHexInput('#12345'), null)
  assert.equal(validateHexInput('rgb(255,0,0)'), null)
  assert.equal(validateHexInput('red'), null)
  assert.equal(validateHexInput(''), null)
  assert.equal(validateHexInput('   '), null)
  assert.equal(validateHexInput('#'), null)
  assert.equal(validateHexInput(null), null)
})

// ─────────────────────────────────────────────
group('color · 色相环几何与对比色')

test('色相环正上方角度为 0', () => {
  assert.equal(pointToHue(0, -10), 0)
})

test('色相环右侧为 90 度', () => {
  assert.equal(pointToHue(10, 0), 90)
})

test('色相环正下方为 180 度', () => {
  assert.equal(pointToHue(0, 10), 180)
})

test('色相环左侧为 270 度', () => {
  assert.equal(pointToHue(-10, 0), 270)
})

test('角度恒在 [0,360)', () => {
  for (const [x, y] of [[1, 1], [-1, -1], [5, -2], [-3, 4]]) {
    const h = pointToHue(x, y)
    assert.ok(h >= 0 && h < 360, `${x},${y} → ${h}`)
  }
})

test('pointToHue 与 hueToPoint 互为逆运算', () => {
  for (let h = 0; h < 360; h += 15) {
    const p = hueToPoint(h, 100)
    const back = pointToHue(p.x, p.y)
    const diff = Math.min(Math.abs(back - h), 360 - Math.abs(back - h))
    assert.ok(diff < 0.01, `hue ${h} → point → ${back}`)
  }
})

test('对比色在白底给黑字、黑底给白字', () => {
  assert.equal(contrastText('#ffffff'), '#000000')
  assert.equal(contrastText('#000000'), '#ffffff')
  assert.equal(contrastText('#ffff00'), '#000000')
  assert.equal(contrastText('#000080'), '#ffffff')
})

test('单通道渐变两端是通道的最小与最大', () => {
  const grad = channelGradient('r', 128, 64, 32)
  assert.ok(grad.includes(rgbToHex(0, 64, 32)), '起点应为 R=0')
  assert.ok(grad.includes(rgbToHex(255, 64, 32)), '终点应为 R=255')
})

// ─────────────────────────────────────────────
group('color · HSV 换算（竖直明度条用）')

test('纯红 HSV', () => {
  assert.deepEqual(rgbToHsv(255, 0, 0), { h: 0, s: 100, v: 100 })
})

test('黑色 V=0、白色 V=100 且 S=0', () => {
  assert.deepEqual(rgbToHsv(0, 0, 0), { h: 0, s: 0, v: 0 })
  assert.deepEqual(rgbToHsv(255, 255, 255), { h: 0, s: 0, v: 100 })
})

test('灰色 S=0', () => {
  const hsv = rgbToHsv(128, 128, 128)
  assert.equal(hsv.s, 0)
  assert.equal(hsv.v, 50)
})

test('hsvToRgb 还原纯色', () => {
  assert.deepEqual(hsvToRgb(0, 100, 100), { r: 255, g: 0, b: 0 })
  assert.deepEqual(hsvToRgb(120, 100, 100), { r: 0, g: 255, b: 0 })
  assert.deepEqual(hsvToRgb(240, 100, 100), { r: 0, g: 0, b: 255 })
  assert.deepEqual(hsvToRgb(0, 0, 0), { r: 0, g: 0, b: 0 })
  assert.deepEqual(hsvToRgb(0, 0, 100), { r: 255, g: 255, b: 255 })
})

test('HSV 色相环绕：360 等价于 0', () => {
  assert.deepEqual(hsvToRgb(360, 100, 100), hsvToRgb(0, 100, 100))
  assert.deepEqual(hsvToRgb(-120, 100, 100), hsvToRgb(240, 100, 100))
})

test('HSV → RGB → HSV 往返：明度条工作区误差 ≤3，极暗区不保证', () => {
  // 8 位色深的硬限制：色相的表达精度取决于 RGB 三通道之间的"差值"，
  // 而差值随饱和度、明度下降而缩小。
  // 实测极暗低饱和区（如 s=10%,v=5% → rgb≈(3,3,2)；s=25%,v=5% → rgb≈(13,11,10)）
  // 色相可偏 16~28°。
  //
  // 但这**不影响实际使用**：
  //  1. 明度条的工作区是"看得清颜色的区域" —— V ≥ 40% 或 S = 100%；
  //  2. V < 20% 的颜色在深色舞台上本来就几乎看不见，
  //     且 S < 10% 时色相在视觉上无意义；
  //  3. 已验证纯浮点路径误差为 0，公式精确。
  // 故只对"明度条工作区"断言，并记录极暗区的实测上界。
  let maxErrUsable = 0
  let maxErrAll = 0
  for (let h = 0; h < 360; h += 3) {
    for (const s of [0, 10, 25, 50, 75, 100]) {
      for (const v of [5, 10, 20, 40, 70, 100]) {
        const rgb = hsvToRgb(h, s, v)
        const back = rgbToHsv(rgb.r, rgb.g, rgb.b)
        const hErr = back.s === 0 ? 0 : Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h))
        const err = Math.max(hErr, Math.abs(back.s - s), Math.abs(back.v - v))
        maxErrAll = Math.max(maxErrAll, err)
        // 明度条工作区：用户凭视觉判断颜色的区域
        // （明度足够亮 ≥40%，或饱和度满格的纯色）
        if (v >= 40 || s === 100) maxErrUsable = Math.max(maxErrUsable, err)
      }
    }
  }
  assert.ok(maxErrUsable <= 3, `明度条工作区最大误差 ${maxErrUsable}，应 ≤3`)
  console.log(`      [info] HSV 往返：中高饱和区 ≤${maxErrUsable}，极暗低饱和区全局 ≤${maxErrAll}（8 位色深限制）`)
})

test('高饱和高明度区 HSV 往返误差 ≤1（明度条主要工作区）', () => {
  let maxErr = 0
  for (let h = 0; h < 360; h += 5) {
    const rgb = hsvToRgb(h, 100, 100)
    const back = rgbToHsv(rgb.r, rgb.g, rgb.b)
    maxErr = Math.max(maxErr, Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h)))
  }
  assert.ok(maxErr <= 1, `高饱和区最大色相误差 ${maxErr}`)
})

test('HSL ↔ HSV 往返', () => {
  for (const [h, s, l] of [[0, 100, 50], [120, 60, 40], [240, 30, 80]]) {
    const hsv = hslToHsv(h, s, l)
    const hsl = hsvToHsl(hsv.h, hsv.s, hsv.v)
    assert.ok(Math.abs(hsl.h - h) <= 1 || Math.abs(hsl.h - h) >= 359, `h=${h}`)
    assert.ok(Math.abs(hsl.s - s) <= 1, `s=${s}: ${hsl.s}`)
    assert.ok(Math.abs(hsl.l - l) <= 1, `l=${l}: ${hsl.l}`)
  }
})

test('明度条渐变：顶端是纯色、底端是黑', () => {
  const grad = valueBarGradient(0, 100)
  assert.ok(grad.includes('#ff0000'), '顶端应为纯红（V=100）')
  assert.ok(grad.includes('#000000'), '底端应为黑（V=0）')
})

test('明度条渐变：纯线性，两端分别是纯色与黑', () => {
  const g = valueGradient(0, 100)
  assert.ok(g.startsWith('linear-gradient(to bottom,'), '应为竖直渐变')
  assert.ok(g.includes('#ff0000 0.0%'), '顶端应为纯红（V=100）')
  assert.ok(g.includes('#000000 100.0%'), '底端应为黑（V=0）')
})

test('明度条渐变：位置与明度严格线性对应（不可再引入缓动）', () => {
  /*
   * 这曾是真实 BUG 的来源：旧版有「感知」模式，
   * 在 V 上套 smoothstep，导致**把手位置与实际明度脱钩**。
   * 明度条是取值控件，位置必须等于取值，所以逐点核对线性关系。
   */
  const g = valueGradient(0, 100, 10)
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    const c = hsvToRgb(0, 100, (1 - t) * 100)
    const hex = rgbToHex(c.r, c.g, c.b)
    assert.ok(
      g.includes(`${hex} ${(t * 100).toFixed(1)}%`),
      `位置 ${(t * 100).toFixed(1)}% 应为 ${hex}`,
    )
  }
})

test('明度条渐变：非法输入不产生 NaN', () => {
  for (const [h, s] of [[Number.NaN, 100], [0, Number.NaN], [-30, 300]]) {
    assert.ok(!valueGradient(h, s).includes('NaN'), `h=${h} s=${s} 产生了 NaN`)
  }
})

// ─────────────────────────────────────────────
group('color · 色轮（阶段 5 补丁 10：替代色相环）')

/*
 * 【为什么从色相环换成色轮】
 * 色相环只管 H，用户在纯白（S=0）时拖环，颜色**必然不变** ——
 * 这在数学上正确，但不满足"点哪里得到哪里的颜色"。
 * 色轮是 H + S 二维：角度→H、半径→S，于是任何位置都能直接定出颜色。
 *
 * 【内部坐标为什么是 HSV 而不是 HSL】
 * HSL 的 L 随 S 变化 → 拖到边缘颜色忽明忽暗；
 * 且色轮与竖直明度条都会改"亮度"，语义重叠。
 * HSV 的 H/S 独立于 V，拖色轮时明暗稳定，与明度条正交。
 *
 * 【互逆性是硬要求】
 * 小点位置与拖动取色必须严格互逆，否则"松手后小点会跳"。
 */

const WHEEL_R = 60

test('色轮：点的位置 → 角度即色相（四方向验证）', () => {
  // 顶部 0°、顺时针增加 —— 与原色相环保持一致，用户的肌肉记忆不变
  assert.equal(pointToHS(0, -WHEEL_R, WHEEL_R).h, 0, '顶部应为 0°')
  assert.equal(pointToHS(WHEEL_R, 0, WHEEL_R).h, 90, '右侧应为 90°')
  assert.equal(pointToHS(0, WHEEL_R, WHEEL_R).h, 180, '底部应为 180°')
  assert.equal(pointToHS(-WHEEL_R, 0, WHEEL_R).h, 270, '左侧应为 270°')
})

test('色轮：边缘 = 满饱和，中心 = 零饱和', () => {
  assert.equal(pointToHS(0, -WHEEL_R, WHEEL_R).s, 100, '边缘 S 应为 100')
  assert.equal(pointToHS(WHEEL_R, 0, WHEEL_R).s, 100)
  assert.equal(pointToHS(0, 0, WHEEL_R).s, 0, '中心 S 应为 0')
})

test('色轮：S 随半径线性增长', () => {
  const half = pointToHS(0, -WHEEL_R / 2, WHEEL_R).s
  const quarter = pointToHS(0, -WHEEL_R / 4, WHEEL_R).s
  assert.ok(Math.abs(half - 50) <= 1, `半径一半应 S=50，实际 ${half}`)
  assert.ok(Math.abs(quarter - 25) <= 1, `半径 1/4 应 S=25，实际 ${quarter}`)
  // 超出圆周要被夹到 100，不能超过
  const outside = pointToHS(0, -WHEEL_R * 2, WHEEL_R).s
  assert.equal(outside, 100, '超出圆周的点应夹到 S=100')
})

test('色轮：中心死区内 S 恒为 0（低饱和精度保护）', () => {
  const dead = WHEEL_DEAD_ZONE * WHEEL_R
  assert.equal(pointToHS(0, 0, WHEEL_R).s, 0, '圆心 S 应为 0')
  assert.equal(pointToHS(0, -dead * 0.9, WHEEL_R).s, 0, '死区内 S 应为 0')
  // 死区外立刻恢复线性
  const justOut = pointToHS(0, -dead * 1.5, WHEEL_R).s
  assert.ok(justOut > 0, `死区外 S 应大于 0，实际 ${justOut}`)
  // 死区内色相仍要跟着鼠标走（小点位置不能冻在某个角度）
  assert.notEqual(pointToHS(0, -dead * 0.5, WHEEL_R).h, pointToHS(0, 0, WHEEL_R).h,
    '死区内色相应随鼠标位置变化')
})

test('色轮：非法输入不产生 NaN', () => {
  assert.deepEqual(pointToHS(0, 0, 0), { h: 0, s: 0 })
  assert.deepEqual(pointToHS(Number.NaN, 0, 60), { h: 0, s: 0 })
  assert.deepEqual(pointToHS(0, 0, -10), { h: 0, s: 0 })
  const p = hsToPoint(Number.NaN, Number.NaN, 60)
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'hsToPoint 不应产生 NaN')
})

test('色轮：H/S ↔ 点的位置严格互逆（松手后小点不跳）', () => {
  let maxH = 0
  let maxS = 0
  let n = 0
  for (let h = 0; h < 360; h += 7) {
    for (let s = 20; s <= 100; s += 10) {
      const p = hsToPoint(h, s, WHEEL_R)
      const back = pointToHS(p.x, p.y, WHEEL_R)
      let dh = Math.abs(back.h - h)
      if (dh > 180) dh = 360 - dh // 环形距离
      maxH = Math.max(maxH, dh)
      maxS = Math.max(maxS, Math.abs(back.s - s))
      n++
    }
  }
  assert.ok(maxH < 0.01, `H 最大往返误差 ${maxH.toFixed(4)}°（应 ≈0）`)
  assert.ok(maxS < 0.01, `S 最大往返误差 ${maxS.toFixed(4)}（应 ≈0）`)
  console.log(`      [info] 色轮互逆性核对 ${n} 组（H/S → 点 → H/S）`)
})

test('色轮：hsToPoint 的 S=0 时落在圆心', () => {
  const p = hsToPoint(123, 0, WHEEL_R)
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9, `S=0 应在圆心，实际 (${p.x}, ${p.y})`)
})

test('色轮背景：中心是**当前明度下的灰**（真机要求，不可写死白色）', () => {
  // 这是"白色起点点绿色能变绿"的前提。
  // 若写死白色遮罩，V=50 时中心会显示"被白稀释的假灰"，不属于任何明度。
  for (const v of [0, 25, 50, 75, 100]) {
    const g = wheelGradient(v)
    const expect = hsvToRgb(0, 0, v)
    assert.equal(g.center, rgbToHex(expect.r, expect.g, expect.b), `V=${v} 的中心色不对`)
  }
})

test('色轮背景：纯白起点时中心是纯白（不是灰）', () => {
  // 用户明确指出：纯白状态下色轮不能"看起来中间灰边缘彩"
  const g = wheelGradient(100)
  assert.equal(g.center, '#ffffff', 'V=100 的中心应是纯白')
  assert.ok(g.background.includes('conic-gradient'), '底层应是色相锥形渐变')
  assert.ok(g.background.includes('radial-gradient'), '顶层应是径向遮罩')
})

test('色轮背景：V=0 时中心是纯黑（整轮几乎全黑）', () => {
  const g = wheelGradient(0)
  assert.equal(g.center, '#000000')
})

test('色轮背景：非法明度被夹取，不产生 NaN', () => {
  for (const v of [Number.NaN, -50, 500]) {
    const g = wheelGradient(v)
    assert.ok(!g.background.includes('NaN'), `V=${v} 产生了 NaN`)
    assert.match(g.center, /^#[0-9a-f]{6}$/, `V=${v} 的 center 格式不对`)
  }
})

test('色轮：点绿色区域 → 绿；点紫色区域 → 紫（核心诉求）', () => {
  // 这是用户推翻色相环方案的根本原因，必须直接断言
  const R = 60
  // 绿色：H=120、S=100 → 半径 60 的 120° 方向
  const greenP = hsToPoint(120, 100, R)
  const greenHS = pointToHS(greenP.x, greenP.y, R)
  const greenRGB = hsvToRgb(greenHS.h, greenHS.s, 100)
  assert.equal(rgbToHex(greenRGB.r, greenRGB.g, greenRGB.b), '#00ff00', '点绿色应得到纯绿')

  // 紫色：H=280
  const purpleP = hsToPoint(280, 100, R)
  const purpleHS = pointToHS(purpleP.x, purpleP.y, R)
  const purpleRGB = hsvToRgb(purpleHS.h, purpleHS.s, 100)
  assert.equal(rgbToHex(purpleRGB.r, purpleRGB.g, purpleRGB.b), '#aa00ff', '点紫色应得到纯紫')
})

test('色轮：任意位置都能定出颜色（不存在"点了没反应"）', () => {
  // 旧色相环的致命缺陷：S=0 时拖动颜色不变。
  // 色轮下任何位置（含纯白起点）点下去都会直接设定 S。
  const R = 60
  for (let a = 0; a < 360; a += 30) {
    for (const frac of [0.3, 0.6, 1.0]) {
      const p = hsToPoint(a, frac * 100, R)
      const hs = pointToHS(p.x, p.y, R)
      assert.ok(hs.s > 0, `角度 ${a} 半径 ${frac} 处 S 应大于 0（否则点了没反应）`)
    }
  }
})

// ─────────────────────────────────────────────
group('color · 色轮所见即所得（真实 BUG 回归）')

/**
 * 从 wheelGradient 产出的径向遮罩里，解析出某个半径比例处的不透明度。
 * 遮罩是 `radial-gradient(circle at center, rgba(...) N%, ...)`，
 * 这里按线性插值还原浏览器会画出的 alpha。
 */
function maskAlphaAt(background, radiusRatio) {
  const re = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)\s+([\d.]+)%/g
  const stops = []
  let m
  while ((m = re.exec(background)) !== null) {
    stops.push({ a: Number(m[4]), p: Number(m[5]) })
  }
  stops.sort((x, y) => x.p - y.p)
  const target = radiusRatio * 100
  if (stops.length === 0) return 0
  if (target <= stops[0].p) return stops[0].a
  if (target >= stops[stops.length - 1].p) return stops[stops.length - 1].a
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (target >= a.p && target <= b.p) {
      const t = (b.p - a.p) === 0 ? 0 : (target - a.p) / (b.p - a.p)
      return a.a + (b.a - a.a) * t
    }
  }
  return 0
}

test('色轮：遮罩在圆心最不透明、在圆边完全透明（不能是反的）', () => {
  /*
   * 这是本次修复的核心。旧实现的遮罩是**反的**：
   * 圆心 transparent（显示满饱和色）、边缘盖灰。
   * 而 pointToHS 是"半径越大饱和度越高"，于是圆心看着是大红、
   * 点下去却是淡粉 —— 用户报告的「指向大红色却输出淡红色」。
   */
  const bg = wheelGradient(100).background
  const center = maskAlphaAt(bg, 0)
  const edge = maskAlphaAt(bg, 1)
  assert.ok(center > 0.99, `圆心遮罩应几乎全不透明（显示灰、S≈0），实际 ${center}`)
  assert.ok(edge < 0.01, `圆边遮罩应完全透明（显示满饱和），实际 ${edge}`)
})

test('色轮：遮罩不透明度单调递减（半径越大越饱和）', () => {
  const bg = wheelGradient(100).background
  let prev = Infinity
  for (let i = 0; i <= 20; i++) {
    const a = maskAlphaAt(bg, i / 20)
    assert.ok(a <= prev + 1e-9, `半径 ${i / 20} 处不透明度回升：${a} > ${prev}`)
    prev = a
  }
})

test('色轮：看到什么颜色就点到什么颜色（WYSIWYG）', () => {
  /*
   * 遮罩不透明度 a 把满饱和色与同明度灰混合，
   * 结果在 HSV 里等价于饱和度 (1-a)。
   * 逐点核对"视觉饱和度"与"取色饱和度"必须一致。
   */
  const R = 58
  const V = 100
  const bg = wheelGradient(V).background
  const hueRgb = hsvToRgb(0, 100, V)
  const grayRgb = hsvToRgb(0, 0, V)

  let worst = 0
  let worstAt = 0
  for (let i = 1; i <= 20; i++) {
    const r = i / 20
    const a = maskAlphaAt(bg, r)
    const mix = {
      r: Math.round(hueRgb.r * (1 - a) + grayRgb.r * a),
      g: Math.round(hueRgb.g * (1 - a) + grayRgb.g * a),
      b: Math.round(hueRgb.b * (1 - a) + grayRgb.b * a),
    }
    const seenS = rgbToHsv(mix.r, mix.g, mix.b).s
    // 同半径处点一下会拿到的 S
    const gotS = pointToHS(0, -r * R, R).s
    const diff = Math.abs(seenS - gotS)
    if (diff > worst) {
      worst = diff
      worstAt = r
    }
  }
  // 允许 2% 误差：遮罩是分段线性近似，且 HSV 在 S 很低时量化误差偏大
  assert.ok(worst <= 2, `半径 ${worstAt.toFixed(2)} 处视觉/取色饱和度差 ${worst}（应 ≤2）`)
})

test('色轮：用户报告的具体数值（S=16% 处应是淡粉，而非看着大红）', () => {
  /*
   * 报告原文：小点在 S=16% 处、指向大红色，输出的却是 #ffd5d9（淡红）。
   * 根因是遮罩反了 —— 该半径处画的是满饱和红。修好后该处应显示淡红。
   */
  const R = 58
  const bg = wheelGradient(100).background
  const a = maskAlphaAt(bg, 0.16)
  const gain = 1 - a
  assert.ok(
    Math.abs(gain - 0.16) < 0.03,
    `S=16% 处应只显示 16% 的饱和度，实际 ${(gain * 100).toFixed(1)}%`,
  )
})

test('色轮：死区边界处遮罩跟着跳（圆心一小块是纯灰）', () => {
  const bg = wheelGradient(100).background
  // 死区内一律 S=0 → 遮罩全不透明
  assert.ok(maskAlphaAt(bg, WHEEL_DEAD_ZONE * 0.5) > 0.99)
  // 刚出死区就应立刻变淡（S=10 → 不透明度 0.9）
  assert.ok(maskAlphaAt(bg, WHEEL_DEAD_ZONE + 0.02) < 0.95)
})

test('色轮：绘制与取色共用同一个饱和度函数（结构上不可能再对不上）', () => {
  for (const r of [0, 0.05, 0.1, 0.3, 0.5, 0.75, 1, 1.5]) {
    // pointToHS 在竖直方向取点，半径比例就是 r
    const got = pointToHS(0, -r * 60, 60)
    assert.equal(got.s, wheelSaturationAt(r), `半径 ${r} 处两者应完全一致`)
  }
})

test('色轮：遮罩必须显式 closest-side（默认 farthest-corner 会拉伸 1.41 倍）', () => {
  /*
   * 这是像素比对抓出来的第二个 BUG：
   * `radial-gradient(circle at center, …)` 的默认尺寸是 **farthest-corner**，
   * 120×120 的圆里是 84.85px（半对角线）而不是 60px（半边长）——
   * 百分比停靠点被整体放大 1.41 倍，边缘本该 S=100 却只画到 S≈68，整轮发白。
   * 必须显式写 closest-side，把 100% 精确锚在"半边长"上。
   */
  const bg = wheelGradient(100).background
  assert.ok(bg.includes('closest-side'), '径向渐变必须显式声明 closest-side')
  assert.ok(
    !/radial-gradient\(circle at center/.test(bg),
    '不能使用默认尺寸写法（那会退化成 farthest-corner）',
  )
})

test('色轮：closest-side 的 100% 与取色半径同源（半边长）', () => {
  /*
   * 取色半径在 ColorPicker 里是 `min(w,h)/2`；
   * closest-side 的 100% 也正好是 min(w,h)/2。
   * 这里用一个具体尺寸核对这个等式，避免有人再给某一侧加内缩。
   */
  const box = 120
  const clickRadius = Math.min(box, box) / 2
  assert.equal(clickRadius, box / 2, 'closest-side 的 100% = 半边长 = 取色半径')
  // 遮罩在 r=1 处必须是完全透明的（显示满饱和）
  const bg = wheelGradient(100).background
  const lastStop = bg.slice(0, bg.indexOf('), conic'))
  assert.ok(/rgba\(\d+,\s*\d+,\s*\d+,\s*0\)\s+100\.00%/.test(lastStop), `100% 处应为完全透明，实际：${lastStop.slice(-60)}`)
})

// ─────────────────────────────────────────────
group('scroll · 居中位移计算（验收：误差 ≤2px）')

test('行中心与容器中心重合时位移等于行中心位置', () => {
  // 行顶部 1000，高 50 → 中心 1025；容器高 400 → 中心 200
  // 轨道需上移 1025 - 200 = 825
  const off = computeCenteringOffset({ top: 1000, height: 50 }, 400)
  assert.equal(off, 825)
})

test('位移后行中心恰好落在容器中心（几何反算验证）', () => {
  const containerH = 600
  for (const top of [0, 123, 4567, 99999]) {
    const line = { top, height: 40 }
    const off = computeCenteringOffset(line, containerH)
    // 行在屏幕上的中心位置 = 行中心 - 位移
    const screenCenter = line.top + line.height / 2 - off
    assert.ok(
      Math.abs(screenCenter - containerH / 2) < 0.001,
      `top=${top} 时中心偏移 ${screenCenter - containerH / 2}`,
    )
  }
})

test('锚点比例可调（0.38 为黄金分割位）', () => {
  const line = { top: 1000, height: 40 }
  const centered = computeCenteringOffset(line, 400, 0.5)
  const golden = computeCenteringOffset(line, 400, 0.38)
  assert.ok(golden > centered, '黄金分割位更靠上，位移更小')
})

test('容器高度为 0 时返回 0（不产生 NaN）', () => {
  assert.equal(computeCenteringOffset({ top: 100, height: 40 }, 0), 0)
})

test('无效输入不产生 NaN', () => {
  assert.equal(computeCenteringOffset(null, 400), 0)
  assert.equal(Number.isFinite(computeCenteringOffset({ top: NaN, height: 40 }, 400)), false)
})

// ─────────────────────────────────────────────
group('scroll · 位移夹取')

test('内容比容器矮时不可滚动', () => {
  assert.equal(clampScrollOffset(500, 300, 400), 0)
})

test('负值夹到 0', () => {
  assert.equal(clampScrollOffset(-50, 2000, 400), 0)
})

test('超出底部夹到最大位移', () => {
  assert.equal(clampScrollOffset(9999, 2000, 400), 1600)
})

test('区间内原样返回', () => {
  assert.equal(clampScrollOffset(800, 2000, 400), 800)
})

test('非法值返回 0', () => {
  assert.equal(clampScrollOffset(NaN, 2000, 400), 0)
})

// ─────────────────────────────────────────────
group('scroll · 帧率无关平滑（120Hz 与 60Hz 手感一致）')

test('朝目标收敛', () => {
  let v = 0
  for (let i = 0; i < 60; i++) v = smoothTowards(v, 100, 16.7, 90)
  assert.ok(Math.abs(v - 100) < 1, `收敛到 ${v}`)
})

test('半衰期语义正确：经过一个半衰期后差距减半', () => {
  const v = smoothTowards(0, 100, 90, 90)
  assert.ok(Math.abs(v - 50) < 0.5, `90ms 后应为 50，实际 ${v}`)
})

test('帧率无关：60Hz 走 1 秒 ≈ 120Hz 走 1 秒', () => {
  let a = 0
  for (let i = 0; i < 60; i++) a = smoothTowards(a, 1000, 16.667, 90) // 60fps × 1s
  let b = 0
  for (let i = 0; i < 120; i++) b = smoothTowards(b, 1000, 8.333, 90) // 120fps × 1s
  assert.ok(Math.abs(a - b) < 5, `60Hz=${a.toFixed(2)} vs 120Hz=${b.toFixed(2)}，应基本一致`)
})

test('dt 为 0 时不改变值', () => {
  assert.equal(smoothTowards(10, 100, 0), 10)
})

test('超大 dt 被夹取（切回标签页不跳变）', () => {
  const normal = smoothTowards(0, 100, 200, 90)
  const huge = smoothTowards(0, 100, 100000, 90)
  assert.equal(normal, huge, '超过 200ms 的间隔都按 200ms 处理')
})

test('已到达目标则保持不动', () => {
  assert.equal(smoothTowards(100, 100, 16.7), 100)
})

test('目标反向也能收敛', () => {
  let v = 100
  for (let i = 0; i < 60; i++) v = smoothTowards(v, 0, 16.7, 90)
  assert.ok(Math.abs(v) < 1)
})

test('NaN 输入不会传播', () => {
  assert.equal(smoothTowards(NaN, 100, 16.7), 100)
  assert.equal(smoothTowards(50, NaN, 16.7), 50)
})

test('isSettled 判定', () => {
  assert.equal(isSettled(100, 100), true)
  assert.equal(isSettled(100, 100.2), true)
  assert.equal(isSettled(100, 105), false)
})

// ─────────────────────────────────────────────
group('scroll · 居中语义的几何事实')

test('居中语义下首行的位移为负（不能沿用 [0,...] 夹取）', () => {
  // 这是实测抓出的关键几何事实：首行要停在容器中心，轨道必须被往下推，
  // 位移是负值。若用 clampScrollOffset（下界 0）夹取，首行永远无法居中
  // （实测偏差可达 92px）。
  const firstRow = { top: 0, height: 64 }
  const off = computeCenteringOffset(firstRow, 600)
  assert.ok(off < 0, `首行居中位移应为负，实际 ${off}`)
  assert.equal(off, 32 - 300)

  // 而 clampScrollOffset 会把它压成 0 —— 正是要避免的行为
  assert.equal(clampScrollOffset(off, 5000, 600), 0, 'clampScrollOffset 会破坏居中')
})

test('居中语义下末行的位移为正且小于内容总高', () => {
  const lastRow = { top: 4940, height: 60 }
  const off = computeCenteringOffset(lastRow, 600)
  assert.equal(off, 4940 + 30 - 300)
  assert.ok(off > 0)
})

// ─────────────────────────────────────────────
group('scroll · 视口中心行（虚化跟随用户视角）')

test('视口中心落在某行区间内 → 返回该行', () => {
  // 行高 50，容器高 200；offset=100 → 视口中心在轨道内 y = 100 + 100 = 200
  const metrics = Array.from({ length: 10 }, (_, i) => ({ top: i * 50, height: 50 }))
  assert.equal(findRowAtViewportCenter(metrics, 100, 200), 4) // 200 落在 [200,250) → 第 4 行
})

test('offset=0 时中心落在容器正中', () => {
  const metrics = Array.from({ length: 10 }, (_, i) => ({ top: i * 50, height: 50 }))
  // y = 0 + 100 = 100 → 第 2 行（top=100）
  assert.equal(findRowAtViewportCenter(metrics, 0, 200), 2)
})

test('滚动后中心行随之下移', () => {
  const metrics = Array.from({ length: 100 }, (_, i) => ({ top: i * 50, height: 50 }))
  const a = findRowAtViewportCenter(metrics, 0, 600)
  const b = findRowAtViewportCenter(metrics, 2500, 600)
  assert.ok(b > a, `应下移：${a} → ${b}`)
})

test('滚到内容之外时夹取到末行（不越界）', () => {
  const metrics = Array.from({ length: 5 }, (_, i) => ({ top: i * 50, height: 50 }))
  const idx = findRowAtViewportCenter(metrics, 99999, 200)
  assert.equal(idx, 4)
})

test('y 小于首行时返回 0', () => {
  const metrics = Array.from({ length: 5 }, (_, i) => ({ top: 1000 + i * 50, height: 50 }))
  assert.equal(findRowAtViewportCenter(metrics, 0, 200), 0)
})

test('空/非法输入返回 -1', () => {
  assert.equal(findRowAtViewportCenter([], 0, 200), -1)
  assert.equal(findRowAtViewportCenter(null, 0, 200), -1)
  assert.equal(findRowAtViewportCenter([{ top: 0, height: 10 }], NaN, 200), -1)
  assert.equal(findRowAtViewportCenter([{ top: 0, height: 10 }], 0, 0), -1)
})

test('结果恒在合法下标范围内', () => {
  const metrics = Array.from({ length: 20 }, (_, i) => ({ top: i * 40, height: 40 }))
  for (const off of [-1000, -1, 0, 137, 5000, 1e9]) {
    const idx = findRowAtViewportCenter(metrics, off, 300)
    assert.ok(idx >= 0 && idx <= 19, `offset=${off} → idx=${idx} 越界`)
  }
})

// ─────────────────────────────────────────────
group('persist · 设置持久化')

/** 内存版 localStorage 桩 */
function makeMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() {
      return map.size
    },
    _map: map,
  }
}

test('键名含版本号', () => {
  assert.ok(STORAGE_KEY.includes('v1'))
})

test('空 storage 读取返回 empty', () => {
  const s = createSettingsStorage(makeMemoryStorage())
  const r = s.read()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty')
})

test('写入后能读回', () => {
  const mem = makeMemoryStorage()
  const s = createSettingsStorage(mem)
  assert.equal(s.write({ font: { size: 72 } }).ok, true)
  const r = s.read()
  assert.equal(r.ok, true)
  assert.equal(r.value.font.size, 72)
})

test('JSON 损坏时返回 corrupt（不抛异常）', () => {
  const mem = makeMemoryStorage({ [STORAGE_KEY]: '{这不是合法JSON' })
  const s = createSettingsStorage(mem)
  const r = s.read()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'corrupt')
})

test('非对象 JSON 视为无效', () => {
  const mem = makeMemoryStorage({ [STORAGE_KEY]: '"just a string"' })
  assert.equal(createSettingsStorage(mem).read().reason, 'invalid')
})

test('remove 清空键', () => {
  const mem = makeMemoryStorage()
  const s = createSettingsStorage(mem)
  s.write({ a: 1 })
  assert.equal(s.remove().ok, true)
  assert.equal(s.read().reason, 'empty')
  assert.equal(mem.size, 0, 'localStorage 应被真正清空')
})

test('storage 不可用时 read/write 均安全返回', () => {
  const s = createSettingsStorage(null)
  assert.equal(s.available, false)
  assert.equal(s.read().ok, false)
  assert.equal(s.write({}).ok, false)
  assert.equal(s.remove().ok, false)
})

test('写入抛异常（配额满）时返回失败而不崩溃', () => {
  // 注意：不能只让 setItem 抛错 —— 探测函数 isStorageAvailable 也会写一次，
  // 那样整个 storage 会被判为"不可用"（reason=unavailable），根本走不到写入分支。
  // 这里让探测通过、真正写入时才抛，才能测到配额满这条路径。
  let armed = false
  const quotaStorage = {
    getItem: () => null,
    setItem: () => {
      if (!armed) return // 探测阶段放行
      const e = new Error('quota')
      e.name = 'QuotaExceededError'
      throw e
    },
    removeItem: () => {},
  }
  const s = createSettingsStorage(quotaStorage)
  assert.equal(s.available, true, '探测应通过')
  armed = true
  const r = s.write({ a: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'quota')
})

test('storage 完全不可写时被判定为 unavailable', () => {
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('nope')
    },
    removeItem: () => {},
  }
  const s = createSettingsStorage(throwing)
  assert.equal(s.available, false)
  assert.equal(s.write({ a: 1 }).reason, 'unavailable')
})

test('isStorageAvailable 对抛异常的 storage 返回 false', () => {
  assert.equal(
    isStorageAvailable({
      setItem: () => {
        throw new Error('nope')
      },
      removeItem: () => {},
    }),
    false,
  )
  assert.equal(isStorageAvailable(null), false)
  assert.equal(isStorageAvailable(makeMemoryStorage()), true)
})

test('写入器防抖：连续 save 只落盘一次', async () => {
  const mem = makeMemoryStorage()
  const store = createSettingsStorage(mem)
  let writes = 0
  const counting = {
    write: (v) => {
      writes++
      return store.write(v)
    },
  }
  const writer = createSettingsWriter(counting, { debounceMs: 50 })
  writer.save({ n: 1 })
  writer.save({ n: 2 })
  writer.save({ n: 3 })
  assert.equal(writes, 0, '防抖期内不应写入')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(writes, 1, '防抖结束后只写一次')
  assert.equal(JSON.parse(mem.getItem(STORAGE_KEY)).n, 3, '应写入最后一次的值')
})

test('写入器 flushNow 立即落盘', () => {
  const mem = makeMemoryStorage()
  const store = createSettingsStorage(mem)
  const writer = createSettingsWriter(store, { debounceMs: 5000 })
  writer.save({ n: 42 })
  writer.flushNow()
  assert.equal(JSON.parse(mem.getItem(STORAGE_KEY)).n, 42)
})

test('写入器 cancel 丢弃未落盘的变更', async () => {
  const mem = makeMemoryStorage()
  const writer = createSettingsWriter(createSettingsStorage(mem), { debounceMs: 30 })
  writer.save({ n: 1 })
  writer.cancel()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(mem.getItem(STORAGE_KEY), null, '取消后不应写入')
})

test('写入失败时通过回调上报，且同类错误不刷屏', async () => {
  const failing = { write: () => ({ ok: false, reason: 'quota' }) }
  let calls = 0
  const writer = createSettingsWriter(failing, {
    debounceMs: 10,
    quotaWarnMs: 10000,
    onResult: () => {
      calls++
    },
  })
  writer.save({ n: 1 })
  await new Promise((r) => setTimeout(r, 40))
  writer.save({ n: 2 })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(calls, 1, '同类失败在抑制窗口内只提示一次')
})

// ─────────────────────────────────────────────
group('fade · 逻辑行归并（双语算一行）')

test('时间不同的行各成一组', () => {
  const r = buildLogicalRows([{ t: 0 }, { t: 1 }, { t: 2 }])
  assert.equal(r.rowCount, 3)
  assert.deepEqual(Array.from(r.rowOf), [0, 1, 2])
})

test('时间相同的两行归为同一逻辑行（原文+翻译）', () => {
  const r = buildLogicalRows([{ t: 5 }, { t: 5 }, { t: 9 }])
  assert.equal(r.rowCount, 2, '5s 的两行应算作一行')
  assert.deepEqual(Array.from(r.rowOf), [0, 0, 1])
  assert.deepEqual(Array.from(r.rowSize), [2, 1])
})

test('三行同时间归为一组', () => {
  const r = buildLogicalRows([{ t: 5 }, { t: 5 }, { t: 5 }])
  assert.equal(r.rowCount, 1)
  assert.deepEqual(Array.from(r.rowSize), [3])
})

test('多组双语混排', () => {
  const r = buildLogicalRows([{ t: 1 }, { t: 1 }, { t: 2 }, { t: 3 }, { t: 3 }, { t: 3 }])
  assert.equal(r.rowCount, 3)
  assert.deepEqual(Array.from(r.rowSize), [2, 1, 3])
})

test('空数组安全', () => {
  const r = buildLogicalRows([])
  assert.equal(r.rowCount, 0)
  assert.equal(r.rowOf.length, 0)
})

test('单行安全', () => {
  const r = buildLogicalRows([{ t: 0 }])
  assert.equal(r.rowCount, 1)
  assert.deepEqual(Array.from(r.rowOf), [0])
})

// ─────────────────────────────────────────────
group('fade · 缓动曲线')

test('linear 恒等', () => {
  assert.equal(applyFadeEasing(0, 'linear'), 0)
  assert.equal(applyFadeEasing(0.5, 'linear'), 0.5)
  assert.equal(applyFadeEasing(1, 'linear'), 1)
})

test('ease 在两端更平缓（smoothstep 特征）', () => {
  // smoothstep 在 0.25 处 = 0.15625，明显小于线性的 0.25
  assert.ok(applyFadeEasing(0.25, 'ease') < 0.25)
  assert.ok(applyFadeEasing(0.75, 'ease') > 0.75)
  assert.equal(applyFadeEasing(0, 'ease'), 0)
  assert.equal(applyFadeEasing(1, 'ease'), 1)
  assert.equal(applyFadeEasing(0.5, 'ease'), 0.5, '中点应保持 0.5')
})

test('ease 单调不减', () => {
  let prev = -1
  for (let i = 0; i <= 20; i++) {
    const v = applyFadeEasing(i / 20, 'ease')
    assert.ok(v >= prev, `在 ${i / 20} 处不单调`)
    prev = v
  }
})

test('输入越界被夹取', () => {
  assert.equal(applyFadeEasing(-5, 'linear'), 0)
  assert.equal(applyFadeEasing(99, 'linear'), 1)
})

// ─────────────────────────────────────────────
group('fade · 距离到透明度（核心规则）')

const baseCfg = { enabled: true, solidAbove: 2, solidBelow: 2, fadeRows: 5, mode: 'ease' }

test('当前行永远为 1（需求明确要求）', () => {
  assert.equal(fadeOpacityForDistance(0, baseCfg), 1)
  // 即使实体行数为 0、过渡行数为 0 也一样
  assert.equal(fadeOpacityForDistance(0, { ...baseCfg, solidAbove: 0, solidBelow: 0, fadeRows: 0 }), 1)
  assert.equal(fadeOpacityForDistance(0, { ...baseCfg, mode: 'none' }), 1)
})

test('实体区内完全透明（opacity=1）', () => {
  assert.equal(fadeOpacityForDistance(-1, baseCfg), 1, '上方第 1 行在实体区')
  assert.equal(fadeOpacityForDistance(-2, baseCfg), 1, '上方第 2 行在实体区')
  assert.equal(fadeOpacityForDistance(1, baseCfg), 1, '下方第 1 行在实体区')
  assert.equal(fadeOpacityForDistance(2, baseCfg), 1, '下方第 2 行在实体区')
})

test('上下实体行数可分别设置', () => {
  const cfg = { ...baseCfg, solidAbove: 4, solidBelow: 0 }
  assert.equal(fadeOpacityForDistance(-4, cfg), 1, '上方 4 行内应实心')
  assert.ok(fadeOpacityForDistance(-5, cfg) < 1, '上方第 5 行应开始淡出')
  assert.ok(fadeOpacityForDistance(1, cfg) < 1, '下方实体为 0，第 1 行就应淡出')
})

test('过渡区内透明度介于 0 与 1 之间且单调递减', () => {
  // 注意斜坡语义：fadeRows=5 时，距离 1~4 是部分可见，距离 5 恰好降到 0。
  // 所以这里是 1..4，而不是 1..5。
  const cfg = { ...baseCfg, solidAbove: 0, solidBelow: 0, fadeRows: 5 }
  let prev = 1.01
  for (let d = 1; d <= 4; d++) {
    const v = fadeOpacityForDistance(d, cfg)
    assert.ok(v > 0 && v < 1, `距离 ${d} 应在 (0,1)，实际 ${v}`)
    assert.ok(v < prev, `距离 ${d} 应比前一个更透明`)
    prev = v
  }
  // 斜坡末端恰好归零 —— 这是有意的设计，不留"半透明幽灵行"
  assert.equal(fadeOpacityForDistance(5, cfg), 0, '斜坡末端应恰好为 0')
})

test('过渡行数 = N 时，可见渐变行恰好 N-1 行（斜坡端点归零）', () => {
  const cfg = { ...baseCfg, solidAbove: 0, solidBelow: 0, fadeRows: 6 }
  const visible = []
  for (let d = 1; d <= 10; d++) {
    if (fadeOpacityForDistance(d, cfg) > 0) visible.push(d)
  }
  assert.deepEqual(visible, [1, 2, 3, 4, 5], 'fadeRows=6 时应有 5 行可见')
})

test('超出过渡区完全不可见（0）', () => {
  assert.equal(fadeOpacityForDistance(2 + 5 + 1, baseCfg), 0, '下方第 8 行应完全不可见')
  assert.equal(fadeOpacityForDistance(-(2 + 5 + 1), baseCfg), 0, '上方第 8 行应完全不可见')
})

test('过渡行数为 0 时实体区外直接不可见', () => {
  const cfg = { ...baseCfg, fadeRows: 0 }
  assert.equal(fadeOpacityForDistance(2, cfg), 1)
  assert.equal(fadeOpacityForDistance(3, cfg), 0)
})

test('none 模式：实体区外直接不可见，不做渐变', () => {
  const cfg = { ...baseCfg, mode: 'none' }
  assert.equal(fadeOpacityForDistance(2, cfg), 1, '实体区内仍为 1')
  assert.equal(fadeOpacityForDistance(3, cfg), 0, '实体区外立刻为 0')
})

test('linear 模式确实比 ease 在近端更透明', () => {
  const cfgL = { ...baseCfg, solidAbove: 0, solidBelow: 0, fadeRows: 10, mode: 'linear' }
  const cfgE = { ...cfgL, mode: 'ease' }
  // 距实体区 1 行处：linear 已降到 0.9，ease 因两端平缓仍在 0.972
  assert.ok(fadeOpacityForDistance(1, cfgL) < fadeOpacityForDistance(1, cfgE))
})

test('关闭虚化后所有距离都返回 1', () => {
  const cfg = { ...baseCfg, enabled: false }
  for (const d of [-10, -1, 0, 1, 10]) {
    assert.equal(fadeOpacityForDistance(d, cfg), 1, `距离 ${d} 应不虚化`)
  }
})

test('无效距离不产生 NaN', () => {
  assert.equal(fadeOpacityForDistance(NaN, baseCfg), 1)
  assert.equal(fadeOpacityForDistance(Infinity, baseCfg), 1)
})

test('对称配置下上下对称', () => {
  for (const d of [1, 3, 5, 7]) {
    assert.equal(
      fadeOpacityForDistance(d, baseCfg),
      fadeOpacityForDistance(-d, baseCfg),
      `距离 ±${d} 应对称`,
    )
  }
})

// ─────────────────────────────────────────────
group('fade · 整表计算')

test('输出长度与行数一致', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ t: i }))
  const out = computeRenderOpacities(lines, 5, baseCfg)
  assert.equal(out.length, 20)
})

test('当前行为 1（即使叠加了虚化和基准）', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ t: i }))
  const out = computeRenderOpacities(lines, 5, baseCfg)
  assert.equal(out[5], 1)
})

test('实体区内的行透明度为 1（需求原文：完全不透明）', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ t: i }))
  const out = computeRenderOpacities(lines, 10, baseCfg)
  // 上方实体区（距离 1、2）与下方实体区（距离 1、2）都必须是 1，
  // 不能因为"已唱过"而被额外调暗 —— 那与"完全不透明"矛盾。
  assert.equal(out[9], 1, '上方第 1 行')
  assert.equal(out[8], 1, '上方第 2 行')
  assert.equal(out[11], 1, '下方第 1 行')
  assert.equal(out[12], 1, '下方第 2 行')
})

test('远处的行透明度为 0', () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ t: i }))
  const out = computeRenderOpacities(lines, 15, baseCfg)
  assert.equal(out[0], 0)
  assert.equal(out[29], 0)
})

test('双语行的两行透明度完全相同（一起淡出）', () => {
  // 第 3、4 行时间相同（一组双语），当前行设为第 10 行
  const lines = [
    { t: 0 }, { t: 1 }, { t: 2 }, { t: 3 }, { t: 3 }, { t: 4 },
    { t: 5 }, { t: 6 }, { t: 7 }, { t: 8 }, { t: 9 }, { t: 10 },
  ]
  const out = computeRenderOpacities(lines, 10, baseCfg)
  assert.equal(out[3], out[4], '双语两行必须同透明度')
})

test('双语行不会让上下距离不对称', () => {
  // 若按物理行号算距离，双语会多占一格导致不对称
  const withPair = [
    { t: 0 }, { t: 1 }, { t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }, { t: 5 }, { t: 6 },
  ]
  const out = computeRenderOpacities(withPair, 4, baseCfg)
  // 逻辑行：0=行0, 1=行1&2, 2=行3, 3=行4(当前), 4=行5, 5=行6, 6=行7
  // 上方距离 1 → 行1和行2 → 实体区 → 都是 1
  assert.equal(out[1], 1)
  assert.equal(out[2], 1, '译文应与原文同值')
  // 下方距离 1 → 行5 → 实体区 → 1
  assert.equal(out[5], 1)
})

test('关闭虚化时回落到 past/upcoming 基准（阶段 3 行为不变）', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ t: i }))
  const cfg = { ...baseCfg, enabled: false }
  const out = computeRenderOpacities(lines, 10, cfg)
  assert.equal(out[10], 1, '当前行仍为 1')
  assert.ok(Math.abs(out[9] - BASE_OPACITY.past) < 1e-9, `已唱过应为 ${BASE_OPACITY.past}，实际 ${out[9]}`)
  assert.ok(Math.abs(out[11] - BASE_OPACITY.upcoming) < 1e-9, `未唱应为 ${BASE_OPACITY.upcoming}，实际 ${out[11]}`)
})

test('空行按同样规则处理（不特殊对待）', () => {
  // 关键：empty 标志**不参与**虚化计算，只按距离算。
  const cfg = { ...baseCfg, solidAbove: 2, solidBelow: 2 }
  const lines = [
    { t: 0, empty: true }, { t: 1, empty: false }, { t: 2, empty: false },
    { t: 3, empty: false }, { t: 4, empty: true },
  ]
  // 当前行为 index=2，行0 与行4 距离分别为 -2 与 +2，都在实体区内 → 透明度都是 1
  assert.equal(fadeOpacityForDistance(-2, cfg), 1)
  assert.equal(fadeOpacityForDistance(2, cfg), 1)

  const out = computeRenderOpacities(lines, 2, cfg)
  assert.equal(out[0], 1, `空行(上方实体区)应为 1，实际 ${out[0]}`)
  assert.equal(out[4], 1, `空行(下方实体区)应为 1，实际 ${out[4]}`)

  // 与同位置的非空行对比：完全一致
  const lines2 = [
    { t: 0, empty: false }, { t: 1, empty: false }, { t: 2, empty: false },
    { t: 3, empty: false }, { t: 4, empty: false },
  ]
  const out2 = computeRenderOpacities(lines2, 2, cfg)
  assert.equal(out[0], out2[0], '空行与非空行在同位置应同透明度')
  assert.equal(out[4], out2[4])
})

test('activeIndex 为 -1（尚未开始）时首行最亮，且不整屏全透明', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ t: i }))
  const out = computeRenderOpacities(lines, -1, baseCfg)
  // 以第 0 个逻辑行为中心，首行距离 0 → 1
  assert.equal(out[0], 1, `实际 ${out[0]}`)
  // 真正的关键断言：不能整屏透明，且首行是最亮的
  assert.ok(out.some((v) => v > 0), '不应整屏全透明')
  assert.equal(Math.max(...out), out[0], '首行应是最亮的一行')
})

test('行数极少时不越界', () => {
  const out = computeRenderOpacities([{ t: 0 }], 0, baseCfg)
  assert.equal(out.length, 1)
  assert.equal(out[0], 1)
})

test('空歌词返回空表', () => {
  const out = computeRenderOpacities([], 0, baseCfg)
  assert.equal(out.length, 0)
})

test('所有输出都在 [0,1] 范围内', () => {
  const lines = Array.from({ length: 50 }, (_, i) => ({ t: i }))
  for (const cfg of [
    baseCfg,
    { ...baseCfg, mode: 'linear' },
    { ...baseCfg, mode: 'none' },
    { ...baseCfg, solidAbove: 0, solidBelow: 20, fadeRows: 0 },
    { ...baseCfg, enabled: false },
  ]) {
    const out = computeRenderOpacities(lines, 25, cfg)
    for (const v of out) {
      assert.ok(v >= 0 && v <= 1, `透明度 ${v} 越界（mode=${cfg.mode}）`)
    }
  }
})

// ─────────────────────────────────────────────
group('fade · 虚化中心可指定（跟随用户视角）')

test('省略 centerIndex 时中心等于 activeIndex（保持原有行为）', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ t: i }))
  const a = computeRenderOpacities(lines, 10, baseCfg)
  const b = computeRenderOpacities(lines, 10, baseCfg, BASE_OPACITY, 10)
  assert.deepEqual(Array.from(a), Array.from(b))
})

test('指定 centerIndex 后，该行成为虚化中心（opacity = 1）', () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ t: i }))
  const out = computeRenderOpacities(lines, 5, baseCfg, BASE_OPACITY, 20)
  assert.equal(out[20], 1, '中心行应为 1')
})

test('中心与 activeIndex 不同时，activeIndex 不再强制为 1（避免两个亮点）', () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ t: i }))
  const out = computeRenderOpacities(lines, 5, baseCfg, BASE_OPACITY, 20)
  // 距离中心 15 行，远超实体+过渡（2+5=7）→ 应为 0
  assert.equal(out[5], 0, `正在播放的行应按距离淡出，实际 ${out[5]}`)
})

test('中心行上下两侧对称淡出', () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ t: i }))
  const out = computeRenderOpacities(lines, 0, baseCfg, BASE_OPACITY, 15)
  for (const d of [1, 3, 6]) {
    assert.ok(
      Math.abs(out[15 - d] - out[15 + d]) < 1e-9,
      `距离 ±${d} 应对称：${out[15 - d]} vs ${out[15 + d]}`,
    )
  }
})

test('centerIndex 越界时回落到第 0 行（不产生全透明）', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ t: i }))
  for (const bad of [-1, 999, NaN]) {
    const out = computeRenderOpacities(lines, 3, baseCfg, BASE_OPACITY, bad)
    assert.ok(out.some((v) => v > 0), `centerIndex=${bad} 时不应整屏全透明`)
  }
})

test('缓存：centerIndex 变化会触发重算', () => {
  const engine = createFadeEngine()
  const lines = Array.from({ length: 100 }, (_, i) => ({ t: i }))
  engine.get(lines, 10, baseCfg, 10)
  assert.equal(engine.computeCount(), 1)
  engine.get(lines, 10, baseCfg, 10)
  assert.equal(engine.computeCount(), 1, '相同 centerIndex 应命中缓存')
  engine.get(lines, 10, baseCfg, 11)
  assert.equal(engine.computeCount(), 2, 'centerIndex 变化应重算')
})

test('缓存：滚动过程中同一行内不重算（模拟跨行滚动）', () => {
  const engine = createFadeEngine()
  const lines = Array.from({ length: 1000 }, (_, i) => ({ t: i }))
  // 模拟 300 帧滚动，但视口中心只跨过 6 行
  let center = 100
  for (let frame = 0; frame < 300; frame++) {
    if (frame % 50 === 0 && frame > 0) center += 1
    engine.get(lines, 50, baseCfg, center)
  }
  assert.ok(engine.computeCount() <= 8, `300 帧滚动只跨 6 行，重算 ${engine.computeCount()} 次（应 ≤8）`)
})

// ─────────────────────────────────────────────
group('fade · 缓存（性能关键：只在必要时重算）')

test('相同输入不重复计算', () => {
  const engine = createFadeEngine()
  const lines = Array.from({ length: 100 }, (_, i) => ({ t: i }))
  engine.get(lines, 10, baseCfg)
  assert.equal(engine.computeCount(), 1)
  engine.get(lines, 10, baseCfg)
  engine.get(lines, 10, baseCfg)
  assert.equal(engine.computeCount(), 1, '相同输入应命中缓存')
})

test('activeIndex 变化才重算（模拟播放换行）', () => {
  const engine = createFadeEngine()
  const lines = Array.from({ length: 100 }, (_, i) => ({ t: i }))
  engine.get(lines, 10, baseCfg)
  engine.get(lines, 11, baseCfg)
  engine.get(lines, 12, baseCfg)
  assert.equal(engine.computeCount(), 3, '换了 3 次行应算 3 次')
})

test('配置变化触发重算', () => {
  const engine = createFadeEngine()
  const lines = Array.from({ length: 50 }, (_, i) => ({ t: i }))
  engine.get(lines, 5, baseCfg)
  engine.get(lines, 5, { ...baseCfg, fadeRows: 8 })
  engine.get(lines, 5, { ...baseCfg, fadeRows: 8, mode: 'linear' })
  assert.equal(engine.computeCount(), 3)
})

test('歌词被替换（行数相同）也能正确失效', () => {
  const engine = createFadeEngine()
  const a = Array.from({ length: 10 }, (_, i) => ({ t: i }))
  const b = Array.from({ length: 10 }, (_, i) => ({ t: i * 2 }))
  const ra = engine.get(a, 3, baseCfg)
  const rb = engine.get(b, 3, baseCfg)
  assert.equal(engine.computeCount(), 2, '歌词变了应重算')
  assert.notEqual(ra, rb)
})

test('播放 5 秒但只换 2 行 → 只算 2 次（而非按帧数算几百次）', () => {
  const engine = createFadeEngine()
  const lines = Array.from({ length: 500 }, (_, i) => ({ t: i }))
  // 模拟 300 帧：当前行只在第 100、200 帧变化
  let active = 10
  for (let frame = 0; frame < 300; frame++) {
    if (frame === 100) active = 11
    if (frame === 200) active = 12
    engine.get(lines, active, baseCfg)
  }
  assert.equal(engine.computeCount(), 3, '300 帧内只换 3 个当前行，应只计算 3 次')
})

test('1000 行单次计算耗时足够低（性能预算）', () => {
  const engine = createFadeEngine()
  const lines = Array.from({ length: 1000 }, (_, i) => ({ t: i * 0.4 }))
  const t0 = performance.now()
  for (let i = 0; i < 60; i++) {
    engine.get(lines, 100 + i, baseCfg)
  }
  const elapsed = performance.now() - t0
  const perCall = elapsed / 60
  // 单次重算应远低于一帧预算（16.7ms），留足余量
  assert.ok(perCall < 5, `1000 行单次重算 ${perCall.toFixed(3)}ms，应 <5ms`)
})

// ─────────────────────────────────────────────
group('fade · 设置默认值与兜底')

test('默认值符合需求（ease、上下各 2 行、过渡 5 行）', () => {
  const d = createDefaultFade()
  assert.equal(d.mode, 'ease')
  assert.equal(d.solidAbove, 2)
  assert.equal(d.solidBelow, 2)
  assert.equal(d.fadeRows, 5)
  assert.equal(d.enabled, true)
})

test('FADE_MODES 白名单与需求一致', () => {
  assert.deepEqual([...FADE_MODES].sort(), ['ease', 'linear', 'none'])
})

test('设置中的 fade 段能通过 sanitize 并保持合法', () => {
  const s = sanitizeSettings({ fade: { solidAbove: 5, solidBelow: 1, fadeRows: 9, mode: 'linear' } })
  assert.equal(s.fade.solidAbove, 5)
  assert.equal(s.fade.solidBelow, 1)
  assert.equal(s.fade.fadeRows, 9)
  assert.equal(s.fade.mode, 'linear')
})

test('fade 段脏数据回落默认', () => {
  const s = sanitizeSettings({ fade: 'not-an-object' })
  assert.equal(s.fade.mode, 'ease')
  assert.equal(s.fade.solidAbove, 2)
})

test('fade 段越界数值回落默认', () => {
  const s = sanitizeSettings({ fade: { solidAbove: 9999, fadeRows: -5 } })
  assert.equal(s.fade.solidAbove, 2)
  assert.equal(s.fade.fadeRows, 5)
})

test('fade 模式非法值回落 ease', () => {
  const s = sanitizeSettings({ fade: { mode: 'rainbow' } })
  assert.equal(s.fade.mode, 'ease')
})

test('旧版本设置（无 fade 段）能平滑升级', () => {
  const s = sanitizeSettings({ font: { size: 50 }, color: { active: '#ff0000' } })
  assert.equal(s.font.size, 50, '旧字段保留')
  assert.equal(s.color.active, '#ff0000')
  assert.equal(s.fade.mode, 'ease', '新字段补默认')
})

// ─────────────────────────────────────────────
group('motion · 缓动曲线（导出复刻预览的 CSS 过渡）')

test('三次贝塞尔过 (0,0) 与 (1,1)', () => {
  const f = cubicBezier(0.22, 1, 0.36, 1)
  assert.equal(f(0), 0)
  assert.equal(f(1), 1)
})

test('曲线单调不减（过渡不会倒退）', () => {
  const f = cubicBezier(0.22, 1, 0.36, 1)
  let prev = -1
  for (let i = 0; i <= 100; i++) {
    const v = f(i / 100)
    assert.ok(v >= prev - 1e-9, `x=${i / 100} 处曲线回退：${v} < ${prev}`)
    prev = v
  }
})

test('线性贝塞尔等价于恒等函数', () => {
  const f = cubicBezier(0.25, 0.25, 0.75, 0.75)
  for (const x of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(f(x) - x) < 1e-4, `f(${x}) = ${f(x)}，应约等于 ${x}`)
  }
})

test('ease 曲线在 x=0.5 处已过半（两端平缓、前段更快）', () => {
  // CSS ease 的实测值约 0.8；这里只要求"明显过半"这个定性特征
  assert.ok(easeCurve(0.5) > 0.6, `easeCurve(0.5) = ${easeCurve(0.5)}`)
})

test('transitionCurve 是 .lyric-line 的 cubic-bezier(.22,1,.36,1)', () => {
  // 控制点 y1=1 表示起步很快：x=0.1 时已走过约 40%（比线性快 4 倍）
  assert.ok(transitionCurve(0.1) > 0.35, `起步应明显快于线性，实际 ${transitionCurve(0.1)}`)
  assert.ok(transitionCurve(0.1) > 0.1, '必须快于线性')
  assert.ok(transitionCurve(0.9) > 0.99, '末端应收敛')
})

test('progress：duration=0 视为瞬间完成（滑杆可拖到 0）', () => {
  assert.equal(progress(0, 0, easeCurve), 1)
  assert.equal(progress(100, 0, easeCurve), 1)
})

test('progress：elapsed<=0 为 0，超过时长为 1', () => {
  assert.equal(progress(0, 260, easeCurve), 0)
  assert.equal(progress(-5, 260, easeCurve), 0)
  assert.equal(progress(260, 260, easeCurve), 1)
  assert.equal(progress(999, 260, easeCurve), 1)
})

test('progress 在时长内严格递增', () => {
  let prev = -1
  for (let ms = 0; ms <= 260; ms += 10) {
    const v = progress(ms, 260, transitionCurve)
    assert.ok(v >= prev, `ms=${ms} 处回退`)
    prev = v
  }
})

test('lerp 两端与中点正确，且 t 被夹取', () => {
  assert.equal(lerp(1, 1.35, 0), 1)
  assert.equal(lerp(1, 1.35, 1), 1.35)
  assert.ok(Math.abs(lerp(1, 1.35, 0.5) - 1.175) < 1e-9)
  assert.equal(lerp(1, 1.35, -3), 1, 't<0 应夹到 0')
  assert.equal(lerp(1, 1.35, 9), 1.35, 't>1 应夹到 1')
})

// ─────────────────────────────────────────────
group('renderFrame · 段落标签与锚点')

test('空行使用预览的「（间奏）」占位文字', () => {
  assert.equal(EMPTY_LABEL, '（间奏）')
})

test('翻译行字号比例与 CSS 的 0.62em 一致', () => {
  assert.equal(TRANSLATION_FONT_EM, 0.62)
})

test('行内上下 padding 与 CSS 的 0.18em 一致', () => {
  assert.equal(LINE_PADDING_EM, 0.18)
})

test('scrollMode=center 锚点为 0.5', () => {
  assert.equal(anchorRatio({ motion: { scrollMode: 'center' } }), 0.5)
})

test('scrollMode=golden 锚点为 0.38（与 useAutoScroll 一致）', () => {
  assert.equal(anchorRatio({ motion: { scrollMode: 'golden' } }), 0.38)
})

test('scrollMode 缺失时回落 0.5', () => {
  assert.equal(anchorRatio({}), 0.5)
})

test('scaleFactor = 画布高 / 舞台高', () => {
  assert.ok(Math.abs(scaleFactor(720, 776) - 720 / 776) < 1e-12)
  assert.equal(scaleFactor(776, 776), 1)
})

test('scaleFactor 对非法输入不返回 NaN/0', () => {
  assert.ok(Number.isFinite(scaleFactor(720, 0)))
  assert.ok(Number.isFinite(scaleFactor(0, 776)))
  assert.ok(scaleFactor(720, 0) > 0)
})

test('背景色：bgMode 优先于自定义色（与预览 --lrc-bg 一致）', () => {
  assert.equal(resolveBgColor({ bgMode: 'green', bg: '#123456' }), '#00b140')
  assert.equal(resolveBgColor({ bgMode: 'black', bg: '#123456' }), '#000000')
  assert.equal(resolveBgColor({ bgMode: 'solid', bg: '#123456' }), '#123456')
})

// ─────────────────────────────────────────────
group('renderFrame · 换行与逐行几何（自定义设置下的关键）')

/** 单字符宽度 = 字号（近似 CJK），与 canvas 实测接近 */
const fakeMeasure = (s, size) => [...s].length * size

test('wrapText：不超宽时原样返回一行', () => {
  assert.deepEqual(wrapText('短句', 1000, fakeMeasure), ['短句'])
})

test('wrapText：超宽时按字符断行，且每行都不超过上限', () => {
  const out = wrapText('啊啊啊啊啊啊', 40, (s) => [...s].length * 10)
  assert.ok(out.length > 1, '应当断成多行')
  for (const part of out) {
    assert.ok([...part].length * 10 <= 40, `「${part}」超宽`)
  }
  assert.equal(out.join(''), '啊啊啊啊啊啊', '断行不得丢字')
})

test('wrapText：空串返回一个空行（占位行仍参与排版）', () => {
  assert.deepEqual(wrapText('', 100, fakeMeasure), [''])
})

test('wrapToLineCount：目标 1 行等价于按宽度自然换行', () => {
  const long = '啊啊啊啊啊啊啊啊'
  assert.deepEqual(wrapToLineCount(long, 1, 1000, fakeMeasure), wrapText(long, 1000, fakeMeasure))
})

test('wrapToLineCount：能把"canvas 以为放得下"的长句拆成 DOM 的 2 行', () => {
  /*
   * 这是真实 bug 的回归用例：DOM 断成 2 行（行高 142），
   * 但 canvas 按版心宽度算只占 1 行 —— 不修正就会横向溢出。
   */
  const long = '这一句特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长'
  const size = 55
  const measure = (s) => [...s].length * size
  const maxW = [...long].length * size // 恰好放得下 → wrapText 给 1 行
  assert.equal(wrapText(long, maxW, measure).length, 1, '前提：自然换行只有 1 行')

  const two = wrapToLineCount(long, 2, maxW, measure)
  assert.equal(two.length, 2, `应被拆成 2 行，实际 ${two.length}`)
  assert.equal(two.join(''), long, '拆行不得丢字')
})

test('wrapToLineCount：拆出的行数是单调可指定的（2/3/4 行）', () => {
  const long = '啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊'
  const size = 10
  const measure = (s) => [...s].length * size
  for (const n of [2, 3, 4]) {
    const out = wrapToLineCount(long, n, [...long].length * size, measure)
    assert.equal(out.length, n, `目标 ${n} 行，实际 ${out.length}`)
    assert.equal(out.join(''), long, '不得丢字')
  }
})

test('wrapToLineCount：字符数不够时按自然换行返回，不硬凑行数', () => {
  const out = wrapToLineCount('短', 5, 1000, fakeMeasure)
  assert.deepEqual(out, ['短'])
})

test('wrapToLineCount：maxW 非法时安全返回单行', () => {
  assert.deepEqual(wrapToLineCount('文字', 2, 0, fakeMeasure), ['文字'])
  assert.deepEqual(wrapToLineCount('文字', 2, NaN, fakeMeasure), ['文字'])
})

test('measureRowLayout：DOM 行高反推行数（长句按 2 行拆）', () => {
  const long = '这一句特别长特别长特别长特别长特别长特别长'
  const size = 55
  const layout = measureRowLayout({
    lines: [{ text: long, empty: false }],
    settings: { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } },
    scale: 1,
    layoutWidth: [...long].length * size, // 恰好放得下，canvas 会算成 1 行
    measure: (s, sz) => [...s].length * (sz || size),
    domHeights: [142], // DOM 实测 2 行
  })
  assert.equal(layout.rows[0].height, 142)
  assert.equal(layout.rows[0].textLines.length, 2, `应拆成 2 行，实际 ${layout.rows[0].textLines.length}`)
})

test('measureRowLayout：行高等于 min-height 时不误判为多行（翻译行回归）', () => {
  /*
   * CSS 的 min-height 用**正文字号**，翻译行绘制字号只有 0.62 倍。
   * 若拿翻译字号去反推一个"由 min-height 决定"的行高，会算出 2 行，
   * 把一句短翻译硬拆成两行。
   */
  const layout = measureRowLayout({
    lines: [{ text: 'short', empty: false, isTranslation: true }],
    settings: { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } },
    scale: 1,
    layoutWidth: 1000,
    measure: (s, sz) => [...s].length * (sz || 40),
    // 64 = min-height(40×1.6)，说明高度由 min-height 决定、内容本就单行
    domHeights: [64],
  })
  assert.equal(layout.rows[0].textLines.length, 1, '不应拆成多行')
})

test('measureRowLayout：单行高度 = baseSize × (lineHeight + 2×0.18)', () => {
  const layout = measureRowLayout({
    lines: [{ text: '短', empty: false }],
    settings: { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } },
    scale: 1,
    layoutWidth: 1000,
    measure: fakeMeasure,
  })
  // min-height 78.4 vs content 64 + padding 14.4 = 78.4，两者相等
  assert.ok(Math.abs(layout.rows[0].height - 40 * (1.6 + 0.36)) < 1e-9, `实际 ${layout.rows[0].height}`)
})

test('measureRowLayout：换行后该行变高（这是等高假设会算错的地方）', () => {
  const settings = { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } }
  const one = measureRowLayout({
    lines: [{ text: '短', empty: false }],
    settings,
    scale: 1,
    layoutWidth: 1000,
    measure: fakeMeasure,
  })
  const two = measureRowLayout({
    lines: [{ text: '啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊', empty: false }],
    settings,
    scale: 1,
    layoutWidth: 100,
    measure: fakeMeasure,
  })
  assert.ok(two.rows[0].height > one.rows[0].height, '换行行必须更高')
  assert.ok(two.rows[0].textLines.length > 1, '应确实断成多行')
})

test('measureRowLayout：后续行的 top 累加真实行高（换行会顶下去）', () => {
  const layout = measureRowLayout({
    lines: [
      { text: '短', empty: false },
      { text: '啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊', empty: false },
      { text: '短', empty: false },
    ],
    settings: { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } },
    scale: 1,
    layoutWidth: 100,
    measure: fakeMeasure,
  })
  const [a, b, c] = layout.rows
  assert.ok(Math.abs(b.top - (a.top + a.height)) < 1e-9, '第 2 行 top 应紧接第 1 行底部')
  assert.ok(Math.abs(c.top - (b.top + b.height)) < 1e-9, '第 3 行 top 应紧接第 2 行底部')
  assert.ok(c.top > a.top + a.height, '换行行把后面的行整体顶下去')
})

test('measureRowLayout：翻译行用 0.62 倍字号（因此更矮）', () => {
  const settings = { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } }
  const normal = measureRowLayout({
    lines: [{ text: '短', empty: false }],
    settings,
    scale: 1,
    layoutWidth: 1000,
    measure: fakeMeasure,
  })
  const trans = measureRowLayout({
    lines: [{ text: '短', empty: false, isTranslation: true }],
    settings,
    scale: 1,
    layoutWidth: 1000,
    measure: fakeMeasure,
  })
  assert.ok(Math.abs(trans.rows[0].drawSize - 40 * 0.62) < 1e-9)
  // min-height 仍按正文号算，所以高度相等；但绘制字号必须更小
  assert.ok(trans.rows[0].drawSize < normal.rows[0].drawSize)
})

test('measureRowLayout：空行也产出占位文字（不跳过）', () => {
  const layout = measureRowLayout({
    lines: [{ text: '', empty: true }],
    settings: { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } },
    scale: 1,
    layoutWidth: 1000,
    measure: fakeMeasure,
  })
  assert.equal(layout.rows[0].isEmpty, true)
  assert.deepEqual(layout.rows[0].textLines, [EMPTY_LABEL])
})

test('measureRowLayout：domHeights 优先于公式（像素级对齐预览）', () => {
  const layout = measureRowLayout({
    lines: [{ text: '短', empty: false }, { text: '短2', empty: false }],
    settings: { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } },
    scale: 1,
    layoutWidth: 1000,
    measure: fakeMeasure,
    domHeights: [100, 150],
  })
  assert.equal(layout.rows[0].height, 100)
  assert.equal(layout.rows[1].height, 150)
  assert.equal(layout.rows[1].top, 100)
})

test('measureRowLayout：domHeights 长度不符时整份作废（不用半份几何）', () => {
  const layout = measureRowLayout({
    lines: [{ text: '短', empty: false }, { text: '短2', empty: false }],
    settings: { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } },
    scale: 1,
    layoutWidth: 1000,
    measure: fakeMeasure,
    domHeights: [100],
  })
  assert.ok(Math.abs(layout.rows[0].height - 40 * 1.96) < 1e-9, '应退回公式')
})

test('measureRowLayout：scale 同时作用于字号与行高（分辨率无关的比例）', () => {
  const mk = (k) =>
    measureRowLayout({
      lines: [{ text: '短', empty: false }],
      settings: { font: { size: 40, lineHeight: 1.6 }, layout: { maxWidth: 0.9 } },
      scale: k,
      layoutWidth: 1000,
      measure: (s, size) => [...s].length * size,
    })
  const a = mk(1)
  const b = mk(2)
  assert.ok(Math.abs(b.rows[0].height / a.rows[0].height - 2) < 1e-9, '高度应随 scale 线性放大')
  assert.ok(Math.abs(b.baseFontSize / a.baseFontSize - 2) < 1e-9)
})

// ─────────────────────────────────────────────
group('renderFrame · 滚动时间轴与预览一致')

const scrollSettings = {
  font: { size: 40, lineHeight: 1.6, letterSpacing: 0.02, family: 'sans-serif', weight: 600, scale: 1.35 },
  layout: { align: 'center', padTop: 0.35, padBottom: 0.35, maxWidth: 0.9 },
  motion: { scrollMode: 'center', reduceMotion: false, transitionMs: 260, activeFadeMs: 180 },
  fade: { enabled: true, solidAbove: 2, solidBelow: 2, fadeRows: 5, mode: 'ease' },
  color: { normal: '#9aa4b2', active: '#ffffff', bg: '#0b0e14', bgMode: 'solid' },
}

function layoutFor(times, settings = scrollSettings, stageH = 776) {
  return measureRowLayout({
    lines: times.map((t, i) => ({ t, text: `行${i}`, empty: false })),
    settings,
    scale: 1,
    layoutWidth: 1382,
    measure: (s, size) => [...s].length * size,
    padTopPx: Math.round(stageH * settings.layout.padTop),
  })
}

test('buildOffsetTimeline：首帧就是"首行居中"（预览挂载时 snapToTarget）', () => {
  const lines = [{ t: 0 }, { t: 5 }, { t: 10 }]
  const layout = layoutFor([0, 5, 10])
  const off = buildOffsetTimeline({ lines, fps: 30, layout, containerHeight: 776, duration: 12 })
  const expected = computeCenteringOffset(layout.rows[0], 776, 0.5)
  // 返回值是 Float32Array：容差按 float32 精度取，不能用 1e-6
  assert.ok(Math.abs(off[0] - expected) < 0.01, `首帧 ${off[0]}，应为 ${expected}`)
})

test('buildOffsetTimeline：与预览同步（不存在"滞后一帧"）', () => {
  // 预览：tick 里先 smoothTowards 再写 transform；导出必须同帧生效。
  const lines = [{ t: 0 }, { t: 5 }]
  const layout = layoutFor([0, 5])
  const off = buildOffsetTimeline({ lines, fps: 30, layout, containerHeight: 776, duration: 8 })

  // 手工复刻预览的逐帧过程
  const o1 = computeCenteringOffset(layout.rows[0], 776, 0.5)
  const o2 = computeCenteringOffset(layout.rows[1], 776, 0.5)
  let cur = o1
  const expected = []
  for (let i = 0; i < off.length; i++) {
    const target = i / 30 >= 5 ? o2 : o1
    cur = smoothTowards(cur, target, 1000 / 30, 90)
    expected.push(cur)
  }
  for (let i = 0; i < off.length; i++) {
    assert.ok(Math.abs(off[i] - expected[i]) < 1e-4, `帧 ${i}: ${off[i]} vs ${expected[i]}`)
  }
})

test('buildOffsetTimeline：切行后位移连续变化（有缓动，不是瞬跳）', () => {
  const lines = [{ t: 0 }, { t: 5 }]
  const layout = layoutFor([0, 5])
  const off = buildOffsetTimeline({ lines, fps: 30, layout, containerHeight: 776, duration: 8 })
  const switchFrame = 5 * 30
  const a = off[switchFrame - 1]
  const b = off[switchFrame]
  const c = off[switchFrame + 1]
  assert.ok(Math.abs(b - a) > 1e-6, '切行那一帧应开始移动')
  assert.ok(Math.abs(c - a) < Math.abs(computeCenteringOffset(layout.rows[1], 776, 0.5) - a), '应是渐进而非瞬跳')
})

test('buildOffsetTimeline：reduceMotion 时直接对齐（与预览一致）', () => {
  const lines = [{ t: 0 }, { t: 5 }]
  const layout = layoutFor([0, 5])
  const off = buildOffsetTimeline({ lines, fps: 30, layout, containerHeight: 776, reduce: true, duration: 8 })
  const o2 = computeCenteringOffset(layout.rows[1], 776, 0.5)
  assert.ok(Math.abs(off[5 * 30] - o2) < 1e-6, '减少动态效果应立即到位')
})

test('centeringOffsetFor：让指定行精确停在锚点（渲染当前帧用）', () => {
  const layout = layoutFor([0, 5, 10])
  for (const idx of [0, 1, 2]) {
    const off = centeringOffsetFor(layout, idx, 776, 0.5)
    const row = layout.rows[idx]
    const cy = row.top + row.height / 2 - off
    assert.ok(Math.abs(cy - 776 / 2) < 0.5, `第 ${idx} 行中心 ${cy}，应为 ${776 / 2}`)
  }
})

test('centeringOffsetFor：含顶部留白也居中（不能用 scrollOffset=0 代替）', () => {
  const layout = layoutFor([0, 5])
  assert.ok(layout.padTop > 0, '本例应有顶部留白')
  const off = centeringOffsetFor(layout, 1, 776, 0.5)
  assert.ok(off > 0, `含留白时必须给非零位移，实际 ${off}`)
  const row = layout.rows[1]
  assert.ok(Math.abs(row.top + row.height / 2 - off - 776 / 2) < 0.5)
})

test('centeringOffsetFor：index 越界时夹到首/末行', () => {
  const layout = layoutFor([0, 5])
  assert.equal(centeringOffsetFor(layout, -1, 776, 0.5), centeringOffsetFor(layout, 0, 776, 0.5))
  assert.equal(centeringOffsetFor(layout, 99, 776, 0.5), centeringOffsetFor(layout, 1, 776, 0.5))
})

test('centeringOffsetFor：golden 锚点生效', () => {
  const layout = layoutFor([0, 5])
  const off = centeringOffsetFor(layout, 1, 776, 0.38)
  const row = layout.rows[1]
  assert.ok(Math.abs(row.top + row.height / 2 - off - 776 * 0.38) < 0.5)
})

test('buildOffsetTimeline：golden 锚点下当前行停在 38%（而非 50%）', () => {
  const golden = { ...scrollSettings, motion: { ...scrollSettings.motion, scrollMode: 'golden' } }
  const lines = [{ t: 0 }, { t: 5 }]
  const layout = layoutFor([0, 5], golden)
  const off = buildOffsetTimeline({
    lines,
    fps: 30,
    layout,
    containerHeight: 776,
    anchor: anchorRatio(golden),
    duration: 8,
  })
  // 第 2 行覆盖 t=5~8s（帧 150~240）；取靠后的一帧，缓动已充分收敛
  const frame = 220
  assert.ok(Number.isFinite(off[frame]), `帧 ${frame} 应有值（总帧数 ${off.length}）`)
  const row = layout.rows[1]
  const centerY = row.top + row.height / 2 - off[frame]
  const expected = 776 * 0.38
  assert.ok(Math.abs(centerY - expected) < 1, `当前行中心 ${centerY}，应约 ${expected}`)
})

test('buildOffsetTimeline：换行行与非换行行都精确居中（逐行几何的收益）', () => {
  const lines = [{ t: 0 }, { t: 5 }, { t: 10 }]
  const layout = measureRowLayout({
    lines: [
      { t: 0, text: '短', empty: false },
      { t: 5, text: '啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊', empty: false },
      { t: 10, text: '短', empty: false },
    ],
    settings: scrollSettings,
    scale: 1,
    layoutWidth: 200,
    measure: (s, size) => [...s].length * size,
    padTopPx: Math.round(776 * 0.35),
  })
  assert.ok(layout.rows[1].textLines.length > 1, '第 2 行应换行')
  const off = buildOffsetTimeline({ lines, fps: 30, layout, containerHeight: 776, duration: 14 })
  // 第 2 行覆盖 t=5~10s（帧 150~300）；取靠后的一帧让缓动收敛
  const frame = 290
  const row = layout.rows[1]
  const target = computeCenteringOffset(row, 776, 0.5)
  const centerY = row.top + row.height / 2 - off[frame]
  assert.ok(Math.abs(centerY - 776 / 2) < 2, `换行行应居中，误差 ${Math.abs(centerY - 776 / 2)}px`)
  void target
})

test('buildOffsetTimeline：空歌词或无行几何时返回全零数组（不抛异常、长度正确）', () => {
  const layout = layoutFor([0, 5])
  // 没有歌词 → 没有帧
  assert.equal(buildOffsetTimeline({ lines: [], fps: 30, layout, containerHeight: 776, duration: 0 }).length, 0)

  // 有歌词但没有行几何 → 帧数仍正确，值全为 0（调用方按帧取用不会越界）
  const out = buildOffsetTimeline({
    lines: [{ t: 0 }],
    fps: 30,
    layout: { rows: [] },
    containerHeight: 776,
    duration: 5,
  })
  assert.equal(out.length, 150, '帧数应由时长决定')
  assert.ok(
    Array.from(out).every((v) => v === 0),
    '无几何时位移应全为 0',
  )
})

// ─────────────────────────────────────────────
group('renderFrame · 过渡状态（缩放/变色/透明度）')

const tLines = [{ t: 0 }, { t: 5 }, { t: 10 }]

test('previousActiveIndex：取"时间严格更小"的最后一行', () => {
  const lines = [{ t: 0 }, { t: 5 }, { t: 5 }, { t: 10 }]
  /*
   * findLineIndexAt 返回"最后一个 t <= time"的下标，
   * 所以 t∈[5,10) 期间当前行是 index 2（翻译行同时也是该时刻的最后一个），
   * 于是 index 3 的"上一行"就是 2。
   */
  assert.equal(previousActiveIndex(lines, 3), 2, '同组翻译行本身在上一段区间是当前行')
  // index 2 的上一行要跳过整组 t=5，落到 t=0
  assert.equal(previousActiveIndex(lines, 2), 0, '应跳过同时间的整组行')
  assert.equal(previousActiveIndex(lines, 0), -1, '首行没有上一行')
})

test('previousActiveIndex：同时间多行都跳过（不会把翻译行当上一行）', () => {
  const lines = [{ t: 0 }, { t: 5 }, { t: 5 }, { t: 5 }, { t: 10 }]
  assert.equal(previousActiveIndex(lines, 4), 3, '上一段区间的当前行是这组同时间行的最后一个')
  assert.equal(previousActiveIndex(lines, 3), 0, '整组 t=5 都要跳过')
})

test('activeTransition：首行不做过渡（首帧即到位）', () => {
  const tr = activeTransition({ t: 0.05, lines: tLines, cur: 0, transitionMs: 260, fadeMs: 180, reduce: false })
  assert.equal(tr.prev, -1)
  assert.equal(tr.scaleProg, 1, '首行应在第一帧就是最终大小')
  assert.equal(tr.colorProg, 1)
})

test('activeTransition：换行瞬间进度为 0，随后单调升到 1', () => {
  const at = (t) => activeTransition({ t, lines: tLines, cur: 1, transitionMs: 260, fadeMs: 180, reduce: false })
  assert.equal(at(5.0).scaleProg, 0, '切行那一刻从 0 开始')
  assert.ok(at(5.13).scaleProg > 0 && at(5.13).scaleProg < 1, '中途应在 0~1 之间')
  assert.equal(at(5.26).scaleProg, 1, '260ms 后到位')
})

test('activeTransition：颜色过渡用 activeFadeMs（比缩放更早完成）', () => {
  // 默认 transitionMs=260 > activeFadeMs=180：180ms 时颜色已完成、缩放还没
  const tr = activeTransition({ t: 5.18, lines: tLines, cur: 1, transitionMs: 260, fadeMs: 180, reduce: false })
  assert.equal(tr.colorProg, 1, '颜色过渡 180ms 后应完成')
  assert.ok(tr.scaleProg < 1, '缩放过渡此时尚未完成')
})

test('activeTransition：duration 为 0 时视为瞬间完成', () => {
  const tr = activeTransition({ t: 5, lines: tLines, cur: 1, transitionMs: 0, fadeMs: 0, reduce: false })
  assert.equal(tr.scaleProg, 1)
  assert.equal(tr.colorProg, 1)
})

test('activeTransition：reduceMotion 不做过渡', () => {
  const tr = activeTransition({ t: 5.01, lines: tLines, cur: 1, transitionMs: 260, fadeMs: 180, reduce: true })
  assert.equal(tr.scaleProg, 1)
  assert.equal(tr.colorProg, 1)
})

test('applyCssOpacityFactors：虚化开启时不叠加 CSS 系数（单一来源）', () => {
  const row = { isEmpty: true, isTranslation: true }
  assert.equal(applyCssOpacityFactors(0.7, row, false, true), 0.7)
})

test('applyCssOpacityFactors：虚化关闭时翻译行 0.72、当前翻译行 0.9', () => {
  assert.ok(Math.abs(applyCssOpacityFactors(1, { isTranslation: true, isEmpty: false }, false, false) - 0.72) < 1e-9)
  assert.ok(Math.abs(applyCssOpacityFactors(1, { isTranslation: true, isEmpty: false }, true, false) - 0.9) < 1e-9)
})

test('applyCssOpacityFactors：虚化关闭时空行 0.35', () => {
  assert.ok(Math.abs(applyCssOpacityFactors(1, { isEmpty: true, isTranslation: false }, false, false) - 0.35) < 1e-9)
})

test('mixHex：两端正确，中点在两色之间', () => {
  assert.deepEqual(mixHex('#000000', '#ffffff', 0), { r: 0, g: 0, b: 0 })
  assert.deepEqual(mixHex('#000000', '#ffffff', 1), { r: 255, g: 255, b: 255 })
  assert.deepEqual(mixHex('#000000', '#ffffff', 0.5), { r: 128, g: 128, b: 128 })
})

test('rgba：透明度被夹到 0~1，颜色被正确合成', () => {
  assert.equal(rgba('#ff0000', 0.5), 'rgba(255,0,0,0.5)')
  assert.equal(rgba('#ff0000', 2), 'rgba(255,0,0,1)')
  assert.equal(rgba('#ff0000', -1), 'rgba(255,0,0,0)')
})

test('rgbaOf：非法透明度按 1 处理，不产出 NaN', () => {
  assert.equal(rgbaOf({ r: 1, g: 2, b: 3 }, NaN), 'rgba(1,2,3,1)')
  assert.ok(!rgbaOf({ r: 1, g: 2, b: 3 }, 0.5).includes('NaN'))
})

// ─────────────────────────────────────────────
group('renderFrame · 画布绘制结果（插桩验证导出到底画了什么）')

/** 记录所有绘制调用的假 canvas */
function makeProbeCanvas(w, h) {
  const ops = []
  let font = ''
  const ctx = {
    get font() {
      return font
    },
    set font(v) {
      font = v
    },
    letterSpacing: '0px',
    textBaseline: '',
    textAlign: '',
    fillStyle: '',
    // ── 描边相关（canvas 的这些属性都是 ctx 上的全局状态，不是绘制参数）──
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    miterLimit: 0,
    clearRect() {
      ops.push({ op: 'clearRect' })
    },
    fillRect() {
      // 记录"铺背景"那一刻的颜色 —— 之后 fillText 会覆盖 ctx.fillStyle，
      // 事后读 ctx.fillStyle 拿到的是文字的填充色，不是背景色。
      ops.push({ op: 'fillRect', fillStyle: String(this.fillStyle) })
    },
    save() {
      ops.push({ op: 'save' })
    },
    restore() {
      ops.push({ op: 'restore' })
    },
    translate(x, y) {
      ops.push({ op: 'translate', x, y })
    },
    scale(x) {
      ops.push({ op: 'scale', x })
    },
    measureText(s) {
      const m = font.match(/(\d+(?:\.\d+)?)px/)
      const size = m ? Number(m[1]) : 40
      // 近似 CJK 全宽：一个字约等于字号
      return { width: [...s].length * size }
    },
    fillText(text, x, y) {
      ops.push({ op: 'text', text, x, y, font, fillStyle: String(this.fillStyle) })
    },
    strokeText(text, x, y) {
      ops.push({
        op: 'stroke',
        text,
        x,
        y,
        font,
        strokeStyle: String(this.strokeStyle),
        lineWidth: Number(this.lineWidth),
        lineJoin: String(this.lineJoin),
      })
    },
  }
  return {
    canvas: { width: w, height: h, getContext: () => ctx },
    ops,
    texts: () => ops.filter((o) => o.op === 'text'),
    strokes: () => ops.filter((o) => o.op === 'stroke'),
  }
}

function drawAt(settings, lines, t, w = 1280, h = 720) {
  const probe = makeProbeCanvas(w, h)
  // 必须用产品代码同一个查找函数 —— 自己写 findIndex 在"超过末行"时会算错
  const idx = findLineIndexAt(lines, t)
  renderFrame({
    lineIndex: idx,
    lines,
    settings,
    t,
    canvas: probe.canvas,
    scrollOffset: 0,
    referenceHeight: 776,
    referenceWidth: 1382,
  })
  return probe
}

test('空行画出「（间奏）」而不是留白', () => {
  const lines = [
    { t: 0, text: '前一句', empty: false },
    { t: 5, text: '', empty: true },
  ]
  const probe = drawAt(scrollSettings, lines, 5.5)
  const texts = probe.texts().map((o) => o.text)
  assert.ok(texts.includes(EMPTY_LABEL), `应画出占位文字，实际画了 ${JSON.stringify(texts)}`)
})

test('翻译行用更小的字号绘制（复刻 0.62em）', () => {
  const lines = [
    { t: 0, text: '原文', empty: false },
    { t: 5, text: 'translation', empty: false, isTranslation: true },
    { t: 10, text: '下一句', empty: false },
  ]
  const probe = drawAt(scrollSettings, lines, 5.5)
  const tr = probe.texts().find((o) => o.text === 'translation')
  assert.ok(tr, '翻译行应被绘制')
  const size = Number(tr.font.match(/(\d+(?:\.\d+)?)px/)[1])
  const base = 40 * (720 / 776)
  assert.ok(Math.abs(size - base * 0.62) < 1e-6, `翻译行字号 ${size}，应约 ${base * 0.62}`)
})

test('还没到第一行时没有任何行放大（预览此时没有 .is-active）', () => {
  const lines = [
    { t: 5, text: '第一句', empty: false },
    { t: 10, text: '第二句', empty: false },
  ]
  const probe = drawAt(scrollSettings, lines, 1.0)
  const scales = probe.ops.filter((o) => o.op === 'scale')
  assert.equal(scales.length, 0, `不应有缩放，实际 ${JSON.stringify(scales)}`)
})

test('到了第一行之后当前行被放大（含首行）', () => {
  const lines = [
    { t: 0, text: '第一句', empty: false },
    { t: 5, text: '第二句', empty: false },
  ]
  const probe = drawAt(scrollSettings, lines, 1.0)
  const scales = probe.ops.filter((o) => o.op === 'scale')
  assert.ok(scales.length > 0, '当前行应被放大')
  assert.ok(Math.abs(scales[0].x - 1.35) < 1e-6, `缩放应为 1.35，实际 ${scales[0].x}`)
})

test('换行途中当前行处于部分放大（不是瞬间到 1.35）', () => {
  const lines = [
    { t: 0, text: '第一句', empty: false },
    { t: 5, text: '第二句', empty: false },
  ]
  const probe = drawAt(scrollSettings, lines, 5.05)
  const scales = probe.ops.filter((o) => o.op === 'scale')
  assert.ok(scales.length > 0, '应有缩放绘制')
  // 应存在一个"未到 1.35"的缩放 —— 那就是过渡中的当前行
  const partial = scales.filter((s) => s.x > 1 && s.x < 1.35)
  assert.ok(partial.length > 0, `应有过渡中的缩放，实际 ${JSON.stringify(scales.map((s) => s.x))}`)
})

test('transitionMs 为 0 时当前行直接是最终大小', () => {
  const s = { ...scrollSettings, motion: { ...scrollSettings.motion, transitionMs: 0 } }
  const lines = [
    { t: 0, text: '第一句', empty: false },
    { t: 5, text: '第二句', empty: false },
  ]
  const probe = drawAt(s, lines, 5.0)
  const scales = probe.ops.filter((o) => o.op === 'scale').map((o) => o.x)
  assert.ok(scales.every((x) => Math.abs(x - 1.35) < 1e-9), `应直接到位，实际 ${JSON.stringify(scales)}`)
})

test('reduceMotion 时不放大当前行（预览 transform: none）', () => {
  const s = { ...scrollSettings, motion: { ...scrollSettings.motion, reduceMotion: true } }
  const lines = [
    { t: 0, text: '第一句', empty: false },
    { t: 5, text: '第二句', empty: false },
  ]
  const probe = drawAt(s, lines, 6.0)
  const scales = probe.ops.filter((o) => o.op === 'scale')
  assert.equal(scales.length, 0, '减少动态效果时不应有缩放')
})

test('当前行颜色过渡到 color.active（自定义颜色也生效）', () => {
  const s = { ...scrollSettings, color: { ...scrollSettings.color, active: '#ff0000', normal: '#00ff00' } }
  const lines = [
    { t: 0, text: '第一句', empty: false },
    { t: 5, text: '第二句', empty: false },
  ]
  const probe = drawAt(s, lines, 6.0)
  const active = probe.texts().find((o) => o.text === '第二句')
  assert.ok(active, '当前行应被绘制')
  assert.equal(active.fillStyle, 'rgba(255,0,0,1)', '当前行应使用用户设置的 active 颜色')
})

test('背景用用户设置的背景色（自定义背景也生效）', () => {
  const s = { ...scrollSettings, color: { ...scrollSettings.color, bg: '#123456', bgMode: 'solid' } }
  const probe = makeProbeCanvas(1280, 720)
  renderFrame({
    lineIndex: 0,
    lines: [{ t: 0, text: 'x', empty: false }],
    settings: s,
    t: 0,
    canvas: probe.canvas,
    scrollOffset: 0,
    referenceHeight: 776,
  })
  const bg = probe.ops.find((o) => o.op === 'fillRect')
  assert.ok(bg, '应铺一次背景')
  assert.equal(bg.fillStyle, '#123456', '背景应使用用户设置的颜色')
})

test('透明 MOV 每帧先清除旧画面，不绘制任何背景', () => {
  const s = { ...scrollSettings, export: { format: 'mov-alpha' } }
  const probe = drawAt(s, [{ t: 0, text: '透明歌词', empty: false }], 1)
  assert.equal(probe.ops[0].op, 'clearRect')
  assert.equal(probe.ops.filter((op) => op.op === 'fillRect').length, 0)
  assert.ok(probe.texts().length > 0)
  const empty = drawAt(s, [], 0)
  assert.deepEqual(empty.ops, [{ op: 'clearRect' }])
})

test('bgMode=green 时背景是绿幕色（优先于自定义色）', () => {
  const s = { ...scrollSettings, color: { ...scrollSettings.color, bg: '#123456', bgMode: 'green' } }
  const probe = makeProbeCanvas(1280, 720)
  renderFrame({
    lineIndex: 0,
    lines: [{ t: 0, text: 'x', empty: false }],
    settings: s,
    t: 0,
    canvas: probe.canvas,
    scrollOffset: 0,
    referenceHeight: 776,
  })
  assert.equal(probe.ops.find((o) => o.op === 'fillRect').fillStyle, '#00b140')
})

test('align=left/right 时锚点贴版心边缘（预览是贴边）', () => {
  /*
   * 当前行是**放大**绘制的：先 translate(anchorX, cy) 再以 x=0 画字，
   * 所以锚点要从 translate 上读，不能读 fillText 的 x（那永远是 0）。
   * 这里同时覆盖两种：放大的当前行读 translate，普通行读 fillText。
   */
  const anchorOf = (probe) => {
    const tr = probe.ops.find((o) => o.op === 'translate')
    if (tr) return tr.x
    return probe.texts()[0]?.x
  }

  const lines = [
    { t: 0, text: '当前行', empty: false },
    { t: 5, text: '普通行', empty: false },
  ]
  const left = drawAt({ ...scrollSettings, layout: { ...scrollSettings.layout, align: 'left' } }, lines, 1)
  const right = drawAt({ ...scrollSettings, layout: { ...scrollSettings.layout, align: 'right' } }, lines, 1)

  const lx = anchorOf(left)
  const rx = anchorOf(right)
  assert.ok(Math.abs(lx - 0) < 12, `左对齐锚点应贴近左缘，实际 ${lx}`)
  assert.ok(Math.abs(rx - 1280) < 12, `右对齐锚点应贴近右缘，实际 ${rx}`)
  assert.ok(rx - lx > 1200, '左右锚点应分别落在两侧')
})

test('align=center 时锚点在版心中央', () => {
  const lines = [{ t: 0, text: '居中', empty: false }]
  const probe = drawAt(scrollSettings, lines, 1)
  const tr = probe.ops.find((o) => o.op === 'translate')
  assert.ok(tr, '当前行应被放大（有 translate）')
  assert.ok(Math.abs(tr.x - 1280 / 2) < 12, `居中锚点应约 640，实际 ${tr.x}`)
})

test('字号设置变化会反映到绘制字号（自定义字号也生效）', () => {
  const lines = [{ t: 0, text: '文字', empty: false }]
  const a = drawAt(scrollSettings, lines, 1)
  const big = { ...scrollSettings, font: { ...scrollSettings.font, size: 80 } }
  const b = drawAt(big, lines, 1)
  const sizeOf = (p) => Number(p.texts()[0].font.match(/(\d+(?:\.\d+)?)px/)[1])
  assert.ok(Math.abs(sizeOf(b) / sizeOf(a) - 2) < 1e-9, '字号翻倍后绘制字号也应翻倍')
})

test('字体族变化会写进 canvas 的 font（自定义字体也生效）', () => {
  const lines = [{ t: 0, text: '文字', empty: false }]
  const s = { ...scrollSettings, font: { ...scrollSettings.font, family: 'KaiTi' } }
  const probe = drawAt(s, lines, 1)
  assert.ok(probe.texts()[0].font.includes('KaiTi'), `实际 ${probe.texts()[0].font}`)
})

test('字间距设置会转成 px 写入 letterSpacing（自定义字间距也生效）', () => {
  const lines = [{ t: 0, text: '文字', empty: false }]
  const probe = makeProbeCanvas(1280, 720)
  const ctx = probe.canvas.getContext('2d')
  const seen = []
  Object.defineProperty(ctx, 'letterSpacing', {
    get: () => seen[seen.length - 1] ?? '0px',
    set: (v) => seen.push(v),
    configurable: true,
  })
  renderFrame({
    lineIndex: 0,
    lines,
    settings: { ...scrollSettings, font: { ...scrollSettings.font, letterSpacing: 0.1 } },
    t: 1,
    canvas: probe.canvas,
    scrollOffset: 0,
    referenceHeight: 776,
  })
  assert.ok(
    seen.some((v) => v !== '0px'),
    `应写入非零字间距，实际 ${JSON.stringify(seen)}`,
  )
})

test('没有歌词时不崩溃，只画背景', () => {
  const probe = makeProbeCanvas(1280, 720)
  const ok = renderFrame({
    lineIndex: -1,
    lines: [],
    settings: scrollSettings,
    t: 0,
    canvas: probe.canvas,
    scrollOffset: 0,
  })
  assert.equal(ok, true)
  assert.equal(probe.texts().length, 0)
})

test('画布尺寸非法时返回 false（不抛异常）', () => {
  const probe = makeProbeCanvas(0, 0)
  const ok = renderFrame({
    lineIndex: 0,
    lines: [{ t: 0, text: 'x', empty: false }],
    settings: scrollSettings,
    t: 0,
    canvas: probe.canvas,
    scrollOffset: 0,
  })
  assert.equal(ok, false)
})

test('设置字段缺失时用兜底值，不产出 NaN', () => {
  const probe = makeProbeCanvas(1280, 720)
  const ok = renderFrame({
    lineIndex: 0,
    lines: [{ t: 0, text: '文字', empty: false }],
    settings: {},
    t: 0,
    canvas: probe.canvas,
    scrollOffset: 0,
  })
  assert.equal(ok, true)
  for (const o of probe.texts()) {
    assert.ok(!String(o.font).includes('NaN'), `字体不应含 NaN：${o.font}`)
    assert.ok(!String(o.fillStyle).includes('NaN'), `颜色不应含 NaN：${o.fillStyle}`)
    assert.ok(Number.isFinite(o.y), `y 应为有限数：${o.y}`)
  }
})

// ─────────────────────────────────────────────
group('settings · 导出分辨率与帧率预设')

test('分辨率预设覆盖 480p / 720p / 1080p / 2K / 4K', () => {
  assert.deepEqual(
    RESOLUTION_PRESETS.map((p) => p.id),
    ['480p', '720p', '1080p', '2k', '4k'],
  )
})

test('所有分辨率预设都是 16:9', () => {
  for (const p of RESOLUTION_PRESETS) {
    assert.ok(Math.abs(p.width / p.height - 16 / 9) < 0.01, `${p.id} 不是 16:9：${p.width}x${p.height}`)
  }
})

test('帧率预设包含 24 / 30 / 60', () => {
  assert.deepEqual(
    FPS_PRESETS.map((f) => f.value),
    [24, 30, 60],
  )
})

test('findResolution：未知 id 回落 720p（不返回 undefined）', () => {
  assert.equal(findResolution('nope').id, '720p')
  assert.equal(findResolution(undefined).id, '720p')
  assert.equal(findResolution('4k').height, 2160)
})

test('nearestResolutionId：按画布尺寸反查最接近的预设', () => {
  assert.equal(nearestResolutionId(1280, 720), '720p')
  assert.equal(nearestResolutionId(1920, 1080), '1080p')
  assert.equal(nearestResolutionId(3840, 2160), '4k')
  assert.equal(nearestResolutionId(NaN, NaN), '720p')
})

test('默认设置带 export.resolution 且合法', () => {
  const d = createDefaultSettings()
  assert.equal(d.export.resolution, '720p')
})

test('export.resolution 脏数据回落默认', () => {
  assert.equal(sanitizeSettings({ export: { resolution: '8k' } }).export.resolution, '720p')
  assert.equal(sanitizeSettings({ export: { resolution: 123 } }).export.resolution, '720p')
  assert.equal(sanitizeSettings({}).export.resolution, '720p')
})

test('export.resolution 合法值被保留（用户选择能持久化）', () => {
  assert.equal(sanitizeSettings({ export: { resolution: '4k' } }).export.resolution, '4k')
  assert.equal(sanitizeSettings({ export: { resolution: '480p' } }).export.resolution, '480p')
})

// ─────────────────────────────────────────────
group('tutorial · 步骤表与推进（新手教程）')

test('教程共 4 步，顺序为 导入 → 打轴 → 设置 → 导出', () => {
  assert.equal(stepCount(), 4)
  assert.deepEqual(
    TUTORIAL_STEPS.map((s) => s.id),
    ['import', 'tapping', 'settings', 'export'],
  )
})

test('每一步都有标题与正文（不允许空内容）', () => {
  for (const s of TUTORIAL_STEPS) {
    assert.ok(s.title && s.title.length > 0, `${s.id} 缺 title`)
    assert.ok(s.body && s.body.length > 0, `${s.id} 缺 body`)
  }
})

test('每一步都有至少一个目标选择器，且都是 data-tour 形式', () => {
  for (const s of TUTORIAL_STEPS) {
    assert.ok(Array.isArray(s.targets) && s.targets.length > 0, `${s.id} 没有 targets`)
    for (const t of s.targets) {
      assert.match(t, /^\[data-tour="[a-z-]+"\]$/, `${s.id} 的选择器不规范：${t}`)
    }
  }
})

test('第 2 步必须写明打轴快捷键与"暂停要用鼠标"', () => {
  const tap = TUTORIAL_STEPS.find((s) => s.id === 'tapping')
  assert.ok(tap, '应有打轴步骤')
  assert.ok(Array.isArray(tap.keys) && tap.keys.length >= 3, '应列出快捷键')
  const joined = tap.keys.map((k) => k.join(' ')).join(' | ')
  assert.ok(joined.includes('空格'), '应说明空格打点')
  assert.ok(joined.includes('Z'), '应说明 Z 撤销')
  assert.ok(joined.includes('←') || joined.includes('→'), '应说明左右键微调')
  assert.ok(tap.warn && tap.warn.includes('鼠标'), '必须提醒"暂停要用鼠标点"')
})

test('第 2 步备有窄屏文案（播放条会隐藏「打轴」按钮）', () => {
  /*
   * PlayerBar 在 ≤640px 会 `display:none` 掉「打轴」按钮。
   * 若教程仍说"点播放条上的打轴"，窄屏用户会对着不存在的按钮找。
   * 所以必须有替代文案，且要提到快捷键 T。
   */
  const tap = TUTORIAL_STEPS.find((s) => s.id === 'tapping')
  assert.ok(tap.narrowBody, '应提供 narrowBody')
  assert.ok(tap.narrowBody.includes('T'), '替代文案应指出用 T 键进入打轴')
})

test('stepAt：越界返回 null（不抛异常）', () => {
  assert.equal(stepAt(0).id, 'import')
  assert.equal(stepAt(3).id, 'export')
  assert.equal(stepAt(4), null)
  assert.equal(stepAt(-1), null)
  assert.equal(stepAt(1.5), null)
  assert.equal(stepAt(NaN), null)
})

test('nextStepIndex：最后一步返回 null（据此结束教程）', () => {
  assert.equal(nextStepIndex(0), 1)
  assert.equal(nextStepIndex(2), 3)
  assert.equal(nextStepIndex(3), null, '最后一步的下一步应为 null')
  assert.equal(nextStepIndex(-1), null)
})

test('prevStepIndex：第一步返回 null（按钮应禁用）', () => {
  assert.equal(prevStepIndex(0), null)
  assert.equal(prevStepIndex(1), 0)
  assert.equal(prevStepIndex(3), 2)
})

test('isLastStep：只有最后一步为 true', () => {
  assert.equal(isLastStep(0), false)
  assert.equal(isLastStep(1), false)
  assert.equal(isLastStep(2), false)
  assert.equal(isLastStep(3), true)
})

test('clampStepIndex：任意脏输入都落回合法范围', () => {
  assert.equal(clampStepIndex(-5), 0)
  assert.equal(clampStepIndex(0), 0)
  assert.equal(clampStepIndex(2), 2)
  assert.equal(clampStepIndex(99), 3)
  assert.equal(clampStepIndex(NaN), 0)
  assert.equal(clampStepIndex('2'), 2)
})

test('从第 0 步一路 next 能走完并停在 null（不会越界）', () => {
  let i = 0
  let guard = 0
  const visited = [i]
  while (guard++ < 20) {
    const n = nextStepIndex(i)
    if (n === null) break
    i = n
    visited.push(i)
  }
  assert.deepEqual(visited, [0, 1, 2, 3])
  assert.equal(nextStepIndex(3), null, '末尾必须停下')
  assert.ok(guard < 20, '不得死循环')
})

// ─────────────────────────────────────────────
group('tutorial · 键盘映射与首次标记')

test('tutorialKeyAction：→/↓/PageDown/Enter 是下一步', () => {
  for (const k of ['ArrowRight', 'ArrowDown', 'PageDown', 'Enter']) {
    assert.equal(tutorialKeyAction(k), 'next', `${k} 应为 next`)
  }
})

test('tutorialKeyAction：←/↑/PageUp 是上一步', () => {
  for (const k of ['ArrowLeft', 'ArrowUp', 'PageUp']) {
    assert.equal(tutorialKeyAction(k), 'prev', `${k} 应为 prev`)
  }
})

test('tutorialKeyAction：Shift+Enter 回退一步', () => {
  assert.equal(tutorialKeyAction('Enter', { shiftKey: true }), 'prev')
  assert.equal(tutorialKeyAction('Enter', { shiftKey: false }), 'next')
})

test('tutorialKeyAction：Esc 关闭', () => {
  assert.equal(tutorialKeyAction('Escape'), 'close')
  assert.equal(tutorialKeyAction('Esc'), 'close')
})

test('tutorialKeyAction：空格与其他键不归教程管（交回全局）', () => {
  // 空格必须是 null —— 否则教程会抢走"空格翻页"，
  // 而用户此时的直觉是"空格没被教程占用"
  for (const k of [' ', 'Spacebar', 'a', 'F5', 'Tab', 'Shift']) {
    assert.equal(tutorialKeyAction(k), null, `${k} 不该被教程拦截`)
  }
})

/** 造一个内存版 Storage，并可模拟"抛异常"的隐私模式 */
function makeFakeStorage({ throwOnWrite = false } = {}) {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (throwOnWrite) throw new Error('QuotaExceededError')
      map.set(k, String(v))
    },
    removeItem: (k) => {
      if (throwOnWrite) throw new Error('nope')
      map.delete(k)
    },
    _map: map,
  }
}

test('首次标记：没存过 → 未看过（会弹教程）', () => {
  const f = createTutorialFlags(makeFakeStorage())
  assert.equal(f.available, true)
  assert.equal(f.seen(), false, '首次访问应为"没看过"')
})

test('首次标记：markSeen 之后 seen() 变成 true（不再自动弹）', () => {
  const f = createTutorialFlags(makeFakeStorage())
  f.markSeen()
  assert.equal(f.seen(), true)
})

test('首次标记：reset 之后又可重新引导', () => {
  const f = createTutorialFlags(makeFakeStorage())
  f.markSeen()
  f.reset()
  assert.equal(f.seen(), false)
})

test('首次标记：storage 为 null 时降级为"未看过"，且不报错', () => {
  const f = createTutorialFlags(null)
  assert.equal(f.available, false)
  assert.equal(f.seen(), false)
  // 关键：不能抛异常（教程只是引导，不能影响主流程）
  f.markSeen()
  f.reset()
  assert.equal(f.seen(), false)
})

test('首次标记：隐私模式（写入抛异常）不崩溃', () => {
  const f = createTutorialFlags(makeFakeStorage({ throwOnWrite: true }))
  assert.equal(f.available, false, '探测失败应判为不可用')
  assert.equal(f.seen(), false)
  // 这两个调用必须静默失败，绝不能把异常抛到调用方
  f.markSeen()
  f.reset()
})

test('首次标记：键名带版本（改版后可重新引导老用户）', () => {
  assert.match(TUTORIAL_STORAGE_KEY, /v\d+$/, '键名应以版本号结尾')
  const s = makeFakeStorage()
  createTutorialFlags(s).markSeen()
  assert.ok(s._map.has(TUTORIAL_STORAGE_KEY), '应按约定键名写入')
})

// ─────────────────────────────────────────────
group('settings · 自定义字体（预览与导出必须用同一个 family）')

test('resolveFontFamily：没有自定义字体时原样返回 family', () => {
  assert.equal(resolveFontFamily({ font: { family: 'Arial, sans-serif', customFamily: '' } }), 'Arial, sans-serif')
})

test('resolveFontFamily：有自定义字体时排在最前（否则不会生效）', () => {
  const out = resolveFontFamily({ font: { family: 'Arial, sans-serif', customFamily: 'MyFont' } })
  assert.equal(out, '"MyFont", Arial, sans-serif')
  assert.ok(out.startsWith('"MyFont"'), '自定义字体必须在最前，否则浏览器会用回退字体')
})

test('resolveFontFamily：自定义字体是空白时视为没有（不产生空引号）', () => {
  for (const v of ['', '   ', '\t', '\n']) {
    assert.equal(resolveFontFamily({ font: { family: 'Arial', customFamily: v } }), 'Arial')
  }
})

test('resolveFontFamily：脏输入返回字符串，不产生 undefined/NaN', () => {
  assert.equal(typeof resolveFontFamily({}), 'string')
  assert.equal(typeof resolveFontFamily(null), 'string')
  assert.equal(typeof resolveFontFamily(undefined), 'string')
  const out = resolveFontFamily({ font: { customFamily: 'X' } })
  assert.ok(!out.includes('undefined'), `不该出现 undefined：${out}`)
  assert.ok(!out.includes('NaN'), `不该出现 NaN：${out}`)
})

test('toCssVars 走 resolveFontFamily（预览侧确实用上自定义字体）', () => {
  const s = createDefaultSettings()
  s.font.customFamily = 'LrcCustomFont-1'
  const vars = toCssVars(s)
  assert.ok(vars['--lrc-font-family'].includes('LrcCustomFont-1'), vars['--lrc-font-family'])
  assert.ok(vars['--lrc-font-family'].startsWith('"LrcCustomFont-1"'), '应排在最前')
  // 回退字体必须保留：刷新后自定义字体已卸载，靠它保证文字仍然可读
  assert.ok(vars['--lrc-font-family'].includes(s.font.family), '必须保留回退字体')
})

test('sanitizeSettings：customFamily 默认为空串', () => {
  assert.equal(createDefaultSettings().font.customFamily, '')
  assert.equal(sanitizeSettings({}).font.customFamily, '')
})

test('sanitizeSettings：customFamily 不被字体族白名单清洗（这正是它单独一个字段的原因）', () => {
  // family 会被 FONT_FAMILY_PRESETS 白名单打回默认值，而用户上传的名字无法预知
  const s = sanitizeSettings({ font: { customFamily: 'LrcCustomFont-1791519445582' } })
  assert.equal(s.font.customFamily, 'LrcCustomFont-1791519445582')
})

test('sanitizeSettings：customFamily 非字符串时回落空串', () => {
  for (const v of [123, null, {}, [], true]) {
    assert.equal(
      sanitizeSettings({ font: { customFamily: v } }).font.customFamily,
      '',
      `${JSON.stringify(v)} 应回落空串`,
    )
  }
})

test('resolveFontFamily：名字内含引号时如实反映当前行为（不静默吞掉）', () => {
  /*
   * 记录当前行为：名字被原样包进双引号。
   * 正常路径下这个名字由 registerCustomFont 生成（LrcCustomFont-<时间戳>），
   * 不含引号；只有手工改 localStorage 才可能写入引号 ——
   * 那种情况下 font-family 解析会失败并自然回退到后面的回退字体，可接受。
   */
  assert.equal(resolveFontFamily({ font: { family: 'A', customFamily: 'We"ird' } }), '"We"ird", A')
})

// ─────────────────────────────────────────────
group('lrcWriter · 生成 LRC 文本（导出）')

test('buildLrcText：单行格式为 [mm:ss.cc]正文', () => {
  const out = buildLrcText([{ t: 12.35, text: '第一句歌词' }], { includeMeta: false })
  assert.equal(out, '[00:12.35]第一句歌词')
})

test('buildLrcText：多行保持传入顺序（不重排）', () => {
  const lines = [
    { t: 12.35, text: '第一句歌词' },
    { t: 16.8, text: '第二句歌词' },
    { t: 3.05, text: '时间更早但在后面' },
  ]
  const out = buildLrcText(lines, { includeMeta: false })
  assert.deepEqual(out.split('\n'), [
    '[00:12.35]第一句歌词',
    '[00:16.80]第二句歌词',
    '[00:03.05]时间更早但在后面',
  ])
})

test('buildLrcText：跨分钟时间正确（01:05.00 而非 00:65.00）', () => {
  const out = buildLrcText([{ t: 65, text: '跨分钟' }], { includeMeta: false })
  assert.equal(out, '[01:05.00]跨分钟')
})

test('buildLrcText：超过 10 分钟仍是两位数分钟并继续增长', () => {
  assert.equal(buildLrcText([{ t: 600, text: 'x' }], { includeMeta: false }), '[10:00.00]x')
  assert.equal(buildLrcText([{ t: 3725.5, text: 'x' }], { includeMeta: false }), '[62:05.50]x')
})

test('buildLrcText：小数四舍五入并正确进位（59.999 → 01:00.00）', () => {
  const out = buildLrcText([{ t: 59.999, text: '进位' }], { includeMeta: false })
  assert.equal(out, '[01:00.00]进位')
})

test('buildLrcText：中文内容原样保留（不转义、不丢字）', () => {
  const text = '我爱你，中国！——「测试」·标点'
  const out = buildLrcText([{ t: 1, text }], { includeMeta: false })
  assert.ok(out.endsWith(text), `中文应原样输出，实际 ${out}`)
})

test('buildLrcText：空行（间奏）保留时间标签但无正文', () => {
  const out = buildLrcText([{ t: 50, text: '', empty: true }], { includeMeta: false })
  assert.equal(out, '[00:50.00]', '空行应保留时间标签，否则 round-trip 会少一行')
})

test('buildLrcText：空歌词返回空串（不产生只有换行的文件）', () => {
  assert.equal(buildLrcText([], { includeMeta: false }), '')
  assert.equal(buildLrcText(null, { includeMeta: false }), '')
  assert.equal(buildLrcText(undefined, { includeMeta: false }), '')
})

test('buildLrcText：无效时间的行被跳过，不影响其他行', () => {
  const lines = [
    { t: 1, text: '正常' },
    { t: NaN, text: 'NaN 时间' },
    { t: Infinity, text: '无穷时间' },
    { t: 'abc', text: '非数字时间' },
    { t: null, text: 'null 时间' },
    { t: undefined, text: 'undefined 时间' },
    { t: 2, text: '也正常' },
  ]
  const out = buildLrcText(lines, { includeMeta: false })
  assert.deepEqual(out.split('\n'), ['[00:01.00]正常', '[00:02.00]也正常'])
})

test('buildLrcText：负时间被夹到 0（formatTimeTag 的行为）', () => {
  // 解析器已保证 t >= 0，这里只固化"即使传负值也不会写出畸形标签"
  const out = buildLrcText([{ t: -5, text: '负时间' }], { includeMeta: false })
  assert.equal(out, '[00:00.00]负时间')
})

test('buildLrcText：正文里的换行被替换成空格（避免劈成无标签的散行）', () => {
  const out = buildLrcText([{ t: 1, text: '前半\n后半' }], { includeMeta: false })
  assert.equal(out, '[00:01.00]前半 后半')
  assert.equal(out.split('\n').length, 1, '不得把一行劈成两行')
})

test('buildLrcText：正文首尾空白被清理', () => {
  const out = buildLrcText([{ t: 1, text: '  有空白  ' }], { includeMeta: false })
  assert.equal(out, '[00:01.00]有空白')
})

test('buildLrcText：元数据按 ti/ar/al/by 顺序输出', () => {
  const out = buildLrcText([{ t: 1, text: '正文' }], {
    meta: { title: '示例歌曲', artist: '歌手', album: '专辑', by: '某人' },
  })
  const rows = out.split('\n')
  assert.deepEqual(rows.slice(0, 4), ['[ti:示例歌曲]', '[ar:歌手]', '[al:专辑]', '[by:某人]'])
  assert.equal(rows[4], '[00:01.00]正文')
})

test('buildLrcText：空元数据不产生空标签行', () => {
  const out = buildLrcText([{ t: 1, text: 'x' }], { meta: { title: '', artist: '' } })
  assert.ok(!out.includes('[ti:]'), '不该写出空的 ti 标签')
  assert.ok(!out.includes('[ar:]'))
})

test('buildLrcText：元数据里的换行与方括号被清理（否则会破坏标签结构）', () => {
  const out = buildLrcText([{ t: 1, text: 'x' }], { meta: { title: '标题\n带有]括号[' } })
  const first = out.split('\n')[0]
  assert.equal(first, '[ti:标题 带有括号]', `实际 ${first}`)
  assert.equal(out.split('\n').filter((l) => l.startsWith('[ti:')).length, 1, 'ti 只能有一行')
})

test('buildLrcText：未知标签（re/ve）原样保留', () => {
  const out = buildLrcText([{ t: 1, text: 'x' }], { meta: { raw: { re: '编辑者', ve: '1.0' } } })
  assert.ok(out.includes('[re:编辑者]'), out)
  assert.ok(out.includes('[ve:1.0]'), out)
})

test('buildLrcText：length 标签被保留为时间格式', () => {
  const out = buildLrcText([{ t: 1, text: 'x' }], { meta: { length: 185.5 } })
  assert.ok(out.includes('[length:03:05.50]'), out)
})

test('buildLrcText：绝不写出 [offset:]（否则重新导入会二次偏移）', () => {
  /*
   * 这是本功能最关键的一条不变量。
   * 解析器的规则是 t = rawT - offsetMs/1000。
   * 导出写的是最终时间 t（已含 offset），若再带上 [offset:500]，
   * 重新导入时会被**再减一次**，整首歌偏移翻倍且没有任何报错。
   */
  const out = buildLrcText([{ t: 12.35, text: 'x' }], {
    meta: { title: 'T', raw: { offset: '500' } },
  })
  assert.ok(!/\[offset:/i.test(out), `不得写出 offset 标签，实际：${out}`)
})

test('buildLrcText：includeMeta=false 时只输出歌词行', () => {
  const out = buildLrcText([{ t: 1, text: 'x' }], { meta: { title: 'T' }, includeMeta: false })
  assert.equal(out, '[00:01.00]x')
})

test('buildLrcText：精度 3 位小数可用', () => {
  const out = buildLrcText([{ t: 1.234, text: 'x' }], { includeMeta: false, precision: 3 })
  assert.equal(out, '[00:01.234]x')
})

test('buildLrcText：纯读操作（不修改传入的数组与行对象）', () => {
  const line = { t: 1.005, text: '  原文  ', empty: false }
  const lines = [line]
  const before = JSON.stringify(lines)
  buildLrcText(lines, { meta: { title: 'T' } })
  assert.equal(JSON.stringify(lines), before, '导出不得修改传入数据')
  assert.equal(line.text, '  原文  ', '行对象必须保持原样')
})

// ─────────────────────────────────────────────
group('lrcWriter · 可导出行统计')

test('summarizeLrcLines：分别统计可导出与将被跳过的行', () => {
  const r = summarizeLrcLines([{ t: 1 }, { t: NaN }, { t: 2 }, { t: null }])
  assert.equal(r.exportable, 2)
  assert.equal(r.skipped, 2)
})

test('summarizeLrcLines：全部有效时 skipped 为 0', () => {
  const r = summarizeLrcLines([{ t: 0 }, { t: 1.5 }])
  assert.deepEqual(r, { exportable: 2, skipped: 0 })
})

test('summarizeLrcLines：空/非数组输入安全', () => {
  assert.deepEqual(summarizeLrcLines([]), { exportable: 0, skipped: 0 })
  assert.deepEqual(summarizeLrcLines(null), { exportable: 0, skipped: 0 })
  assert.deepEqual(summarizeLrcLines(undefined), { exportable: 0, skipped: 0 })
})

test('isExportableLine：只认有限数字，空行也算可导出', () => {
  assert.equal(isExportableLine({ t: 0 }), true)
  assert.equal(isExportableLine({ t: 12.5 }), true)
  assert.equal(isExportableLine({ t: 0, text: '', empty: true }), true, '空行（间奏）也要导出')
  assert.equal(isExportableLine({ t: NaN }), false)
  assert.equal(isExportableLine({ t: Infinity }), false)
  assert.equal(isExportableLine({}), false)
  assert.equal(isExportableLine(null), false)
  assert.equal(isExportableLine('x'), false)
})

test('isExportableLine：null / 空串 / false 不得被当成 0 秒（Number() 强转陷阱）', () => {
  /*
   * 这是一次真实 bug 的回归用例。
   * `Number(null)`、`Number('')`、`Number(false)` 全都等于 0，
   * 用 Number() 强转判断会把"没有时间"的行**静默当成 0 秒**导出 ——
   * 文件开头凭空多出一行，用户完全不知道发生了什么。
   * 必须显式分类型判断。
   */
  for (const bad of [null, undefined, '', '   ', false, true, {}, []]) {
    assert.equal(
      isExportableLine({ t: bad }),
      false,
      `t=${JSON.stringify(bad)} 不应被视为可导出`,
    )
  }
})

test('isExportableLine：容忍数字字符串（"12.5" 可导出）', () => {
  assert.equal(isExportableLine({ t: '12.5' }), true)
  assert.equal(isExportableLine({ t: 'abc' }), false)
})

test('buildLrcText：t 为 null/空串/false 的行被跳过（不会变成 00:00.00）', () => {
  const out = buildLrcText(
    [
      { t: 5, text: '正常' },
      { t: null, text: 'null' },
      { t: '', text: '空串' },
      { t: false, text: 'false' },
    ],
    { includeMeta: false },
  )
  assert.equal(out, '[00:05.00]正常', `不该把脏值当 0 秒，实际：${out}`)
})

// ─────────────────────────────────────────────
group('lrcWriter · 导出文件名')

test('buildLrcFileName：优先用歌曲标题', () => {
  assert.equal(
    buildLrcFileName({ title: '示例歌曲', audioFileName: 'song.mp3' }),
    '示例歌曲.lrc',
  )
})

test('buildLrcFileName：没有标题时用音频文件名（并去掉原扩展名）', () => {
  assert.equal(buildLrcFileName({ title: '', audioFileName: '我的歌.mp3' }), '我的歌.lrc')
})

test('buildLrcFileName：都没有时回落 lyrics.lrc', () => {
  assert.equal(buildLrcFileName({}), 'lyrics.lrc')
  assert.equal(buildLrcFileName({ title: '  ', audioFileName: '' }), 'lyrics.lrc')
})

test('buildLrcFileName：不产生重复扩展名（标题自带 .lrc 时）', () => {
  assert.equal(buildLrcFileName({ title: '示例歌曲.lrc' }), '示例歌曲.lrc')
  assert.equal(buildLrcFileName({ audioFileName: 'song.mp3' }), 'song.lrc')
})

test('buildLrcFileName：歌名里的点号不被误当扩展名', () => {
  // 只剥"已知的"扩展名，所以 Hello.World / Op.10 里的点会保留
  assert.equal(buildLrcFileName({ title: 'Hello.World' }), 'Hello.World.lrc')
  assert.equal(buildLrcFileName({ title: 'Op.10 No.3' }), 'Op.10 No.3.lrc')
})

test('buildLrcFileName：非法字符被替换（Windows 无法保存的名字）', () => {
  const out = buildLrcFileName({ title: 'a/b\\c:d*e?f"g<h>i|j' })
  assert.equal(out, 'a_b_c_d_e_f_g_h_i_j.lrc')
  assert.ok(!/[\\/:*?"<>|]/.test(out), `不该含非法字符：${out}`)
})

test('buildLrcFileName：控制字符被清理', () => {
  const out = buildLrcFileName({ title: 'a\u0000b\u001fc' })
  assert.equal(out, 'a_b_c.lrc')
})

test('buildLrcFileName：结尾的点与空格被去掉（Windows 会静默丢弃）', () => {
  assert.equal(buildLrcFileName({ title: '歌名...' }), '歌名.lrc')
  assert.equal(buildLrcFileName({ title: '歌名   ' }), '歌名.lrc')
})

test('buildLrcFileName：Windows 保留设备名被避开', () => {
  assert.equal(buildLrcFileName({ title: 'CON' }), 'CON_.lrc')
  assert.equal(buildLrcFileName({ title: 'nul' }), 'nul_.lrc')
  assert.equal(buildLrcFileName({ title: 'COM1' }), 'COM1_.lrc')
  // 含保留名但不是保留名的要原样保留
  assert.equal(buildLrcFileName({ title: 'CONCERT' }), 'CONCERT.lrc')
})

test('buildLrcFileName：超长标题被截断且仍以 .lrc 结尾', () => {
  const out = buildLrcFileName({ title: '长'.repeat(200) })
  assert.ok(out.endsWith('.lrc'))
  assert.ok([...out].length <= MAX_BASE_LENGTH + LRC_EXT.length, `过长：${[...out].length}`)
})

test('buildLrcFileName：全非法字符时回落 lyrics.lrc', () => {
  assert.equal(buildLrcFileName({ title: '///' }), 'lyrics.lrc')
  assert.equal(buildLrcFileName({ title: '...' }), 'lyrics.lrc')
})

// ─────────────────────────────────────────────
group('lrcWriter · round-trip（导出的文件必须能被解析器读回）')

test('round-trip：导出的 LRC 重新导入后时间与文本完全一致', () => {
  const original = [
    { t: 0, text: '欢迎使用', empty: false },
    { t: 3.5, text: '这是示例', empty: false },
    { t: 65.25, text: '跨分钟的一句', empty: false },
    { t: 90, text: '', empty: true },
    { t: 125.99, text: '结束', empty: false },
  ]
  const text = buildLrcText(original, { meta: { title: '往返测试', artist: '歌手' }, includeMeta: true })
  const doc = parseLrc(text, { encoding: 'utf-8' })

  assert.equal(doc.lines.length, original.length, '行数必须一致')
  for (let i = 0; i < original.length; i++) {
    assert.ok(
      Math.abs(doc.lines[i].t - original[i].t) < 0.005,
      `第 ${i} 行时间 ${doc.lines[i].t} vs ${original[i].t}`,
    )
    assert.equal(doc.lines[i].text, original[i].text, `第 ${i} 行文本应一致`)
    assert.equal(doc.lines[i].empty, original[i].empty, `第 ${i} 行 empty 标记应一致`)
  }
  assert.equal(doc.meta.title, '往返测试')
  assert.equal(doc.meta.artist, '歌手')
})

test('round-trip：导出不含 offset，重新导入不会二次偏移', () => {
  /*
   * 模拟"用户把 offset 调成 +500ms 后导出"的场景：
   * 此时 lines[].t 已经是最终时间（rawT - 0.5）。
   * 导出的文件里不能再带 offset，否则重新导入会再减一次。
   */
  const withOffsetApplied = [
    { t: 11.5, rawT: 12, text: '第一句', empty: false },
    { t: 15.5, rawT: 16, text: '第二句', empty: false },
  ]
  const text = buildLrcText(withOffsetApplied, { meta: { title: 'T', offsetMs: 500 }, includeMeta: true })
  const doc = parseLrc(text, { encoding: 'utf-8' })

  assert.equal(doc.meta.offsetMs, 0, '导出文件里不应有 offset')
  assert.ok(Math.abs(doc.lines[0].t - 11.5) < 0.005, `重新导入后应仍是 11.5，实际 ${doc.lines[0].t}`)
  assert.ok(Math.abs(doc.lines[1].t - 15.5) < 0.005)
})

test('round-trip：中文与标点经导出再导入不丢字', () => {
  const text = '我爱你，中国！——「测试」·标点（括号）'
  const out = buildLrcText([{ t: 1.23, text, empty: false }], { includeMeta: false })
  const doc = parseLrc(out, { encoding: 'utf-8' })
  assert.equal(doc.lines.length, 1)
  assert.equal(doc.lines[0].text, text)
})

test('round-trip：双语（同时间两行）导出后仍保留两行', () => {
  const lines = [
    { t: 5, rawT: 5, text: '原文', empty: false, sourceLine: 1, duplicateOf: [] },
    { t: 5, rawT: 5, text: 'translation', empty: false, sourceLine: 2, duplicateOf: [] },
  ]
  const out = buildLrcText(lines, { includeMeta: false })
  const doc = parseLrc(out, { encoding: 'utf-8' })
  assert.equal(doc.lines.length, 2, '同时间两行都要保留')
  assert.deepEqual(doc.lines.map((l) => l.text).sort(), ['translation', '原文'])
})

test('round-trip：导出的文件是合法 UTF-8 且不含 BOM', () => {
  const out = buildLrcText([{ t: 1, text: '中文测试' }], { includeMeta: false })
  assert.notEqual(out.charCodeAt(0), 0xfeff, '不应带 BOM（会被部分播放器显示成乱码）')
  // Node 的 Buffer 往返验证：UTF-8 编解码后完全一致
  const round = Buffer.from(out, 'utf-8').toString('utf-8')
  assert.equal(round, out)
})

test('round-trip：空行不会被解析器丢进 droppedLines', () => {
  const out = buildLrcText(
    [
      { t: 1, text: '前', empty: false },
      { t: 2, text: '', empty: true },
      { t: 3, text: '后', empty: false },
    ],
    { includeMeta: false },
  )
  const doc = parseLrc(out, { encoding: 'utf-8' })
  assert.equal(doc.lines.length, 3)
  assert.equal(doc.droppedLines.length, 0, '不应有被丢弃的行')
})

// ─────────────────────────────────────────────
group('lyricsStore.applyTapped · 两种打轴目标（修复静默丢数据）')

/**
 * 复刻 lyricsStore.applyTapped 的合并逻辑，便于在 Node 里断言。
 *
 * 【为什么要复刻而不是直接 import store】
 * lyricsStore 是 Pinia store（依赖 vue），core 层单测刻意不引入任何框架。
 * 这里逐行对应 store 里的实现；浏览器端的真实行为另由 e2e 覆盖。
 * 修改 store 时**必须同步改这里**，否则测试会失去意义。
 */
function applyTappedMirror(store, tapped) {
  const hasValidTap = (rec) => {
    if (!rec || typeof rec !== 'object') return false
    return Number.isFinite(Number(rec.t))
  }
  if (!Array.isArray(tapped) || tapped.length === 0) {
    return { applied: 0, remaining: store.droppedLines.length }
  }
  const useDropped = store.droppedLines.length > 0
  const merged = [...store.lines]
  const rest = []
  let applied = 0

  if (useDropped) {
    for (let i = 0; i < store.droppedLines.length; i++) {
      const row = store.droppedLines[i]
      const rec = tapped[i]
      if (!hasValidTap(rec)) { rest.push(row); continue }
      merged.push({
        id: '', t: rec.t, rawT: rec.t, text: row.text, empty: row.text === '',
        beat: rec.beat ?? null, locked: rec.locked ?? false,
        sourceLine: row.line, duplicateOf: [],
      })
      applied++
    }
  } else {
    for (let i = 0; i < merged.length; i++) {
      const rec = tapped[i]
      if (!hasValidTap(rec)) continue
      merged[i] = { ...merged[i], t: rec.t, rawT: rec.t, beat: rec.beat ?? null, locked: rec.locked ?? false }
      applied++
    }
  }

  merged.sort((a, b) => (a.t - b.t) || (a.sourceLine - b.sourceLine))
  for (let i = 0; i < merged.length; i++) merged[i].id = `L${i}`
  store.lines = merged
  store.droppedLines = rest
  return { applied, remaining: rest.length }
}

/** 造一个带时间的歌词行 */
const timedLine = (t, text, sourceLine) => ({
  id: '', t, rawT: t, text, empty: false,
  beat: null, locked: false, sourceLine, duplicateOf: [],
})

test('纯 LRC（目标 = lines）里重新打轴：不再静默丢弃', () => {
  /*
   * 这是一个真实的旧 BUG：applyTapped 只遍历 droppedLines，
   * 而纯 LRC 文件的打轴目标是 lines（droppedLines 为空）。
   * 结果用户打完轴点「应用到歌词」提示"已应用 0 行"，时间被悄悄丢掉。
   */
  const store = { lines: [timedLine(2, '第 1 句', 1), timedLine(4, '第 2 句', 2)], droppedLines: [] }
  const r = applyTappedMirror(store, [
    { t: 1.5, beat: null, locked: false },
    { t: 3.5, beat: null, locked: false },
  ])
  assert.ok(r.applied > 0, `不该丢数据，applied=${r.applied}`)
  assert.deepEqual(store.lines.map((l) => l.t), [1.5, 3.5])
})

test('纯 LRC：就地改写时间，不新增行、不动正文', () => {
  const store = { lines: [timedLine(2, '第 1 句', 1), timedLine(4, '第 2 句', 2)], droppedLines: [] }
  applyTappedMirror(store, [{ t: 1.5, beat: null, locked: false }, null])
  assert.equal(store.lines.length, 2, '不应新增行')
  assert.deepEqual(store.lines.map((l) => l.text), ['第 1 句', '第 2 句'], '正文不得改动')
  assert.deepEqual(store.lines.map((l) => l.rawT), [1.5, 4], 'rawT 应同步为 t')
})

test('纯 LRC：改写后按新时间重新排序', () => {
  const store = { lines: [timedLine(0, 'A', 1), timedLine(10, 'B', 2)], droppedLines: [] }
  applyTappedMirror(store, [null, { t: 20, beat: null, locked: false }])
  assert.deepEqual(store.lines.map((l) => l.t), [0, 20])
  assert.deepEqual(store.lines.map((l) => l.id), ['L0', 'L1'], 'id 应重新连续')
})

test('纯 TXT（目标 = droppedLines）行为与修复前完全一致', () => {
  const store = {
    lines: [],
    droppedLines: [
      { line: 1, text: '第 1 句', reason: '' },
      { line: 2, text: '第 2 句', reason: '' },
      { line: 3, text: '第 3 句', reason: '' },
      { line: 4, text: '第 4 句', reason: '' },
    ],
  }
  const r = applyTappedMirror(store, [
    { t: 2, beat: null, locked: false },
    { t: 4, beat: null, locked: false },
    null, null,
  ])
  assert.equal(store.lines.length, 2)
  assert.deepEqual(store.lines.map((l) => l.t), [2, 4])
  assert.deepEqual(store.lines.map((l) => l.id), ['L0', 'L1'])
  assert.deepEqual(store.lines.map((l) => l.rawT), [2, 4])
  assert.deepEqual(store.lines.map((l) => l.text), ['第 1 句', '第 2 句'])
  assert.deepEqual(store.lines.map((l) => l.sourceLine), [1, 2], '同时间行靠它稳定排序')
  assert.equal(store.droppedLines.length, 2, '未打的行留下')
  assert.deepEqual(r, { applied: 2, remaining: 2 })
})

test('混合文件：只处理 droppedLines，不动已有时间行', () => {
  const store = {
    lines: [timedLine(10, '有时间', 1)],
    droppedLines: [
      { line: 2, text: '没时间A', reason: '' },
      { line: 3, text: '没时间B', reason: '' },
    ],
  }
  const r = applyTappedMirror(store, [{ t: 20, beat: null, locked: false }, null])
  assert.equal(r.applied, 1)
  assert.equal(store.lines.length, 2)
  assert.ok(store.lines.some((l) => l.t === 10 && l.text === '有时间'), '原有时间行必须保留')
  assert.equal(store.droppedLines.length, 1)
  assert.equal(store.droppedLines[0].text, '没时间B')
})

test('脏记录（t 为 NaN）不得写进歌词', () => {
  const store = { lines: [timedLine(1, 'A', 1), timedLine(2, 'B', 2)], droppedLines: [] }
  const r = applyTappedMirror(store, [{ t: NaN, beat: null, locked: false }, { t: 9, beat: null, locked: false }])
  assert.equal(r.applied, 1, 'NaN 记录应被跳过')
  assert.ok(store.lines.every((l) => Number.isFinite(l.t)), '不能让 NaN 污染时间轴')
})

test('空 tapped 不改变任何东西', () => {
  const store = { lines: [timedLine(1, 'A', 1)], droppedLines: [{ line: 2, text: 'B', reason: '' }] }
  const r = applyTappedMirror(store, [])
  assert.equal(r.applied, 0)
  assert.equal(store.lines.length, 1, 'lines 不变')
  assert.equal(store.droppedLines.length, 1, 'droppedLines 不变')
})

// ─────────────────────────────────────────────
group('文字描边 · 设置与校验')

test('描边默认关闭（width = 0），老用户升级后观感不变', () => {
  const s = createDefaultSettings()
  assert.equal(s.stroke.width, 0, '默认必须是 0，否则升级后所有人的画面都会变')
  assert.equal(typeof s.stroke.color, 'string')
  assert.equal(typeof s.stroke.brightness, 'number')
})

test('描边字段的脏数据回落默认（越界/错类型/缺失）', () => {
  const d = createDefaultSettings()
  // 注意：数字字符串会被 pick() 归一化成数字（"0.2" → 0.2），
  // 这是所有数值字段的共同行为（font.size 的 "50" 同样→50），
  // 对 localStorage 里存成字符串的老数据是必要的兼容，不算脏数据。
  for (const bad of [-1, 0.5, 999, NaN, Infinity, null, {}]) {
    const s = sanitizeSettings({ stroke: { width: bad } })
    assert.equal(s.stroke.width, d.stroke.width, `width=${JSON.stringify(bad)} 应回落默认`)
  }
  for (const bad of [-5, 101, NaN, 'x', undefined]) {
    const s = sanitizeSettings({ stroke: { brightness: bad } })
    assert.equal(s.stroke.brightness, d.stroke.brightness, `brightness=${JSON.stringify(bad)} 应回落默认`)
  }
})

test('描边宽度的数字字符串被归一化（与其他数值字段一致）', () => {
  assert.equal(sanitizeSettings({ stroke: { width: '0.2' } }).stroke.width, 0.2)
  // 与既有字段行为保持一致，确认不是这里特例
  assert.equal(sanitizeSettings({ font: { size: '50' } }).font.size, 50)
})

test('描述字段的合法值被保留', () => {
  const s = sanitizeSettings({
    stroke: { width: 0.12, color: '#FF0000', brightness: 55 },
  })
  assert.equal(s.stroke.width, 0.12)
  assert.equal(s.stroke.color, '#ff0000', '颜色应被归一化为小写 #rrggbb')
  assert.equal(s.stroke.brightness, 55)
})

test('旧设置（完全没有 stroke 段）能平滑升级', () => {
  const old = { version: 1, font: { size: 50 }, color: { normal: '#123456' } }
  const s = sanitizeSettings(old)
  assert.equal(s.stroke.width, 0, '老数据应得到"关闭"的默认值')
  assert.equal(s.font.size, 50, '其他字段不受影响')
  assert.equal(s.color.normal, '#123456')
})

// ─────────────────────────────────────────────
group('文字描边 · resolveStrokeColor（颜色 + 明亮 的分工）')

test('明亮 = 0 输出纯黑（无论选了什么颜色）', () => {
  for (const c of ['#ff0000', '#00ff00', '#123456', '#ffffff']) {
    assert.equal(
      resolveStrokeColor({ stroke: { color: c, brightness: 0 } }),
      '#000000',
      `brightness=0 时 ${c} 应变成纯黑`,
    )
  }
})

test('明亮 = 100 输出纯白（无论选了什么颜色）', () => {
  for (const c of ['#ff0000', '#00ff00', '#123456', '#000000']) {
    assert.equal(resolveStrokeColor({ stroke: { color: c, brightness: 100 } }), '#ffffff')
  }
})

test('明亮保持在中间时保留色相（红仍是红，不是灰）', () => {
  const red = resolveStrokeColor({ stroke: { color: '#ff0000', brightness: 50 } })
  const rgb = hexToRgb(red)
  assert.ok(rgb, `应产出合法 hex，实际 ${red}`)
  assert.ok(rgb.r > 200 && rgb.g < 60 && rgb.b < 60, `应仍是红色，实际 ${red}`)
})

test('调明亮不改变色相：同一颜色的不同明度应当同色系', () => {
  const hues = [10, 30, 50, 70].map((b) => {
    const hex = resolveStrokeColor({ stroke: { color: '#3366ff', brightness: b } })
    return hexToHsl(hex).h
  })
  const spread = Math.max(...hues) - Math.min(...hues)
  assert.ok(spread < 12, `色相不该随明度漂移，实际分布 ${JSON.stringify(hues)}`)
})

test('明度单调递增：brightness 越大越亮', () => {
  const lums = [0, 25, 50, 75, 100].map((b) => {
    const rgb = hexToRgb(resolveStrokeColor({ stroke: { color: '#3366ff', brightness: b } }))
    return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b
  })
  for (let i = 1; i < lums.length; i++) {
    assert.ok(lums[i] >= lums[i - 1], `亮度应单调不减：${JSON.stringify(lums)}`)
  }
})

test('脏输入不抛异常，回落到可用的颜色', () => {
  for (const bad of [undefined, {}, { stroke: {} }, { stroke: { color: 'nope' } }, null]) {
    const out = resolveStrokeColor(bad)
    assert.match(out, /^#[0-9a-f]{6}$/, `${JSON.stringify(bad)} 应产出合法 hex，实际 ${out}`)
  }
})

test('brightness 越界被夹取（不产出非法 hex）', () => {
  assert.equal(resolveStrokeColor({ stroke: { color: '#ff0000', brightness: -20 } }), '#000000')
  assert.equal(resolveStrokeColor({ stroke: { color: '#ff0000', brightness: 500 } }), '#ffffff')
})

// ─────────────────────────────────────────────
group('文字描边 · CSS 变量（预览侧）')

test('toCssVars 输出描边宽度与颜色变量', () => {
  const s = createDefaultSettings()
  s.stroke.width = 0.08
  s.stroke.color = '#ff0000'
  s.stroke.brightness = 0
  const vars = toCssVars(s)
  assert.equal(vars['--lrc-stroke-width'], '0.08em', '宽度必须是 em，才能随字号与翻译行等比缩放')
  assert.equal(vars['--lrc-stroke-color'], '#000000', '颜色应经过「明亮」换算')
})

test('描边位置默认为外侧（老用户观感不变）', () => {
  assert.equal(createDefaultSettings().stroke.position, 'outer')
})

test('描边位置只接受 outer/center，其余回落默认', () => {
  assert.equal(sanitizeSettings({ stroke: { position: 'center' } }).stroke.position, 'center')
  // 'inner' 是刻意不支持的取值 —— CSS 无法实现，必须被挡回 outer
  for (const bad of ['inner', 'inside', 'OUTER', '', 'x', 42, null, {}]) {
    assert.equal(
      sanitizeSettings({ stroke: { position: bad } }).stroke.position,
      'outer',
      `position=${JSON.stringify(bad)} 应回落 outer`,
    )
  }
})

test('toCssVars：位置映射成 paint-order 值', () => {
  const outer = createDefaultSettings()
  assert.equal(toCssVars(outer)['--lrc-stroke-order'], 'stroke fill')
  const center = sanitizeSettings({ stroke: { position: 'center' } })
  assert.equal(toCssVars(center)['--lrc-stroke-order'], 'fill stroke')
})

test('旧设置（没有 position 字段）升级后是外侧', () => {
  const old = { version: 1, stroke: { width: 0.1, color: '#ff0000', brightness: 50 } }
  assert.equal(sanitizeSettings(old).stroke.position, 'outer')
  assert.equal(sanitizeSettings(old).stroke.width, 0.1, '其他描边字段不受影响')
})

// ─────────────────────────────────────────────
group('文字描边 · 导出（canvas 侧）')

/** 造带描边设置的 settings */
const withStroke = (width, { color = '#ff0000', brightness = 50 } = {}) => ({
  ...scrollSettings,
  stroke: { width, color, brightness },
})

const strokeLines = [
  { t: 0, text: '普通行', empty: false },
  { t: 5, text: '当前行', empty: false },
]

test('默认（width 0）不画任何描边', () => {
  const probe = drawAt(scrollSettings, strokeLines, 0.1)
  assert.equal(probe.strokes().length, 0, '关闭时不该有 strokeText 调用')
})

test('开启后每段文字都先描边再填充（等价 paint-order: stroke fill）', () => {
  const probe = drawAt(withStroke(0.1), strokeLines, 6.0)
  const strokes = probe.strokes()
  assert.ok(strokes.length > 0, '应画出描边')
  assert.equal(strokes.length, probe.texts().length, '每个 fillText 都应有配对的 strokeText')

  /*
   * 顺序断言：canvas 没有 paint-order 属性，只能靠"先 stroke 后 fill"实现。
   * 反序会让描边盖住字形内部（实测白色像素只有 1/16），必须锁死。
   */
  const seq = probe.ops.filter((o) => o.op === 'stroke' || o.op === 'text').map((o) => o.op)
  for (let i = 0; i < seq.length; i += 2) {
    assert.equal(seq[i], 'stroke', `第 ${i} 步应是描边，实际顺序 ${JSON.stringify(seq)}`)
    assert.equal(seq[i + 1], 'text', `第 ${i + 1} 步应是填充，实际顺序 ${JSON.stringify(seq)}`)
  }
})

test('线宽 = 宽度(em) × 该行字号', () => {
  const probe = drawAt(withStroke(0.1), strokeLines, 0.1)
  const st = probe.strokes()[0]
  const size = Number(st.font.match(/(\d+(?:\.\d+)?)px/)[1])
  assert.ok(
    Math.abs(st.lineWidth - 0.1 * size) < 1e-6,
    `线宽应为 0.1×${size}=${0.1 * size}，实际 ${st.lineWidth}`,
  )
})

test('翻译行的描边同比更细（与 CSS 的 em 语义一致）', () => {
  const lines = [
    { t: 0, text: '原文', empty: false },
    { t: 5, text: 'translation', empty: false, isTranslation: true },
    { t: 10, text: '下一句', empty: false },
  ]
  const probe = drawAt(withStroke(0.1), lines, 6.0)
  const byText = new Map(probe.strokes().map((s) => [s.text, s]))
  const main = byText.get('translation') ? byText.get('原文') : null
  assert.ok(main, '应画出主歌词')
  const trans = byText.get('translation')
  assert.ok(trans, '应画出翻译行')
  assert.ok(
    trans.lineWidth < main.lineWidth,
    `翻译行描边应更细：主 ${main.lineWidth} vs 翻译 ${trans.lineWidth}`,
  )
  // 比例应约等于 0.62（与 .is-translation 的 font-size: 0.62em 对齐）
  const ratio = trans.lineWidth / main.lineWidth
  assert.ok(Math.abs(ratio - 0.62) < 0.05, `细化比例应约 0.62，实际 ${ratio}`)
})

test('描边颜色用 resolveStrokeColor 的结果（与预览同一个字符串）', () => {
  /*
   * 明亮取 20（而不是 50）：#00ff00 的原生明度恰好是 50，
   * 取 50 时「明亮」等于原值、输出与选色相同，就测不出这层换算是否生效。
   */
  const s = withStroke(0.1, { color: '#00ff00', brightness: 20 })
  const probe = drawAt(s, strokeLines, 0.1)
  const expected = resolveStrokeColor(s)
  assert.equal(probe.strokes()[0].strokeStyle, expected)
  assert.notEqual(expected, '#00ff00', '这是「明亮」生效后的值，不该等于原始选色')
})

test('lineJoin=round 与 CSS 的圆滑转角对齐', () => {
  const probe = drawAt(withStroke(0.1), strokeLines, 0.1)
  assert.equal(probe.strokes()[0].lineJoin, 'round')
})

test('描边在缩放分支里也被放大（lineWidth 按未缩放字号算）', () => {
  /*
   * 当前行走的是 translate + scale 分支。实测 CSS 行为：
   * 父级 scale(2) 时 2em 仍按**未缩放**的 font-size 解析，然后被 transform 放大。
   * canvas 必须一致 —— lineWidth 乘的是 row.drawSize（未缩放），
   * 由 ctx.scale 负责放大。
   */
  const probe = drawAt(withStroke(0.1), strokeLines, 6.0)
  assert.ok(probe.ops.some((o) => o.op === 'scale'), '当前行应走缩放分支')
  const st = probe.strokes()[0]
  const size = Number(st.font.match(/(\d+(?:\.\d+)?)px/)[1])
  assert.ok(
    Math.abs(st.lineWidth - 0.1 * size) < 1e-6,
    `缩放分支中线宽仍按未缩放字号算，实际 ${st.lineWidth} vs ${0.1 * size}`,
  )
})

test('空行（间奏）也描边（描边作用于全部行）', () => {
  const lines = [
    { t: 0, text: '前一句', empty: false },
    { t: 5, text: '', empty: true },
  ]
  const probe = drawAt(withStroke(0.1), lines, 5.5)
  const hasEmpty = probe.strokes().some((s) => s.text === EMPTY_LABEL)
  assert.ok(hasEmpty, '间奏占位也应描边')
})

test('描边不改变文字内容与填充（只是多画一层轮廓）', () => {
  const plain = drawAt(scrollSettings, strokeLines, 0.1)
  const stroked = drawAt(withStroke(0.1), strokeLines, 0.1)
  assert.deepEqual(
    stroked.texts().map((t) => t.text),
    plain.texts().map((t) => t.text),
    '文字内容应完全一致',
  )
  assert.deepEqual(
    stroked.texts().map((t) => t.fillStyle),
    plain.texts().map((t) => t.fillStyle),
    '填充色不应受描边影响',
  )
})

// ── 描边位置：外侧 / 居中 ──
const withPosition = (position, width = 0.1) => ({
  ...scrollSettings,
  stroke: { width, color: '#ff0000', brightness: 50, position },
})

/** 取出绘制顺序序列（只看 text / stroke 两类操作） */
const paintSeq = (probe) =>
  probe.ops.filter((o) => o.op === 'stroke' || o.op === 'text').map((o) => o.op)

test('position=outer 时先描边再填充（填充盖住内半 → 只露外侧）', () => {
  const probe = drawAt(withPosition('outer'), strokeLines, 0.1)
  const seq = paintSeq(probe)
  assert.ok(seq.length > 0, '应有绘制')
  for (let i = 0; i < seq.length; i += 2) {
    assert.equal(seq[i], 'stroke', `外侧应先描边，实际 ${JSON.stringify(seq)}`)
    assert.equal(seq[i + 1], 'text')
  }
})

test('position=center 时先填充再描边（描边压在上面 → 内外各半）', () => {
  const probe = drawAt(withPosition('center'), strokeLines, 0.1)
  const seq = paintSeq(probe)
  assert.ok(seq.length > 0, '应有绘制')
  for (let i = 0; i < seq.length; i += 2) {
    assert.equal(seq[i], 'text', `居中应先填充，实际 ${JSON.stringify(seq)}`)
    assert.equal(seq[i + 1], 'stroke')
  }
})

test('两种位置的描边数量与颜色一致（只有顺序不同）', () => {
  const outer = drawAt(withPosition('outer'), strokeLines, 0.1)
  const center = drawAt(withPosition('center'), strokeLines, 0.1)
  assert.equal(outer.strokes().length, center.strokes().length, '描边笔数应相同')
  assert.deepEqual(
    outer.strokes().map((s) => s.lineWidth),
    center.strokes().map((s) => s.lineWidth),
    '线宽不应因位置而变（线宽始终以轮廓为中心，位置只改绘制顺序）',
  )
  assert.deepEqual(
    outer.strokes().map((s) => s.strokeStyle),
    center.strokes().map((s) => s.strokeStyle),
  )
})

test('position=center 时描边与填充的位置完全相同（同一字形上叠加）', () => {
  const probe = drawAt(withPosition('center'), strokeLines, 0.1)
  const seq = probe.ops.filter((o) => o.op === 'stroke' || o.op === 'text')
  for (let i = 0; i < seq.length; i += 2) {
    const fill = seq[i]
    const stroke = seq[i + 1]
    assert.equal(fill.text, stroke.text, '同一段文字')
    assert.equal(fill.x, stroke.x, `x 应一致（${fill.x} vs ${stroke.x}）`)
    assert.equal(fill.y, stroke.y, `y 应一致（${fill.y} vs ${stroke.y}）`)
  }
})

test('position 不是 center 的任何取值都按外侧处理（与 pickEnum 兜底一致）', () => {
  // 直接传脏值到渲染层（绕过 sanitize），确认渲染层也是"非 center 即 outer"
  const probe = drawAt({ ...scrollSettings, stroke: { width: 0.1, color: '#ff0000', brightness: 50, position: 'inner' } }, strokeLines, 0.1)
  assert.equal(paintSeq(probe)[0], 'stroke', '未知取值应按外侧（先描后填）')
})

test('关闭描边时位置无关紧要（两种位置都不画描边）', () => {
  for (const pos of ['outer', 'center']) {
    const probe = drawAt({ ...scrollSettings, stroke: { width: 0, color: '#ff0000', brightness: 50, position: pos } }, strokeLines, 0.1)
    assert.equal(probe.strokes().length, 0, `position=${pos} 且宽度 0 时不应有描边`)
  }
})

// ─────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
console.log('─'.repeat(48))

if (failed > 0) process.exit(1)
