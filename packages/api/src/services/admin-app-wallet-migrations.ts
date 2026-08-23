import {
  createAdminAppWalletAdjustment,
  reviewAdminAppWalletAdjustment,
} from './admin-app-wallet'
import {
  AppWalletError,
  requireAppWalletPolicy,
  type AppWalletRuntimeConfig,
} from './app-wallet'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const JOB_ID = /^wlmj_[A-Za-z0-9_-]{1,91}$/u
const ITEM_ID = /^wlmi_[A-Za-z0-9_-]{1,91}$/u
const SOURCE_SYSTEM = /^[A-Za-z0-9._-]{2,48}$/u
const SOURCE_ACCOUNT_REFERENCE = /^opaque:[A-Za-z0-9._-]{4,120}$/u
const ACCOUNT_PUBLIC_ID = /^acc_[A-Za-z0-9_-]{1,76}$/u
const MAX_ITEMS = 200
const MAX_BALANCE = 1_000_000
const EXECUTION_LEASE_MS = 10 * 60 * 1000

export type AdminWalletLegacyJobStatus =
  | 'dry_run'
  | 'pending_review'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'partial_failed'
  | 'cancelled'

export type AdminWalletLegacyItemStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'conflict'
  | 'evidence_insufficient'
  | 'migrated'
  | 'failed'
  | 'stale'

export interface AdminWalletLegacyDryRunInput {
  sourceName?: unknown
  sourceSystem?: unknown
  extractedAt?: unknown
  mappingRule?: unknown
  rows?: unknown
}

export interface AdminWalletLegacySubmitInput {
  expectedVersion?: unknown
}

export interface AdminWalletLegacyReviewInput {
  decision?: unknown
  expectedVersion?: unknown
  reviewNote?: unknown
}

export interface AdminWalletLegacyExecuteInput {
  expectedVersion?: unknown
}

