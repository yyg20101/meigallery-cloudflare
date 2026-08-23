import { IMPORT_PACKAGE_LIMITS } from '@meigallery/shared/constants'
import { containsAsciiControlCharacter } from '../utils/text-safety'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const MAX_ZIP_COMMENT_BYTES = 65_535
const ZIP_EOCD_BYTES = 22
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp'])
const MAX_IMAGE_DIMENSION = 20_000
const MAX_IMAGE_PIXELS = 80_000_000
const MANIFEST_HEADERS = [
  'folder',
  'title',
  'slug',
  'region',
  'personality',
  'style',
  'tags',
  'required_level',
  'status',
] as const

export type ZipImportErrorScope = 'package' | 'item'

export class ZipImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly scope: ZipImportErrorScope,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ZipImportError'
  }
}

export interface ZipArchiveEntry {
  path: string
  compressionMethod: number
  flags: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  directory: boolean
}

export interface ZipArchiveIndex {
  sourceKey: string
  packageSize: number
  centralDirectoryOffset: number
  entries: ZipArchiveEntry[]
  byPath: Map<string, ZipArchiveEntry>
}

export interface ZipManifestRow {
  folder: string
  title: string
  slug: string
  region: string
  personality: string
  style: string
  tags: string[]
  requiredLevel: 'free' | 'vip' | 'svip'
  status: 'draft' | 'published'
}

export interface PreparedZipImportItem {
  row: ZipManifestRow
  contentPath: string
  coverPath: string
  imagePaths: string[]
  videoPaths: Array<{ path: string; role: 'preview' | 'full' }>
  preflightError?: { code: string; message: string }
}

export interface PreparedZipImportPackage {
  archive: ZipArchiveIndex
  items: PreparedZipImportItem[]
}

export async function prepareZipImportPackage(
  r2: R2Bucket,
  sourceKey: string,
  packageSize: number,
): Promise<PreparedZipImportPackage> {
  const archive = await openZipArchive(r2, sourceKey, packageSize)
  const manifestEntry = archive.byPath.get('manifest.csv')
  if (!manifestEntry || manifestEntry.directory) {
    throw packageError('IMPORT_MANIFEST_MISSING', 'ZIP 根目录缺少 manifest.csv')
  }
  if (manifestEntry.uncompressedSize > IMPORT_PACKAGE_LIMITS.MAX_TEXT_BYTES) {
    throw packageError('IMPORT_MANIFEST_TOO_LARGE', 'manifest.csv 超过 1MB 上限')
  }

  const manifestBytes = await readZipEntry(r2, archive, manifestEntry, 'package')
  const manifestText = decodeUtf8(manifestBytes, 'manifest.csv', 'package')
  const rows = parseManifestCsv(manifestText)
  const declaredFolders = new Set(rows.map(row => row.folder))
  const inventoryErrors = new Map<string, { code: string; message: string }>()

  for (const entry of archive.entries) {
    if (entry.directory || entry.path === 'manifest.csv' || isIgnoredArchivePath(entry.path)) continue
    const [folder, ...rest] = entry.path.split('/')
    if (!folder || !declaredFolders.has(folder)) {
      throw packageError('IMPORT_UNDECLARED_PATH', `ZIP 含有 manifest.csv 未声明的路径：${entry.path}`)
    }
    const relativePath = rest.join('/')
    if (!isAllowedGalleryPath(relativePath)) {
      inventoryErrors.set(folder, {
        code: 'IMPORT_ITEM_UNSUPPORTED_PATH',
        message: `目录含有不支持的文件：${relativePath || entry.path}`,
      })
    }
  }

  return {
    archive,
    items: rows.map((row) => {
      const prefix = `${row.folder}/`
      const contentPath = `${prefix}content.md`
      const coverPath = `${prefix}cover.jpg`
      const imagePaths = archive.entries
        .filter(entry => !entry.directory && isGalleryImagePath(entry.path, row.folder))
        .map(entry => entry.path)
        .sort(compareArchivePaths)
      const videoPaths: PreparedZipImportItem['videoPaths'] = []
      if (archive.byPath.has(`${prefix}videos/preview.mp4`)) {
        videoPaths.push({ path: `${prefix}videos/preview.mp4`, role: 'preview' })
      }
      if (archive.byPath.has(`${prefix}videos/full.mp4`)) {
        videoPaths.push({ path: `${prefix}videos/full.mp4`, role: 'full' })
      }

      const preflightError = validateManifestRow(row)
        ?? inventoryErrors.get(row.folder)
        ?? (!archive.byPath.has(contentPath)
          ? { code: 'IMPORT_CONTENT_MISSING', message: '缺少 content.md' }
          : undefined)
        ?? (!archive.byPath.has(coverPath)
          ? { code: 'IMPORT_COVER_MISSING', message: '缺少 cover.jpg' }
          : undefined)
        ?? (imagePaths.length === 0
          ? { code: 'IMPORT_IMAGES_MISSING', message: 'images/ 目录至少需要一张图片' }
          : undefined)

      return { row, contentPath, coverPath, imagePaths, videoPaths, preflightError }
    }),
  }
}

