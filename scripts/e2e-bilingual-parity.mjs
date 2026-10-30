// @ts-check
/**
 * 双语字幕 · 导出=预览 一致性验收（真实浏览器 / CDP）。
 *
 * 断言："预览里被 .is-active 高亮的行数" 必须等于 "导出画面里被上色的行数"。
 * 修复前：双语组只高亮一行（翻译行），原文不放大 —— 正是用户报的 bug。
 *
 * 用法：node scripts/e2e-bilingual-parity.mjs <页面URL> [调试端口]
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 20000)
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      throw new Error(
        `页面求值异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`,
      )
    }
    return r.result?.value
  }

  close() {
    this.ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 双语（原文在上、翻译在下），第三组作为当前行 */
const LRC = `[ti:双语一致性验收]
[00:00.00]无人知晓
[00:00.00]Where all the years go
[00:03.00]时间都去哪儿了
[00:03.00]Our stories unfold
[00:06.00]我们的故事如何发展
[00:06.00]What a time, a time, a time
[00:09.00]活着
[00:09.00]To be alive
`

async function main() {
  const target = await waitForTarget()
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(1000)
  await cdp.eval(`(() => { try { localStorage.clear(); localStorage.setItem('lrc-scroller:tutorial-seen:v1','1'); } catch (e) {} return true })()`)
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2500)

  console.log(`\n双语字幕 · 导出=预览 一致性验收 —— ${PAGE_URL}\n`)

  // ── 载入双语歌词并停在第三组 ──
  const loaded = await cdp.eval(`(async () => {
    const d = window.__lrcDiag;
    if (!d) return { error: 'no diag hooks' };
    d.lyrics.loadFromText(${JSON.stringify(LRC)}, { fileName: 'bilingual-test.lrc' });
    await new Promise((r) => setTimeout(r, 120));
    d.engine.seek(6.2);
    await new Promise((r) => setTimeout(r, 260));
    return { count: d.lyrics.lines.length };
  })()`)
  check('双语歌词已载入', loaded?.count === 8, JSON.stringify(loaded))

  // ── 预览侧：哪些行带 .is-active，颜色与缩放各是多少 ──
  const preview = await cdp.eval(`(() => {
    const root = document.querySelector('.app-shell');
    const scaleVar = getComputedStyle(root).getPropertyValue('--lrc-active-scale').trim();
    return [...document.querySelectorAll('.lyric-line')].map((el) => {
      const text = el.querySelector('.lyric-line__text');
      const cs = getComputedStyle(el);
      const tcs = getComputedStyle(text);
      const m = (cs.transform || '').match(/matrix\\(([^,]+),/);
      return {
        text: text.textContent,
        active: el.classList.contains('is-active'),
        translation: el.classList.contains('is-translation'),
        color: cs.color,
        textSize: parseFloat(tcs.fontSize),
        scale: m ? Number(m[1]) : 1,
      };
    });
  })()`)

  const previewActive = (preview ?? []).filter((l) => l.active)
  check(
    '预览：双语组两行同时 .is-active',
    previewActive.length === 2,
    `实际 ${previewActive.length} 行：${JSON.stringify(previewActive.map((l) => l.text))}`,
  )
  check(
    '预览：原文与翻译同一颜色（两行一起变色）',
    previewActive.length === 2 && previewActive[0].color === previewActive[1].color,
    JSON.stringify(previewActive.map((l) => `${l.text}:${l.color}`)),
  )
  const previewPrimary = previewActive.find((l) => !l.translation)
  const previewTrans = previewActive.find((l) => l.translation)
  check(
    '预览：原文渲染字号更大（翻译行 0.62em）',
    previewPrimary && previewTrans && previewPrimary.textSize > previewTrans.textSize,
    `原文 ${previewPrimary?.textSize} / 翻译 ${previewTrans?.textSize}`,
  )

  // ── 导出侧：渲染一帧，抓 canvas 实际用到的颜色与缩放 ──
  //
  // 直接拦截 fillText 而不是事后数像素：颜色要区分"当前色 / 普通色"，
  // 数像素只能靠亮度猜；拦截能拿到精确的 fillStyle 与当时的 transform。
  const exported = await cdp.eval(`(async () => {
    const { useVideoExportShared } = await import('/src/composables/useVideoExport.js');
    const exporter = useVideoExportShared();
    const canvas = document.createElement('canvas');
    const size = { width: 1280, height: 720 };
    exporter.ensureCanvasSize(canvas, size);

    const proto = CanvasRenderingContext2D.prototype;
    const origFill = proto.fillText;
    const drawn = [];
    proto.fillText = function (text, x, y) {
      const m = this.getTransform();
      drawn.push({ text: String(text), fillStyle: String(this.fillStyle), scale: Math.hypot(m.a, m.b) });
      return origFill.apply(this, arguments);
    };
    let ok = false;
    try {
      ok = exporter.renderPreview(canvas, 6.2, size);
    } finally {
      proto.fillText = origFill;
    }
    return { ok, drawn };
  })()`)

  if (!exported?.ok) {
    check('导出帧渲染成功', false, JSON.stringify(exported))
  } else {
    const drawn = exported.drawn
    // 同一段文字可能因逐字进度被重画两次，按 text 去重
    const byText = new Map()
    for (const d of drawn) if (!byText.has(d.text)) byText.set(d.text, d)

    const main = byText.get('我们的故事如何发展')
    const trans = byText.get('What a time, a time, a time')
    check('导出：当前组的原文与翻译都被绘制', !!main && !!trans, JSON.stringify([...byText.keys()]))

    // 预览读到的是 "rgb(255, 255, 255)"，canvas 里是 "#ffffff"，统一成三元组再比
    const rgbOf = (s) => {
      if (!s) return null
      const hex = /^#([0-9a-f]{6})$/i.exec(s.trim())
      if (hex) {
        const n = parseInt(hex[1], 16)
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      }
      const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s)
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
    }
    const activeRgb = rgbOf(previewActive[0]?.color)
    const isActiveColor = (s) => {
      const c = rgbOf(s)
      return !!c && !!activeRgb && c.every((v, i) => Math.abs(v - activeRgb[i]) <= 2)
    }
    check(
      '导出：翻译行用当前色（与预览一起变色）',
      !!trans && isActiveColor(trans.fillStyle),
      `翻译行颜色 ${trans?.fillStyle}`,
    )
    check(
      '导出：原文用当前色（不再"只有翻译行变色"）',
      !!main && isActiveColor(main.fillStyle),
      `原文颜色 ${main?.fillStyle}`,
    )
    check(
      '导出：原文被放大到 active scale（1.35）',
      !!main && Math.abs(main.scale - 1.35) < 0.02,
      `原文 scale=${main?.scale}`,
    )
    check(
      '导出：翻译行同样随组放大（与预览 CSS 一致）',
      !!trans && Math.abs(trans.scale - 1.35) < 0.02,
      `翻译 scale=${trans?.scale}`,
    )
    const prev = byText.get('Our stories unfold')
    check(
      '导出：上一组已回落（不再放大）',
      !prev || Math.abs(prev.scale - 1) < 0.02,
      `上一组 scale=${prev?.scale}`,
    )
    console.log(
      '  实拍绘制：',
      [...byText.values()].map((d) => `${d.text}@${d.scale.toFixed(2)} ${d.fillStyle}`).join(' | '),
    )
  }

  check('全程无页面异常', cdp.errors.length === 0, cdp.errors.join(' | '))

  console.log(`\n────────────────────────────────────────────────`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  console.log(`────────────────────────────────────────────────\n`)

  cdp.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
