import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PngMovWriter } from '../src/core/pngMov.js'
import { createDefaultSettings, sanitizeSettings } from '../src/core/settings.js'

// Small independent PNG fixture with fully transparent, half-transparent and opaque pixels.
function pngChunk(type, data) {
  const input = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, input, checksum])
}
const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 64])
const nextPixels = Buffer.from([0, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 64, 0, 255, 0, 128])
function png(rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(4, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return new Blob([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat([Buffer.from([0]), rgba]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ], { type: 'image/png' })
}
async function makeMovie(fps = 24, writable = null) {
  const writer = new PngMovWriter({ width: 4, height: 1, fps, writable })
  await writer.start()
  await writer.addFrame(png(pixels))
  await writer.addFrame(png(nextPixels))
  await writer.addFrame(png(pixels))
  return writer.finalize()
}

test('format settings survive persistence; old/invalid settings use MP4', () => {
  assert.equal(createDefaultSettings().export.format, 'mp4')
  assert.equal(sanitizeSettings({}).export.format, 'mp4')
  assert.equal(sanitizeSettings({ export: { format: 'webm' } }).export.format, 'mp4')
  assert.equal(sanitizeSettings({ export: { format: 'mov-alpha' } }).export.format, 'mov-alpha')
})

test('streamed output matches the Blob output byte for byte', async () => {
  let position = 0
  let buffer = Buffer.alloc(0)
  let closed = false
  const writable = {
    async write(part) {
      const bytes = part instanceof Blob ? Buffer.from(await part.arrayBuffer()) : Buffer.from(part)
      if (position + bytes.length > buffer.length) {
        const grown = Buffer.alloc(position + bytes.length)
        buffer.copy(grown)
        buffer = grown
      }
      bytes.copy(buffer, position)
      position += bytes.length
    },
    async seek(offset) { position = offset },
    async close() { closed = true },
    async abort() { assert.fail('unexpected abort') },
  }
  const memory = await makeMovie()
  const streamed = await makeMovie(24, writable)
  assert.equal(streamed.blob, null)
  assert.equal(streamed.bytes, memory.bytes)
  assert.equal(closed, true)
  assert.deepEqual(buffer, Buffer.from(await memory.blob.arrayBuffer()))
})

test('memory limit fails before retaining an oversized frame; abort releases frames', async () => {
  const writer = new PngMovWriter({ width: 4, height: 1, fps: 30, maxBytes: 2200 })
  await writer.start()
  await writer.addFrame(png(pixels))
  await assert.rejects(writer.addFrame(new Blob([Buffer.alloc(1024)], { type: 'image/png' })), { name: 'MovMemoryLimitError' })
  assert.equal(writer.sizes.length, 1)
  await writer.abort()
  assert.equal(writer.frames.length, 0)
  await assert.rejects(writer.finalize())
  await assert.rejects(writer.addFrame(png(pixels)))
})

test('abort rolls back the file stream and empty movies cannot be finalized', async () => {
  let aborted = false
  const writer = new PngMovWriter({ width: 4, height: 1, fps: 60, writable: {
    async write() {}, async abort() { aborted = true },
  } })
  await writer.start()
  await assert.rejects(writer.finalize())
  await writer.abort()
  assert.equal(aborted, true)
  assert.throws(() => new PngMovWriter({ width: 0, height: 1, fps: 30 }), RangeError)
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0
test('FFmpeg decodes exact RGBA pixels, frame order, count and timing at 24/30/60 fps', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lrc-mov-test-'))
  try {
    for (const fps of [24, 30, 60]) {
      const output = await makeMovie(fps)
      const path = join(dir, `alpha-${fps}.mov`)
      writeFileSync(path, Buffer.from(await output.blob.arrayBuffer()))
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path], { encoding: 'utf8', windowsHide: true })
      assert.equal(probe.status, 0, probe.stderr)
      const [stream] = JSON.parse(probe.stdout).streams
      assert.equal(stream.codec_name, 'png')
      assert.equal(stream.pix_fmt, 'rgba')
      assert.equal(stream.nb_frames, '3')
      assert.equal(stream.r_frame_rate, `${fps}/1`)
      assert.ok(Math.abs(Number(stream.duration) - 3 / fps) < 0.00001)
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true })
      assert.equal(decode.status, 0, decode.stderr.toString())
      assert.deepEqual(decode.stdout, Buffer.concat([pixels, nextPixels, pixels]))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
