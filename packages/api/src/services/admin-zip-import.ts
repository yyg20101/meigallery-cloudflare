import {
  IMPORT_PACKAGE_LIMITS,
  MEMBERSHIP_RANKS,
  R2_KEY_PREFIX,
} from '@meigallery/shared/constants'
import { generateId } from '../utils/db'
import { containsAsciiControlCharacter } from '../utils/text-safety'
import {
  isExpectedImportErrorReportKey,
  isExpectedImportPackageKey,
} from '../utils/import-report-key'
import {
  assertImageMatchesPath,
  assertMp4,
  decodeZipText,
  openZipArchive,
  prepareZipImportPackage,
  readZipEntry,
  sanitizeImportedImage,
  ZipImportError,
  type PreparedZipImportItem,
  type ZipManifestRow,
} from './admin-zip-package'

const MAX_ITEM_ATTEMPTS = 3
const IMPORT_QUEUE_KIND = 'zip_import'
export const ZIP_IMPORT_QUEUE_NAME = 'meigallery-import-zip'

export interface ZipImportQueueMessage {
  schemaVersion: 1
  kind: typeof IMPORT_QUEUE_KIND
  jobId: string
  runNumber: number
}

export interface ZipImportActor {
  adminId: number
  role: string
}

export interface ZipImportEnvironment {
  DB: D1Database
  R2: R2Bucket
  IMPORT_QUEUE?: Queue<ZipImportQueueMessage>
  STREAM_ACCOUNT_ID?: string
  STREAM_API_TOKEN?: string
}

export interface ZipImportCommandResult {
  id: string
  status: 'processing' | 'partial_failure' | 'completed' | 'paused'
  totalCount: number
  successCount: number
  failureCount: number
  message: string
}

export class AdminZipImportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'AdminZipImportError'
  }
}

type ImportJobRow = {
  id: string
  status: string
  source_key: string | null
  source_name: string | null
  package_size: number | null
  package_etag: string | null
  multipart_upload_id: string | null
  upload_session_id: string | null
  upload_part_size: number | null
  upload_part_count: number | null
  created_by: number
  attempt_count: number
  processing_requested_by: number | null
  error_report_key: string | null
  updated_at: string | null
}

type ImportItemRow = {
  id: string
  job_id: string
  folder: string
  title: string
  slug: string
  manifest_json: string
  status: string
  attempt_count: number
}

type StoredPreparedItem = Omit<PreparedZipImportItem, 'preflightError'>

type ResolvedTagDescriptor = {
  type: string
  name: string
  slug: string
} & (
  | { existingId: string; createId: null }
  | { existingId: null; createId: string }
)

type QueueMessageLike = {
  body: unknown
  attempts: number
  ack(): void
  retry(): void
}

type PauseJobGuard = {
  statuses: readonly string[]
  runNumber?: number
  uploadSession?: string
}

