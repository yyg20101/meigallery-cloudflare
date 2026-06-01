import { PAGINATION } from '@meigallery/shared/constants'
import { generateId } from '../utils/db'
import { isExternalMediaKey } from '../utils/cover-url'
import { getAdminGalleryOrderClause } from '../utils/gallery-interactions'
import { isExpectedGalleryMediaKey } from '../utils/media-keys'
import { writeAuditLog } from '../utils/permission'

export type AdminGalleryBatchAction = 'publish' | 'unpublish' | 'delete' | 'set_level' | 'add_tags' | 'remove_tags'

export interface AdminGalleryBatchRequest {
  action: AdminGalleryBatchAction
  galleryIds?: string[]
  selectAll?: boolean
  filter?: {
    status?: string
    tag?: string
    search?: string
  }
  params?: {
    requiredLevelRank?: number
    tagIds?: string[]
  }
}

export interface AdminGalleryBatchResult {
  affected: number
  success: number
  failed: number
  errors: Array<{ galleryId: string; error: string }>
}

export interface AdminGalleryListParams {
  page?: string | null
  pageSize?: string | null
  status?: string | null
  search?: string | null
  tag?: string | null
  sort?: string | null
}

export interface AdminGalleryListItem {
  id: string
  title: string
  slug: string
  status: string
  required_level_rank: number
  cover_key: string | null
  published_at: string | null
  created_at: string
  updated_at: string
  view_count: number
  like_count: number
}

export interface AdminGalleryListResult {
  data: AdminGalleryListItem[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

export interface AdminGalleryDetail {
  id: string
  title: string
  slug: string
  summary: string | null
  bodyMd: string | null
  coverKey: string | null
  status: string
  requiredLevelRank: number
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  viewCount: number
  tags: Array<{ id: string; name: string; type: string }>
}

export interface AdminGalleryCreateInput {
  title: string
  slug: string
  summary?: string
  bodyMd?: string
  requiredLevelRank?: number
  tagIds?: string[]
  status?: string
}

export interface AdminGalleryUpdateInput {
  title?: string
  slug?: string
  summary?: string
  bodyMd?: string
  requiredLevelRank?: number
  tagIds?: string[]
}

export class AdminGalleryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AdminGalleryError'
  }
}

const ADMIN_GALLERY_STATUSES = new Set(['draft', 'published', 'archived'])
const BATCH_CHUNK_SIZE = 100

function parsePage(value: string | null | undefined): number {
  const parsed = Number.parseInt(value || String(PAGINATION.DEFAULT_PAGE), 10)
  return Math.max(1, Number.isNaN(parsed) ? PAGINATION.DEFAULT_PAGE : parsed)
}

function parsePageSize(value: string | null | undefined): number {
  const parsed = Number.parseInt(value || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)
  const pageSize = Number.isNaN(parsed) ? PAGINATION.DEFAULT_PAGE_SIZE : parsed
  return Math.min(PAGINATION.MAX_PAGE_SIZE, Math.max(1, pageSize))
}

function buildGalleryFilter(params: AdminGalleryListParams): { joinClause: string; whereClause: string; values: unknown[] } {
  const conditions: string[] = []
  const values: unknown[] = []
  let joinClause = ''

  if (params.status && ADMIN_GALLERY_STATUSES.has(params.status)) {
    conditions.push('g.status = ?')
    values.push(params.status)
  }

  if (params.search) {
    conditions.push('g.title LIKE ?')
    values.push(`%${params.search}%`)
  }

  if (params.tag) {
    joinClause = 'INNER JOIN gallery_tags gt ON gt.gallery_id = g.id INNER JOIN tags t ON t.id = gt.tag_id'
    conditions.push('(t.name = ? OR t.slug = ?)')
    values.push(params.tag, params.tag)
  }

  return {
    joinClause,
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  }
}

