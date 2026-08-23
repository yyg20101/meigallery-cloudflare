import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { IMPORT_PACKAGE_LIMITS, PAGINATION } from '@meigallery/shared/constants'
import type { Bindings, Variables } from '../../index'
import {
  AdminZipImportError,
  completeZipImportPackageUpload,
  initializeZipImportPackageUpload,
  resumePausedZipImportJob,
  retryFailedZipImportItems,
  startZipImportJob,
  uploadZipImportPackagePart,
  type ZipImportActor,
} from '../../services/admin-zip-import'
import { generateId } from '../../utils/db'
import { isExpectedImportErrorReportKey } from '../../utils/import-report-key'
import { validateTurnstile } from '../../utils/turnstile'

export const adminImportRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
type AdminImportContext = Context<{ Bindings: Bindings; Variables: Variables }>

const RUNNING_IMPORT_STATUSES = ['validating', 'processing', 'finalizing'] as const
const FILTERABLE_IMPORT_STATUSES = new Set([
  'pending',
  'queued',
  'uploading',
  ...RUNNING_IMPORT_STATUSES,
  'partial_failure',
  'paused',
  'completed',
  'failed',
])

/** 导入任务列表。Owner 可查看全部任务，Admin 只查看自己创建的任务。 */
adminImportRoutes.get('/', async (c) => {
  const page = positiveInteger(c.req.query('page'), 1)
  const pageSize = Math.min(PAGINATION.MAX_PAGE_SIZE, positiveInteger(c.req.query('pageSize'), 20))
  const offset = (page - 1) * pageSize
  const requestedType = c.req.query('type')?.trim()
  const requestedStatus = c.req.query('status')?.trim()
  if (requestedType && !['zip', 'legacy'].includes(requestedType)) {
    return c.json({ statusCode: 400, code: 'IMPORT_TYPE_INVALID', message: '导入任务类型不正确' }, 400)
  }
  if (requestedStatus && !FILTERABLE_IMPORT_STATUSES.has(requestedStatus)) {
    return c.json({ statusCode: 400, code: 'IMPORT_STATUS_INVALID', message: '导入任务状态不正确' }, 400)
  }

  const conditions: string[] = []
  const bindings: Array<string | number> = []
  if (c.get('userRole') !== 'owner') {
    conditions.push('ij.created_by = ?')
    bindings.push(c.get('userId')!)
  }
  if (requestedType) {
    conditions.push('ij.type = ?')
    bindings.push(requestedType)
  }
  if (requestedStatus) {
    conditions.push('ij.status = ?')
    bindings.push(requestedStatus)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await c.env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM import_jobs ij
    ${where}
  `).bind(...bindings).first<{ total: number }>()
  const jobs = await c.env.DB.prepare(`
    SELECT ij.id, ij.type, ij.status, ij.source_name, ij.package_size,
           ij.total_count, ij.success_count, ij.failure_count,
           ij.created_by, u.email AS creator_email,
           ij.created_at, ij.uploaded_at, ij.started_at, ij.updated_at, ij.completed_at,
           ij.last_error_code, ij.last_error_message,
           CASE WHEN ij.package_etag IS NOT NULL AND ij.multipart_upload_id IS NULL THEN 1 ELSE 0 END AS package_uploaded,
           CASE WHEN ij.error_report_key IS NULL THEN 0 ELSE 1 END AS has_error_report
    FROM import_jobs ij
    JOIN users u ON u.id = ij.created_by
    ${where}
    ORDER BY COALESCE(ij.updated_at, ij.created_at) DESC, ij.id DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, pageSize, offset).all()

  return c.json({
    data: jobs.results.map(serializeImportJob),
    total: Number(countResult?.total ?? 0),
    page,
    pageSize,
  })
})