export async function initializeZipImportPackageUpload(
  env: ZipImportEnvironment,
  actor: ZipImportActor,
  jobId: string,
  sourceName: string,
  packageSize: number,
): Promise<{
  id: string
  status: 'uploading'
  uploadSession: string
  partSize: number
  partCount: number
  sourceName: string
}> {
  const normalizedSourceName = normalizeSourceName(sourceName)
  if (!Number.isSafeInteger(packageSize) || packageSize <= 0) {
    throw new AdminZipImportError(400, 'IMPORT_PACKAGE_SIZE_INVALID', 'ZIP 文件大小不正确')
  }
  if (packageSize > IMPORT_PACKAGE_LIMITS.MAX_ARCHIVE_BYTES) {
    throw new AdminZipImportError(413, 'IMPORT_PACKAGE_TOO_LARGE', 'ZIP 文件超过 256MB 上限')
  }

  const job = await loadImportJob(env.DB, jobId)
  await assertCanManageJob(env.DB, job, actor)
  if (!['queued', 'paused', 'uploading'].includes(job.status)) {
    throw new AdminZipImportError(409, 'IMPORT_PACKAGE_UPLOAD_CONFLICT', '当前任务状态不允许上传或替换 ZIP')
  }
  if (job.status === 'paused' || job.status === 'uploading') {
    const completed = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM import_job_items
      WHERE job_id = ? AND status = 'completed'
    `).bind(jobId).first<{ count: number }>()
    if (Number(completed?.count ?? 0) > 0) {
      throw new AdminZipImportError(
        409,
        'IMPORT_PACKAGE_REPLACEMENT_UNSAFE',
        '任务已有成功条目，不能替换原包；请继续任务或新建导入任务',
      )
    }
  }

  const uploadSession = crypto.randomUUID()
  const claim = await env.DB.prepare(`
    UPDATE import_jobs
    SET status = 'uploading', upload_session_id = ?, updated_at = datetime('now'),
        last_error_code = NULL, last_error_message = NULL
    WHERE id = ? AND status IN ('queued', 'paused', 'uploading')
  `).bind(uploadSession, jobId).run()
  if (!changed(claim)) {
    throw new AdminZipImportError(409, 'IMPORT_PACKAGE_UPLOAD_CONFLICT', '任务状态已变化，请刷新后重试')
  }

  const packageKey = `${R2_KEY_PREFIX.IMPORTS}/${jobId}/packages/${crypto.randomUUID()}.zip`
  const partSize = IMPORT_PACKAGE_LIMITS.MULTIPART_PART_BYTES
  const partCount = Math.ceil(packageSize / partSize)
  let multipart: R2MultipartUpload | null = null
  try {
    multipart = await env.R2.createMultipartUpload(packageKey, {
      httpMetadata: { contentType: 'application/zip' },
      customMetadata: { importJobId: jobId },
    })

    const statements = [
      env.DB.prepare(`
        UPDATE import_jobs
        SET source_key = ?, source_name = ?, package_size = ?, package_etag = NULL,
            multipart_upload_id = ?, upload_part_size = ?, upload_part_count = ?,
            uploaded_at = NULL, started_at = NULL, completed_at = NULL,
            total_count = 0, success_count = 0, failure_count = 0,
            error_report_key = NULL, processing_requested_by = NULL,
            last_error_code = NULL, last_error_message = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'uploading' AND upload_session_id = ?
      `).bind(
        packageKey,
        normalizedSourceName,
        packageSize,
        multipart.uploadId,
        partSize,
        partCount,
        jobId,
        uploadSession,
      ),
      env.DB.prepare(`
        DELETE FROM import_job_items
        WHERE job_id = ? AND EXISTS (
          SELECT 1 FROM import_jobs
          WHERE id = ? AND status = 'uploading' AND upload_session_id = ?
        )
      `).bind(jobId, jobId, uploadSession),
      env.DB.prepare(`
        DELETE FROM import_job_upload_parts
        WHERE job_id = ? AND EXISTS (
          SELECT 1 FROM import_jobs
          WHERE id = ? AND status = 'uploading' AND upload_session_id = ?
        )
      `).bind(jobId, jobId, uploadSession),
      auditImportUploadSessionStatement(env.DB, actor.adminId, jobId, uploadSession, 'initialize_import_upload', {
        sourceName: normalizedSourceName,
        packageSize,
        partSize,
        partCount,
      }),
    ]
    const results = await env.DB.batch(statements)
    if (!changed(results[0])) {
      throw new AdminZipImportError(409, 'IMPORT_UPLOAD_SESSION_REPLACED', '上传会话已被新的操作替换')
    }
  }
  catch (error) {
    if (multipart) await safeAbortMultipart(multipart)
    const normalized = error instanceof AdminZipImportError
      ? error
      : new AdminZipImportError(503, 'IMPORT_UPLOAD_INITIALIZE_FAILED', 'ZIP 分片上传初始化失败，请稍后重试', true)
    const current = await loadImportJob(env.DB, jobId).catch(() => null)
    if (current?.upload_session_id === uploadSession) {
      await pauseJob(env.DB, actor.adminId, jobId, normalized.code, normalized.message, {
        statuses: ['uploading'],
        uploadSession,
      })
    }
    throw normalized
  }

  if (job.multipart_upload_id && job.source_key && isExpectedImportPackageKey(job.source_key, jobId)) {
    await safeAbortMultipart(env.R2.resumeMultipartUpload(job.source_key, job.multipart_upload_id))
  }
  else if (job.source_key && isExpectedImportPackageKey(job.source_key, jobId)) {
    await safeDeleteR2(env.R2, job.source_key)
  }
  if (job.error_report_key && isExpectedImportErrorReportKey(job.error_report_key, jobId)) {
    await safeDeleteR2(env.R2, job.error_report_key)
  }

  return {
    id: jobId,
    status: 'uploading',
    uploadSession,
    partSize,
    partCount,
    sourceName: normalizedSourceName,
  }
}

export async function uploadZipImportPackagePart(
  env: ZipImportEnvironment,
  actor: ZipImportActor,
  jobId: string,
  uploadSession: string,
  partNumber: number,
  declaredSize: number,
  source: ReadableStream<Uint8Array>,
): Promise<{ partNumber: number; uploadedParts: number; partCount: number }> {
  const job = await loadImportJob(env.DB, jobId)
  await assertCanManageJob(env.DB, job, actor)
  assertMultipartUploadSession(job, uploadSession)
  const partSize = Number(job.upload_part_size)
  const partCount = Number(job.upload_part_count)
  const packageSize = Number(job.package_size)
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    throw new AdminZipImportError(400, 'IMPORT_PART_NUMBER_INVALID', 'ZIP 分片序号不正确')
  }
  const expectedSize = Math.min(partSize, packageSize - (partNumber - 1) * partSize)
  if (!Number.isSafeInteger(declaredSize) || declaredSize !== expectedSize) {
    throw new AdminZipImportError(400, 'IMPORT_PART_SIZE_INVALID', 'ZIP 分片大小与上传计划不一致')
  }

  let observedSize = 0
  let exceeded = false
  const countingStream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      observedSize += chunk.byteLength
      if (observedSize > expectedSize) {
        exceeded = true
        throw new Error('part_too_large')
      }
      controller.enqueue(chunk)
    },
  }))

  let uploadedPart: R2UploadedPart
  try {
    const multipart = env.R2.resumeMultipartUpload(job.source_key!, job.multipart_upload_id!)
    uploadedPart = await multipart.uploadPart(partNumber, countingStream)
  }
  catch {
    if (exceeded) {
      throw new AdminZipImportError(400, 'IMPORT_PART_SIZE_INVALID', 'ZIP 分片实际大小超过上传计划')
    }
    throw new AdminZipImportError(503, 'IMPORT_PART_UPLOAD_FAILED', 'ZIP 分片上传失败，请重试当前文件', true)
  }
  if (observedSize !== expectedSize || uploadedPart.partNumber !== partNumber || !uploadedPart.etag) {
    throw new AdminZipImportError(400, 'IMPORT_PART_SIZE_INVALID', 'ZIP 分片实际大小与上传计划不一致')
  }

  const statements = [
    env.DB.prepare(`
      INSERT INTO import_job_upload_parts (
        job_id, upload_session_id, part_number, etag, part_size, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, datetime('now'), datetime('now')
      WHERE EXISTS (
        SELECT 1 FROM import_jobs
        WHERE id = ? AND status = 'uploading' AND upload_session_id = ?
      )
      ON CONFLICT(job_id, upload_session_id, part_number) DO UPDATE SET
        etag = excluded.etag,
        part_size = excluded.part_size,
        updated_at = datetime('now')
    `).bind(
      jobId,
      uploadSession,
      partNumber,
      uploadedPart.etag,
      observedSize,
      jobId,
      uploadSession,
    ),
    env.DB.prepare(`
      UPDATE import_jobs SET updated_at = datetime('now')
      WHERE id = ? AND status = 'uploading' AND upload_session_id = ?
    `).bind(jobId, uploadSession),
    auditImportUploadPartStatement(env.DB, actor.adminId, jobId, uploadSession, partNumber, observedSize),
  ]
  const results = await env.DB.batch(statements)
  if (!changed(results[0]) || !changed(results[1])) {
    throw new AdminZipImportError(409, 'IMPORT_UPLOAD_SESSION_REPLACED', '上传会话已被新的操作替换')
  }
  const count = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM import_job_upload_parts
    WHERE job_id = ? AND upload_session_id = ?
  `).bind(jobId, uploadSession).first<{ count: number }>()
  return { partNumber, uploadedParts: Number(count?.count ?? 0), partCount }
}

export async function completeZipImportPackageUpload(
  env: ZipImportEnvironment,
  actor: ZipImportActor,
  jobId: string,
  uploadSession: string,
): Promise<{ id: string; status: 'queued'; packageSize: number; sourceName: string }> {
  const job = await loadImportJob(env.DB, jobId)
  await assertCanManageJob(env.DB, job, actor)
  assertMultipartUploadSession(job, uploadSession)
  const partCount = Number(job.upload_part_count)
  const partSize = Number(job.upload_part_size)
  const packageSize = Number(job.package_size)
  const rows = await env.DB.prepare(`
    SELECT part_number, etag, part_size
    FROM import_job_upload_parts
    WHERE job_id = ? AND upload_session_id = ?
    ORDER BY part_number ASC
  `).bind(jobId, uploadSession).all<{ part_number: number; etag: string; part_size: number }>()
  if (rows.results.length !== partCount) {
    throw new AdminZipImportError(409, 'IMPORT_PARTS_INCOMPLETE', 'ZIP 分片尚未全部上传', true)
  }
  let totalSize = 0
  const parts: R2UploadedPart[] = rows.results.map((part, index) => {
    const partNumber = index + 1
    const expectedSize = Math.min(partSize, packageSize - index * partSize)
    if (Number(part.part_number) !== partNumber || Number(part.part_size) !== expectedSize || !part.etag) {
      throw new AdminZipImportError(409, 'IMPORT_PARTS_INVALID', 'ZIP 分片清单不完整，请重新上传', true)
    }
    totalSize += Number(part.part_size)
    return { partNumber, etag: part.etag }
  })
  if (totalSize !== packageSize) {
    throw new AdminZipImportError(409, 'IMPORT_PARTS_SIZE_MISMATCH', 'ZIP 分片总大小不正确，请重新上传', true)
  }

  let object: R2Object | null
  try {
    object = await env.R2.head(job.source_key!)
  }
  catch {
    throw new AdminZipImportError(503, 'IMPORT_PACKAGE_HEAD_FAILED', '暂时无法确认 ZIP 合并状态，请稍后重试', true)
  }
  if (!object) {
    try {
      object = await env.R2.resumeMultipartUpload(job.source_key!, job.multipart_upload_id!).complete(parts)
    }
    catch {
      throw new AdminZipImportError(503, 'IMPORT_MULTIPART_COMPLETE_FAILED', 'ZIP 分片合并失败，请稍后重试', true)
    }
  }
  if (object.size !== packageSize || object.size > IMPORT_PACKAGE_LIMITS.MAX_ARCHIVE_BYTES) {
    await safeDeleteR2(env.R2, job.source_key!)
    await pauseJob(env.DB, actor.adminId, jobId, 'IMPORT_PACKAGE_SIZE_MISMATCH', 'ZIP 合并后的大小与上传计划不一致', {
      statuses: ['uploading'],
      uploadSession,
    })
    throw new AdminZipImportError(400, 'IMPORT_PACKAGE_SIZE_MISMATCH', 'ZIP 合并后的大小与上传计划不一致')
  }

  const completedAt = new Date().toISOString()
  const statements = [
    env.DB.prepare(`
      UPDATE import_jobs
      SET status = 'queued', package_etag = ?, multipart_upload_id = NULL,
          upload_session_id = NULL, upload_part_size = NULL, upload_part_count = NULL,
          uploaded_at = ?, updated_at = ?,
          last_error_code = NULL, last_error_message = NULL
      WHERE id = ? AND status = 'uploading' AND upload_session_id = ?
    `).bind(object.etag, completedAt, completedAt, jobId, uploadSession),
    auditCompletedImportUploadStatement(
      env.DB,
      actor.adminId,
      jobId,
      completedAt,
      object.etag,
      job.source_key!,
      {
        sourceName: job.source_name,
        packageSize,
        partCount,
        packageEtag: object.etag,
      },
    ),
    env.DB.prepare(`
      DELETE FROM import_job_upload_parts
      WHERE job_id = ? AND upload_session_id = ?
    `).bind(jobId, uploadSession),
  ]
  const results = await env.DB.batch(statements)
  if (!changed(results[0])) {
    const current = await loadImportJob(env.DB, jobId)
    if (current.status !== 'queued' || current.source_key !== job.source_key || !current.package_etag) {
      throw new AdminZipImportError(409, 'IMPORT_UPLOAD_SESSION_REPLACED', '上传会话已被新的操作替换')
    }
  }
  if (job.error_report_key && isExpectedImportErrorReportKey(job.error_report_key, jobId)) {
    await safeDeleteR2(env.R2, job.error_report_key)
  }
  return { id: jobId, status: 'queued', packageSize, sourceName: job.source_name! }
}

export async function startZipImportJob(
  env: ZipImportEnvironment,
  actor: ZipImportActor,
  jobId: string,
): Promise<ZipImportCommandResult> {
  const job = await loadImportJob(env.DB, jobId)
  await assertCanManageJob(env.DB, job, actor)
  if (job.status !== 'queued') {
    throw new AdminZipImportError(409, 'IMPORT_START_CONFLICT', '任务状态已变化，请刷新后重试')
  }
  assertUsablePackage(job)

  const claim = await env.DB.prepare(`
    UPDATE import_jobs
    SET status = 'validating', processing_requested_by = ?, started_at = COALESCE(started_at, datetime('now')),
        completed_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = datetime('now')
    WHERE id = ? AND status = 'queued'
      AND (
        SELECT COUNT(*) FROM import_jobs active
        WHERE active.id != ?
          AND active.status IN ('validating', 'processing', 'finalizing')
      ) < ?
  `).bind(actor.adminId, jobId, jobId, IMPORT_PACKAGE_LIMITS.MAX_ACTIVE_JOBS).run()
  if (!changed(claim)) {
    await throwImportClaimConflict(
      env.DB,
      jobId,
      ['queued'],
      'IMPORT_START_CONFLICT',
      '任务状态已变化，请刷新后重试',
    )
  }

  try {
    const prepared = await prepareZipImportPackage(env.R2, job.source_key!, Number(job.package_size))
    const runNumber = Number(job.attempt_count || 0) + 1
    const pendingCount = prepared.items.filter(item => !item.preflightError).length
    const failureCount = prepared.items.length - pendingCount
    const statements: D1PreparedStatement[] = [
      env.DB.prepare('DELETE FROM import_job_items WHERE job_id = ?').bind(jobId),
    ]
    for (const item of prepared.items) {
      statements.push(env.DB.prepare(`
        INSERT INTO import_job_items (
          id, job_id, folder, title, slug, manifest_json, status, stage, retryable,
          error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'preflight', 0, ?, ?, datetime('now'), datetime('now'))
      `).bind(
        generateId('impi'),
        jobId,
        item.row.folder,
        item.row.title,
        item.row.slug,
        JSON.stringify(toStoredPreparedItem(item)),
        item.preflightError ? 'failed' : 'pending',
        item.preflightError?.code ?? null,
        item.preflightError?.message ?? null,
      ))
    }
    const transitionIndex = statements.length
    statements.push(
      env.DB.prepare(`
        UPDATE import_jobs
        SET status = 'processing', total_count = ?, success_count = 0, failure_count = ?,
            attempt_count = ?, processing_requested_by = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'validating'
      `).bind(prepared.items.length, failureCount, runNumber, actor.adminId, jobId),
      auditImportJobStateStatement(env.DB, actor.adminId, 'process_import', jobId, 'processing', runNumber, {
        phase: 'started',
        runNumber,
        totalCount: prepared.items.length,
        preflightFailureCount: failureCount,
      }),
    )
    const results = await env.DB.batch(statements)
    if (!changed(results[transitionIndex])) {
      throw new AdminZipImportError(409, 'IMPORT_START_CONFLICT', '任务状态已变化，请刷新后重试')
    }

    if (pendingCount === 0) {
      return await finalizeImportJob(env, jobId, runNumber, actor.adminId)
    }
    await enqueueImportRun(env, jobId, runNumber, actor.adminId)
    return {
      id: jobId,
      status: 'processing',
      totalCount: prepared.items.length,
      successCount: 0,
      failureCount,
      message: 'ZIP 校验完成，已进入逐项导入队列',
    }
  }
  catch (error) {
    if (
      error instanceof AdminZipImportError
      && ['IMPORT_QUEUE_UNAVAILABLE', 'IMPORT_QUEUE_SEND_FAILED', 'IMPORT_FINALIZATION_FAILED'].includes(error.code)
    ) throw error
    const normalized = normalizePackageError(error)
    await pauseJob(env.DB, actor.adminId, jobId, normalized.code, normalized.message, {
      statuses: ['validating'],
    })
    throw normalized
  }
}

export async function retryFailedZipImportItems(
  env: ZipImportEnvironment,
  actor: ZipImportActor,
  jobId: string,
): Promise<ZipImportCommandResult> {
  const job = await loadImportJob(env.DB, jobId)
  await assertCanManageJob(env.DB, job, actor)
  if (job.status !== 'partial_failure') {
    throw new AdminZipImportError(409, 'IMPORT_RETRY_CONFLICT', '仅部分失败任务可以重试失败项')
  }
  assertUsablePackage(job)
  const failed = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM import_job_items
    WHERE job_id = ? AND status = 'failed' AND retryable = 1
  `).bind(jobId).first<{ count: number }>()
  if (!failed?.count) {
    throw new AdminZipImportError(409, 'IMPORT_RETRY_EMPTY', '当前任务没有可安全重试的失败项，请修正原包后新建任务')
  }
  if (!env.IMPORT_QUEUE) {
    await pauseJob(env.DB, actor.adminId, jobId, 'IMPORT_QUEUE_UNAVAILABLE', '导入队列尚未配置', {
      statuses: ['partial_failure'],
    })
    throw new AdminZipImportError(503, 'IMPORT_QUEUE_UNAVAILABLE', '导入队列尚未配置，任务已暂停')
  }

  const runNumber = Number(job.attempt_count || 0) + 1
  const claim = await env.DB.prepare(`
    UPDATE import_jobs
    SET status = 'processing', attempt_count = ?, processing_requested_by = ?,
        completed_at = NULL, last_error_code = NULL, last_error_message = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND status = 'partial_failure'
      AND (
        SELECT COUNT(*) FROM import_jobs active
        WHERE active.id != ?
          AND active.status IN ('validating', 'processing', 'finalizing')
      ) < ?
  `).bind(runNumber, actor.adminId, jobId, jobId, IMPORT_PACKAGE_LIMITS.MAX_ACTIVE_JOBS).run()
  if (!changed(claim)) {
    await throwImportClaimConflict(
      env.DB,
      jobId,
      ['partial_failure'],
      'IMPORT_RETRY_CONFLICT',
      '任务状态已变化，请刷新后重试',
    )
  }
  try {
    await env.DB.batch([
      env.DB.prepare(`
      UPDATE import_job_items
      SET status = 'pending', stage = 'preflight', attempt_count = 0,
          retryable = 0, error_code = NULL, error_message = NULL, updated_at = datetime('now')
      WHERE job_id = ? AND status = 'failed' AND retryable = 1
    `).bind(jobId),
      env.DB.prepare(`
      UPDATE import_jobs
      SET success_count = (
            SELECT COUNT(*) FROM import_job_items WHERE job_id = ? AND status = 'completed'
          ),
          failure_count = (
            SELECT COUNT(*) FROM import_job_items WHERE job_id = ? AND status = 'failed'
          ),
          updated_at = datetime('now')
      WHERE id = ? AND status = 'processing' AND attempt_count = ?
    `).bind(jobId, jobId, jobId, runNumber),
      auditImportJobStateStatement(env.DB, actor.adminId, 'retry_import', jobId, 'processing', runNumber, {
        runNumber,
        retryCount: Number(failed.count),
      }),
    ])
  }
  catch {
    await pauseJob(env.DB, actor.adminId, jobId, 'IMPORT_RETRY_PREPARE_FAILED', '失败项重新排队未完成', {
      statuses: ['processing'],
      runNumber,
    })
    throw new AdminZipImportError(503, 'IMPORT_RETRY_PREPARE_FAILED', '失败项重新排队未完成，任务已暂停', true)
  }

  try {
    await env.IMPORT_QUEUE.send(queueMessage(jobId, runNumber))
  }
  catch {
    await pauseJob(env.DB, actor.adminId, jobId, 'IMPORT_QUEUE_SEND_FAILED', '导入队列暂不可用', {
      statuses: ['processing'],
      runNumber,
    })
    throw new AdminZipImportError(503, 'IMPORT_QUEUE_SEND_FAILED', '导入队列暂不可用，任务已暂停', true)
  }
  const counts = await readItemCounts(env.DB, jobId)
  return {
    id: jobId,
    status: 'processing',
    totalCount: counts.total,
    successCount: counts.completed,
    failureCount: counts.failed,
    message: `已重新排队 ${failed.count} 个失败项`,
  }
}

export async function resumePausedZipImportJob(
  env: ZipImportEnvironment,
  actor: ZipImportActor,
  jobId: string,
): Promise<ZipImportCommandResult> {
  const job = await loadImportJob(env.DB, jobId)
  await assertCanManageJob(env.DB, job, actor)
  if (job.status !== 'paused') {
    throw new AdminZipImportError(409, 'IMPORT_RESUME_CONFLICT', '仅已暂停任务可以继续')
  }
  assertUsablePackage(job)

  const itemCounts = await readItemCounts(env.DB, jobId)
  if (itemCounts.total === 0) {
    const reset = await env.DB.prepare(`
      UPDATE import_jobs SET status = 'queued', updated_at = datetime('now')
      WHERE id = ? AND status = 'paused'
    `).bind(jobId).run()
    if (!changed(reset)) throw new AdminZipImportError(409, 'IMPORT_RESUME_CONFLICT', '任务状态已变化')
    return startZipImportJob(env, actor, jobId)
  }
  if (!env.IMPORT_QUEUE && itemCounts.pending + itemCounts.processing + itemCounts.retryableFailed > 0) {
    throw new AdminZipImportError(503, 'IMPORT_QUEUE_UNAVAILABLE', '导入队列尚未配置，任务保持暂停')
  }

  const runNumber = Number(job.attempt_count || 0) + 1
  const claim = await env.DB.prepare(`
    UPDATE import_jobs
    SET status = 'processing', attempt_count = ?, processing_requested_by = ?, completed_at = NULL,
        last_error_code = NULL, last_error_message = NULL, updated_at = datetime('now')
    WHERE id = ? AND status = 'paused'
      AND (
        SELECT COUNT(*) FROM import_jobs active
        WHERE active.id != ?
          AND active.status IN ('validating', 'processing', 'finalizing')
      ) < ?
  `).bind(runNumber, actor.adminId, jobId, jobId, IMPORT_PACKAGE_LIMITS.MAX_ACTIVE_JOBS).run()
  if (!changed(claim)) {
    await throwImportClaimConflict(
      env.DB,
      jobId,
      ['paused'],
      'IMPORT_RESUME_CONFLICT',
      '任务状态已变化，请刷新后重试',
    )
  }
  try {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE import_job_items
        SET status = 'pending', stage = 'preflight',
            attempt_count = CASE WHEN status = 'failed' THEN 0 ELSE attempt_count END,
            retryable = 0, updated_at = datetime('now')
        WHERE job_id = ?
          AND (status = 'processing' OR (status = 'failed' AND retryable = 1))
      `).bind(jobId),
      auditImportJobStateStatement(env.DB, actor.adminId, 'resume_import', jobId, 'processing', runNumber, {
        runNumber,
        pendingCount: itemCounts.pending + itemCounts.processing + itemCounts.retryableFailed,
      }),
    ])
  }
  catch {
    await pauseJob(env.DB, actor.adminId, jobId, 'IMPORT_RESUME_PREPARE_FAILED', '暂停任务恢复未完成', {
      statuses: ['processing'],
      runNumber,
    })
    throw new AdminZipImportError(503, 'IMPORT_RESUME_PREPARE_FAILED', '暂停任务恢复未完成，任务仍保持暂停', true)
  }

  const refreshedCounts = await readItemCounts(env.DB, jobId)
  if (refreshedCounts.pending > 0) {
    try {
      await env.IMPORT_QUEUE!.send(queueMessage(jobId, runNumber))
    }
    catch {
      await pauseJob(env.DB, actor.adminId, jobId, 'IMPORT_QUEUE_SEND_FAILED', '导入队列暂不可用', {
        statuses: ['processing'],
        runNumber,
      })
      throw new AdminZipImportError(503, 'IMPORT_QUEUE_SEND_FAILED', '导入队列暂不可用，任务已暂停', true)
    }
    return {
      id: jobId,
      status: 'processing',
      totalCount: refreshedCounts.total,
      successCount: refreshedCounts.completed,
      failureCount: refreshedCounts.failed,
      message: '任务已恢复并重新进入导入队列',
    }
  }
  return finalizeImportJob(env, jobId, runNumber, actor.adminId)
}