export async function openZipArchive(
  r2: R2Bucket,
  sourceKey: string,
  packageSize: number,
): Promise<ZipArchiveIndex> {
  if (!Number.isSafeInteger(packageSize) || packageSize < ZIP_EOCD_BYTES) {
    throw packageError('IMPORT_PACKAGE_INVALID', 'ZIP 文件为空或结构不完整')
  }
  if (packageSize > IMPORT_PACKAGE_LIMITS.MAX_ARCHIVE_BYTES) {
    throw packageError('IMPORT_PACKAGE_TOO_LARGE', 'ZIP 文件超过 256MB 上限')
  }

  const tailLength = Math.min(packageSize, ZIP_EOCD_BYTES + MAX_ZIP_COMMENT_BYTES)
  const tailOffset = packageSize - tailLength
  const tail = await readR2Range(r2, sourceKey, tailOffset, tailLength, 'package')
  const eocdOffset = findEndOfCentralDirectory(tail)
  if (eocdOffset < 0) {
    throw packageError('IMPORT_ZIP_EOCD_MISSING', 'ZIP 中央目录结束记录不存在')
  }

  const eocd = new DataView(tail.buffer, tail.byteOffset + eocdOffset, tail.byteLength - eocdOffset)
  const diskNumber = eocd.getUint16(4, true)
  const centralDiskNumber = eocd.getUint16(6, true)
  const diskEntryCount = eocd.getUint16(8, true)
  const totalEntryCount = eocd.getUint16(10, true)
  const centralDirectorySize = eocd.getUint32(12, true)
  const centralDirectoryOffset = eocd.getUint32(16, true)

  if (diskNumber !== 0 || centralDiskNumber !== 0 || diskEntryCount !== totalEntryCount) {
    throw packageError('IMPORT_MULTI_DISK_ZIP_UNSUPPORTED', '不支持分卷 ZIP')
  }
  if (
    totalEntryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    throw packageError('IMPORT_ZIP64_UNSUPPORTED', '当前导入不支持 ZIP64，请拆分导入包')
  }
  if (totalEntryCount === 0 || totalEntryCount > IMPORT_PACKAGE_LIMITS.MAX_ENTRIES) {
    throw packageError('IMPORT_ENTRY_COUNT_INVALID', `ZIP 文件数量必须为 1-${IMPORT_PACKAGE_LIMITS.MAX_ENTRIES}`)
  }
  if (
    centralDirectorySize <= 0
    || centralDirectorySize > IMPORT_PACKAGE_LIMITS.MAX_CENTRAL_DIRECTORY_BYTES
  ) {
    throw packageError('IMPORT_CENTRAL_DIRECTORY_TOO_LARGE', 'ZIP 中央目录超过应用上限')
  }
  const eocdAbsoluteOffset = tailOffset + eocdOffset
  if (
    centralDirectoryOffset + centralDirectorySize > eocdAbsoluteOffset
    || centralDirectoryOffset + centralDirectorySize > packageSize
  ) {
    throw packageError('IMPORT_ZIP_OFFSETS_INVALID', 'ZIP 中央目录偏移无效')
  }

  const central = await readR2Range(
    r2,
    sourceKey,
    centralDirectoryOffset,
    centralDirectorySize,
    'package',
  )
  const entries = parseCentralDirectory(central, totalEntryCount, centralDirectoryOffset)
  return {
    sourceKey,
    packageSize,
    centralDirectoryOffset,
    entries,
    byPath: new Map(entries.map(entry => [entry.path, entry])),
  }
}