/** 任务详情只返回展示字段和逐项结果，不暴露私有 R2 key。 */
adminImportRoutes.get('/:id', async (c) => {
  const jobId = c.req.param('id')
  const owner = c.get('userRole') === 'owner'
  const job = await c.env.DB.prepare(`
    SELECT ij.id, ij.type, ij.status, ij.source_name, ij.package_size,
           ij.total_count, ij.success_count, ij.failure_count,
           ij.created_by, u.email AS creator_email,
           ij.created_at, ij.uploaded_at, ij.started_at, ij.updated_at, ij.completed_at,
           ij.attempt_count, ij.last_error_code, ij.last_error_message,
           CASE WHEN ij.package_etag IS NOT NULL AND ij.multipart_upload_id IS NULL THEN 1 ELSE 0 END AS package_uploaded,
           CASE WHEN ij.error_report_key IS NULL THEN 0 ELSE 1 END AS has_error_report
    FROM import_jobs ij
    JOIN users u ON u.id = ij.created_by
    WHERE ij.id = ? AND (? = 1 OR ij.created_by = ?)
  `).bind(jobId, owner ? 1 : 0, c.get('userId')!).first<Record<string, unknown>>()
  if (!job) return c.json({ statusCode: 404, code: 'IMPORT_JOB_NOT_FOUND', message: '导入任务不存在' }, 404)

  const items = job.type === 'zip'
    ? await c.env.DB.prepare(`
        SELECT id, folder, title, slug, status, stage, retryable, gallery_id, attempt_count,
               COALESCE(json_array_length(manifest_json, '$.imagePaths'), 0) AS image_count,
               COALESCE(json_array_length(manifest_json, '$.videoPaths'), 0) AS video_count,
               error_code, error_message, created_at, updated_at
        FROM import_job_items
        WHERE job_id = ?
        ORDER BY folder ASC
      `).bind(jobId).all()
    : { results: [] }

  return c.json({
    ...serializeImportJob(job),
    items: items.results,
  })
})

/** 创建一个等待 ZIP 上传的任务。 */
adminImportRoutes.post('/', async (c) => {
  const body = await readJsonObject(c)
  const turnstileError = await validateTurnstile(c.env, optionalString(body.turnstileToken))
  if (turnstileError) return c.json(turnstileError.body, turnstileError.status)

  const processing = await c.env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM import_jobs
    WHERE status IN (${RUNNING_IMPORT_STATUSES.map(() => '?').join(', ')})
  `).bind(...RUNNING_IMPORT_STATUSES).first<{ count: number }>()
  if (Number(processing?.count ?? 0) >= IMPORT_PACKAGE_LIMITS.MAX_ACTIVE_JOBS) {
    return c.json({
      statusCode: 429,
      code: 'IMPORT_CONCURRENCY_LIMIT',
      message: `当前已有 ${IMPORT_PACKAGE_LIMITS.MAX_ACTIVE_JOBS} 个导入任务在执行，请等待后再创建`,
    }, 429)
  }

  const adminId = c.get('userId')!
  const jobId = generateId('imp')
  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO import_jobs (
        id, type, status, total_count, success_count, failure_count,
        created_by, updated_at
      ) VALUES (?, 'zip', 'queued', 0, 0, 0, ?, datetime('now'))
    `).bind(jobId, adminId),
    auditStatement(c.env.DB, adminId, 'create_import', jobId, {
      type: 'zip',
      status: 'queued',
    }),
  ])

  return c.json({ id: jobId, status: 'queued', packageUploaded: false }, 201)
})

/** 初始化私有 R2 multipart；uploadId 只保存在服务端。 */
adminImportRoutes.post('/:id/package/init', async (c) => {
  const body = await readJsonObject(c)
  try {
    const result = await initializeZipImportPackageUpload(
      c.env,
      currentActor(c),
      c.req.param('id'),
      optionalString(body.sourceName) || '',
      Number(body.packageSize),
    )
    return c.json(result)
  }
  catch (error) {
    return zipImportErrorResponse(c, error)
  }
})

