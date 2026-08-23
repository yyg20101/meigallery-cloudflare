import type { AppWalletEntryType, AppWalletReasonCode } from '@meigallery/shared'
import {
  createAdminAppWalletAdjustment,
  prepareAdminWalletAdjustment,
} from './admin-app-wallet'
import {
  AppWalletError,
  requireAppWalletPolicy,
  type AppWalletRuntimeConfig,
} from './app-wallet'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const BATCH_ID = /^wab_[A-Za-z0-9_-]{1,91}$/u
const MAX_ROWS = 200
const PROCESSING_LEASE_MS = 10 * 60 * 1000
const EXPECTED_HEADERS = [
  'account_id',
  'action_type',
  'amount',
  'reason_code',
  'user_visible_note',
  'internal_note',
  'business_reference',
] as const

export interface AdminWalletBatchCreateInput {
  sourceName?: unknown
  csvText?: unknown
}

export interface AdminWalletBatchSubmitInput {
  expectedVersion?: unknown
}

export type AdminWalletBatchStatus = 'draft' | 'pending_review' | 'processing' | 'completed' | 'partial_failed' | 'cancelled'
export type AdminWalletBatchItemStatus = 'valid' | 'invalid' | 'submitting' | 'submitted' | 'submit_failed'

export interface AdminWalletBatchItemView {
  itemId: string
  rowNumber: number
  accountId: string | null
  actionType: AppWalletEntryType | null
  amount: number | null
  reasonCode: AppWalletReasonCode | null
  userVisibleNote: string | null
  internalNote: string | null
  businessReference: string | null
  status: AdminWalletBatchItemStatus
  error: { code: string; summary: string } | null
  adjustmentId: string | null
}

export interface AdminWalletBatchView {
  batchId: string
  policyId: string
  status: AdminWalletBatchStatus
  sourceName: string
  sourceSha256: string
  totalCount: number
  validCount: number
  invalidCount: number
  totalAmount: number
  riskCodes: string[]
  submittedCount: number
  version: number
  createdBy: { id: number; label: string }
  processingStartedAt: string | null
  processingLeaseExpiresAt: string | null
  processingRecoverable: boolean
  submittedAt: string | null
  createdAt: string
  updatedAt: string
  items?: AdminWalletBatchItemView[]
}

type BatchRow = {
  id: string
  policy_id: string
  status: string
  source_name: string
  source_sha256: string
  total_count: number
  valid_count: number
  invalid_count: number
  total_amount: number
  risk_codes_json: string
  submitted_count: number
  version: number
  created_by: number
  creator_label: string
  processing_started_at: string | null
  processing_lease_expires_at: string | null
  processing_token: string | null
  submitted_at: string | null
  created_at: string
  updated_at: string
}

type BatchItemRow = {
  id: string
  row_number: number
  account_public_id: string | null
  action_type: string | null
  amount: number | null
  reason_code: string | null
  user_visible_note: string | null
  internal_note: string | null
  business_reference: string | null
  status: string
  error_code: string | null
  error_summary: string | null
  adjustment_id: string | null
}

type PreparedCsvRow = {
  rowNumber: number
  raw: Record<string, string>
  rowSha256: string
  normalized: null | {
    accountId: string
    actionType: 'admin_credit' | 'admin_debit' | 'compensation'
    amount: number
    reasonCode: 'manual_adjustment' | 'service_compensation' | 'correction'
    userVisibleNote: string
    internalNote: string
    businessReference: string
  }
  error: { code: string; summary: string } | null
}

type BatchControlRow = {
  enabled: number
  max_rows: number
  max_total_amount: number
}

