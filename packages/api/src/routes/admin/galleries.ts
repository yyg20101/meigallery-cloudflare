import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import { PAGINATION } from '@meigallery/shared/constants'

export const adminGalleryRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ============================================================
// 批量操作类型
// ============================================================

type BatchAction = 'publish' | 'unpublish' | 'delete' | 'set_level' | 'add_tags' | 'remove_tags'

interface BatchRequest {
  action: BatchAction
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

interface BatchResult {
  affected: number
  success: number
  failed: number
  errors: Array<{ galleryId: string; error: string }>
}

/** 每批处理的最大图库数量（D1 SQL 大小限制） */
const BATCH_CHUNK_SIZE = 100

// ============================================================
// POST /batch - 批量操作
// ============================================================

adminGalleryRoutes.post('/batch', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')!
  const userRole = c.get('userRole')!

  const body = await c.req.json<BatchRequest>()

  // 参数校验
  const validActions: BatchAction[] = ['publish', 'unpublish', 'delete', 'set_level', 'add_tags', 'remove_tags']
  if (!body.action || !validActions.includes(body.action)) {
    return c.json({ error: `action 必须为: ${validActions.join(', ')}` }, 400)
  }

  // 删除操作需要 Owner 角色
  if (body.action === 'delete' && userRole !== 'owner') {
    return c.json({ error: '批量删除需要 Owner 权限' }, 403)
  }

  // set_level 需要 requiredLevelRank 参数
  if (body.action === 'set_level') {
    if (body.params?.requiredLevelRank === undefined || typeof body.params.requiredLevelRank !== 'number') {
      return c.json({ error: 'set_level 操作需要 params.requiredLevelRank（数字）' }, 400)
    }
  }

  // add_tags / remove_tags 需要 tagIds 参数
  if ((body.action === 'add_tags' || body.action === 'remove_tags') && (!body.params?.tagIds || body.params.tagIds.length === 0)) {
    return c.json({ error: `${body.action} 操作需要 params.tagIds（非空数组）` }, 400)
  }

  // 解析目标图库 ID 列表
  let galleryIds: string[]

  if (body.selectAll && body.filter) {
    // 全选模式：根据筛选条件查出所有匹配的 ID
    galleryIds = await resolveFilteredGalleryIds(db, body.filter)
  } else if (body.galleryIds && body.galleryIds.length > 0) {
    galleryIds = body.galleryIds
  } else {
    return c.json({ error: '请提供 galleryIds 列表或 selectAll + filter 条件' }, 400)
  }

  if (galleryIds.length === 0) {
    return c.json({ affected: 0, success: 0, failed: 0, errors: [] })
  }

  // 分批执行
  const result: BatchResult = { affected: galleryIds.length, success: 0, failed: 0, errors: [] }

  for (let i = 0; i < galleryIds.length; i += BATCH_CHUNK_SIZE) {
    const chunk = galleryIds.slice(i, i + BATCH_CHUNK_SIZE)
    const chunkResult = await executeBatchAction(db, c.env.R2, body.action, chunk, body.params, userId)
    result.success += chunkResult.success
    result.failed += chunkResult.failed
    result.errors.push(...chunkResult.errors)
  }

  // 写审计日志（一次记录整体操作）
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

  return c.json(result)
})

/**
 * 根据筛选条件查询匹配的图库 ID 列表
 */
