/** Headless Chromium integration: pnpm dev --port 5178, then node scripts/e2e-alpha.mjs. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const pageUrl = process.argv[2] || 'http://127.0.0.1:5178/'
const browserPath = process.env.LRC_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync)
assert.ok(browserPath, 'Set LRC_BROWSER to a Chromium executable')
const outputDir = resolve('.tmp/e2e-alpha')
mkdirSync(outputDir, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'lrc-alpha-browser-'))
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let ws
const pending = new Map()
let nextId = 0
const errors = []
async function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 60_000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function until(expression) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out: ${expression}`)
}
async function saveCaptured(name, key = '__captured') {
  const base64 = await evaluate(`(async () => {
    const blob = window[${JSON.stringify(key)}];
    return await new Promise(r => { const reader = new FileReader(); reader.onload = () => r(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
  })()`)
  const path = join(outputDir, name)
  writeFileSync(path, Buffer.from(base64, 'base64'))
  return path
}

try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`Browser startup timed out: ${stderr.slice(-1000)}`)), 20_000)
    browser.once('error', (error) => { clearTimeout(timer); reject(error) })
    browser.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      const found = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (found) { clearTimeout(timer); resolve(found[1]) }
    })
  })
  const { host } = new URL(endpoint)
  const targets = await (await fetch(`http://${host}/json/list`)).json()
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args)
    const call = pending.get(message.id)
    if (call) {
      pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) call.reject(new Error(JSON.stringify(message.error)))
      else call.resolve(message.result)
    }
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 960, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('lrc-scroller:tutorial-seen:v1', '1')` })
  await send('Page.navigate', { url: pageUrl })
  await until('Boolean(window.__lrcDiag)')
  await evaluate(`(async () => {
    const d = window.__lrcDiag;
    d.lyrics.loadFromText('[00:00.00]透明歌词 Alpha\\n[00:00.10]下一句 Fade\\n[00:00.20]第三句');
    d.settings.setMany({'export.format':'mov-alpha','export.resolution':'480p','export.fps':24,'stroke.width':0.08,'fade.solidAbove':0,'fade.solidBelow':0,'fade.fadeRows':3,'motion.activeFadeMs':0});
    const { nextTick } = await import('/node_modules/.vite/deps/vue.js');
    await nextTick();
    d.player.setDuration(0.25);
    d.settings.openDrawer();
    await nextTick();
    document.querySelector('[data-tour="export-toggle"]').click();
    window.__exporter = (await import('/src/composables/useVideoExport.js')).useVideoExportShared();
    window.__canvas = document.querySelector('.export-panel__canvas');
    window.__savePicker = window.showSaveFilePicker;
    window.showSaveFilePicker = undefined;
    window.__createUrl = URL.createObjectURL;
    URL.createObjectURL = blob => { window.__captured = blob; return window.__createUrl(blob); };
    window.__anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__downloadName = this.download; };
  })()`)
  await until('Boolean(document.querySelector(".export-panel__canvas")) && !document.querySelector("[data-tour=export-video]").disabled')
  // Capture the panel after its v-if mount has completed.
  await evaluate(`window.__canvas = document.querySelector('.export-panel__canvas'); document.querySelector('.export-panel').scrollIntoView({block:'start'});`)
  assert.equal(await evaluate(`document.querySelector('.export-panel select').value`), 'mov-alpha')
  await evaluate(`window.__canvas.width=854; window.__canvas.height=480; window.__exporter.renderPreview(window.__canvas, 0.15);`)
  const alpha = await evaluate(`(() => {
    const data=window.__canvas.getContext('2d').getImageData(0,0,854,480).data;
    let clear=0, partial=0, opaque=0;
    for(let i=3;i<data.length;i+=4) { if(data[i]===0)clear++; else if(data[i]===255)opaque++; else partial++; }
    return {clear,partial,opaque,corner:data[3]};
  })()`)
  assert.ok(alpha.clear > 10000 && alpha.partial > 100 && alpha.opaque > 10, JSON.stringify(alpha))
  assert.equal(alpha.corner, 0)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outputDir, 'preview.png'), Buffer.from(shot.data, 'base64'))
  console.log('PASS: transparent canvas, antialiasing, fade, outline and UI format selector')

  // Use the real export button, including disabled state, progress and status text.
  await evaluate(`document.querySelector('[data-tour="export-video"]').click()`)
  await until(`Boolean(window.__captured) && document.querySelector('.export-panel').textContent.includes('已导出 6 帧')`)
  assert.ok((await evaluate('window.__downloadName')).endsWith('.mov'))
  const movPath = await saveCaptured('lyrics-alpha.mov')
  console.log('PASS: MOV Blob download through the export panel (6 frames)')

  // Streaming path uses the same FileSystemWritableFileStream methods as a real save picker.
  const streamed = await evaluate(`(async () => {
    let pos=0, bytes=new Uint8Array(0); window.__closed=false; window.__aborted=false;
    window.showSaveFilePicker = async () => ({createWritable:async()=>({
      async write(value){const data=value instanceof Blob?new Uint8Array(await value.arrayBuffer()):value; if(pos+data.length>bytes.length){const b=new Uint8Array(pos+data.length);b.set(bytes);bytes=b;} bytes.set(data,pos);pos+=data.length;},
      async seek(n){pos=n;}, async close(){window.__closed=true; window.__streamed=new Blob([bytes],{type:'video/quicktime'});}, async abort(){window.__aborted=true;}
    })});
    const r=await window.__exporter.exportVideo(window.__canvas);
    return {r,closed:window.__closed,aborted:window.__aborted};
  })()`)
  assert.ok(streamed.r.ok && streamed.closed && !streamed.aborted, JSON.stringify(streamed))
  await saveCaptured('lyrics-alpha-streamed.mov', '__streamed')
  console.log('PASS: streamed MOV writes, seeks and commits')

  const cancelled = await evaluate(`(async () => {
    window.__closed=false; window.__aborted=false;
    const ctrl=new AbortController();
    const r=await window.__exporter.exportVideo(window.__canvas,{signal:ctrl.signal,onProgress:()=>ctrl.abort()});
    return {r,closed:window.__closed,aborted:window.__aborted};
  })()`)
  assert.equal(cancelled.r.reason, 'aborted')
  assert.ok(cancelled.aborted && !cancelled.closed)
  const pickerCancelled = await evaluate(`(async () => {
    window.showSaveFilePicker=async()=>{throw new DOMException('cancel','AbortError')};
    return await window.__exporter.exportVideo(window.__canvas);
  })()`)
  assert.equal(pickerCancelled.reason, 'aborted')
  const writeFailure = await evaluate(`(async () => {
    window.__aborted=false;
    window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async()=>{throw new Error('disk full')},abort:async()=>{window.__aborted=true}})});
    try {await window.__exporter.exportVideo(window.__canvas);return false;}catch(e){return window.__aborted&&e.message==='disk full';}
  })()`)
  assert.equal(writeFailure, true)
  console.log('PASS: frame cancellation, save-picker cancellation and disk-write failure roll back')

  // No H.264 support must not disable transparent export, even after a slow MP4 probe resolves.
  const capability = await evaluate(`(async () => {
    const encoder=window.VideoEncoder;
    window.VideoEncoder=undefined;
    window.__lrcDiag.settings.set('export.format','mp4');
    await new Promise(r=>setTimeout(r,50));
    const mp4Disabled=document.querySelector('[data-tour="export-video"]').disabled;
    window.__lrcDiag.settings.set('export.format','mov-alpha');
    await new Promise(r=>setTimeout(r,50));
    const movEnabled=!document.querySelector('[data-tour="export-video"]').disabled;
    window.VideoEncoder=encoder;
    return {mp4Disabled,movEnabled};
  })()`)
  assert.deepEqual(capability, { mp4Disabled: true, movEnabled: true })
  console.log('PASS: transparent MOV works without WebCodecs')

  const mp4 = await evaluate(`(async () => {
    window.showSaveFilePicker=undefined; window.__captured=null;
    window.__lrcDiag.settings.set('export.format','mp4');
    await new Promise(r=>setTimeout(r,100));
    return await window.__exporter.exportVideo(window.__canvas);
  })()`)
  assert.equal(mp4.ok, true, JSON.stringify(mp4))
  await saveCaptured('lyrics-opaque.mp4')
  assert.equal(await evaluate(`window.__canvas.getContext('2d').getImageData(0,0,1,1).data[3]`), 255)
  console.log('PASS: existing opaque MP4 export')

  // Browser-independent decoding checks the actual exported file, including lyric pixels.
  if (spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0) {
    const probe = spawnSync('ffprobe', ['-v','error','-show_streams','-of','json',movPath], { encoding: 'utf8', windowsHide: true })
    assert.equal(probe.status, 0, probe.stderr)
    const [stream] = JSON.parse(probe.stdout).streams
    assert.equal(stream.pix_fmt, 'rgba')
    assert.equal(stream.nb_frames, '6')
    assert.equal(stream.r_frame_rate, '24/1')
    assert.equal(Number(stream.duration), 0.25)
    const decoded = spawnSync('ffmpeg', ['-v','error','-i',movPath,'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    assert.equal(decoded.status, 0, decoded.stderr.toString())
    assert.equal(decoded.stdout[3], 0)
    assert.ok(decoded.stdout.some((v, i) => i % 4 === 3 && v > 0 && v < 255))
    console.log('PASS: actual lyric MOV decodes with alpha, 24 fps, 6 frames and 0.25s duration')
  }
  assert.deepEqual(errors, [], JSON.stringify(errors))
  console.log(`All browser checks passed. Artifacts: ${outputDir}`)
} finally {
  ws?.close()
  for (const call of pending.values()) clearTimeout(call.timer)
  const exited = new Promise((r) => browser.once('exit', r))
  browser.kill()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* browser may still be releasing its profile */ }
}