export async function readZipEntry(
  r2: R2Bucket,
  archive: ZipArchiveIndex,
  entryOrPath: ZipArchiveEntry | string,
  scope: ZipImportErrorScope = 'item',
): Promise<Uint8Array> {
  const entry = typeof entryOrPath === 'string' ? archive.byPath.get(entryOrPath) : entryOrPath
  if (!entry || entry.directory) {
    throw new ZipImportError('IMPORT_ENTRY_MISSING', 'ZIP 条目不存在', scope)
  }

  const localHeader = await readR2Range(
    r2,
    archive.sourceKey,
    entry.localHeaderOffset,
    30,
    scope,
  )
  const view = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength)
  if (view.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) {
    throw new ZipImportError('IMPORT_LOCAL_HEADER_INVALID', `ZIP 条目头无效：${entry.path}`, scope)
  }
  const localFlags = view.getUint16(6, true)
  const localCompression = view.getUint16(8, true)
  const fileNameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  if (localFlags !== entry.flags || localCompression !== entry.compressionMethod) {
    throw new ZipImportError('IMPORT_ENTRY_METADATA_MISMATCH', `ZIP 条目元数据不一致：${entry.path}`, scope)
  }

  const localName = await readR2Range(
    r2,
    archive.sourceKey,
    entry.localHeaderOffset + 30,
    fileNameLength,
    scope,
  )
  const decodedLocalName = decodeZipPath(localName, Boolean(entry.flags & 0x0800))
  if (decodedLocalName !== entry.path) {
    throw new ZipImportError('IMPORT_ENTRY_NAME_MISMATCH', `ZIP 条目名称不一致：${entry.path}`, scope)
  }

  const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraLength
  if (dataOffset + entry.compressedSize > archive.centralDirectoryOffset) {
    throw new ZipImportError('IMPORT_ENTRY_RANGE_INVALID', `ZIP 条目范围无效：${entry.path}`, scope)
  }
  let observedCompressedSize = 0
  let observedUncompressedSize = 0
  let bytes: Uint8Array
  try {
    const compressedStream = entry.compressedSize === 0
      ? new ReadableStream<Uint8Array>({ start: controller => controller.close() })
      : await readR2RangeBody(r2, archive.sourceKey, dataOffset, entry.compressedSize, scope)
    const countedCompressed = compressedStream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observedCompressedSize += chunk.byteLength
        if (observedCompressedSize > entry.compressedSize) {
          throw new ZipImportError('IMPORT_ENTRY_SIZE_MISMATCH', `ZIP 条目压缩大小校验失败：${entry.path}`, scope)
        }
        controller.enqueue(chunk)
      },
    }))
    const decompressed = entry.compressionMethod === 0
      ? countedCompressed
      : countedCompressed.pipeThrough(new DecompressionStream('deflate-raw'))
    const bounded = decompressed.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observedUncompressedSize += chunk.byteLength
        if (observedUncompressedSize > entry.uncompressedSize) {
          throw new ZipImportError('IMPORT_ENTRY_SIZE_MISMATCH', `ZIP 条目解压大小超过目录声明：${entry.path}`, scope)
        }
        controller.enqueue(chunk)
      },
    }))
    bytes = new Uint8Array(await new Response(bounded).arrayBuffer())
  }
  catch (error) {
    if (error instanceof ZipImportError) throw error
    throw new ZipImportError('IMPORT_ENTRY_DECOMPRESSION_FAILED', `ZIP 条目解压失败：${entry.path}`, scope)
  }

  if (
    observedCompressedSize !== entry.compressedSize
    || observedUncompressedSize !== entry.uncompressedSize
    || bytes.byteLength !== entry.uncompressedSize
  ) {
    throw new ZipImportError('IMPORT_ENTRY_SIZE_MISMATCH', `ZIP 条目大小校验失败：${entry.path}`, scope)
  }
  if (crc32(bytes) !== entry.crc32) {
    throw new ZipImportError('IMPORT_ENTRY_CRC_MISMATCH', `ZIP 条目完整性校验失败：${entry.path}`, scope)
  }
  return bytes
}

export function decodeZipText(
  bytes: Uint8Array,
  path: string,
  scope: ZipImportErrorScope = 'item',
): string {
  if (bytes.byteLength > IMPORT_PACKAGE_LIMITS.MAX_TEXT_BYTES) {
    throw new ZipImportError('IMPORT_TEXT_TOO_LARGE', `${path} 超过 1MB 上限`, scope)
  }
  return decodeUtf8(bytes, path, scope)
}

export function detectImageType(bytes: Uint8Array): 'jpg' | 'png' | 'webp' | 'gif' | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'png'
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp'
  if (bytes.byteLength >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return 'gif'
  return null
}

export function assertImageMatchesPath(bytes: Uint8Array, path: string): 'jpg' | 'png' | 'webp' {
  const detected = detectImageType(bytes)
  const extension = extensionOf(path)
  const normalizedExtension = extension === 'jpeg' ? 'jpg' : extension
  if (!detected || detected !== normalizedExtension) {
    throw itemError('IMPORT_IMAGE_SIGNATURE_INVALID', `图片扩展名与文件内容不一致：${path}`)
  }
  if (detected === 'gif') {
    throw itemError('IMPORT_IMAGE_TYPE_UNSUPPORTED', `ZIP 导入图片仅支持 JPEG、PNG 和 WebP：${path}`)
  }
  return assertSupportedImageBytes(bytes, path)
}