export interface AdminWalletLegacyJobView {
  jobId: string
  policyId: string
  status: AdminWalletLegacyJobStatus
  sourceName: string
  sourceSystem: string
  extractedAt: string
  mappingRule: string
  sourceSha256: string
  version: number
  counts: Record<AdminWalletLegacyItemStatus, number>
  total: number
  createdBy: { id: number; label: string }
  submittedAt: string | null
  executedBy: { id: number; label: string } | null
  executionStartedAt: string | null
  executionLeaseExpiresAt: string | null
  executedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminWalletLegacyItemView {
  itemId: string
  rowNumber: number
  sourceRecordId: string
  sourceAccountReference: string
  targetAccountId: string
  sourceBalance: number
  evidenceSha256: string
  status: AdminWalletLegacyItemStatus
  version: number
  conflict: { code: string; summary: string } | null
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  reviewedAt: string | null
  resultAdjustmentId: string | null
  resultEntryId: string | null
  failure: { code: string; summary: string } | null
  createdAt: string
  updatedAt: string
}

export interface AdminWalletLegacyWorkspace {
  job: AdminWalletLegacyJobView
  items: AdminWalletLegacyItemView[]
  permissions: {
    canSubmit: boolean
    canReview: boolean
    canExecute: boolean
    executionRecoverable: boolean
    selfReviewBlocked: boolean
    executionBlockedReason: string | null
  }
}

type Actor = { id: number; role: string | null }

type NormalizedRow = {
  rowNumber: number
  sourceRecordId: string
  sourceAccountReference: string
  targetAccountId: string
  sourceBalance: number
}

type JobRow = {
  id: string
  policy_id: string
  status: string
  source_name: string
  source_system: string
  extracted_at: string
  mapping_rule: string
  source_sha256: string
  request_hash: string
  version: number
  created_by: number
  creator_nickname: string | null
  creator_role: string
  submitted_at: string | null
  executed_by: number | null
  executor_nickname: string | null
  executor_role: string | null
  execution_started_at: string | null
  execution_lease_expires_at: string | null
  execution_token: string | null
  executed_at: string | null
  created_at: string
  updated_at: string
}

type ItemRow = {
  id: string
  job_id: string
  row_number: number
  source_record_id: string
  source_account_reference: string
  source_identity_sha256: string
  target_account_id: number | null
  account_public_id_snapshot: string
  source_balance: number
  evidence_sha256: string
  status: string
  version: number
  conflict_code: string | null
  conflict_summary: string | null
  reviewed_by: number | null
  reviewer_nickname: string | null
  reviewer_role: string | null
  review_note: string | null
  reviewed_at: string | null
  result_adjustment_id: string | null
  result_entry_id: string | null
  failure_code: string | null
  failure_summary: string | null
  created_at: string
  updated_at: string
}

type AccountEvidenceRow = {
  user_id: number
  account_public_id: string
  user_status: string
  account_status: string
  entry_count: number
  migrated_count: number
}

type MutationRequestRow = {
  job_id: string
  item_id: string | null
  operation: 'submit' | 'review' | 'execute'
  request_hash: string
  result_status: string
}

type PreparedItem = {
  id: string
  row: NormalizedRow
  sourceIdentitySha256: string
  targetAccountId: number | null
  evidenceSha256: string
  status: 'draft' | 'conflict' | 'evidence_insufficient'
  conflict: { code: string; summary: string } | null
}

const ITEM_STATUSES: AdminWalletLegacyItemStatus[] = [
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'conflict',
  'evidence_insufficient',
  'migrated',
  'failed',
  'stale',
]

export async function listAdminAppWalletLegacyJobs(
  db: D1Database,
  actor: Actor,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<AdminWalletLegacyJobView[]> {
  await requireAppWalletPolicy(db, config)
  const jobs = await listJobRows(db, config.policyId)
  const counts = jobs.length
    ? await loadItemCounts(db, jobs.map(job => job.id))
    : new Map<string, Record<AdminWalletLegacyItemStatus, number>>()
  await writeLegacyMigrationReadAudit(
    db,
    actor.id,
    'app.wallet.legacy_migration.list',
    'app_wallet_legacy_migration_queue',
    config.policyId,
    { purpose: 'legacy_balance_migration_operation', returnedJobs: jobs.length },
    now,
  )
  return jobs.map(job => toJobView(job, counts.get(job.id)))
}

export async function getAdminAppWalletLegacyWorkspace(
  db: D1Database,
  jobId: string,
  actor: Actor,
  config: AppWalletRuntimeConfig,
  now = new Date(),
  auditRead = false,
): Promise<AdminWalletLegacyWorkspace> {
  validateJobId(jobId)
  await requireAppWalletPolicy(db, config)
  const job = await requireJob(db, config.policyId, jobId)
  const items = await listItemRows(db, jobId)
  const counts = countItems(items)
  const control = await loadExecutionControl(db, config.policyId)
  const selfReviewBlocked = Number(job.created_by) === actor.id
  const executionRecoverable = job.status === 'executing'
    && !isFuture(job.execution_lease_expires_at, now)
  const executionBlockedReason = !control.productionReady
    ? '旧余额迁移正式执行尚未形成完整的 Owner、时间和决策引用；当前只允许 Dry-run 与独立复核。'
    : job.status === 'executing' && !executionRecoverable
      ? `迁移执行租约仍有效至 ${job.execution_lease_expires_at}，请等待本次执行完成。`
      : null
  const workspace: AdminWalletLegacyWorkspace = {
    job: toJobView(job, counts),
    items: items.map(toItemView),
    permissions: {
      canSubmit: job.status === 'dry_run' && Number(job.created_by) === actor.id && counts.draft > 0,
      canReview: job.status === 'pending_review' && actor.role === 'owner' && !selfReviewBlocked,
      canExecute: actor.role === 'owner'
        && control.productionReady
        && (job.status === 'ready' || executionRecoverable),
      executionRecoverable: executionRecoverable && control.productionReady && actor.role === 'owner',
      selfReviewBlocked,
      executionBlockedReason,
    },
  }
  if (auditRead) {
    await writeLegacyMigrationReadAudit(
      db,
      actor.id,
      'app.wallet.legacy_migration.view',
      'app_wallet_legacy_migration_job',
      jobId,
      {
        purpose: 'legacy_balance_migration_operation',
        itemCount: items.length,
        status: job.status,
      },
      now,
    )
  }
  return workspace
}

export async function createAdminAppWalletLegacyDryRun(
  db: D1Database,
  actor: Actor,
  idempotencyKey: string | null,
  input: AdminWalletLegacyDryRunInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ workspace: AdminWalletLegacyWorkspace; replayed: boolean }> {
  const policy = await requireAppWalletPolicy(db, config)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const sourceName = normalizeText(input.sourceName, 'sourceName', 1, 120)
  const sourceSystem = normalizeSourceSystem(input.sourceSystem)
  const extractedAt = normalizeExtractedAt(input.extractedAt, now)
  const mappingRule = normalizeText(input.mappingRule, 'mappingRule', 3, 160)
  const rows = normalizeRows(input.rows)
  const sourceSha256 = await sha256Hex(JSON.stringify(rows))
  const requestHash = await sha256Hex(JSON.stringify({
    policyId: config.policyId,
    sourceName,
    sourceSystem,
    extractedAt,
    mappingRule,
    sourceSha256,
  }))
  const replay = await findJobByCreateKey(db, actor.id, key)
  if (replay) {
    if (replay.request_hash !== requestHash || replay.policy_id !== config.policyId) {
      throw idempotencyConflict()
    }
    return {
      workspace: await getAdminAppWalletLegacyWorkspace(db, replay.id, actor, config, now),
      replayed: true,
    }
  }

  const accounts = await loadAccountEvidence(db, rows.map(row => row.targetAccountId))
  const duplicateTargets = duplicateValues(rows.map(row => row.targetAccountId))
  const preparedItems: PreparedItem[] = []
  for (const row of rows) {
    const sourceIdentitySha256 = await sha256Hex(`${sourceSystem}\n${row.sourceRecordId}`)
    const account = accounts.get(row.targetAccountId)
    const conflict = await resolveDryRunConflict(
      db,
      row,
      account,
      sourceIdentitySha256,
      duplicateTargets.has(row.targetAccountId),
      Number(policy.max_single_amount),
    )
    const evidenceSha256 = await itemEvidenceSha256({
      sourceSystem,
      extractedAt,
      mappingRule,
      row,
      sourceIdentitySha256,
      targetAccountId: account ? Number(account.user_id) : null,
    })
    preparedItems.push({
      id: randomId('wlmi'),
      row,
      sourceIdentitySha256,
      targetAccountId: account ? Number(account.user_id) : null,
      evidenceSha256,
      status: conflict ? 'conflict' : 'draft',
      conflict,
    })
  }

  const timestamp = now.toISOString()
  const jobId = randomId('wlmj')
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_wallet_legacy_migration_jobs (
        id, policy_id, status, source_name, source_system, extracted_at, mapping_rule,
        source_sha256, request_idempotency_key, request_hash, version, created_by,
        created_at, updated_at
      ) VALUES (?, ?, 'dry_run', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).bind(
      jobId,
      config.policyId,
      sourceName,
      sourceSystem,
      extractedAt,
      mappingRule,
      sourceSha256,
      key,
      requestHash,
      actor.id,
      timestamp,
      timestamp,
    ),
  ]
  for (const item of preparedItems) {
    statements.push(
      db.prepare(`
        INSERT INTO app_wallet_legacy_migration_items (
          id, job_id, row_number, source_record_id, source_account_reference,
          source_identity_sha256, target_account_id, account_public_id_snapshot,
          source_balance, evidence_sha256, status, version, conflict_code,
          conflict_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).bind(
        item.id,
        jobId,
        item.row.rowNumber,
        item.row.sourceRecordId,
        item.row.sourceAccountReference,
        item.sourceIdentitySha256,
        item.targetAccountId,
        item.row.targetAccountId,
        item.row.sourceBalance,
        item.evidenceSha256,
        item.status,
        item.conflict?.code ?? null,
        item.conflict?.summary ?? null,
        timestamp,
        timestamp,
      ),
      db.prepare(`
        INSERT INTO app_wallet_legacy_migration_item_events (
          id, item_id, sequence, event_type, status_from, status_to,
          actor_id, result_code, created_at
        ) VALUES (?, ?, 1, 'dry_run', NULL, ?, ?, ?, ?)
      `).bind(randomId('wlme'), item.id, item.status, actor.id, item.conflict?.code ?? item.status, timestamp),
    )
  }
  statements.push(db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app.wallet.legacy_migration.dry_run', 'app_wallet_legacy_migration_job', ?, NULL, ?, ?)
  `).bind(
    randomId('audit'),
    actor.id,
    jobId,
    JSON.stringify({
      policyId: config.policyId,
      sourceSystem,
      extractedAt,
      mappingRule,
      sourceSha256,
      total: preparedItems.length,
      reviewable: preparedItems.filter(item => item.status === 'draft').length,
      conflict: preparedItems.filter(item => item.status === 'conflict').length,
    }),
    timestamp,
  ))
  await db.batch(statements)
  return {
    workspace: await getAdminAppWalletLegacyWorkspace(db, jobId, actor, config, now),
    replayed: false,
  }
}

export async function submitAdminAppWalletLegacyJob(
  db: D1Database,
  jobId: string,
  actor: Actor,
  idempotencyKey: string | null,
  input: AdminWalletLegacySubmitInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ workspace: AdminWalletLegacyWorkspace; replayed: boolean }> {
  validateJobId(jobId)
  await requireAppWalletPolicy(db, config)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const requestHash = await sha256Hex(JSON.stringify({ jobId, expectedVersion }))
  const replay = await findMutationRequest(db, actor.id, key)
  if (replay) return resolveMutationReplay(db, jobId, actor, config, replay, requestHash, 'submit', now)
  const job = await requireJob(db, config.policyId, jobId)
  if (Number(job.created_by) !== actor.id) {
    throw new AppWalletError(403, 'WALLET_MIGRATION_CREATOR_REQUIRED', '只有 Dry-run 创建人可以提交复核')
  }
  if (job.status !== 'dry_run') throw jobStateConflict()
  if (Number(job.version) !== expectedVersion) throw versionConflict()
  const items = await listItemRows(db, jobId)
  const drafts = items.filter(item => item.status === 'draft')
  if (!drafts.length) {
    throw new AppWalletError(409, 'WALLET_MIGRATION_NO_REVIEWABLE_ITEMS', 'Dry-run 没有可提交复核的条目')
  }
  const timestamp = now.toISOString()
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      UPDATE app_wallet_legacy_migration_jobs
      SET status = 'pending_review', version = version + 1,
          submitted_at = ?, updated_at = ?
      WHERE id = ? AND policy_id = ? AND status = 'dry_run'
        AND version = ? AND created_by = ?
    `).bind(timestamp, timestamp, jobId, config.policyId, expectedVersion, actor.id),
    db.prepare(`
      UPDATE app_wallet_legacy_migration_items
      SET status = 'pending_review', version = version + 1, updated_at = ?
      WHERE job_id = ? AND status = 'draft'
        AND EXISTS (
          SELECT 1 FROM app_wallet_legacy_migration_jobs job
          WHERE job.id = app_wallet_legacy_migration_items.job_id
            AND job.status = 'pending_review' AND job.updated_at = ?
        )
    `).bind(timestamp, jobId, timestamp),
  ]
  for (const item of drafts) {
    statements.push(itemEventStatement(
      db,
      item.id,
      'submitted',
      'draft',
      'pending_review',
      actor.id,
      'pending_review',
      timestamp,
    ))
  }
  statements.push(
    db.prepare(`
      INSERT INTO app_wallet_legacy_migration_requests (
        id, job_id, item_id, operation, actor_id, idempotency_key,
        request_hash, result_status, created_at
      )
      SELECT ?, id, NULL, 'submit', ?, ?, ?, 'pending_review', ?
      FROM app_wallet_legacy_migration_jobs
      WHERE id = ? AND status = 'pending_review' AND updated_at = ?
    `).bind(randomId('wlmr'), actor.id, key, requestHash, timestamp, jobId, timestamp),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.legacy_migration.submit',
             'app_wallet_legacy_migration_job', id, ?, ?, ?
      FROM app_wallet_legacy_migration_jobs
      WHERE id = ? AND status = 'pending_review' AND updated_at = ?
    `).bind(
      randomId('audit'),
      actor.id,
      JSON.stringify({ status: 'dry_run', version: expectedVersion }),
      JSON.stringify({ status: 'pending_review', submittedItems: drafts.length }),
      timestamp,
      jobId,
      timestamp,
    ),
  )
  await db.batch(statements)
  const request = await findMutationRequest(db, actor.id, key)
  if (!request) throw versionConflict()
  return {
    workspace: await getAdminAppWalletLegacyWorkspace(db, jobId, actor, config, now),
    replayed: false,
  }
}

