import { AppMembershipError, getAppMembershipCatalog } from './app-membership'
import { requireAppOperationalControlAvailable } from './app-operational-safety'

const LEGACY_LEVEL_CODE = /^[A-Za-z0-9._-]{1,48}$/u
const TARGET_TIER_ID = /^amt_[A-Za-z0-9_-]{1,76}$/u
const JOB_ID = /^amlj_[A-Za-z0-9_-]{1,91}$/u
const ITEM_ID = /^amli_[A-Za-z0-9_-]{1,91}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u

export type AdminMembershipLegacyJobStatus =
  | 'dry_run'
  | 'pending_review'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'partial_failed'
  | 'cancelled'

export type AdminMembershipLegacyItemStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'conflict'
  | 'evidence_insufficient'
  | 'migrated'
  | 'failed'
  | 'stale'

export interface AdminMembershipLegacyDryRunInput {
  mappings?: unknown
  limit?: unknown
}

export interface AdminMembershipLegacySubmitInput {
  expectedVersion?: unknown
}

export interface AdminMembershipLegacyReviewInput {
  decision?: unknown
  expectedVersion?: unknown
  reviewNote?: unknown
}

export interface AdminMembershipLegacyExecuteInput {
  expectedVersion?: unknown
}

export interface AdminMembershipLegacyMapping {
  legacyLevelCode: string
  targetTierId: string
  targetTierName: string
  targetRank: number
}

export interface AdminMembershipLegacyJobSummary {
  jobId: string
  catalogVersionId: string
  status: AdminMembershipLegacyJobStatus
  version: number
  mappings: AdminMembershipLegacyMapping[]
  mappingSha256: string
  counts: Record<AdminMembershipLegacyItemStatus, number>
  total: number
  createdBy: { id: number; label: string }
  createdAt: string
  submittedAt: string | null
  executedBy: { id: number; label: string } | null
  executionStartedAt: string | null
  executionLeaseExpiresAt: string | null
  executedAt: string | null
}

export interface AdminMembershipLegacyItemView {
  itemId: string
  legacyMembershipId: string
  userId: number
  accountId: string | null
  emailMasked: string
  legacyLevel: { id: string; code: string; name: string; rank: number }
  legacyStartsAt: string | null
  legacyExpiresAt: string | null
  targetTier: { tierId: string; code: string; name: string; rank: number }
  evidenceSha256: string
  status: AdminMembershipLegacyItemStatus
  version: number
  conflict: { code: string; summary: string } | null
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  reviewedAt: string | null
  resultGrantId: string | null
  failure: { code: string; summary: string } | null
  createdAt: string
  updatedAt: string
}