async function resolveFilteredGalleryIds(
  db: D1Database,
  filter: { status?: string; tag?: string; search?: string },
): Promise<string[]> {
  const conditions: string[] = []
  const bindValues: unknown[] = []

  if (filter.status && ['draft', 'published', 'archived'].includes(filter.status)) {
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

/**
 * 对一批图库 ID 执行指定操作
 */
async function executeBatchAction(
  db: D1Database,
  r2: R2Bucket,
  action: BatchAction,
  galleryIds: string[],
  params: BatchRequest['params'],
  _adminId: string,
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
        // 1. 查询关联的 R2 key，用于后续清理存储
        const mediaRows = await db
          .prepare(`SELECT r2_key FROM media_assets WHERE gallery_id IN (${placeholders}) AND r2_key IS NOT NULL`)
          .bind(...galleryIds)
          .all<{ r2_key: string }>()

        // 2. 删除数据库记录（gallery_tags → media_assets → galleries）
        const stmts: D1PreparedStatement[] = [
          db.prepare(`DELETE FROM gallery_tags WHERE gallery_id IN (${placeholders})`).bind(...galleryIds),
          db.prepare(`DELETE FROM media_assets WHERE gallery_id IN (${placeholders})`).bind(...galleryIds),
          db.prepare(`DELETE FROM galleries WHERE id IN (${placeholders})`).bind(...galleryIds),
        ]
        await db.batch(stmts)

        // 3. 异步清理 R2 对象（不阻塞响应，失败不影响结果）
        const r2Keys = mediaRows.results.map((r) => r.r2_key)
        if (r2Keys.length > 0) {
          // R2 delete 支持最多 1000 个 key
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
        // 对每个图库添加标签（使用 INSERT OR IGNORE 避免重复）
        const tagStmts: D1PreparedStatement[] = []
        for (const galleryId of galleryIds) {
          for (const tagId of params!.tagIds!) {
            tagStmts.push(
              db.prepare('INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)').bind(galleryId, tagId),
            )
          }
        }
        // D1 batch 最多支持约 100 条语句，分批执行
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
    // 整批失败时，记录到 errors
    for (const id of galleryIds) {
      errors.push({ galleryId: id, error: errorMsg })
    }
    return { success: 0, failed: galleryIds.length, errors }
  }
}

/**
 * GET / - 管理员图库列表（支持状态筛选 + 搜索 + 标签过滤）
 */
adminGalleryRoutes.get('/', async (c) => {
  const db = c.env.DB

  const page = Math.max(1, Number(c.req.query('page')) || PAGINATION.DEFAULT_PAGE)
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, Number(c.req.query('pageSize')) || PAGINATION.DEFAULT_PAGE_SIZE),
  )
  const status = c.req.query('status')
  const search = c.req.query('search')
  const tag = c.req.query('tag')
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const bindValues: unknown[] = []
  let joinClause = ''

  if (status && ['draft', 'published', 'archived'].includes(status)) {
    conditions.push('g.status = ?')
    bindValues.push(status)
  }

  if (search) {
    conditions.push('g.title LIKE ?')
    bindValues.push(`%${search}%`)
  }

  if (tag) {
    joinClause = 'INNER JOIN gallery_tags gt ON gt.gallery_id = g.id INNER JOIN tags t ON t.id = gt.tag_id'
    conditions.push('(t.name = ? OR t.slug = ?)')
    bindValues.push(tag, tag)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await db
    .prepare(`SELECT COUNT(DISTINCT g.id) as total FROM galleries g ${joinClause} ${whereClause}`)
    .bind(...bindValues)
    .first<{ total: number }>()

  const total = countResult?.total ?? 0

  const rows = await db
    .prepare(
      `SELECT DISTINCT g.id, g.title, g.slug, g.status, g.required_level_rank, g.cover_key, g.published_at, g.created_at, g.updated_at
       FROM galleries g ${joinClause} ${whereClause}
       ORDER BY g.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindValues, pageSize, offset)
    .all()

  return c.json({
    data: rows.results,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  })
})

/**
 * GET /:id - 图库详情（含全部字段和标签）
 */
adminGalleryRoutes.get('/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')

  const gallery = await db
    .prepare('SELECT * FROM galleries WHERE id = ?')
    .bind(id)
    .first()

  if (!gallery) {
    return c.json({ error: '图库不存在' }, 404)
  }

  const tags = await db
    .prepare(
      `SELECT t.id, t.name, t.type FROM tags t
       INNER JOIN gallery_tags gt ON gt.tag_id = t.id
       WHERE gt.gallery_id = ?`,
    )
    .bind(id)
    .all()

  return c.json({ data: { ...gallery, tags: tags.results } })
})

/**
 * POST / - 创建图库
 */
adminGalleryRoutes.post('/', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')!
  const userRole = c.get('userRole')!

  const body = await c.req.json<{
    title: string
    slug: string
    summary?: string
    bodyMd?: string
    requiredLevelRank?: number
    tagIds?: string[]
    status?: string
  }>()

  if (!body.title || !body.slug) {
    return c.json({ error: 'title 和 slug 为必填项' }, 400)
  }

  // slug 唯一性校验
  const existing = await db
    .prepare('SELECT id FROM galleries WHERE slug = ?')
    .bind(body.slug)
    .first()

  if (existing) {
    return c.json({ error: 'slug 已存在' }, 409)
  }

  // Owner 可发布，Admin 强制 draft
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

  // 标签关联
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

  return c.json({ data: { id, status } }, 201)
})

/**
 * PATCH /:id - 更新图库
 */
adminGalleryRoutes.patch('/:id', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')!
  const id = c.req.param('id')

  const gallery = await db.prepare('SELECT * FROM galleries WHERE id = ?').bind(id).first()
  if (!gallery) {
    return c.json({ error: '图库不存在' }, 404)
  }

  const body = await c.req.json<{
    title?: string
    slug?: string
    summary?: string
    bodyMd?: string
    requiredLevelRank?: number
    tagIds?: string[]
  }>()

  // slug 唯一性校验
  if (body.slug && body.slug !== gallery.slug) {
    const existing = await db
      .prepare('SELECT id FROM galleries WHERE slug = ? AND id != ?')
      .bind(body.slug, id)
      .first()
    if (existing) {
      return c.json({ error: 'slug 已存在' }, 409)
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

  // 标签关联更新
  if (body.tagIds !== undefined) {
    const stmts: D1PreparedStatement[] = [
      db.prepare('DELETE FROM gallery_tags WHERE gallery_id = ?').bind(id),
      ...body.tagIds.map((tagId) =>
        db.prepare('INSERT INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)').bind(id, tagId),
      ),
    ]
    await db.batch(stmts)
  }

  await writeAuditLog(db, {
    adminId: userId,
    action: 'gallery.update',
    targetType: 'gallery',
    targetId: id,
    beforeValue: gallery,
    afterValue: { ...body, updated_at: now },
  })

  return c.json({ data: { id, updated: true } })
})

/**
 * POST /:id/publish - 发布图库
 */
adminGalleryRoutes.post('/:id/publish', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')!
  const id = c.req.param('id')

  const gallery = await db.prepare('SELECT id, status FROM galleries WHERE id = ?').bind(id).first()
  if (!gallery) {
    return c.json({ error: '图库不存在' }, 404)
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

  return c.json({ data: { id, status: 'published' } })
})

/**
 * POST /:id/unpublish - 下架图库
 */
adminGalleryRoutes.post('/:id/unpublish', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')!
  const id = c.req.param('id')

  const gallery = await db.prepare('SELECT id, status FROM galleries WHERE id = ?').bind(id).first()
  if (!gallery) {
    return c.json({ error: '图库不存在' }, 404)
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

  return c.json({ data: { id, status: 'draft' } })
})

/**
 * DELETE /:id - 归档图库（软删除）
 */
adminGalleryRoutes.delete('/:id', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')!
  const id = c.req.param('id')

  const gallery = await db.prepare('SELECT id, status FROM galleries WHERE id = ?').bind(id).first()
  if (!gallery) {
    return c.json({ error: '图库不存在' }, 404)
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

  return c.json({ data: { id, status: 'archived' } })
})