export async function reviewAdminAppWalletLegacyItem(
  db: D1Database,
  jobId: string,
  itemId: string,
  actor: Actor,
  idempotencyKey: string | null,
  input: AdminWalletLegacyReviewInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{ workspace: AdminWalletLegacyWorkspace; replayed: boolean }> {
  validateJobId(jobId)
  validateItemId(itemId)
  requireOwner(actor)
  await requireAppWalletPolicy(db, config)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const decision = normalizeDecision(input.decision)
  const reviewNote = normalizeText(input.reviewNote, 'reviewNote', 2, 500)
  const requestHash = await sha256Hex(JSON.stringify({ jobId, itemId, decision, expectedVersion, reviewNote }))
  const replay = await findMutationRequest(db, actor.id, key)
  if (replay) return resolveMutationReplay(db, jobId, actor, config, replay, requestHash, 'review', now, itemId)
  const job = await requireJob(db, config.policyId, jobId)
  if (job.status !== 'pending_review') throw jobStateConflict()
  if (Number(job.created_by) === actor.id) {
    throw new AppWalletError(403, 'WALLET_MIGRATION_SELF_REVIEW_FORBIDDEN', '迁移任务创建人不能复核自己的条目')
  }
  const item = await requireItem(db, jobId, itemId)
  if (item.status !== 'pending_review') throw itemStateConflict()
  if (Number(item.version) !== expectedVersion) throw versionConflict()
  const timestamp = now.toISOString()
  const nextStatus = decision === 'approve' ? 'approved' : 'rejected'
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_legacy_migration_items
      SET status = ?, version = version + 1, reviewed_by = ?, review_note = ?,
          reviewed_at = ?, updated_at = ?
      WHERE id = ? AND job_id = ? AND status = 'pending_review' AND version = ?
        AND EXISTS (
          SELECT 1 FROM app_wallet_legacy_migration_jobs job
          WHERE job.id = ? AND job.status = 'pending_review' AND job.created_by <> ?
        )
    `).bind(nextStatus, actor.id, reviewNote, timestamp, timestamp, itemId, jobId, expectedVersion, jobId, actor.id),
    itemEventStatement(
      db,
      itemId,
      nextStatus === 'approved' ? 'approved' : 'rejected',
      'pending_review',
      nextStatus,
      actor.id,
      nextStatus,
      timestamp,
    ),
    db.prepare(`
      INSERT INTO app_wallet_legacy_migration_requests (
        id, job_id, item_id, operation, actor_id, idempotency_key,
        request_hash, result_status, created_at
      )
      SELECT ?, ?, ?, 'review', ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM app_wallet_legacy_migration_items
        WHERE id = ? AND job_id = ? AND status = ?
          AND reviewed_by = ? AND reviewed_at = ?
      )
    `).bind(
      randomId('wlmr'),
      jobId,
      itemId,
      actor.id,
      key,
      requestHash,
      nextStatus,
      timestamp,
      itemId,
      jobId,
      nextStatus,
      actor.id,
      timestamp,
    ),
    db.prepare(`
      UPDATE app_wallet_legacy_migration_jobs
      SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM app_wallet_legacy_migration_items
              WHERE job_id = app_wallet_legacy_migration_jobs.id AND status = 'pending_review'
            ) THEN 'pending_review'
            WHEN EXISTS (
              SELECT 1 FROM app_wallet_legacy_migration_items
              WHERE job_id = app_wallet_legacy_migration_jobs.id AND status = 'approved'
            ) THEN 'ready'
            ELSE 'completed'
          END,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND status = 'pending_review'
        AND EXISTS (
          SELECT 1 FROM app_wallet_legacy_migration_requests request
          WHERE request.actor_id = ? AND request.idempotency_key = ?
            AND request.request_hash = ?
        )
    `).bind(timestamp, jobId, actor.id, key, requestHash),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.legacy_migration.review',
             'app_wallet_legacy_migration_item', id, ?, ?, ?
      FROM app_wallet_legacy_migration_items
      WHERE id = ? AND job_id = ? AND status = ?
        AND reviewed_by = ? AND reviewed_at = ?
    `).bind(
      randomId('audit'),
      actor.id,
      JSON.stringify({ status: 'pending_review', version: expectedVersion }),
      JSON.stringify({ status: nextStatus, decision, jobId }),
      timestamp,
      itemId,
      jobId,
      nextStatus,
      actor.id,
      timestamp,
    ),
  ])
  const request = await findMutationRequest(db, actor.id, key)
  if (!request) throw versionConflict()
  return {
    workspace: await getAdminAppWalletLegacyWorkspace(db, jobId, actor, config, now),
    replayed: false,
  }
}