export interface AdminMembershipLegacyWorkspace {
  job: AdminMembershipLegacyJobSummary
  items: AdminMembershipLegacyItemView[]
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

type JobRow = {
  id: string
  catalog_version_id: string
  status: string
  mapping_json: string
  mapping_sha256: string
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
  execution_idempotency_key: string | null
  execution_request_hash: string | null
  executed_at: string | null
  created_at: string
}

type ItemRow = {
  id: string
  job_id: string
  catalog_version_id: string
  legacy_membership_id: string
  user_id: number
  account_public_id_snapshot: string | null
  email_masked_snapshot: string
  legacy_level_id: string
  legacy_level_code: string
  legacy_level_name: string
  legacy_rank: number
  legacy_granted_by: number
  legacy_starts_at_raw: string
  legacy_expires_at_raw: string
  legacy_starts_at: string | null
  legacy_expires_at: string | null
  target_tier_id: string
  target_tier_code_snapshot: string
  target_tier_name_snapshot: string
  target_rank_snapshot: number
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
  result_grant_id: string | null
  failure_code: string | null
  failure_summary: string | null
  created_at: string
  updated_at: string
}

type LegacyEvidenceRow = {
  legacy_membership_id: string
  user_id: number
  user_status: string
  email: string
  account_public_id: string | null
  account_status: string | null
  legacy_level_id: string
  legacy_level_code: string
  legacy_level_name: string
  legacy_rank: number
  legacy_granted_by: number
  legacy_starts_at: string | null
  legacy_expires_at: string | null
  already_migrated: number
  overlapping_grant: number
}

type TierRow = {
  tier_id: string
  code: string
  display_name: string
  rank: number
}

type RequestRow = {
  job_id: string
  operation: 'submit' | 'review' | 'execute'
  request_hash: string
  result_status: string
}

const ITEM_STATUSES: AdminMembershipLegacyItemStatus[] = [
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

export async function listAdminAppMembershipLegacyJobs(
  db: D1Database,
  catalogVersionId: string,
): Promise<AdminMembershipLegacyJobSummary[]> {
  await getAppMembershipCatalog(db, catalogVersionId)
  const jobs = await listJobRows(db, catalogVersionId)
  if (!jobs.length) return []
  const counts = await loadItemCounts(db, jobs.map(job => job.id))
  return jobs.map(job => toJobSummary(job, counts.get(job.id)))
}

export async function getAdminAppMembershipLegacyWorkspace(
  db: D1Database,
  catalogVersionId: string,
  jobId: string,
  actor: Actor,
): Promise<AdminMembershipLegacyWorkspace> {
  validateJobId(jobId)
  const job = await requireJob(db, catalogVersionId, jobId)
  const items = await listItemRows(db, jobId)
  const counts = countItemRows(items)
  const selfReviewBlocked = actor.id === Number(job.created_by)
  const executionControl = await loadExecutionControl(db, catalogVersionId)
  const executionLeaseActive = job.status === 'executing' && isFuture(job.execution_lease_expires_at, new Date())
  const executionRecoverable = job.status === 'executing' && !executionLeaseActive
  const executionBlockedReason = !executionControl.productionReady
    ? '旧会员正式映射决策尚未形成完整的 Owner、时间和决策引用；当前只允许 Dry-run 与独立复核。'
    : executionLeaseActive
      ? `迁移执行租约仍有效至 ${job.execution_lease_expires_at}，请等待本次执行完成。`
      : null
  return {
    job: toJobSummary(job, counts),
    items: items.map(toItemView),
    permissions: {
      canSubmit: job.status === 'dry_run' && actor.id === Number(job.created_by) && counts.draft > 0,
      canReview: job.status === 'pending_review' && actor.role === 'owner' && !selfReviewBlocked,
      canExecute: actor.role === 'owner'
        && executionControl.productionReady
        && ((job.status === 'ready' && counts.approved > 0) || executionRecoverable),
      executionRecoverable: executionRecoverable && executionControl.productionReady && actor.role === 'owner',
      selfReviewBlocked,
      executionBlockedReason,
    },
  }
}

export async function createAdminAppMembershipLegacyDryRun(
  db: D1Database,
  catalogVersionId: string,
  actor: Actor,
  idempotencyKey: string | null,
  body: AdminMembershipLegacyDryRunInput,
  now = new Date(),
): Promise<{ workspace: AdminMembershipLegacyWorkspace; replayed: boolean }> {
  const key = normalizeIdempotencyKey(idempotencyKey)
  const catalog = await getAppMembershipCatalog(db, catalogVersionId)
  const limit = normalizeLimit(body.limit)
  const rawMappings = normalizeMappings(body.mappings)
  const targetIds = [...new Set(rawMappings.map(mapping => mapping.targetTierId))]
  const targetTiers = await loadTargetTiers(db, catalogVersionId, targetIds)
  const mappings = rawMappings.map((mapping): AdminMembershipLegacyMapping => {
    const tier = targetTiers.get(mapping.targetTierId)
    if (!tier) {
      throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_TARGET_INVALID', `目标等级 ${mapping.targetTierId} 不属于当前目录`)
    }
    return {
      legacyLevelCode: mapping.legacyLevelCode,
      targetTierId: tier.tier_id,
      targetTierName: tier.display_name,
      targetRank: Number(tier.rank),
    }
  }).sort((left, right) => left.legacyLevelCode.localeCompare(right.legacyLevelCode))
  const mappingSha256 = await sha256Hex(JSON.stringify(mappings))
  const requestHash = await sha256Hex(JSON.stringify({ catalogVersionId, mappings, limit }))
  const replay = await findJobByCreateKey(db, actor.id, key)
  if (replay) {
    if (replay.request_hash !== requestHash) throw idempotencyConflict()
    return {
      workspace: await getAdminAppMembershipLegacyWorkspace(db, catalogVersionId, replay.id, actor),
      replayed: true,
    }
  }

  const evidenceRows = await loadLegacyEvidence(db, mappings.map(mapping => mapping.legacyLevelCode), now, limit)
  if (!evidenceRows.length) {
    throw new AppMembershipError(409, 'MEMBERSHIP_MIGRATION_SOURCE_EMPTY', '当前映射范围内没有仍有效的旧会员证据')
  }
  const mappingByCode = new Map(mappings.map(mapping => [mapping.legacyLevelCode, mapping]))
  const timestamp = now.toISOString()
  const jobId = randomId('amlj')
  const preparedItems = await Promise.all(evidenceRows.map(async (row) => {
    const mapping = mappingByCode.get(row.legacy_level_code)
    if (!mapping) throw invalidStoredEvidence()
    const tier = targetTiers.get(mapping.targetTierId)
    if (!tier) throw invalidStoredEvidence()
    const normalizedPeriod = normalizeLegacyPeriod(row.legacy_starts_at, row.legacy_expires_at, now)
    const evidenceSha256 = await sha256Hex(JSON.stringify({
      legacyMembershipId: row.legacy_membership_id,
      userId: Number(row.user_id),
      levelId: row.legacy_level_id,
      levelCode: row.legacy_level_code,
      levelRank: Number(row.legacy_rank),
      grantedBy: Number(row.legacy_granted_by),
      startsAtRaw: row.legacy_starts_at ?? '',
      expiresAtRaw: row.legacy_expires_at ?? '',
      startsAt: normalizedPeriod.startsAt,
      expiresAt: normalizedPeriod.expiresAt,
    }))
    const evidenceInsufficient = normalizedPeriod.conflict
    const conflict = evidenceInsufficient ?? resolveDryRunConflict(row)
    return {
      id: randomId('amli'),
      row,
      tier,
      startsAt: normalizedPeriod.startsAt,
      expiresAt: normalizedPeriod.expiresAt,
      evidenceSha256,
      status: evidenceInsufficient
        ? 'evidence_insufficient' as const
        : conflict
          ? 'conflict' as const
          : 'draft' as const,
      conflict,
    }
  }))

  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_membership_legacy_migration_jobs (
        id, catalog_version_id, status, mapping_json, mapping_sha256, request_idempotency_key,
        request_hash, version, created_by, created_at, updated_at
      ) VALUES (?, ?, 'dry_run', ?, ?, ?, ?, 1, ?, ?, ?)
    `).bind(jobId, catalogVersionId, JSON.stringify(mappings), mappingSha256, key, requestHash, actor.id, timestamp, timestamp),
  ]
  for (const item of preparedItems) {
    statements.push(
      db.prepare(`
        INSERT INTO app_membership_legacy_migration_items (
          id, job_id, catalog_version_id, legacy_membership_id, user_id,
          account_public_id_snapshot, email_masked_snapshot, legacy_level_id,
          legacy_level_code, legacy_level_name, legacy_rank, legacy_granted_by,
          legacy_starts_at_raw, legacy_expires_at_raw, legacy_starts_at,
          legacy_expires_at, target_tier_id, target_tier_code_snapshot,
          target_tier_name_snapshot, target_rank_snapshot, evidence_sha256,
          status, version, conflict_code, conflict_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).bind(
        item.id,
        jobId,
        catalogVersionId,
        item.row.legacy_membership_id,
        Number(item.row.user_id),
        item.row.account_public_id,
        maskEmail(item.row.email),
        item.row.legacy_level_id,
        item.row.legacy_level_code,
        item.row.legacy_level_name,
        Number(item.row.legacy_rank),
        Number(item.row.legacy_granted_by),
        item.row.legacy_starts_at ?? '',
        item.row.legacy_expires_at ?? '',
        item.startsAt,
        item.expiresAt,
        item.tier.tier_id,
        item.tier.code,
        item.tier.display_name,
        Number(item.tier.rank),
        item.evidenceSha256,
        item.status,
        item.conflict?.code ?? null,
        item.conflict?.summary ?? null,
        timestamp,
        timestamp,
      ),
      db.prepare(`
        INSERT INTO app_membership_legacy_migration_item_events (
          id, item_id, sequence, event_type, actor_id, result_code, detail_json, created_at
        ) VALUES (?, ?, 1, 'dry_run_created', ?, ?, ?, ?)
      `).bind(
        randomId('amle'),
        item.id,
        actor.id,
        item.status,
        JSON.stringify({ evidenceSha256: item.evidenceSha256, conflictCode: item.conflict?.code ?? null }),
        timestamp,
      ),
    )
  }
  statements.push(db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app.membership.legacy_migration.dry_run', 'app_membership_legacy_migration_job', ?, NULL, ?, ?)
  `).bind(
    randomId('audit'),
    actor.id,
    jobId,
    JSON.stringify({
      catalogVersionId,
      catalogVersionCode: catalog.versionCode,
      mappings,
      total: preparedItems.length,
      draft: preparedItems.filter(item => item.status === 'draft').length,
      conflict: preparedItems.filter(item => item.status === 'conflict').length,
      evidenceInsufficient: preparedItems.filter(item => item.status === 'evidence_insufficient').length,
    }),
    timestamp,
  ))
  await db.batch(statements)
  return {
    workspace: await getAdminAppMembershipLegacyWorkspace(db, catalogVersionId, jobId, actor),
    replayed: false,
  }
}

export async function submitAdminAppMembershipLegacyJob(
  db: D1Database,
  catalogVersionId: string,
  jobId: string,
  actor: Actor,
  idempotencyKey: string | null,
  body: AdminMembershipLegacySubmitInput,
  now = new Date(),
): Promise<{ workspace: AdminMembershipLegacyWorkspace; replayed: boolean }> {
  validateJobId(jobId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(body.expectedVersion, 'expectedVersion')
  const requestHash = await sha256Hex(JSON.stringify({ jobId, expectedVersion }))
  const replay = await findMutationRequest(db, actor.id, key)
  if (replay) return resolveMutationReplay(db, catalogVersionId, jobId, actor, replay, requestHash, 'submit')
  const job = await requireJob(db, catalogVersionId, jobId)
  if (Number(job.created_by) !== actor.id) {
    throw new AppMembershipError(403, 'MEMBERSHIP_MIGRATION_CREATOR_REQUIRED', '只有 Dry-run 创建人可以提交复核')
  }
  if (job.status !== 'dry_run') throw jobStateConflict()
  if (Number(job.version) !== expectedVersion) throw versionConflict()
  const items = await listItemRows(db, jobId)
  const drafts = items.filter(item => item.status === 'draft')
  if (!drafts.length) {
    throw new AppMembershipError(409, 'MEMBERSHIP_MIGRATION_NO_REVIEWABLE_ITEMS', 'Dry-run 没有可提交复核的条目')
  }
  const timestamp = now.toISOString()
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      UPDATE app_membership_legacy_migration_jobs
      SET status = 'pending_review', version = version + 1, submitted_at = ?, updated_at = ?
      WHERE id = ? AND catalog_version_id = ? AND status = 'dry_run' AND version = ? AND created_by = ?
    `).bind(timestamp, timestamp, jobId, catalogVersionId, expectedVersion, actor.id),
    db.prepare(`
      UPDATE app_membership_legacy_migration_items
      SET status = 'pending_review', version = version + 1, updated_at = ?
      WHERE job_id = ? AND status = 'draft'
        AND EXISTS (
          SELECT 1 FROM app_membership_legacy_migration_jobs job
          WHERE job.id = app_membership_legacy_migration_items.job_id
            AND job.status = 'pending_review' AND job.updated_at = ?
        )
    `).bind(timestamp, jobId, timestamp),
  ]
  for (const item of drafts) {
    statements.push(db.prepare(`
      INSERT INTO app_membership_legacy_migration_item_events (
        id, item_id, sequence, event_type, actor_id, result_code, detail_json, created_at
      )
      SELECT ?, item.id,
             COALESCE((SELECT MAX(sequence) FROM app_membership_legacy_migration_item_events WHERE item_id = item.id), 0) + 1,
             'submitted', ?, 'pending_review', ?, ?
      FROM app_membership_legacy_migration_items item
      WHERE item.id = ? AND item.status = 'pending_review' AND item.updated_at = ?
    `).bind(randomId('amle'), actor.id, JSON.stringify({ jobVersion: expectedVersion + 1 }), timestamp, item.id, timestamp))
  }
  statements.push(
    db.prepare(`
      INSERT INTO app_membership_legacy_migration_requests (
        id, job_id, operation, actor_id, idempotency_key, request_hash, result_status, created_at
      )
      SELECT ?, id, 'submit', ?, ?, ?, 'pending_review', ?
      FROM app_membership_legacy_migration_jobs
      WHERE id = ? AND status = 'pending_review' AND updated_at = ?
    `).bind(randomId('amlr'), actor.id, key, requestHash, timestamp, jobId, timestamp),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.legacy_migration.submit', 'app_membership_legacy_migration_job', id, ?, ?, ?
      FROM app_membership_legacy_migration_jobs
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
    workspace: await getAdminAppMembershipLegacyWorkspace(db, catalogVersionId, jobId, actor),
    replayed: false,
  }
}