export async function handleZipImportQueueBatch(
  batch: MessageBatch<ZipImportQueueMessage>,
  env: ZipImportEnvironment,
): Promise<void> {
  for (const rawMessage of batch.messages as unknown as QueueMessageLike[]) {
    const message = parseQueueMessage(rawMessage.body)
    if (!message) {
      safeAck(rawMessage)
      continue
    }
    try {
      const outcome = await processNextImportItem(env, message, rawMessage.attempts)
      if (outcome === 'retry') safeRetry(rawMessage)
      else safeAck(rawMessage)
    }
    catch {
      if (rawMessage.attempts >= MAX_ITEM_ATTEMPTS) {
        await pauseJob(env.DB, 0, message.jobId, 'IMPORT_QUEUE_RUNTIME_FAILED', '导入队列连续执行失败', {
          statuses: ['processing'],
          runNumber: message.runNumber,
        })
        safeAck(rawMessage)
      }
      else {
        safeRetry(rawMessage)
      }
    }
  }
}

async function processNextImportItem(
  env: ZipImportEnvironment,
  message: ZipImportQueueMessage,
  queueAttempts: number,
): Promise<'ack' | 'retry'> {
  const job = await env.DB.prepare(`
    SELECT id, status, source_key, source_name, package_size, package_etag, created_by,
           multipart_upload_id, upload_session_id, upload_part_size, upload_part_count,
           attempt_count, processing_requested_by, error_report_key, updated_at
    FROM import_jobs
    WHERE id = ? AND type = 'zip'
  `).bind(message.jobId).first<ImportJobRow>()
  if (!job || job.status !== 'processing' || Number(job.attempt_count) !== message.runNumber) return 'ack'
  assertUsablePackage(job)

  const operator = await loadCurrentOperator(env.DB, job.processing_requested_by)
  if (!operator) {
    await pauseJob(env.DB, 0, job.id, 'IMPORT_OPERATOR_UNAVAILABLE', '发起导入的管理员已失去操作权限', {
      statuses: ['processing'],
      runNumber: message.runNumber,
    })
    return 'ack'
  }

  const item = await env.DB.prepare(`
    SELECT id, job_id, folder, title, slug, manifest_json, status, attempt_count
    FROM import_job_items
    WHERE job_id = ? AND status = 'pending'
    ORDER BY folder ASC
    LIMIT 1
  `).bind(job.id).first<ImportItemRow>()

  if (!item) {
    const counts = await readItemCounts(env.DB, job.id)
    if (counts.processing === 0 && counts.pending === 0) {
      await finalizeImportJob(env, job.id, message.runNumber, operator.adminId)
    }
    return 'ack'
  }

  const claim = await env.DB.prepare(`
    UPDATE import_job_items
    SET status = 'processing', stage = 'content', attempt_count = attempt_count + 1,
        retryable = 0,
        error_code = NULL, error_message = NULL, updated_at = datetime('now')
    WHERE id = ? AND job_id = ? AND status = 'pending'
  `).bind(item.id, job.id).run()
  if (!changed(claim)) return 'ack'
  item.attempt_count = Number(item.attempt_count) + 1

  try {
    await importOneGallery(env, operator, job, item)
  }
  catch (error) {
    const normalized = normalizeItemError(error)
    if (normalized.retryable && item.attempt_count < MAX_ITEM_ATTEMPTS && queueAttempts < MAX_ITEM_ATTEMPTS) {
      await env.DB.prepare(`
        UPDATE import_job_items
        SET status = 'pending', retryable = 1, error_code = ?, error_message = ?, updated_at = datetime('now')
        WHERE id = ? AND job_id = ? AND status = 'processing'
      `).bind(normalized.code, normalized.message, item.id, job.id).run()
      return 'retry'
    }
    await env.DB.prepare(`
      UPDATE import_job_items
      SET status = 'failed', retryable = ?, error_code = ?, error_message = ?, updated_at = datetime('now')
      WHERE id = ? AND job_id = ? AND status = 'processing'
    `).bind(normalized.retryable ? 1 : 0, normalized.code, normalized.message, item.id, job.id).run()
  }

  await updateJobCounts(env.DB, job.id, message.runNumber)
  const counts = await readItemCounts(env.DB, job.id)
  if (counts.pending > 0) {
    try {
      await env.IMPORT_QUEUE!.send(message)
      return 'ack'
    }
    catch {
      return 'retry'
    }
  }
  if (counts.processing === 0) await finalizeImportJob(env, job.id, message.runNumber, operator.adminId)
  return 'ack'
}

