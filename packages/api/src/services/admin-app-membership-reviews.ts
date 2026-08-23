import type { AppMembershipSnapshot } from '@meigallery/shared'
import {
  getAdminAppMembershipGrantById,
  normalizeAdminAppMembershipGrantInput,
  normalizeAdminAppMembershipRevokeInput,
  previewAdminAppMembershipGrant,
  resolveAdminAppMembershipRevokeReviewRequirement,
  type AdminAppMembershipGrantInput,
  type AdminAppMembershipGrantView,
  type AdminAppMembershipReviewRequirement,
  type AdminAppMembershipRevokeInput,
  type AppMembershipGrantReason,
  type AppMembershipRevokeReason,
} from './admin-app-membership'
import { AppMembershipError, resolveAppMembershipSnapshot } from './app-membership'
import { requireAppOperationalControlAvailable } from './app-operational-safety'

const REQUEST_ID = /^amcr_[A-Za-z0-9_-]{1,91}$/u
const APPLICATION_ID = /^ama_[A-Za-z0-9_-]{1,76}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u

export type AdminAppMembershipChangeOperation = 'grant' | 'revoke'
export type AdminAppMembershipChangeStatus =
  | 'pending_review'
  | 'executing'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'cancelled'

export interface AdminAppMembershipChangeReviewInput {
  expectedVersion?: unknown
  reviewNote?: unknown
}

export interface AdminAppMembershipChangeListQuery {
  status?: unknown
  operation?: unknown
  limit?: unknown
}

export interface AdminAppMembershipRevokePreview {
  grant: AdminAppMembershipGrantView
  current: AppMembershipSnapshot
  review: AdminAppMembershipReviewRequirement
}

export interface AdminAppMembershipChangeRequestView {
  requestId: string
  operation: AdminAppMembershipChangeOperation
  account: {
    userId: number
    accountId: string | null
    emailMasked: string
    status: string
  }
  grantChange: null | {
    action: 'grant' | 'renew'
    catalogVersionId: string
    tierId: string
    tierCode: string
    tierName: string
    rank: number
    startsAt: string
    expiresAt: string
    durationDays: number
  }
  revokeTarget: null | {
    grantId: string
    tierName: string
    rank: number
    startsAt: string
    expiresAt: string
    revoked: boolean
  }
  reasonCode: AppMembershipGrantReason | AppMembershipRevokeReason
  userVisibleNote: string
  internalNote: string | null
  businessReference: string
  source: {
    type: 'direct_admin' | 'membership_application'
    applicationId: string | null
    applicationVersion: number | null
  }
  baseline: {
    grantId: string | null
    rank: number
    expiresAt: string | null
  }
  currentMembership: AppMembershipSnapshot
  policy: {
    policyId: string | null
    versionCode: string
    mode: AdminAppMembershipReviewRequirement['mode']
    riskCodes: AdminAppMembershipReviewRequirement['riskCodes']
  }
  status: AdminAppMembershipChangeStatus
  version: number
  requestedBy: { id: number; label: string }
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  resultGrantId: string | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  appliedAt: string | null
  canReview: boolean
}

interface ChangeRequestRow {
  id: string
  operation: string
  policy_id: string | null
  policy_version_code: string
  policy_mode: string
  target_user_id: number
  catalog_version_id: string
  tier_id: string | null
  tier_code_snapshot: string | null
  tier_name_snapshot: string | null
  rank_snapshot: number | null
  grant_action: string | null
  starts_at: string | null
  expires_at: string | null
  duration_days: number | null
  target_grant_id: string | null
  target_grant_tier_name: string | null
  target_grant_rank: number | null
  target_grant_starts_at: string | null
  target_grant_expires_at: string | null
  target_grant_revoked_at: string | null
  reason_code: string
  user_visible_note: string
  internal_note: string | null
  business_reference: string
  source_type: string
  source_application_id: string | null
  source_application_version: number | null
  baseline_grant_id: string | null
  baseline_rank: number
  baseline_expires_at: string | null
  risk_codes_json: string
  status: string
  version: number
  request_hash: string
  requested_by: number
  requester_label: string
  reviewed_by: number | null
  reviewer_label: string | null
  review_note: string | null
  result_grant_id: string | null
  created_at: string
  updated_at: string
  reviewed_at: string | null
  applied_at: string | null
  account_public_id: string | null
  account_email: string
  account_status: string
}

interface DecisionRow {
  request_id: string
  request_hash: string
  result_status: string
}

interface SourceApplicationOptions {
  applicationId: string
  expectedVersion: number
}

