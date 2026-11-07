// @ts-check
/**
 * 双语打轴验收（真实浏览器 / CDP）：翻译行不单独打轴，只跟随主行。
 *
 * 用法：node scripts/e2e-bilingual-tapping.mjs <页面URL> [调试端口]
 *
 * 断言（全部在真实 Pinia store 里跑，不 mock）：
 *   1. 可打行数 = 主行数（3），不是物理行数（6）
 *   2. 打一次 → 原文与翻译同时拿到同一个时间；光标越过翻译行
 *   3. 撤销 → 两条一起回滚
 *   4. 应用 → 翻译行时间与主行一致（不会被拆开）
 */

const PAGE_URL = process.argv[2] ?? 'http://localhost:5173/'
const PORT = Number(process.argv[3] ?? 9222)

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
      lastErr = 'no page target yet'
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((res) => setTimeout(res, 400))
  }
  throw new Error(`CDP 端口 ${PORT} 未就绪: ${lastErr}`)
}

class CDP {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.ws = null
    this.errors = []
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(new Error(`WS 错误: ${e?.message ?? 'unknown'}`)))
      ws.addEventListener('message', (ev) => {
        let msg
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          this.errors.push(msg.params?.exceptionDetails?.text ?? 'exception')
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) rej(new Error(JSON.stringify(msg.error)))
          else res(msg.result)
        }
      })
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description ?? ''))
    }
    return r.result?.value
  }
}

const target = await waitForTarget()
const cdp = new CDP(target.webSocketDebuggerUrl)
await cdp.connect()
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Page.navigate', { url: PAGE_URL })
await new Promise((r) => setTimeout(r, 3500))

console.log('\n设置双语歌词并进入打轴…')
const setup = await cdp.eval(`(async () => {
  const { useLyricsStore } = await import('/src/stores/lyricsStore.js')
  const { useTappingStore } = await import('/src/stores/tappingStore.js')
  const lyrics = useLyricsStore()
  const tapping = useTappingStore()

  let seq = 0
  const mk = (t, text, tr) => ({
    id: 'T' + seq++, t, rawT: t, text, chars: null, empty: false,
    beat: null, locked: false, sourceLine: seq, duplicateOf: [],
    isTranslation: !!tr,
  })
  lyrics.lines = [
    mk(0, '第一句'), mk(0, 'first line', true),
    mk(3, '第二句'), mk(3, 'second line', true),
    mk(6, '第三句'), mk(6, 'third line', true),
  ]
  lyrics.droppedLines = []
  tapping.reset()
  tapping.enable()

  return {
    phys: lyrics.lines.length,
    total: tapping.totalCount,
    slots: tapping.tapSlotIndexes,
    ord: tapping.tapSlotOrdinal,
    editing: tapping.editingIndex,
  }
})()`)

check('可打行数 = 主行数（3），不是物理行数（6）', setup.total === 3, `total=${setup.total}`)
check('槽位是 [0,2,4]（跳过翻译行）', JSON.stringify(setup.slots) === '[0,2,4]', JSON.stringify(setup.slots))
check('初始光标在第 1 条主行', setup.editing === 0 && setup.ord === 1, `editing=${setup.editing} ord=${setup.ord}`)

const afterFirst = await cdp.eval(`(async () => {
  const { useTappingStore } = await import('/src/stores/tappingStore.js')
  const tapping = useTappingStore()
  tapping.record(1.23)
  return {
    tapped: tapping.tapped.map((x) => (x ? x.t : null)),
    editing: tapping.editingIndex,
    ord: tapping.tapSlotOrdinal,
    count: tapping.tappedCount,
  }
})()`)

check(
  '打一次：原文与翻译拿到同一个时间',
  Math.abs(afterFirst.tapped[0] - 1.23) < 1e-6 && Math.abs(afterFirst.tapped[1] - 1.23) < 1e-6,
  JSON.stringify(afterFirst.tapped),
)
check('光标越过翻译行，落到下一组原文（index 2）', afterFirst.editing === 2, `editing=${afterFirst.editing}`)
check('进度只算主行：1/3', afterFirst.count === 1 && afterFirst.ord === 2, `count=${afterFirst.count} ord=${afterFirst.ord}`)

const afterSecond = await cdp.eval(`(async () => {
  const { useTappingStore } = await import('/src/stores/tappingStore.js')
  const tapping = useTappingStore()
  tapping.record(4.5)
  return { tapped: tapping.tapped.map((x) => (x ? x.t : null)), editing: tapping.editingIndex }
})()`)

check(
  '第二次打轴：第二组同步，第四行也拿到时间',
  Math.abs(afterSecond.tapped[2] - 4.5) < 1e-6 && Math.abs(afterSecond.tapped[3] - 4.5) < 1e-6,
  JSON.stringify(afterSecond.tapped),
)

