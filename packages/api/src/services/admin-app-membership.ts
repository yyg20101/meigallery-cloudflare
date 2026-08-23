import type { AppMembershipCatalog, AppMembershipSnapshot, AppMembershipTier } from '@meigallery/shared'
import { AppMembershipError, getAppMembershipCatalog, resolveAppMembershipSnapshot } from './app-membership'
import { requireAppOperationalControlAvailable } from './app-operational-safety'

export type AppMembershipGrantAction = 'grant' | 'renew'
export type AppMembershipGrantReason = 'manual_review' | 'customer_support' | 'promotion' | 'compensation'
export type AppMembershipRevokeReason = 'admin_correction' | 'customer_request' | 'account_restriction' | 'policy_enforcement'

export type AdminAppMembershipReviewRiskCode =
  | 'POLICY_UNRESOLVED_ALL_REVIEW'
  | 'POLICY_REVIEW_ALL'
  | 'RANK_THRESHOLD'
  | 'DURATION_THRESHOLD'
  | 'LOWER_THAN_CURRENT_TIER'
  | 'REVOCATION'

export interface AdminAppMembershipReviewRequirement {
  required: boolean
  policyId: string | null
  policyVersionCode: string
  mode: 'conservative_review_all' | 'review_all' | 'risk_based'
  riskCodes: AdminAppMembershipReviewRiskCode[]
}

export interface AdminAppMembershipGrantInput {
  userId?: unknown
  tierId?: unknown
  action?: unknown
  startsAt?: unknown
  durationDays?: unknown
  reasonCode?: unknown
  userVisibleNote?: unknown
  internalNote?: unknown
  businessReference?: unknown
}

export interface AdminAppMembershipRevokeInput {
  reasonCode?: unknown
  userVisibleNote?: unknown
  internalNote?: unknown
  businessReference?: unknown
}

export interface AdminAppMembershipGrantPreview {
  user: {
    userId: number
    accountId: string | null
    emailMasked: string
    status: 'active'
  }
  action: AppMembershipGrantAction
  catalogVersionId: string
  tier: {
    tierId: string
    code: string
    displayName: string
    rank: number
    accentToken: string
  }
  startsAt: string
  expiresAt: string
  durationDays: number
  reasonCode: AppMembershipGrantReason
  userVisibleNote: string
  businessReference: string
  current: AppMembershipSnapshot
  willBecomeCurrentImmediately: boolean
  warnings: Array<'DEVELOPMENT_CATALOG' | 'ENTITLEMENTS_PLANNED' | 'LOWER_THAN_CURRENT_TIER'>
  review: AdminAppMembershipReviewRequirement
}

export interface AdminAppMembershipGrantView {
  grantId: string
  userId: number
  catalogVersionId: string
  tierId: string
  tierCode: string
  tierName: string
  rank: number
  startsAt: string
  expiresAt: string
  sourceType: 'manual_admin'
  reasonCode: AppMembershipGrantReason
  userVisibleNote: string
  businessReference: string
  grantedBy: number
  createdAt: string
  revoked: boolean
  revokedAt: string | null
  revokeReasonCode: AppMembershipRevokeReason | null
}

export interface AdminAppMembershipGrantResult extends AdminAppMembershipGrantView {
  replayed: boolean
}

interface UserRow {
  id: number
  email: string
  status: string
  account_public_id: string | null
  security_status: string
}

interface GrantRow {
  id: string
  user_id: number
  catalog_version_id: string
  tier_id: string
  tier_code_snapshot: string
  tier_name_snapshot: string
  rank_snapshot: number
  starts_at: string
  expires_at: string
  source_type: string
  reason_code: string
  user_visible_note: string
  business_reference: string
  granted_by: number
  created_at: string
  revoked_at: string | null
  revoke_reason_code: string | null
}

interface AdminRequestRow {
  operation: string
  request_hash: string
  target_user_id: number
  grant_id: string
}

export interface NormalizedAdminAppMembershipGrantInput {
  userId: number
  tierId: string
  action: AppMembershipGrantAction
  startsAtInput: string | null
  durationDays: number
  reasonCode: AppMembershipGrantReason
  userVisibleNote: string
  internalNote: string | null
  businessReference: string
}

