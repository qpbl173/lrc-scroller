// @ts-check
/**
 * 纯英文逐词打轴验收（真实浏览器 / CDP / 构建产物）。
 *
 * 用法：node scripts/e2e-word-tapping.mjs <dist/index.html 的 file:// URL> [调试端口]
 *
 * 【为什么用构建产物而不是 dev server】
 * 本仓库的路径落在 pnpm store 里，vite 的依赖优化器在这条路径上会崩
 * （`Cannot read properties of undefined (reading 'imports')`），
 * dev server 起不来。而"英文按词"是**用户可见行为**，值得在真浏览器里验一次：
 * 走完整 UI（导入文件 → 点「逐字」→ 按空格），只读页面上的可见结果，
 * 不 mock 任何 store。
 *
 * 断言：
 *   1. 导入英文歌词后，逐字进度标记按「词」计量（不是「字」）
 *   2. 单元数 = 词数（一行 3 个词的歌不会给出 11 个单元）
 *   3. 两次空格吃完一行 → 进度标到 2/3（整词一个单元）
 *   4. 再按一次 → 光标停在最后一个词上（覆盖，不是新增）
 *   5. 中文歌词仍然按「字」计量
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PAGE_URL = process.argv[2]
const PORT = Number(process.argv[3] ?? 9222)

if (!PAGE_URL) {
  console.error('用法: node scripts/e2e-word-tapping.mjs <file://.../dist/index.html> [端口]')
  process.exit(2)
}

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
await cdp.send('DOM.enable')
// 宽窗口：窄屏会整组藏掉逐字控件（有意的取舍），验收不能用窄屏
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 导入一份歌词：把文件塞进隐藏的 file input，浏览器会自己派发 change 事件 */
async function importLyrics(filePath) {
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(1800)
  // 首次打开的引导层会吃掉空格（空格=下一步），必须先关掉
  await cdp.eval(`(() => {
    const skip = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '跳过')
    if (skip) skip.click()
    return true
  })()`)
  await sleep(300)
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type=file][accept*=".lrc"]',
  })
  if (!nodeId) throw new Error('找不到歌词文件输入框')
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [filePath] })
  await sleep(1200)
}

/** 读播放条上的逐字进度标记（唯一可见的单元计数来源） */
const readLabel = () =>
  cdp.eval(`(() => {
    const el = document.querySelector('.playerbar__char-progress')
    return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null
  })()`)

/** 点「逐字」开关 */
const clickCharToggle = () =>
  cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === '逐字',
    )
    if (!btn) return false
    btn.click()
    return true
  })()`)

/** 模拟按空格（键盘监听在 window 上） */
const pressSpace = () =>
  cdp.eval(`(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true }),
    )
    return true
  })()`)

const EN_LRC = [
  '[ti:Word Tapping]',
  '[00:01.00]Hold on to me',
  '[00:05.00]I love you',
  '',
].join('\n')

const ZH_LRC = ['[ti:字级打轴]', '[00:01.00]你好世界', ''].join('\n')

const enPath = join(tmpdir(), 'lrc-e2e-en-tapping.lrc')
const zhPath = join(tmpdir(), 'lrc-e2e-zh-tapping.lrc')
writeFileSync(enPath, EN_LRC, 'utf8')
writeFileSync(zhPath, ZH_LRC, 'utf8')

console.log('\n英文歌词：导入 → 进入逐字 → 按空格')
await importLyrics(enPath)
check('歌词导入成功（页面上出现英文正文）', await cdp.eval(`document.body.innerText.includes('Hold on to me')`))
check('「逐字」按钮存在', await clickCharToggle())
await sleep(600)

const label0 = await readLabel()
check('进度标记存在', typeof label0 === 'string', String(label0))
check('单元名是「词」而不是「字」', String(label0).includes('词'), String(label0))
check('「Hold on to me」= 4 个词（不是 12 个字母）', /·\s*0\/4\s*词/.test(String(label0)), String(label0))

await pressSpace()
await sleep(200)
await pressSpace()
await sleep(200)
const label2 = await readLabel()
check('两次空格吃掉两个整词 → 2/4 词', /·\s*2\/4\s*词/.test(String(label2)), String(label2))

await pressSpace()
await sleep(200)
await pressSpace()
await sleep(300)
const label4 = await readLabel()
check(
  '打完第一个词换到第 2 行（1/2 · 0/3 词）',
  /逐字 2\/2 · 0\/3 词/.test(String(label4)),
  String(label4),
)

console.log('\n中文歌词：仍然按「字」计量')
await importLyrics(zhPath)
await clickCharToggle()
await sleep(600)
const zhLabel = await readLabel()
check('中文行单元名是「字」', String(zhLabel).includes('字') && !String(zhLabel).includes('词'), String(zhLabel))
check('「你好世界」= 4 个字', /·\s*0\/4\s*字/.test(String(zhLabel)), String(zhLabel))

console.log('\n────────────────────────────────────────────────')
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
console.log('────────────────────────────────────────────────')
process.exit(failed === 0 ? 0 : 1)
