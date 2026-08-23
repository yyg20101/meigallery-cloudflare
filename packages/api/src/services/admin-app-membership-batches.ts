import {
  previewAdminAppMembershipGrant,
  type AppMembershipGrantAction,
  type AppMembershipGrantReason,
} from './admin-app-membership'
import {
  createAdminAppMembershipGrantChangeRequest,
} from './admin-app-membership-reviews'
import { AppMembershipError } from './app-membership'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const BATCH_ID = /^amb_[A-Za-z0-9_-]{1,91}$/u
const ACCOUNT_PUBLIC_ID = /^acc_[A-Za-z0-9_-]{1,76}$/u
const TIER_ID = /^amt_[A-Za-z0-9_-]{1,76}$/u
const MAX_ROWS = 200
const PROCESSING_LEASE_MS = 10 * 60 * 1000
const EXPECTED_HEADERS = [
  'account_id',
  'tier_id',
  'action',
  'starts_at',
  'duration_days',
  'reason_code',
  'user_visible_note',
  'internal_note',
  'business_reference',
] as const

export interface AdminMembershipBatchCreateInput {
  sourceName?: unknown
  csvText?: unknown
}

export interface AdminMembershipBatchSubmitInput {
  expectedVersion?: unknown
}

export interface AdminMembershipBatchCancelInput {
  expectedVersion?: unknown
  reason?: unknown
}

export type AdminMembershipBatchStatus = 'draft' | 'processing' | 'submitted' | 'partial_failed' | 'cancelled'
export type AdminMembershipBatchItemStatus = 'valid' | 'invalid' | 'submitting' | 'submitted' | 'submit_failed'

export interface AdminMembershipBatchItemView {
  itemId: string
  rowNumber: number
  accountId: string | null
  tierId: string | null
  tierName: string | null
  rank: number | null
  action: AppMembershipGrantAction | null
  requestedStartsAt: string | null
  previewStartsAt: string | null
  previewExpiresAt: string | null
  durationDays: number | null
  reasonCode: AppMembershipGrantReason | null
  userVisibleNote: string | null
  internalNote: string | null
  businessReference: string | null
  status: AdminMembershipBatchItemStatus
  error: { code: string; summary: string } | null
  changeRequestId: string | null
}

export interface AdminMembershipBatchView {
  batchId: string
  catalogVersionId: string
  status: AdminMembershipBatchStatus
  sourceName: string
  sourceSha256: string
  totalCount: number
  validCount: number
  invalidCount: number
  riskCodes: string[]
  submittedCount: number
  version: number
  createdBy: { id: number; label: string }
  processingStartedAt: string | null
  processingLeaseExpiresAt: string | null
  processingRecoverable: boolean
  submittedAt: string | null
  cancelledBy: { id: number; label: string } | null
  cancellationReason: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
  items?: AdminMembershipBatchItemView[]
}