export interface NormalizedAdminAppMembershipRevokeInput {
  reasonCode: AppMembershipRevokeReason
  userVisibleNote: string
  internalNote: string | null
  businessReference: string
}

interface ReviewPolicyRow {
  id: string
  version_code: string
  risk_decision_status: string
  review_mode: string
  grant_rank_threshold: number | null
  grant_duration_days_threshold: number | null
  review_lower_rank_grant: number
  review_revocation: number
}

export async function previewAdminAppMembershipGrant(
  db: D1Database,
  catalogVersionId: string,
  body: AdminAppMembershipGrantInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipGrantPreview> {
  const input = normalizeAdminAppMembershipGrantInput(body)
  return buildGrantPreview(db, catalogVersionId, input, now, requireProductionReady)
}

export async function grantAdminAppMembership(
  db: D1Database,
  catalogVersionId: string,
  adminId: number,
  idempotencyKey: string | null,
  body: AdminAppMembershipGrantInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipGrantResult> {
  const input = normalizeAdminAppMembershipGrantInput(body)
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  const requestHash = await sha256Hex(JSON.stringify({ operation: 'grant', ...input }))
  const existing = await findAdminRequest(db, normalizedKey)
  if (existing) {
    return resolveExistingRequest(db, existing, requestHash, 'grant', input.userId)
  }

  await requireMembershipGrantControl(db)

  const preview = await buildGrantPreview(db, catalogVersionId, input, now, requireProductionReady)
  if (preview.review.required) {
    throw new AppMembershipError(
      409,
      'MEMBERSHIP_REVIEW_REQUIRED',
      '该会员变更必须先提交独立复核，不能直接发放',
    )
  }
  const grantId = secureId('amg')
  const requestId = secureId('amr')
  const auditId = secureId('audit')
  const createdAt = now.toISOString()
  const auditAfter = JSON.stringify({
    userId: input.userId,
    catalogVersionId,
    tierId: preview.tier.tierId,
    rank: preview.tier.rank,
    startsAt: preview.startsAt,
    expiresAt: preview.expiresAt,
    reasonCode: input.reasonCode,
    businessReference: input.businessReference,
    hasInternalNote: input.internalNote !== null,
    idempotencyRequestId: requestId,
  })

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_membership_grants (
          id, user_id, catalog_version_id, tier_id, tier_code_snapshot, tier_name_snapshot,
          rank_snapshot, starts_at, expires_at, source_type, reason_code, user_visible_note,
          internal_note, business_reference, granted_by, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_admin', ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM app_operational_safety_controls control
          WHERE control.control_key = 'membership_grants' AND control.state = 'available'
        )
      `).bind(
        grantId,
        input.userId,
        catalogVersionId,
        preview.tier.tierId,
        preview.tier.code,
        preview.tier.displayName,
        preview.tier.rank,
        preview.startsAt,
        preview.expiresAt,
        input.reasonCode,
        input.userVisibleNote,
        input.internalNote,
        input.businessReference,
        adminId,
        createdAt,
      ),
      db.prepare(`
        INSERT INTO app_membership_admin_requests (
          id, idempotency_key, operation, request_hash, target_user_id, grant_id, created_by, created_at
        )
        SELECT ?, ?, 'grant', ?, ?, id, ?, ?
        FROM app_membership_grants
        WHERE id = ?
      `).bind(requestId, normalizedKey, requestHash, input.userId, adminId, createdAt, grantId),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_membership_grant', 'app_membership_grant', id, ?, ?, ?
        FROM app_membership_grants
        WHERE id = ?
      `).bind(
        auditId,
        adminId,
        JSON.stringify({ status: preview.current.status, rank: preview.current.tier?.rank ?? 0 }),
        auditAfter,
        createdAt,
        grantId,
      ),
    ])
  }
  catch (error) {
    const raced = await findAdminRequest(db, normalizedKey)
    if (raced) return resolveExistingRequest(db, raced, requestHash, 'grant', input.userId)
    if (await findGrantByBusinessReference(db, input.userId, input.businessReference)) {
      throw businessReferenceConflict()
    }
    await requireMembershipGrantControl(db)
    throw error
  }

  try {
    return {
      ...(await getAdminAppMembershipGrantById(db, grantId)),
      replayed: false,
    }
  }
  catch (error) {
    await requireMembershipGrantControl(db)
    throw error
  }
}