async function importOneGallery(
  env: ZipImportEnvironment,
  operator: ZipImportActor,
  job: ImportJobRow,
  itemRow: ImportItemRow,
): Promise<void> {
  const item = parseStoredPreparedItem(itemRow.manifest_json)
  const archive = await openZipArchive(env.R2, job.source_key!, Number(job.package_size))
  const existing = await env.DB.prepare('SELECT id FROM galleries WHERE slug = ? LIMIT 1')
    .bind(item.row.slug)
    .first<{ id: string }>()
  if (existing) {
    throw new AdminZipImportError(409, 'IMPORT_SLUG_EXISTS', `slug “${item.row.slug}” 已存在`)
  }
  if (item.videoPaths.length > 0 && (!env.STREAM_ACCOUNT_ID?.trim() || !env.STREAM_API_TOKEN?.trim())) {
    throw new AdminZipImportError(503, 'STREAM_NOT_CONFIGURED', '导入项含视频，但 Cloudflare Stream 尚未配置', true)
  }

  const contentBytes = await readZipEntry(env.R2, archive, item.contentPath)
  const bodyMd = decodeZipText(contentBytes, item.contentPath).trim()
  if (!bodyMd) throw new AdminZipImportError(422, 'IMPORT_CONTENT_EMPTY', 'content.md 不能为空')
  const coverValidationBytes = await readZipEntry(env.R2, archive, item.coverPath)
  if (assertImageMatchesPath(coverValidationBytes, item.coverPath) !== 'jpg') {
    throw new AdminZipImportError(422, 'IMPORT_COVER_NOT_JPEG', 'cover.jpg 必须为 JPEG 文件')
  }
  for (const imagePath of item.imagePaths) {
    const bytes = await readZipEntry(env.R2, archive, imagePath)
    assertImageMatchesPath(bytes, imagePath)
  }
  for (const video of item.videoPaths) {
    const bytes = await readZipEntry(env.R2, archive, video.path)
    assertMp4(bytes, video.path)
  }

  await markItemStage(env.DB, itemRow.id, job.id, 'media')

  const galleryId = generateId('gal')
  const requiredRank = membershipRank(item.row.requiredLevel)
  const galleryStatus = operator.role === 'owner' && item.row.status === 'published' ? 'published' : 'draft'
  const now = new Date().toISOString()
  const publishedAt = galleryStatus === 'published' ? now : null
  const coverKey = `${R2_KEY_PREFIX.COVERS}/${galleryId}/cover.jpg`
  const uploadedR2Keys: string[] = []
  const uploadedStreamUids: string[] = []
  const imageAssets: Array<{ id: string; key: string; contentType: string; sortOrder: number }> = []
  const videoAssets: Array<{ id: string; uid: string; role: 'preview' | 'full'; sortOrder: number }> = []

  try {
    const coverBytes = await readZipEntry(env.R2, archive, item.coverPath)
    await putR2Media(env.R2, coverKey, sanitizeImportedImage(coverBytes, 'jpg'), 'image/jpeg')
    uploadedR2Keys.push(coverKey)

    for (let index = 0; index < item.imagePaths.length; index++) {
      const imagePath = item.imagePaths[index]!
      const bytes = await readZipEntry(env.R2, archive, imagePath)
      const imageType = assertImageMatchesPath(bytes, imagePath)
      const assetId = generateId('med')
      const key = `${R2_KEY_PREFIX.ORIGINALS}/${galleryId}/${assetId}.${imageType}`
      const contentType = imageContentType(imageType)
      await putR2Media(env.R2, key, sanitizeImportedImage(bytes, imageType), contentType)
      uploadedR2Keys.push(key)
      imageAssets.push({ id: assetId, key, contentType, sortOrder: index + 1 })
    }

    for (let index = 0; index < item.videoPaths.length; index++) {
      const video = item.videoPaths[index]!
      const bytes = await readZipEntry(env.R2, archive, video.path)
      assertMp4(bytes, video.path)
      const assetId = generateId('med')
      const uid = await uploadVideoBytesToStream(
        env.STREAM_ACCOUNT_ID!,
        env.STREAM_API_TOKEN!,
        bytes,
        `${item.row.slug}-${video.role}.mp4`,
        { importJobId: job.id, galleryId, assetId, role: video.role },
      )
      uploadedStreamUids.push(uid)
      videoAssets.push({ id: assetId, uid, role: video.role, sortOrder: imageAssets.length + index + 1 })
    }

    const tagDescriptors = await resolveTagDescriptors(env.DB, item.row)
    await markItemStage(env.DB, itemRow.id, job.id, 'commit')
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`
        INSERT INTO galleries (
          id, title, slug, summary, body_md, cover_key, status,
          required_level_rank, published_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        galleryId,
        item.row.title,
        item.row.slug,
        summarizeMarkdown(bodyMd),
        bodyMd,
        coverKey,
        galleryStatus,
        requiredRank,
        publishedAt,
        now,
        now,
      ),
    ]
    for (const tag of tagDescriptors) {
      if (tag.existingId) {
        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id)
          VALUES (?, ?)
        `).bind(galleryId, tag.existingId))
        continue
      }

      statements.push(
        env.DB.prepare(`
          INSERT OR IGNORE INTO tags (id, type, name, slug)
          VALUES (?, ?, ?, ?)
        `).bind(tag.createId, tag.type, tag.name, tag.slug),
        auditCreatedTagStatement(env.DB, operator.adminId, tag),
        env.DB.prepare(`
          INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id)
          SELECT ?, id
          FROM tags
          WHERE slug = ? AND type = ? AND name = ? COLLATE NOCASE
          LIMIT 1
        `).bind(galleryId, tag.slug, tag.type, tag.name),
      )
    }
    for (const image of imageAssets) {
      statements.push(env.DB.prepare(`
        INSERT INTO media_assets (
          id, gallery_id, type, storage, r2_key, stream_uid,
          required_rank, role, sort_order, upload_status
        ) VALUES (?, ?, 'image', 'r2', ?, NULL, ?, 'gallery_image', ?, 'completed')
      `).bind(image.id, galleryId, image.key, requiredRank, image.sortOrder))
    }
    for (const video of videoAssets) {
      statements.push(env.DB.prepare(`
        INSERT INTO media_assets (
          id, gallery_id, type, storage, r2_key, stream_uid,
          required_rank, role, sort_order, upload_status
        ) VALUES (?, ?, 'video', 'stream', NULL, ?, ?, ?, ?, 'completed')
      `).bind(
        video.id,
        galleryId,
        video.uid,
        video.role === 'full' ? requiredRank : MEMBERSHIP_RANKS.FREE,
        video.role,
        video.sortOrder,
      ))
    }
    statements.push(
      env.DB.prepare(`
        UPDATE import_job_items
        SET status = 'completed', stage = 'completed', retryable = 0,
            gallery_id = ?, error_code = NULL, error_message = NULL,
            updated_at = datetime('now')
        WHERE id = ? AND job_id = ? AND status = 'processing'
      `).bind(galleryId, itemRow.id, job.id),
      auditStatement(env.DB, operator.adminId, 'gallery.create', 'gallery', galleryId, {
        source: 'zip_import',
        importJobId: job.id,
        folder: item.row.folder,
        title: item.row.title,
        slug: item.row.slug,
        status: galleryStatus,
        requiredRank,
        imageCount: imageAssets.length,
        videoCount: videoAssets.length,
        tags: tagDescriptors.map(tag => tag.slug),
      }),
    )
    await env.DB.batch(statements)
  }
  catch (error) {
    await Promise.all(uploadedR2Keys.map(key => safeDeleteR2(env.R2, key)))
    await Promise.all(uploadedStreamUids.map(uid => safeDeleteStreamVideo(
      env.STREAM_ACCOUNT_ID!,
      env.STREAM_API_TOKEN!,
      uid,
    )))
    throw error
  }
}