type BatchRow = {
  id: string
  catalog_version_id: string
  status: string
  source_name: string
  source_sha256: string
  total_count: number
  valid_count: number
  invalid_count: number
  risk_codes_json: string
  submitted_count: number
  version: number
  created_by: number
  creator_label: string
  processing_started_at: string | null
  processing_lease_expires_at: string | null
  processing_token: string | null
  submitted_at: string | null
  cancelled_by: number | null
  canceller_label: string | null
  cancellation_reason: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

type BatchItemRow = {
  id: string
  row_number: number
  account_public_id: string | null
  target_user_id: number | null
  tier_id: string | null
  tier_name_snapshot: string | null
  rank_snapshot: number | null
  action: string | null
  requested_starts_at: string | null
  preview_starts_at: string | null
  preview_expires_at: string | null
  duration_days: number | null
  reason_code: string | null
  user_visible_note: string | null
  internal_note: string | null
  business_reference: string | null
  status: string
  error_code: string | null
  error_summary: string | null
  change_request_id: string | null
}

type NormalizedCsvRow = {
  accountId: string
  tierId: string
  action: AppMembershipGrantAction
  startsAt: string | null
  durationDays: number
  reasonCode: AppMembershipGrantReason
  userVisibleNote: string
  internalNote: string
  businessReference: string
}

type PreparedCsvRow = {
  rowNumber: number
  raw: Record<string, string>
  rowSha256: string
  normalized: NormalizedCsvRow | null
  targetUserId: number | null
  preview: null | {
    tierName: string
    rank: number
    startsAt: string
    expiresAt: string
  }
  error: { code: string; summary: string } | null
}

type BatchControlRow = {
  enabled: number
  max_rows: number
  large_batch_threshold: number
}

export async function listAdminAppMembershipBatches(
  db: D1Database,
  catalogVersionId: string,
  now = new Date(),
): Promise<AdminMembershipBatchView[]> {
  const result = await db.prepare(`
    ${batchSelect()}
    WHERE batch.catalog_version_id = ?
    ORDER BY batch.created_at DESC, batch.id DESC
    LIMIT 100
  `).bind(catalogVersionId).all<BatchRow>()
  return result.results.map(row => toBatchView(row, now))
}

export async function getAdminAppMembershipBatch(
  db: D1Database,
  catalogVersionId: string,
  batchId: string,
  viewerId: number | null = null,
  now = new Date(),
): Promise<AdminMembershipBatchView> {
  validateBatchId(batchId)
  const batch = await requireBatch(db, catalogVersionId, batchId)
  const items = await listBatchItems(db, batchId)
  if (viewerId !== null) {
    await db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      ) VALUES (?, ?, 'app.membership.batch.view', 'app_membership_grant_batch', ?, NULL, ?, ?)
    `).bind(
      randomId('audit'),
      viewerId,
      batchId,
      JSON.stringify({ purpose: 'service_operation', fields: ['account_public_id', 'internal_note'] }),
      now.toISOString(),
    ).run()
  }
  return { ...toBatchView(batch, now), items: items.map(toBatchItemView) }
}

export async function createAdminAppMembershipBatchPreview(
  db: D1Database,
  catalogVersionId: string,
  adminId: number,
  idempotencyKey: string | null,
  input: AdminMembershipBatchCreateInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ batch: AdminMembershipBatchView; replayed: boolean }> {
  const key = normalizeIdempotencyKey(idempotencyKey)
  const control = await requireBatchControl(db, catalogVersionId)
  const sourceName = normalizeText(input.sourceName, 'sourceName', 1, 120)
  const csvText = normalizeCsvText(input.csvText)
  const sourceSha256 = await sha256Hex(csvText)
  const requestHash = await sha256Hex(JSON.stringify({ catalogVersionId, sourceName, sourceSha256 }))
  const replay = await findBatchByKey(db, adminId, key)
  if (replay) {
    if (replay.request_hash !== requestHash || replay.catalog_version_id !== catalogVersionId) {
      throw idempotencyConflict()
    }
    return {
      batch: await getAdminAppMembershipBatch(db, catalogVersionId, replay.id, null, now),
      replayed: true,
    }
  }

  const parsedRows = parseCsv(csvText, Number(control.max_rows))
  const businessReferences = new Set<string>()
  const preparedRows: PreparedCsvRow[] = []
  for (let index = 0; index < parsedRows.length; index += 1) {
    const row = parsedRows[index]!
    const rowNumber = index + 2
    const rowSha256 = await sha256Hex(JSON.stringify(row))
    let normalized: NormalizedCsvRow | null = null
    let targetUserId: number | null = null
    try {
      normalized = normalizeCsvRow(row)
      const businessKey = `${normalized.accountId}\u0000${normalized.businessReference}`
      if (businessReferences.has(businessKey)) {
        throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_DUPLICATE_BUSINESS_REFERENCE', '批次内同一账号的业务单号重复')
      }
      businessReferences.add(businessKey)
      targetUserId = await resolveActiveAccountUserId(db, normalized.accountId)
      const preview = await previewAdminAppMembershipGrant(
        db,
        catalogVersionId,
        {
          userId: targetUserId,
          tierId: normalized.tierId,
          action: normalized.action,
          startsAt: normalized.startsAt ?? undefined,
          durationDays: normalized.durationDays,
          reasonCode: normalized.reasonCode,
          userVisibleNote: normalized.userVisibleNote,
          internalNote: normalized.internalNote,
          businessReference: normalized.businessReference,
        },
        now,
        requireProductionReady,
      )
      preparedRows.push({
        rowNumber,
        raw: row,
        rowSha256,
        normalized,
        targetUserId,
        preview: {
          tierName: preview.tier.displayName,
          rank: preview.tier.rank,
          startsAt: preview.startsAt,
          expiresAt: preview.expiresAt,
        },
        error: null,
      })
    }
    catch (error) {
      preparedRows.push({
        rowNumber,
        raw: row,
        rowSha256,
        normalized: normalized ?? tryNormalizeCsvRow(row),
        targetUserId,
        preview: null,
        error: toItemError(error),
      })
    }
  }

  const validRows = preparedRows.filter(row => (
    !row.error
    && row.normalized !== null
    && row.targetUserId !== null
    && row.preview !== null
  ))
  const riskCodes = [
    'BATCH_INDEPENDENT_REVIEW',
    ...(preparedRows.length >= Number(control.large_batch_threshold) ? ['LARGE_BATCH'] : []),
    ...(preparedRows.some(row => row.error?.code === 'MEMBERSHIP_BATCH_DUPLICATE_BUSINESS_REFERENCE') ? ['DUPLICATE_ROW'] : []),
    ...(preparedRows.some(row => row.error) ? ['PARTIAL_INVALID'] : []),
  ]
  const timestamp = now.toISOString()
  const batchId = randomId('amb')
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_membership_grant_batches (
        id, catalog_version_id, status, source_name, source_sha256,
        total_count, valid_count, invalid_count, risk_codes_json, submitted_count,
        version, request_idempotency_key, request_hash, created_by, created_at, updated_at
      ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)
    `).bind(
      batchId,
      catalogVersionId,
      sourceName,
      sourceSha256,
      preparedRows.length,
      validRows.length,
      preparedRows.length - validRows.length,
      JSON.stringify(riskCodes),
      key,
      requestHash,
      adminId,
      timestamp,
      timestamp,
    ),
  ]
  for (const row of preparedRows) {
    statements.push(db.prepare(`
      INSERT INTO app_membership_grant_batch_items (
        id, batch_id, row_number, row_sha256, raw_row_json,
        account_public_id, target_user_id, catalog_version_id, tier_id,
        tier_name_snapshot, rank_snapshot, action, requested_starts_at,
        preview_starts_at, preview_expires_at, duration_days, reason_code,
        user_visible_note, internal_note, business_reference, status,
        error_code, error_summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      randomId('ambi'),
      batchId,
      row.rowNumber,
      row.rowSha256,
      JSON.stringify(row.raw),
      row.normalized?.accountId ?? null,
      row.targetUserId,
      row.preview && row.normalized?.tierId ? catalogVersionId : null,
      row.normalized?.tierId ?? null,
      row.preview?.tierName ?? null,
      row.preview?.rank ?? null,
      row.normalized?.action ?? null,
      row.normalized?.startsAt ?? null,
      row.preview?.startsAt ?? null,
      row.preview?.expiresAt ?? null,
      row.normalized?.durationDays ?? null,
      row.normalized?.reasonCode ?? null,
      row.normalized?.userVisibleNote ?? null,
      row.normalized?.internalNote ?? null,
      row.normalized?.businessReference ?? null,
      row.error ? 'invalid' : 'valid',
      row.error?.code ?? null,
      row.error?.summary ?? null,
      timestamp,
      timestamp,
    ))
  }
  statements.push(db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app.membership.batch.preview', 'app_membership_grant_batch', ?, NULL, ?, ?)
  `).bind(
    randomId('audit'),
    adminId,
    batchId,
    JSON.stringify({
      sourceName,
      sourceSha256,
      totalCount: preparedRows.length,
      validCount: validRows.length,
      invalidCount: preparedRows.length - validRows.length,
      riskCodes,
      independentReviewRequired: true,
    }),
    timestamp,
  ))
  try {
    await db.batch(statements)
  }
  catch (error) {
    const raced = await findBatchByKey(db, adminId, key)
    if (raced?.request_hash === requestHash && raced.catalog_version_id === catalogVersionId) {
      return {
        batch: await getAdminAppMembershipBatch(db, catalogVersionId, raced.id, null, now),
        replayed: true,
      }
    }
    if (raced) throw idempotencyConflict()
    throw error
  }
  return {
    batch: await getAdminAppMembershipBatch(db, catalogVersionId, batchId, null, now),
    replayed: false,
  }
}

