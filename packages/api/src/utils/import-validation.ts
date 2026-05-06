import type { ImportPermission } from './import-token'
import { ImportError } from './import-errors'

export type TelegramImportType = 'gallery' | 'testimonial_case'
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

function fail(message: string): never {
  throw new ImportError('IMPORT_VALIDATION_FAILED', message, 400)
}

export function validateTelegramImportPayload(input: unknown): TelegramImportPayload {
  const body = input as TelegramImportPayload
  if (!body || typeof body !== 'object') fail('请求 body 必须是 JSON 对象')
  if (!body.metadata || typeof body.metadata !== 'object') fail('metadata 为必填对象')
  if (!body.telegram || typeof body.telegram !== 'object') fail('telegram 为必填对象')
  if (!Array.isArray(body.files)) fail('files 为必填数组')

  const metadata = body.metadata
  if (!['gallery', 'testimonial_case'].includes(metadata.type)) fail('metadata.type 必须是 gallery 或 testimonial_case')
  if (metadata.source !== 'telegram') fail('metadata.source 必须是 telegram')
  if (!metadata.externalMessageId || metadata.externalMessageId.length > 160) fail('externalMessageId 为必填且不能超过 160 字符')
  if (!metadata.title || metadata.title.trim().length > 80) fail('标题为必填且不能超过 80 字')
  if (!metadata.slug || !/^[a-z0-9-]{3,120}$/.test(metadata.slug.trim())) fail('slug 只能包含小写字母、数字和短横线，长度 3-120 字符')
  if (metadata.summary && metadata.summary.length > 160) fail('摘要不能超过 160 字')
  if (metadata.bodyMd && metadata.bodyMd.length > 5000) fail('正文不能超过 5000 字')
  if (metadata.requiredLevelRank !== undefined && ![0, 10, 20].includes(metadata.requiredLevelRank)) fail('requiredLevelRank 只能是 0、10 或 20')
  if (metadata.tags && (metadata.tags.length > 30 || metadata.tags.some(tag => typeof tag !== 'string' || tag.trim().length < 1 || tag.trim().length > 30))) fail('tags 最多 30 个，每个标签 1-30 字')

  const telegram = body.telegram
  if (!telegram.sourceBotKey || !/^[a-z0-9_]{3,64}$/.test(telegram.sourceBotKey)) fail('sourceBotKey 只能包含小写字母、数字和下划线，长度 3-64 字符')
  if (!telegram.sourceChatId) fail('sourceChatId 为必填')
  if (!telegram.sourceMessageId) fail('sourceMessageId 为必填')

  if (metadata.type === 'gallery' && (body.files.length < 1 || body.files.length > 30)) fail('图库导入需要 1-30 张图片')
  if (metadata.type === 'testimonial_case' && (body.files.length < 2 || body.files.length > 9)) fail('真实案例导入需要 2-9 张图片')

  const sortOrders = new Set<number>()
  for (const file of body.files) {
    if (!file.fileId) fail('files[].fileId 为必填')
    if (!ALLOWED_MIME_TYPES.includes(file.mimeType)) fail('仅支持 JPEG、PNG、WebP 图片')
    if (!Number.isInteger(file.sortOrder) || file.sortOrder < 0 || file.sortOrder > 999) fail('sortOrder 必须是 0-999 的整数')
    if (sortOrders.has(file.sortOrder)) fail('文件 sortOrder 不能重复')
    sortOrders.add(file.sortOrder)
  }

  return {
    ...body,
    metadata: {
      ...metadata,
      title: metadata.title.trim(),
      slug: metadata.slug.trim(),
      summary: metadata.summary?.trim(),
      bodyMd: metadata.bodyMd?.trim(),
      requiredLevelRank: metadata.requiredLevelRank ?? 0,
      tags: metadata.tags?.map(tag => tag.trim()).filter(Boolean),
    },
    files: [...body.files].sort((a, b) => a.sortOrder - b.sortOrder),
  }
}

export function importPermissionForType(type: TelegramImportType): ImportPermission {
  return type === 'gallery' ? 'gallery:create' : 'testimonial:create'
}