export async function listAdminAppWalletBatches(
  db: D1Database,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<AdminWalletBatchView[]> {
  await requireAppWalletPolicy(db, config)
  const result = await db.prepare(`${batchSelect()} ORDER BY batch.created_at DESC, batch.id DESC LIMIT 100`).all<BatchRow>()
  return result.results.map(row => toBatchView(row, now))
}

export async function getAdminAppWalletBatch(
  db: D1Database,
  batchId: string,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<AdminWalletBatchView> {
  validateBatchId(batchId)
  await requireAppWalletPolicy(db, config)
  const batch = await requireBatch(db, batchId)
  const items = await listBatchItems(db, batchId)
  return { ...toBatchView(batch, now), items: items.map(toBatchItemView) }
}

export async function createAdminAppWalletBatchPreview(
  db: D1Database,
  adminId: number,
  idempotencyKey: string | null,
  input: AdminWalletBatchCreateInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ batch: AdminWalletBatchView; replayed: boolean }> {
  const key = normalizeIdempotencyKey(idempotencyKey)
  const policy = await requireAppWalletPolicy(db, config, { writable: true })
  const batchControl = await requireBatchControl(db, policy.id)
  const sourceName = normalizeText(input.sourceName, 'sourceName', 1, 120)
  const csvText = normalizeCsvText(input.csvText)
  const sourceSha256 = await sha256Hex(csvText)
  const requestHash = await sha256Hex(JSON.stringify({ policyId: policy.id, sourceName, sourceSha256 }))
  const replay = await findBatchByKey(db, adminId, key)
  if (replay) {
    if (replay.request_hash !== requestHash) throw idempotencyConflict()
    return { batch: await getAdminAppWalletBatch(db, replay.id, config, now), replayed: true }
  }

  const parsedRows = parseCsv(csvText, Number(batchControl.max_rows))
  const businessReferences = new Set<string>()
  const preparedRows = await Promise.all(parsedRows.map(async (row, index): Promise<PreparedCsvRow> => {
    const rowNumber = index + 2
    const rowSha256 = await sha256Hex(JSON.stringify(row))
    try {
      const normalized = normalizeCsvRow(row)
      if (businessReferences.has(normalized.businessReference)) {
        throw new AppWalletError(409, 'BATCH_DUPLICATE_BUSINESS_REFERENCE', '批次内业务单号重复')
      }
      businessReferences.add(normalized.businessReference)
      const prepared = await prepareAdminWalletAdjustment(db, normalized, policy)
      const blocking = prepared.riskCodes.find(code => code !== 'POLICY_UNRESOLVED_ALL_REVIEW')
      if (blocking) throw riskError(blocking)
      return { rowNumber, raw: row, rowSha256, normalized, error: null }
    }
    catch (error) {
      return {
        rowNumber,
        raw: row,
        rowSha256,
        normalized: tryNormalizeCsvRow(row),
        error: toItemError(error),
      }
    }
  }))
  const validRows = preparedRows.filter(row => !row.error && row.normalized)
  const totalAmount = preparedRows.reduce((sum, row) => sum + (row.normalized?.amount ?? 0), 0)
  const riskCodes = [
    ...(preparedRows.length >= Math.min(100, Number(batchControl.max_rows)) ? ['LARGE_BATCH'] : []),
    ...(totalAmount > Number(batchControl.max_total_amount) ? ['TOTAL_AMOUNT_HIGH'] : []),
    ...(preparedRows.some(row => row.error?.code === 'BATCH_DUPLICATE_BUSINESS_REFERENCE') ? ['DUPLICATE_ROW'] : []),
    ...(preparedRows.some(row => row.error) ? ['PARTIAL_INVALID'] : []),
  ]
  const timestamp = now.toISOString()
  const batchId = randomId('wab')
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_wallet_adjustment_batches (
        id, policy_id, status, source_name, source_sha256, total_count,
        valid_count, invalid_count, total_amount, risk_codes_json, submitted_count,
        version, request_idempotency_key, request_hash, created_by, created_at, updated_at
      ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)
    `).bind(
      batchId,
      policy.id,
      sourceName,
      sourceSha256,
      preparedRows.length,
      validRows.length,
      preparedRows.length - validRows.length,
      totalAmount,
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
      INSERT INTO app_wallet_adjustment_batch_items (
        id, batch_id, row_number, row_sha256, raw_row_json, account_public_id,
        action_type, amount, reason_code, user_visible_note, internal_note,
        business_reference, status, error_code, error_summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      randomId('wabi'),
      batchId,
      row.rowNumber,
      row.rowSha256,
      JSON.stringify(row.raw),
      row.normalized?.accountId ?? null,
      row.normalized?.actionType ?? null,
      row.normalized?.amount ?? null,
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
    ) VALUES (?, ?, 'app.wallet.batch.preview', 'app_wallet_adjustment_batch', ?, NULL, ?, ?)
  `).bind(
    randomId('log'),
    adminId,
    batchId,
    JSON.stringify({ sourceName, sourceSha256, totalCount: preparedRows.length, validCount: validRows.length, totalAmount, riskCodes }),
    timestamp,
  ))
  await db.batch(statements)
  return { batch: await getAdminAppWalletBatch(db, batchId, config, now), replayed: false }
}