export async function submitAdminAppMembershipBatch(
  db: D1Database,
  catalogVersionId: string,
  batchId: string,
  adminId: number,
  idempotencyKey: string | null,
  input: AdminMembershipBatchSubmitInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ batch: AdminMembershipBatchView; replayed: boolean }> {
  validateBatchId(batchId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  await requireBatchControl(db, catalogVersionId)
  const requestHash = await sha256Hex(JSON.stringify({ operation: 'submit', batchId, catalogVersionId, expectedVersion }))
  const replay = await findBatchRequest(db, adminId, key)
  if (replay) {
    if (replay.operation !== 'submit' || replay.batch_id !== batchId || replay.request_hash !== requestHash) {
      throw idempotencyConflict()
    }
    return {
      batch: await getAdminAppMembershipBatch(db, catalogVersionId, batchId, null, now),
      replayed: true,
    }
  }

  const batch = await requireBatch(db, catalogVersionId, batchId)
  const leaseExpired = batch.status === 'processing'
    && Boolean(batch.processing_lease_expires_at)
    && Date.parse(batch.processing_lease_expires_at!) <= now.getTime()
  if (
    (!['draft', 'partial_failed'].includes(batch.status) && !leaseExpired)
    || Number(batch.version) !== expectedVersion
    || Number(batch.created_by) !== adminId
  ) {
    throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_VERSION_CONFLICT', '会员批量任务状态已变化，请刷新后重试')
  }
  const items = (await listBatchItems(db, batchId)).filter(item => (
    item.status === 'valid'
    || item.status === 'submit_failed'
    || (leaseExpired && item.status === 'submitting')
  ))
  if (!items.length) {
    throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_NO_RETRYABLE_ITEMS', '会员批量任务没有可提交或可恢复的有效行')
  }

  const timestamp = now.toISOString()
  const processingLeaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS).toISOString()
  const processingToken = randomId('ambx')
  const claimResults = await db.batch([
    db.prepare(`
      UPDATE app_membership_grant_batches
      SET status = 'processing', version = version + 1,
          processing_started_at = ?, processing_lease_expires_at = ?, processing_token = ?,
          processing_idempotency_key = ?, processing_request_hash = ?, submitted_at = NULL,
          updated_at = ?
      WHERE id = ? AND catalog_version_id = ? AND version = ? AND created_by = ?
        AND (
          status IN ('draft', 'partial_failed')
          OR (status = 'processing' AND processing_lease_expires_at <= ?)
        )
    `).bind(
      timestamp,
      processingLeaseExpiresAt,
      processingToken,
      key,
      requestHash,
      timestamp,
      batchId,
      catalogVersionId,
      expectedVersion,
      adminId,
      timestamp,
    ),
    db.prepare(`
      UPDATE app_membership_grant_batch_items
      SET status = 'submitting', processing_token = ?, error_code = NULL,
          error_summary = NULL, updated_at = ?
      WHERE batch_id = ?
        AND (
          status IN ('valid', 'submit_failed')
          OR (status = 'submitting' AND processing_token = ?)
        )
        AND EXISTS (
          SELECT 1 FROM app_membership_grant_batches batch
          WHERE batch.id = app_membership_grant_batch_items.batch_id
            AND batch.status = 'processing' AND batch.processing_token = ?
        )
    `).bind(processingToken, timestamp, batchId, batch.processing_token, processingToken),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.batch.submit_claim', 'app_membership_grant_batch', id, ?, ?, ?
      FROM app_membership_grant_batches
      WHERE id = ? AND status = 'processing' AND processing_token = ?
    `).bind(
      randomId('audit'),
      adminId,
      JSON.stringify({ status: batch.status, version: expectedVersion, recoveredExpiredLease: leaseExpired }),
      JSON.stringify({ status: 'processing', processingLeaseExpiresAt }),
      timestamp,
      batchId,
      processingToken,
    ),
  ])
  if (!claimResults[0]?.meta.changes) {
    throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_VERSION_CONFLICT', '会员批量任务已被其他操作修改')
  }

  for (const item of items) {
    const owned = await db.prepare(`
      SELECT 1 AS found
      FROM app_membership_grant_batch_items
      WHERE id = ? AND batch_id = ? AND status = 'submitting' AND processing_token = ?
      LIMIT 1
    `).bind(item.id, batchId, processingToken).first<{ found: number }>()
    if (!owned) continue
    if (
      item.target_user_id === null
      || !item.tier_id
      || !isGrantAction(item.action)
      || item.duration_days === null
      || !isGrantReason(item.reason_code)
      || !item.user_visible_note
      || !item.internal_note
      || !item.business_reference
    ) {
      await markSubmitFailed(
        db,
        item.id,
        batchId,
        processingToken,
        'MEMBERSHIP_BATCH_ROW_DATA_INVALID',
        '批量行标准化数据不完整',
        now,
      )
      continue
    }
    try {
      const result = await createAdminAppMembershipGrantChangeRequest(
        db,
        catalogVersionId,
        adminId,
        `membership.batch.${batchId}.${item.row_number}`,
        {
          userId: Number(item.target_user_id),
          tierId: item.tier_id,
          action: item.action,
          startsAt: item.requested_starts_at ?? undefined,
          durationDays: Number(item.duration_days),
          reasonCode: item.reason_code,
          userVisibleNote: item.user_visible_note,
          internalNote: item.internal_note,
          businessReference: item.business_reference,
        },
        now,
        requireProductionReady,
      )
      await db.prepare(`
        UPDATE app_membership_grant_batch_items
        SET status = 'submitted', processing_token = NULL, change_request_id = ?,
            error_code = NULL, error_summary = NULL, updated_at = ?
        WHERE id = ? AND batch_id = ? AND status = 'submitting' AND processing_token = ?
      `).bind(result.request.requestId, timestamp, item.id, batchId, processingToken).run()
    }
    catch (error) {
      const failure = toItemError(error)
      await markSubmitFailed(db, item.id, batchId, processingToken, failure.code, failure.summary, now)
    }
  }

  const itemCounts = await db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted_count,
      SUM(CASE WHEN status = 'submit_failed' THEN 1 ELSE 0 END) AS failed_count
    FROM app_membership_grant_batch_items
    WHERE batch_id = ?
  `).bind(batchId).first<{ submitted_count: number | null; failed_count: number | null }>()
  const submittedCount = Number(itemCounts?.submitted_count ?? 0)
  const failedCount = Number(itemCounts?.failed_count ?? 0)
  const finalStatus: AdminMembershipBatchStatus = failedCount > 0 || Number(batch.invalid_count) > 0
    ? 'partial_failed'
    : 'submitted'
  const finalResults = await db.batch([
    db.prepare(`
      UPDATE app_membership_grant_batches
      SET status = ?, submitted_count = ?, version = version + 1,
          processing_lease_expires_at = NULL, processing_token = NULL,
          submitted_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND processing_token = ?
    `).bind(finalStatus, submittedCount, timestamp, timestamp, batchId, processingToken),
    db.prepare(`
      INSERT INTO app_membership_grant_batch_requests (
        id, batch_id, actor_id, operation, idempotency_key, request_hash, result_status, created_at
      )
      SELECT ?, id, ?, 'submit', ?, ?, ?, ?
      FROM app_membership_grant_batches
      WHERE id = ? AND status = ? AND submitted_at = ? AND processing_idempotency_key = ?
    `).bind(
      randomId('ambr'),
      adminId,
      key,
      requestHash,
      finalStatus,
      timestamp,
      batchId,
      finalStatus,
      timestamp,
      key,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.batch.submit', 'app_membership_grant_batch', id, ?, ?, ?
      FROM app_membership_grant_batches
      WHERE id = ? AND status = ? AND submitted_at = ? AND processing_idempotency_key = ?
    `).bind(
      randomId('audit'),
      adminId,
      JSON.stringify({ status: batch.status, version: expectedVersion }),
      JSON.stringify({
        status: finalStatus,
        submittedCount,
        failedCount,
        invalidCount: Number(batch.invalid_count),
        independentReviewRequired: true,
      }),
      timestamp,
      batchId,
      finalStatus,
      timestamp,
      key,
    ),
  ])
  if (!finalResults[0]?.meta.changes) {
    throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_VERSION_CONFLICT', '会员批量任务结果未能提交，请刷新后恢复')
  }
  const request = await findBatchRequest(db, adminId, key)
  if (
    !request
    || request.operation !== 'submit'
    || request.batch_id !== batchId
    || request.request_hash !== requestHash
  ) {
    throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_VERSION_CONFLICT', '会员批量任务结果未能确认，请刷新后恢复')
  }
  return {
    batch: await getAdminAppMembershipBatch(db, catalogVersionId, batchId, null, now),
    replayed: false,
  }
}

export async function cancelAdminAppMembershipBatch(
  db: D1Database,
  catalogVersionId: string,
  batchId: string,
  adminId: number,
  idempotencyKey: string | null,
  input: AdminMembershipBatchCancelInput,
  now = new Date(),
): Promise<{ batch: AdminMembershipBatchView; replayed: boolean }> {
  validateBatchId(batchId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const reason = normalizeText(input.reason, 'reason', 3, 300)
  await requireBatchControl(db, catalogVersionId)
  const requestHash = await sha256Hex(JSON.stringify({
    operation: 'cancel',
    batchId,
    catalogVersionId,
    expectedVersion,
    reason,
  }))
  const replay = await findBatchRequest(db, adminId, key)
  if (replay) {
    if (replay.operation !== 'cancel' || replay.batch_id !== batchId || replay.request_hash !== requestHash) {
      throw idempotencyConflict()
    }
    return {
      batch: await getAdminAppMembershipBatch(db, catalogVersionId, batchId, null, now),
      replayed: true,
    }
  }

  const batch = await requireBatch(db, catalogVersionId, batchId)
  if (
    batch.status !== 'draft'
    || Number(batch.version) !== expectedVersion
    || Number(batch.created_by) !== adminId
  ) {
    throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_VERSION_CONFLICT', '只有创建人可以取消尚未提交的会员批量任务')
  }

  const timestamp = now.toISOString()
  let cancelled = false
  try {
    const results = await db.batch([
      db.prepare(`
        UPDATE app_membership_grant_batches
        SET status = 'cancelled', version = version + 1,
            cancelled_by = ?, cancellation_reason = ?, cancelled_at = ?, updated_at = ?
        WHERE id = ? AND catalog_version_id = ? AND status = 'draft'
          AND version = ? AND created_by = ?
      `).bind(
        adminId,
        reason,
        timestamp,
        timestamp,
        batchId,
        catalogVersionId,
        expectedVersion,
        adminId,
      ),
      db.prepare(`
        INSERT INTO app_membership_grant_batch_requests (
          id, batch_id, actor_id, operation, idempotency_key, request_hash, result_status, created_at
        )
        SELECT ?, id, ?, 'cancel', ?, ?, 'cancelled', ?
        FROM app_membership_grant_batches
        WHERE id = ? AND status = 'cancelled' AND cancelled_by = ? AND cancelled_at = ?
      `).bind(
        randomId('ambr'),
        adminId,
        key,
        requestHash,
        timestamp,
        batchId,
        adminId,
        timestamp,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app.membership.batch.cancel', 'app_membership_grant_batch', id, ?, ?, ?
        FROM app_membership_grant_batches
        WHERE id = ? AND status = 'cancelled' AND cancelled_by = ? AND cancelled_at = ?
      `).bind(
        randomId('audit'),
        adminId,
        JSON.stringify({ status: batch.status, version: expectedVersion }),
        JSON.stringify({ status: 'cancelled', reason }),
        timestamp,
        batchId,
        adminId,
        timestamp,
      ),
    ])
    cancelled = Boolean(results[0]?.meta.changes)
  }
  catch (error) {
    const raced = await findBatchRequest(db, adminId, key)
    if (raced?.operation === 'cancel' && raced.batch_id === batchId && raced.request_hash === requestHash) {
      return {
        batch: await getAdminAppMembershipBatch(db, catalogVersionId, batchId, null, now),
        replayed: true,
      }
    }
    if (raced) throw idempotencyConflict()
    throw error
  }
  if (!cancelled) {
    const raced = await findBatchRequest(db, adminId, key)
    if (raced?.operation === 'cancel' && raced.batch_id === batchId && raced.request_hash === requestHash) {
      return {
        batch: await getAdminAppMembershipBatch(db, catalogVersionId, batchId, null, now),
        replayed: true,
      }
    }
    throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_VERSION_CONFLICT', '会员批量任务已被其他操作修改')
  }
  const request = await findBatchRequest(db, adminId, key)
  if (
    !request
    || request.operation !== 'cancel'
    || request.batch_id !== batchId
    || request.request_hash !== requestHash
  ) {
    throw new AppMembershipError(409, 'MEMBERSHIP_BATCH_VERSION_CONFLICT', '会员批量任务取消结果未能确认')
  }
  return {
    batch: await getAdminAppMembershipBatch(db, catalogVersionId, batchId, null, now),
    replayed: false,
  }
}