export async function createAdminAppMembershipGrantChangeRequest(
  db: D1Database,
  catalogVersionId: string,
  adminId: number,
  idempotencyKey: string | null,
  body: AdminAppMembershipGrantInput,
  now = new Date(),
  requireProductionReady = false,
  sourceApplication?: SourceApplicationOptions,
): Promise<{ request: AdminAppMembershipChangeRequestView; replayed: boolean }> {
  const key = normalizeIdempotencyKey(idempotencyKey)
  const input = normalizeAdminAppMembershipGrantInput(body)
  const requestHash = await sha256Hex(JSON.stringify({ operation: 'grant', input, sourceApplication: sourceApplication ?? null }))
  const replay = await findRequestedChange(db, adminId, key)
  if (replay) return resolveCreateReplay(db, replay, requestHash, adminId, now, requireProductionReady)

  const preview = await previewAdminAppMembershipGrant(db, catalogVersionId, body, now, requireProductionReady)
  const source = sourceApplication
    ? await validateSourceApplication(db, sourceApplication, adminId, input.userId, input.tierId, catalogVersionId)
    : null
  const duplicate = await findActiveBusinessReference(db, input.userId, 'grant', input.businessReference)
  if (duplicate) throw businessReferenceConflict()

  const requestId = randomId('amcr')
  const timestamp = now.toISOString()
  const eventId = randomId('amce')
  const auditId = randomId('audit')
  const sourceType = source ? 'membership_application' : 'direct_admin'
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_membership_change_requests (
          id, operation, policy_id, policy_version_code, policy_mode,
          target_user_id, catalog_version_id, tier_id, tier_code_snapshot,
          tier_name_snapshot, rank_snapshot, grant_action, starts_at, expires_at,
          duration_days, target_grant_id, reason_code, user_visible_note, internal_note,
          business_reference, source_type, source_application_id, source_application_version,
          baseline_grant_id, baseline_rank, baseline_expires_at, risk_codes_json,
          status, version, request_idempotency_key, request_hash, requested_by,
          created_at, updated_at
        )
        SELECT
          ?, 'grant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 1, ?, ?, ?, ?, ?
        WHERE ? = 'direct_admin'
           OR EXISTS (
             SELECT 1 FROM app_membership_applications application
             WHERE application.id = ?
               AND application.user_id = ?
               AND application.catalog_version_id = ?
               AND application.tier_id = ?
               AND application.status = 'processing'
               AND application.version = ?
               AND application.assigned_to = ?
               AND application.approval_request_key IS NULL
           )
      `).bind(
        requestId,
        preview.review.policyId,
        preview.review.policyVersionCode,
        preview.review.mode,
        input.userId,
        catalogVersionId,
        preview.tier.tierId,
        preview.tier.code,
        preview.tier.displayName,
        preview.tier.rank,
        preview.action,
        preview.startsAt,
        preview.expiresAt,
        preview.durationDays,
        preview.reasonCode,
        preview.userVisibleNote,
        input.internalNote,
        preview.businessReference,
        sourceType,
        source?.id ?? null,
        source?.version ?? null,
        preview.current.grant?.grantId ?? null,
        preview.current.tier?.rank ?? 0,
        preview.current.grant?.expiresAt ?? null,
        JSON.stringify(preview.review.riskCodes),
        key,
        requestHash,
        adminId,
        timestamp,
        timestamp,
        sourceType,
        source?.id ?? null,
        input.userId,
        catalogVersionId,
        input.tierId,
        source?.version ?? 0,
        adminId,
      ),
      db.prepare(`
        INSERT INTO app_membership_change_request_events (
          id, request_id, sequence, event_type, actor_id, result_code, created_at
        )
        SELECT ?, id, 1, 'submitted', ?, 'pending_review', ?
        FROM app_membership_change_requests WHERE id = ?
      `).bind(eventId, adminId, timestamp, requestId),
      db.prepare(`
        UPDATE app_membership_applications
        SET approval_request_key = ?, approval_started_at = ?, updated_at = ?
        WHERE id = ? AND ? = 'membership_application'
          AND status = 'processing' AND version = ? AND assigned_to = ?
          AND approval_request_key IS NULL
          AND EXISTS (
            SELECT 1 FROM app_membership_change_requests request
            WHERE request.id = ? AND request.source_application_id = app_membership_applications.id
          )
      `).bind(
        key,
        timestamp,
        timestamp,
        source?.id ?? '',
        sourceType,
        source?.version ?? 0,
        adminId,
        requestId,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app.membership.change.request', 'app_membership_change_request', id, ?, ?, ?
        FROM app_membership_change_requests WHERE id = ?
      `).bind(
        auditId,
        adminId,
        JSON.stringify({ membership: preview.current.status, rank: preview.current.tier?.rank ?? 0 }),
        JSON.stringify({
          operation: 'grant',
          tierId: preview.tier.tierId,
          rank: preview.tier.rank,
          startsAt: preview.startsAt,
          expiresAt: preview.expiresAt,
          businessReference: preview.businessReference,
          sourceType,
          sourceApplicationId: source?.id ?? null,
          policyVersionCode: preview.review.policyVersionCode,
          riskCodes: preview.review.riskCodes,
          hasInternalNote: input.internalNote !== null,
          status: 'pending_review',
        }),
        timestamp,
        requestId,
      ),
    ])
  }
  catch (error) {
    const raced = await findRequestedChange(db, adminId, key)
    if (raced) return resolveCreateReplay(db, raced, requestHash, adminId, now, requireProductionReady)
    if (await findActiveBusinessReference(db, input.userId, 'grant', input.businessReference)) {
      throw businessReferenceConflict()
    }
    throw error
  }

  const created = await findRequestedChange(db, adminId, key)
  if (!created) {
    throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_VERSION_CONFLICT', '会员申请状态已变化，请刷新后重试')
  }
  if (source) {
    const locked = await db.prepare(`
      SELECT approval_request_key FROM app_membership_applications WHERE id = ? LIMIT 1
    `).bind(source.id).first<{ approval_request_key: string | null }>()
    if (locked?.approval_request_key !== key) {
      throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_VERSION_CONFLICT', '会员申请锁定失败，请刷新后重试')
    }
  }
  return {
    request: await requireChangeRequest(db, created.id, adminId, now, requireProductionReady, true),
    replayed: false,
  }
}

