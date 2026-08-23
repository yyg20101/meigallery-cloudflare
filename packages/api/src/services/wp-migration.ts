/**
 * WordPress 迁移执行服务
 * 编排 WP 文章拉取 → HTML 解析 → 标签映射 → 入库流程
 */

import type { WpPost, WpCategory, WpTag } from './wp-fetcher'
import { parseWpContent, type ParsedContent } from './wp-html-parser'
import {
  mapWpCategories,
  mapWpTags,
  type ExistingMappedTag,
  type MappedTag,
} from './wp-category-mapper'
import { generateId } from '../utils/db'
import { assertSafeExternalUrl, createSafeExternalUrl } from '../utils/external-url'

const MAX_LEGACY_MEDIA_PER_ITEM = 500
const MAX_LEGACY_TAGS_PER_ITEM = 100
const MAX_LEGACY_TITLE_CHARACTERS = 80
const MAX_LEGACY_BODY_CHARACTERS = 5_000
const MAX_LEGACY_SLUG_CHARACTERS = 120
const MAX_LEGACY_EXTERNAL_URL_CHARACTERS = 4_096
const MAX_LEGACY_SOURCE_SNAPSHOT_BYTES = 512 * 1024
const MAX_LEGACY_ERROR_CODE_CHARACTERS = 100
const MAX_LEGACY_ERROR_MESSAGE_CHARACTERS = 500
const MAX_FAILED_REVIEW_FLAGS = 100
const MAX_FAILED_REVIEW_FLAG_CHARACTERS = 240
// D1 当前每条语句最多 100 个绑定参数；每个媒体行使用 7 个参数。
const LEGACY_MEDIA_ROWS_PER_STATEMENT = 14
const LEGACY_MAPPING_QUERY_CHUNK = 90

export interface LegacyMappingOverrides {
  categories?: ReadonlyMap<number, ExistingMappedTag>
  tags?: ReadonlyMap<number, ExistingMappedTag>
}

export interface MigrationItem {
  wpPost: WpPost
  parsedContent: ParsedContent
  mappedTags: MappedTag[]
  reviewFlags: string[]
  galleryData: {
    id: string
    title: string
    slug: string
    summary: string
    bodyMd: string
    legacyUrl: string
    legacySlug: string
    status: 'draft'  // 迁移内容始终为 draft
    requiredLevelRank: number
  }
}

export interface MigrationResult {
  totalProcessed: number
  items: MigrationItem[]
  skippedDuplicates: number
}

export type MigrationWriteResult =
  | { success: true }
  | { success: false; errorCode: string; error: string }

export type MigrationWriteFailure = Extract<MigrationWriteResult, { success: false }>

class LegacyMigrationItemError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LegacyMigrationItemError'
  }
}

/**
 * 处理一批 WP 文章为 MigrationItem
 * 纯数据转换，不涉及数据库操作
 */