/** 对没有可信文件名的远程图片执行与 ZIP 导入相同的内容、容器和像素边界。 */
export function assertSupportedImageBytes(
  bytes: Uint8Array,
  label: string,
): 'jpg' | 'png' | 'webp' {
  const detected = detectImageType(bytes)
  if (!detected || detected === 'gif') {
    throw itemError('IMPORT_IMAGE_TYPE_UNSUPPORTED', `图片仅支持 JPEG、PNG 和 WebP：${label}`)
  }
  assertImageContainer(bytes, detected, label)
  const dimensions = imageDimensions(bytes, detected)
  if (
    !dimensions
    || dimensions.width <= 0
    || dimensions.height <= 0
    || dimensions.width > MAX_IMAGE_DIMENSION
    || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw itemError('IMPORT_IMAGE_DIMENSIONS_INVALID', `图片尺寸无效或超过安全上限：${label}`)
  }
  return detected
}

/** 去除可能包含定位、设备和作者信息的图片元数据；ZIP 原包本身继续私有留存。 */
export function sanitizeImportedImage(
  bytes: Uint8Array,
  type: 'jpg' | 'png' | 'webp',
): Uint8Array {
  if (type === 'jpg') return stripJpegMetadata(bytes)
  if (type === 'png') return stripPngMetadata(bytes)
  return stripWebpMetadata(bytes)
}

export function assertMp4(bytes: Uint8Array, path: string): void {
  if (bytes.byteLength < 12 || ascii(bytes, 4, 4) !== 'ftyp') {
    throw itemError('IMPORT_VIDEO_SIGNATURE_INVALID', `视频不是有效的 MP4 文件：${path}`)
  }
}

function parseCentralDirectory(
  central: Uint8Array,
  expectedEntries: number,
  centralDirectoryOffset: number,
): ZipArchiveEntry[] {
  const entries: ZipArchiveEntry[] = []
  const seen = new Set<string>()
  let offset = 0
  let totalUncompressedBytes = 0

  while (entries.length < expectedEntries) {
    if (offset + 46 > central.byteLength) {
      throw packageError('IMPORT_CENTRAL_DIRECTORY_TRUNCATED', 'ZIP 中央目录被截断')
    }
    const view = new DataView(central.buffer, central.byteOffset + offset, central.byteLength - offset)
    if (view.getUint32(0, true) !== CENTRAL_FILE_SIGNATURE) {
      throw packageError('IMPORT_CENTRAL_ENTRY_INVALID', 'ZIP 中央目录条目无效')
    }

    const versionMadeBy = view.getUint16(4, true)
    const flags = view.getUint16(8, true)
    const compressionMethod = view.getUint16(10, true)
    const entryCrc32 = view.getUint32(16, true)
    const compressedSize = view.getUint32(20, true)
    const uncompressedSize = view.getUint32(24, true)
    const fileNameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const commentLength = view.getUint16(32, true)
    const diskStart = view.getUint16(34, true)
    const externalAttributes = view.getUint32(38, true)
    const localHeaderOffset = view.getUint32(42, true)
    const recordLength = 46 + fileNameLength + extraLength + commentLength
    if (offset + recordLength > central.byteLength || fileNameLength === 0) {
      throw packageError('IMPORT_CENTRAL_ENTRY_TRUNCATED', 'ZIP 中央目录条目不完整')
    }
    if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw packageError('IMPORT_ZIP64_UNSUPPORTED', '当前导入不支持 ZIP64 或分卷条目')
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
      throw packageError('IMPORT_ENCRYPTED_ZIP_UNSUPPORTED', '不支持加密 ZIP')
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw packageError('IMPORT_COMPRESSION_UNSUPPORTED', 'ZIP 仅支持 stored 或 deflate 压缩')
    }
    const supportedFlags = compressionMethod === 8 ? 0x080e : 0x0808
    if ((flags & ~supportedFlags) !== 0) {
      throw packageError('IMPORT_ZIP_FLAGS_UNSUPPORTED', 'ZIP 使用了当前不支持的条目特性')
    }

    const fileNameBytes = central.subarray(offset + 46, offset + 46 + fileNameLength)
    const path = decodeZipPath(fileNameBytes, Boolean(flags & 0x0800))
    validateArchivePath(path)
    const madeBySystem = versionMadeBy >>> 8
    const unixMode = externalAttributes >>> 16
    if (madeBySystem === 3 && (unixMode & 0xf000) === 0xa000) {
      throw packageError('IMPORT_SYMLINK_UNSUPPORTED', `ZIP 不允许符号链接：${path}`)
    }

    const directory = path.endsWith('/')
    const entryLimit = isTextArchivePath(path)
      ? IMPORT_PACKAGE_LIMITS.MAX_TEXT_BYTES
      : isImageArchivePath(path)
        ? IMPORT_PACKAGE_LIMITS.MAX_IMAGE_ENTRY_BYTES
        : IMPORT_PACKAGE_LIMITS.MAX_MEDIA_ENTRY_BYTES
    if (
      !directory
      && Math.max(compressedSize, uncompressedSize) > entryLimit
    ) {
      const label = isTextArchivePath(path)
        ? '文本文件超过 1MB 上限'
        : isImageArchivePath(path)
          ? '图片超过 10MB 上限'
          : '单个文件超过 48MB 上限'
      throw packageError('IMPORT_ENTRY_TOO_LARGE', `${label}：${path}`)
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      throw packageError('IMPORT_COMPRESSION_RATIO_INVALID', `ZIP 条目压缩比异常：${path}`)
    }
    if (
      compressedSize > 0
      && uncompressedSize / compressedSize > IMPORT_PACKAGE_LIMITS.MAX_COMPRESSION_RATIO
    ) {
      throw packageError('IMPORT_COMPRESSION_RATIO_INVALID', `ZIP 条目压缩比超过应用上限：${path}`)
    }
    if (localHeaderOffset >= centralDirectoryOffset) {
      throw packageError('IMPORT_LOCAL_OFFSET_INVALID', `ZIP 条目偏移无效：${path}`)
    }

    totalUncompressedBytes += uncompressedSize
    if (totalUncompressedBytes > IMPORT_PACKAGE_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw packageError('IMPORT_UNCOMPRESSED_TOTAL_TOO_LARGE', 'ZIP 解压后总大小超过 512MB 上限')
    }
    const duplicateKey = path.toLocaleLowerCase('en-US')
    if (seen.has(duplicateKey)) {
      throw packageError('IMPORT_DUPLICATE_PATH', `ZIP 含有重复路径：${path}`)
    }
    seen.add(duplicateKey)
    entries.push({
      path,
      compressionMethod,
      flags,
      crc32: entryCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      directory,
    })
    offset += recordLength
  }

  if (offset !== central.byteLength) {
    throw packageError('IMPORT_CENTRAL_DIRECTORY_LENGTH_MISMATCH', 'ZIP 中央目录长度不一致')
  }
  return entries
}