export async function executeAdminAppWalletLegacyJob(
  db: D1Database,
  jobId: string,
  actor: Actor,
  idempotencyKey: string | null,
  input: AdminWalletLegacyExecuteInput,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<{
  workspace: AdminWalletLegacyWorkspace
  replayed: boolean
  refreshedAccountIds: string[]
}> {
  validateJobId(jobId)
  requireOwner(actor)
  await requireAppWalletPolicy(db, config)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  const requestHash = await sha256Hex(JSON.stringify({ jobId, expectedVersion }))
  const replay = await findMutationRequest(db, actor.id, key)
  if (replay) {
    const resolved = await resolveMutationReplay(db, jobId, actor, config, replay, requestHash, 'execute', now)
    return { ...resolved, refreshedAccountIds: [] }
  }
  await requireAppWalletPolicy(db, config, { writable: true })
  await requireExecutionEnabled(db, config.policyId)
  const job = await requireJob(db, config.policyId, jobId)
  const recoverable = job.status === 'executing' && !isFuture(job.execution_lease_expires_at, now)
  if (job.status !== 'ready' && !recoverable) throw jobStateConflict()
  if (Number(job.version) !== expectedVersion) throw versionConflict()
  const approved = (await listItemRows(db, jobId)).filter(item => item.status === 'approved')
  if (!approved.length) {
    throw new AppWalletError(409, 'WALLET_MIGRATION_NO_APPROVED_ITEMS', '迁移任务没有可执行的已批准条目')
  }
  const timestamp = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS).toISOString()
  const executionToken = randomId('wlmx')
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_legacy_migration_jobs
      SET status = 'executing', version = version + 1, executed_by = ?,
          execution_started_at = COALESCE(execution_started_at, ?),
          execution_lease_expires_at = ?, execution_token = ?, updated_at = ?
      WHERE id = ? AND policy_id = ? AND version = ?
        AND (
          status = 'ready'
          OR (status = 'executing' AND execution_lease_expires_at <= ?)
        )
        AND EXISTS (
          SELECT 1 FROM app_wallet_legacy_migration_controls control
          WHERE control.policy_id = app_wallet_legacy_migration_jobs.policy_id
            AND control.execution_enabled = 1
            AND control.decision_reference IS NOT NULL
            AND control.approved_by IS NOT NULL
            AND control.approved_at IS NOT NULL
        )
    `).bind(
      actor.id,
      timestamp,
      leaseExpiresAt,
      executionToken,
      timestamp,
      jobId,
      config.policyId,
      expectedVersion,
      timestamp,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.legacy_migration.execute_claim',
             'app_wallet_legacy_migration_job', id, ?, ?, ?
      FROM app_wallet_legacy_migration_jobs
      WHERE id = ? AND status = 'executing' AND execution_token = ?
    `).bind(
      randomId('audit'),
      actor.id,
      JSON.stringify({ status: job.status, version: expectedVersion }),
      JSON.stringify({ status: 'executing', leaseExpiresAt }),
      timestamp,
      jobId,
      executionToken,
    ),
  ])
  const claimed = await requireJob(db, config.policyId, jobId)
  if (claimed.status !== 'executing' || claimed.execution_token !== executionToken) {
    throw versionConflict()
  }

  for (const item of approved) {
    try {
      await executeApprovedItem(db, claimed, item, config, now)
    }
    catch (error) {
      if (error instanceof AppWalletError && error.retryable) throw error
      await markItemExecutionFailure(db, item, actor.id, error, now)
    }
  }

  const finalItems = await listItemRows(db, jobId)
  const counts = countItems(finalItems)
  const finalStatus: AdminWalletLegacyJobStatus = counts.failed > 0 || counts.stale > 0
    ? 'partial_failed'
    : 'completed'
  const refreshedAccountIds = finalItems
    .filter(item => item.status === 'migrated')
    .map(item => item.account_public_id_snapshot)
  const completedAt = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_legacy_migration_jobs
      SET status = ?, version = version + 1, execution_lease_expires_at = NULL,
          execution_token = NULL, executed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'executing' AND execution_token = ?
    `).bind(finalStatus, completedAt, completedAt, jobId, executionToken),
    db.prepare(`
      INSERT INTO app_wallet_legacy_migration_requests (
        id, job_id, item_id, operation, actor_id, idempotency_key,
        request_hash, result_status, created_at
      )
      SELECT ?, id, NULL, 'execute', ?, ?, ?, ?, ?
      FROM app_wallet_legacy_migration_jobs
      WHERE id = ? AND status = ? AND executed_at = ?
    `).bind(randomId('wlmr'), actor.id, key, requestHash, finalStatus, completedAt, jobId, finalStatus, completedAt),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.legacy_migration.execute',
             'app_wallet_legacy_migration_job', id, ?, ?, ?
      FROM app_wallet_legacy_migration_jobs
      WHERE id = ? AND status = ? AND executed_at = ?
    `).bind(
      randomId('audit'),
      actor.id,
      JSON.stringify({ status: 'executing' }),
      JSON.stringify({ status: finalStatus, counts }),
      completedAt,
      jobId,
      finalStatus,
      completedAt,
    ),
  ])
  const request = await findMutationRequest(db, actor.id, key)
  if (!request) {
    throw new AppWalletError(503, 'WALLET_MIGRATION_RESULT_UNAVAILABLE', '迁移结果暂不可用，请刷新任务', true)
  }
  return {
    workspace: await getAdminAppWalletLegacyWorkspace(db, jobId, actor, config, new Date(completedAt)),
    replayed: false,
    refreshedAccountIds: [...new Set(refreshedAccountIds)],
  }
}