async function finalizeImportJob(
  env: ZipImportEnvironment,
  jobId: string,
  runNumber: number,
  adminId: number,
): Promise<ZipImportCommandResult> {
  const counts = await readItemCounts(env.DB, jobId)
  if (counts.pending > 0 || counts.processing > 0) {
    return {
      id: jobId,
      status: 'processing',
      totalCount: counts.total,
      successCount: counts.completed,
      failureCount: counts.failed,
      message: '导入仍在处理中',
    }
  }

  const claim = await env.DB.prepare(`
    UPDATE import_jobs
    SET status = 'finalizing', updated_at = datetime('now')
    WHERE id = ? AND status = 'processing' AND attempt_count = ?
      AND NOT EXISTS (
        SELECT 1 FROM import_job_items
        WHERE job_id = ? AND status IN ('pending', 'processing')
      )
  `).bind(jobId, runNumber, jobId).run()
  if (!changed(claim)) {
    const current = await env.DB.prepare(`
      SELECT status, total_count, success_count, failure_count
      FROM import_jobs WHERE id = ?
    `).bind(jobId).first<{
      status: string
      total_count: number
      success_count: number
      failure_count: number
    }>()
    return {
      id: jobId,
      status: terminalCommandStatus(current?.status),
      totalCount: Number(current?.total_count ?? counts.total),
      successCount: Number(current?.success_count ?? counts.completed),
      failureCount: Number(current?.failure_count ?? counts.failed),
      message: '导入状态已由其他执行器更新',
    }
  }

  try {
    const failedItems = await env.DB.prepare(`
      SELECT folder, stage, retryable, error_code, error_message
      FROM import_job_items
      WHERE job_id = ? AND status = 'failed'
      ORDER BY folder ASC
    `).bind(jobId).all<{
      folder: string
      stage: string
      retryable: number
      error_code: string | null
      error_message: string | null
    }>()
    const errorReportKey = `${R2_KEY_PREFIX.IMPORTS}/${jobId}/errors.csv`
    if (failedItems.results.length > 0) {
      const csv = `\uFEFF${[
        'folder,stage,retryable,error_code,error_message,remediation',
        ...failedItems.results.map(row => [
          row.folder,
          row.stage,
          Number(row.retryable) === 1 ? 'true' : 'false',
          row.error_code ?? '',
          row.error_message ?? '',
          importErrorRemediation(row.error_code, Number(row.retryable) === 1),
        ].map(csvCell).join(',')),
      ].join('\n')}`
      const report = await env.R2.put(errorReportKey, csv, {
        httpMetadata: { contentType: 'text/csv; charset=utf-8' },
      })
      if (!report) throw new Error('error_report_put_failed')
    }
    else {
      await safeDeleteR2(env.R2, errorReportKey)
    }

    const status = counts.failed > 0 ? 'partial_failure' : 'completed'
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE import_jobs
        SET status = ?, total_count = ?, success_count = ?, failure_count = ?,
            error_report_key = ?, completed_at = datetime('now'), updated_at = datetime('now'),
            last_error_code = NULL, last_error_message = NULL
        WHERE id = ? AND status = 'finalizing' AND attempt_count = ?
      `).bind(
        status,
        counts.total,
        counts.completed,
        counts.failed,
        counts.failed > 0 ? errorReportKey : null,
        jobId,
        runNumber,
      ),
      auditImportJobStateStatement(env.DB, adminId, 'process_import', jobId, status, runNumber, {
        phase: 'completed',
        status,
        runNumber,
        totalCount: counts.total,
        successCount: counts.completed,
        failureCount: counts.failed,
        errorReportAvailable: counts.failed > 0,
      }),
    ])
    if (!changed(results[0])) {
      throw new AdminZipImportError(409, 'IMPORT_FINALIZATION_CONFLICT', '导入汇总状态已变化，请刷新任务')
    }
    return {
      id: jobId,
      status,
      totalCount: counts.total,
      successCount: counts.completed,
      failureCount: counts.failed,
      message: status === 'completed' ? '导入已完成并写入审计记录' : '导入完成，部分条目需要处理',
    }
  }
  catch {
    await pauseJob(env.DB, adminId, jobId, 'IMPORT_FINALIZATION_FAILED', '导入结果汇总失败，请继续任务', {
      statuses: ['finalizing'],
      runNumber,
    })
    throw new AdminZipImportError(503, 'IMPORT_FINALIZATION_FAILED', '导入结果汇总失败，任务已暂停', true)
  }
}

async function enqueueImportRun(
  env: ZipImportEnvironment,
  jobId: string,
  runNumber: number,
  adminId: number,
): Promise<void> {
  if (!env.IMPORT_QUEUE) {
    await pauseJob(env.DB, adminId, jobId, 'IMPORT_QUEUE_UNAVAILABLE', '导入队列尚未配置', {
      statuses: ['processing'],
      runNumber,
    })
    throw new AdminZipImportError(503, 'IMPORT_QUEUE_UNAVAILABLE', '导入队列尚未配置，任务已暂停')
  }
  try {
    await env.IMPORT_QUEUE.send(queueMessage(jobId, runNumber))
  }
  catch {
    await pauseJob(env.DB, adminId, jobId, 'IMPORT_QUEUE_SEND_FAILED', '导入队列暂不可用', {
      statuses: ['processing'],
      runNumber,
    })
    throw new AdminZipImportError(503, 'IMPORT_QUEUE_SEND_FAILED', '导入队列暂不可用，任务已暂停', true)
  }
}

async function loadImportJob(db: D1Database, jobId: string): Promise<ImportJobRow> {
  const job = await db.prepare(`
    SELECT id, status, source_key, source_name, package_size, package_etag, created_by,
           multipart_upload_id, upload_session_id, upload_part_size, upload_part_count,
           attempt_count, processing_requested_by, error_report_key, updated_at
    FROM import_jobs
    WHERE id = ? AND type = 'zip'
  `).bind(jobId).first<ImportJobRow>()
  if (!job) throw new AdminZipImportError(404, 'IMPORT_JOB_NOT_FOUND', '导入任务不存在')
  return job
}

async function throwImportClaimConflict(
  db: D1Database,
  jobId: string,
  expectedStatuses: readonly string[],
  conflictCode: string,
  conflictMessage: string,
): Promise<never> {
  const [current, active] = await Promise.all([
    db.prepare('SELECT status FROM import_jobs WHERE id = ? AND type = \'zip\'')
      .bind(jobId)
      .first<{ status: string }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM import_jobs
      WHERE id != ? AND status IN ('validating', 'processing', 'finalizing')
    `).bind(jobId).first<{ count: number }>(),
  ])
  if (
    current
    && expectedStatuses.includes(current.status)
    && Number(active?.count ?? 0) >= IMPORT_PACKAGE_LIMITS.MAX_ACTIVE_JOBS
  ) {
    throw new AdminZipImportError(
      429,
      'IMPORT_CONCURRENCY_LIMIT',
      `当前已有 ${IMPORT_PACKAGE_LIMITS.MAX_ACTIVE_JOBS} 个导入任务在执行，请稍后重试`,
      true,
    )
  }
  throw new AdminZipImportError(409, conflictCode, conflictMessage)
}