export async function reviewAdminAppMembershipLegacyItem(
  db: D1Database,
  catalogVersionId: string,
  jobId: string,
  itemId: string,
  actor: Actor,
  idempotencyKey: string | null,
  body: AdminMembershipLegacyReviewInput,
  now = new Date(),
): Promise<{ workspace: AdminMembershipLegacyWorkspace; replayed: boolean }> {
  validateJobId(jobId)
  validateItemId(itemId)
  requireOwnerActor(actor)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(body.expectedVersion, 'expectedVersion')
  const decision = normalizeDecision(body.decision)
  const reviewNote = normalizeText(body.reviewNote, 'reviewNote', 2, 500)
  const requestHash = await sha256Hex(JSON.stringify({ jobId, itemId, decision, expectedVersion, reviewNote }))
  const replay = await findMutationRequest(db, actor.id, key)
  if (replay) return resolveMutationReplay(db, catalogVersionId, jobId, actor, replay, requestHash, 'review')
  const job = await requireJob(db, catalogVersionId, jobId)
  if (job.status !== 'pending_review') throw jobStateConflict()
  if (Number(job.created_by) === actor.id) {
    throw new AppMembershipError(403, 'MEMBERSHIP_MIGRATION_SELF_REVIEW_FORBIDDEN', '迁移任务创建人不能复核自己的条目')
  }
  const item = await requireItem(db, jobId, itemId)
  if (item.status !== 'pending_review') throw itemStateConflict()
  if (Number(item.version) !== expectedVersion) throw versionConflict()
  const timestamp = now.toISOString()
  const nextStatus = decision === 'approve' ? 'approved' : 'rejected'
  await db.batch([
    db.prepare(`
      UPDATE app_membership_legacy_migration_items
      SET status = ?, version = version + 1, reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND job_id = ? AND status = 'pending_review' AND version = ?
        AND EXISTS (
          SELECT 1 FROM app_membership_legacy_migration_jobs job
          WHERE job.id = ? AND job.status = 'pending_review' AND job.created_by <> ?
        )
    `).bind(nextStatus, actor.id, reviewNote, timestamp, timestamp, itemId, jobId, expectedVersion, jobId, actor.id),
    db.prepare(`
      INSERT INTO app_membership_legacy_migration_item_events (
        id, item_id, sequence, event_type, actor_id, result_code, detail_json, created_at
      )
      SELECT ?, item.id,
             COALESCE((SELECT MAX(sequence) FROM app_membership_legacy_migration_item_events WHERE item_id = item.id), 0) + 1,
             ?, ?, ?, ?, ?
      FROM app_membership_legacy_migration_items item
      WHERE item.id = ? AND item.job_id = ? AND item.status = ? AND item.reviewed_by = ? AND item.reviewed_at = ?
    `).bind(
      randomId('amle'),
      decision === 'approve' ? 'approved' : 'rejected',
      actor.id,
      nextStatus,
      JSON.stringify({ reviewNote }),
      timestamp,
      itemId,
      jobId,
      nextStatus,
      actor.id,
      timestamp,
    ),
    db.prepare(`
      INSERT INTO app_membership_legacy_migration_requests (
        id, job_id, operation, actor_id, idempotency_key, request_hash, result_status, created_at
      )
      SELECT ?, ?, 'review', ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM app_membership_legacy_migration_items
        WHERE id = ? AND job_id = ? AND status = ? AND reviewed_by = ? AND reviewed_at = ?
      )
    `).bind(randomId('amlr'), jobId, actor.id, key, requestHash, nextStatus, timestamp, itemId, jobId, nextStatus, actor.id, timestamp),
    db.prepare(`
      UPDATE app_membership_legacy_migration_jobs
      SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM app_membership_legacy_migration_items
              WHERE job_id = app_membership_legacy_migration_jobs.id AND status = 'pending_review'
            ) THEN 'pending_review'
            WHEN EXISTS (
              SELECT 1 FROM app_membership_legacy_migration_items
              WHERE job_id = app_membership_legacy_migration_jobs.id AND status = 'approved'
            ) THEN 'ready'
            ELSE 'completed'
          END,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND status = 'pending_review'
        AND EXISTS (
          SELECT 1 FROM app_membership_legacy_migration_requests request
          WHERE request.actor_id = ? AND request.idempotency_key = ? AND request.request_hash = ?
        )
    `).bind(timestamp, jobId, actor.id, key, requestHash),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.legacy_migration.review', 'app_membership_legacy_migration_item', id, ?, ?, ?
      FROM app_membership_legacy_migration_items
      WHERE id = ? AND job_id = ? AND status = ? AND reviewed_by = ? AND reviewed_at = ?
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
    workspace: await getAdminAppMembershipLegacyWorkspace(db, catalogVersionId, jobId, actor),
    replayed: false,
  }
}

export async function executeAdminAppMembershipLegacyJob(
  db: D1Database,
  catalogVersionId: string,
  jobId: string,
  actor: Actor,
  idempotencyKey: string | null,
  body: AdminMembershipLegacyExecuteInput,
  now = new Date(),
): Promise<{ workspace: AdminMembershipLegacyWorkspace; replayed: boolean }> {
  validateJobId(jobId)
  requireOwnerActor(actor)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizePositiveInteger(body.expectedVersion, 'expectedVersion')
  const requestHash = await sha256Hex(JSON.stringify({ jobId, expectedVersion }))
  const replay = await findMutationRequest(db, actor.id, key)
  if (replay) return resolveMutationReplay(db, catalogVersionId, jobId, actor, replay, requestHash, 'execute')
  const job = await requireJob(db, catalogVersionId, jobId)
  if (job.status === 'executing') {
    if (isFuture(job.execution_lease_expires_at, now)) {
      throw new AppMembershipError(409, 'MEMBERSHIP_MIGRATION_EXECUTION_IN_PROGRESS', '迁移执行仍在进行，请稍后刷新', true)
    }
  }
  else if (job.status !== 'ready') throw jobStateConflict()
  if (Number(job.version) !== expectedVersion) throw versionConflict()
  const executionControl = await loadExecutionControl(db, catalogVersionId)
  if (!executionControl.productionReady) {
    throw new AppMembershipError(
      403,
      'MEMBERSHIP_MIGRATION_EXECUTION_DISABLED',
      '旧会员正式映射决策 OQ-016 尚未关闭；当前只允许 Dry-run 与独立复核。',
    )
  }
  await requireAppOperationalControlAvailable(
    db,
    'membership_grants',
    (code, message) => new AppMembershipError(503, code, message, true),
  )
  const approvedItems = (await listItemRows(db, jobId)).filter(item => item.status === 'approved')
  if (!approvedItems.length && job.status === 'ready') {
    throw new AppMembershipError(409, 'MEMBERSHIP_MIGRATION_NO_APPROVED_ITEMS', '没有已通过独立复核的迁移条目')
  }
  const executionStartedAt = job.status === 'executing' && job.execution_started_at
    ? job.execution_started_at
    : now.toISOString()
  const timestamp = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString()
  const executionToken = randomId('amlx')
  const claimResults = await db.batch([
    db.prepare(`
      UPDATE app_membership_legacy_migration_jobs
      SET status = 'executing', version = version + 1, executed_by = ?, execution_started_at = ?,
          execution_lease_expires_at = ?, execution_token = ?, execution_idempotency_key = ?,
          execution_request_hash = ?, updated_at = ?
      WHERE id = ? AND catalog_version_id = ? AND version = ?
        AND (
          status = 'ready'
          OR (status = 'executing' AND datetime(execution_lease_expires_at) <= datetime(?))
        )
    `).bind(
      actor.id,
      executionStartedAt,
      leaseExpiresAt,
      executionToken,
      key,
      requestHash,
      timestamp,
      jobId,
      catalogVersionId,
      expectedVersion,
      timestamp,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.legacy_migration.execute_claim',
             'app_membership_legacy_migration_job', id, ?, ?, ?
      FROM app_membership_legacy_migration_jobs
      WHERE id = ? AND status = 'executing' AND execution_token = ? AND executed_by = ?
    `).bind(
      randomId('audit'),
      actor.id,
      JSON.stringify({ status: job.status, version: expectedVersion }),
      JSON.stringify({ status: 'executing', leaseExpiresAt, recovered: job.status === 'executing' }),
      timestamp,
      jobId,
      executionToken,
      actor.id,
    ),
  ])
  if (!claimResults[0]?.meta.changes) throw versionConflict()

  for (const item of approvedItems) {
    await executeLegacyItem(db, job, item, actor.id, executionToken, now)
  }
  const finalCounts = countItemRows(await listItemRows(db, jobId))
  const finalStatus: AdminMembershipLegacyJobStatus = finalCounts.failed > 0
    || finalCounts.stale > 0
    || finalCounts.conflict > 0
    || finalCounts.evidence_insufficient > 0
    ? 'partial_failed'
    : 'completed'
  await db.batch([
    db.prepare(`
      UPDATE app_membership_legacy_migration_jobs
      SET status = ?, version = version + 1, execution_lease_expires_at = NULL,
          execution_token = NULL, executed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'executing' AND execution_token = ? AND executed_by = ?
    `).bind(finalStatus, timestamp, timestamp, jobId, executionToken, actor.id),
    db.prepare(`
      INSERT INTO app_membership_legacy_migration_requests (
        id, job_id, operation, actor_id, idempotency_key, request_hash, result_status, created_at
      )
      SELECT ?, id, 'execute', ?, ?, ?, ?, ?
      FROM app_membership_legacy_migration_jobs
      WHERE id = ? AND status = ? AND executed_by = ? AND executed_at = ?
        AND execution_idempotency_key = ? AND execution_request_hash = ?
    `).bind(randomId('amlr'), actor.id, key, requestHash, finalStatus, timestamp, jobId, finalStatus, actor.id, timestamp, key, requestHash),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.legacy_migration.execute', 'app_membership_legacy_migration_job', id, ?, ?, ?
      FROM app_membership_legacy_migration_jobs
      WHERE id = ? AND status = ? AND executed_by = ? AND executed_at = ?
        AND execution_idempotency_key = ? AND execution_request_hash = ?
    `).bind(
      randomId('audit'),
      actor.id,
      JSON.stringify({ status: 'ready', version: expectedVersion }),
      JSON.stringify({ status: finalStatus, counts: finalCounts }),
      timestamp,
      jobId,
      finalStatus,
      actor.id,
      timestamp,
      key,
      requestHash,
    ),
  ])
  const request = await findMutationRequest(db, actor.id, key)
  if (!request) throw versionConflict()
  return {
    workspace: await getAdminAppMembershipLegacyWorkspace(db, catalogVersionId, jobId, actor),
    replayed: false,
  }
}

async function executeLegacyItem(
  db: D1Database,
  job: JobRow,
  item: ItemRow,
  actorId: number,
  executionToken: string,
  now: Date,
) {
  const current = await loadCurrentEvidence(db, item.legacy_membership_id)
  const staleReason = resolveExecutionStaleReason(item, current, now)
  if (staleReason) {
    await markLegacyItem(db, item, actorId, 'stale', staleReason.code, staleReason.summary, now)
    return
  }
  const duplicate = await db.prepare(`
    SELECT migrated.id
    FROM app_membership_legacy_migration_items migrated
    WHERE migrated.legacy_membership_id = ? AND migrated.status = 'migrated' AND migrated.id <> ?
    LIMIT 1
  `).bind(item.legacy_membership_id, item.id).first<{ id: string }>()
  if (duplicate) {
    await markLegacyItem(db, item, actorId, 'stale', 'LEGACY_EVIDENCE_ALREADY_MIGRATED', '该旧会员证据已由其他任务完成迁移', now)
    return
  }
  const overlap = await db.prepare(`
    SELECT grant_row.id
    FROM app_membership_grants grant_row
    WHERE grant_row.user_id = ?
      AND grant_row.catalog_version_id = ?
      AND julianday(grant_row.starts_at) < julianday(?)
      AND julianday(grant_row.expires_at) > julianday(?)
      AND NOT EXISTS (
        SELECT 1 FROM app_membership_grant_revocations revoked WHERE revoked.grant_id = grant_row.id
      )
    LIMIT 1
  `).bind(item.user_id, job.catalog_version_id, item.legacy_expires_at, item.legacy_starts_at).first<{ id: string }>()
  if (overlap) {
    await markLegacyItem(db, item, actorId, 'stale', 'APP_GRANT_OVERLAP', '执行前发现重叠的 App 会员 grant，需要重新核对', now)
    return
  }

  const timestamp = now.toISOString()
  const grantId = `amg_legacy_${item.evidence_sha256.slice(0, 48)}`
  const businessReference = `legacy-migration:${item.evidence_sha256.slice(0, 48)}`
  const eventId = randomId('amle')
  const auditId = randomId('audit')
  try {
    await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO app_membership_grants (
          id, user_id, catalog_version_id, tier_id, tier_code_snapshot, tier_name_snapshot,
          rank_snapshot, starts_at, expires_at, source_type, reason_code, user_visible_note,
          internal_note, business_reference, granted_by, created_at
        )
        SELECT ?, item.user_id, item.catalog_version_id, item.target_tier_id,
               item.target_tier_code_snapshot, item.target_tier_name_snapshot,
               item.target_rank_snapshot, item.legacy_starts_at, item.legacy_expires_at,
               'manual_admin', 'manual_review',
               '旧版会员权益已迁移，原到期时间保持不变。', ?, ?, ?, ?
        FROM app_membership_legacy_migration_items item
        JOIN app_membership_legacy_migration_jobs job ON job.id = item.job_id
        JOIN users account ON account.id = item.user_id
        JOIN user_memberships legacy ON legacy.id = item.legacy_membership_id
        JOIN membership_levels level ON level.id = legacy.level_id
        JOIN app_membership_tiers tier
          ON tier.catalog_version_id = item.catalog_version_id AND tier.tier_id = item.target_tier_id
        WHERE item.id = ? AND item.job_id = ? AND item.status = 'approved'
          AND job.status = 'executing' AND job.execution_token = ? AND account.status = 'active'
          AND level.id = item.legacy_level_id
          AND level.code = item.legacy_level_code
          AND level.rank = item.legacy_rank
          AND legacy.granted_by = item.legacy_granted_by
          AND legacy.starts_at = item.legacy_starts_at_raw
          AND legacy.expires_at = item.legacy_expires_at_raw
          AND julianday(legacy.starts_at) = julianday(item.legacy_starts_at)
          AND julianday(legacy.expires_at) = julianday(item.legacy_expires_at)
          AND tier.code = item.target_tier_code_snapshot
          AND tier.display_name = item.target_tier_name_snapshot
          AND tier.rank = item.target_rank_snapshot
          AND NOT EXISTS (
            SELECT 1 FROM app_membership_legacy_migration_items migrated
            WHERE migrated.legacy_membership_id = item.legacy_membership_id
              AND migrated.status = 'migrated' AND migrated.id <> item.id
          )
          AND EXISTS (
            SELECT 1 FROM app_operational_safety_controls control
            WHERE control.control_key = 'membership_grants' AND control.state = 'available'
          )
      `).bind(
        grantId,
        `legacyMembershipId=${item.legacy_membership_id}; evidenceSha256=${item.evidence_sha256}`,
        businessReference,
        actorId,
        timestamp,
        item.id,
        item.job_id,
        executionToken,
      ),
      db.prepare(`
        UPDATE app_membership_legacy_migration_items
        SET status = 'migrated', version = version + 1, result_grant_id = ?,
            failure_code = NULL, failure_summary = NULL, updated_at = ?
        WHERE id = ? AND job_id = ? AND status = 'approved'
          AND EXISTS (
            SELECT 1 FROM app_membership_grants grant_row
            WHERE grant_row.id = ? AND grant_row.user_id = app_membership_legacy_migration_items.user_id
              AND grant_row.business_reference = ?
          )
      `).bind(grantId, timestamp, item.id, item.job_id, grantId, businessReference),
      db.prepare(`
        INSERT INTO app_membership_legacy_migration_item_events (
          id, item_id, sequence, event_type, actor_id, result_code, detail_json, created_at
        )
        SELECT ?, item.id,
               COALESCE((SELECT MAX(sequence) FROM app_membership_legacy_migration_item_events WHERE item_id = item.id), 0) + 1,
               'migrated', ?, 'migrated', ?, ?
        FROM app_membership_legacy_migration_items item
        WHERE item.id = ? AND item.status = 'migrated' AND item.result_grant_id = ?
      `).bind(eventId, actorId, JSON.stringify({ grantId, businessReference }), timestamp, item.id, grantId),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app.membership.legacy_migration.item_migrate', 'app_membership_legacy_migration_item', id, ?, ?, ?
        FROM app_membership_legacy_migration_items
        WHERE id = ? AND status = 'migrated' AND result_grant_id = ?
      `).bind(
        auditId,
        actorId,
        JSON.stringify({ status: 'approved', evidenceSha256: item.evidence_sha256 }),
        JSON.stringify({ status: 'migrated', grantId, catalogVersionId: job.catalog_version_id }),
        timestamp,
        item.id,
        grantId,
      ),
    ])
  }
  catch {
    await markLegacyItem(db, item, actorId, 'failed', 'MIGRATION_WRITE_CONFLICT', '受控写入发生冲突，未确认生成新的会员 grant', now)
    return
  }
  const migrated = await db.prepare(`
    SELECT status FROM app_membership_legacy_migration_items WHERE id = ? LIMIT 1
  `).bind(item.id).first<{ status: string }>()
  if (migrated?.status !== 'migrated') {
    await markLegacyItem(db, item, actorId, 'stale', 'MIGRATION_BASELINE_CHANGED', '旧会员证据、账号或目录在执行前发生变化', now)
  }
}

