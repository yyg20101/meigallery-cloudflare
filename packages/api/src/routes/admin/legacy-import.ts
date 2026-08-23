import { Hono } from 'hono'
import { PAGINATION } from '@meigallery/shared/constants'
import type { Bindings, Variables } from '../../index'
import { errorJson } from '../../utils/api-error'
import { generateId } from '../../utils/db'
import { writeAuditLog } from '../../utils/permission'
import { fetchAllPosts, fetchAllCategories, fetchAllTags } from '../../services/wp-fetcher'
import {
  loadLegacyMappingOverrides,
  processPosts,
  writeFailedMigrationItem,
  writeMigrationItem,
} from '../../services/wp-migration'
import { downloadImageToR2 } from '../../services/media-downloader'
import { assertSafeExternalUrl } from '../../utils/external-url'

export const adminLegacyImportRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const LEGACY_JOB_STATUSES = new Set(['pending', 'queued', 'processing', 'completed', 'failed'])
const LEGACY_ITEM_STATUSES = new Set(['pending', 'imported', 'failed'])
const LEGACY_REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected'])
const DEFAULT_MEDIA_DOWNLOAD_LIMIT = 10
const MAX_MEDIA_DOWNLOAD_LIMIT = 50
const MAX_SOURCE_NAME_LENGTH = 80
const MAX_SOURCE_URL_LENGTH = 2_048
const MAX_JOB_DESCRIPTION_LENGTH = 500
const MAX_MAPPING_ENTRIES = 500
const LEGACY_PROCESSING_LEASE_MODIFIER = '+30 minutes'
const LEGACY_LEASE_HEARTBEAT_ITEMS = 10

type PendingLegacyImage = {
  id: string
  gallery_id: string
  type: 'image'
  r2_key: string
}

class LegacyImportLeaseLostError extends Error {
  constructor() {
    super('旧站迁移处理租约已失效')
    this.name = 'LegacyImportLeaseLostError'
  }
}