export async function previewAdminAppMembershipRevokeChange(
  db: D1Database,
  catalogVersionId: string,
  grantId: string,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipRevokePreview> {
  const grant = await getAdminAppMembershipGrantById(db, grantId)
  if (grant.catalogVersionId !== catalogVersionId) {
    throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_CHANGED', '目标 grant 不属于当前会员目录')
  }
  const [current, review] = await Promise.all([
    resolveAppMembershipSnapshot(db, grant.userId, catalogVersionId, now, { requireProductionReady }),
    resolveAdminAppMembershipRevokeReviewRequirement(db),
  ])
  return { grant, current, review }
}

export async function createAdminAppMembershipRevokeChangeRequest(
  db: D1Database,
  catalogVersionId: string,
  adminId: number,
  grantId: string,
  idempotencyKey: string | null,
  body: AdminAppMembershipRevokeInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ request: AdminAppMembershipChangeRequestView; replayed: boolean }> {
  const key = normalizeIdempotencyKey(idempotencyKey)
  const input = normalizeAdminAppMembershipRevokeInput(body)
  const requestHash = await sha256Hex(JSON.stringify({ operation: 'revoke', grantId, input }))
  const replay = await findRequestedChange(db, adminId, key)
  if (replay) return resolveCreateReplay(db, replay, requestHash, adminId, now, requireProductionReady)

  const preview = await previewAdminAppMembershipRevokeChange(
    db,
    catalogVersionId,
    grantId,
    now,
    requireProductionReady,
  )
  if (preview.grant.revoked) {
    throw new AppMembershipError(409, 'MEMBERSHIP_GRANT_ALREADY_REVOKED', '该会员发放已经撤销')
  }
  const duplicate = await findActiveBusinessReference(
    db,
    preview.grant.userId,
    'revoke',
    input.businessReference,
  )
  if (duplicate) throw businessReferenceConflict()

  const requestId = randomId('amcr')
  const eventId = randomId('amce')
  const auditId = randomId('audit')
  const timestamp = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_membership_change_requests (
          id, operation, policy_id, policy_version_code, policy_mode,
          target_user_id, catalog_version_id, tier_id, tier_code_snapshot,
          tier_name_snapshot, rank_snapshot, grant_action, starts_at, expires_at,
          duration_days, target_grant_id, reason_code, user_visible_note, internal_note,
          business_reference, source_type, source_application_id, source_application_version,
          baseline_grant_id, baseline_rank, baseline_expires_at, risk_codes_json,
          status, version, request_idempotency_key, request_hash, requested_by,
          created_at, updated_at
        ) VALUES (
          ?, 'revoke', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?,
          ?, ?, ?, ?, 'direct_admin', NULL, NULL, ?, ?, ?, ?,
          'pending_review', 1, ?, ?, ?, ?, ?
        )
      `).bind(
        requestId,
        preview.review.policyId,
        preview.review.policyVersionCode,
        preview.review.mode,
        preview.grant.userId,
        catalogVersionId,
        grantId,
        input.reasonCode,
        input.userVisibleNote,
        input.internalNote,
        input.businessReference,
        preview.current.grant?.grantId ?? null,
        preview.current.tier?.rank ?? 0,
        preview.current.grant?.expiresAt ?? null,
        JSON.stringify(preview.review.riskCodes),
        key,
        requestHash,
        adminId,
        timestamp,
        timestamp,
      ),
      db.prepare(`
        INSERT INTO app_membership_change_request_events (
          id, request_id, sequence, event_type, actor_id, result_code, created_at
        ) VALUES (?, ?, 1, 'submitted', ?, 'pending_review', ?)
      `).bind(eventId, requestId, adminId, timestamp),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        ) VALUES (?, ?, 'app.membership.change.request', 'app_membership_change_request', ?, ?, ?, ?)
      `).bind(
        auditId,
        adminId,
        requestId,
        JSON.stringify({ grantId, revoked: false, rank: preview.grant.rank }),
        JSON.stringify({
          operation: 'revoke',
          grantId,
          businessReference: input.businessReference,
          policyVersionCode: preview.review.policyVersionCode,
          riskCodes: preview.review.riskCodes,
          hasInternalNote: input.internalNote !== null,
          status: 'pending_review',
        }),
        timestamp,
      ),
    ])
  }
  catch (error) {
    const raced = await findRequestedChange(db, adminId, key)
    if (raced) return resolveCreateReplay(db, raced, requestHash, adminId, now, requireProductionReady)
    if (await findActiveBusinessReference(db, preview.grant.userId, 'revoke', input.businessReference)) {
      throw businessReferenceConflict()
    }
    throw error
  }
  return {
    request: await requireChangeRequest(db, requestId, adminId, now, requireProductionReady, true),
    replayed: false,
  }
}