const afterUndo = await cdp.eval(`(async () => {
  const { useTappingStore } = await import('/src/stores/tappingStore.js')
  const tapping = useTappingStore()
  tapping.undo()
  return { tapped: tapping.tapped.map((x) => (x ? x.t : null)), editing: tapping.editingIndex }
})()`)

check(
  '撤销：主行与翻译一起回滚',
  afterUndo.tapped[2] === null && afterUndo.tapped[3] === null && Math.abs(afterUndo.tapped[0] - 1.23) < 1e-6,
  JSON.stringify(afterUndo.tapped),
)

const applied = await cdp.eval(`(async () => {
  const { useLyricsStore } = await import('/src/stores/lyricsStore.js')
  const { useTappingStore } = await import('/src/stores/tappingStore.js')
  const lyrics = useLyricsStore()
  const tapping = useTappingStore()
  lyrics.applyTapped(tapping.tapped)
  return lyrics.lines.map((l) => ({ t: l.t, text: l.text, tr: !!l.isTranslation }))
})()`)

const first = applied[0]
const firstTr = applied[1]
check(
  '应用后：原文与翻译时间仍然一致（没有被拆开）',
  first != null && firstTr != null && Math.abs(first.t - firstTr.t) < 1e-6 && firstTr.tr === true,
  JSON.stringify(applied.slice(0, 2)),
)

// ── 逐字打轴：打完主行后光标要跳过翻译行 ──
const charSkip = await cdp.eval(`(async () => {
  const { useLyricsStore } = await import('/src/stores/lyricsStore.js')
  const { useTappingStore } = await import('/src/stores/tappingStore.js')
  const lyrics = useLyricsStore()
  const tapping = useTappingStore()

  const mk = (id, t, text, tr) => ({
    id, t, rawT: t, text, chars: null, empty: false,
    beat: null, locked: false, sourceLine: 0, duplicateOf: [], isTranslation: !!tr,
  })
  lyrics.lines = [
    mk('M1', 0, 'abcd', false),
    mk('T1', 0, 'wxyz', true),
    mk('M2', 5, 'efgh', false),
  ]
  lyrics.droppedLines = []
  tapping.reset()
  tapping.charMode = true
  tapping.charEnsureCurrentLine()

  const start = tapping.charLineIndex
  // 主行 4 个字，全部打完 → 应直接跳到 index 2（跳过翻译行）
  for (let i = 0; i < 4; i++) tapping.charRecord(1 + i * 0.5)
  return { start, after: tapping.charLineIndex, chars: tapping.charDraft[0]?.length ?? 0 }
})()`)

check('逐字：从主行开始打', charSkip.start === 0, JSON.stringify(charSkip))
check('逐字：主行 4 个字打完', charSkip.chars === 4, JSON.stringify(charSkip))
check('逐字：打完主行直接跳到下一条主行（跳过翻译行）', charSkip.after === 2, JSON.stringify(charSkip))

// ── 预览侧：翻译行的进度百分比必须跟主行一致 ──
const preview = await cdp.eval(`(async () => {
  const { useLyricsStore } = await import('/src/stores/lyricsStore.js')
  const { usePlayerStore } = await import('/src/stores/playerStore.js')
  const lyrics = useLyricsStore()
  const player = usePlayerStore()

  const mk = (id, text, tr, chars) => ({
    id, t: 0, rawT: 0, text, chars, empty: false,
    beat: null, locked: false, sourceLine: 0, duplicateOf: [], isTranslation: !!tr,
  })
  lyrics.lines = [
    mk('M', 'abcd', false, [{ c: 'a', t: 0 }, { c: 'b', t: 1 }, { c: 'c', t: 2 }, { c: 'd', t: 3 }]),
    mk('T', 'wxyz', true, null),
  ]
  player.currentTime = 1.5
  await new Promise((r) => setTimeout(r, 250))

  return [...document.querySelectorAll('.lyric-line')].slice(0, 2).map((el) => ({
    tr: el.classList.contains('is-translation'),
    p: el.querySelector('.lyric-line__text')?.getAttribute('data-char-progress') ?? null,
  }))
})()`)

check(
  '预览：翻译行的进度百分比 = 主行的 0.3750',
  preview.length === 2 && preview[0].p === '0.3750' && preview[1].p === '0.3750',
  JSON.stringify(preview),
)
check('预览：第二条确实是翻译行', preview[1]?.tr === true, JSON.stringify(preview[1]))

const errors = cdp.errors.filter((e) => !/favicon/i.test(e))
check('页面无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log('\n────────────────────────────────')
if (failed) {
  console.log(`失败 ${failed} 项 / 通过 ${passed} 项`)
  process.exit(1)
}
console.log(`全部通过：${passed} 项`)
process.exit(0)
