import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import { PAGINATION } from '@meigallery/shared/constants'

export const adminGalleryRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/**
 * GET / - 管理员图库列表（支持全部状态筛选）
 */
adminGalleryRoutes.get('/', async (c) => {
  const db = c.env.DB

  const page = Math.max(1, Number(c.req.query('page')) || PAGINATION.DEFAULT_PAGE)
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, Number(c.req.query('pageSize')) || PAGINATION.DEFAULT_PAGE_SIZE),
  )
  const status = c.req.query('status')
  const offset = (page - 1) * pageSize

  let whereClause = ''
  const bindValues: unknown[] = []

  if (status && ['draft', 'published', 'archived'].includes(status)) {
    whereClause = 'WHERE status = ?'
    bindValues.push(status)
  }

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM galleries ${whereClause}`)
    .bind(...bindValues)
    .first<{ total: number }>()

  const total = countResult?.total ?? 0

  const rows = await db
    .prepare(
      `SELECT id, title, slug, status, required_level_rank, cover_key, published_at, created_at, updated_at
       FROM galleries ${whereClause}
       ORDER BY created_at DESC
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