async function loadGalleryById(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  return db
    .prepare('SELECT * FROM galleries WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>()
}

async function loadGalleryTags(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.type FROM tags t
       INNER JOIN gallery_tags gt ON gt.tag_id = t.id
       WHERE gt.gallery_id = ?`,
    )
    .bind(id)
    .all<{ id: string; name: string; type: string }>()
}

function assertGallerySlugUnique(db: D1Database, slug: string, galleryId?: string) {
  if (!galleryId) {
    return db
      .prepare('SELECT id FROM galleries WHERE slug = ?')
      .bind(slug)
      .first<{ id: string }>()
  }

  return db
    .prepare('SELECT id FROM galleries WHERE slug = ? AND id != ?')
    .bind(slug, galleryId)
    .first<{ id: string }>()
}

async function upsertGalleryTags(db: D1Database, galleryId: string, tagIds?: string[]) {
  if (tagIds === undefined) return

  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM gallery_tags WHERE gallery_id = ?').bind(galleryId),
    ...tagIds.map((tagId) => db.prepare('INSERT INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)').bind(galleryId, tagId)),
  ]
  await db.batch(stmts)
}

export async function listAdminGalleries(
  db: D1Database,
  params: AdminGalleryListParams,
): Promise<AdminGalleryListResult> {
  const page = parsePage(params.page)
  const pageSize = parsePageSize(params.pageSize)
  const filter = buildGalleryFilter(params)
  const offset = (page - 1) * pageSize
  const orderClause = getAdminGalleryOrderClause(params.sort || 'created_desc')

  const countResult = await db
    .prepare(`SELECT COUNT(DISTINCT g.id) as total FROM galleries g ${filter.joinClause} ${filter.whereClause}`)
    .bind(...filter.values)
    .first<{ total: number }>()
  const total = countResult?.total ?? 0

  const rows = await db
    .prepare(
      `SELECT DISTINCT g.id, g.title, g.slug, g.status, g.required_level_rank, g.cover_key, g.published_at, g.created_at, g.updated_at, g.view_count, g.like_count
       FROM galleries g ${filter.joinClause} ${filter.whereClause}
       ${orderClause}
       LIMIT ? OFFSET ?`,
    )
    .bind(...filter.values, pageSize, offset)
    .all<AdminGalleryListItem>()

  return {
    data: rows.results,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

export async function getAdminGalleryDetail(db: D1Database, id: string): Promise<AdminGalleryDetail> {
  const row = await loadGalleryById(db, id)
  if (!row) {
    throw new AdminGalleryError(404, '图库不存在')
  }

  const tags = await loadGalleryTags(db, id)

  return {
    id: row.id as string,
    title: row.title as string,
    slug: row.slug as string,
    summary: (row.summary as string | null) ?? null,
    bodyMd: (row.body_md as string | null) ?? null,
    coverKey: (row.cover_key as string | null) ?? null,
    status: row.status as string,
    requiredLevelRank: Number(row.required_level_rank ?? 0),
    publishedAt: (row.published_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    viewCount: Number(row.view_count ?? 0),
    tags: tags.results,
  }
}

export async function createAdminGallery(
  db: D1Database,
  userId: number,
  userRole: string,
  body: AdminGalleryCreateInput,
): Promise<{ id: string; status: string }> {
  if (!body.title || !body.slug) {
    throw new AdminGalleryError(400, 'title 和 slug 为必填项')
  }

  const existing = await assertGallerySlugUnique(db, body.slug)
  if (existing) {
    throw new AdminGalleryError(409, 'slug 已存在')
  }

  let status = 'draft'
  let publishedAt: string | null = null
  if (userRole === 'owner' && body.status === 'published') {
    status = 'published'
    publishedAt = new Date().toISOString()
  }

  const id = generateId('gal')
  const now = new Date().toISOString()

  await db
    .prepare(
      `INSERT INTO galleries (id, title, slug, summary, body_md, cover_key, status, required_level_rank, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      body.title,
      body.slug,
      body.summary ?? null,
      body.bodyMd ?? null,
      null,
      status,
      body.requiredLevelRank ?? 0,
      publishedAt,
      now,
      now,
    )
    .run()

  if (body.tagIds && body.tagIds.length > 0) {
    const stmts = body.tagIds.map((tagId) =>
      db.prepare('INSERT INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)').bind(id, tagId),
    )
    await db.batch(stmts)
  }

  await writeAuditLog(db, {
    adminId: userId,
    action: 'gallery.create',
    targetType: 'gallery',
    targetId: id,
    afterValue: { title: body.title, slug: body.slug, status },
  })

  return { id, status }
}

export async function updateAdminGallery(
  db: D1Database,
  userId: number,
  id: string,
  body: AdminGalleryUpdateInput,
): Promise<{ id: string; updated: true }> {
  const gallery = await loadGalleryById(db, id)
  if (!gallery) {
    throw new AdminGalleryError(404, '图库不存在')
  }

  if (body.slug && body.slug !== gallery.slug) {
    const existing = await assertGallerySlugUnique(db, body.slug, id)
    if (existing) {
      throw new AdminGalleryError(409, 'slug 已存在')
    }
  }

  const now = new Date().toISOString()
  const sets: string[] = []
  const values: unknown[] = []

  if (body.title !== undefined) { sets.push('title = ?'); values.push(body.title) }
  if (body.slug !== undefined) { sets.push('slug = ?'); values.push(body.slug) }
  if (body.summary !== undefined) { sets.push('summary = ?'); values.push(body.summary) }
  if (body.bodyMd !== undefined) { sets.push('body_md = ?'); values.push(body.bodyMd) }
  if (body.requiredLevelRank !== undefined) { sets.push('required_level_rank = ?'); values.push(body.requiredLevelRank) }

  if (sets.length > 0) {
    sets.push('updated_at = ?')
    values.push(now)
    await db
      .prepare(`UPDATE galleries SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, id)
      .run()
  }

  await upsertGalleryTags(db, id, body.tagIds)

  await writeAuditLog(db, {
    adminId: userId,
    action: 'gallery.update',
    targetType: 'gallery',
    targetId: id,
    beforeValue: gallery,
    afterValue: { ...body, updated_at: now },
  })

  return { id, updated: true }
}

export async function publishAdminGallery(
  db: D1Database,
  userId: number,
  id: string,
): Promise<{ id: string; status: 'published' }> {
  const gallery = await db.prepare('SELECT id, status FROM galleries WHERE id = ?').bind(id).first<{ id: string; status: string }>()
  if (!gallery) {
    throw new AdminGalleryError(404, '图库不存在')
  }

  const now = new Date().toISOString()
  await db
    .prepare('UPDATE galleries SET status = ?, published_at = ?, updated_at = ? WHERE id = ?')
    .bind('published', now, now, id)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'gallery.publish',
    targetType: 'gallery',
    targetId: id,
    beforeValue: { status: gallery.status },
    afterValue: { status: 'published' },
  })

  return { id, status: 'published' }
}

export async function unpublishAdminGallery(
  db: D1Database,
  userId: number,
  id: string,
): Promise<{ id: string; status: 'draft' }> {
  const gallery = await db.prepare('SELECT id, status FROM galleries WHERE id = ?').bind(id).first<{ id: string; status: string }>()
  if (!gallery) {
    throw new AdminGalleryError(404, '图库不存在')
  }

  const now = new Date().toISOString()
  await db
    .prepare('UPDATE galleries SET status = ?, published_at = NULL, updated_at = ? WHERE id = ?')
    .bind('draft', now, id)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'gallery.unpublish',
    targetType: 'gallery',
    targetId: id,
    beforeValue: { status: gallery.status },
    afterValue: { status: 'draft' },
  })

  return { id, status: 'draft' }
}

export async function archiveAdminGallery(
  db: D1Database,
  userId: number,
  id: string,
): Promise<{ id: string; status: 'archived' }> {
  const gallery = await db.prepare('SELECT id, status FROM galleries WHERE id = ?').bind(id).first<{ id: string; status: string }>()
  if (!gallery) {
    throw new AdminGalleryError(404, '图库不存在')
  }

  const now = new Date().toISOString()
  await db
    .prepare('UPDATE galleries SET status = ?, updated_at = ? WHERE id = ?')
    .bind('archived', now, id)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'gallery.archive',
    targetType: 'gallery',
    targetId: id,
    beforeValue: { status: gallery.status },
    afterValue: { status: 'archived' },
  })

  return { id, status: 'archived' }
}

async function resolveFilteredGalleryIds(
  db: D1Database,
  filter: { status?: string; tag?: string; search?: string },
): Promise<string[]> {
  const conditions: string[] = []
  const bindValues: unknown[] = []

  if (filter.status && ADMIN_GALLERY_STATUSES.has(filter.status)) {
    conditions.push('g.status = ?')
    bindValues.push(filter.status)
  }

  if (filter.search) {
    conditions.push('g.title LIKE ?')
    bindValues.push(`%${filter.search}%`)
  }

  let joinClause = ''
  if (filter.tag) {
    joinClause = 'INNER JOIN gallery_tags gt ON gt.gallery_id = g.id INNER JOIN tags t ON t.id = gt.tag_id'
    conditions.push('(t.name = ? OR t.slug = ?)')
    bindValues.push(filter.tag, filter.tag)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = await db
    .prepare(`SELECT DISTINCT g.id FROM galleries g ${joinClause} ${whereClause}`)
    .bind(...bindValues)
    .all<{ id: string }>()

  return rows.results.map((r) => r.id)
}

async function executeBatchAction(
  db: D1Database,
  r2: R2Bucket,
  action: AdminGalleryBatchAction,
  galleryIds: string[],
  params: AdminGalleryBatchRequest['params'],
): Promise<{ success: number; failed: number; errors: Array<{ galleryId: string; error: string }> }> {
  const errors: Array<{ galleryId: string; error: string }> = []
  const now = new Date().toISOString()
  const placeholders = galleryIds.map(() => '?').join(',')

  try {
    switch (action) {
      case 'publish': {
        await db
          .prepare(`UPDATE galleries SET status = 'published', published_at = ?, updated_at = ? WHERE id IN (${placeholders})`)
          .bind(now, now, ...galleryIds)
          .run()
        break
      }

      case 'unpublish': {
        await db
          .prepare(`UPDATE galleries SET status = 'draft', published_at = NULL, updated_at = ? WHERE id IN (${placeholders})`)
          .bind(now, ...galleryIds)
          .run()
        break
      }

      case 'delete': {
        const mediaRows = await db
          .prepare(`SELECT id, gallery_id, r2_key FROM media_assets WHERE gallery_id IN (${placeholders}) AND r2_key IS NOT NULL`)
          .bind(...galleryIds)
          .all<{ id: string; gallery_id: string; r2_key: string }>()

        const stmts: D1PreparedStatement[] = [
          db.prepare(`DELETE FROM gallery_tags WHERE gallery_id IN (${placeholders})`).bind(...galleryIds),
          db.prepare(`DELETE FROM media_assets WHERE gallery_id IN (${placeholders})`).bind(...galleryIds),
          db.prepare(`DELETE FROM galleries WHERE id IN (${placeholders})`).bind(...galleryIds),
        ]
        await db.batch(stmts)

        const r2Keys = mediaRows.results
          .filter(r => !isExternalMediaKey(r.r2_key) && isExpectedGalleryMediaKey(r.r2_key, r.gallery_id, r.id))
          .map(r => r.r2_key)
        if (r2Keys.length > 0) {
          for (let j = 0; j < r2Keys.length; j += 1000) {
            const keyChunk = r2Keys.slice(j, j + 1000)
            try {
              await r2.delete(keyChunk)
            } catch (e) {
              console.error('R2 批量删除失败:', e)
            }
          }
        }
        break
      }

      case 'set_level': {
        await db
          .prepare(`UPDATE galleries SET required_level_rank = ?, updated_at = ? WHERE id IN (${placeholders})`)
          .bind(params!.requiredLevelRank!, now, ...galleryIds)
          .run()
        break
      }

      case 'add_tags': {
        const tagStmts: D1PreparedStatement[] = []
        for (const galleryId of galleryIds) {
          for (const tagId of params!.tagIds!) {
            tagStmts.push(
              db.prepare('INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)').bind(galleryId, tagId),
            )
          }
        }
        for (let j = 0; j < tagStmts.length; j += 100) {
          await db.batch(tagStmts.slice(j, j + 100))
        }
        break
      }

      case 'remove_tags': {
        const tagPlaceholders = params!.tagIds!.map(() => '?').join(',')
        await db
          .prepare(`DELETE FROM gallery_tags WHERE gallery_id IN (${placeholders}) AND tag_id IN (${tagPlaceholders})`)
          .bind(...galleryIds, ...params!.tagIds!)
          .run()
        break
      }
    }

    return { success: galleryIds.length, failed: 0, errors }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e)
    console.error(`批量操作 ${action} 失败:`, errorMsg)
    for (const id of galleryIds) {
      errors.push({ galleryId: id, error: errorMsg })
    }
    return { success: 0, failed: galleryIds.length, errors }
  }
}

export async function processAdminGalleryBatch(
  db: D1Database,
  r2: R2Bucket,
  userId: number,
  userRole: string,
  body: AdminGalleryBatchRequest,
): Promise<AdminGalleryBatchResult> {
  const validActions: AdminGalleryBatchAction[] = ['publish', 'unpublish', 'delete', 'set_level', 'add_tags', 'remove_tags']
  if (!body.action || !validActions.includes(body.action)) {
    throw new AdminGalleryError(400, `action 必须为: ${validActions.join(', ')}`)
  }

  if (body.action === 'delete' && userRole !== 'owner') {
    throw new AdminGalleryError(403, '批量删除需要 Owner 权限')
  }

  if (body.action === 'set_level') {
    if (body.params?.requiredLevelRank === undefined || typeof body.params.requiredLevelRank !== 'number') {
      throw new AdminGalleryError(400, 'set_level 操作需要 params.requiredLevelRank（数字）')
    }
  }

  if ((body.action === 'add_tags' || body.action === 'remove_tags') && (!body.params?.tagIds || body.params.tagIds.length === 0)) {
    throw new AdminGalleryError(400, `${body.action} 操作需要 params.tagIds（非空数组）`)
  }

  let galleryIds: string[]
  if (body.selectAll && body.filter) {
    galleryIds = await resolveFilteredGalleryIds(db, body.filter)
  } else if (body.galleryIds && body.galleryIds.length > 0) {
    galleryIds = body.galleryIds
  } else {
    throw new AdminGalleryError(400, '请提供 galleryIds 列表或 selectAll + filter 条件')
  }

  if (galleryIds.length === 0) {
    return { affected: 0, success: 0, failed: 0, errors: [] }
  }

  const result: AdminGalleryBatchResult = { affected: galleryIds.length, success: 0, failed: 0, errors: [] }

  for (let i = 0; i < galleryIds.length; i += BATCH_CHUNK_SIZE) {
    const chunk = galleryIds.slice(i, i + BATCH_CHUNK_SIZE)
    const chunkResult = await executeBatchAction(db, r2, body.action, chunk, body.params)
    result.success += chunkResult.success
    result.failed += chunkResult.failed
    result.errors.push(...chunkResult.errors)
  }

  await writeAuditLog(db, {
    adminId: userId,
    action: `gallery.batch_${body.action}`,
    targetType: 'gallery',
    afterValue: {
      action: body.action,
      totalAffected: result.affected,
      success: result.success,
      failed: result.failed,
      filter: body.filter ?? null,
      params: body.params ?? null,
    },
  })

  return result
}