async function assertCanManageJob(
  db: D1Database,
  job: ImportJobRow,
  actor: ZipImportActor,
): Promise<void> {
  if (actor.role !== 'owner' && Number(job.created_by) !== actor.adminId) {
    await auditStatement(db, actor.adminId, 'import_job.access_denied', 'import_job', job.id, {
      reason: 'ownership_scope',
    }).run()
    throw new AdminZipImportError(403, 'IMPORT_JOB_FORBIDDEN', '只能操作自己创建的导入任务')
  }
}

function assertUsablePackage(job: ImportJobRow): void {
  if (
    !job.source_key
    || !job.package_size
    || !job.package_etag
    || job.multipart_upload_id
    || job.upload_session_id
    || !isExpectedImportPackageKey(job.source_key, job.id)
  ) {
    throw new AdminZipImportError(422, 'IMPORT_PACKAGE_MISSING', '任务尚未上传有效 ZIP 原包')
  }
}

function assertMultipartUploadSession(job: ImportJobRow, uploadSession: string): void {
  if (
    job.status !== 'uploading'
    || !/^[a-f0-9-]{36}$/i.test(uploadSession)
    || job.upload_session_id !== uploadSession
    || !job.source_key
    || !isExpectedImportPackageKey(job.source_key, job.id)
    || !job.multipart_upload_id
    || job.multipart_upload_id.length > 256
    || containsAsciiControlCharacter(job.multipart_upload_id)
    || !Number.isSafeInteger(Number(job.package_size))
    || Number(job.package_size) <= 0
    || !Number.isSafeInteger(Number(job.upload_part_size))
    || Number(job.upload_part_size) !== IMPORT_PACKAGE_LIMITS.MULTIPART_PART_BYTES
    || !Number.isSafeInteger(Number(job.upload_part_count))
    || Number(job.upload_part_count) <= 0
    || Number(job.upload_part_count) !== Math.ceil(
      Number(job.package_size) / IMPORT_PACKAGE_LIMITS.MULTIPART_PART_BYTES,
    )
  ) {
    throw new AdminZipImportError(409, 'IMPORT_UPLOAD_SESSION_INVALID', 'ZIP 上传会话无效或已被替换')
  }
}

async function loadCurrentOperator(db: D1Database, adminId: number | null): Promise<ZipImportActor | null> {
  if (!adminId) return null
  const operator = await db.prepare(`
    SELECT id, role FROM users
    WHERE id = ? AND status = 'active' AND role IN ('admin', 'owner')
  `).bind(adminId).first<{ id: number; role: string }>()
  return operator ? { adminId: Number(operator.id), role: operator.role } : null
}

async function readItemCounts(db: D1Database, jobId: string) {
  const rows = await db.prepare(`
    SELECT status, retryable, COUNT(*) AS count
    FROM import_job_items
    WHERE job_id = ?
    GROUP BY status, retryable
  `).bind(jobId).all<{ status: string; retryable: number; count: number }>()
  const counts = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, retryableFailed: 0 }
  for (const row of rows.results) {
    const count = Number(row.count || 0)
    counts.total += count
    if (row.status === 'pending') counts.pending = count
    else if (row.status === 'processing') counts.processing = count
    else if (row.status === 'completed') counts.completed = count
    else if (row.status === 'failed') {
      counts.failed += count
      if (Number(row.retryable) === 1) counts.retryableFailed += count
    }
  }
  return counts
}