async function requireBatch(
  db: D1Database,
  catalogVersionId: string,
  batchId: string,
): Promise<BatchRow> {
  const batch = await db.prepare(`
    ${batchSelect()}
    WHERE batch.id = ? AND batch.catalog_version_id = ?
    LIMIT 1
  `).bind(batchId, catalogVersionId).first<BatchRow>()
  if (!batch) throw new AppMembershipError(404, 'MEMBERSHIP_BATCH_NOT_FOUND', '会员批量任务不存在')
  return batch
}

function batchSelect() {
  return `
    SELECT batch.id, batch.catalog_version_id, batch.status, batch.source_name,
           batch.source_sha256, batch.total_count, batch.valid_count, batch.invalid_count,
           batch.risk_codes_json, batch.submitted_count, batch.version, batch.created_by,
           COALESCE(creator.nickname, creator.email) AS creator_label,
           batch.processing_started_at, batch.processing_lease_expires_at,
           batch.processing_token, batch.submitted_at, batch.cancelled_by,
           CASE WHEN batch.cancelled_by IS NULL THEN NULL
                ELSE COALESCE(canceller.nickname, canceller.email) END AS canceller_label,
           batch.cancellation_reason, batch.cancelled_at, batch.created_at, batch.updated_at
    FROM app_membership_grant_batches batch
    JOIN users creator ON creator.id = batch.created_by
    LEFT JOIN users canceller ON canceller.id = batch.cancelled_by
  `
}