// POST /sources — 创建旧站来源
adminLegacyImportRoutes.post('/sources', async (c) => {
  const db = c.env.DB
  const body = await readJsonObject(c.req.raw)
  if (!body) return errorJson(c, 400, '请求体必须是 JSON 对象')
  const name = normalizedString(body.name)
  if (!name || name.length > MAX_SOURCE_NAME_LENGTH) {
    return errorJson(c, 400, `来源名称为必填且不能超过 ${MAX_SOURCE_NAME_LENGTH} 字`)
  }
  const baseUrl = normalizedString(body.baseUrl)
  if (!baseUrl) return errorJson(c, 400, '来源地址为必填')
  if ([...baseUrl].length > MAX_SOURCE_URL_LENGTH) {
    return errorJson(c, 400, `来源地址不能超过 ${MAX_SOURCE_URL_LENGTH} 字`)
  }
  const mode = body.mode
  if (mode !== 'rest_api' && mode !== 'xml') {
    return errorJson(c, 400, '迁移模式不正确')
  }

  let categoryMapping: string | null
  let tagMapping: string | null
  try {
    categoryMapping = normalizeLegacyMapping(body.categoryMapping, '分类映射')
    tagMapping = normalizeLegacyMapping(body.tagMapping, '标签映射')
  } catch (error) {
    return errorJson(c, 400, error instanceof Error ? error.message : '映射格式不正确')
  }

  let safeBaseUrl: string
  try {
    safeBaseUrl = assertSafeExternalUrl(baseUrl)
  } catch (error) {
    const message = error instanceof Error ? error.message : '来源地址不安全'
    return errorJson(c, 400, message)
  }

  const id = generateId('lsrc')
  const adminId = c.get('userId')!
  await db.batch([
    db.prepare(
      `INSERT INTO legacy_import_sources (id, name, base_url, mode, category_mapping, tag_mapping)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      name,
      safeBaseUrl,
      mode,
      categoryMapping,
      tagMapping,
    ),
    legacyAuditStatement(db, {
      adminId,
      action: 'create_legacy_source',
      targetType: 'legacy_import_source',
      targetId: id,
      afterValue: {
        id,
        name,
        baseUrl: safeBaseUrl,
        mode,
        categoryMappingConfigured: categoryMapping !== null,
        tagMappingConfigured: tagMapping !== null,
      },
    }),
  ])

  const record = await db
    .prepare('SELECT * FROM legacy_import_sources WHERE id = ?')
    .bind(id)
    .first()

  return c.json(record, 201)
})

// GET /sources — 来源列表
adminLegacyImportRoutes.get('/sources', async (c) => {
  const db = c.env.DB
  const { results } = await db.prepare(
    'SELECT * FROM legacy_import_sources ORDER BY created_at DESC, id DESC',
  ).all()
  return c.json({ data: results })
})

// POST /jobs — 启动迁移任务
adminLegacyImportRoutes.post('/jobs', async (c) => {
  const db = c.env.DB
  const body = await readJsonObject(c.req.raw)
  if (!body) return errorJson(c, 400, '请求体必须是 JSON 对象')
  const sourceId = normalizedString(body.sourceId)
  if (!sourceId || sourceId.length > 128) return errorJson(c, 400, '来源 ID 不正确')
  const description = body.description === undefined ? '' : normalizedString(body.description)
  if (body.description !== undefined && description === null) {
    return errorJson(c, 400, '任务说明必须是字符串')
  }
  if ((description?.length ?? 0) > MAX_JOB_DESCRIPTION_LENGTH) {
    return errorJson(c, 400, `任务说明不能超过 ${MAX_JOB_DESCRIPTION_LENGTH} 字`)
  }

  // 验证 source 存在
  const source = await db
    .prepare('SELECT id FROM legacy_import_sources WHERE id = ?')
    .bind(sourceId)
    .first()
  if (!source) {
    return errorJson(c, 404, '来源不存在')
  }

  const id = generateId('job')
  const adminId = c.get('userId')!
  await db.batch([
    db.prepare(
      `INSERT INTO import_jobs (
         id, type, status, source_key, total_count, success_count, failure_count,
         created_by, updated_at
       ) VALUES (?, 'legacy', 'pending', ?, 0, 0, 0, ?, datetime('now'))`,
    )
    .bind(id, sourceId, adminId),
    legacyAuditStatement(db, {
      adminId,
      action: 'create_legacy_import_job',
      targetType: 'import_job',
      targetId: id,
      afterValue: { sourceId, description: description || undefined },
    }),
  ])

  const record = await db.prepare(`
    SELECT id, status, source_key, total_count, success_count, failure_count,
           created_by, created_at, updated_at, completed_at,
           attempt_count, last_error_code, last_error_message
    FROM import_jobs
    WHERE id = ? AND type = 'legacy'
  `).bind(id).first()
  return c.json(record, 201)
})

// GET /jobs — 旧站迁移任务列表；不复用 ZIP 列表，避免暴露包对象字段或混入其他任务。
adminLegacyImportRoutes.get('/jobs', async (c) => {
  const db = c.env.DB
  const page = positiveInteger(c.req.query('page'), PAGINATION.DEFAULT_PAGE)
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    positiveInteger(c.req.query('pageSize'), PAGINATION.DEFAULT_PAGE_SIZE),
  )
  const sourceId = c.req.query('sourceId')?.trim()
  const status = c.req.query('status')?.trim()
  if (status && !LEGACY_JOB_STATUSES.has(status)) {
    return errorJson(c, 400, '迁移任务状态不正确')
  }

  const conditions = ["job.type = 'legacy'"]
  const bindings: unknown[] = []
  if (c.get('userRole') !== 'owner') {
    conditions.push('job.created_by = ?')
    bindings.push(c.get('userId')!)
  }
  if (sourceId) {
    conditions.push('job.source_key = ?')
    bindings.push(sourceId)
  }
  if (status) {
    conditions.push('job.status = ?')
    bindings.push(status)
  }
  const where = `WHERE ${conditions.join(' AND ')}`
  const offset = (page - 1) * pageSize
  const countResult = await db.prepare(`
    SELECT COUNT(*) AS total
    FROM import_jobs job
    ${where}
  `).bind(...bindings).first<{ total: number }>()
  const jobs = await db.prepare(`
    SELECT job.id, job.status, job.source_key, source.name AS source_name,
           job.total_count, job.success_count, job.failure_count,
           job.created_by, job.created_at, job.completed_at,
           job.legacy_processing_expires_at,
           CASE
             WHEN job.status = 'processing'
               AND (
                 job.legacy_processing_expires_at IS NULL
                 OR job.legacy_processing_expires_at <= datetime('now')
               )
             THEN 1 ELSE 0
           END AS recovery_available
    FROM import_jobs job
    LEFT JOIN legacy_import_sources source ON source.id = job.source_key
    ${where}
    ORDER BY job.created_at DESC, job.id DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, pageSize, offset).all()

  return c.json({
    data: jobs.results,
    total: Number(countResult?.total ?? 0),
    page,
    pageSize,
  })
})

// GET /jobs/:id — 任务详情
adminLegacyImportRoutes.get('/jobs/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')

  const job = await db.prepare(`
    SELECT job.id, job.status, job.source_key, source.name AS source_name,
           job.total_count, job.success_count, job.failure_count,
           job.created_by, job.created_at, job.updated_at, job.completed_at,
           job.attempt_count, job.last_error_code, job.last_error_message,
           job.legacy_processing_expires_at,
           CASE
             WHEN job.status = 'processing'
               AND (
                 job.legacy_processing_expires_at IS NULL
                 OR job.legacy_processing_expires_at <= datetime('now')
               )
             THEN 1 ELSE 0
           END AS recovery_available
    FROM import_jobs job
    LEFT JOIN legacy_import_sources source ON source.id = job.source_key
    WHERE job.id = ? AND job.type = 'legacy' AND (? = 1 OR job.created_by = ?)
  `).bind(id, c.get('userRole') === 'owner' ? 1 : 0, c.get('userId')!).first()
  if (!job) {
    return errorJson(c, 404, '任务不存在')
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

// POST /jobs/:id/recover-stale — 只回收已过期或历史缺失租约的 processing 任务。
adminLegacyImportRoutes.post('/jobs/:id/recover-stale', async (c) => {
  const db = c.env.DB
  const jobId = c.req.param('id')
  const adminId = c.get('userId')!
  const recoveryBatch = await db.batch([
    db.prepare(`
      UPDATE import_jobs
      SET status = 'failed',
          legacy_processing_token = NULL,
          legacy_processing_expires_at = NULL,
          completed_at = datetime('now'),
          updated_at = datetime('now'),
          last_error_code = 'LEGACY_IMPORT_PROCESSING_LEASE_EXPIRED',
          last_error_message = '旧站迁移执行租约已过期，请创建新任务安全重试'
      WHERE id = ? AND type = 'legacy'
        AND (? = 1 OR created_by = ?)
        AND status = 'processing'
        AND (
          legacy_processing_expires_at IS NULL
          OR legacy_processing_expires_at <= datetime('now')
        )
    `).bind(
      jobId,
      c.get('userRole') === 'owner' ? 1 : 0,
      adminId,
    ),
    conditionalLegacyJobAuditStatement(db, {
      adminId,
      action: 'recover_stale_legacy_import_job',
      jobId,
      beforeValue: { status: 'processing' },
      afterValue: {
        status: 'failed',
        errorCode: 'LEGACY_IMPORT_PROCESSING_LEASE_EXPIRED',
      },
    }),
  ])
  if (Number(recoveryBatch[0]?.meta?.changes ?? 0) !== 1) {
    const job = await db.prepare(`
      SELECT status, legacy_processing_expires_at
      FROM import_jobs
      WHERE id = ? AND type = 'legacy' AND (? = 1 OR created_by = ?)
    `).bind(
      jobId,
      c.get('userRole') === 'owner' ? 1 : 0,
      adminId,
    ).first<{ status: string; legacy_processing_expires_at: string | null }>()
    if (!job) return errorJson(c, 404, '任务不存在')
    if (job.status !== 'processing') return errorJson(c, 409, '任务当前不处于执行中')
    return errorJson(c, 409, '任务处理租约仍有效，不能提前回收')
  }

  return c.json({
    id: jobId,
    status: 'failed',
    errorCode: 'LEGACY_IMPORT_PROCESSING_LEASE_EXPIRED',
    retryMode: 'create_new_job',
  })
})

// POST /jobs/:id/download-media — 只下载当前 legacy 任务已导入图库的待处理图片。
adminLegacyImportRoutes.post('/jobs/:id/download-media', async (c) => {
  const db = c.env.DB
  const jobId = c.req.param('id')
  const job = await db.prepare(`
    SELECT id, status
    FROM import_jobs
    WHERE id = ? AND type = 'legacy' AND (? = 1 OR created_by = ?)
    LIMIT 1
  `).bind(
    jobId,
    c.get('userRole') === 'owner' ? 1 : 0,
    c.get('userId')!,
  ).first<{ id: string; status: string }>()
  if (!job) return errorJson(c, 404, '任务不存在')
  if (job.status !== 'completed') return errorJson(c, 409, '只有已完成的迁移任务可以下载媒体')

  const limit = Math.min(
    MAX_MEDIA_DOWNLOAD_LIMIT,
    positiveInteger(c.req.query('limit'), DEFAULT_MEDIA_DOWNLOAD_LIMIT),
  )
  const adminId = c.get('userId')!
  const result = await downloadPendingLegacyImages(db, c.env.R2, limit, adminId, { jobId })
  await writeAuditLog(db, {
    adminId,
    action: 'legacy_job_media_download',
    targetType: 'import_job',
    targetId: jobId,
    afterValue: { limit, ...legacyMediaAuditSummary(result) },
  })

  return c.json(result)
})

// GET /items — 条目列表
adminLegacyImportRoutes.get('/items', async (c) => {
  const db = c.env.DB
  const sourceId = c.req.query('sourceId')
  const jobId = c.req.query('jobId')
  const status = c.req.query('status')
  const reviewStatus = c.req.query('reviewStatus')
  if (status && !LEGACY_ITEM_STATUSES.has(status)) {
    return errorJson(c, 400, '迁移条目状态不正确')
  }
  if (reviewStatus && !LEGACY_REVIEW_STATUSES.has(reviewStatus)) {
    return errorJson(c, 400, '迁移审核状态不正确')
  }
  const page = positiveInteger(c.req.query('page'), PAGINATION.DEFAULT_PAGE)
  const pageSize = Math.min(
    PAGINATION.MAX_PAGE_SIZE,
    positiveInteger(c.req.query('pageSize'), PAGINATION.DEFAULT_PAGE_SIZE),
  )

  const conditions: string[] = []
  const bindings: unknown[] = []

  if (c.get('userRole') !== 'owner') {
    conditions.push(`EXISTS (
      SELECT 1 FROM import_jobs visible_job
      WHERE visible_job.id = item.job_id
        AND visible_job.type = 'legacy'
        AND visible_job.created_by = ?
    )`)
    bindings.push(c.get('userId')!)
  }

  if (sourceId) {
    conditions.push('item.source_id = ?')
    bindings.push(sourceId)
  }
  if (jobId) {
    conditions.push('item.job_id = ?')
    bindings.push(jobId)
  }
  if (status) {
    conditions.push('item.status = ?')
    bindings.push(status)
  }
  if (reviewStatus) {
    conditions.push('item.review_status = ?')
    bindings.push(reviewStatus)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const offset = (page - 1) * pageSize

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM legacy_import_items item ${where}`)
    .bind(...bindings)
    .first<{ total: number }>()

  const { results } = await db
    .prepare(`
      SELECT item.id, item.source_id, item.job_id, item.legacy_post_id,
             item.legacy_url, item.legacy_title, item.gallery_id,
             item.status, item.review_status, item.review_flags,
             item.review_note, item.reviewed_by, item.reviewed_at,
             item.error_code, item.error_message, item.created_at
      FROM legacy_import_items item
      ${where}
      ORDER BY item.created_at DESC, item.id DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...bindings, pageSize, offset)
    .all()

  return c.json({ data: results, total: countResult?.total ?? 0, page, pageSize })
})

// GET /items/:id — 显式读取单条私有来源快照；列表端点不携带原 HTML。
adminLegacyImportRoutes.get('/items/:id', async (c) => {
  const row = await c.env.DB.prepare(`
    SELECT item.id, item.source_id, item.job_id, item.legacy_post_id,
           item.legacy_url, item.legacy_title, item.gallery_id,
           item.status, item.review_status, item.review_flags,
           item.review_note, item.reviewed_by, reviewer.email AS reviewer_email,
           item.reviewed_at, item.error_code, item.error_message,
           item.created_at, item.source_snapshot_json,
           gallery.title AS gallery_title, gallery.status AS gallery_status
    FROM legacy_import_items item
    LEFT JOIN import_jobs job ON job.id = item.job_id AND job.type = 'legacy'
    LEFT JOIN users reviewer ON reviewer.id = item.reviewed_by
    LEFT JOIN galleries gallery ON gallery.id = item.gallery_id
    WHERE item.id = ? AND (? = 1 OR job.created_by = ?)
    LIMIT 1
  `).bind(
    c.req.param('id'),
    c.get('userRole') === 'owner' ? 1 : 0,
    c.get('userId')!,
  ).first<Record<string, unknown>>()
  if (!row) return errorJson(c, 404, '条目不存在')

  const { source_snapshot_json: sourceSnapshotJson, ...item } = row
  return c.json({
    ...item,
    sourceSnapshot: safeJsonObject(sourceSnapshotJson),
  })
})

// PATCH /items/:id/review — 审核条目
adminLegacyImportRoutes.patch('/items/:id/review', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await readJsonObject(c.req.raw)
  if (!body) return errorJson(c, 400, '请求体必须是 JSON 对象')
  if (body.reviewStatus !== 'approved' && body.reviewStatus !== 'rejected') {
    return errorJson(c, 400, '审核结论不正确')
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    return errorJson(c, 400, '审核备注必须是字符串')
  }
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (note.length > 500) return errorJson(c, 400, '审核备注不能超过 500 字')

  const item = await db.prepare(`
    SELECT item.id, item.status, item.review_status
    FROM legacy_import_items item
    LEFT JOIN import_jobs job ON job.id = item.job_id AND job.type = 'legacy'
    WHERE item.id = ? AND (? = 1 OR job.created_by = ?)
  `).bind(
    id,
    c.get('userRole') === 'owner' ? 1 : 0,
    c.get('userId')!,
  ).first<{
    id: string
    status: string
    review_status: string
  }>()
  if (!item) {
    return errorJson(c, 404, '条目不存在')
  }
  if (item.status !== 'imported') return errorJson(c, 409, '只有完整导入的条目可以审核')
  if (item.review_status !== 'pending') {
    if (item.review_status === body.reviewStatus) {
      return c.json({ success: true, replayed: true, galleryPublished: false })
    }
    return errorJson(c, 409, '审核结论已经形成，不能原地改写')
  }

  const auditId = generateId('log')
  const batch = await db.batch([
    db.prepare(`
      UPDATE legacy_import_items
      SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now')
      WHERE id = ? AND status = 'imported' AND review_status = 'pending'
    `).bind(body.reviewStatus, note || null, c.get('userId')!, id),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value
      )
      SELECT ?, ?, 'review_legacy_import_item', 'legacy_import_item', ?, ?, ?
      WHERE changes() = 1
    `).bind(
      auditId,
      c.get('userId')!,
      id,
      JSON.stringify({ reviewStatus: item.review_status }),
      JSON.stringify({ reviewStatus: body.reviewStatus, note: note || null }),
    ),
  ])
  if (Number(batch[0]?.meta?.changes ?? 0) !== 1) {
    return errorJson(c, 409, '审核状态已变化，请刷新后重试')
  }

  // 迁移审核只确认条目可进入正常内容工作流；Gallery 必须继续保持草稿并独立发布。
  return c.json({ success: true, replayed: false, galleryPublished: false })
})

/**
 * POST /jobs/:id/execute — 执行迁移任务
 * 从 WP REST API 拉取文章 → 解析 → 映射 → 写入数据库
 */
adminLegacyImportRoutes.post('/jobs/:id/execute', async (c) => {
  const db = c.env.DB
  const jobId = c.req.param('id')
  const adminId = c.get('userId')!

  // 获取任务和来源信息
  const job = await db
    .prepare(`
      SELECT *
      FROM import_jobs
      WHERE id = ? AND type = 'legacy' AND (? = 1 OR created_by = ?)
    `)
    .bind(jobId, c.get('userRole') === 'owner' ? 1 : 0, adminId)
    .first<{ id: string; status: string; source_key: string }>()

  if (!job) return errorJson(c, 404, '任务不存在')
  if (job.status !== 'pending' && job.status !== 'queued') {
    return errorJson(c, 400, '任务状态不允许执行')
  }

  const source = await db
    .prepare('SELECT * FROM legacy_import_sources WHERE id = ?')
    .bind(job.source_key)
    .first<{
      id: string
      base_url: string
      mode: string
      category_mapping: string | null
      tag_mapping: string | null
    }>()

  if (!source) return errorJson(c, 404, '来源不存在')
  if (source.mode !== 'rest_api') {
    return errorJson(c, 409, '当前任务来源不是可执行的 WordPress REST API 模式')
  }
  let mappingOverrides: Awaited<ReturnType<typeof loadLegacyMappingOverrides>>
  try {
    mappingOverrides = await loadLegacyMappingOverrides(
      db,
      source.category_mapping,
      source.tag_mapping,
    )
  } catch (error) {
    return errorJson(
      c,
      409,
      error instanceof Error ? error.message : '来源映射无法执行',
    )
  }

  // 条件领取，阻止两个管理员同时执行同一旧站任务。
  const processingToken = crypto.randomUUID()
  const claimBatch = await db.batch([
    db.prepare(`
      UPDATE import_jobs
      SET status = 'processing',
          started_at = COALESCE(started_at, datetime('now')),
          updated_at = datetime('now'),
          attempt_count = attempt_count + 1,
          processing_requested_by = ?,
          legacy_processing_token = ?,
          legacy_processing_expires_at = datetime('now', ?),
          last_error_code = NULL,
          last_error_message = NULL
      WHERE id = ? AND type = 'legacy' AND status = ?
        AND NOT EXISTS (
          SELECT 1
          FROM import_jobs active_job
          WHERE active_job.type = 'legacy'
            AND active_job.source_key = import_jobs.source_key
            AND active_job.status = 'processing'
            AND active_job.id <> import_jobs.id
        )
    `).bind(
      adminId,
      processingToken,
      LEGACY_PROCESSING_LEASE_MODIFIER,
      jobId,
      job.status,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value
      )
      SELECT ?, ?, 'claim_legacy_import_job', 'import_job', ?, ?, ?
      WHERE changes() = 1
    `).bind(
      generateId('log'),
      adminId,
      jobId,
      JSON.stringify({ status: job.status }),
      JSON.stringify({ status: 'processing' }),
    ),
  ])
  if (Number(claimBatch[0]?.meta?.changes ?? 0) !== 1) {
    return errorJson(c, 409, '迁移任务或同一来源的其他任务已开始处理')
  }

  let observedTotalPosts = 0
  let processedCount = 0
  let skippedDuplicateCount = 0
  let successCount = 0
  let failureCount = 0

  try {
    // 拉取 WP 数据
    const renewLeaseAfterWpPage = async () => {
      await renewLegacyProcessingLease(db, jobId, processingToken)
    }
    const { posts, totalPosts } = await fetchAllPosts({
      baseUrl: source.base_url,
      perPage: 50,
      onPage: renewLeaseAfterWpPage,
    })
    observedTotalPosts = totalPosts
    const categories = await fetchAllCategories(source.base_url, renewLeaseAfterWpPage)
    const tags = await fetchAllTags(source.base_url, renewLeaseAfterWpPage)

    // 获取已有 slugs 避免重复
    const existingResult = await db.prepare('SELECT slug FROM galleries').all<{ slug: string }>()
    const existingSlugs = new Set(existingResult.results.map(r => r.slug))
    const existingLegacyItems = await db.prepare(`
      SELECT legacy_post_id
      FROM legacy_import_items
      WHERE source_id = ? AND status = 'imported'
    `).bind(source.id).all<{ legacy_post_id: number }>()
    const existingLegacyPostIds = new Set(
      existingLegacyItems.results.map(item => Number(item.legacy_post_id)),
    )

    // 处理文章
    const migrationResult = processPosts(
      posts,
      categories,
      tags,
      existingSlugs,
      existingLegacyPostIds,
      mappingOverrides,
    )
    processedCount = migrationResult.items.length
    skippedDuplicateCount = migrationResult.skippedDuplicates

    // 逐条写入
    const errors: Array<{ title: string; errorCode: string; error: string }> = []

    for (const [index, item] of migrationResult.items.entries()) {
      if (index % LEGACY_LEASE_HEARTBEAT_ITEMS === 0) {
        await renewLegacyProcessingLease(db, jobId, processingToken)
      }
      const writeResult = await writeMigrationItem(db, item, source.id, jobId, adminId)
      if (writeResult.success) {
        successCount++
      } else {
        await writeFailedMigrationItem(
          db,
          item,
          source.id,
          jobId,
          adminId,
          source.base_url,
          writeResult,
        )
        failureCount++
        errors.push({
          title: item.galleryData.title,
          errorCode: writeResult.errorCode,
          error: writeResult.error,
        })
      }
    }

    // 更新任务状态
    const totalCount = processedCount + skippedDuplicateCount
    const finalStatus = migrationResult.items.length > 0
      && failureCount === migrationResult.items.length
      ? 'failed'
      : 'completed'

    await renewLegacyProcessingLease(db, jobId, processingToken)
    const completionBatch = await db.batch([
      db.prepare(`
        UPDATE import_jobs
        SET status = ?, total_count = ?, success_count = ?, failure_count = ?,
            updated_at = datetime('now'), completed_at = datetime('now'),
            legacy_processing_token = NULL, legacy_processing_expires_at = NULL,
            last_error_code = ?, last_error_message = ?
        WHERE id = ? AND type = 'legacy' AND status = 'processing'
          AND legacy_processing_token = ?
          AND legacy_processing_expires_at > datetime('now')
      `)
      .bind(
        finalStatus,
        totalCount,
        successCount,
        failureCount,
        finalStatus === 'failed' ? 'LEGACY_IMPORT_ALL_ITEMS_FAILED' : null,
        finalStatus === 'failed' ? '所有待迁移条目均写入失败' : null,
        jobId,
        processingToken,
      ),
      conditionalLegacyJobAuditStatement(db, {
        adminId,
        action: 'execute_legacy_import',
        jobId,
        beforeValue: { status: 'processing' },
        afterValue: {
          status: finalStatus,
          totalPosts: observedTotalPosts,
          processed: processedCount,
          skippedDuplicates: skippedDuplicateCount,
          successCount,
          failureCount,
        },
      }),
    ])
    if (Number(completionBatch[0]?.meta?.changes ?? 0) !== 1) {
      throw new LegacyImportLeaseLostError()
    }

    return c.json({
      status: finalStatus,
      totalPosts: observedTotalPosts,
      processed: processedCount,
      skippedDuplicates: skippedDuplicateCount,
      successCount,
      failureCount,
      errors: errors.length > 0 ? errors.slice(0, 50) : undefined,
    })
  } catch (err: unknown) {
    const leaseLost = err instanceof LegacyImportLeaseLostError
    const executionErrorCode = leaseLost
      ? 'LEGACY_IMPORT_PROCESSING_LEASE_EXPIRED'
      : 'LEGACY_IMPORT_EXECUTION_FAILED'
    const executionErrorMessage = leaseLost
      ? '旧站迁移执行租约已过期，请创建新任务安全重试'
      : '旧站迁移执行失败，请查看审计事件并安全重试'
    console.error(JSON.stringify({
      event: 'legacy_import_execution_failed',
      jobId,
      errorName: err instanceof Error ? err.name : 'UnknownError',
      errorCode: executionErrorCode,
    }))
    const failureBatch = await db.batch([
      db.prepare(`
        UPDATE import_jobs
        SET status = 'failed', total_count = ?, success_count = ?, failure_count = ?,
            updated_at = datetime('now'), completed_at = datetime('now'),
            legacy_processing_token = NULL, legacy_processing_expires_at = NULL,
            last_error_code = ?, last_error_message = ?
        WHERE id = ? AND type = 'legacy' AND status = 'processing'
          AND legacy_processing_token = ?
      `)
        .bind(
          observedTotalPosts,
          successCount,
          failureCount,
          executionErrorCode,
          executionErrorMessage,
          jobId,
          processingToken,
        ),
      conditionalLegacyJobAuditStatement(db, {
        adminId,
        action: 'execute_legacy_import_failed',
        jobId,
        beforeValue: { status: 'processing' },
        afterValue: {
          status: 'failed',
          errorCode: executionErrorCode,
          totalPosts: observedTotalPosts,
          processed: processedCount,
          skippedDuplicates: skippedDuplicateCount,
          successCount,
          failureCount,
        },
      }),
    ])
    if (Number(failureBatch[0]?.meta?.changes ?? 0) !== 1) {
      return errorJson(c, 409, '迁移任务处理租约已失效，请刷新任务状态')
    }
    if (leaseLost) {
      return errorJson(c, 409, '迁移任务处理租约已过期，请创建新任务安全重试')
    }
    return errorJson(c, 500, '迁移执行失败，请查看任务错误与审计事件')
  }
})

