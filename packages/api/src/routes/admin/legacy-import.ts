import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import { PAGINATION } from '@meigallery/shared/constants'

export const adminLegacyImportRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// POST /sources — 创建旧站来源
adminLegacyImportRoutes.post('/sources', async (c) => {
  const db = c.env.DB
  const body = await c.req.json<{
    name: string
    baseUrl: string
    mode: 'rest_api' | 'xml'
    categoryMapping?: Record<string, string>
    tagMapping?: Record<string, string>
  }>()

  const id = generateId('lsrc')
  await db
    .prepare(
      `INSERT INTO legacy_import_sources (id, name, base_url, mode, category_mapping, tag_mapping)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      body.name,
      body.baseUrl,
      body.mode,
      body.categoryMapping ? JSON.stringify(body.categoryMapping) : null,
      body.tagMapping ? JSON.stringify(body.tagMapping) : null,
    )
    .run()

  const record = await db
    .prepare('SELECT * FROM legacy_import_sources WHERE id = ?')
    .bind(id)
    .first()

  await writeAuditLog(db, {
    adminId: c.get('userId')!,
    action: 'create_legacy_source',
    targetType: 'legacy_import_source',
    targetId: id,
    afterValue: record,
  })

  return c.json(record, 201)
})

// GET /sources — 来源列表
adminLegacyImportRoutes.get('/sources', async (c) => {
  const db = c.env.DB
  const { results } = await db.prepare('SELECT * FROM legacy_import_sources ORDER BY created_at DESC').all()
  return c.json({ data: results })
})

// POST /jobs — 启动迁移任务
adminLegacyImportRoutes.post('/jobs', async (c) => {
  const db = c.env.DB
  const body = await c.req.json<{ sourceId: string; description?: string }>()

  // 验证 source 存在
  const source = await db
    .prepare('SELECT id FROM legacy_import_sources WHERE id = ?')
    .bind(body.sourceId)
    .first()
  if (!source) {
    return c.json({ error: '来源不存在' }, 404)
  }

  const id = generateId('job')
  await db
    .prepare(
      `INSERT INTO import_jobs (id, type, status, source_key, total_count, success_count, failure_count, created_by)
       VALUES (?, 'legacy', 'pending', ?, 0, 0, 0, ?)`,
    )
    .bind(id, body.sourceId, c.get('userId')!)
    .run()

  await writeAuditLog(db, {
    adminId: c.get('userId')!,
    action: 'create_legacy_import_job',
    targetType: 'import_job',
    targetId: id,
    afterValue: { sourceId: body.sourceId, description: body.description },
  })

  const record = await db.prepare('SELECT * FROM import_jobs WHERE id = ?').bind(id).first()
  return c.json(record, 201)
})

// GET /jobs/:id — 任务详情
adminLegacyImportRoutes.get('/jobs/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')

  const job = await db.prepare('SELECT * FROM import_jobs WHERE id = ?').bind(id).first()
  if (!job) {
    return c.json({ error: '任务不存在' }, 404)
  }

  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
         SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END) as imported_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
         SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) as approved_count,
         SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
       FROM legacy_import_items WHERE job_id = ?`,
    )
    .bind(id)
    .first()

  return c.json({ ...job, stats })
})

// GET /items — 条目列表
adminLegacyImportRoutes.get('/items', async (c) => {
  const db = c.env.DB
  const sourceId = c.req.query('sourceId')
  const jobId = c.req.query('jobId')
  const status = c.req.query('status')
  const reviewStatus = c.req.query('reviewStatus')
  const page = Math.max(1, parseInt(c.req.query('page') || String(PAGINATION.DEFAULT_PAGE), 10))
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(PAGINATION.DEFAULT_PAGE_SIZE), 10)),
  )

  const conditions: string[] = []
  const bindings: unknown[] = []

  if (sourceId) {
    conditions.push('source_id = ?')
    bindings.push(sourceId)
  }
  if (jobId) {
    conditions.push('job_id = ?')
    bindings.push(jobId)
  }
  if (status) {
    conditions.push('status = ?')
    bindings.push(status)
  }
  if (reviewStatus) {
    conditions.push('review_status = ?')
    bindings.push(reviewStatus)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const offset = (page - 1) * pageSize

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM legacy_import_items ${where}`)
    .bind(...bindings)
    .first<{ total: number }>()

  const { results } = await db
    .prepare(`SELECT * FROM legacy_import_items ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, pageSize, offset)
    .all()

  return c.json({ data: results, total: countResult?.total ?? 0, page, pageSize })
})

// PATCH /items/:id/review — 审核条目
adminLegacyImportRoutes.patch('/items/:id/review', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.json<{ reviewStatus: 'approved' | 'rejected'; note?: string }>()

  const item = await db.prepare('SELECT * FROM legacy_import_items WHERE id = ?').bind(id).first<{
    id: string
    gallery_id: string | null
    review_status: string
  }>()
  if (!item) {
    return c.json({ error: '条目不存在' }, 404)
  }

  const flags = body.note ? JSON.stringify({ note: body.note }) : null
  await db
    .prepare('UPDATE legacy_import_items SET review_status = ?, review_flags = ? WHERE id = ?')
    .bind(body.reviewStatus, flags, id)
    .run()

  // 如果 approved 且有 gallery_id，发布 gallery
  if (body.reviewStatus === 'approved' && item.gallery_id) {
    await db
      .prepare("UPDATE galleries SET status = 'published' WHERE id = ?")
      .bind(item.gallery_id)
      .run()
  }

  await writeAuditLog(db, {
    adminId: c.get('userId')!,
    action: 'review_legacy_import_item',
    targetType: 'legacy_import_item',
    targetId: id,
    beforeValue: { reviewStatus: item.review_status },
    afterValue: { reviewStatus: body.reviewStatus, note: body.note },
  })

  return c.json({ success: true })
})