export function parseManifestCsv(text: string): ZipManifestRow[] {
  const parsed = parseCsvRows(text.replace(/^\uFEFF/, ''))
  const rows = parsed.filter(row => row.some(cell => cell.trim() !== ''))
  if (rows.length < 2) {
    throw packageError('IMPORT_MANIFEST_EMPTY', 'manifest.csv 至少需要表头和一行数据')
  }
  const headers = rows[0]!.map(header => header.trim())
  if (new Set(headers).size !== headers.length) {
    throw packageError('IMPORT_MANIFEST_DUPLICATE_HEADER', 'manifest.csv 含有重复列')
  }
  const missing = MANIFEST_HEADERS.filter(header => !headers.includes(header))
  const unknown = headers.filter(header => !MANIFEST_HEADERS.includes(header as typeof MANIFEST_HEADERS[number]))
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      missing.length ? `缺少：${missing.join(', ')}` : '',
      unknown.length ? `未知：${unknown.join(', ')}` : '',
    ].filter(Boolean).join('；')
    throw packageError('IMPORT_MANIFEST_HEADERS_INVALID', `manifest.csv 列定义不正确（${details}）`)
  }
  if (rows.length - 1 > IMPORT_PACKAGE_LIMITS.MAX_MANIFEST_ROWS) {
    throw packageError('IMPORT_MANIFEST_ROWS_EXCEEDED', `单个导入包最多 ${IMPORT_PACKAGE_LIMITS.MAX_MANIFEST_ROWS} 个图库`)
  }

  const folders = new Set<string>()
  const slugs = new Set<string>()
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length > headers.length) {
      throw packageError('IMPORT_MANIFEST_ROW_WIDTH_INVALID', `manifest.csv 第 ${rowIndex + 2} 行字段数量超过表头`)
    }
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = values[index]?.trim() ?? ''
    })
    const folder = record.folder ?? ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(folder)) {
      throw packageError('IMPORT_FOLDER_INVALID', `manifest.csv 第 ${rowIndex + 2} 行 folder 不合法`)
    }
    const folderKey = folder.toLocaleLowerCase('en-US')
    if (folders.has(folderKey)) {
      throw packageError('IMPORT_FOLDER_DUPLICATE', `manifest.csv folder 重复：${folder}`)
    }
    folders.add(folderKey)

    const slug = (record.slug ?? '').toLocaleLowerCase('en-US')
    if (slug && slugs.has(slug)) {
      throw packageError('IMPORT_SLUG_DUPLICATE', `manifest.csv slug 重复：${slug}`)
    }
    if (slug) slugs.add(slug)

    return {
      folder,
      title: record.title ?? '',
      slug,
      region: record.region ?? '',
      personality: record.personality ?? '',
      style: record.style ?? '',
      tags: (record.tags ?? '').split(',').map(tag => tag.trim()).filter(Boolean),
      requiredLevel: ((record.required_level || 'free').toLocaleLowerCase('en-US')) as ZipManifestRow['requiredLevel'],
      status: ((record.status || 'draft').toLocaleLowerCase('en-US')) as ZipManifestRow['status'],
    }
  })
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let quoteClosed = false

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"'
        index++
      }
      else if (quoted) {
        quoted = false
        quoteClosed = true
      }
      else if (cell.length === 0 && !quoteClosed) {
        quoted = true
      }
      else {
        throw packageError('IMPORT_MANIFEST_QUOTES_INVALID', 'manifest.csv 引号只能包裹完整字段')
      }
      continue
    }
    if (character === ',' && !quoted) {
      row.push(cell)
      cell = ''
      quoteClosed = false
      continue
    }
    if ((character === '\r' || character === '\n') && !quoted) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      quoteClosed = false
      if (character === '\r' && text[index + 1] === '\n') index++
      continue
    }
    if (quoteClosed) {
      throw packageError('IMPORT_MANIFEST_QUOTES_INVALID', 'manifest.csv 引号字段结束后只能换列或换行')
    }
    cell += character
  }
  if (quoted) {
    throw packageError('IMPORT_MANIFEST_QUOTES_INVALID', 'manifest.csv 存在未闭合的引号字段')
  }
  row.push(cell)
  rows.push(row)
  return rows
}