/**
 * POST /download-pending — 批量下载待处理媒体（不依赖 job_id）
 * 供本地迁移脚本循环调用
 * query: ?limit=10 （每次处理的数量，默认 10）
 * 图片并行下载（5 并发），视频跳过（需要配置 Stream）
 */
adminLegacyImportRoutes.post('/download-pending', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const limit = Math.min(
    MAX_MEDIA_DOWNLOAD_LIMIT,
    positiveInteger(c.req.query('limit'), DEFAULT_MEDIA_DOWNLOAD_LIMIT),
  )
  const createdBy = c.get('userRole') === 'owner' ? undefined : adminId
  const result = await downloadPendingLegacyImages(db, c.env.R2, limit, adminId, { createdBy })

  await writeAuditLog(db, {
    adminId,
    action: 'legacy_media_download_pending',
    targetType: 'media_asset',
    afterValue: {
      limit,
      scope: createdBy === undefined ? 'all_legacy' : 'own_legacy',
      ...legacyMediaAuditSummary(result),
    },
  })

  return c.json(result)
})

// ============================================================
// 迁移辅助工具
// ============================================================

/**
 * GET /migrate/status — 迁移资源状态概览
 * 返回图片/视频各状态数量 + 无封面图库数量
 */
adminLegacyImportRoutes.get('/migrate/status', async (c) => {
  const db = c.env.DB
  const createdBy = c.get('userRole') === 'owner' ? undefined : c.get('userId')!
  const mediaScope = legacyGalleryScope('asset.gallery_id', createdBy)
  const galleryScope = legacyGalleryScope('gallery.id', createdBy)

  const [mediaStats, coverStats, totalGalleries] = await Promise.all([
    db
      .prepare(`
        SELECT asset.type, asset.upload_status, COUNT(*) as cnt
        FROM media_assets asset
        WHERE ${mediaScope.sql}
        GROUP BY asset.type, asset.upload_status
      `)
      .bind(...mediaScope.bindings)
      .all<{ type: string; upload_status: string; cnt: number }>(),
    db
      .prepare(`
        SELECT COUNT(*) as cnt
        FROM galleries gallery
        WHERE gallery.cover_key IS NULL AND ${galleryScope.sql}
      `)
      .bind(...galleryScope.bindings)
      .first<{ cnt: number }>(),
    db
      .prepare(`
        SELECT COUNT(*) as cnt
        FROM galleries gallery
        WHERE ${galleryScope.sql}
      `)
      .bind(...galleryScope.bindings)
      .first<{ cnt: number }>(),
  ])

  // 整理统计
  const stats: Record<string, Record<string, number>> = {}
  for (const row of mediaStats.results) {
    if (!stats[row.type]) stats[row.type] = {}
    stats[row.type]![row.upload_status] = row.cnt
  }

  return c.json({
    media: stats,
    galleries: {
      total: totalGalleries?.cnt ?? 0,
      withoutCover: coverStats?.cnt ?? 0,
    },
  })
})