export async function listAdminAppMembershipChangeRequests(
  db: D1Database,
  reviewerId: number,
  catalogVersionId: string,
  query: AdminAppMembershipChangeListQuery,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipChangeRequestView[]> {
  const filter = normalizeListQuery(query)
  const conditions: string[] = []
  const bindings: Array<string | number> = []
  if (filter.status) {
    conditions.push('request.status = ?')
    bindings.push(filter.status)
  }
  if (filter.operation) {
    conditions.push('request.operation = ?')
    bindings.push(filter.operation)
  }
  conditions.push('request.catalog_version_id = ?')
  bindings.push(catalogVersionId)
  const where = `WHERE ${conditions.join(' AND ')}`
  const rows = await db.prepare(`
    ${changeRequestSelect()}
    ${where}
    ORDER BY CASE request.status WHEN 'pending_review' THEN 0 WHEN 'executing' THEN 1 ELSE 2 END,
             request.created_at ASC, request.id ASC
    LIMIT ?
  `).bind(...bindings, filter.limit).all<ChangeRequestRow>()
  return Promise.all(rows.results.map(row => toChangeRequestView(
    db,
    row,
    reviewerId,
    now,
    requireProductionReady,
    false,
  )))
}

export async function getAdminAppMembershipChangeRequest(
  db: D1Database,
  requestId: string,
  reviewerId: number,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipChangeRequestView> {
  validateRequestId(requestId)
  const view = await requireChangeRequest(db, requestId, reviewerId, now, requireProductionReady, true)
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app.membership.change.view', 'app_membership_change_request', ?, NULL, ?, ?)
  `).bind(
    randomId('audit'),
    reviewerId,
    requestId,
    JSON.stringify({ purpose: 'service_operation', fields: ['internal_note', 'review_note'] }),
    now.toISOString(),
  ).run()
  return view
}

export async function reviewAdminAppMembershipChangeRequest(
  db: D1Database,
  requestId: string,
  reviewerId: number,
  decision: 'approve' | 'reject',
  idempotencyKey: string | null,
  body: AdminAppMembershipChangeReviewInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ request: AdminAppMembershipChangeRequestView; replayed: boolean }> {
  validateRequestId(requestId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = positiveInteger(body.expectedVersion, 'expectedVersion')
  const reviewNote = requiredText(body.reviewNote, 'reviewNote', 2, 500)
  const reviewNoteSha256 = await sha256Hex(reviewNote)
  const requestHash = await sha256Hex(JSON.stringify({ requestId, decision, expectedVersion, reviewNote }))
  const replay = await findDecision(db, reviewerId, key)
  if (replay) {
    if (replay.request_id !== requestId || replay.request_hash !== requestHash) throw idempotencyConflict()
    if (replay.result_status === 'stale') throw staleConflict()
    return {
      request: await requireChangeRequest(db, requestId, reviewerId, now, requireProductionReady, true),
      replayed: true,
    }
  }
  const current = await requireChangeRequest(db, requestId, reviewerId, now, requireProductionReady, true)
  if (current.requestedBy.id === reviewerId) {
    throw new AppMembershipError(403, 'MEMBERSHIP_SELF_REVIEW_FORBIDDEN', '会员变更发起人不能复核自己的申请')
  }
  if (current.status !== 'pending_review') {
    throw new AppMembershipError(409, 'MEMBERSHIP_CHANGE_ALREADY_REVIEWED', '会员变更申请已被处理，请刷新后查看')
  }
  if (current.version !== expectedVersion) {
    throw new AppMembershipError(409, 'MEMBERSHIP_CHANGE_VERSION_CONFLICT', '会员变更申请版本已变化，请刷新后复核')
  }
  await requireActiveAdmin(db, reviewerId)

  if (decision === 'reject') {
    return rejectChangeRequest(
      db,
      current,
      reviewerId,
      key,
      requestHash,
      reviewNote,
      reviewNoteSha256,
      now,
      requireProductionReady,
    )
  }
  if (current.operation === 'grant') await requireMembershipGrantControl(db)
  return approveChangeRequest(
    db,
    current,
    reviewerId,
    key,
    requestHash,
    reviewNote,
    reviewNoteSha256,
    now,
    requireProductionReady,
  )
}

async function approveChangeRequest(
  db: D1Database,
  current: AdminAppMembershipChangeRequestView,
  reviewerId: number,
  key: string,
  decisionHash: string,
  reviewNote: string,
  reviewNoteSha256: string,
  now: Date,
  requireProductionReady: boolean,
): Promise<{ request: AdminAppMembershipChangeRequestView; replayed: boolean }> {
  const timestamp = now.toISOString()
  const mutationToken = randomId('amcm')
  const grantId = current.operation === 'grant' ? randomId('amg') : current.revokeTarget!.grantId
  const adminRequestId = randomId('amr')
  const executionIdempotencyKey = `membership.review.execute:${current.requestId}`
  const eventApprovedId = randomId('amce')
  const eventStaleId = randomId('amce')
  const decisionApprovedId = randomId('amcd')
  const decisionStaleId = randomId('amcd')
  const auditApprovedId = randomId('audit')
  const auditStaleId = randomId('audit')
  const applicationEventId = randomId('amae')
  const applicationAuditId = randomId('audit')

  await db.batch([
    db.prepare(`
      UPDATE app_membership_change_requests AS request
      SET status = 'executing', mutation_token = ?, reviewed_by = ?, review_note = ?,
          review_note_sha256 = ?, reviewed_at = ?, updated_at = ?
      WHERE request.id = ?
        AND request.status = 'pending_review'
        AND request.version = ?
        AND request.requested_by <> ?
        AND (
          request.operation <> 'grant'
          OR EXISTS (
            SELECT 1 FROM app_operational_safety_controls control
            WHERE control.control_key = 'membership_grants' AND control.state = 'available'
          )
        )
        AND EXISTS (
          SELECT 1 FROM users reviewer
          WHERE reviewer.id = ? AND reviewer.status = 'active' AND reviewer.role IN ('admin', 'owner')
        )
        AND (
          request.operation = 'revoke'
          OR EXISTS (
            SELECT 1 FROM users account
            WHERE account.id = request.target_user_id AND account.status = 'active'
          )
        )
        AND COALESCE(request.baseline_grant_id, '') = COALESCE((
          SELECT grant.id
          FROM app_membership_grants grant
          WHERE grant.user_id = request.target_user_id
            AND grant.catalog_version_id = request.catalog_version_id
            AND grant.starts_at <= ? AND grant.expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM app_membership_grant_revocations revocation
              WHERE revocation.grant_id = grant.id
            )
          ORDER BY grant.rank_snapshot DESC, grant.expires_at DESC, grant.id ASC
          LIMIT 1
        ), '')
        AND NOT EXISTS (
          SELECT 1 FROM app_membership_grants existing
          WHERE request.operation = 'grant'
            AND existing.user_id = request.target_user_id
            AND existing.business_reference = request.business_reference
        )
        AND (
          request.operation <> 'revoke'
          OR NOT EXISTS (
            SELECT 1 FROM app_membership_grant_revocations existing_revocation
            WHERE existing_revocation.grant_id = request.target_grant_id
          )
        )
        AND (
          request.source_type = 'direct_admin'
          OR EXISTS (
            SELECT 1 FROM app_membership_applications application
            WHERE application.id = request.source_application_id
              AND application.status = 'processing'
              AND application.version = request.source_application_version
              AND application.assigned_to = request.requested_by
              AND application.approval_request_key = request.request_idempotency_key
              AND application.grant_id IS NULL
          )
        )
    `).bind(
      mutationToken,
      reviewerId,
      reviewNote,
      reviewNoteSha256,
      timestamp,
      timestamp,
      current.requestId,
      current.version,
      reviewerId,
      reviewerId,
      timestamp,
      timestamp,
    ),
    db.prepare(`
      INSERT INTO app_membership_grants (
        id, user_id, catalog_version_id, tier_id, tier_code_snapshot, tier_name_snapshot,
        rank_snapshot, starts_at, expires_at, source_type, reason_code, user_visible_note,
        internal_note, business_reference, granted_by, created_at
      )
      SELECT ?, target_user_id, catalog_version_id, tier_id, tier_code_snapshot, tier_name_snapshot,
             rank_snapshot, starts_at, expires_at, 'manual_admin', reason_code, user_visible_note,
             internal_note, business_reference, ?, ?
      FROM app_membership_change_requests
      WHERE id = ? AND operation = 'grant' AND status = 'executing' AND mutation_token = ?
    `).bind(grantId, reviewerId, timestamp, current.requestId, mutationToken),
    db.prepare(`
      INSERT INTO app_membership_grant_revocations (
        grant_id, reason_code, user_visible_note, internal_note,
        business_reference, revoked_by, revoked_at
      )
      SELECT target_grant_id, reason_code, user_visible_note, internal_note,
             business_reference, ?, ?
      FROM app_membership_change_requests
      WHERE id = ? AND operation = 'revoke' AND status = 'executing' AND mutation_token = ?
    `).bind(reviewerId, timestamp, current.requestId, mutationToken),
    db.prepare(`
      INSERT INTO app_membership_admin_requests (
        id, idempotency_key, operation, request_hash, target_user_id, grant_id, created_by, created_at
      )
      SELECT ?, ?, operation, request_hash, target_user_id,
             CASE operation WHEN 'grant' THEN ? ELSE target_grant_id END,
             ?, ?
      FROM app_membership_change_requests request
      WHERE request.id = ? AND request.status = 'executing' AND request.mutation_token = ?
        AND (
          (request.operation = 'grant' AND EXISTS (SELECT 1 FROM app_membership_grants grant WHERE grant.id = ?))
          OR
          (request.operation = 'revoke' AND EXISTS (
            SELECT 1 FROM app_membership_grant_revocations revocation
            WHERE revocation.grant_id = request.target_grant_id
          ))
        )
    `).bind(
      adminRequestId,
      executionIdempotencyKey,
      grantId,
      reviewerId,
      timestamp,
      current.requestId,
      mutationToken,
      grantId,
    ),
    db.prepare(`
      UPDATE app_membership_change_requests AS request
      SET status = 'approved', version = version + 1,
          result_grant_id = CASE operation WHEN 'grant' THEN ? ELSE target_grant_id END,
          applied_at = ?, updated_at = ?
      WHERE request.id = ? AND request.status = 'executing' AND request.mutation_token = ?
        AND EXISTS (
          SELECT 1 FROM app_membership_admin_requests admin_request
          WHERE admin_request.id = ?
        )
    `).bind(grantId, timestamp, timestamp, current.requestId, mutationToken, adminRequestId),
    db.prepare(`
      UPDATE app_membership_applications AS application
      SET status = 'approved', version = version + 1,
          grant_id = ?, decision_message = ?, updated_at = ?, resolved_at = ?
      WHERE application.id = (
          SELECT source_application_id FROM app_membership_change_requests WHERE id = ?
        )
        AND EXISTS (
          SELECT 1 FROM app_membership_change_requests request
          WHERE request.id = ? AND request.status = 'approved'
            AND request.operation = 'grant' AND request.source_type = 'membership_application'
            AND request.source_application_version = application.version
            AND request.request_idempotency_key = application.approval_request_key
        )
    `).bind(
      grantId,
      '独立复核已通过，会员权益已由平台正式发放。',
      timestamp,
      timestamp,
      current.requestId,
      current.requestId,
    ),
    db.prepare(`
      INSERT INTO app_membership_application_events (
        id, application_id, sequence, event_type, from_status, to_status,
        public_message, actor_type, actor_user_id, created_at
      )
      SELECT ?, application.id, application.version, 'approved', 'processing', 'approved',
             application.decision_message, 'admin', ?, ?
      FROM app_membership_applications application
      JOIN app_membership_change_requests request ON request.source_application_id = application.id
      WHERE request.id = ? AND request.status = 'approved'
        AND request.source_type = 'membership_application'
        AND application.status = 'approved' AND application.grant_id = ?
    `).bind(applicationEventId, reviewerId, timestamp, current.requestId, grantId),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app_membership_application_approve', 'app_membership_application',
             application.id, ?, ?, ?
      FROM app_membership_applications application
      JOIN app_membership_change_requests request ON request.source_application_id = application.id
      WHERE request.id = ? AND request.status = 'approved'
        AND request.source_type = 'membership_application'
        AND application.status = 'approved' AND application.grant_id = ?
    `).bind(
      applicationAuditId,
      reviewerId,
      JSON.stringify({ status: 'processing', version: current.source.applicationVersion }),
      JSON.stringify({ status: 'approved', grantId, reviewRequestId: current.requestId }),
      timestamp,
      current.requestId,
      grantId,
    ),
    db.prepare(`
      INSERT INTO app_membership_change_request_events (
        id, request_id, sequence, event_type, actor_id, result_code, result_grant_id, created_at
      )
      SELECT ?, id, version, 'approved', ?, 'approved', result_grant_id, ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'approved' AND mutation_token = ?
    `).bind(eventApprovedId, reviewerId, timestamp, current.requestId, mutationToken),
    db.prepare(`
      INSERT INTO app_membership_change_review_decisions (
        id, request_id, reviewer_id, decision, idempotency_key,
        request_hash, result_status, result_grant_id, created_at
      )
      SELECT ?, id, ?, 'approve', ?, ?, 'approved', result_grant_id, ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'approved' AND mutation_token = ?
    `).bind(
      decisionApprovedId,
      reviewerId,
      key,
      decisionHash,
      timestamp,
      current.requestId,
      mutationToken,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.change.approve', 'app_membership_change_request', id, ?, ?, ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'approved' AND mutation_token = ?
    `).bind(
      auditApprovedId,
      reviewerId,
      JSON.stringify({ status: 'pending_review', version: current.version }),
      JSON.stringify({
        status: 'approved',
        operation: current.operation,
        resultGrantId: grantId,
        reviewNoteSha256,
        reviewNoteLength: Array.from(reviewNote).length,
      }),
      timestamp,
      current.requestId,
      mutationToken,
    ),
    db.prepare(`
      INSERT INTO app_membership_change_request_events (
        id, request_id, sequence, event_type, actor_id, result_code, created_at
      )
      SELECT ?, id, version + 1, 'execution_stale', ?, 'account_changed', ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'executing' AND mutation_token = ?
    `).bind(eventStaleId, reviewerId, timestamp, current.requestId, mutationToken),
    db.prepare(`
      INSERT INTO app_membership_change_review_decisions (
        id, request_id, reviewer_id, decision, idempotency_key,
        request_hash, result_status, result_grant_id, created_at
      )
      SELECT ?, id, ?, 'approve', ?, ?, 'stale', NULL, ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'executing' AND mutation_token = ?
    `).bind(
      decisionStaleId,
      reviewerId,
      key,
      decisionHash,
      timestamp,
      current.requestId,
      mutationToken,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.change.execution_stale', 'app_membership_change_request', id, ?, ?, ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'executing' AND mutation_token = ?
    `).bind(
      auditStaleId,
      reviewerId,
      JSON.stringify({ status: 'pending_review', version: current.version }),
      JSON.stringify({
        status: 'stale',
        resultCode: 'account_changed',
        reviewNoteSha256,
        reviewNoteLength: Array.from(reviewNote).length,
      }),
      timestamp,
      current.requestId,
      mutationToken,
    ),
    db.prepare(`
      UPDATE app_membership_change_requests
      SET status = 'stale', version = version + 1, updated_at = ?
      WHERE id = ? AND status = 'executing' AND mutation_token = ?
    `).bind(timestamp, current.requestId, mutationToken),
    db.prepare(`
      UPDATE app_membership_applications
      SET approval_request_key = NULL, approval_started_at = NULL, updated_at = ?
      WHERE id = ? AND approval_request_key = (
        SELECT request_idempotency_key FROM app_membership_change_requests
        WHERE id = ? AND status = 'stale'
      )
    `).bind(timestamp, current.source.applicationId ?? '', current.requestId),
  ])

  const decision = await findDecision(db, reviewerId, key)
  if (decision?.request_id === current.requestId && decision.request_hash === decisionHash) {
    if (decision.result_status === 'stale') throw staleConflict()
    return {
      request: await requireChangeRequest(
        db,
        current.requestId,
        reviewerId,
        now,
        requireProductionReady,
        true,
      ),
      replayed: false,
    }
  }
  throw new AppMembershipError(409, 'MEMBERSHIP_CHANGE_VERSION_CONFLICT', '会员变更已被其他复核人处理')
}

