// @ts-check
/**
 * QuickTime PNG video: one lossless RGBA PNG per sample, no audio.
 * PNG preserves straight alpha without relying on a browser's video encoder.
 * A single media chunk and 64-bit offsets/sizes also support large streamed files.
 * The sample table lives at the end, so frames can be written directly to disk.
 */
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const zeros = (n) => new Uint8Array(n)
function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
function u16(n) {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n)
  return b
}
function u32(n) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}
function u64(n) {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n))
  return b
}
const atom = (type, ...parts) => {
  const body = join(...parts)
  return join(u32(8 + body.length), ascii(type), body)
}
const full = (type, flags, ...parts) => atom(type, u32(flags), ...parts)
const matrix = join(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000))
const ftyp = atom('ftyp', ascii('qt  '), u32(0), ascii('qt  '))
const mediaHeader = (bytes) => join(u32(1), ascii('mdat'), u64(16 + bytes))
export const MOV_MEMORY_LIMIT = 512 * 1024 * 1024

function movieHeader(width, height, fps, sizes) {
  const count = sizes.length
  const mvhd = full('mvhd', 0, u32(0), u32(0), u32(fps), u32(count),
    u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2))
  const tkhd = full('tkhd', 7, u32(0), u32(0), u32(1), u32(0), u32(count),
    zeros(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(width * 65536), u32(height * 65536))
  const mdhd = full('mdhd', 0, u32(0), u32(0), u32(fps), u32(count), u16(0), u16(0))
  const hdlr = full('hdlr', 0, u32(0), ascii('vide'), zeros(12), ascii('LRC transparent video\0'))
  const compressor = zeros(32)
  compressor.set(ascii('PNG'), 1)
  compressor[0] = 3
  const sample = atom('png ', zeros(6), u16(1), u16(0), u16(0), u32(0),
    u32(0), u32(0), u16(width), u16(height), u32(72 * 65536), u32(72 * 65536),
    u32(0), u16(1), compressor, u16(32), u16(0xffff))
  const sizeTable = new Uint8Array(count * 4)
  const view = new DataView(sizeTable.buffer)
  sizes.forEach((size, i) => view.setUint32(i * 4, size))
  const stbl = atom('stbl',
    full('stsd', 0, u32(1), sample),
    full('stts', 0, u32(1), u32(count), u32(1)),
    full('stsc', 0, u32(1), u32(1), u32(count), u32(1)),
    full('stsz', 0, u32(0), u32(count), sizeTable),
    full('co64', 0, u32(1), u64(ftyp.length + 16)))
  const dinf = atom('dinf', full('dref', 0, u32(1), full('url ', 1)))
  const minf = atom('minf', full('vmhd', 1, zeros(8)), dinf, stbl)
  return atom('moov', mvhd, atom('trak', tkhd, atom('mdia', mdhd, hdlr, minf)))
}

/** A size-limited Blob fallback, or a transactional FileSystemWritableFileStream. */
export class PngMovWriter {
  constructor({ width, height, fps, writable = null, maxBytes = MOV_MEMORY_LIMIT }) {
    if (![width, height, fps].every(Number.isInteger) || width < 1 || height < 1 ||
      width > 65535 || height > 65535 || fps < 1 || fps > 1000) {
      throw new RangeError('Invalid MOV dimensions or frame rate')
    }
    this.width = width
    this.height = height
    this.fps = fps
    this.writable = writable
    this.maxBytes = maxBytes
    this.sizes = []
    this.frames = []
    this.bytes = 0
    this.started = false
    this.closed = false
  }

  async start() {
    if (this.started || this.closed) throw new Error('MOV writer already started or closed')
    this.started = true
    if (this.writable) {
      await this.writable.write(ftyp)
      await this.writable.write(mediaHeader(0))
    }
  }

  async addFrame(png) {
    if (!this.started || this.closed) throw new Error('MOV writer is not open')
    if (!(png instanceof Blob) || png.type !== 'image/png' || png.size < 33 || png.size > 0xffffffff) {
      throw new Error('Expected a PNG frame')
    }
    // Include the growing size table and headers in the memory budget.
    if (!this.writable && this.bytes + png.size + (this.sizes.length + 1) * 4 + 2048 > this.maxBytes) {
      const error = new Error('MOV memory limit reached')
      error.name = 'MovMemoryLimitError'
      throw error
    }
    if (this.writable) await this.writable.write(png)
    else this.frames.push(png)
    this.sizes.push(png.size)
    this.bytes += png.size
  }

  async finalize() {
    if (!this.started || this.closed || !this.sizes.length) throw new Error('No MOV frames to finalize')
    const moov = movieHeader(this.width, this.height, this.fps, this.sizes)
    const size = ftyp.length + 16 + this.bytes + moov.length
    let blob = null
    if (this.writable) {
      await this.writable.write(moov)
      await this.writable.seek(ftyp.length)
      await this.writable.write(mediaHeader(this.bytes))
      await this.writable.close()
    } else {
      blob = new Blob([ftyp, mediaHeader(this.bytes), ...this.frames, moov], { type: 'video/quicktime' })
    }
    this.closed = true
    this.frames = []
    this.sizes = []
    return { blob, bytes: size }
  }

  async abort() {
    if (this.closed) return
    this.closed = true
    this.frames = []
    this.sizes = []
    if (this.writable) await this.writable.abort()
  }
}