/**
 * POST /migrate/retry-failed — 重置失败的图片为 pending，可被 download-pending 重新处理
 * 前提：失败图片的 r2_key 仍保留原始外部 URL
 */
adminLegacyImportRoutes.post('/migrate/retry-failed', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const createdBy = c.get('userRole') === 'owner' ? undefined : adminId
  const scope = legacyGalleryScope('media_assets.gallery_id', createdBy)
  const failedWhere = `
    upload_status = 'failed'
    AND type = 'image'
    AND r2_key LIKE 'https://%'
    AND ${scope.sql}
  `

  // 确认失败图片的 r2_key 仍是外部 URL
  const failedCount = await db
    .prepare(`SELECT COUNT(*) as cnt FROM media_assets WHERE ${failedWhere}`)
    .bind(...scope.bindings)
    .first<{ cnt: number }>()

  if (!failedCount?.cnt) {
    return c.json({ message: '无失败图片', reset: 0 })
  }

  // 重置为 pending
  const auditId = generateId('log')
  const auditScope = createdBy === undefined ? 'all_legacy' : 'own_legacy'
  const batch = await db.batch([
    db.prepare(`UPDATE media_assets SET upload_status = 'pending' WHERE ${failedWhere}`)
      .bind(...scope.bindings),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value
      )
      SELECT ?, ?, 'retry_failed_media', 'media_asset', NULL, NULL, ?
      WHERE changes() > 0
    `).bind(
      auditId,
      adminId,
      JSON.stringify({ scope: auditScope, eligibleCount: Number(failedCount.cnt) }),
    ),
  ])
  const resetCount = Number(batch[0]?.meta?.changes ?? 0)

  return c.json({
    message: `已重置 ${resetCount} 张失败图片为待下载状态`,
    reset: resetCount,
  })
})

/**
 * POST /migrate/set-covers — 批量为无封面图库设置封面
 * 每个图库取 sort_order 最小的已完成图片作为封面
 * query: ?limit=100 （每次处理数量，默认 100）
 */
adminLegacyImportRoutes.post('/migrate/set-covers', async (c) => {
  const db = c.env.DB
  const adminId = c.get('userId')!
  const createdBy = c.get('userRole') === 'owner' ? undefined : adminId
  const limit = Math.min(500, positiveInteger(c.req.query('limit'), 100))
  const galleryScope = legacyGalleryScope('gallery.id', createdBy)

  // 找出无封面的图库
  const galleries = await db
    .prepare(`
      SELECT gallery.id FROM galleries gallery
      WHERE gallery.cover_key IS NULL AND ${galleryScope.sql}
      ORDER BY gallery.created_at ASC, gallery.id ASC
      LIMIT ?
    `)
    .bind(...galleryScope.bindings, limit)
    .all<{ id: string }>()

  if (galleries.results.length === 0) {
    const remaining = await db
      .prepare(`
        SELECT COUNT(*) as cnt
        FROM galleries gallery
        WHERE gallery.cover_key IS NULL AND ${galleryScope.sql}
      `)
      .bind(...galleryScope.bindings)
      .first<{ cnt: number }>()
    return c.json({ updated: 0, remaining: remaining?.cnt ?? 0, done: true })
  }

  const coverUpdates: Array<{ galleryId: string; r2Key: string }> = []
  let skipped = 0

  for (const gallery of galleries.results) {
    // 取该图库的第一张已完成的图片
    const firstImage = await db
      .prepare(`
        SELECT r2_key FROM media_assets
        WHERE gallery_id = ? AND type = 'image' AND upload_status = 'completed'
          AND r2_key IS NOT NULL AND r2_key NOT LIKE 'http%'
        ORDER BY sort_order ASC, created_at ASC
        LIMIT 1
      `)
      .bind(gallery.id)
      .first<{ r2_key: string }>()

    if (firstImage?.r2_key) {
      coverUpdates.push({ galleryId: gallery.id, r2Key: firstImage.r2_key })
    } else {
      skipped++ // 该图库没有已完成的 R2 图片
    }
  }

  const updateStatements = coverUpdates.map(update => db.prepare(`
    UPDATE galleries
    SET cover_key = ?, updated_at = datetime('now')
    WHERE id = ? AND cover_key IS NULL
  `).bind(update.r2Key, update.galleryId))
  const batch = await db.batch([
    ...updateStatements,
    legacyAuditStatement(db, {
      adminId,
      action: 'batch_set_covers',
      targetType: 'gallery',
      afterValue: {
        scope: createdBy === undefined ? 'all_legacy' : 'own_legacy',
        selectedCount: galleries.results.length,
        candidateCount: coverUpdates.length,
        skippedNoImage: skipped,
      },
    }),
  ])
  const updated = batch
    .slice(0, updateStatements.length)
    .reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0)

  const remaining = await db
    .prepare(`
      SELECT COUNT(*) as cnt
      FROM galleries gallery
      WHERE gallery.cover_key IS NULL AND ${galleryScope.sql}
    `)
    .bind(...galleryScope.bindings)
    .first<{ cnt: number }>()

  return c.json({
    updated,
    skipped,
    remaining: remaining?.cnt ?? 0,
    done: (remaining?.cnt ?? 0) === 0,
  })
})

async function downloadPendingLegacyImages(
  db: D1Database,
  r2: R2Bucket,
  limit: number,
  adminId: number,
  visibility: { jobId?: string; createdBy?: number } = {},
) {
  const jobCondition = visibility.jobId ? 'AND item.job_id = ?' : ''
  const createdByCondition = visibility.createdBy === undefined ? '' : 'AND job.created_by = ?'
  const scopeBindings: unknown[] = []
  if (visibility.jobId) scopeBindings.push(visibility.jobId)
  if (visibility.createdBy !== undefined) scopeBindings.push(visibility.createdBy)
  const scope = `
    asset.upload_status = 'pending'
    AND asset.r2_key IS NOT NULL
    AND asset.type = 'image'
    AND EXISTS (
      SELECT 1
      FROM legacy_import_items item
      JOIN import_jobs job ON job.id = item.job_id AND job.type = 'legacy'
      WHERE item.gallery_id = asset.gallery_id
        AND item.status = 'imported'
        ${jobCondition}
        ${createdByCondition}
    )
  `
  const assets = await db.prepare(`
    SELECT asset.id, asset.gallery_id, asset.type, asset.r2_key
    FROM media_assets asset
    WHERE ${scope}
    ORDER BY asset.created_at ASC, asset.id ASC
    LIMIT ?
  `).bind(...scopeBindings, limit).all<PendingLegacyImage>()

  let downloaded = 0
  let failed = 0
  let skipped = 0
  const errors: string[] = []
  const concurrency = 5
  for (let index = 0; index < assets.results.length; index += concurrency) {
    const batch = assets.results.slice(index, index + concurrency)
    const outcomes = await Promise.allSettled(batch.map(async (asset) => {
      const result = await downloadImageToR2(r2, asset.r2_key, asset.gallery_id, asset.id)
      if (result.success && result.r2Key) {
        const stateBatch = await db.batch([
          db.prepare(`
            UPDATE media_assets
            SET r2_key = ?, upload_status = 'completed'
            WHERE id = ? AND upload_status = 'pending' AND r2_key = ?
          `).bind(result.r2Key, asset.id, asset.r2_key),
          conditionalLegacyMediaAuditStatement(
            db,
            adminId,
            asset.id,
            'legacy_media_download_completed',
            { status: 'completed' },
          ),
        ])
        return Number(stateBatch[0]?.meta?.changes ?? 0) === 1
          ? { state: 'downloaded' as const }
          : { state: 'skipped' as const }
      }

      const stateBatch = await db.batch([
        db.prepare(`
          UPDATE media_assets
          SET upload_status = 'failed'
          WHERE id = ? AND upload_status = 'pending' AND r2_key = ?
        `).bind(asset.id, asset.r2_key),
        conditionalLegacyMediaAuditStatement(
          db,
          adminId,
          asset.id,
          'legacy_media_download_failed',
          {
            status: 'failed',
            errorCode: result.errorCode ?? 'LEGACY_MEDIA_REMOTE_DOWNLOAD_FAILED',
          },
        ),
      ])
      return Number(stateBatch[0]?.meta?.changes ?? 0) === 1
        ? {
            state: 'failed' as const,
            error: `${asset.id}: ${result.error ?? '远程图片下载失败'}`,
          }
        : { state: 'skipped' as const }
    }))

    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        skipped += 1
        errors.push('媒体状态更新失败，请稍后重试')
      }
      else if (outcome.value.state === 'downloaded') downloaded += 1
      else if (outcome.value.state === 'failed') {
        failed += 1
        errors.push(outcome.value.error)
      }
      else skipped += 1
    }
  }

  const remainingResult = await db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM media_assets asset
    WHERE ${scope}
  `).bind(...scopeBindings).first<{ cnt: number }>()
  const remaining = Number(remainingResult?.cnt ?? 0)
  return {
    galleries: new Set(assets.results.map(asset => asset.gallery_id)).size,
    selectedCount: assets.results.length,
    downloaded,
    failed,
    skipped,
    remaining,
    done: remaining === 0,
    errors: errors.slice(0, 10),
  }
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function renewLegacyProcessingLease(
  db: D1Database,
  jobId: string,
  processingToken: string,
) {
  const result = await db.prepare(`
    UPDATE import_jobs
    SET legacy_processing_expires_at = datetime('now', ?),
        updated_at = datetime('now')
    WHERE id = ? AND type = 'legacy' AND status = 'processing'
      AND legacy_processing_token = ?
      AND legacy_processing_expires_at > datetime('now')
  `).bind(
    LEGACY_PROCESSING_LEASE_MODIFIER,
    jobId,
    processingToken,
  ).run()
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new LegacyImportLeaseLostError()
  }
}