async function listBatchItems(db: D1Database, batchId: string) {
  const result = await db.prepare(`
    SELECT id, row_number, account_public_id, target_user_id, tier_id,
           tier_name_snapshot, rank_snapshot, action, requested_starts_at,
           preview_starts_at, preview_expires_at, duration_days, reason_code,
           user_visible_note, internal_note, business_reference, status,
           error_code, error_summary, change_request_id
    FROM app_membership_grant_batch_items
    WHERE batch_id = ?
    ORDER BY row_number ASC
  `).bind(batchId).all<BatchItemRow>()
  return result.results
}

async function markSubmitFailed(
  db: D1Database,
  itemId: string,
  batchId: string,
  processingToken: string,
  code: string,
  summary: string,
  now: Date,
) {
  await db.prepare(`
    UPDATE app_membership_grant_batch_items
    SET status = 'submit_failed', processing_token = NULL,
        error_code = ?, error_summary = ?, updated_at = ?
    WHERE id = ? AND batch_id = ? AND status = 'submitting' AND processing_token = ?
  `).bind(
    safeErrorCode(code),
    summary.slice(0, 300),
    now.toISOString(),
    itemId,
    batchId,
    processingToken,
  ).run()
}

async function resolveActiveAccountUserId(db: D1Database, accountPublicId: string) {
  const account = await db.prepare(`
    SELECT account.id
    FROM app_account_security security
    JOIN users account ON account.id = security.account_id
    WHERE security.account_public_id = ?
      AND security.status = 'active'
      AND account.status = 'active'
    LIMIT 1
  `).bind(accountPublicId).first<{ id: number }>()
  if (!account) throw new AppMembershipError(404, 'ACCOUNT_NOT_FOUND', '目标 App 账号不存在或当前不可发放会员')
  return Number(account.id)
}

