import type { ImportPermission } from './import-token'
import { ImportError } from './import-errors'

export type TelegramImportType = 'gallery' | 'case'
export type AllowedImportMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

export type TelegramImportPayload = {
  metadata: {
    type: TelegramImportType
    source: 'telegram'
    externalMessageId: string
    title: string
    slug: string
    summary?: string
    bodyMd?: string
    requiredLevelRank?: 0 | 10 | 20
    tags?: string[]
    featured?: boolean
    sortOrder?: number
    seoTitle?: string
    seoDescription?: string
  }
  telegram: {
    sourceBotKey: string
    sourceChatId: string
    sourceMessageId: string
    mediaGroupId?: string
  }
  files: Array<{
    fileId: string
    fileUniqueId?: string
    filename?: string
    mimeType: AllowedImportMimeType
    sortOrder: number
    isCover?: boolean
  }>
}

const ALLOWED_MIME_TYPES: readonly AllowedImportMimeType[] = ['image/jpeg', 'image/png', 'image/webp']

type UnknownRecord = Record<string, unknown>

function fail(message: string): never {
  throw new ImportError('IMPORT_VALIDATION_FAILED', message, 400)
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') fail(`${label}为必填字符串`)
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > maxLength) {
    fail(`${label}长度必须为 1-${maxLength} 字符`)
  }
  return normalized
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') fail(`${label}必须是字符串`)
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > maxLength) {
    fail(`${label}长度必须为 1-${maxLength} 字符`)
  }
  return normalized
}