async function executeApprovedItem(
  db: D1Database,
  job: JobRow,
  item: ItemRow,
  config: AppWalletRuntimeConfig,
  now: Date,
): Promise<string | null> {
  if (item.status !== 'approved' || item.target_account_id === null || item.reviewed_by === null) {
    return null
  }
  const existing = await loadLinkedAdjustment(db, item.id)
  if (existing?.entry_id) {
    await markItemMigrated(db, item, existing.adjustment_id, existing.entry_id, Number(job.executed_by), now)
    return item.account_public_id_snapshot
  }
  if (existing && existing.status !== 'pending_review') {
    throw staleError('LINKED_ADJUSTMENT_NOT_PENDING', '旧余额迁移关联的调币申请已结束且未形成分录')
  }
  const current = await loadExecutionAccountEvidence(db, item.target_account_id)
  if (!current
    || current.account_public_id !== item.account_public_id_snapshot
    || current.user_status !== 'active'
    || current.account_status !== 'active') {
    await rejectLinkedMigrationAdjustment(db, item, config, now)
    throw staleError('TARGET_ACCOUNT_CHANGED', '目标 App 账号不存在、已受限或稳定账号标识已变化')
  }
  if (Number(current.entry_count) > 0) {
    await rejectLinkedMigrationAdjustment(db, item, config, now)
    throw staleError('TARGET_LEDGER_NOT_EMPTY', '目标账号已产生正式金币分录，旧余额不能再作为初始余额迁移')
  }
  const sourceDuplicate = await db.prepare(`
    SELECT 1 AS found
    FROM app_wallet_legacy_migration_items migrated
    WHERE migrated.id <> ?
      AND migrated.status = 'migrated'
      AND (migrated.source_identity_sha256 = ? OR migrated.target_account_id = ?)
    LIMIT 1
  `).bind(item.id, item.source_identity_sha256, item.target_account_id).first<{ found: number }>()
  if (sourceDuplicate) {
    await rejectLinkedMigrationAdjustment(db, item, config, now)
    throw staleError('MIGRATION_ALREADY_APPLIED', '该来源记录或目标账号已由其他任务完成旧余额迁移')
  }
  const expectedEvidenceSha256 = await itemEvidenceSha256({
    sourceSystem: job.source_system,
    extractedAt: job.extracted_at,
    mappingRule: job.mapping_rule,
    row: {
      rowNumber: Number(item.row_number),
      sourceRecordId: item.source_record_id,
      sourceAccountReference: item.source_account_reference,
      targetAccountId: item.account_public_id_snapshot,
      sourceBalance: Number(item.source_balance),
    },
    sourceIdentitySha256: item.source_identity_sha256,
    targetAccountId: Number(item.target_account_id),
  })
  if (expectedEvidenceSha256 !== item.evidence_sha256) {
    await rejectLinkedMigrationAdjustment(db, item, config, now)
    throw staleError('MIGRATION_EVIDENCE_CHANGED', '冻结的来源、映射或目标证据已不一致')
  }

  let adjustmentId = existing?.adjustment_id ?? null
  if (!adjustmentId) {
    const created = await createAdminAppWalletAdjustment(
      db,
      Number(job.created_by),
      `wallet.migration.adjustment:${item.id}`,
      {
        accountId: item.account_public_id_snapshot,
        actionType: 'admin_credit',
        amount: Number(item.source_balance),
        reasonCode: 'correction',
        userVisibleNote: '旧版金币余额迁移',
        internalNote: `受控旧余额迁移 ${job.id}/${item.id}`,
        businessReference: `legacy:${item.id}`,
      },
      config,
      now,
      { legacyMigrationItemId: item.id },
    )
    adjustmentId = created.adjustment.adjustmentId
  }
  let adjustment: Awaited<ReturnType<typeof reviewAdminAppWalletAdjustment>>
  try {
    adjustment = await reviewAdminAppWalletAdjustment(
      db,
      adjustmentId,
      Number(item.reviewed_by),
      'approve',
      `wallet.migration.review:${item.id}`,
      {
        expectedVersion: 1,
        reviewNote: item.review_note ?? '旧余额迁移独立复核通过',
      },
      config,
      now,
      { legacyMigrationItemId: item.id },
    )
  }
  catch (error) {
    if (error instanceof AppWalletError && error.retryable) throw error
    await rejectLinkedMigrationAdjustment(db, item, config, now)
    if (error instanceof AppWalletError && error.code === 'WALLET_BALANCE_CHANGED') {
      throw staleError('TARGET_LEDGER_CHANGED', '目标钱包在正式落账前已变化，关联申请已拒绝且旧余额未写入')
    }
    throw error
  }
  if (adjustment.adjustment.status !== 'applied' || !adjustment.adjustment.entryId) {
    throw new AppWalletError(503, 'WALLET_MIGRATION_ENTRY_UNAVAILABLE', '迁移分录尚未形成，请稍后重试', true)
  }
  await markItemMigrated(
    db,
    item,
    adjustmentId,
    adjustment.adjustment.entryId,
    Number(job.executed_by),
    now,
  )
  return item.account_public_id_snapshot
}

async function markItemMigrated(
  db: D1Database,
  item: ItemRow,
  adjustmentId: string,
  entryId: string,
  actorId: number,
  now: Date,
) {
  const timestamp = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_legacy_migration_items
      SET status = 'migrated', version = version + 1,
          result_adjustment_id = ?, result_entry_id = ?, updated_at = ?
      WHERE id = ? AND status = 'approved' AND version = ?
        AND EXISTS (
          SELECT 1
          FROM app_wallet_legacy_migration_links link
          JOIN app_wallet_entries entry ON entry.adjustment_id = link.adjustment_id
          WHERE link.item_id = app_wallet_legacy_migration_items.id
            AND link.adjustment_id = ? AND entry.id = ?
            AND entry.account_id = app_wallet_legacy_migration_items.target_account_id
            AND entry.amount = app_wallet_legacy_migration_items.source_balance
        )
    `).bind(adjustmentId, entryId, timestamp, item.id, item.version, adjustmentId, entryId),
    itemEventStatement(db, item.id, 'migrated', 'approved', 'migrated', actorId, 'migrated', timestamp),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.legacy_migration.item_migrate',
             'app_wallet_legacy_migration_item', id, ?, ?, ?
      FROM app_wallet_legacy_migration_items
      WHERE id = ? AND status = 'migrated' AND result_entry_id = ?
    `).bind(
      randomId('audit'),
      actorId,
      JSON.stringify({ status: 'approved', version: item.version }),
      JSON.stringify({ status: 'migrated', adjustmentId, entryId }),
      timestamp,
      item.id,
      entryId,
    ),
  ])
  const result = await requireItem(db, item.job_id, item.id)
  if (result.status !== 'migrated' || result.result_entry_id !== entryId) throw versionConflict()
}

async function markItemExecutionFailure(
  db: D1Database,
  item: ItemRow,
  actorId: number,
  error: unknown,
  now: Date,
) {
  const stale = error instanceof AppWalletError && error.code.startsWith('WALLET_MIGRATION_STALE_')
  const nextStatus: 'stale' | 'failed' = stale ? 'stale' : 'failed'
  const failureCode = error instanceof AppWalletError
    ? error.code.replace(/^WALLET_MIGRATION_STALE_/u, '')
    : 'EXECUTION_FAILED'
  const failureSummary = safeFailureSummary(error, stale)
  const timestamp = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_wallet_legacy_migration_items
      SET status = ?, version = version + 1, failure_code = ?,
          failure_summary = ?, updated_at = ?
      WHERE id = ? AND status = 'approved' AND version = ?
    `).bind(nextStatus, failureCode, failureSummary, timestamp, item.id, item.version),
    itemEventStatement(db, item.id, nextStatus, 'approved', nextStatus, actorId, failureCode, timestamp),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.wallet.legacy_migration.item_failure',
             'app_wallet_legacy_migration_item', id, ?, ?, ?
      FROM app_wallet_legacy_migration_items
      WHERE id = ? AND status = ? AND failure_code = ?
    `).bind(
      randomId('audit'),
      actorId,
      JSON.stringify({ status: 'approved', version: item.version }),
      JSON.stringify({ status: nextStatus, failureCode }),
      timestamp,
      item.id,
      nextStatus,
      failureCode,
    ),
  ])
}

async function resolveDryRunConflict(
  db: D1Database,
  row: NormalizedRow,
  account: AccountEvidenceRow | undefined,
  sourceIdentitySha256: string,
  duplicateTarget: boolean,
  maxSingleAmount: number,
): Promise<{ code: string; summary: string } | null> {
  if (!account) return { code: 'TARGET_ACCOUNT_NOT_FOUND', summary: '显式映射的目标 App 账号不存在' }
  if (account.user_status !== 'active' || account.account_status !== 'active') {
    return { code: 'TARGET_ACCOUNT_UNAVAILABLE', summary: '目标 App 账号已受限、待注销或不可用' }
  }
  if (duplicateTarget) {
    return { code: 'TARGET_MAPPING_DUPLICATE', summary: '同一源快照把多条旧余额记录映射到了同一 App 账号' }
  }
  if (row.sourceBalance > maxSingleAmount) {
    return { code: 'POLICY_AMOUNT_LIMIT', summary: '来源余额超过当前钱包策略单笔上限，不能进入执行复核' }
  }
  if (Number(account.entry_count) > 0) {
    return { code: 'TARGET_LEDGER_NOT_EMPTY', summary: '目标账号已有正式金币分录，不能再写入初始旧余额' }
  }
  if (Number(account.migrated_count) > 0) {
    return { code: 'TARGET_ALREADY_MIGRATED', summary: '目标账号已完成旧余额迁移' }
  }
  const sourceMigrated = await db.prepare(`
    SELECT 1 AS found FROM app_wallet_legacy_migration_items
    WHERE source_identity_sha256 = ? AND status = 'migrated'
    LIMIT 1
  `).bind(sourceIdentitySha256).first<{ found: number }>()
  if (sourceMigrated) {
    return { code: 'SOURCE_ALREADY_MIGRATED', summary: `来源记录 ${row.sourceRecordId} 已完成迁移` }
  }
  return null
}