async function requireMembershipGrantControl(db: D1Database) {
  return requireAppOperationalControlAvailable(
    db,
    'membership_grants',
    (code, message) => new AppMembershipError(503, code, message, true),
  )
}

export async function revokeAdminAppMembershipGrant(
  db: D1Database,
  adminId: number,
  grantId: string,
  idempotencyKey: string | null,
  body: AdminAppMembershipRevokeInput,
  now = new Date(),
): Promise<AdminAppMembershipGrantResult> {
  if (!/^amg_[A-Za-z0-9_-]{1,76}$/u.test(grantId)) {
    throw new AppMembershipError(404, 'MEMBERSHIP_GRANT_NOT_FOUND', '会员发放记录不存在')
  }
  const input = normalizeAdminAppMembershipRevokeInput(body)
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  const grant = await getAdminAppMembershipGrantById(db, grantId)
  const requestHash = await sha256Hex(JSON.stringify({ operation: 'revoke', grantId, ...input }))
  const existing = await findAdminRequest(db, normalizedKey)
  if (existing) {
    return resolveExistingRequest(db, existing, requestHash, 'revoke', grant.userId)
  }
  const review = await resolveAdminAppMembershipRevokeReviewRequirement(db)
  if (review.required) {
    throw new AppMembershipError(
      409,
      'MEMBERSHIP_REVIEW_REQUIRED',
      '该会员撤销必须先提交独立复核，不能直接执行',
    )
  }
  if (grant.revoked) return { ...grant, replayed: true }

  const revokedAt = now.toISOString()
  const requestId = secureId('amr')
  const auditId = secureId('audit')
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_membership_grant_revocations (
          grant_id, reason_code, user_visible_note, internal_note,
          business_reference, revoked_by, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        grantId,
        input.reasonCode,
        input.userVisibleNote,
        input.internalNote,
        input.businessReference,
        adminId,
        revokedAt,
      ),
      db.prepare(`
        INSERT INTO app_membership_admin_requests (
          id, idempotency_key, operation, request_hash, target_user_id, grant_id, created_by, created_at
        ) VALUES (?, ?, 'revoke', ?, ?, ?, ?, ?)
      `).bind(requestId, normalizedKey, requestHash, grant.userId, grantId, adminId, revokedAt),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        ) VALUES (?, ?, 'app_membership_revoke', 'app_membership_grant', ?, ?, ?, ?)
      `).bind(
        auditId,
        adminId,
        grantId,
        JSON.stringify({ revoked: false, rank: grant.rank, expiresAt: grant.expiresAt }),
        JSON.stringify({
          revoked: true,
          reasonCode: input.reasonCode,
          businessReference: input.businessReference,
          hasInternalNote: input.internalNote !== null,
          idempotencyRequestId: requestId,
        }),
        revokedAt,
      ),
    ])
  }
  catch (error) {
    const raced = await findAdminRequest(db, normalizedKey)
    if (raced) return resolveExistingRequest(db, raced, requestHash, 'revoke', grant.userId)
    const current = await getAdminAppMembershipGrantById(db, grantId)
    if (current.revoked) return { ...current, replayed: true }
    throw error
  }

  return { ...(await getAdminAppMembershipGrantById(db, grantId)), replayed: false }
}

export async function getAdminAppMembershipUserState(
  db: D1Database,
  catalogVersionId: string,
  userId: number,
  now = new Date(),
  requireProductionReady = false,
): Promise<{
  catalog: AppMembershipCatalog
  current: AppMembershipSnapshot
  grants: AdminAppMembershipGrantView[]
}> {
  await getActiveUser(db, userId)
  const [catalog, current, grants] = await Promise.all([
    getAppMembershipCatalog(db, catalogVersionId, { requireProductionReady }),
    resolveAppMembershipSnapshot(db, userId, catalogVersionId, now, { requireProductionReady }),
    db.prepare(`
      SELECT g.id, g.user_id, g.catalog_version_id, g.tier_id, g.tier_code_snapshot,
             g.tier_name_snapshot, g.rank_snapshot, g.starts_at, g.expires_at,
             g.source_type, g.reason_code, g.user_visible_note, g.business_reference,
             g.granted_by, g.created_at, r.revoked_at, r.reason_code AS revoke_reason_code
      FROM app_membership_grants g
      LEFT JOIN app_membership_grant_revocations r ON r.grant_id = g.id
      WHERE g.user_id = ? AND g.catalog_version_id = ?
      ORDER BY g.created_at DESC, g.id ASC
      LIMIT 100
    `).bind(userId, catalogVersionId).all<GrantRow>(),
  ])
  return {
    catalog,
    current,
    grants: grants.results.map(toGrantView),
  }
}

async function buildGrantPreview(
  db: D1Database,
  catalogVersionId: string,
  input: NormalizedAdminAppMembershipGrantInput,
  now: Date,
  requireProductionReady: boolean,
): Promise<AdminAppMembershipGrantPreview> {
  const [user, catalog, current, existingBusinessReference] = await Promise.all([
    getActiveUser(db, input.userId),
    getAppMembershipCatalog(db, catalogVersionId, { requireProductionReady }),
    resolveAppMembershipSnapshot(db, input.userId, catalogVersionId, now, { requireProductionReady }),
    findGrantByBusinessReference(db, input.userId, input.businessReference),
  ])
  if (existingBusinessReference) throw businessReferenceConflict()
  const tier = catalog.tiers.find(item => item.tierId === input.tierId)
  if (!tier) throw new AppMembershipError(400, 'MEMBERSHIP_TIER_INVALID', '会员等级不存在')

  const requestedStart = input.startsAtInput ? parseIsoDate(input.startsAtInput, '开始时间') : now
  if (requestedStart.getTime() < now.getTime() - 5 * 60_000) {
    throw new AppMembershipError(400, 'MEMBERSHIP_START_INVALID', '会员开始时间不能早于当前时间')
  }
  if (requestedStart.getTime() > now.getTime() + 90 * 86_400_000) {
    throw new AppMembershipError(400, 'MEMBERSHIP_START_INVALID', '预约生效时间不能超过 90 天')
  }

  let startsAt = requestedStart
  if (input.action === 'renew') {
    const latest = await db.prepare(`
      SELECT MAX(g.expires_at) AS latest_expiry
      FROM app_membership_grants g
      WHERE g.user_id = ?
        AND g.catalog_version_id = ?
        AND g.tier_id = ?
        AND g.expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM app_membership_grant_revocations r WHERE r.grant_id = g.id
        )
    `).bind(input.userId, catalogVersionId, input.tierId, now.toISOString()).first<{ latest_expiry: string | null }>()
    if (latest?.latest_expiry) {
      const latestExpiry = parseIsoDate(latest.latest_expiry, '已有会员到期时间')
      if (latestExpiry.getTime() > startsAt.getTime()) startsAt = latestExpiry
    }
  }
  const expiresAt = new Date(startsAt.getTime() + input.durationDays * 86_400_000)
  const warnings: AdminAppMembershipGrantPreview['warnings'] = []
  if (!catalog.productionReady) warnings.push('DEVELOPMENT_CATALOG')
  if (tier.entitlements.some(item => item.availability === 'planned')) warnings.push('ENTITLEMENTS_PLANNED')
  if ((current.tier?.rank ?? 0) > tier.rank) warnings.push('LOWER_THAN_CURRENT_TIER')

  const review = await resolveAdminAppMembershipGrantReviewRequirement(db, {
    rank: tier.rank,
    durationDays: input.durationDays,
    isLowerThanCurrent: (current.tier?.rank ?? 0) > tier.rank,
  })

  return {
    user: {
      userId: user.id,
      accountId: user.account_public_id,
      emailMasked: maskEmail(user.email),
      status: 'active',
    },
    action: input.action,
    catalogVersionId,
    tier: tierSummary(tier),
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    durationDays: input.durationDays,
    reasonCode: input.reasonCode,
    userVisibleNote: input.userVisibleNote,
    businessReference: input.businessReference,
    current,
    willBecomeCurrentImmediately: startsAt.getTime() <= now.getTime()
      && tier.rank >= (current.tier?.rank ?? 0),
    warnings,
    review,
  }
}

async function getActiveUser(db: D1Database, userId: number): Promise<UserRow> {
  const user = await db.prepare(`
    SELECT u.id, u.email, u.status, s.account_public_id, s.status AS security_status
    FROM users u
    JOIN app_account_security s ON s.account_id = u.id
    WHERE u.id = ?
    LIMIT 1
  `).bind(userId).first<UserRow>()
  if (!user) throw new AppMembershipError(404, 'ACCOUNT_NOT_FOUND', '目标账号不存在')
  if (user.status !== 'active' || user.security_status !== 'active') {
    throw new AppMembershipError(409, 'ACCOUNT_RESTRICTED', '目标账号当前不可发放会员')
  }
  return user
}

export async function getAdminAppMembershipGrantById(
  db: D1Database,
  grantId: string,
): Promise<AdminAppMembershipGrantView> {
  const grant = await db.prepare(`
    SELECT g.id, g.user_id, g.catalog_version_id, g.tier_id, g.tier_code_snapshot,
           g.tier_name_snapshot, g.rank_snapshot, g.starts_at, g.expires_at,
           g.source_type, g.reason_code, g.user_visible_note, g.business_reference,
           g.granted_by, g.created_at, r.revoked_at, r.reason_code AS revoke_reason_code
    FROM app_membership_grants g
    LEFT JOIN app_membership_grant_revocations r ON r.grant_id = g.id
    WHERE g.id = ?
    LIMIT 1
  `).bind(grantId).first<GrantRow>()
  if (!grant) throw new AppMembershipError(404, 'MEMBERSHIP_GRANT_NOT_FOUND', '会员发放记录不存在')
  return toGrantView(grant)
}

export async function resolveAdminAppMembershipGrantReviewRequirement(
  db: D1Database,
  input: { rank: number; durationDays: number; isLowerThanCurrent: boolean },
): Promise<AdminAppMembershipReviewRequirement> {
  const policy = await getPublishedReviewPolicy(db)
  if (!policy || policy.risk_decision_status !== 'approved') return conservativeReviewRequirement()
  if (policy.review_mode === 'review_all') {
    return {
      required: true,
      policyId: policy.id,
      policyVersionCode: policy.version_code,
      mode: 'review_all',
      riskCodes: ['POLICY_REVIEW_ALL'],
    }
  }
  if (policy.review_mode !== 'risk_based') return conservativeReviewRequirement()

  const riskCodes: AdminAppMembershipReviewRiskCode[] = []
  if (policy.grant_rank_threshold !== null && input.rank >= Number(policy.grant_rank_threshold)) {
    riskCodes.push('RANK_THRESHOLD')
  }
  if (
    policy.grant_duration_days_threshold !== null
    && input.durationDays >= Number(policy.grant_duration_days_threshold)
  ) {
    riskCodes.push('DURATION_THRESHOLD')
  }
  if (Number(policy.review_lower_rank_grant) === 1 && input.isLowerThanCurrent) {
    riskCodes.push('LOWER_THAN_CURRENT_TIER')
  }
  return {
    required: riskCodes.length > 0,
    policyId: policy.id,
    policyVersionCode: policy.version_code,
    mode: 'risk_based',
    riskCodes,
  }
}

export async function resolveAdminAppMembershipRevokeReviewRequirement(
  db: D1Database,
): Promise<AdminAppMembershipReviewRequirement> {
  const policy = await getPublishedReviewPolicy(db)
  if (!policy || policy.risk_decision_status !== 'approved') return conservativeReviewRequirement()
  if (policy.review_mode === 'review_all') {
    return {
      required: true,
      policyId: policy.id,
      policyVersionCode: policy.version_code,
      mode: 'review_all',
      riskCodes: ['POLICY_REVIEW_ALL', 'REVOCATION'],
    }
  }
  if (policy.review_mode !== 'risk_based') return conservativeReviewRequirement()
  const required = Number(policy.review_revocation) === 1
  return {
    required,
    policyId: policy.id,
    policyVersionCode: policy.version_code,
    mode: 'risk_based',
    riskCodes: required ? ['REVOCATION'] : [],
  }
}

async function getPublishedReviewPolicy(db: D1Database): Promise<ReviewPolicyRow | null> {
  return db.prepare(`
    SELECT id, version_code, risk_decision_status, review_mode,
           grant_rank_threshold, grant_duration_days_threshold,
           review_lower_rank_grant, review_revocation
    FROM app_membership_review_policies
    WHERE state = 'published'
    ORDER BY published_at DESC, id DESC
    LIMIT 1
  `).first<ReviewPolicyRow>()
}

function conservativeReviewRequirement(): AdminAppMembershipReviewRequirement {
  return {
    required: true,
    policyId: null,
    policyVersionCode: 'unconfigured-v1',
    mode: 'conservative_review_all',
    riskCodes: ['POLICY_UNRESOLVED_ALL_REVIEW'],
  }
}

async function findAdminRequest(db: D1Database, idempotencyKey: string): Promise<AdminRequestRow | null> {
  return db.prepare(`
    SELECT operation, request_hash, target_user_id, grant_id
    FROM app_membership_admin_requests
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(idempotencyKey).first<AdminRequestRow>()
}