export function validateTelegramImportPayload(input: unknown): TelegramImportPayload {
  if (!isRecord(input)) fail('请求 body 必须是 JSON 对象')
  if (!isRecord(input.metadata)) fail('metadata 为必填对象')
  if (!isRecord(input.telegram)) fail('telegram 为必填对象')
  if (!Array.isArray(input.files)) fail('files 为必填数组')

  const metadataInput = input.metadata
  const type = metadataInput.type
  if (type !== 'gallery' && type !== 'case') fail('metadata.type 必须是 gallery 或 case')
  if (metadataInput.source !== 'telegram') fail('metadata.source 必须是 telegram')
  const externalMessageId = requiredString(metadataInput.externalMessageId, 'externalMessageId', 160)
  const title = requiredString(metadataInput.title, '标题', 80)
  if (typeof metadataInput.slug !== 'string' || !/^[a-z0-9-]{3,120}$/.test(metadataInput.slug.trim())) {
    fail('slug 只能包含小写字母、数字和短横线，长度 3-120 字符')
  }
  const slug = metadataInput.slug.trim()
  const summary = optionalString(metadataInput.summary, '摘要', 160)
  const bodyMd = optionalString(metadataInput.bodyMd, '正文', 5000)
  const requiredLevelRank = metadataInput.requiredLevelRank ?? 0
  if (requiredLevelRank !== 0 && requiredLevelRank !== 10 && requiredLevelRank !== 20) {
    fail('requiredLevelRank 只能是 0、10 或 20')
  }

  let tags: string[] | undefined
  if (metadataInput.tags !== undefined) {
    if (!Array.isArray(metadataInput.tags) || metadataInput.tags.length > 30) {
      fail('tags 最多 30 个，每个标签 1-30 字')
    }
    const seenTags = new Set<string>()
    tags = []
    for (const tag of metadataInput.tags) {
      if (typeof tag !== 'string') fail('tags 最多 30 个，每个标签 1-30 字')
      const normalized = tag.normalize('NFKC').trim().replace(/\s+/gu, ' ')
      if (normalized.length < 1 || normalized.length > 30) fail('tags 最多 30 个，每个标签 1-30 字')
      const identity = normalized.toLocaleLowerCase('zh-CN')
      if (seenTags.has(identity)) continue
      seenTags.add(identity)
      tags.push(normalized)
    }
  }

  if (metadataInput.featured !== undefined && typeof metadataInput.featured !== 'boolean') {
    fail('featured 必须是布尔值')
  }
  if (
    metadataInput.sortOrder !== undefined
    && (!Number.isSafeInteger(metadataInput.sortOrder) || Number(metadataInput.sortOrder) < 0 || Number(metadataInput.sortOrder) > 1_000_000)
  ) {
    fail('sortOrder 必须是 0-1000000 的整数')
  }
  const seoTitle = optionalString(metadataInput.seoTitle, 'seoTitle', 120)
  const seoDescription = optionalString(metadataInput.seoDescription, 'seoDescription', 300)

  const telegramInput = input.telegram
  if (typeof telegramInput.sourceBotKey !== 'string' || !/^[a-z0-9_]{3,64}$/.test(telegramInput.sourceBotKey)) {
    fail('sourceBotKey 只能包含小写字母、数字和下划线，长度 3-64 字符')
  }
  const sourceBotKey = telegramInput.sourceBotKey
  const sourceChatId = requiredString(telegramInput.sourceChatId, 'sourceChatId', 128)
  const sourceMessageId = requiredString(telegramInput.sourceMessageId, 'sourceMessageId', 128)
  const mediaGroupId = optionalString(telegramInput.mediaGroupId, 'mediaGroupId', 128)

  if (type === 'gallery' && (input.files.length < 1 || input.files.length > 30)) fail('图库导入需要 1-30 张图片')
  if (type === 'case' && (input.files.length < 2 || input.files.length > 9)) fail('案例导入需要 2-9 张图片')

  const files: TelegramImportPayload['files'] = []
  const sortOrders = new Set<number>()
  let coverCount = 0
  for (const fileInput of input.files) {
    if (!isRecord(fileInput)) fail('files[] 每项必须是对象')
    const fileId = requiredString(fileInput.fileId, 'files[].fileId', 512)
    const fileUniqueId = optionalString(fileInput.fileUniqueId, 'files[].fileUniqueId', 256)
    const filename = optionalString(fileInput.filename, 'files[].filename', 255)
    if (!ALLOWED_MIME_TYPES.includes(fileInput.mimeType as AllowedImportMimeType)) fail('仅支持 JPEG、PNG、WebP 图片')
    if (!Number.isSafeInteger(fileInput.sortOrder) || Number(fileInput.sortOrder) < 0 || Number(fileInput.sortOrder) > 999) {
      fail('sortOrder 必须是 0-999 的整数')
    }
    const sortOrder = Number(fileInput.sortOrder)
    if (sortOrders.has(sortOrder)) fail('文件 sortOrder 不能重复')
    sortOrders.add(sortOrder)
    if (fileInput.isCover !== undefined && typeof fileInput.isCover !== 'boolean') fail('isCover 必须是布尔值')
    if (fileInput.isCover === true) coverCount += 1
    files.push({
      fileId,
      ...(fileUniqueId ? { fileUniqueId } : {}),
      ...(filename ? { filename } : {}),
      mimeType: fileInput.mimeType as AllowedImportMimeType,
      sortOrder,
      ...(fileInput.isCover !== undefined ? { isCover: fileInput.isCover } : {}),
    })
  }
  if (coverCount > 1) fail('最多只能指定一张封面图片')

  return {
    metadata: {
      type,
      source: 'telegram',
      externalMessageId,
      title,
      slug,
      ...(summary ? { summary } : {}),
      ...(bodyMd ? { bodyMd } : {}),
      requiredLevelRank,
      ...(tags ? { tags } : {}),
      ...(metadataInput.featured !== undefined ? { featured: metadataInput.featured } : {}),
      ...(metadataInput.sortOrder !== undefined ? { sortOrder: Number(metadataInput.sortOrder) } : {}),
      ...(seoTitle ? { seoTitle } : {}),
      ...(seoDescription ? { seoDescription } : {}),
    },
    telegram: {
      sourceBotKey,
      sourceChatId,
      sourceMessageId,
      ...(mediaGroupId ? { mediaGroupId } : {}),
    },
    files: files.sort((a, b) => a.sortOrder - b.sortOrder),
  }
}

export function importPermissionForType(type: TelegramImportType): ImportPermission {
  return type === 'gallery' ? 'gallery:create' : 'case:create'
}