async function markLegacyItem(
  db: D1Database,
  item: ItemRow,
  actorId: number,
  status: 'failed' | 'stale',
  code: string,
  summary: string,
  now: Date,
) {
  const timestamp = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_membership_legacy_migration_items
      SET status = ?, version = version + 1, failure_code = ?, failure_summary = ?, updated_at = ?
      WHERE id = ? AND status = 'approved'
    `).bind(status, code, summary, timestamp, item.id),
    db.prepare(`
      INSERT INTO app_membership_legacy_migration_item_events (
        id, item_id, sequence, event_type, actor_id, result_code, detail_json, created_at
      )
      SELECT ?, item.id,
             COALESCE((SELECT MAX(sequence) FROM app_membership_legacy_migration_item_events WHERE item_id = item.id), 0) + 1,
             ?, ?, ?, ?, ?
      FROM app_membership_legacy_migration_items item
      WHERE item.id = ? AND item.status = ? AND item.failure_code = ? AND item.updated_at = ?
    `).bind(randomId('amle'), status, actorId, code, JSON.stringify({ summary }), timestamp, item.id, status, code, timestamp),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.legacy_migration.item_failure', 'app_membership_legacy_migration_item', id, ?, ?, ?
      FROM app_membership_legacy_migration_items
      WHERE id = ? AND status = ? AND failure_code = ? AND updated_at = ?
    `).bind(
      randomId('audit'),
      actorId,
      JSON.stringify({ status: 'approved' }),
      JSON.stringify({ status, code, summary }),
      timestamp,
      item.id,
      status,
      code,
      timestamp,
    ),
  ])
}