function legacyGalleryScope(galleryIdExpression: string, createdBy?: number) {
  const createdByCondition = createdBy === undefined ? '' : 'AND job.created_by = ?'
  return {
    sql: `EXISTS (
      SELECT 1
      FROM legacy_import_items item
      JOIN import_jobs job ON job.id = item.job_id AND job.type = 'legacy'
      WHERE item.gallery_id = ${galleryIdExpression}
        AND item.status = 'imported'
        ${createdByCondition}
    )`,
    bindings: createdBy === undefined ? [] : [createdBy],
  }
}

function legacyMediaAuditSummary(result: Awaited<ReturnType<typeof downloadPendingLegacyImages>>) {
  return {
    galleries: result.galleries,
    selectedCount: result.selectedCount,
    downloaded: result.downloaded,
    failed: result.failed,
    skipped: result.skipped,
    remaining: result.remaining,
    done: result.done,
    errorCount: result.errors.length,
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json()
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function normalizedString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null
}

function normalizeLegacyMapping(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw new Error(`${label}必须是对象`)
  const entries = Object.entries(value)
  if (entries.length > MAX_MAPPING_ENTRIES) {
    throw new Error(`${label}不能超过 ${MAX_MAPPING_ENTRIES} 项`)
  }
  const normalized: Record<string, string> = {}
  for (const [wpId, targetId] of entries) {
    if (!/^[1-9]\d*$/.test(wpId) || typeof targetId !== 'string') {
      throw new Error(`${label}必须使用正整数 WordPress ID 映射到标签 ID`)
    }
    const trimmedTargetId = targetId.trim()
    if (!trimmedTargetId || trimmedTargetId.length > 128) {
      throw new Error(`${label}中的标签 ID 不正确`)
    }
    normalized[wpId] = trimmedTargetId
  }
  return entries.length > 0 ? JSON.stringify(normalized) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function conditionalLegacyMediaAuditStatement(
  db: D1Database,
  adminId: number,
  assetId: string,
  action: string,
  afterValue: Record<string, unknown>,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, ?, 'media_asset', ?, NULL, ?
    WHERE changes() = 1
  `).bind(
    generateId('log'),
    adminId,
    action,
    assetId,
    JSON.stringify(afterValue),
  )
}

function legacyAuditStatement(
  db: D1Database,
  params: {
    adminId: number
    action: string
    targetType: string
    targetId?: string
    afterValue?: unknown
  },
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    ) VALUES (?, ?, ?, ?, ?, NULL, ?)
  `).bind(
    generateId('log'),
    params.adminId,
    params.action,
    params.targetType,
    params.targetId ?? null,
    params.afterValue === undefined ? null : JSON.stringify(params.afterValue),
  )
}

function conditionalLegacyJobAuditStatement(
  db: D1Database,
  params: {
    adminId: number
    action: string
    jobId: string
    beforeValue: unknown
    afterValue: unknown
  },
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, ?, 'import_job', ?, ?, ?
    WHERE changes() = 1
  `).bind(
    generateId('log'),
    params.adminId,
    params.action,
    params.jobId,
    JSON.stringify(params.beforeValue),
    JSON.stringify(params.afterValue),
  )
}
