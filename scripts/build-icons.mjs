/**
 * 生成应用图标
 *
 * 输入：build/icon.svg
 * 输出：
 *   - build/icon.png        256×256 主图标（Linux / BrowserWindow icon）
 *   - build/icon.ico        多分辨率 .ico（Windows 安装包 / 任务栏）
 *   - build/icon.icns       macOS .icns（多分辨率，打包必需）
 *   - build/icons/*.png     各尺寸分解（可选，方便调试）
 *
 * 运行：node scripts/build-icons.mjs
 *
 * 依赖：项目已声明 sharp ^0.33.5。
 *
 * 实现要点：
 * - sharp 支持读取 SVG，输出 PNG。
 * - .ico 文件格式 = 6 字节 header + N * 16 字节 directory + N 个 PNG 数据段。
 *   Windows 7+ 支持 PNG 嵌入的 ICO，所以可以直接把 PNG 字节原样拼进去，
 *   无需做 BMP 编码。
 * - .icns：macOS 苹果图标格式。结构：8 字节文件头 ('icns' + 大端 uint32) +
 *   N 个 8 字节块头 (4 字节类型 + 4 字节大端 uint32 块大小，包含块头) + 数据。
 *   这里用手写 buffer 拼装，零依赖、不依赖 macOS 系统调用，Linux CI 也能跑。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SVG_PATH = join(ROOT, 'build', 'icon.svg')
const ICON_PNG = join(ROOT, 'build', 'icon.png')
const ICON_ICO = join(ROOT, 'build', 'icon.ico')
const ICON_ICNS = join(ROOT, 'build', 'icon.icns')
const ICONS_DIR = join(ROOT, 'build', 'icons')

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
// macOS ICNS 标准尺寸（覆盖 macOS 11+ 全部 icon type）
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]

/**
 * 把 PNG buffer 列表组合成 ICNS buffer。
 * ICNS 格式（macOS）：
 *   - 8 字节文件头：4 字节 magic 'icns' + 4 字节大端 uint32 文件总大小
 *   - N 个图标块：4 字节类型 + 4 字节大端 uint32 块大小（含块头 8 字节）+ 数据
 *
 * 块类型映射（macOS 标准）：
 *   16  → icp4, 32  → icp5, 64  → icp6, 128 → ic07
 *   256 → ic08, 512 → ic09, 1024 → ic10
 */
function buildIcns(pngFrames) {
  const TYPE_BY_SIZE = {
    16: 'icp4',
    32: 'icp5',
    64: 'icp6',
    128: 'ic07',
    256: 'ic08',
    512: 'ic09',
    1024: 'ic10',
  }
  const blocks = []
  for (const { px, buf } of pngFrames) {
    const type = TYPE_BY_SIZE[px]
    if (!type) continue
    const dataSize = buf.byteLength
    const blockSize = 8 + dataSize // 含 8 字节块头
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(blockSize, 4)
    blocks.push(Buffer.concat([header, buf]))
  }
  const totalSize = 8 + blocks.reduce((s, b) => s + b.byteLength, 0)
  const fileHeader = Buffer.alloc(8)
  fileHeader.write('icns', 0, 4, 'ascii')
  fileHeader.writeUInt32BE(totalSize, 4)
  return Buffer.concat([fileHeader, ...blocks])
}

/** 把 PNG buffer 列表组合成 ICO buffer（PNG 嵌入格式）。
 *  ICO 格式：6 字节文件头 + N * 16 字节目录项 + N 个 PNG 数据段。
 */