async function listJobRows(db: D1Database, catalogVersionId: string): Promise<JobRow[]> {
  const result = await db.prepare(`
    SELECT job.id, job.catalog_version_id, job.status, job.mapping_json, job.mapping_sha256, job.version,
           job.created_by, creator.nickname AS creator_nickname, creator.role AS creator_role,
           job.submitted_at, job.executed_by, executor.nickname AS executor_nickname,
           executor.role AS executor_role, job.execution_started_at, job.execution_lease_expires_at,
           job.execution_token, job.execution_idempotency_key, job.execution_request_hash,
           job.executed_at, job.created_at
    FROM app_membership_legacy_migration_jobs job
    JOIN users creator ON creator.id = job.created_by
    LEFT JOIN users executor ON executor.id = job.executed_by
    WHERE job.catalog_version_id = ?
    ORDER BY job.created_at DESC, job.id DESC
    LIMIT 100
  `).bind(catalogVersionId).all<JobRow>()
  return result.results
}

async function requireJob(db: D1Database, catalogVersionId: string, jobId: string): Promise<JobRow> {
  const job = await db.prepare(`
    SELECT job.id, job.catalog_version_id, job.status, job.mapping_json, job.mapping_sha256, job.version,
           job.created_by, creator.nickname AS creator_nickname, creator.role AS creator_role,
           job.submitted_at, job.executed_by, executor.nickname AS executor_nickname,
           executor.role AS executor_role, job.execution_started_at, job.execution_lease_expires_at,
           job.execution_token, job.execution_idempotency_key, job.execution_request_hash,
           job.executed_at, job.created_at
    FROM app_membership_legacy_migration_jobs job
    JOIN users creator ON creator.id = job.created_by
    LEFT JOIN users executor ON executor.id = job.executed_by
    WHERE job.id = ? AND job.catalog_version_id = ?
    LIMIT 1
  `).bind(jobId, catalogVersionId).first<JobRow>()
  if (!job) throw new AppMembershipError(404, 'MEMBERSHIP_MIGRATION_JOB_NOT_FOUND', '旧会员迁移任务不存在')
  if (!isJobStatus(job.status)) throw invalidStoredEvidence()
  return job
}