export function processPosts(
  posts: WpPost[],
  categories: WpCategory[],
  tags: WpTag[],
  existingSlugs: Set<string>,
  existingLegacyPostIds: Set<number> = new Set(),
  mappingOverrides: LegacyMappingOverrides = {},
): MigrationResult {
  const items: MigrationItem[] = []
  let skippedDuplicates = 0

  for (const post of posts) {
    if (existingLegacyPostIds.has(post.id)) {
      skippedDuplicates++
      continue
    }

    // 生成 slug（解码 URL 编码的中文 slug）
    const decodedSlug = safeDecodeURIComponent(post.slug).toLowerCase()
    const baseSlug = decodedSlug
      .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || `legacy-post-${post.id}`
    const cleanSlug = normalizeLegacySlug(baseSlug, post.id)

    // 检查 slug 重复
    if (existingSlugs.has(cleanSlug)) {
      skippedDuplicates++
      continue
    }
    existingSlugs.add(cleanSlug)
    existingLegacyPostIds.add(post.id)

    // 超过私有快照上限的原 HTML 不进入正则解析，避免恶意大正文放大 Worker CPU；
    // 仍构造失败候选，让后续写入层形成可追溯的结构化失败条目。
    const rawHtmlTooLarge = encodedByteLength(post.content.rendered) > MAX_LEGACY_SOURCE_SNAPSHOT_BYTES
    const parsedContent: ParsedContent = rawHtmlTooLarge
      ? {
          media: [],
          textContent: '',
          markdown: '',
          rawHtml: post.content.rendered,
        }
      : parseWpContent(post.content.rendered)

    // 映射分类
    const categoryResult = mapWpCategories(categories, post.categories, mappingOverrides.categories)
    const tagResult = mapWpTags(tags, post.tags, mappingOverrides.tags)

    const allFlags = [...categoryResult.reviewFlags, ...tagResult.reviewFlags]
    if (rawHtmlTooLarge) {
      allFlags.push('原始 HTML 超过 512 KiB，未进入正文解析，需人工拆分或转存私有制品')
    }
    const allTags = deduplicateMappedTags(
      [...categoryResult.tags, ...tagResult.tags],
      allFlags,
    )

    // 正文内容风险检查
    const contentFlags = checkContentRisk(post.title.rendered, parsedContent.textContent)
    allFlags.push(...contentFlags)

    // 清洗标题（去掉 emoji 和多余空格）
    const normalizedTitle = post.title.rendered
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `未命名旧站内容 #${post.id}`
    if ([...normalizedTitle].length > MAX_LEGACY_TITLE_CHARACTERS) {
      allFlags.push(`标题超过 ${MAX_LEGACY_TITLE_CHARACTERS} 字，迁移时已截断`)
    }
    if ([...parsedContent.textContent].length > MAX_LEGACY_BODY_CHARACTERS) {
      allFlags.push(`正文超过 ${MAX_LEGACY_BODY_CHARACTERS} 字，迁移时已截断`)
    }
    const cleanTitle = truncateCharacters(normalizedTitle, MAX_LEGACY_TITLE_CHARACTERS)
    const cleanBody = truncateCharacters(parsedContent.textContent, MAX_LEGACY_BODY_CHARACTERS)

    items.push({
      wpPost: post,
      parsedContent,
      mappedTags: allTags,
      reviewFlags: allFlags,
      galleryData: {
        id: generateId('gal'),
        title: cleanTitle,
        slug: cleanSlug,
        summary: truncateCharacters(parsedContent.textContent, 160),
        // 远程媒体必须经 media_assets → R2/Stream 流程，正文不保留可绕过访问控制的源站嵌入。
        bodyMd: cleanBody,
        legacyUrl: post.link,
        legacySlug: post.slug,
        status: 'draft',
        requiredLevelRank: 0, // 默认免费，后续人工设置
      },
    })
  }

  return { totalProcessed: posts.length, items, skippedDuplicates }
}

/**
 * 正文内容风险检查
 */
function checkContentRisk(title: string, text: string): string[] {
  const flags: string[] = []
  const combined = `${title} ${text}`.toLowerCase()

  const riskKeywords = ['联系方式', '微信', 'wechat', '约', '上门', '服务']
  for (const keyword of riskKeywords) {
    if (combined.includes(keyword)) {
      flags.push(`正文包含风险关键词: "${keyword}"`)
    }
  }

  return flags
}

/**
 * 将 MigrationItem 写入数据库
 * 包括：galleries、tags、gallery_tags、media_assets、legacy_import_items、legacy_url_redirects
 */