async function updateJobCounts(db: D1Database, jobId: string, runNumber: number): Promise<void> {
  await db.prepare(`
    UPDATE import_jobs
    SET success_count = (
          SELECT COUNT(*) FROM import_job_items WHERE job_id = ? AND status = 'completed'
        ),
        failure_count = (
          SELECT COUNT(*) FROM import_job_items WHERE job_id = ? AND status = 'failed'
        ),
        updated_at = datetime('now')
    WHERE id = ? AND status = 'processing' AND attempt_count = ?
  `).bind(jobId, jobId, jobId, runNumber).run()
}

async function markItemStage(
  db: D1Database,
  itemId: string,
  jobId: string,
  stage: 'media' | 'commit',
): Promise<void> {
  const result = await db.prepare(`
    UPDATE import_job_items
    SET stage = ?, updated_at = datetime('now')
    WHERE id = ? AND job_id = ? AND status = 'processing'
  `).bind(stage, itemId, jobId).run()
  if (!changed(result)) {
    throw new AdminZipImportError(409, 'IMPORT_ITEM_CLAIM_LOST', '导入项执行权已变化，请刷新任务状态', true)
  }
}

async function pauseJob(
  db: D1Database,
  adminId: number,
  jobId: string,
  code: string,
  message: string,
  guard: PauseJobGuard,
): Promise<void> {
  if (guard.statuses.length === 0) return
  const safeMessage = message.slice(0, 500)
  const pausedAt = new Date().toISOString()
  const conditions = [
    'id = ?',
    `status IN (${guard.statuses.map(() => '?').join(', ')})`,
  ]
  const bindings: Array<string | number> = [jobId, ...guard.statuses]
  if (guard.runNumber !== undefined) {
    conditions.push('attempt_count = ?')
    bindings.push(guard.runNumber)
  }
  if (guard.uploadSession !== undefined) {
    conditions.push('upload_session_id = ?')
    bindings.push(guard.uploadSession)
  }
  const pauseStatement = db.prepare(`
    UPDATE import_jobs
    SET status = 'paused', last_error_code = ?, last_error_message = ?, updated_at = ?
    WHERE ${conditions.join(' AND ')}
  `).bind(code, safeMessage, pausedAt, ...bindings)
  const actorId = adminId > 0
    ? adminId
    : await db.prepare('SELECT COALESCE(processing_requested_by, created_by) AS id FROM import_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ id: number }>()
      .then(row => Number(row?.id || 0))
  if (actorId <= 0) {
    await pauseStatement.run()
    return
  }
  await db.batch([
    pauseStatement,
    auditPausedImportStatement(db, actorId, jobId, pausedAt, code, safeMessage, {
      phase: 'paused',
      errorCode: code,
      errorMessage: safeMessage,
    }),
  ])
}

function auditPausedImportStatement(
  db: D1Database,
  adminId: number,
  jobId: string,
  pausedAt: string,
  errorCode: string,
  errorMessage: string,
  afterValue: unknown,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, 'process_import', 'import_job', ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM import_jobs
      WHERE id = ? AND status = 'paused' AND updated_at = ?
        AND last_error_code = ? AND last_error_message = ?
    )
  `).bind(
    generateId('log'),
    adminId,
    jobId,
    JSON.stringify(afterValue),
    jobId,
    pausedAt,
    errorCode,
    errorMessage,
  )
}

function auditStatement(
  db: D1Database,
  adminId: number,
  action: string,
  targetType: string,
  targetId: string,
  afterValue: unknown,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    ) VALUES (?, ?, ?, ?, ?, NULL, ?)
  `).bind(generateId('log'), adminId, action, targetType, targetId, JSON.stringify(afterValue))
}

function auditImportJobStateStatement(
  db: D1Database,
  adminId: number,
  action: string,
  jobId: string,
  expectedStatus: string,
  runNumber: number,
  afterValue: unknown,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, ?, 'import_job', ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM import_jobs
      WHERE id = ? AND status = ? AND attempt_count = ?
    )
  `).bind(
    generateId('log'),
    adminId,
    action,
    jobId,
    JSON.stringify(afterValue),
    jobId,
    expectedStatus,
    runNumber,
  )
}

function auditImportUploadPartStatement(
  db: D1Database,
  adminId: number,
  jobId: string,
  uploadSession: string,
  partNumber: number,
  partSize: number,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, 'upload_import_part', 'import_job', ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM import_jobs
      WHERE id = ? AND status = 'uploading' AND upload_session_id = ?
    )
  `).bind(
    generateId('log'),
    adminId,
    jobId,
    JSON.stringify({ partNumber, partSize }),
    jobId,
    uploadSession,
  )
}

function auditImportUploadSessionStatement(
  db: D1Database,
  adminId: number,
  jobId: string,
  uploadSession: string,
  action: string,
  afterValue: unknown,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, ?, 'import_job', ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM import_jobs
      WHERE id = ? AND status = 'uploading' AND upload_session_id = ?
    )
  `).bind(
    generateId('log'),
    adminId,
    action,
    jobId,
    JSON.stringify(afterValue),
    jobId,
    uploadSession,
  )
}

function auditCompletedImportUploadStatement(
  db: D1Database,
  adminId: number,
  jobId: string,
  completedAt: string,
  packageEtag: string,
  sourceKey: string,
  afterValue: unknown,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, 'upload_import_package', 'import_job', ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM import_jobs
      WHERE id = ? AND status = 'queued' AND uploaded_at = ?
        AND package_etag = ? AND source_key = ?
    )
  `).bind(
    generateId('log'),
    adminId,
    jobId,
    JSON.stringify(afterValue),
    jobId,
    completedAt,
    packageEtag,
    sourceKey,
  )
}

async function putR2Media(
  r2: R2Bucket,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  try {
    const result = await r2.put(key, toOwnedArrayBuffer(bytes), { httpMetadata: { contentType } })
    if (!result) throw new Error('r2_put_failed')
  }
  catch {
    throw new AdminZipImportError(503, 'IMPORT_MEDIA_STORE_FAILED', '媒体写入 R2 失败，请稍后重试', true)
  }
}

async function uploadVideoBytesToStream(
  accountId: string,
  apiToken: string,
  bytes: Uint8Array,
  fileName: string,
  metadata: Record<string, string>,
): Promise<string> {
  let response: Response
  try {
    const form = new FormData()
    form.set('file', new Blob([toOwnedArrayBuffer(bytes)], { type: 'video/mp4' }), fileName)
    form.set('requireSignedURLs', 'true')
    form.set('meta', JSON.stringify(metadata))
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    })
  }
  catch {
    throw new AdminZipImportError(503, 'STREAM_UPLOAD_UNAVAILABLE', 'Cloudflare Stream 上传暂不可用', true)
  }
  const payload = await response.json().catch(() => null) as {
    success?: boolean
    result?: { uid?: string }
    errors?: Array<{ message?: string }>
  } | null
  if (!response.ok || !payload?.success || !payload.result?.uid) {
    const message = payload?.errors?.[0]?.message?.slice(0, 200) || 'Cloudflare Stream 拒绝了视频上传'
    throw new AdminZipImportError(
      response.status >= 500 || response.status === 429 ? 503 : 422,
      'STREAM_UPLOAD_REJECTED',
      message,
      response.status >= 500 || response.status === 429,
    )
  }
  return payload.result.uid
}

async function safeDeleteStreamVideo(accountId: string, apiToken: string, uid: string): Promise<void> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    })
    if (!response.ok && response.status !== 404) throw new Error('stream_delete_failed')
  }
  catch {
    console.error('[zip-import] Stream 回滚失败', { code: 'stream_cleanup_failed' })
  }
}

async function safeDeleteR2(r2: R2Bucket, key: string): Promise<void> {
  try {
    await r2.delete(key)
  }
  catch {
    console.error('[zip-import] R2 回滚失败', { code: 'r2_cleanup_failed' })
  }
}

async function safeAbortMultipart(upload: R2MultipartUpload): Promise<void> {
  try {
    await upload.abort()
  }
  catch {
    console.error('[zip-import] R2 分片上传回滚失败', { code: 'r2_multipart_abort_failed' })
  }
}

function toStoredPreparedItem(item: PreparedZipImportItem): StoredPreparedItem {
  return {
    row: item.row,
    contentPath: item.contentPath,
    coverPath: item.coverPath,
    imagePaths: item.imagePaths,
    videoPaths: item.videoPaths,
  }
}