async function listItemRows(db: D1Database, jobId: string): Promise<ItemRow[]> {
  const result = await db.prepare(`
    SELECT item.*, reviewer.nickname AS reviewer_nickname, reviewer.role AS reviewer_role
    FROM app_membership_legacy_migration_items item
    LEFT JOIN users reviewer ON reviewer.id = item.reviewed_by
    WHERE item.job_id = ?
    ORDER BY
      CASE item.status
        WHEN 'pending_review' THEN 0 WHEN 'approved' THEN 1 WHEN 'evidence_insufficient' THEN 2
        WHEN 'conflict' THEN 3 WHEN 'failed' THEN 4 WHEN 'stale' THEN 5 ELSE 6 END,
      item.created_at ASC, item.id ASC
  `).bind(jobId).all<ItemRow>()
  return result.results
}

async function requireItem(db: D1Database, jobId: string, itemId: string): Promise<ItemRow> {
  const item = (await listItemRows(db, jobId)).find(candidate => candidate.id === itemId)
  if (!item) throw new AppMembershipError(404, 'MEMBERSHIP_MIGRATION_ITEM_NOT_FOUND', '旧会员迁移条目不存在')
  return item
}

async function loadItemCounts(db: D1Database, jobIds: string[]) {
  const placeholders = jobIds.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT job_id, status, COUNT(*) AS count
    FROM app_membership_legacy_migration_items
    WHERE job_id IN (${placeholders})
    GROUP BY job_id, status
  `).bind(...jobIds).all<{ job_id: string; status: string; count: number }>()
  const counts = new Map<string, Record<AdminMembershipLegacyItemStatus, number>>()
  for (const row of result.results) {
    if (!isItemStatus(row.status)) throw invalidStoredEvidence()
    const current = counts.get(row.job_id) ?? emptyCounts()
    current[row.status] = Number(row.count)
    counts.set(row.job_id, current)
  }
  return counts
}

async function loadTargetTiers(db: D1Database, catalogVersionId: string, tierIds: string[]) {
  const placeholders = tierIds.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT tier_id, code, display_name, rank
    FROM app_membership_tiers
    WHERE catalog_version_id = ? AND tier_id IN (${placeholders})
  `).bind(catalogVersionId, ...tierIds).all<TierRow>()
  return new Map(result.results.map(tier => [tier.tier_id, tier]))
}