function parseCsv(csvText: string, maxRows: number): Array<Record<string, string>> {
  const rows = parseCsvRows(csvText)
  if (rows.length < 2) {
    throw new AppMembershipError(400, 'MEMBERSHIP_BATCH_CSV_EMPTY', 'CSV 必须包含表头和至少一行数据')
  }
  const headers = rows[0]!.map(value => value.trim().toLowerCase())
  if (
    headers.length !== EXPECTED_HEADERS.length
    || EXPECTED_HEADERS.some((header, index) => headers[index] !== header)
  ) {
    throw new AppMembershipError(
      400,
      'MEMBERSHIP_BATCH_CSV_HEADERS_INVALID',
      `CSV 表头必须依次为 ${EXPECTED_HEADERS.join(',')}`,
    )
  }
  const dataRows = rows.slice(1).filter(row => row.some(value => value.trim()))
  const effectiveMaxRows = Math.min(MAX_ROWS, maxRows)
  if (!dataRows.length || dataRows.length > effectiveMaxRows) {
    throw new AppMembershipError(
      400,
      'MEMBERSHIP_BATCH_ROW_COUNT_INVALID',
      `CSV 数据行必须为 1–${effectiveMaxRows} 行`,
    )
  }
  const invalidColumnIndex = dataRows.findIndex(row => row.length !== EXPECTED_HEADERS.length)
  if (invalidColumnIndex >= 0) {
    throw new AppMembershipError(
      400,
      'MEMBERSHIP_BATCH_CSV_COLUMNS_INVALID',
      `CSV 第 ${invalidColumnIndex + 2} 行必须包含 ${EXPECTED_HEADERS.length} 列`,
    )
  }
  return dataRows.map(row => Object.fromEntries(
    EXPECTED_HEADERS.map((header, index) => [header, row[index] ?? '']),
  ))
}