function validateManifestRow(row: ZipManifestRow): { code: string; message: string } | undefined {
  if (!row.title || row.title.length > 160 || hasControlCharacter(row.title)) {
    return { code: 'IMPORT_TITLE_INVALID', message: 'title 必须为 1-160 个可显示字符' }
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(row.slug) || row.slug.includes('--')) {
    return { code: 'IMPORT_SLUG_INVALID', message: 'slug 只能使用小写字母、数字和单个连字符' }
  }
  if (!['free', 'vip', 'svip'].includes(row.requiredLevel)) {
    return { code: 'IMPORT_REQUIRED_LEVEL_INVALID', message: 'required_level 仅支持 free、vip、svip' }
  }
  if (!['draft', 'published'].includes(row.status)) {
    return { code: 'IMPORT_STATUS_INVALID', message: 'status 仅支持 draft、published' }
  }
  for (const [label, value] of [
    ['region', row.region],
    ['personality', row.personality],
    ['style', row.style],
  ] as const) {
    if (value.length > 60 || hasControlCharacter(value)) {
      return { code: 'IMPORT_TAG_FIELD_INVALID', message: `${label} 不能超过 60 个可显示字符` }
    }
  }
  if (row.tags.length > 30 || row.tags.some(tag => tag.length > 60 || hasControlCharacter(tag))) {
    return { code: 'IMPORT_TAGS_INVALID', message: 'tags 最多 30 个，每个不超过 60 个可显示字符' }
  }
  return undefined
}

function isAllowedGalleryPath(relativePath: string): boolean {
  if (relativePath === 'content.md' || relativePath === 'cover.jpg') return true
  if (/^images\/[^/]+\.(?:jpe?g|png|webp)$/i.test(relativePath)) return true
  return relativePath === 'videos/preview.mp4' || relativePath === 'videos/full.mp4'
}

function isGalleryImagePath(path: string, folder: string): boolean {
  const prefix = `${folder}/images/`
  if (!path.startsWith(prefix)) return false
  const fileName = path.slice(prefix.length)
  if (!fileName || fileName.includes('/')) return false
  return SUPPORTED_IMAGE_EXTENSIONS.has(extensionOf(fileName))
}

function isIgnoredArchivePath(path: string): boolean {
  return path.startsWith('__MACOSX/')
    || path.endsWith('/.DS_Store')
    || path === '.DS_Store'
    || path.endsWith('/Thumbs.db')
    || path === 'Thumbs.db'
}