async function requireMembershipGrantControl(db: D1Database) {
  return requireAppOperationalControlAvailable(
    db,
    'membership_grants',
    (code, message) => new AppMembershipError(503, code, message, true),
  )
}

async function rejectChangeRequest(
  db: D1Database,
  current: AdminAppMembershipChangeRequestView,
  reviewerId: number,
  key: string,
  decisionHash: string,
  reviewNote: string,
  reviewNoteSha256: string,
  now: Date,
  requireProductionReady: boolean,
): Promise<{ request: AdminAppMembershipChangeRequestView; replayed: boolean }> {
  const timestamp = now.toISOString()
  const mutationToken = randomId('amcm')
  const eventId = randomId('amce')
  const decisionId = randomId('amcd')
  const auditId = randomId('audit')
  await db.batch([
    db.prepare(`
      UPDATE app_membership_change_requests
      SET status = 'rejected', version = version + 1, mutation_token = ?,
          reviewed_by = ?, review_note = ?, review_note_sha256 = ?,
          reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_review' AND version = ? AND requested_by <> ?
        AND EXISTS (
          SELECT 1 FROM users reviewer
          WHERE reviewer.id = ? AND reviewer.status = 'active' AND reviewer.role IN ('admin', 'owner')
        )
    `).bind(
      mutationToken,
      reviewerId,
      reviewNote,
      reviewNoteSha256,
      timestamp,
      timestamp,
      current.requestId,
      current.version,
      reviewerId,
      reviewerId,
    ),
    db.prepare(`
      INSERT INTO app_membership_change_request_events (
        id, request_id, sequence, event_type, actor_id, result_code, created_at
      )
      SELECT ?, id, version, 'rejected', ?, 'rejected', ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'rejected' AND mutation_token = ?
    `).bind(eventId, reviewerId, timestamp, current.requestId, mutationToken),
    db.prepare(`
      INSERT INTO app_membership_change_review_decisions (
        id, request_id, reviewer_id, decision, idempotency_key,
        request_hash, result_status, created_at
      )
      SELECT ?, id, ?, 'reject', ?, ?, 'rejected', ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'rejected' AND mutation_token = ?
    `).bind(decisionId, reviewerId, key, decisionHash, timestamp, current.requestId, mutationToken),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.change.reject', 'app_membership_change_request', id, ?, ?, ?
      FROM app_membership_change_requests
      WHERE id = ? AND status = 'rejected' AND mutation_token = ?
    `).bind(
      auditId,
      reviewerId,
      JSON.stringify({ status: 'pending_review', version: current.version }),
      JSON.stringify({
        status: 'rejected',
        reviewNoteSha256,
        reviewNoteLength: Array.from(reviewNote).length,
      }),
      timestamp,
      current.requestId,
      mutationToken,
    ),
    db.prepare(`
      UPDATE app_membership_applications
      SET approval_request_key = NULL, approval_started_at = NULL, updated_at = ?
      WHERE id = ? AND approval_request_key = (
        SELECT request_idempotency_key FROM app_membership_change_requests
        WHERE id = ? AND status = 'rejected'
      )
    `).bind(timestamp, current.source.applicationId ?? '', current.requestId),
  ])

  const decision = await findDecision(db, reviewerId, key)
  if (!decision || decision.request_id !== current.requestId || decision.request_hash !== decisionHash) {
    throw new AppMembershipError(409, 'MEMBERSHIP_CHANGE_VERSION_CONFLICT', '会员变更已被其他复核人处理')
  }
  return {
    request: await requireChangeRequest(
      db,
      current.requestId,
      reviewerId,
      now,
      requireProductionReady,
      true,
    ),
    replayed: false,
  }
}

async function validateSourceApplication(
  db: D1Database,
  source: SourceApplicationOptions,
  adminId: number,
  userId: number,
  tierId: string,
  catalogVersionId: string,
) {
  if (!APPLICATION_ID.test(source.applicationId) || !Number.isSafeInteger(source.expectedVersion) || source.expectedVersion < 1) {
    throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_INVALID', '会员申请来源参数无效')
  }
  const row = await db.prepare(`
    SELECT id, user_id, tier_id, catalog_version_id, status, version, assigned_to, approval_request_key
    FROM app_membership_applications WHERE id = ? LIMIT 1
  `).bind(source.applicationId).first<{
    id: string
    user_id: number
    tier_id: string
    catalog_version_id: string
    status: string
    version: number
    assigned_to: number | null
    approval_request_key: string | null
  }>()
  if (!row) throw new AppMembershipError(404, 'MEMBERSHIP_APPLICATION_NOT_FOUND', '会员申请不存在')
  if (
    row.status !== 'processing'
    || Number(row.version) !== source.expectedVersion
    || Number(row.assigned_to) !== adminId
    || Number(row.user_id) !== userId
    || row.tier_id !== tierId
    || row.catalog_version_id !== catalogVersionId
    || row.approval_request_key !== null
  ) {
    throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_VERSION_CONFLICT', '会员申请状态已变化，请刷新后重试')
  }
  return { id: row.id, version: Number(row.version) }
}

async function requireActiveAdmin(db: D1Database, adminId: number) {
  const admin = await db.prepare(`
    SELECT id FROM users WHERE id = ? AND status = 'active' AND role IN ('admin', 'owner') LIMIT 1
  `).bind(adminId).first<{ id: number }>()
  if (!admin) throw new AppMembershipError(403, 'ADMIN_REQUIRED', '需要有效管理员权限')
}

async function resolveCreateReplay(
  db: D1Database,
  replay: { id: string; request_hash: string },
  requestHash: string,
  adminId: number,
  now: Date,
  requireProductionReady: boolean,
) {
  if (replay.request_hash !== requestHash) throw idempotencyConflict()
  return {
    request: await requireChangeRequest(db, replay.id, adminId, now, requireProductionReady, true),
    replayed: true,
  }
}

async function findRequestedChange(db: D1Database, adminId: number, key: string) {
  return db.prepare(`
    SELECT id, request_hash FROM app_membership_change_requests
    WHERE requested_by = ? AND request_idempotency_key = ? LIMIT 1
  `).bind(adminId, key).first<{ id: string; request_hash: string }>()
}

async function findActiveBusinessReference(
  db: D1Database,
  userId: number,
  operation: AdminAppMembershipChangeOperation,
  businessReference: string,
) {
  return db.prepare(`
    SELECT id FROM app_membership_change_requests
    WHERE target_user_id = ? AND operation = ? AND business_reference = ?
      AND status IN ('pending_review', 'executing', 'approved')
    LIMIT 1
  `).bind(userId, operation, businessReference).first<{ id: string }>()
}

async function findDecision(db: D1Database, reviewerId: number, key: string) {
  return db.prepare(`
    SELECT request_id, request_hash, result_status
    FROM app_membership_change_review_decisions
    WHERE reviewer_id = ? AND idempotency_key = ? LIMIT 1
  `).bind(reviewerId, key).first<DecisionRow>()
}

async function requireChangeRequest(
  db: D1Database,
  requestId: string,
  reviewerId: number,
  now: Date,
  requireProductionReady: boolean,
  revealInternalNote: boolean,
) {
  const row = await db.prepare(`${changeRequestSelect()} WHERE request.id = ? LIMIT 1`)
    .bind(requestId)
    .first<ChangeRequestRow>()
  if (!row) throw new AppMembershipError(404, 'MEMBERSHIP_CHANGE_NOT_FOUND', '会员变更申请不存在')
  return toChangeRequestView(db, row, reviewerId, now, requireProductionReady, revealInternalNote)
}

function changeRequestSelect() {
  return `
    SELECT request.*,
           account.email AS account_email, account.status AS account_status,
           security.account_public_id,
           COALESCE(requester.nickname, requester.email) AS requester_label,
           COALESCE(reviewer.nickname, reviewer.email) AS reviewer_label,
           target_grant.tier_name_snapshot AS target_grant_tier_name,
           target_grant.rank_snapshot AS target_grant_rank,
           target_grant.starts_at AS target_grant_starts_at,
           target_grant.expires_at AS target_grant_expires_at,
           target_revocation.revoked_at AS target_grant_revoked_at
    FROM app_membership_change_requests request
    JOIN users account ON account.id = request.target_user_id
    LEFT JOIN app_account_security security ON security.account_id = account.id
    JOIN users requester ON requester.id = request.requested_by
    LEFT JOIN users reviewer ON reviewer.id = request.reviewed_by
    LEFT JOIN app_membership_grants target_grant ON target_grant.id = request.target_grant_id
    LEFT JOIN app_membership_grant_revocations target_revocation ON target_revocation.grant_id = target_grant.id
  `
}

async function toChangeRequestView(
  db: D1Database,
  row: ChangeRequestRow,
  reviewerId: number,
  now: Date,
  requireProductionReady: boolean,
  revealInternalNote: boolean,
): Promise<AdminAppMembershipChangeRequestView> {
  const operation = storedOperation(row.operation)
  const status = storedStatus(row.status)
  const mode = storedPolicyMode(row.policy_mode)
  const currentMembership = await resolveAppMembershipSnapshot(
    db,
    Number(row.target_user_id),
    row.catalog_version_id,
    now,
    { requireProductionReady },
  )
  const riskCodes = parseRiskCodes(row.risk_codes_json)
  const requestedBy = { id: Number(row.requested_by), label: row.requester_label }
  return {
    requestId: row.id,
    operation,
    account: {
      userId: Number(row.target_user_id),
      accountId: row.account_public_id,
      emailMasked: maskEmail(row.account_email),
      status: row.account_status,
    },
    grantChange: operation === 'grant'
      ? {
          action: storedGrantAction(row.grant_action),
          catalogVersionId: row.catalog_version_id,
          tierId: requiredStored(row.tier_id),
          tierCode: requiredStored(row.tier_code_snapshot),
          tierName: requiredStored(row.tier_name_snapshot),
          rank: safeInteger(row.rank_snapshot, 'rank_snapshot'),
          startsAt: requiredStored(row.starts_at),
          expiresAt: requiredStored(row.expires_at),
          durationDays: safeInteger(row.duration_days, 'duration_days'),
        }
      : null,
    revokeTarget: operation === 'revoke'
      ? {
          grantId: requiredStored(row.target_grant_id),
          tierName: requiredStored(row.target_grant_tier_name),
          rank: safeInteger(row.target_grant_rank, 'target_grant_rank'),
          startsAt: requiredStored(row.target_grant_starts_at),
          expiresAt: requiredStored(row.target_grant_expires_at),
          revoked: row.target_grant_revoked_at !== null,
        }
      : null,
    reasonCode: storedReasonCode(row.reason_code),
    userVisibleNote: row.user_visible_note,
    internalNote: revealInternalNote ? row.internal_note : null,
    businessReference: row.business_reference,
    source: {
      type: row.source_type === 'membership_application' ? 'membership_application' : 'direct_admin',
      applicationId: row.source_application_id,
      applicationVersion: row.source_application_version === null ? null : Number(row.source_application_version),
    },
    baseline: {
      grantId: row.baseline_grant_id,
      rank: Number(row.baseline_rank),
      expiresAt: row.baseline_expires_at,
    },
    currentMembership,
    policy: {
      policyId: row.policy_id,
      versionCode: row.policy_version_code,
      mode,
      riskCodes,
    },
    status,
    version: safeInteger(row.version, 'version'),
    requestedBy,
    reviewedBy: row.reviewed_by !== null && row.reviewer_label
      ? { id: Number(row.reviewed_by), label: row.reviewer_label }
      : null,
    reviewNote: revealInternalNote ? row.review_note : null,
    resultGrantId: row.result_grant_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    appliedAt: row.applied_at,
    canReview: status === 'pending_review' && requestedBy.id !== reviewerId,
  }
}

function normalizeListQuery(query: AdminAppMembershipChangeListQuery) {
  const status = query.status === undefined || query.status === '' || query.status === 'all'
    ? null
    : storedStatus(String(query.status))
  const operation = query.operation === undefined || query.operation === '' || query.operation === 'all'
    ? null
    : storedOperation(String(query.operation))
  const limit = query.limit === undefined ? 50 : Number(query.limit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppMembershipError(400, 'PAGE_SIZE_INVALID', 'limit 必须为 1–100 的整数')
  }
  return { status, operation, limit }
}

function parseRiskCodes(value: string): AdminAppMembershipReviewRequirement['riskCodes'] {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some(item => !isRiskCode(item))) throw new Error('invalid')
    return parsed
  }
  catch {
    throw new AppMembershipError(503, 'MEMBERSHIP_REVIEW_DATA_INVALID', '会员复核策略快照异常')
  }
}

function isRiskCode(value: unknown): value is AdminAppMembershipReviewRequirement['riskCodes'][number] {
  return value === 'POLICY_UNRESOLVED_ALL_REVIEW'
    || value === 'POLICY_REVIEW_ALL'
    || value === 'RANK_THRESHOLD'
    || value === 'DURATION_THRESHOLD'
    || value === 'LOWER_THAN_CURRENT_TIER'
    || value === 'REVOCATION'
}

function storedOperation(value: string): AdminAppMembershipChangeOperation {
  if (value === 'grant' || value === 'revoke') return value
  throw dataInvalid()
}

function storedStatus(value: string): AdminAppMembershipChangeStatus {
  if (
    value === 'pending_review' || value === 'executing' || value === 'approved'
    || value === 'rejected' || value === 'stale' || value === 'cancelled'
  ) return value
  throw dataInvalid()
}

function storedPolicyMode(value: string): AdminAppMembershipReviewRequirement['mode'] {
  if (value === 'conservative_review_all' || value === 'review_all' || value === 'risk_based') return value
  throw dataInvalid()
}

function storedGrantAction(value: string | null): 'grant' | 'renew' {
  if (value === 'grant' || value === 'renew') return value
  throw dataInvalid()
}

function storedReasonCode(value: string): AppMembershipGrantReason | AppMembershipRevokeReason {
  if (
    value === 'manual_review' || value === 'customer_support' || value === 'promotion' || value === 'compensation'
    || value === 'admin_correction' || value === 'customer_request'
    || value === 'account_restriction' || value === 'policy_enforcement'
  ) return value
  throw dataInvalid()
}

function safeInteger(value: number | null, field: string) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new AppMembershipError(503, 'MEMBERSHIP_REVIEW_DATA_INVALID', `${field} 数据异常`)
  }
  return normalized
}

function requiredStored(value: string | null) {
  if (!value) throw dataInvalid()
  return value
}

function positiveInteger(value: unknown, field: string) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new AppMembershipError(400, 'MEMBERSHIP_REVIEW_INPUT_INVALID', `${field} 必须为正整数`)
  }
  return normalized
}

function requiredText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'MEMBERSHIP_REVIEW_INPUT_INVALID', `${field} 为必填`)
  }
  const normalized = value.trim()
  if (Array.from(normalized).length < min || Array.from(normalized).length > max || hasControlCharacter(normalized)) {
    throw new AppMembershipError(400, 'MEMBERSHIP_REVIEW_INPUT_INVALID', `${field} 长度或字符无效`)
  }
  return normalized
}

function hasControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127
  })
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AppMembershipError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 必须为 16–128 位安全字符')
  }
  return normalized
}

function validateRequestId(value: string) {
  if (!REQUEST_ID.test(value)) {
    throw new AppMembershipError(404, 'MEMBERSHIP_CHANGE_NOT_FOUND', '会员变更申请不存在')
  }
}

function businessReferenceConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_BUSINESS_REFERENCE_CONFLICT', '该账号的业务单号已有待复核或已生效操作')
}

function idempotencyConflict() {
  return new AppMembershipError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被其他会员操作使用')
}

function staleConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_CHANGE_ACCOUNT_CHANGED', '账号会员状态已变化，旧申请已失效，请重新创建预览')
}

function dataInvalid() {
  return new AppMembershipError(503, 'MEMBERSHIP_REVIEW_DATA_INVALID', '会员复核数据异常')
}

function maskEmail(email: string) {
  const separator = email.lastIndexOf('@')
  if (separator <= 0) return '***'
  const local = email.slice(0, separator)
  return `${local.slice(0, Math.min(2, local.length))}***${email.slice(separator)}`
}

function randomId(prefix: 'amcr' | 'amce' | 'amcd' | 'amcm' | 'amg' | 'amr' | 'amae' | 'audit') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