async function findGrantByBusinessReference(
  db: D1Database,
  userId: number,
  businessReference: string,
): Promise<{ id: string } | null> {
  return db.prepare(`
    SELECT id
    FROM app_membership_grants
    WHERE user_id = ? AND business_reference = ?
    LIMIT 1
  `).bind(userId, businessReference).first<{ id: string }>()
}

function businessReferenceConflict(): AppMembershipError {
  return new AppMembershipError(
    409,
    'MEMBERSHIP_BUSINESS_REFERENCE_CONFLICT',
    '该账号已使用此业务单号完成会员操作，请核对原记录',
  )
}

async function resolveExistingRequest(
  db: D1Database,
  request: AdminRequestRow,
  expectedHash: string,
  operation: 'grant' | 'revoke',
  userId: number,
): Promise<AdminAppMembershipGrantResult> {
  if (
    request.request_hash !== expectedHash
    || request.operation !== operation
    || Number(request.target_user_id) !== userId
  ) {
    throw new AppMembershipError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被其他会员操作使用')
  }
  return { ...(await getAdminAppMembershipGrantById(db, request.grant_id)), replayed: true }
}

export function normalizeAdminAppMembershipGrantInput(
  body: AdminAppMembershipGrantInput,
): NormalizedAdminAppMembershipGrantInput {
  const userId = Number(body.userId)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppMembershipError(400, 'ACCOUNT_ID_INVALID', 'userId 必须为正整数')
  }
  const tierId = normalizeRequiredString(body.tierId, 'tierId', 80)
  if (!/^amt_[A-Za-z0-9_-]{1,76}$/u.test(tierId)) {
    throw new AppMembershipError(400, 'MEMBERSHIP_TIER_INVALID', 'tierId 格式无效')
  }
  if (body.action !== 'grant' && body.action !== 'renew') {
    throw new AppMembershipError(400, 'MEMBERSHIP_ACTION_INVALID', 'action 必须为 grant 或 renew')
  }
  const durationDays = Number(body.durationDays)
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 366) {
    throw new AppMembershipError(400, 'MEMBERSHIP_DURATION_INVALID', 'durationDays 必须为 1–366 的整数')
  }
  if (!isGrantReason(body.reasonCode)) {
    throw new AppMembershipError(400, 'MEMBERSHIP_REASON_INVALID', '会员发放原因无效')
  }
  const startsAtInput = body.startsAt === undefined || body.startsAt === null || body.startsAt === ''
    ? null
    : normalizeRequiredString(body.startsAt, 'startsAt', 64)
  if (startsAtInput) parseIsoDate(startsAtInput, '开始时间')
  return {
    userId,
    tierId,
    action: body.action,
    startsAtInput,
    durationDays,
    reasonCode: body.reasonCode,
    userVisibleNote: normalizeRequiredString(body.userVisibleNote, '用户可见说明', 240),
    internalNote: normalizeOptionalString(body.internalNote, 1000),
    businessReference: normalizeRequiredString(body.businessReference, '业务单号', 100, 3),
  }
}