export async function submitAdminAppWalletBatch(
  db: D1Database,
  batchId: string,
  adminId: number,
  idempotencyKey: string | null,
  input: AdminWalletBatchSubmitInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ batch: AdminWalletBatchView; replayed: boolean }> {
  validateBatchId(batchId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const policy = await requireAppWalletPolicy(db, config, { writable: true })
  await requireBatchControl(db, policy.id)
  const requestHash = await sha256Hex(JSON.stringify({ batchId, expectedVersion }))
  const replay = await findBatchRequest(db, adminId, key)
  if (replay) {
    if (replay.batch_id !== batchId) throw idempotencyConflict()
    return { batch: await getAdminAppWalletBatch(db, batchId, config, now), replayed: true }
  }
  const batch = await requireBatch(db, batchId)
  const leaseExpired = batch.status === 'processing'
    && Boolean(batch.processing_lease_expires_at)
    && Date.parse(batch.processing_lease_expires_at!) <= now.getTime()
  if (
    (!['draft', 'partial_failed'].includes(batch.status) && !leaseExpired)
    || Number(batch.version) !== expectedVersion
    || Number(batch.created_by) !== adminId
  ) {
    throw new AppWalletError(409, 'WALLET_BATCH_VERSION_CONFLICT', '批量任务状态已变化，请刷新后重试')
  }
  const riskCodes = parseRiskCodes(batch.risk_codes_json)
  if (riskCodes.includes('TOTAL_AMOUNT_HIGH')) {
    throw new AppWalletError(409, 'WALLET_BATCH_TOTAL_AMOUNT_EXCEEDED', '批量金币总额超过治理上限，禁止提交')
  }
  const items = (await listBatchItems(db, batchId)).filter(item => (
    item.status === 'valid' || item.status === 'submit_failed' || (leaseExpired && item.status === 'submitting')
  ))
  if (!items.length) throw new AppWalletError(409, 'WALLET_BATCH_NO_VALID_ITEMS', '批量任务没有可提交的有效行')
  const timestamp = now.toISOString()
  const processingLeaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS).toISOString()
  const processingToken = randomId('wabx')
  const claimResults = await db.batch([
    db.prepare(`
    UPDATE app_wallet_adjustment_batches
    SET status = 'processing', version = version + 1,
        processing_started_at = ?, processing_lease_expires_at = ?, processing_token = ?,
        processing_idempotency_key = ?, processing_request_hash = ?, submitted_at = NULL, updated_at = ?
    WHERE id = ? AND version = ? AND created_by = ?
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
      expectedVersion,
      adminId,
      timestamp,
    ),
    db.prepare(`
      UPDATE app_wallet_adjustment_batch_items
      SET status = 'submitting', processing_token = ?, error_code = NULL, error_summary = NULL, updated_at = ?
      WHERE batch_id = ?
        AND (
          status IN ('valid', 'submit_failed')
          OR (status = 'submitting' AND processing_token = ?)
        )
        AND EXISTS (
          SELECT 1 FROM app_wallet_adjustment_batches batch
          WHERE batch.id = app_wallet_adjustment_batch_items.batch_id
            AND batch.status = 'processing' AND batch.processing_token = ?
        )
    `).bind(processingToken, timestamp, batchId, batch.processing_token, processingToken),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.batch.submit_claim', 'app_wallet_adjustment_batch', id, ?, ?, ?
      FROM app_wallet_adjustment_batches
      WHERE id = ? AND status = 'processing' AND processing_token = ?
    `).bind(
      randomId('log'),
      adminId,
      JSON.stringify({ status: batch.status, version: expectedVersion, recoveredExpiredLease: leaseExpired }),
      JSON.stringify({ status: 'processing', processingLeaseExpiresAt }),
      timestamp,
      batchId,
      processingToken,
    ),
  ])
  if (!claimResults[0]?.meta.changes) throw new AppWalletError(409, 'WALLET_BATCH_VERSION_CONFLICT', '批量任务已被其他操作修改')

  for (const item of items) {
    const owned = await db.prepare(`
      SELECT 1 AS found FROM app_wallet_adjustment_batch_items
      WHERE id = ? AND batch_id = ? AND status = 'submitting' AND processing_token = ?
      LIMIT 1
    `).bind(item.id, batchId, processingToken).first<{ found: number }>()
    if (!owned) continue
    if (!item.account_public_id || !item.action_type || item.amount === null || !item.reason_code || !item.user_visible_note || !item.internal_note || !item.business_reference) {
      await markSubmitFailed(db, item.id, batchId, processingToken, 'BATCH_ROW_DATA_INVALID', '批量行标准化数据不完整', now)
      continue
    }
    try {
      const result = await createAdminAppWalletAdjustment(
        db,
        adminId,
        `wallet.batch.${batchId}.${item.row_number}`,
        {
          accountId: item.account_public_id,
          actionType: item.action_type,
          amount: Number(item.amount),
          reasonCode: item.reason_code,
          userVisibleNote: item.user_visible_note,
          internalNote: item.internal_note,
          businessReference: item.business_reference,
        },
        config,
        now,
      )
      await db.prepare(`
        UPDATE app_wallet_adjustment_batch_items
        SET status = 'submitted', processing_token = NULL, adjustment_id = ?, error_code = NULL, error_summary = NULL, updated_at = ?
        WHERE id = ? AND batch_id = ? AND status = 'submitting' AND processing_token = ?
      `).bind(result.adjustment.adjustmentId, timestamp, item.id, batchId, processingToken).run()
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
    FROM app_wallet_adjustment_batch_items WHERE batch_id = ?
  `).bind(batchId).first<{ submitted_count: number | null; failed_count: number | null }>()
  const submittedCount = Number(itemCounts?.submitted_count ?? 0)
  const failedCount = Number(itemCounts?.failed_count ?? 0)
  const finalStatus: AdminWalletBatchStatus = failedCount > 0 || Number(batch.invalid_count) > 0 ? 'partial_failed' : 'completed'
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_adjustment_batches
      SET status = ?, submitted_count = ?, version = version + 1,
          processing_lease_expires_at = NULL, processing_token = NULL,
          submitted_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND processing_token = ?
    `).bind(finalStatus, submittedCount, timestamp, timestamp, batchId, processingToken),
    db.prepare(`
      INSERT INTO app_wallet_adjustment_batch_requests (
        id, batch_id, actor_id, idempotency_key, request_hash, result_status, created_at
      )
      SELECT ?, id, ?, ?, ?, ?, ? FROM app_wallet_adjustment_batches
      WHERE id = ? AND status = ? AND submitted_at = ? AND processing_idempotency_key = ?
    `).bind(randomId('wabr'), adminId, key, requestHash, finalStatus, timestamp, batchId, finalStatus, timestamp, key),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.batch.submit', 'app_wallet_adjustment_batch', id, ?, ?, ?
      FROM app_wallet_adjustment_batches
      WHERE id = ? AND status = ? AND submitted_at = ? AND processing_idempotency_key = ?
    `).bind(
      randomId('log'),
      adminId,
      JSON.stringify({ status: batch.status, version: expectedVersion }),
      JSON.stringify({ status: finalStatus, submittedCount, failedCount, independentReviewRequired: true }),
      timestamp,
      batchId,
      finalStatus,
      timestamp,
      key,
    ),
  ])
  const request = await findBatchRequest(db, adminId, key)
  if (!request) throw new AppWalletError(409, 'WALLET_BATCH_VERSION_CONFLICT', '批量任务结果未能确认，请刷新后重试')
  return { batch: await getAdminAppWalletBatch(db, batchId, config, now), replayed: false }
}

async function requireBatch(db: D1Database, batchId: string): Promise<BatchRow> {
  const batch = await db.prepare(`${batchSelect()} WHERE batch.id = ? LIMIT 1`).bind(batchId).first<BatchRow>()
  if (!batch) throw new AppWalletError(404, 'WALLET_BATCH_NOT_FOUND', '批量调币任务不存在')
  return batch
}

function batchSelect() {
  return `
    SELECT batch.id, batch.policy_id, batch.status, batch.source_name, batch.source_sha256,
           batch.total_count, batch.valid_count, batch.invalid_count, batch.total_amount,
           batch.risk_codes_json, batch.submitted_count, batch.version, batch.created_by,
           COALESCE(creator.nickname, creator.email) AS creator_label,
           batch.processing_started_at, batch.processing_lease_expires_at, batch.processing_token,
           batch.submitted_at, batch.created_at, batch.updated_at
    FROM app_wallet_adjustment_batches batch
    JOIN users creator ON creator.id = batch.created_by
  `
}

async function listBatchItems(db: D1Database, batchId: string) {
  const result = await db.prepare(`
    SELECT id, row_number, account_public_id, action_type, amount, reason_code,
           user_visible_note, internal_note, business_reference, status,
           error_code, error_summary, adjustment_id
    FROM app_wallet_adjustment_batch_items
    WHERE batch_id = ? ORDER BY row_number ASC
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
    UPDATE app_wallet_adjustment_batch_items
    SET status = 'submit_failed', processing_token = NULL, error_code = ?, error_summary = ?, updated_at = ?
    WHERE id = ? AND batch_id = ? AND status = 'submitting' AND processing_token = ?
  `).bind(code.slice(0, 80), summary.slice(0, 300), now.toISOString(), itemId, batchId, processingToken).run()
}

function parseCsv(csvText: string, maxRows: number): Array<Record<string, string>> {
  const rows = parseCsvRows(csvText)
  if (rows.length < 2) throw new AppWalletError(400, 'WALLET_BATCH_CSV_EMPTY', 'CSV 必须包含表头和至少一行数据')
  const headers = rows[0]!.map(value => value.trim().toLowerCase())
  if (headers.length !== EXPECTED_HEADERS.length || EXPECTED_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new AppWalletError(400, 'WALLET_BATCH_CSV_HEADERS_INVALID', `CSV 表头必须依次为 ${EXPECTED_HEADERS.join(',')}`)
  }
  const dataRows = rows.slice(1).filter(row => row.some(value => value.trim()))
  const effectiveMaxRows = Math.min(MAX_ROWS, maxRows)
  if (!dataRows.length || dataRows.length > effectiveMaxRows) {
    throw new AppWalletError(400, 'WALLET_BATCH_ROW_COUNT_INVALID', `CSV 数据行必须为 1–${effectiveMaxRows} 行`)
  }
  return dataRows.map(row => Object.fromEntries(EXPECTED_HEADERS.map((header, index) => [header, row[index] ?? ''])))
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
  if (quoted) throw new AppWalletError(400, 'WALLET_BATCH_CSV_INVALID', 'CSV 存在未闭合的引号')
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function normalizeCsvRow(row: Record<string, string>) {
  const accountId = normalizeText(row.account_id, 'account_id', 5, 80)
  if (!/^acc_[A-Za-z0-9_-]{1,76}$/u.test(accountId)) throw new AppWalletError(400, 'INVALID_ACCOUNT_ID', 'account_id 格式无效')
  const actionType = normalizeActionType(row.action_type ?? '')
  const amount = normalizePositiveInteger(Number(row.amount), 'amount')
  const reasonCode = normalizeReasonCode(row.reason_code ?? '', actionType)
  const userVisibleNote = normalizeText(row.user_visible_note, 'user_visible_note', 2, 160)
  const internalNote = normalizeText(row.internal_note, 'internal_note', 2, 500)
  const businessReference = normalizeText(row.business_reference, 'business_reference', 3, 80)
  if (!/^[A-Za-z0-9._:/-]+$/u.test(businessReference)) throw new AppWalletError(400, 'INVALID_BUSINESS_REFERENCE', 'business_reference 格式无效')
  return { accountId, actionType, amount, reasonCode, userVisibleNote, internalNote, businessReference }
}

function tryNormalizeCsvRow(row: Record<string, string>) {
  try { return normalizeCsvRow(row) }
  catch { return null }
}

function normalizeActionType(value: string): 'admin_credit' | 'admin_debit' | 'compensation' {
  const normalized = value.trim()
  if (normalized === 'admin_credit' || normalized === 'admin_debit' || normalized === 'compensation') return normalized
  throw new AppWalletError(400, 'INVALID_ADJUSTMENT_TYPE', 'action_type 只允许 admin_credit、admin_debit、compensation')
}

function normalizeReasonCode(value: string, actionType: string): 'manual_adjustment' | 'service_compensation' | 'correction' {
  const normalized = value.trim()
  if (actionType === 'compensation' && normalized !== 'service_compensation') {
    throw new AppWalletError(400, 'INVALID_REASON_CODE', 'compensation 必须使用 service_compensation')
  }
  if (normalized === 'manual_adjustment' || normalized === 'service_compensation' || normalized === 'correction') return normalized
  throw new AppWalletError(400, 'INVALID_REASON_CODE', 'reason_code 无效')
}

function toBatchView(row: BatchRow, now = new Date()): AdminWalletBatchView {
  if (!isBatchStatus(row.status)) throw invalidStoredBatch()
  return {
    batchId: row.id,
    policyId: row.policy_id,
    status: row.status,
    sourceName: row.source_name,
    sourceSha256: row.source_sha256,
    totalCount: Number(row.total_count),
    validCount: Number(row.valid_count),
    invalidCount: Number(row.invalid_count),
    totalAmount: Number(row.total_amount),
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toBatchItemView(row: BatchItemRow): AdminWalletBatchItemView {
  if (!isBatchItemStatus(row.status)) throw invalidStoredBatch()
  return {
    itemId: row.id,
    rowNumber: Number(row.row_number),
    accountId: row.account_public_id,
    actionType: row.action_type as AppWalletEntryType | null,
    amount: row.amount === null ? null : Number(row.amount),
    reasonCode: row.reason_code as AppWalletReasonCode | null,
    userVisibleNote: row.user_visible_note,
    internalNote: row.internal_note,
    businessReference: row.business_reference,
    status: row.status,
    error: row.error_code && row.error_summary ? { code: row.error_code, summary: row.error_summary } : null,
    adjustmentId: row.adjustment_id,
  }
}

async function findBatchByKey(db: D1Database, actorId: number, key: string) {
  return db.prepare(`SELECT id, request_hash FROM app_wallet_adjustment_batches WHERE created_by = ? AND request_idempotency_key = ? LIMIT 1`)
    .bind(actorId, key).first<{ id: string; request_hash: string }>()
}

async function findBatchRequest(db: D1Database, actorId: number, key: string) {
  return db.prepare(`SELECT batch_id, request_hash FROM app_wallet_adjustment_batch_requests WHERE actor_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(actorId, key).first<{ batch_id: string; request_hash: string }>()
}

async function requireBatchControl(db: D1Database, policyId: string) {
  const control = await db.prepare(`
    SELECT enabled, max_rows, max_total_amount
    FROM app_wallet_batch_controls WHERE policy_id = ? LIMIT 1
  `).bind(policyId).first<BatchControlRow>()
  if (!control || Number(control.enabled) !== 1) {
    throw new AppWalletError(403, 'WALLET_BATCH_ADJUSTMENTS_DISABLED', '批量调币尚未通过配置门禁')
  }
  return control
}

function normalizeCsvText(value: unknown) {
  if (typeof value !== 'string') throw new AppWalletError(400, 'WALLET_BATCH_CSV_REQUIRED', 'csvText 为必填文本')
  const normalized = value.replace(/^\uFEFF/u, '').trim()
  if (!normalized || normalized.length > 500_000) throw new AppWalletError(400, 'WALLET_BATCH_CSV_SIZE_INVALID', 'CSV 内容必须小于 500 KB')
  return normalized
}

function normalizeText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 必须是文本`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 长度必须为 ${min}–${max}`)
  return normalized
}

function normalizePositiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 必须是正整数`)
  return Number(value)
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) throw new AppWalletError(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要有效的 Idempotency-Key')
  return normalized
}

function validateBatchId(value: string) {
  if (!BATCH_ID.test(value)) throw new AppWalletError(404, 'WALLET_BATCH_NOT_FOUND', '批量调币任务不存在')
}

function parseRiskCodes(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('invalid')
    return parsed as string[]
  }
  catch { throw invalidStoredBatch() }
}

function isBatchStatus(value: string): value is AdminWalletBatchStatus {
  return value === 'draft' || value === 'pending_review' || value === 'processing'
    || value === 'completed' || value === 'partial_failed' || value === 'cancelled'
}

function isBatchItemStatus(value: string): value is AdminWalletBatchItemStatus {
  return value === 'valid' || value === 'invalid' || value === 'submitting'
    || value === 'submitted' || value === 'submit_failed'
}

function toItemError(error: unknown) {
  if (error instanceof AppWalletError) return { code: error.code.slice(0, 80), summary: error.message.slice(0, 300) }
  return { code: 'BATCH_ROW_INVALID', summary: '该行无法通过调币预览校验' }
}

function riskError(code: string) {
  return new AppWalletError(409, code, `调币预览阻断：${code}`)
}

function invalidStoredBatch() {
  return new AppWalletError(503, 'WALLET_BATCH_DATA_INVALID', '批量调币数据异常', true)
}

function idempotencyConflict() {
  return new AppWalletError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键已用于其他批量任务')
}

function randomId(prefix: 'wab' | 'wabi' | 'wabr' | 'wabx' | 'log') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