function isImageArchivePath(path: string): boolean {
  return /(?:^|\/)(?:cover\.jpg|[^/]+\.(?:jpe?g|png|webp))$/iu.test(path)
}

function isTextArchivePath(path: string): boolean {
  return path === 'manifest.csv' || path.endsWith('/content.md')
}

function validateArchivePath(path: string): void {
  if (
    !path
    || path.length > 240
    || path.startsWith('/')
    || path.includes('\\')
    || hasControlCharacter(path)
  ) {
    throw packageError('IMPORT_PATH_INVALID', 'ZIP 含有不安全或过长的路径')
  }
  const segments = path.split('/')
  const effectiveSegments = path.endsWith('/') ? segments.slice(0, -1) : segments
  if (
    effectiveSegments.length === 0
    || effectiveSegments.some(segment => !segment || segment === '.' || segment === '..' || segment.length > 100)
  ) {
    throw packageError('IMPORT_PATH_TRAVERSAL', `ZIP 路径不合法：${path}`)
  }
}

function decodeZipPath(bytes: Uint8Array, utf8Flag: boolean): string {
  if (!utf8Flag && bytes.some(byte => byte > 0x7f)) {
    throw packageError('IMPORT_FILENAME_ENCODING_UNSUPPORTED', 'ZIP 非 ASCII 文件名必须使用 UTF-8 编码')
  }
  const decoded = decodeUtf8(bytes, 'ZIP 文件名', 'package')
  return decoded.normalize('NFC')
}

function decodeUtf8(bytes: Uint8Array, label: string, scope: ZipImportErrorScope): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  }
  catch {
    throw new ZipImportError('IMPORT_UTF8_INVALID', `${label} 不是有效的 UTF-8 文本`, scope)
  }
}

async function readR2Range(
  r2: R2Bucket,
  key: string,
  offset: number,
  length: number,
  scope: ZipImportErrorScope,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new ZipImportError('IMPORT_RANGE_INVALID', 'ZIP 读取范围无效', scope)
  }
  if (length === 0) return new Uint8Array()
  try {
    const object = await r2.get(key, { range: { offset, length } })
    if (!object || !('body' in object) || !object.body) {
      throw new Error('range_missing')
    }
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (bytes.byteLength !== length) throw new Error('range_truncated')
    return bytes
  }
  catch (error) {
    if (error instanceof ZipImportError) throw error
    throw new ZipImportError('IMPORT_PACKAGE_READ_FAILED', '读取 ZIP 原包失败，请稍后重试', scope, true)
  }
}

async function readR2RangeBody(
  r2: R2Bucket,
  key: string,
  offset: number,
  length: number,
  scope: ZipImportErrorScope,
): Promise<ReadableStream<Uint8Array>> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) {
    throw new ZipImportError('IMPORT_RANGE_INVALID', 'ZIP 读取范围无效', scope)
  }
  try {
    const object = await r2.get(key, { range: { offset, length } })
    if (!object || !('body' in object) || !object.body) throw new Error('range_missing')
    return object.body
  }
  catch (error) {
    if (error instanceof ZipImportError) throw error
    throw new ZipImportError('IMPORT_PACKAGE_READ_FAILED', '读取 ZIP 原包失败，请稍后重试', scope, true)
  }
}

function findEndOfCentralDirectory(tail: Uint8Array): number {
  for (let offset = tail.byteLength - ZIP_EOCD_BYTES; offset >= 0; offset--) {
    const view = new DataView(tail.buffer, tail.byteOffset + offset, tail.byteLength - offset)
    if (view.getUint32(0, true) !== EOCD_SIGNATURE) continue
    const commentLength = view.getUint16(20, true)
    if (offset + ZIP_EOCD_BYTES + commentLength === tail.byteLength) return offset
  }
  return -1
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function assertImageContainer(
  bytes: Uint8Array,
  type: 'jpg' | 'png' | 'webp' | 'gif',
  path: string,
): void {
  if (type === 'jpg' && (bytes.byteLength < 4 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)) {
    throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', `JPEG 文件结束标记无效：${path}`)
  }
  if (type === 'png') {
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - 12))
    if (tail.byteLength !== 12 || ascii(tail, 4, 4) !== 'IEND') {
      throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', `PNG 文件结束块无效：${path}`)
    }
  }
  if (type === 'webp') {
    if (bytes.byteLength < 20 || readUint32LE(bytes, 4) + 8 !== bytes.byteLength) {
      throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', `WebP 容器长度无效：${path}`)
    }
  }
}