export function normalizeAdminAppMembershipRevokeInput(
  body: AdminAppMembershipRevokeInput,
): NormalizedAdminAppMembershipRevokeInput {
  if (!isRevokeReason(body.reasonCode)) {
    throw new AppMembershipError(400, 'MEMBERSHIP_REASON_INVALID', '会员撤销原因无效')
  }
  return {
    reasonCode: body.reasonCode,
    userVisibleNote: normalizeRequiredString(body.userVisibleNote, '用户可见说明', 240),
    internalNote: normalizeOptionalString(body.internalNote, 1000),
    businessReference: normalizeRequiredString(body.businessReference, '业务单号', 100, 3),
  }
}

function normalizeIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length < 16 || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
    throw new AppMembershipError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 必须为 16–128 位安全字符')
  }
  return normalized
}

function normalizeRequiredString(value: unknown, label: string, maxLength: number, minLength = 1): string {
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'MEMBERSHIP_INPUT_INVALID', `${label}为必填`)
  }
  const normalized = value.trim()
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new AppMembershipError(400, 'MEMBERSHIP_INPUT_INVALID', `${label}长度必须为 ${minLength}–${maxLength}`)
  }
  return normalized
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'MEMBERSHIP_INPUT_INVALID', '内部备注格式无效')
  }
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > maxLength) {
    throw new AppMembershipError(400, 'MEMBERSHIP_INPUT_INVALID', `内部备注不能超过 ${maxLength} 个字符`)
  }
  return normalized
}