function buildIco(pngFrames) {
  if (pngFrames.length === 0) throw new Error('没有可用的 PNG 帧')
  const headerSize = 6
  const dirEntrySize = 16
  const dirSize = dirEntrySize * pngFrames.length
  let offset = headerSize + dirSize

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = ICO
  header.writeUInt16LE(pngFrames.length, 4) // count

  const entries = Buffer.alloc(dirSize)
  pngFrames.forEach((frame, i) => {
    const entryOffset = i * dirEntrySize
    const size = frame.size
    const pxSize = frame.px
    // ICO 规定 256 编码为 0
    entries.writeUInt8(pxSize >= 256 ? 0 : pxSize, entryOffset + 0) // width
    entries.writeUInt8(pxSize >= 256 ? 0 : pxSize, entryOffset + 1) // height
    entries.writeUInt8(0, entryOffset + 2) // colorCount
    entries.writeUInt8(0, entryOffset + 3) // reserved
    entries.writeUInt16LE(1, entryOffset + 4) // planes
    entries.writeUInt16LE(32, entryOffset + 6) // bitCount
    entries.writeUInt32LE(size, entryOffset + 8) // sizeInBytes
    entries.writeUInt32LE(offset, entryOffset + 12) // offset
    offset += size
  })

  return Buffer.concat([header, entries, ...pngFrames.map((f) => f.buf)])
}

async function renderPngs(svgBuf, sizes, background) {
  const out = []
  for (const size of sizes) {
    const buf = await sharp(svgBuf, { density: 384 })
      .resize(size, size, { fit: 'contain', background })
      .png({ compressionLevel: 9 })
      .toBuffer()
    out.push({ px: size, size: buf.byteLength, buf })
    console.log(`[build-icons]   ${size}x${size}  ${(buf.byteLength / 1024).toFixed(1)} KiB`)
  }
  return out
}

async function main() {
  console.log('[build-icons] reading', SVG_PATH)
  const svgBuf = await readFile(SVG_PATH)

  await mkdir(ICONS_DIR, { recursive: true })

  // ICO 用 PNG（透明背景 —— Windows 在任务栏 / 资源管理器上会渲染为方形，
  // 透明边缘效果 OK）。
  console.log('[build-icons] generating ICO frames:')
  const icoPngs = await renderPngs(svgBuf, ICO_SIZES, { r: 0, g: 0, b: 0, alpha: 0 })
  for (const f of icoPngs) {
    await writeFile(join(ICONS_DIR, `icon-${f.px}.png`), f.buf)
  }

  // 主 PNG = 256x256（不透明背景，Windows 资源管理器在透明背景下渲染会变黑）
  // UI 清理 (icon-redesign)：背景从 indigo #6366f1 改为暖黄 #F5C76A，跟新便签纸主色一致。
  // W1-B (icon-redraw)：外圈改成时钟面 + 对勾；保持主色。
  const mainPng = await sharp(svgBuf, { density: 384 })
    .resize(256, 256, { fit: 'contain', background: { r: 245, g: 199, b: 106, alpha: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
  await writeFile(ICON_PNG, mainPng)
  console.log(`[build-icons] wrote ${ICON_PNG}  (${(mainPng.byteLength / 1024).toFixed(1)} KiB)`)

  // ICO
  const ico = buildIco(icoPngs.map((p) => ({ px: p.px, size: p.size, buf: p.buf })))
  await writeFile(ICON_ICO, ico)
  console.log(`[build-icons] wrote ${ICON_ICO}  (${(ico.byteLength / 1024).toFixed(1)} KiB)`)

  // ICNS（macOS）。需要不透明背景 PNG —— 透明 ICNS 在 macOS Dock 上有渲染 bug。
  console.log('[build-icons] generating ICNS frames:')
  const icnsPngs = await renderPngs(svgBuf, ICNS_SIZES, { r: 245, g: 199, b: 106, alpha: 1 })
  const icns = buildIcns(icnsPngs)
  await writeFile(ICON_ICNS, icns)
  console.log(`[build-icons] wrote ${ICON_ICNS}  (${(icns.byteLength / 1024).toFixed(1)} KiB)`)

  console.log('[build-icons] done.')
}

main().catch((err) => {
  console.error('[build-icons] failed:', err)
  process.exit(1)
})