async function loadLegacyEvidence(
  db: D1Database,
  legacyLevelCodes: string[],
  now: Date,
  limit: number,
): Promise<LegacyEvidenceRow[]> {
  const placeholders = legacyLevelCodes.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT membership.id AS legacy_membership_id, membership.user_id,
           account.status AS user_status, account.email,
           security.account_public_id, security.status AS account_status,
	           level.id AS legacy_level_id, level.code AS legacy_level_code,
	           level.name AS legacy_level_name, level.rank AS legacy_rank,
	           membership.granted_by AS legacy_granted_by,
           membership.starts_at AS legacy_starts_at,
           membership.expires_at AS legacy_expires_at,
           EXISTS (
             SELECT 1 FROM app_membership_legacy_migration_items migrated
             WHERE migrated.legacy_membership_id = membership.id AND migrated.status = 'migrated'
           ) AS already_migrated,
           EXISTS (
             SELECT 1 FROM app_membership_grants grant_row
             WHERE grant_row.user_id = membership.user_id
               AND julianday(grant_row.starts_at) < julianday(membership.expires_at)
               AND julianday(grant_row.expires_at) > julianday(membership.starts_at)
               AND NOT EXISTS (
                 SELECT 1 FROM app_membership_grant_revocations revoked WHERE revoked.grant_id = grant_row.id
               )
           ) AS overlapping_grant
    FROM user_memberships membership
    JOIN membership_levels level ON level.id = membership.level_id
    JOIN users account ON account.id = membership.user_id
    LEFT JOIN app_account_security security ON security.account_id = account.id
    WHERE level.code IN (${placeholders})
      AND level.rank > 0
	      AND (
	        julianday(membership.expires_at) > julianday(?)
	        OR julianday(membership.expires_at) IS NULL
	      )
    ORDER BY membership.expires_at ASC, membership.id ASC
    LIMIT ?
  `).bind(...legacyLevelCodes, now.toISOString(), limit).all<LegacyEvidenceRow>()
  return result.results
}

async function loadCurrentEvidence(db: D1Database, legacyMembershipId: string): Promise<LegacyEvidenceRow | null> {
  return db.prepare(`
    SELECT membership.id AS legacy_membership_id, membership.user_id,
           account.status AS user_status, account.email,
           security.account_public_id, security.status AS account_status,
	           level.id AS legacy_level_id, level.code AS legacy_level_code,
	           level.name AS legacy_level_name, level.rank AS legacy_rank,
	           membership.granted_by AS legacy_granted_by,
           membership.starts_at AS legacy_starts_at,
           membership.expires_at AS legacy_expires_at,
           0 AS already_migrated, 0 AS overlapping_grant
    FROM user_memberships membership
    JOIN membership_levels level ON level.id = membership.level_id
    JOIN users account ON account.id = membership.user_id
    LEFT JOIN app_account_security security ON security.account_id = account.id
    WHERE membership.id = ?
    LIMIT 1
  `).bind(legacyMembershipId).first<LegacyEvidenceRow>()
}

function resolveDryRunConflict(row: LegacyEvidenceRow): { code: string; summary: string } | null {
  if (row.user_status !== 'active') return { code: 'ACCOUNT_RESTRICTED', summary: '旧会员所属账号当前受限' }
  if (!row.account_public_id) return { code: 'APP_ACCOUNT_NOT_LINKED', summary: '账号尚未建立 App 稳定身份，不能生成 App grant' }
  if (row.account_status !== 'active') return { code: 'APP_ACCOUNT_RESTRICTED', summary: 'App 账号当前不是可发放状态' }
  if (Number(row.already_migrated) === 1) return { code: 'LEGACY_EVIDENCE_ALREADY_MIGRATED', summary: '该旧会员证据已经完成迁移' }
  if (Number(row.overlapping_grant) === 1) return { code: 'APP_GRANT_OVERLAP', summary: '目标账号已有时间范围重叠的 App grant' }
  return null
}

function resolveExecutionStaleReason(item: ItemRow, row: LegacyEvidenceRow | null, now: Date) {
  if (!row) return { code: 'LEGACY_EVIDENCE_MISSING', summary: '旧会员证据已不存在' }
  if (row.user_status !== 'active' || row.account_status !== 'active') {
    return { code: 'ACCOUNT_RESTRICTED', summary: '账号在复核后变为受限状态' }
  }
  if (item.legacy_starts_at === null || item.legacy_expires_at === null) {
    return { code: 'LEGACY_EVIDENCE_INVALID', summary: '条目缺少已复核的有效期证据' }
  }
  const normalizedPeriod = normalizeLegacyPeriod(row.legacy_starts_at, row.legacy_expires_at, now)
  if (normalizedPeriod.conflict || normalizedPeriod.startsAt === null || normalizedPeriod.expiresAt === null) {
    return { code: 'LEGACY_EVIDENCE_INVALID', summary: '旧会员时间证据已无法解析' }
  }
  if (
    Number(row.user_id) !== Number(item.user_id)
    || row.legacy_level_id !== item.legacy_level_id
    || row.legacy_level_code !== item.legacy_level_code
    || Number(row.legacy_rank) !== Number(item.legacy_rank)
    || Number(row.legacy_granted_by) !== Number(item.legacy_granted_by)
    || (row.legacy_starts_at ?? '') !== item.legacy_starts_at_raw
    || (row.legacy_expires_at ?? '') !== item.legacy_expires_at_raw
    || normalizedPeriod.startsAt !== item.legacy_starts_at
    || normalizedPeriod.expiresAt !== item.legacy_expires_at
    || row.account_public_id !== item.account_public_id_snapshot
  ) {
    return { code: 'MIGRATION_BASELINE_CHANGED', summary: '旧会员证据或 App 账号标识在复核后发生变化' }
  }
  return null
}

async function loadExecutionControl(db: D1Database, catalogVersionId: string) {
  const control = await db.prepare(`
    SELECT execution_enabled, decision_reference, approved_by, approved_at
    FROM app_membership_legacy_migration_controls
    WHERE catalog_version_id = ?
    LIMIT 1
  `).bind(catalogVersionId).first<{
    execution_enabled: number
    decision_reference: string | null
    approved_by: number | null
    approved_at: string | null
  }>()
  const productionReady = control?.execution_enabled === 1
    && Boolean(control.decision_reference?.trim())
    && Number.isSafeInteger(Number(control.approved_by))
    && Number(control.approved_by) > 0
    && isValidDate(control.approved_at)
  return { productionReady }
}

async function findJobByCreateKey(db: D1Database, actorId: number, key: string) {
  return db.prepare(`
    SELECT id, request_hash FROM app_membership_legacy_migration_jobs
    WHERE created_by = ? AND request_idempotency_key = ? LIMIT 1
  `).bind(actorId, key).first<{ id: string; request_hash: string }>()
}

async function findMutationRequest(db: D1Database, actorId: number, key: string) {
  return db.prepare(`
    SELECT job_id, operation, request_hash, result_status
    FROM app_membership_legacy_migration_requests
    WHERE actor_id = ? AND idempotency_key = ? LIMIT 1
  `).bind(actorId, key).first<RequestRow>()
}

async function resolveMutationReplay(
  db: D1Database,
  catalogVersionId: string,
  jobId: string,
  actor: Actor,
  request: RequestRow,
  requestHash: string,
  operation: RequestRow['operation'],
): Promise<{ workspace: AdminMembershipLegacyWorkspace; replayed: boolean }> {
  if (request.job_id !== jobId || request.operation !== operation || request.request_hash !== requestHash) {
    throw idempotencyConflict()
  }
  return {
    workspace: await getAdminAppMembershipLegacyWorkspace(db, catalogVersionId, jobId, actor),
    replayed: true,
  }
}

function toJobSummary(
  row: JobRow,
  countsInput?: Record<AdminMembershipLegacyItemStatus, number>,
): AdminMembershipLegacyJobSummary {
  if (!isJobStatus(row.status)) throw invalidStoredEvidence()
  const mappings = parseMappings(row.mapping_json)
  const counts = countsInput ?? emptyCounts()
  return {
    jobId: row.id,
    catalogVersionId: row.catalog_version_id,
    status: row.status,
    version: Number(row.version),
    mappings,
    mappingSha256: row.mapping_sha256,
    counts,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    createdBy: { id: Number(row.created_by), label: adminLabel(row.creator_nickname, row.creator_role, Number(row.created_by)) },
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    executedBy: row.executed_by === null
      ? null
      : { id: Number(row.executed_by), label: adminLabel(row.executor_nickname, row.executor_role, Number(row.executed_by)) },
    executionStartedAt: row.execution_started_at,
    executionLeaseExpiresAt: row.execution_lease_expires_at,
    executedAt: row.executed_at,
  }
}

function toItemView(row: ItemRow): AdminMembershipLegacyItemView {
  if (!isItemStatus(row.status)) throw invalidStoredEvidence()
  return {
    itemId: row.id,
    legacyMembershipId: row.legacy_membership_id,
    userId: Number(row.user_id),
    accountId: row.account_public_id_snapshot,
    emailMasked: row.email_masked_snapshot,
    legacyLevel: {
      id: row.legacy_level_id,
      code: row.legacy_level_code,
      name: row.legacy_level_name,
      rank: Number(row.legacy_rank),
    },
    legacyStartsAt: row.legacy_starts_at,
    legacyExpiresAt: row.legacy_expires_at,
    targetTier: {
      tierId: row.target_tier_id,
      code: row.target_tier_code_snapshot,
      name: row.target_tier_name_snapshot,
      rank: Number(row.target_rank_snapshot),
    },
    evidenceSha256: row.evidence_sha256,
    status: row.status,
    version: Number(row.version),
    conflict: row.conflict_code && row.conflict_summary
      ? { code: row.conflict_code, summary: row.conflict_summary }
      : null,
    reviewedBy: row.reviewed_by === null
      ? null
      : { id: Number(row.reviewed_by), label: adminLabel(row.reviewer_nickname, row.reviewer_role, Number(row.reviewed_by)) },
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    resultGrantId: row.status === 'migrated' && row.result_grant_id ? row.result_grant_id : null,
    failure: row.failure_code && row.failure_summary
      ? { code: row.failure_code, summary: row.failure_summary }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function countItemRows(rows: ItemRow[]) {
  const counts = emptyCounts()
  for (const row of rows) {
    if (!isItemStatus(row.status)) throw invalidStoredEvidence()
    counts[row.status] += 1
  }
  return counts
}

function emptyCounts(): Record<AdminMembershipLegacyItemStatus, number> {
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

function normalizeMappings(value: unknown): Array<{ legacyLevelCode: string; targetTierId: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_MAPPING_INVALID', 'mappings 必须包含 1–10 条显式等级映射')
  }
  const seen = new Set<string>()
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw mappingInvalid()
    const row = candidate as { legacyLevelCode?: unknown; targetTierId?: unknown }
    const legacyLevelCode = normalizeText(row.legacyLevelCode, 'legacyLevelCode', 1, 48)
    const targetTierId = normalizeText(row.targetTierId, 'targetTierId', 5, 80)
    if (!LEGACY_LEVEL_CODE.test(legacyLevelCode) || !TARGET_TIER_ID.test(targetTierId)) throw mappingInvalid()
    if (seen.has(legacyLevelCode)) {
      throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_MAPPING_DUPLICATE', `旧等级 ${legacyLevelCode} 只能映射一次`)
    }
    seen.add(legacyLevelCode)
    return { legacyLevelCode, targetTierId }
  })
}

function parseMappings(value: string): AdminMembershipLegacyMapping[] {
  try {
    const parsed = JSON.parse(value) as AdminMembershipLegacyMapping[]
    if (!Array.isArray(parsed)) throw new Error('not array')
    return parsed
  }
  catch {
    throw invalidStoredEvidence()
  }
}

function normalizeLimit(value: unknown) {
  if (value === undefined || value === null || value === '') return 50
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_LIMIT_INVALID', 'limit 必须为 1–50 的整数')
  }
  return parsed
}

function normalizePositiveInteger(value: unknown, field: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_INPUT_INVALID', `${field} 必须为正整数`)
  }
  return parsed
}

function normalizeDecision(value: unknown): 'approve' | 'reject' {
  if (value === 'approve' || value === 'reject') return value
  throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_DECISION_INVALID', 'decision 必须为 approve 或 reject')
}

function normalizeText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_INPUT_INVALID', `${field} 为必填字符串`)
  }
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) {
    throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_INPUT_INVALID', `${field} 长度必须为 ${min}–${max}`)
  }
  return normalized
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AppMembershipError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 必须为 16–128 位安全字符')
  }
  return normalized
}

function normalizeLegacyDate(value: string | null) {
  if (!value) return null
  const normalizedInput = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = new Date(normalizedInput)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function normalizeLegacyPeriod(startsAtRaw: string | null, expiresAtRaw: string | null, now?: Date) {
  const startsAt = normalizeLegacyDate(startsAtRaw)
  const expiresAt = normalizeLegacyDate(expiresAtRaw)
  if (!startsAt || !expiresAt) {
    return {
      startsAt,
      expiresAt,
      conflict: { code: 'LEGACY_PERIOD_INVALID', summary: '旧会员开始时间或到期时间无法解析，证据不足' },
    }
  }
  if (new Date(expiresAt).getTime() <= new Date(startsAt).getTime()) {
    return {
      startsAt,
      expiresAt,
      conflict: { code: 'LEGACY_PERIOD_INVALID', summary: '旧会员到期时间必须晚于开始时间，证据不足' },
    }
  }
  if (now && new Date(expiresAt).getTime() <= now.getTime()) {
    return {
      startsAt,
      expiresAt,
      conflict: { code: 'LEGACY_PERIOD_EXPIRED', summary: '旧会员证据已经到期，不生成新的 App 会员' },
    }
  }
  return { startsAt, expiresAt, conflict: null as { code: string; summary: string } | null }
}

function isFuture(value: string | null, now: Date) {
  if (!value) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()
}

function isValidDate(value: string | null) {
  if (!value) return false
  return !Number.isNaN(new Date(value).getTime())
}

function validateJobId(value: string) {
  if (!JOB_ID.test(value)) throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_JOB_ID_INVALID', '迁移任务 ID 格式无效')
}

function validateItemId(value: string) {
  if (!ITEM_ID.test(value)) throw new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_ITEM_ID_INVALID', '迁移条目 ID 格式无效')
}

function requireOwnerActor(actor: Actor) {
  if (actor.role !== 'owner') {
    throw new AppMembershipError(403, 'OWNER_REQUIRED', '该迁移操作仅限 Owner')
  }
}

function isJobStatus(value: string): value is AdminMembershipLegacyJobStatus {
  return value === 'dry_run' || value === 'pending_review' || value === 'ready'
    || value === 'executing' || value === 'completed' || value === 'partial_failed' || value === 'cancelled'
}

function isItemStatus(value: string): value is AdminMembershipLegacyItemStatus {
  return ITEM_STATUSES.includes(value as AdminMembershipLegacyItemStatus)
}

function adminLabel(nickname: string | null, role: string | null, id: number) {
  return nickname?.trim() || `${role === 'owner' ? '站长' : '管理员'} #${id}`
}

function maskEmail(email: string) {
  const separator = email.lastIndexOf('@')
  if (separator <= 0) return '***'
  const local = email.slice(0, separator)
  return `${local.slice(0, Math.min(2, local.length))}***${email.slice(separator)}`
}

function mappingInvalid() {
  return new AppMembershipError(400, 'MEMBERSHIP_MIGRATION_MAPPING_INVALID', '旧等级与目标等级映射格式无效')
}

function jobStateConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_MIGRATION_JOB_STATE_CONFLICT', '迁移任务状态已变化，请刷新后重试')
}

function itemStateConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_MIGRATION_ITEM_STATE_CONFLICT', '迁移条目状态已变化，请刷新后重试')
}

function versionConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_MIGRATION_VERSION_CONFLICT', '迁移数据版本已变化，请刷新后重试')
}

function idempotencyConflict() {
  return new AppMembershipError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被其他迁移操作使用')
}

function invalidStoredEvidence() {
  return new AppMembershipError(503, 'MEMBERSHIP_MIGRATION_DATA_INVALID', '旧会员迁移数据异常', true)
}

function randomId(prefix: 'amlj' | 'amli' | 'amle' | 'amlr' | 'amlx' | 'audit') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