function parseStoredPreparedItem(value: string): StoredPreparedItem {
  try {
    const parsed = JSON.parse(value) as StoredPreparedItem
    if (
      !parsed
      || typeof parsed !== 'object'
      || !parsed.row
      || typeof parsed.row.folder !== 'string'
      || typeof parsed.row.title !== 'string'
      || typeof parsed.row.slug !== 'string'
      || typeof parsed.contentPath !== 'string'
      || typeof parsed.coverPath !== 'string'
      || !Array.isArray(parsed.imagePaths)
      || !parsed.imagePaths.every(path => typeof path === 'string')
      || !Array.isArray(parsed.videoPaths)
      || !parsed.videoPaths.every(video => video && typeof video.path === 'string' && ['preview', 'full'].includes(video.role))
    ) throw new Error('invalid_manifest_json')
    return parsed
  }
  catch {
    throw new AdminZipImportError(500, 'IMPORT_ITEM_SNAPSHOT_INVALID', '导入项快照损坏，任务需要人工复核')
  }
}

async function resolveTagDescriptors(
  db: D1Database,
  row: ZipManifestRow,
): Promise<ResolvedTagDescriptor[]> {
  const values: Array<{ type: string; name: string }> = []
  if (row.region) values.push({ type: 'city_country', name: row.region })
  if (row.personality) values.push({ type: 'personality', name: row.personality })
  if (row.style) values.push({ type: 'style', name: row.style })
  for (const tag of row.tags) values.push({ type: 'content_type', name: tag })

  const seen = new Set<string>()
  const descriptors: ResolvedTagDescriptor[] = []
  for (const value of values) {
    const name = normalizeTagName(value.name)
    const identity = `${value.type}\u0000${name.toLocaleLowerCase('zh-CN')}`
    if (seen.has(identity)) continue
    seen.add(identity)

    const existing = await db.prepare(`
      SELECT id, type, name, slug
      FROM tags
      WHERE type = ? AND name = ? COLLATE NOCASE
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).bind(value.type, name).first<{ id: string; type: string; name: string; slug: string }>()
    if (existing) {
      descriptors.push({
        type: existing.type,
        name: existing.name,
        slug: existing.slug,
        existingId: existing.id,
        createId: null,
      })
      continue
    }

    const slug = await deterministicTagSlug(value.type, name)
    const slugOwner = await db.prepare(`
      SELECT id, type, name, slug
      FROM tags
      WHERE slug = ?
      LIMIT 1
    `).bind(slug).first<{ id: string; type: string; name: string; slug: string }>()
    if (slugOwner) {
      if (sameTagIdentity(slugOwner, value.type, name)) {
        descriptors.push({
          type: slugOwner.type,
          name: slugOwner.name,
          slug: slugOwner.slug,
          existingId: slugOwner.id,
          createId: null,
        })
        continue
      }
      throw new AdminZipImportError(
        409,
        'IMPORT_TAG_SLUG_CONFLICT',
        `标签“${name}”的稳定标识已被占用，请先在标签管理中处理冲突`,
      )
    }

    descriptors.push({
      type: value.type,
      name,
      slug,
      existingId: null,
      createId: generateId('tag'),
    })
  }
  return descriptors
}

function normalizeTagName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

async function deterministicTagSlug(type: string, name: string): Promise<string> {
  const canonical = `${type}\u0000${name.toLocaleLowerCase('zh-CN')}`
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))
  const suffix = [...digest.subarray(0, 12)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${type}-${suffix}`
}

function sameTagIdentity(
  tag: { type: string; name: string },
  type: string,
  name: string,
): boolean {
  return tag.type === type
    && normalizeTagName(tag.name).toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN')
}

function auditCreatedTagStatement(
  db: D1Database,
  adminId: number,
  tag: ResolvedTagDescriptor,
): D1PreparedStatement {
  const auditId = generateId('log')
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, 'create_tag', 'tag', ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM tags WHERE id = ? AND type = ? AND name = ? AND slug = ?
    )
  `).bind(
    auditId,
    adminId,
    tag.createId,
    JSON.stringify({ type: tag.type, name: tag.name, slug: tag.slug, source: 'zip_import' }),
    tag.createId,
    tag.type,
    tag.name,
    tag.slug,
  )
}

function summarizeMarkdown(markdown: string): string | null {
  const line = markdown.split(/\r?\n/)
    .map(value => value.trim())
    .find(value => value && !value.startsWith('#') && value !== '---')
  if (!line) return null
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>~-]/g, '')
    .trim()
    .slice(0, 300) || null
}

function membershipRank(level: ZipManifestRow['requiredLevel']): number {
  if (level === 'vip') return MEMBERSHIP_RANKS.VIP
  if (level === 'svip') return MEMBERSHIP_RANKS.SVIP
  return MEMBERSHIP_RANKS.FREE
}

function imageContentType(type: 'jpg' | 'png' | 'webp'): string {
  if (type === 'jpg') return 'image/jpeg'
  return `image/${type}`
}

function normalizeSourceName(value: string): string {
  const normalized = value.trim().normalize('NFC')
  if (!normalized || normalized.length > 180 || !normalized.toLocaleLowerCase('en-US').endsWith('.zip')) {
    throw new AdminZipImportError(400, 'IMPORT_SOURCE_NAME_INVALID', '文件名必须是 180 字符以内的 .zip 文件名')
  }
  if (containsAsciiControlCharacter(normalized) || normalized.includes('/') || normalized.includes('\\')) {
    throw new AdminZipImportError(400, 'IMPORT_SOURCE_NAME_INVALID', 'ZIP 文件名含有不安全字符')
  }
  return normalized
}

function normalizePackageError(error: unknown): AdminZipImportError {
  if (error instanceof AdminZipImportError) return error
  if (error instanceof ZipImportError) {
    return new AdminZipImportError(error.retryable ? 503 : 422, error.code, error.message, error.retryable)
  }
  return new AdminZipImportError(503, 'IMPORT_VALIDATION_FAILED', 'ZIP 校验未完成，任务已暂停', true)
}

function normalizeItemError(error: unknown): AdminZipImportError {
  if (error instanceof AdminZipImportError) return error
  if (error instanceof ZipImportError) {
    return new AdminZipImportError(error.retryable ? 503 : 422, error.code, error.message, error.retryable)
  }
  if (error instanceof Error && /UNIQUE constraint failed: galleries\.slug/i.test(error.message)) {
    return new AdminZipImportError(409, 'IMPORT_SLUG_EXISTS', '图库 slug 已存在')
  }
  return new AdminZipImportError(
    500,
    'IMPORT_ITEM_PROCESS_FAILED',
    '导入条目处理失败，请核对错误报告与审计记录',
  )
}

function parseQueueMessage(value: unknown): ZipImportQueueMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (
    message.schemaVersion !== 1
    || message.kind !== IMPORT_QUEUE_KIND
    || typeof message.jobId !== 'string'
    || !/^imp_[A-Za-z0-9_-]+$/.test(message.jobId)
    || !Number.isSafeInteger(message.runNumber)
    || Number(message.runNumber) <= 0
  ) return null
  return message as unknown as ZipImportQueueMessage
}

function queueMessage(jobId: string, runNumber: number): ZipImportQueueMessage {
  return { schemaVersion: 1, kind: IMPORT_QUEUE_KIND, jobId, runNumber }
}

function csvCell(value: string): string {
  const formulaSafe = /^[\t\r\n ]*[=+\-@]/u.test(value) ? `'${value}` : value
  return `"${formulaSafe.replace(/"/g, '""')}"`
}

function importErrorRemediation(code: string | null, retryable: boolean): string {
  if (retryable) return '可在服务恢复后使用“重试失败项”安全重试'
  if (code?.includes('SLUG')) return '修正 manifest.csv 中的 slug 后新建导入任务'
  if (code?.includes('MISSING')) return '补齐对应目录的必需文件后新建导入任务'
  if (code?.includes('SIGNATURE') || code?.includes('MP4') || code?.includes('IMAGE')) {
    return '替换格式或内容不匹配的媒体文件后新建导入任务'
  }
  return '修正原包中对应条目后新建导入任务'
}

function terminalCommandStatus(value: string | undefined): ZipImportCommandResult['status'] {
  if (value === 'completed' || value === 'partial_failure' || value === 'paused') return value
  return 'processing'
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return Number(result?.meta?.changes ?? 0) > 0
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function safeAck(message: QueueMessageLike): void {
  try { message.ack() }
  catch { /* 队列运行时会处理失效句柄。 */ }
}

function safeRetry(message: QueueMessageLike): void {
  try { message.retry() }
  catch { /* 队列运行时会按未确认消息处理。 */ }
}
