import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const size = 256
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(projectRoot, 'build')
const rgba = Buffer.alloc(size * size * 4)

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const index = (y * size + x) * 4
    const inside = insideRoundedRect(x, y, 14, 14, size - 28, size - 28, 54)
    if (!inside) continue

    const dx = x - size / 2
    const dy = y - size / 2
    const distance = Math.sqrt(dx * dx + dy * dy)
    const backgroundLift = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 180)
    let red = Math.round(17 + 14 * backgroundLift)
    let green = Math.round(21 + 16 * backgroundLift)
    let blue = Math.round(31 + 24 * backgroundLift)

    if (distance >= 60 && distance <= 82) {
      const mix = Math.max(0, Math.min(1, (x + y) / (size * 2)))
      red = Math.round(130 - 66 * mix)
      green = Math.round(150 + 78 * mix)
      blue = Math.round(255 - 42 * mix)
    }

    const sparkleVertical = Math.abs(dx) <= 7 && Math.abs(dy) <= 39 - Math.abs(dx) * 2.2
    const sparkleHorizontal = Math.abs(dy) <= 7 && Math.abs(dx) <= 39 - Math.abs(dy) * 2.2
    if (sparkleVertical || sparkleHorizontal) {
      red = 232
      green = 255
      blue = 250
    }

    rgba[index] = red
    rgba[index + 1] = green
    rgba[index + 2] = blue
    rgba[index + 3] = 255
  }
}

const png = createPng(size, size, rgba)
const ico = createIco(png)
await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  writeFile(resolve(outputDirectory, 'icon.png'), png),
  writeFile(resolve(outputDirectory, 'icon.ico'), ico)
])

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width
  const bottom = top + height
  const closestX = Math.max(left + radius, Math.min(x, right - radius))
  const closestY = Math.max(top + radius, Math.min(y, bottom - radius))
  const dx = x - closestX
  const dy = y - closestY
  return x >= left && x <= right && y >= top && y <= bottom && dx * dx + dy * dy <= radius * radius
}

function createPng(width, height, pixels) {
  const stride = width * 4
  const scanlines = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1)
    scanlines[row] = 0
    pixels.copy(scanlines, row + 1, y * stride, (y + 1) * stride)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, checksum])
}

function createIco(png) {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = 0
  header[7] = 0
  header[8] = 0
  header[9] = 0
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const value of buffer) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