function imageDimensions(
  bytes: Uint8Array,
  type: 'jpg' | 'png' | 'webp' | 'gif',
): { width: number; height: number } | null {
  if (type === 'png' && bytes.byteLength >= 24 && ascii(bytes, 12, 4) === 'IHDR') {
    return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) }
  }
  if (type === 'gif' && bytes.byteLength >= 10) {
    return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) }
  }
  if (type === 'webp') return webpDimensions(bytes)
  if (type !== 'jpg') return null

  let offset = 2
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.byteLength) return null
    const length = readUint16BE(bytes, offset)
    if (length < 2 || offset + length > bytes.byteLength) return null
    if (isJpegStartOfFrame(marker) && length >= 7) {
      return {
        height: readUint16BE(bytes, offset + 3),
        width: readUint16BE(bytes, offset + 5),
      }
    }
    offset += length
  }
  return null
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X' && bytes.byteLength >= 30) {
    return {
      width: 1 + readUint24LE(bytes, 24),
      height: 1 + readUint24LE(bytes, 27),
    }
  }
  if (chunk === 'VP8 ' && bytes.byteLength >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: readUint16LE(bytes, 26) & 0x3fff,
      height: readUint16LE(bytes, 28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
      height: 1 + ((bytes[22]! >>> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)),
    }
  }
  return null
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]
  let offset = 2
  while (offset < bytes.byteLength) {
    const markerStart = offset
    if (bytes[offset] !== 0xff) throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'JPEG 段结构无效')
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined) throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'JPEG 段结构不完整')
    if (marker === 0xda) {
      parts.push(bytes.subarray(markerStart))
      return concatBytes(parts)
    }
    if (marker === 0xd9) {
      parts.push(bytes.subarray(markerStart, offset))
      return concatBytes(parts)
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(markerStart, offset))
      continue
    }
    if (offset + 2 > bytes.byteLength) throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'JPEG 段长度无效')
    const length = readUint16BE(bytes, offset)
    const segmentEnd = offset + length
    if (length < 2 || segmentEnd > bytes.byteLength) {
      throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'JPEG 段越界')
    }
    const remove = marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xee)
    if (!remove) parts.push(bytes.subarray(markerStart, segmentEnd))
    offset = segmentEnd
  }
  throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'JPEG 缺少图像数据')
}

function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const removed = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'iCCP'])
  const parts: Uint8Array[] = [bytes.subarray(0, 8)]
  let offset = 8
  let ended = false
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32BE(bytes, offset)
    const end = offset + 12 + length
    if (end > bytes.byteLength) throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'PNG 数据块越界')
    const type = ascii(bytes, offset + 4, 4)
    const storedCrc = readUint32BE(bytes, offset + 8 + length)
    const computedCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length))
    if (storedCrc !== computedCrc) throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'PNG 数据块校验失败')
    if (!removed.has(type)) parts.push(bytes.subarray(offset, end))
    offset = end
    if (type === 'IEND') {
      ended = true
      break
    }
  }
  if (!ended || offset !== bytes.byteLength) throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'PNG 数据块结构无效')
  return concatBytes(parts)
}

function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4)
    const length = readUint32LE(bytes, offset + 4)
    const paddedLength = length + (length % 2)
    const end = offset + 8 + paddedLength
    if (end > bytes.byteLength) throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'WebP 数据块越界')
    if (type !== 'EXIF' && type !== 'XMP ' && type !== 'ICCP') {
      const chunk = bytes.slice(offset, end)
      if (type === 'VP8X' && length >= 1) chunk[8] = chunk[8]! & ~0x2c
      chunks.push(chunk)
    }
    offset = end
  }
  if (offset !== bytes.byteLength || chunks.length === 0) {
    throw itemError('IMPORT_IMAGE_CONTAINER_INVALID', 'WebP 数据块结构无效')
  }
  const totalLength = 12 + chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(totalLength)
  output.set(bytes.subarray(0, 12), 0)
  writeUint32LE(output, 4, totalLength - 8)
  let cursor = 12
  for (const chunk of chunks) {
    output.set(chunk, cursor)
    cursor += chunk.byteLength
  }
  return output
}

function isJpegStartOfFrame(marker: number): boolean {
  return [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ].includes(marker)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000)
    + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8)
    + bytes[offset + 3]!
  ) >>> 0
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)
  ) >>> 0
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function extensionOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLocaleLowerCase('en-US')
}

function compareArchivePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasControlCharacter(value: string): boolean {
  return containsAsciiControlCharacter(value)
}

function packageError(code: string, message: string): ZipImportError {
  return new ZipImportError(code, message, 'package')
}

function itemError(code: string, message: string, retryable = false): ZipImportError {
  return new ZipImportError(code, message, 'item', retryable)
}