function parseIsoDate(value: string, label: string): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new AppMembershipError(400, 'MEMBERSHIP_DATE_INVALID', `${label}格式无效`)
  }
  return parsed
}

function tierSummary(tier: AppMembershipTier) {
  return {
    tierId: tier.tierId,
    code: tier.code,
    displayName: tier.displayName,
    rank: tier.rank,
    accentToken: tier.accentToken,
  }
}

function toGrantView(row: GrantRow): AdminAppMembershipGrantView {
  if (row.source_type !== 'manual_admin' || !isGrantReason(row.reason_code)) {
    throw new AppMembershipError(503, 'MEMBERSHIP_GRANT_INVALID', '会员发放记录异常')
  }
  const revokeReason = row.revoke_reason_code
  if (revokeReason !== null && !isRevokeReason(revokeReason)) {
    throw new AppMembershipError(503, 'MEMBERSHIP_GRANT_INVALID', '会员撤销记录异常')
  }
  return {
    grantId: row.id,
    userId: Number(row.user_id),
    catalogVersionId: row.catalog_version_id,
    tierId: row.tier_id,
    tierCode: row.tier_code_snapshot,
    tierName: row.tier_name_snapshot,
    rank: Number(row.rank_snapshot),
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    sourceType: 'manual_admin',
    reasonCode: row.reason_code,
    userVisibleNote: row.user_visible_note,
    businessReference: row.business_reference,
    grantedBy: Number(row.granted_by),
    createdAt: row.created_at,
    revoked: row.revoked_at !== null,
    revokedAt: row.revoked_at,
    revokeReasonCode: revokeReason,
  }
}

function maskEmail(email: string): string {
  const separator = email.lastIndexOf('@')
  if (separator <= 0) return '***'
  const local = email.slice(0, separator)
  const domain = email.slice(separator)
  return `${local.slice(0, Math.min(2, local.length))}***${domain}`
}

function isGrantReason(value: unknown): value is AppMembershipGrantReason {
  return value === 'manual_review'
    || value === 'customer_support'
    || value === 'promotion'
    || value === 'compensation'
}

function isRevokeReason(value: unknown): value is AppMembershipRevokeReason {
  return value === 'admin_correction'
    || value === 'customer_request'
    || value === 'account_restriction'
    || value === 'policy_enforcement'
}

function secureId(prefix: 'amg' | 'amr' | 'audit'): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