async function loadAccountEvidence(db: D1Database, accountIds: string[]) {
  const uniqueIds = [...new Set(accountIds)]
  if (!uniqueIds.length) return new Map<string, AccountEvidenceRow>()
  const placeholders = uniqueIds.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT users.id AS user_id, security.account_public_id,
           users.status AS user_status, security.status AS account_status,
           (SELECT COUNT(*) FROM app_wallet_entries entry WHERE entry.account_id = users.id) AS entry_count,
           (SELECT COUNT(*) FROM app_wallet_legacy_migration_items migrated
             WHERE migrated.target_account_id = users.id AND migrated.status = 'migrated') AS migrated_count
    FROM app_account_security security
    JOIN users ON users.id = security.account_id
    WHERE security.account_public_id IN (${placeholders})
  `).bind(...uniqueIds).all<AccountEvidenceRow>()
  return new Map(result.results.map(row => [row.account_public_id, row]))
}

async function loadExecutionAccountEvidence(db: D1Database, accountId: number) {
  return db.prepare(`
    SELECT users.id AS user_id, security.account_public_id,
           users.status AS user_status, security.status AS account_status,
           (SELECT COUNT(*) FROM app_wallet_entries entry WHERE entry.account_id = users.id) AS entry_count,
           (SELECT COUNT(*) FROM app_wallet_legacy_migration_items migrated
             WHERE migrated.target_account_id = users.id AND migrated.status = 'migrated') AS migrated_count
    FROM users
    JOIN app_account_security security ON security.account_id = users.id
    WHERE users.id = ?
    LIMIT 1
  `).bind(accountId).first<AccountEvidenceRow>()
}

async function rejectLinkedMigrationAdjustment(
  db: D1Database,
  item: ItemRow,
  config: AppWalletRuntimeConfig,
  now: Date,
) {
  const linked = await loadLinkedAdjustment(db, item.id)
  if (!linked) return
  if (linked.entry_id) {
    throw new AppWalletError(
      503,
      'WALLET_MIGRATION_ENTRY_RECOVERY_REQUIRED',
      '迁移分录已经形成，需先恢复迁移条目结果',
      true,
    )
  }
  if (linked.status === 'rejected') return
  if (linked.status !== 'pending_review' || item.reviewed_by === null) {
    throw new AppWalletError(
      503,
      'WALLET_MIGRATION_LINK_STATE_INVALID',
      '迁移关联申请状态暂不可用于安全拒绝',
      true,
    )
  }
  try {
    const rejected = await reviewAdminAppWalletAdjustment(
      db,
      linked.adjustment_id,
      Number(item.reviewed_by),
      'reject',
      `wallet.migration.reject:${item.id}`,
      {
        expectedVersion: Number(linked.version),
        reviewNote: '迁移执行前目标事实已变化，拒绝冻结申请',
      },
      config,
      now,
      { legacyMigrationItemId: item.id },
    )
    if (rejected.adjustment.status !== 'rejected') {
      throw new AppWalletError(
        503,
        'WALLET_MIGRATION_REJECTION_UNAVAILABLE',
        '迁移关联申请尚未安全拒绝',
        true,
      )
    }
  }
  catch (error) {
    const latest = await loadLinkedAdjustment(db, item.id)
    if (latest?.status === 'rejected' && !latest.entry_id) return
    if (latest?.entry_id) {
      throw new AppWalletError(
        503,
        'WALLET_MIGRATION_ENTRY_RECOVERY_REQUIRED',
        '迁移分录已经形成，需先恢复迁移条目结果',
        true,
      )
    }
    throw error
  }
}

async function loadLinkedAdjustment(db: D1Database, itemId: string) {
  return db.prepare(`
    SELECT link.adjustment_id, adjustment.status, adjustment.version,
           entry.id AS entry_id
    FROM app_wallet_legacy_migration_links link
    JOIN app_wallet_adjustments adjustment ON adjustment.id = link.adjustment_id
    LEFT JOIN app_wallet_entries entry ON entry.adjustment_id = link.adjustment_id
    WHERE link.item_id = ?
    LIMIT 1
  `).bind(itemId).first<{
    adjustment_id: string
    status: string
    version: number
    entry_id: string | null
  }>()
}

async function writeLegacyMigrationReadAudit(
  db: D1Database,
  actorId: number,
  action: 'app.wallet.legacy_migration.list' | 'app.wallet.legacy_migration.view',
  targetType: 'app_wallet_legacy_migration_queue' | 'app_wallet_legacy_migration_job',
  targetId: string,
  detail: Record<string, unknown>,
  now: Date,
) {
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).bind(
    randomId('audit'),
    actorId,
    action,
    targetType,
    targetId,
    JSON.stringify(detail),
    now.toISOString(),
  ).run()
}

async function listJobRows(db: D1Database, policyId: string): Promise<JobRow[]> {
  const result = await db.prepare(`${jobSelect()} WHERE job.policy_id = ? ORDER BY job.created_at DESC, job.id DESC LIMIT 100`)
    .bind(policyId)
    .all<JobRow>()
  return result.results
}

async function requireJob(db: D1Database, policyId: string, jobId: string): Promise<JobRow> {
  const row = await db.prepare(`${jobSelect()} WHERE job.policy_id = ? AND job.id = ? LIMIT 1`)
    .bind(policyId, jobId)
    .first<JobRow>()
  if (!row) throw new AppWalletError(404, 'WALLET_MIGRATION_JOB_NOT_FOUND', '旧余额迁移任务不存在')
  if (!isJobStatus(row.status)) throw invalidStoredEvidence()
  return row
}

function jobSelect() {
  return `
    SELECT job.id, job.policy_id, job.status, job.source_name, job.source_system,
           job.extracted_at, job.mapping_rule, job.source_sha256, job.request_hash,
           job.version, job.created_by, creator.nickname AS creator_nickname,
           creator.role AS creator_role, job.submitted_at, job.executed_by,
           executor.nickname AS executor_nickname, executor.role AS executor_role,
           job.execution_started_at, job.execution_lease_expires_at,
           job.execution_token, job.executed_at, job.created_at, job.updated_at
    FROM app_wallet_legacy_migration_jobs job
    JOIN users creator ON creator.id = job.created_by
    LEFT JOIN users executor ON executor.id = job.executed_by
  `
}

async function listItemRows(db: D1Database, jobId: string): Promise<ItemRow[]> {
  const result = await db.prepare(`
    SELECT item.id, item.job_id, item.row_number, item.source_record_id,
           item.source_account_reference, item.source_identity_sha256,
           item.target_account_id, item.account_public_id_snapshot,
           item.source_balance, item.evidence_sha256, item.status, item.version,
           item.conflict_code, item.conflict_summary, item.reviewed_by,
           reviewer.nickname AS reviewer_nickname, reviewer.role AS reviewer_role,
           item.review_note, item.reviewed_at, item.result_adjustment_id,
           item.result_entry_id, item.failure_code, item.failure_summary,
           item.created_at, item.updated_at
    FROM app_wallet_legacy_migration_items item
    LEFT JOIN users reviewer ON reviewer.id = item.reviewed_by
    WHERE item.job_id = ?
    ORDER BY item.row_number ASC, item.id ASC
  `).bind(jobId).all<ItemRow>()
  return result.results
}

async function requireItem(db: D1Database, jobId: string, itemId: string): Promise<ItemRow> {
  const rows = await listItemRows(db, jobId)
  const row = rows.find(candidate => candidate.id === itemId)
  if (!row) throw new AppWalletError(404, 'WALLET_MIGRATION_ITEM_NOT_FOUND', '旧余额迁移条目不存在')
  if (!isItemStatus(row.status)) throw invalidStoredEvidence()
  return row
}

async function loadItemCounts(db: D1Database, jobIds: string[]) {
  const map = new Map<string, Record<AdminWalletLegacyItemStatus, number>>()
  if (!jobIds.length) return map
  const placeholders = jobIds.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT job_id, status, COUNT(*) AS count
    FROM app_wallet_legacy_migration_items
    WHERE job_id IN (${placeholders})
    GROUP BY job_id, status
  `).bind(...jobIds).all<{ job_id: string; status: string; count: number }>()
  for (const row of result.results) {
    if (!isItemStatus(row.status)) throw invalidStoredEvidence()
    const counts = map.get(row.job_id) ?? emptyCounts()
    counts[row.status] = Number(row.count)
    map.set(row.job_id, counts)
  }
  return map
}