export async function writeMigrationItem(
  db: D1Database,
  item: MigrationItem,
  sourceId: string,
  jobId: string,
  adminId: number,
): Promise<MigrationWriteResult> {
  try {
    const g = item.galleryData
    if (item.mappedTags.length > MAX_LEGACY_TAGS_PER_ITEM) {
      throw new LegacyMigrationItemError(
        'LEGACY_ITEM_TAG_LIMIT_EXCEEDED',
        `单篇内容标签超过 ${MAX_LEGACY_TAGS_PER_ITEM} 个，需人工拆分`,
      )
    }
    if (item.parsedContent.media.length > MAX_LEGACY_MEDIA_PER_ITEM) {
      throw new LegacyMigrationItemError(
        'LEGACY_ITEM_MEDIA_LIMIT_EXCEEDED',
        `单篇内容媒体超过 ${MAX_LEGACY_MEDIA_PER_ITEM} 个，需人工拆分`,
      )
    }
    let safeLegacyUrl: string
    let safeMedia: ParsedContent['media']
    try {
      safeLegacyUrl = assertLegacyExternalUrl(item.wpPost.link)
      safeMedia = item.parsedContent.media.map(media => ({
        ...media,
        url: assertLegacyExternalUrl(media.url),
      }))
    } catch (error) {
      throw new LegacyMigrationItemError(
        'LEGACY_ITEM_EXTERNAL_URL_INVALID',
        error instanceof Error ? error.message : '旧站外部地址不安全',
      )
    }
    const oldPath = new URL(safeLegacyUrl).pathname.replace(/\/$/, '')
    const sourceSnapshotJson = JSON.stringify({
      schemaVersion: 1,
      postId: item.wpPost.id,
      postDate: item.wpPost.date,
      legacyUrl: safeLegacyUrl,
      legacySlug: item.wpPost.slug,
      categoryIds: item.wpPost.categories,
      tagIds: item.wpPost.tags,
      media: safeMedia,
      mappedTags: item.mappedTags.map(tag => ({
        wpSource: tag.wpSource,
        wpId: tag.wpId,
        targetId: tag.existingId ?? null,
        type: tag.type,
        name: tag.name,
        slug: tag.slug,
      })),
      rawHtml: item.parsedContent.rawHtml,
    })
    if (new TextEncoder().encode(sourceSnapshotJson).byteLength > MAX_LEGACY_SOURCE_SNAPSHOT_BYTES) {
      throw new LegacyMigrationItemError(
        'LEGACY_ITEM_SOURCE_SNAPSHOT_TOO_LARGE',
        '单篇旧站来源快照超过 512 KiB，需人工拆分或转存私有制品',
      )
    }
    const statements: D1PreparedStatement[] = [
      db.prepare(`
        INSERT INTO galleries (id, title, slug, summary, body_md, status, required_level_rank, legacy_url, legacy_slug)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        g.id,
        g.title,
        g.slug,
        g.summary,
        g.bodyMd,
        g.status,
        g.requiredLevelRank,
        safeLegacyUrl,
        g.legacySlug,
      ),
    ]

    // 标签通过 slug 子查询绑定最终权威行；并发 INSERT OR IGNORE 不会留下错误 tagId 外键。
    for (const tag of item.mappedTags) {
      if (tag.existingId) {
        statements.push(
          db.prepare('INSERT INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)')
            .bind(g.id, tag.existingId),
        )
        continue
      }
      const tagId = generateId('tag')
      statements.push(
        db.prepare('INSERT OR IGNORE INTO tags (id, type, name, slug) VALUES (?, ?, ?, ?)')
          .bind(tagId, tag.type, tag.name, tag.slug),
        db.prepare(`
          INSERT INTO admin_audit_logs (
            id, admin_id, action, target_type, target_id, before_value, after_value
          )
          SELECT ?, ?, 'create_legacy_import_tag', 'tag', ?, NULL, ?
          WHERE changes() = 1
        `).bind(
          generateId('log'),
          adminId,
          tagId,
          JSON.stringify({ type: tag.type, name: tag.name, slug: tag.slug, jobId }),
        ),
        db.prepare(`
          INSERT INTO gallery_tags (gallery_id, tag_id)
          VALUES (?, (
            SELECT id FROM tags
            WHERE slug = ? AND type = ? AND name = ? COLLATE NOCASE
            LIMIT 1
          ))
        `).bind(g.id, tag.slug, tag.type, tag.name),
      )
    }

    // 媒体只冻结安全拉取所需的公开源 URL；单条多值 INSERT 避免大图库放大 batch 语句数。
    for (
      let start = 0;
      start < safeMedia.length;
      start += LEGACY_MEDIA_ROWS_PER_STATEMENT
    ) {
      const mediaChunk = safeMedia.slice(
        start,
        start + LEGACY_MEDIA_ROWS_PER_STATEMENT,
      )
      const mediaBindings: unknown[] = []
      const mediaValues = mediaChunk.map((media, index) => {
        mediaBindings.push(
          generateId('med'),
          g.id,
          media.type,
          media.type === 'image' ? 'r2' : 'stream',
          media.type === 'image' ? 'gallery_image' : 'preview_video',
          media.url,
          start + index + 1,
        )
        return "(?, ?, ?, ?, ?, ?, ?, 'pending')"
      })
      statements.push(db.prepare(`
        INSERT INTO media_assets (
          id, gallery_id, type, storage, role, r2_key, sort_order, upload_status
        ) VALUES ${mediaValues.join(', ')}
      `).bind(...mediaBindings))
    }

    const itemId = generateId('lii')
    statements.push(db.prepare(`
        INSERT INTO legacy_import_items (
          id, source_id, job_id, legacy_post_id, legacy_url, legacy_title,
          gallery_id, status, review_status, review_flags, source_snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', 'pending', ?, ?)
      `).bind(
        itemId, sourceId, jobId,
        item.wpPost.id, safeLegacyUrl, item.galleryData.title,
        g.id,
        item.reviewFlags.length > 0 ? JSON.stringify(item.reviewFlags) : null,
        sourceSnapshotJson,
      ))

    if (oldPath) {
      statements.push(
        db.prepare('INSERT OR IGNORE INTO legacy_url_redirects (old_path, new_path) VALUES (?, ?)')
          .bind(oldPath, `/gallery/${g.slug}`),
      )
    }

    // 每篇成功事实与最小审计同批提交；失败会整体回滚，不留下半成品 Gallery。
    statements.push(db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value
      ) VALUES (?, ?, 'import_legacy_gallery_item', 'import_job', ?, NULL, ?)
    `).bind(
      generateId('log'),
      adminId,
      jobId,
      JSON.stringify({
        sourceId,
        legacyPostId: item.wpPost.id,
        galleryId: g.id,
        tagCount: item.mappedTags.length,
        explicitTagCount: item.mappedTags.filter(tag => tag.existingId).length,
        mediaCount: item.parsedContent.media.length,
        reviewFlagCount: item.reviewFlags.length,
      }),
    ))

    await db.batch(statements)

    return { success: true }
  } catch (err: unknown) {
    if (err instanceof LegacyMigrationItemError) {
      return { success: false, errorCode: err.code, error: err.message }
    }
    return {
      success: false,
      errorCode: 'LEGACY_ITEM_WRITE_FAILED',
      error: '单篇迁移写入失败，请检查该任务的失败条目和审计事件',
    }
  }
}

/**
 * 冻结单篇写入失败事实。
 *
 * 成功写入的跨表事务已经完整回滚后，失败条目与审计必须再次以一个独立 batch
 * 提交。若这个 batch 也失败，调用方必须中止整个任务，不能只在 HTTP 响应里留下
 * 无法追溯的错误文字。
 */
export async function writeFailedMigrationItem(
  db: D1Database,
  item: MigrationItem,
  sourceId: string,
  jobId: string,
  adminId: number,
  sourceBaseUrl: string,
  failure: MigrationWriteFailure,
): Promise<void> {
  const itemId = generateId('lii')
  const legacyUrl = resolveFailureLegacyUrl(item.wpPost.link, sourceBaseUrl, item.wpPost.id)
  const errorCode = normalizeFailureText(
    failure.errorCode,
    MAX_LEGACY_ERROR_CODE_CHARACTERS,
    'LEGACY_ITEM_WRITE_FAILED',
  )
  const errorMessage = normalizeFailureText(
    failure.error,
    MAX_LEGACY_ERROR_MESSAGE_CHARACTERS,
    '单篇迁移写入失败，请检查该任务的失败条目和审计事件',
  )
  const sourceSnapshotJson = buildFailureSourceSnapshot(item, legacyUrl)
  const reviewFlags = serializeFailureReviewFlags(item.reviewFlags)

  await db.batch([
    db.prepare(`
      INSERT INTO legacy_import_items (
        id, source_id, job_id, legacy_post_id, legacy_url, legacy_title,
        gallery_id, status, review_status, review_flags, source_snapshot_json,
        error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'failed', 'pending', ?, ?, ?, ?)
    `).bind(
      itemId,
      sourceId,
      jobId,
      item.wpPost.id,
      legacyUrl,
      item.galleryData.title,
      reviewFlags,
      sourceSnapshotJson,
      errorCode,
      errorMessage,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value
      ) VALUES (?, ?, 'import_legacy_gallery_item_failed', 'legacy_import_item', ?, NULL, ?)
    `).bind(
      generateId('log'),
      adminId,
      itemId,
      JSON.stringify({
        sourceId,
        jobId,
        legacyPostId: item.wpPost.id,
        errorCode,
        tagCount: item.mappedTags.length,
        mediaCount: item.parsedContent.media.length,
        reviewFlagCount: item.reviewFlags.length,
      }),
    ),
  ])
}

export async function loadLegacyMappingOverrides(
  db: D1Database,
  categoryMappingJson: string | null,
  tagMappingJson: string | null,
): Promise<LegacyMappingOverrides> {
  const categoryMapping = parseLegacyMappingJson(categoryMappingJson, '分类映射')
  const tagMapping = parseLegacyMappingJson(tagMappingJson, '标签映射')
  const targetIds = [...new Set([...categoryMapping.values(), ...tagMapping.values()])]
  const targetById = new Map<string, ExistingMappedTag>()

  for (let start = 0; start < targetIds.length; start += LEGACY_MAPPING_QUERY_CHUNK) {
    const chunk = targetIds.slice(start, start + LEGACY_MAPPING_QUERY_CHUNK)
    const rows = await db.prepare(`
      SELECT id, type, name, slug
      FROM tags
      WHERE id IN (${chunk.map(() => '?').join(', ')})
    `).bind(...chunk).all<ExistingMappedTag>()
    for (const row of rows.results) targetById.set(row.id, row)
  }

  if (targetById.size !== targetIds.length) {
    throw new Error('来源映射引用了不存在的标签，请先修复映射')
  }

  return {
    categories: resolveMappingTargets(categoryMapping, targetById),
    tags: resolveMappingTargets(tagMapping, targetById),
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeLegacySlug(slug: string, postId: number): string {
  if ([...slug].length <= MAX_LEGACY_SLUG_CHARACTERS) return slug
  const suffix = `-${postId}`
  const prefix = truncateCharacters(slug, MAX_LEGACY_SLUG_CHARACTERS - suffix.length)
    .replace(/-+$/, '')
  return `${prefix}${suffix}`
}

function truncateCharacters(value: string, maxCharacters: number): string {
  return [...value].slice(0, maxCharacters).join('')
}

function resolveFailureLegacyUrl(postUrl: string, sourceBaseUrl: string, postId: number): string {
  try {
    return assertLegacyExternalUrl(postUrl)
  } catch {
    return assertLegacyExternalUrl(
      createSafeExternalUrl(sourceBaseUrl, `/wp-json/wp/v2/posts/${postId}`),
    )
  }
}

function buildFailureSourceSnapshot(item: MigrationItem, legacyUrl: string): string {
  const safeMedia = item.parsedContent.media.map(media => {
    try {
      return { ...media, url: assertLegacyExternalUrl(media.url), urlAccepted: true }
    } catch {
      return {
        type: media.type,
        width: media.width,
        height: media.height,
        alt: media.alt,
        urlAccepted: false,
      }
    }
  })
  const fullSnapshot = JSON.stringify({
    schemaVersion: 1,
    writeStatus: 'failed',
    postId: item.wpPost.id,
    postDate: item.wpPost.date,
    legacyUrl,
    legacySlug: item.wpPost.slug,
    categoryIds: item.wpPost.categories,
    tagIds: item.wpPost.tags,
    media: safeMedia,
    mappedTags: item.mappedTags.map(tag => ({
      wpSource: tag.wpSource,
      wpId: tag.wpId,
      targetId: tag.existingId ?? null,
      type: tag.type,
      name: tag.name,
      slug: tag.slug,
    })),
    rawHtml: item.parsedContent.rawHtml,
  })
  const fullSnapshotBytes = encodedByteLength(fullSnapshot)
  if (fullSnapshotBytes <= MAX_LEGACY_SOURCE_SNAPSHOT_BYTES) return fullSnapshot

  // 超限失败仍需保留可追溯的最小事实；原 HTML 不做静默截断，明确记录被省略及原始字节数。
  return JSON.stringify({
    schemaVersion: 1,
    writeStatus: 'failed',
    postId: item.wpPost.id,
    postDate: truncateCharacters(item.wpPost.date, 64),
    legacyUrl,
    legacySlug: truncateCharacters(item.wpPost.slug, MAX_LEGACY_SLUG_CHARACTERS),
    categoryCount: item.wpPost.categories.length,
    tagCount: item.wpPost.tags.length,
    mediaCount: item.parsedContent.media.length,
    mappedTagCount: item.mappedTags.length,
    rawHtml: {
      omitted: true,
      byteLength: encodedByteLength(item.parsedContent.rawHtml),
    },
    fullSnapshotByteLength: fullSnapshotBytes,
  })
}

function serializeFailureReviewFlags(reviewFlags: string[]): string | null {
  if (reviewFlags.length === 0) return null
  const storedFlags = reviewFlags
    .slice(0, MAX_FAILED_REVIEW_FLAGS)
    .map(flag => truncateCharacters(flag, MAX_FAILED_REVIEW_FLAG_CHARACTERS))
  if (reviewFlags.length > MAX_FAILED_REVIEW_FLAGS) {
    storedFlags.push(`另有 ${reviewFlags.length - MAX_FAILED_REVIEW_FLAGS} 条复核标记未展开`)
  }
  return JSON.stringify(storedFlags)
}

function normalizeFailureText(value: string, maxCharacters: number, fallback: string): string {
  const normalized = value.trim() || fallback
  return truncateCharacters(normalized, maxCharacters)
}

function assertLegacyExternalUrl(value: string): string {
  const safeUrl = assertSafeExternalUrl(value)
  if ([...safeUrl].length > MAX_LEGACY_EXTERNAL_URL_CHARACTERS) {
    throw new Error(`旧站外部地址不能超过 ${MAX_LEGACY_EXTERNAL_URL_CHARACTERS} 字`)
  }
  return safeUrl
}

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function deduplicateMappedTags(tags: MappedTag[], reviewFlags: string[]): MappedTag[] {
  const unique = new Map<string, MappedTag>()
  for (const tag of tags) {
    const existing = unique.get(tag.slug)
    if (!existing) {
      unique.set(tag.slug, tag)
      continue
    }
    if (
      existing.type !== tag.type
      || existing.name !== tag.name
      || existing.existingId !== tag.existingId
    ) {
      reviewFlags.push(`标签 slug“${tag.slug}”映射冲突，已保留“${existing.name}”`)
    }
  }
  return [...unique.values()]
}

function parseLegacyMappingJson(value: string | null, label: string): Map<number, string> {
  if (!value) return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error(`${label}不是有效 JSON`)
  }
  if (!isRecord(parsed)) throw new Error(`${label}必须是对象`)
  const entries = Object.entries(parsed)
  if (entries.length > 500) throw new Error(`${label}不能超过 500 项`)
  const result = new Map<number, string>()
  for (const [wpId, targetId] of entries) {
    if (!/^[1-9]\d*$/.test(wpId) || typeof targetId !== 'string' || !targetId.trim()) {
      throw new Error(`${label}必须使用正整数 WordPress ID 映射到标签 ID`)
    }
    result.set(Number(wpId), targetId.trim())
  }
  return result
}

function resolveMappingTargets(
  mapping: ReadonlyMap<number, string>,
  targets: ReadonlyMap<string, ExistingMappedTag>,
): ReadonlyMap<number, ExistingMappedTag> {
  const resolved = new Map<number, ExistingMappedTag>()
  for (const [wpId, targetId] of mapping) {
    const target = targets.get(targetId)
    if (target) resolved.set(wpId, target)
  }
  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