function parseCsvRows(value: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"'
        index += 1
      }
      else quoted = !quoted
    }
    else if (character === ',' && !quoted) {
      row.push(field)
      field = ''
    }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && value[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    }
    else field += character
  }
  if (quoted) throw new AppMembershipError(400, 'MEMBERSHIP_BATCH_CSV_INVALID', 'CSV 存在未闭合的引号')
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function normalizeCsvRow(row: Record<string, string>): NormalizedCsvRow {
  const accountId = normalizeText(row.account_id, 'account_id', 5, 80)
  if (!ACCOUNT_PUBLIC_ID.test(accountId)) {
    throw new AppMembershipError(400, 'ACCOUNT_ID_INVALID', 'account_id 格式无效')
  }
  const tierId = normalizeText(row.tier_id, 'tier_id', 5, 80)
  if (!TIER_ID.test(tierId)) {
    throw new AppMembershipError(400, 'MEMBERSHIP_TIER_INVALID', 'tier_id 格式无效')
  }
  const action = normalizeGrantAction(row.action)
  const startsAt = normalizeStartsAt(row.starts_at)
  const durationDays = normalizeBoundedInteger(row.duration_days, 'duration_days', 1, 366)
  const reasonCode = normalizeGrantReason(row.reason_code)
  const userVisibleNote = normalizeText(row.user_visible_note, 'user_visible_note', 1, 240)
  const internalNote = normalizeText(row.internal_note, 'internal_note', 1, 1000)
  const businessReference = normalizeText(row.business_reference, 'business_reference', 3, 100)
  return {
    accountId,
    tierId,
    action,
    startsAt,
    durationDays,
    reasonCode,
    userVisibleNote,
    internalNote,
    businessReference,
  }
}

function tryNormalizeCsvRow(row: Record<string, string>): NormalizedCsvRow | null {
  try { return normalizeCsvRow(row) }
  catch { return null }
}

function normalizeGrantAction(value: unknown): AppMembershipGrantAction {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized === 'grant' || normalized === 'renew') return normalized
  throw new AppMembershipError(400, 'MEMBERSHIP_ACTION_INVALID', 'action 只允许 grant 或 renew')
}

function normalizeGrantReason(value: unknown): AppMembershipGrantReason {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    normalized === 'manual_review'
    || normalized === 'customer_support'
    || normalized === 'promotion'
    || normalized === 'compensation'
  ) return normalized
  throw new AppMembershipError(400, 'MEMBERSHIP_REASON_INVALID', 'reason_code 无效')
}

function normalizeStartsAt(value: unknown): string | null {
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'MEMBERSHIP_START_INVALID', 'starts_at 必须是 ISO 时间或留空')
  }
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > 64) {
    throw new AppMembershipError(400, 'MEMBERSHIP_START_INVALID', 'starts_at 长度无效')
  }
  const parsed = new Date(normalized)
  if (!Number.isFinite(parsed.getTime())) {
    throw new AppMembershipError(400, 'MEMBERSHIP_START_INVALID', 'starts_at 必须是有效 ISO 时间')
  }
  return parsed.toISOString()
}

function normalizeCsvText(value: unknown) {
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'MEMBERSHIP_BATCH_CSV_REQUIRED', 'csvText 为必填文本')
  }
  const normalized = value.replace(/^\uFEFF/u, '').trim()
  if (!normalized || new TextEncoder().encode(normalized).byteLength > 500_000) {
    throw new AppMembershipError(400, 'MEMBERSHIP_BATCH_CSV_SIZE_INVALID', 'CSV 内容必须小于 500 KB')
  }
  return normalized
}

function normalizeText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'INVALID_REQUEST', `${field} 必须是文本`)
  }
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) {
    throw new AppMembershipError(400, 'INVALID_REQUEST', `${field} 长度必须为 ${min}–${max}`)
  }
  return normalized
}

function normalizeBoundedInteger(value: unknown, field: string, min: number, max: number) {
  const normalized = typeof value === 'string' && value.trim() ? Number(value.trim()) : Number.NaN
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new AppMembershipError(400, 'INVALID_REQUEST', `${field} 必须为 ${min}–${max} 的整数`)
  }
  return normalized
}

function normalizePositiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppMembershipError(400, 'INVALID_REQUEST', `${field} 必须是正整数`)
  }
  return Number(value)
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AppMembershipError(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要有效的 Idempotency-Key')
  }
  return normalized
}

function validateBatchId(value: string) {
  if (!BATCH_ID.test(value)) {
    throw new AppMembershipError(404, 'MEMBERSHIP_BATCH_NOT_FOUND', '会员批量任务不存在')
  }
}