async function findJobByCreateKey(db: D1Database, actorId: number, key: string) {
  return db.prepare(`
    SELECT id, policy_id, request_hash
    FROM app_wallet_legacy_migration_jobs
    WHERE created_by = ? AND request_idempotency_key = ?
    LIMIT 1
  `).bind(actorId, key).first<{ id: string; policy_id: string; request_hash: string }>()
}

async function findMutationRequest(db: D1Database, actorId: number, key: string) {
  return db.prepare(`
    SELECT job_id, item_id, operation, request_hash, result_status
    FROM app_wallet_legacy_migration_requests
    WHERE actor_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorId, key).first<MutationRequestRow>()
}

async function resolveMutationReplay(
  db: D1Database,
  jobId: string,
  actor: Actor,
  config: AppWalletRuntimeConfig,
  request: MutationRequestRow,
  requestHash: string,
  operation: MutationRequestRow['operation'],
  now: Date,
  itemId: string | null = null,
) {
  if (request.job_id !== jobId
    || request.item_id !== itemId
    || request.operation !== operation
    || request.request_hash !== requestHash) {
    throw idempotencyConflict()
  }
  return {
    workspace: await getAdminAppWalletLegacyWorkspace(db, jobId, actor, config, now),
    replayed: true,
  }
}

async function loadExecutionControl(db: D1Database, policyId: string) {
  const row = await db.prepare(`
    SELECT execution_enabled, decision_reference, approved_by, approved_at
    FROM app_wallet_legacy_migration_controls
    WHERE policy_id = ?
    LIMIT 1
  `).bind(policyId).first<{
    execution_enabled: number
    decision_reference: string | null
    approved_by: number | null
    approved_at: string | null
  }>()
  return {
    productionReady: row?.execution_enabled === 1
      && Boolean(row.decision_reference)
      && row.approved_by !== null
      && Boolean(row.approved_at),
  }
}

async function requireExecutionEnabled(db: D1Database, policyId: string) {
  if (!(await loadExecutionControl(db, policyId)).productionReady) {
    throw new AppWalletError(403, 'WALLET_MIGRATION_EXECUTION_DISABLED', '旧余额迁移正式执行当前保持关闭')
  }
}

function toJobView(
  row: JobRow,
  countsInput?: Record<AdminWalletLegacyItemStatus, number>,
): AdminWalletLegacyJobView {
  if (!isJobStatus(row.status)) throw invalidStoredEvidence()
  const counts = countsInput ?? emptyCounts()
  return {
    jobId: row.id,
    policyId: row.policy_id,
    status: row.status,
    sourceName: row.source_name,
    sourceSystem: row.source_system,
    extractedAt: row.extracted_at,
    mappingRule: row.mapping_rule,
    sourceSha256: row.source_sha256,
    version: Number(row.version),
    counts,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    createdBy: { id: Number(row.created_by), label: adminLabel(row.creator_nickname, row.creator_role, Number(row.created_by)) },
    submittedAt: row.submitted_at,
    executedBy: row.executed_by === null
      ? null
      : { id: Number(row.executed_by), label: adminLabel(row.executor_nickname, row.executor_role ?? 'admin', Number(row.executed_by)) },
    executionStartedAt: row.execution_started_at,
    executionLeaseExpiresAt: row.execution_lease_expires_at,
    executedAt: row.executed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toItemView(row: ItemRow): AdminWalletLegacyItemView {
  if (!isItemStatus(row.status)) throw invalidStoredEvidence()
  return {
    itemId: row.id,
    rowNumber: Number(row.row_number),
    sourceRecordId: row.source_record_id,
    sourceAccountReference: row.source_account_reference,
    targetAccountId: row.account_public_id_snapshot,
    sourceBalance: Number(row.source_balance),
    evidenceSha256: row.evidence_sha256,
    status: row.status,
    version: Number(row.version),
    conflict: row.conflict_code && row.conflict_summary
      ? { code: row.conflict_code, summary: row.conflict_summary }
      : null,
    reviewedBy: row.reviewed_by === null
      ? null
      : { id: Number(row.reviewed_by), label: adminLabel(row.reviewer_nickname, row.reviewer_role ?? 'admin', Number(row.reviewed_by)) },
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    resultAdjustmentId: row.result_adjustment_id,
    resultEntryId: row.result_entry_id,
    failure: row.failure_code && row.failure_summary
      ? { code: row.failure_code, summary: row.failure_summary }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function countItems(rows: ItemRow[]) {
  const counts = emptyCounts()
  for (const row of rows) {
    if (!isItemStatus(row.status)) throw invalidStoredEvidence()
    counts[row.status] += 1
  }
  return counts
}

function emptyCounts(): Record<AdminWalletLegacyItemStatus, number> {
  return {
    draft: 0,
    pending_review: 0,
    approved: 0,
    rejected: 0,
    conflict: 0,
    evidence_insufficient: 0,
    migrated: 0,
    failed: 0,
    stale: 0,
  }
}

function normalizeRows(value: unknown): NormalizedRow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) {
    throw new AppWalletError(400, 'INVALID_MIGRATION_ROWS', `rows 必须包含 1–${MAX_ITEMS} 条显式来源记录`)
  }
  const rows = value.map((candidate, index): NormalizedRow => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new AppWalletError(400, 'INVALID_MIGRATION_ROW', `第 ${index + 1} 行不是有效对象`)
    }
    const row = candidate as Record<string, unknown>
    const sourceRecordId = normalizeText(row.sourceRecordId, `rows[${index}].sourceRecordId`, 1, 128)
    const sourceAccountReference = normalizeSourceAccountReference(row.sourceAccountReference, index)
    const targetAccountId = normalizeAccountPublicId(row.targetAccountId, index)
    const sourceBalance = normalizeBalance(row.sourceBalance, index)
    return { rowNumber: index + 1, sourceRecordId, sourceAccountReference, targetAccountId, sourceBalance }
  })
  const sourceIds = rows.map(row => row.sourceRecordId)
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new AppWalletError(400, 'DUPLICATE_SOURCE_RECORD', '同一源快照内 sourceRecordId 必须唯一')
  }
  return rows
}

function normalizeSourceSystem(value: unknown) {
  if (typeof value !== 'string' || !SOURCE_SYSTEM.test(value.trim())) {
    throw new AppWalletError(400, 'INVALID_SOURCE_SYSTEM', 'sourceSystem 必须是 2–48 位稳定来源代码')
  }
  return value.trim()
}

function normalizeSourceAccountReference(value: unknown, index: number) {
  if (typeof value !== 'string' || !SOURCE_ACCOUNT_REFERENCE.test(value.trim())) {
    throw new AppWalletError(
      400,
      'INVALID_SOURCE_ACCOUNT_REFERENCE',
      `第 ${index + 1} 行 sourceAccountReference 必须是 opaque: 前缀的不透明标识`,
    )
  }
  return value.trim()
}

function normalizeExtractedAt(value: unknown, now: Date) {
  if (typeof value !== 'string') {
    throw new AppWalletError(400, 'INVALID_EXTRACTED_AT', 'extractedAt 必须是合法服务端时间格式')
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new AppWalletError(400, 'INVALID_EXTRACTED_AT', 'extractedAt 无效或晚于当前时间')
  }
  return parsed.toISOString()
}

function normalizeAccountPublicId(value: unknown, index: number) {
  if (typeof value !== 'string' || !ACCOUNT_PUBLIC_ID.test(value.trim())) {
    throw new AppWalletError(400, 'INVALID_TARGET_ACCOUNT', `第 ${index + 1} 行 targetAccountId 无效`)
  }
  return value.trim()
}

function normalizeBalance(value: unknown, index: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_BALANCE) {
    throw new AppWalletError(400, 'INVALID_SOURCE_BALANCE', `第 ${index + 1} 行 sourceBalance 必须是 1–${MAX_BALANCE} 的整数`)
  }
  return Number(value)
}

function normalizeDecision(value: unknown): 'approve' | 'reject' {
  if (value === 'approve' || value === 'reject') return value
  throw new AppWalletError(400, 'INVALID_REVIEW_DECISION', 'decision 必须为 approve 或 reject')
}

function normalizeText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 长度必须为 ${min}–${max} 个字符`)
  }
  return value.trim()
}

function normalizePositiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppWalletError(400, 'INVALID_REQUEST', `${field} 必须是正整数`)
  }
  return Number(value)
}

function normalizeIdempotencyKey(value: string | null) {
  if (!value || !IDEMPOTENCY_KEY.test(value)) {
    throw new AppWalletError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 必须是 16–128 位稳定标识')
  }
  return value
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return duplicates
}

async function itemEvidenceSha256(input: {
  sourceSystem: string
  extractedAt: string
  mappingRule: string
  row: NormalizedRow
  sourceIdentitySha256: string
  targetAccountId: number | null
}) {
  return sha256Hex(JSON.stringify({
    sourceSystem: input.sourceSystem,
    extractedAt: input.extractedAt,
    mappingRule: input.mappingRule,
    rowNumber: input.row.rowNumber,
    sourceRecordId: input.row.sourceRecordId,
    sourceAccountReference: input.row.sourceAccountReference,
    sourceIdentitySha256: input.sourceIdentitySha256,
    targetAccountId: input.targetAccountId,
    accountPublicId: input.row.targetAccountId,
    sourceBalance: input.row.sourceBalance,
  }))
}

function itemEventStatement(
  db: D1Database,
  itemId: string,
  eventType: 'submitted' | 'approved' | 'rejected' | 'migrated' | 'failed' | 'stale',
  statusFrom: string,
  statusTo: string,
  actorId: number,
  resultCode: string,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO app_wallet_legacy_migration_item_events (
      id, item_id, sequence, event_type, status_from, status_to,
      actor_id, result_code, created_at
    )
    SELECT ?, item.id,
           COALESCE((SELECT MAX(sequence) FROM app_wallet_legacy_migration_item_events WHERE item_id = item.id), 0) + 1,
           ?, ?, ?, ?, ?, ?
    FROM app_wallet_legacy_migration_items item
    WHERE item.id = ? AND item.status = ? AND item.updated_at = ?
  `).bind(
    randomId('wlme'),
    eventType,
    statusFrom,
    statusTo,
    actorId,
    resultCode,
    timestamp,
    itemId,
    statusTo,
    timestamp,
  )
}

function requireOwner(actor: Actor) {
  if (actor.role !== 'owner') {
    throw new AppWalletError(403, 'OWNER_REQUIRED', '旧余额迁移复核和执行仅限 Owner')
  }
}

function validateJobId(value: string) {
  if (!JOB_ID.test(value)) throw new AppWalletError(404, 'WALLET_MIGRATION_JOB_NOT_FOUND', '旧余额迁移任务不存在')
}

function validateItemId(value: string) {
  if (!ITEM_ID.test(value)) throw new AppWalletError(404, 'WALLET_MIGRATION_ITEM_NOT_FOUND', '旧余额迁移条目不存在')
}

function isJobStatus(value: string): value is AdminWalletLegacyJobStatus {
  return ['dry_run', 'pending_review', 'ready', 'executing', 'completed', 'partial_failed', 'cancelled'].includes(value)
}

function isItemStatus(value: string): value is AdminWalletLegacyItemStatus {
  return ITEM_STATUSES.some(status => status === value)
}

function isFuture(value: string | null, now: Date) {
  return Boolean(value && new Date(value).getTime() > now.getTime())
}

function adminLabel(nickname: string | null, role: string, id: number) {
  return nickname?.trim() || `${role || 'admin'} #${id}`
}

function staleError(code: string, message: string) {
  return new AppWalletError(409, `WALLET_MIGRATION_STALE_${code}`, message)
}

function safeFailureSummary(error: unknown, stale: boolean) {
  if (error instanceof AppWalletError) {
    if (stale) return error.message.slice(0, 300)
    if (error.code === 'WALLET_BALANCE_CHANGED') return '目标钱包在执行前已变化，旧余额未写入'
    if (error.code === 'BUSINESS_REFERENCE_CONFLICT') return '迁移业务引用已存在，旧余额未重复写入'
    return '迁移分录未能形成，未修改目标余额'
  }
  return '迁移执行发生未分类错误，未确认目标余额变化'
}

function idempotencyConflict() {
  return new AppWalletError(409, 'IDEMPOTENCY_CONFLICT', '相同 Idempotency-Key 已用于不同迁移请求')
}

function versionConflict() {
  return new AppWalletError(409, 'VERSION_CONFLICT', '迁移任务或条目版本已变化，请刷新后重试')
}

function jobStateConflict() {
  return new AppWalletError(409, 'WALLET_MIGRATION_JOB_STATE_CONFLICT', '迁移任务状态已变化，请刷新后重试')
}

function itemStateConflict() {
  return new AppWalletError(409, 'WALLET_MIGRATION_ITEM_STATE_CONFLICT', '迁移条目状态已变化，请刷新后重试')
}

function invalidStoredEvidence() {
  return new AppWalletError(503, 'WALLET_MIGRATION_DATA_INVALID', '旧余额迁移证据暂不可用', true)
}

function randomId(prefix: 'wlmj' | 'wlmi' | 'wlme' | 'wlmr' | 'wlmx' | 'audit') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