/** 单片流式经过 Worker 写入 R2；每片固定 8 MiB，末片除外。 */
adminImportRoutes.put('/:id/package/parts/:partNumber', async (c) => {
  const contentType = (c.req.header('content-type') || '').split(';', 1)[0]!.trim().toLowerCase()
  if (!['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(contentType)) {
    return c.json({ statusCode: 415, code: 'IMPORT_CONTENT_TYPE_INVALID', message: 'ZIP 分片类型不正确' }, 415)
  }
  const contentLength = Number(c.req.header('content-length') || c.req.header('x-import-part-size'))
  const uploadSession = (c.req.header('x-import-upload-session') || '').trim()
  if (!c.req.raw.body) {
    return c.json({ statusCode: 400, code: 'IMPORT_PART_EMPTY', message: 'ZIP 分片内容为空' }, 400)
  }

  try {
    const result = await uploadZipImportPackagePart(
      c.env,
      currentActor(c),
      c.req.param('id'),
      uploadSession,
      Number(c.req.param('partNumber')),
      contentLength,
      c.req.raw.body as ReadableStream<Uint8Array>,
    )
    return c.json(result)
  }
  catch (error) {
    return zipImportErrorResponse(c, error)
  }
})

/** 服务端使用持久化的分片 ETag 合并对象，不信任浏览器提交的 parts 清单。 */
adminImportRoutes.post('/:id/package/complete', async (c) => {
  const body = await readJsonObject(c)
  try {
    const result = await completeZipImportPackageUpload(
      c.env,
      currentActor(c),
      c.req.param('id'),
      optionalString(body.uploadSession) || '',
    )
    return c.json(result)
  }
  catch (error) {
    return zipImportErrorResponse(c, error)
  }
})

adminImportRoutes.post('/:id/process', async (c) => {
  const body = await readJsonObject(c)
  const turnstileError = await validateTurnstile(c.env, optionalString(body.turnstileToken))
  if (turnstileError) return c.json(turnstileError.body, turnstileError.status)
  try {
    return c.json(await startZipImportJob(c.env, currentActor(c), c.req.param('id')))
  }
  catch (error) {
    return zipImportErrorResponse(c, error)
  }
})

adminImportRoutes.post('/:id/retry', async (c) => {
  const body = await readJsonObject(c)
  const turnstileError = await validateTurnstile(c.env, optionalString(body.turnstileToken))
  if (turnstileError) return c.json(turnstileError.body, turnstileError.status)
  try {
    return c.json(await retryFailedZipImportItems(c.env, currentActor(c), c.req.param('id')))
  }
  catch (error) {
    return zipImportErrorResponse(c, error)
  }
})

adminImportRoutes.post('/:id/resume', async (c) => {
  const body = await readJsonObject(c)
  const turnstileError = await validateTurnstile(c.env, optionalString(body.turnstileToken))
  if (turnstileError) return c.json(turnstileError.body, turnstileError.status)
  try {
    return c.json(await resumePausedZipImportJob(c.env, currentActor(c), c.req.param('id')))
  }
  catch (error) {
    return zipImportErrorResponse(c, error)
  }
})

/** 下载服务器生成的逐项错误报告。 */
adminImportRoutes.get('/:id/errors', async (c) => {
  const jobId = c.req.param('id')
  const owner = c.get('userRole') === 'owner'
  const job = await c.env.DB.prepare(`
    SELECT error_report_key
    FROM import_jobs
    WHERE id = ? AND (? = 1 OR created_by = ?)
  `).bind(jobId, owner ? 1 : 0, c.get('userId')!).first<{ error_report_key: string | null }>()
  if (!job?.error_report_key || !isExpectedImportErrorReportKey(job.error_report_key, jobId)) {
    return c.json({ statusCode: 404, code: 'IMPORT_ERROR_REPORT_NOT_FOUND', message: '错误报告不存在' }, 404)
  }

  const object = await c.env.R2.get(job.error_report_key)
  if (!object?.body) {
    return c.json({ statusCode: 404, code: 'IMPORT_ERROR_REPORT_NOT_FOUND', message: '错误报告文件不存在' }, 404)
  }
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="import-errors-${jobId}.csv"`,
    'X-Content-Type-Options': 'nosniff',
  })
  return new Response(object.body, { headers })
})

function currentActor(c: AdminImportContext): ZipImportActor {
  return { adminId: c.get('userId')!, role: c.get('userRole')! }
}

function serializeImportJob(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    package_uploaded: Number(row.package_uploaded ?? 0) === 1,
    has_error_report: Number(row.has_error_report ?? 0) === 1,
  }
}

function auditStatement(
  db: D1Database,
  adminId: number,
  action: string,
  jobId: string,
  afterValue: unknown,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    ) VALUES (?, ?, ?, 'import_job', ?, NULL, ?)
  `).bind(generateId('log'), adminId, action, jobId, JSON.stringify(afterValue))
}

async function readJsonObject(c: AdminImportContext): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json<unknown>()
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  }
  catch {
    return {}
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function zipImportErrorResponse(c: AdminImportContext, error: unknown): Response {
  if (!(error instanceof AdminZipImportError)) throw error
  return c.json({
    statusCode: error.status,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  }, error.status as ContentfulStatusCode)
}