async function requireBatchControl(db: D1Database, catalogVersionId: string) {
  const control = await db.prepare(`
    SELECT enabled, max_rows, large_batch_threshold
    FROM app_membership_batch_controls
    WHERE catalog_version_id = ?
    LIMIT 1
  `).bind(catalogVersionId).first<BatchControlRow>()
  if (!control || Number(control.enabled) !== 1) {
    throw new AppMembershipError(403, 'MEMBERSHIP_BATCH_GRANTS_DISABLED', '会员批量发放尚未通过配置门禁')
  }
  return control
}

function toBatchView(row: BatchRow, now = new Date()): AdminMembershipBatchView {
  if (!isBatchStatus(row.status)) throw invalidStoredBatch()
  return {
    batchId: row.id,
    catalogVersionId: row.catalog_version_id,
    status: row.status,
    sourceName: row.source_name,
    sourceSha256: row.source_sha256,
    totalCount: Number(row.total_count),
    validCount: Number(row.valid_count),
    invalidCount: Number(row.invalid_count),
    riskCodes: parseRiskCodes(row.risk_codes_json),
    submittedCount: Number(row.submitted_count),
    version: Number(row.version),
    createdBy: { id: Number(row.created_by), label: row.creator_label },
    processingStartedAt: row.processing_started_at,
    processingLeaseExpiresAt: row.processing_lease_expires_at,
    processingRecoverable: row.status === 'processing'
      && Boolean(row.processing_lease_expires_at)
      && Date.parse(row.processing_lease_expires_at!) <= now.getTime(),
    submittedAt: row.submitted_at,
    cancelledBy: row.cancelled_by !== null && row.canceller_label
      ? { id: Number(row.cancelled_by), label: row.canceller_label }
      : null,
    cancellationReason: row.cancellation_reason,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toBatchItemView(row: BatchItemRow): AdminMembershipBatchItemView {
  if (!isBatchItemStatus(row.status)) throw invalidStoredBatch()
  return {
    itemId: row.id,
    rowNumber: Number(row.row_number),
    accountId: row.account_public_id,
    tierId: row.tier_id,
    tierName: row.tier_name_snapshot,
    rank: row.rank_snapshot === null ? null : Number(row.rank_snapshot),
    action: isGrantAction(row.action) ? row.action : null,
    requestedStartsAt: row.requested_starts_at,
    previewStartsAt: row.preview_starts_at,
    previewExpiresAt: row.preview_expires_at,
    durationDays: row.duration_days === null ? null : Number(row.duration_days),
    reasonCode: isGrantReason(row.reason_code) ? row.reason_code : null,
    userVisibleNote: row.user_visible_note,
    internalNote: row.internal_note,
    businessReference: row.business_reference,
    status: row.status,
    error: row.error_code && row.error_summary
      ? { code: row.error_code, summary: row.error_summary }
      : null,
    changeRequestId: row.change_request_id,
  }
}

async function findBatchByKey(db: D1Database, actorId: number, key: string) {
  return db.prepare(`
    SELECT id, catalog_version_id, request_hash
    FROM app_membership_grant_batches
    WHERE created_by = ? AND request_idempotency_key = ?
    LIMIT 1
  `).bind(actorId, key).first<{ id: string; catalog_version_id: string; request_hash: string }>()
}

async function findBatchRequest(db: D1Database, actorId: number, key: string) {
  return db.prepare(`
    SELECT batch_id, operation, request_hash
    FROM app_membership_grant_batch_requests
    WHERE actor_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorId, key).first<{ batch_id: string; operation: 'submit' | 'cancel'; request_hash: string }>()
}

function parseRiskCodes(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('invalid')
    return parsed as string[]
  }
  catch { throw invalidStoredBatch() }
}

function isBatchStatus(value: string): value is AdminMembershipBatchStatus {
  return value === 'draft'
    || value === 'processing'
    || value === 'submitted'
    || value === 'partial_failed'
    || value === 'cancelled'
}

function isBatchItemStatus(value: string): value is AdminMembershipBatchItemStatus {
  return value === 'valid'
    || value === 'invalid'
    || value === 'submitting'
    || value === 'submitted'
    || value === 'submit_failed'
}

function isGrantAction(value: unknown): value is AppMembershipGrantAction {
  return value === 'grant' || value === 'renew'
}

function isGrantReason(value: unknown): value is AppMembershipGrantReason {
  return value === 'manual_review'
    || value === 'customer_support'
    || value === 'promotion'
    || value === 'compensation'
}

function toItemError(error: unknown) {
  if (error instanceof AppMembershipError) {
    return { code: safeErrorCode(error.code), summary: error.message.slice(0, 300) }
  }
  return { code: 'MEMBERSHIP_BATCH_ROW_INVALID', summary: '该行无法通过会员发放预览校验' }
}

function safeErrorCode(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_').slice(0, 80)
  return normalized.length >= 3 ? normalized : 'MEMBERSHIP_BATCH_ROW_INVALID'
}

function invalidStoredBatch() {
  return new AppMembershipError(503, 'MEMBERSHIP_BATCH_DATA_INVALID', '会员批量任务数据异常', true)
}

function idempotencyConflict() {
  return new AppMembershipError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键已用于其他会员批量任务')
}

function randomId(prefix: 'amb' | 'ambi' | 'ambr' | 'ambx' | 'audit') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
