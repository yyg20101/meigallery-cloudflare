import { generateId } from '../utils/db'

export const PERSON_VERIFICATION_ITEMS = [
  'identity_existence',
  'authorization_agency',
  'profile_consistency',
  'media_rights',
] as const

type VerificationItem = typeof PERSON_VERIFICATION_ITEMS[number]
type RegionPrecision = 'city' | 'province' | 'country' | 'broad'

type ProfileRow = {
  person_id: string
  lifecycle_status: string
  profile_id: string
  source_gallery_id: string
  gallery_title: string
  gallery_status: string
  cover_key: string | null
  display_name: string
  summary: string | null
  tags_json: string
  operation_mode: string
  operation_label: string
  region_code: string | null
  region_label: string | null
  region_precision: string | null
  recommendation_score: number
  heat_score: number
  recommendation_reason_code: string
  verification_status: string
  publication_status: string
  safety_status: string
  content_version: number
  live_content_version: number | null
  lock_version: number
  created_at: string
  updated_at: string
  projection_visibility_status: string | null
  projection_publication_status: string | null
  projection_version: number | null
  projection_profile_version: number | null
  projection_authorization_id: string | null
  projection_verification_id: string | null
  projection_publication_id: string | null
}

type AuthorizationRow = {
  id: string
  profile_id: string
  profile_version: number
  status: string
  evidence_ref: string
  valid_from: string
  valid_until: string | null
  reason_code: string | null
  note: string | null
  created_by: number
  reviewed_by: number
  revoked_by: number | null
  created_at: string
  reviewed_at: string
  revoked_at: string | null
}

type VerificationRow = {
  id: string
  profile_id: string
  profile_version: number
  status: string
  evidence_ref: string
  verification_items_json: string
  policy_version: string
  valid_until: string | null
  reason_code: string | null
  note: string | null
  submitted_by: number
  reviewed_by: number | null
  submitted_at: string
  reviewed_at: string | null
  revoked_by: number | null
  revoked_at: string | null
}

type PublicationRow = {
  id: string
  profile_id: string
  profile_version: number
  status: string
  reason_code: string | null
  note: string | null
  projection_version: number | null
  submitted_by: number
  reviewed_by: number | null
  submitted_at: string
  reviewed_at: string | null
}

export type PersonWorkflowGate = {
  code: string
  label: string
  passed: boolean
  detail: string
}

export class PersonSupplyError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

export type PersonProfileInput = {
  sourceGalleryId: unknown
  displayName: unknown
  summary?: unknown
  tags?: unknown
  regionCode?: unknown
  regionLabel?: unknown
  regionPrecision?: unknown
  recommendationScore?: unknown
  heatScore?: unknown
  recommendationReasonCode?: unknown
}

export type UpdatePersonProfileInput = PersonProfileInput & { expectedVersion: unknown }

export type GrantAuthorizationInput = {
  expectedVersion: unknown
  evidenceRef: unknown
  validFrom?: unknown
  validUntil?: unknown
  reasonCode?: unknown
  note?: unknown
}

export type SubmitVerificationInput = {
  expectedVersion: unknown
  evidenceRef: unknown
  note?: unknown
}

export type ReviewVerificationInput = {
  expectedVersion: unknown
  verificationId: unknown
  decision: unknown
  verificationItems?: unknown
  validUntil?: unknown
  reasonCode?: unknown
  note?: unknown
}

export type SubmitPublicationInput = {
  expectedVersion: unknown
  note?: unknown
}

export type ReviewPublicationInput = {
  expectedVersion: unknown
  publicationId: unknown
  decision: unknown
  reasonCode?: unknown
  note?: unknown
}

export type RevokeWorkflowRecordInput = {
  expectedVersion: unknown
  recordId: unknown
  reasonCode: unknown
  note?: unknown
}

export type PausePublicationInput = {
  expectedVersion: unknown
  reasonCode: unknown
  note?: unknown
}

export async function listAdminPersons(
  db: D1Database,
  input: { page?: string; pageSize?: string; q?: string; publicationStatus?: string },
) {
  const page = positiveInteger(input.page, 1, 10_000)
  const pageSize = positiveInteger(input.pageSize, 20, 50)
  const q = optionalText(input.q, 80)
  const publicationStatus = optionalEnum(input.publicationStatus, [
    'draft',
    'pending_review',
    'published',
    'suspended',
    'archived',
  ])
  const conditions: string[] = []
  const params: unknown[] = []
  if (q) {
    conditions.push('(p.display_name LIKE ? ESCAPE \'\\\' OR p.id LIKE ? ESCAPE \'\\\' OR p.person_id LIKE ? ESCAPE \'\\\')')
    const like = `%${escapeLike(q)}%`
    params.push(like, like, like)
  }
  if (publicationStatus) {
    conditions.push('p.publication_status = ?')
    params.push(publicationStatus)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM person_profiles p ${where}`)
    .bind(...params)
    .first<{ count: number }>()
  const rows = await db.prepare(`
    SELECT ${PROFILE_SELECT}
    FROM person_profiles p
    JOIN persons pe ON pe.id = p.person_id
    JOIN galleries g ON g.id = p.source_gallery_id
    LEFT JOIN profile_public_projections proj ON proj.profile_id = p.id
    ${where}
    ORDER BY p.updated_at DESC, p.id ASC
    LIMIT ? OFFSET ?
  `).bind(...params, pageSize, (page - 1) * pageSize).all<ProfileRow>()

  const profileIds = rows.results.map(row => row.profile_id)
  const [authorizationByProfile, verificationByProfile] = await Promise.all([
    listLatestAuthorizations(db, profileIds),
    listLatestVerifications(db, profileIds),
  ])
  const data = rows.results.map(row => mapListItem(
    row,
    authorizationByProfile.get(row.profile_id) ?? null,
    verificationByProfile.get(row.profile_id) ?? null,
  ))
  const total = Number(count?.count ?? 0)
  return {
    data,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

export async function getAdminPersonDetail(db: D1Database, personId: string, now = new Date()) {
  const row = await getProfileRow(db, personId)
  if (!row) throw new PersonSupplyError(404, 'PERSON_NOT_FOUND', '人物候选不存在')

  const [authorization, verification, authorizations, verifications, publications] = await Promise.all([
    getLatestAuthorization(db, row.profile_id, row.content_version),
    getLatestVerification(db, row.profile_id, row.content_version),
    db.prepare(`${AUTHORIZATION_SELECT} WHERE profile_id = ? ORDER BY created_at DESC LIMIT 20`)
      .bind(row.profile_id).all<AuthorizationRow>(),
    db.prepare(`${VERIFICATION_SELECT} WHERE profile_id = ? ORDER BY submitted_at DESC LIMIT 20`)
      .bind(row.profile_id).all<VerificationRow>(),
    db.prepare(`${PUBLICATION_SELECT} WHERE profile_id = ? ORDER BY submitted_at DESC LIMIT 20`)
      .bind(row.profile_id).all<PublicationRow>(),
  ])
  const gates = buildPublicationGates(row, authorization, verification, now)

  return {
    personId: row.person_id,
    profileId: row.profile_id,
    lifecycleStatus: row.lifecycle_status,
    sourceGallery: {
      id: row.source_gallery_id,
      title: row.gallery_title,
      status: row.gallery_status,
      hasCover: Boolean(row.cover_key),
    },
    displayName: row.display_name,
    summary: row.summary,
    tags: parseStringArray(row.tags_json),
    operation: { mode: row.operation_mode, label: row.operation_label },
    region: row.region_code && row.region_label && row.region_precision
      ? { code: row.region_code, label: row.region_label, precision: row.region_precision }
      : null,
    recommendation: {
      score: row.recommendation_score,
      heatScore: row.heat_score,
      reasonCode: row.recommendation_reason_code,
    },
    verificationStatus: effectiveVerificationStatus(verification, now),
    publicationStatus: row.publication_status,
    authorizationStatus: effectiveAuthorizationStatus(authorization, now),
    safetyStatus: row.safety_status,
    contentVersion: row.content_version,
    liveContentVersion: row.live_content_version,
    lockVersion: row.lock_version,
    liveProjection: row.projection_version
      ? {
          visible: row.projection_publication_status === 'published' && row.projection_visibility_status === 'visible',
          publicationStatus: row.projection_publication_status,
          visibilityStatus: row.projection_visibility_status,
          projectionVersion: row.projection_version,
          profileVersion: row.projection_profile_version,
          authorizationId: row.projection_authorization_id,
          verificationId: row.projection_verification_id,
          publicationId: row.projection_publication_id,
        }
      : null,
    gates,
    currentAuthorization: authorization ? mapAuthorization(authorization, now) : null,
    currentVerification: verification ? mapVerification(verification, now) : null,
    history: {
      authorizations: authorizations.results.map(item => mapAuthorization(item, now)),
      verifications: verifications.results.map(item => mapVerification(item, now)),
      publications: publications.results.map(mapPublication),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createPersonCandidate(
  db: D1Database,
  input: PersonProfileInput,
  adminId: number,
) {
  const profile = normalizeProfileInput(input)
  await assertGalleryAvailable(db, profile.sourceGalleryId)
  await assertGalleryNotAssigned(db, profile.sourceGalleryId)

  const personId = generateId('per')
  const profileId = generateId('pp')
  const auditId = generateId('log')
  const now = new Date().toISOString()
  await db.batch([
    db.prepare(`
      INSERT INTO persons (id, lifecycle_status, created_by, created_at, updated_at)
      VALUES (?, 'active', ?, ?, ?)
    `).bind(personId, adminId, now, now),
    db.prepare(`
      INSERT INTO person_profiles (
        id, person_id, source_gallery_id, display_name, summary, tags_json,
        operation_mode, operation_label, region_code, region_label, region_precision,
        recommendation_score, heat_score, recommendation_reason_code,
        verification_status, publication_status, safety_status,
        content_version, lock_version, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'platform_managed', '消息由平台运营接收', ?, ?, ?, ?, ?, ?,
        'unverified', 'draft', 'clear', 1, 1, ?, ?, ?, ?)
    `).bind(
      profileId,
      personId,
      profile.sourceGalleryId,
      profile.displayName,
      profile.summary,
      JSON.stringify(profile.tags),
      profile.regionCode,
      profile.regionLabel,
      profile.regionPrecision,
      profile.recommendationScore,
      profile.heatScore,
      profile.recommendationReasonCode,
      adminId,
      adminId,
      now,
      now,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_type, target_id, after_value, created_at)
      VALUES (?, ?, 'app_person.create', 'person_profile', ?, ?, ?)
    `).bind(auditId, adminId, profileId, JSON.stringify({
      personId,
      profileId,
      sourceGalleryId: profile.sourceGalleryId,
      displayName: profile.displayName,
      contentVersion: 1,
      publicationStatus: 'draft',
    }), now),
  ])
  return getAdminPersonDetail(db, personId)
}

export async function updatePersonCandidate(
  db: D1Database,
  personId: string,
  input: UpdatePersonProfileInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  if (current.publication_status === 'archived') {
    throw new PersonSupplyError(409, 'PERSON_ARCHIVED', '已归档人物不能继续编辑')
  }
  const profile = normalizeProfileInput(input)
  await assertGalleryAvailable(db, profile.sourceGalleryId)
  await assertGalleryNotAssigned(db, profile.sourceGalleryId, current.profile_id)

  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const nextContentVersion = current.content_version + 1
  const before = profileAuditSnapshot(current)
  const after = {
    sourceGalleryId: profile.sourceGalleryId,
    displayName: profile.displayName,
    contentVersion: nextContentVersion,
    verificationStatus: 'unverified',
    publicationStatus: 'draft',
    liveProjectionUnchanged: Boolean(current.projection_version),
  }
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET source_gallery_id = ?, display_name = ?, summary = ?, tags_json = ?,
          region_code = ?, region_label = ?, region_precision = ?,
          recommendation_score = ?, heat_score = ?, recommendation_reason_code = ?,
          verification_status = 'unverified', publication_status = 'draft',
          content_version = content_version + 1, lock_version = lock_version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ? AND publication_status <> 'archived'
    `).bind(
      profile.sourceGalleryId,
      profile.displayName,
      profile.summary,
      JSON.stringify(profile.tags),
      profile.regionCode,
      profile.regionLabel,
      profile.regionPrecision,
      profile.recommendationScore,
      profile.heatScore,
      profile.recommendationReasonCode,
      token,
      adminId,
      now,
      current.profile_id,
      expectedVersion,
    ),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.update',
      profileId: current.profile_id,
      token,
      before,
      after,
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, personId)
}

export async function grantPersonAuthorization(
  db: D1Database,
  personId: string,
  input: GrantAuthorizationInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  const evidenceRef = requiredText(input.evidenceRef, '授权证据引用', 500)
  const now = new Date().toISOString()
  const validFrom = dateText(input.validFrom, '授权开始时间') ?? now
  const validUntil = dateText(input.validUntil, '授权结束时间')
  if (validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw new PersonSupplyError(400, 'INVALID_AUTHORIZATION_PERIOD', '授权结束时间必须晚于开始时间')
  }
  const reasonCode = optionalCode(input.reasonCode) ?? 'ADMIN_CONFIRMED'
  const note = optionalText(input.note, 500)
  const authorizationId = generateId('paut')
  const token = crypto.randomUUID()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET publication_status = CASE
            WHEN live_content_version = content_version THEN 'suspended'
            ELSE publication_status
          END,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ? AND publication_status <> 'archived'
    `).bind(token, adminId, now, current.profile_id, expectedVersion),
    db.prepare(`
      UPDATE person_authorizations
      SET status = 'revoked', revoked_by = ?, revoked_at = ?, reason_code = 'REPLACED'
      WHERE profile_id = ? AND profile_version = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(adminId, now, current.profile_id, current.content_version, current.profile_id, token),
    db.prepare(`
      INSERT INTO person_authorizations (
        id, profile_id, profile_version, purpose, status, evidence_ref,
        valid_from, valid_until, reason_code, note,
        created_by, reviewed_by, created_at, reviewed_at
      )
      SELECT ?, id, content_version, 'app_public_display', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM person_profiles WHERE id = ? AND mutation_token = ?
    `).bind(
      authorizationId,
      evidenceRef,
      validFrom,
      validUntil,
      reasonCode,
      note,
      adminId,
      adminId,
      now,
      now,
      current.profile_id,
      token,
    ),
    suspendProjectionForClaim(db, current.profile_id, token, {
      authorizationStatus: 'revoked',
      now,
    }),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.authorization_grant',
      profileId: current.profile_id,
      token,
      after: {
        authorizationId,
        profileVersion: current.content_version,
        validFrom,
        validUntil,
        reasonCode,
        evidenceRecorded: true,
      },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, personId)
}

export async function submitPersonVerification(
  db: D1Database,
  personId: string,
  input: SubmitVerificationInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  const latest = await getLatestVerification(db, current.profile_id, current.content_version)
  const latestStatus = effectiveVerificationStatus(latest, new Date())
  if (latestStatus === 'pending') {
    throw new PersonSupplyError(409, 'VERIFICATION_ALREADY_PENDING', '当前内容版本已提交认证复核')
  }
  if (latestStatus === 'verified') {
    throw new PersonSupplyError(409, 'VERIFICATION_ALREADY_VALID', '当前内容版本已有有效认证；如需重审请先撤销认证')
  }
  const evidenceRef = requiredText(input.evidenceRef, '认证证据引用', 500)
  const note = optionalText(input.note, 500)
  const verificationId = generateId('pver')
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET verification_status = 'pending',
          publication_status = CASE
            WHEN live_content_version = content_version THEN 'suspended'
            ELSE publication_status
          END,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ? AND publication_status <> 'archived'
    `).bind(token, adminId, now, current.profile_id, expectedVersion),
    db.prepare(`
      INSERT INTO person_verifications (
        id, profile_id, profile_version, status, evidence_ref,
        verification_items_json, policy_version, note, submitted_by, submitted_at
      )
      SELECT ?, id, content_version, 'pending', ?, '[]', 'person_verification_v1', ?, ?, ?
      FROM person_profiles WHERE id = ? AND mutation_token = ?
    `).bind(verificationId, evidenceRef, note, adminId, now, current.profile_id, token),
    suspendProjectionForClaim(db, current.profile_id, token, {
      verificationStatus: 'suspended',
      now,
    }),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.verification_submit',
      profileId: current.profile_id,
      token,
      after: {
        verificationId,
        profileVersion: current.content_version,
        evidenceRecorded: true,
        policyVersion: 'person_verification_v1',
      },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, personId)
}

export async function reviewPersonVerification(
  db: D1Database,
  personId: string,
  input: ReviewVerificationInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  const verificationId = requiredId(input.verificationId, 'pver_', '认证记录 ID')
  const pending = await db.prepare(`${VERIFICATION_SELECT} WHERE id = ? AND profile_id = ? LIMIT 1`)
    .bind(verificationId, current.profile_id).first<VerificationRow>()
  if (!pending || pending.profile_version !== current.content_version || pending.status !== 'pending') {
    throw new PersonSupplyError(409, 'VERIFICATION_NOT_PENDING', '认证记录不存在、已处理或不属于当前内容版本')
  }
  const decision = requiredEnum(input.decision, ['verified', 'rejected'], '认证决定')
  const items = decision === 'verified' ? normalizeVerificationItems(input.verificationItems) : []
  const validUntil = dateText(input.validUntil, '认证有效期')
  if (validUntil && Date.parse(validUntil) <= Date.now()) {
    throw new PersonSupplyError(400, 'INVALID_VERIFICATION_EXPIRY', '认证有效期必须晚于当前时间')
  }
  const reasonCode = optionalCode(input.reasonCode)
    ?? (decision === 'verified' ? 'VERIFICATION_PASSED' : 'VERIFICATION_REJECTED')
  const note = optionalText(input.note, 500)
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET verification_status = ?, lock_version = lock_version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ? AND content_version = ?
        AND verification_status = 'pending'
    `).bind(decision, token, adminId, now, current.profile_id, expectedVersion, current.content_version),
    db.prepare(`
      UPDATE person_verifications
      SET status = 'expired', reason_code = 'SUPERSEDED_AFTER_EXPIRY',
          reviewed_by = ?, reviewed_at = ?
      WHERE profile_id = ? AND profile_version = ? AND id <> ? AND status = 'verified'
        AND valid_until IS NOT NULL AND datetime(valid_until) <= datetime(?)
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(
      adminId,
      now,
      current.profile_id,
      current.content_version,
      verificationId,
      now,
      current.profile_id,
      token,
    ),
    db.prepare(`
      UPDATE person_verifications
      SET status = ?, verification_items_json = ?, valid_until = ?, reason_code = ?, note = ?,
          reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND profile_id = ? AND profile_version = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(
      decision,
      JSON.stringify(items),
      validUntil,
      reasonCode,
      note,
      adminId,
      now,
      verificationId,
      current.profile_id,
      current.content_version,
      current.profile_id,
      token,
    ),
    auditForClaimedProfile(db, {
      adminId,
      action: decision === 'verified' ? 'app_person.verification_approve' : 'app_person.verification_reject',
      profileId: current.profile_id,
      token,
      after: { verificationId, decision, items, validUntil, reasonCode },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, personId)
}

export async function submitPersonPublication(
  db: D1Database,
  personId: string,
  input: SubmitPublicationInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  const [authorization, verification, pending] = await Promise.all([
    getLatestAuthorization(db, current.profile_id, current.content_version),
    getLatestVerification(db, current.profile_id, current.content_version),
    getPendingPublication(db, current.profile_id, current.content_version),
  ])
  if (pending) {
    throw new PersonSupplyError(409, 'PUBLICATION_ALREADY_PENDING', '当前内容版本已提交发布复核')
  }
  const gates = buildPublicationGates(current, authorization, verification, new Date())
  const blockers = gates.filter(gate => !gate.passed)
  if (blockers.length) {
    throw new PersonSupplyError(422, 'PUBLICATION_GATES_FAILED', '发布门禁未全部通过', { gates })
  }
  const publicationId = generateId('ppub')
  const note = optionalText(input.note, 500)
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET publication_status = 'pending_review', lock_version = lock_version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ? AND content_version = ?
        AND publication_status <> 'archived'
    `).bind(token, adminId, now, current.profile_id, expectedVersion, current.content_version),
    db.prepare(`
      INSERT INTO person_publication_reviews (
        id, profile_id, profile_version, status, note, submitted_by, submitted_at
      )
      SELECT ?, id, content_version, 'pending_review', ?, ?, ?
      FROM person_profiles WHERE id = ? AND mutation_token = ?
    `).bind(publicationId, note, adminId, now, current.profile_id, token),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.publication_submit',
      profileId: current.profile_id,
      token,
      after: { publicationId, profileVersion: current.content_version, gates },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, personId)
}

export async function reviewPersonPublication(
  db: D1Database,
  personId: string,
  input: ReviewPublicationInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  const publicationId = requiredId(input.publicationId, 'ppub_', '发布复核 ID')
  const pending = await db.prepare(`${PUBLICATION_SELECT} WHERE id = ? AND profile_id = ? LIMIT 1`)
    .bind(publicationId, current.profile_id).first<PublicationRow>()
  if (!pending || pending.profile_version !== current.content_version || pending.status !== 'pending_review') {
    throw new PersonSupplyError(409, 'PUBLICATION_NOT_PENDING', '发布复核记录不存在、已处理或不属于当前内容版本')
  }
  const decision = requiredEnum(input.decision, ['published', 'rejected'], '发布决定')
  const reasonCode = optionalCode(input.reasonCode)
    ?? (decision === 'published' ? 'PUBLICATION_APPROVED' : 'PUBLICATION_REJECTED')
  const note = optionalText(input.note, 500)
  if (decision === 'rejected') {
    return rejectPublication(db, current, pending, expectedVersion, reasonCode, note, adminId)
  }
  return publishProjection(db, current, pending, expectedVersion, reasonCode, note, adminId)
}

export async function pausePersonPublication(
  db: D1Database,
  personId: string,
  input: PausePublicationInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  if (!current.projection_version) {
    throw new PersonSupplyError(409, 'NO_LIVE_PROJECTION', '当前人物没有可暂停的公开投影')
  }
  const reasonCode = requiredCode(input.reasonCode, '暂停原因码')
  const note = optionalText(input.note, 500)
  const publicationId = generateId('ppub')
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET publication_status = 'suspended', lock_version = lock_version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ? AND publication_status <> 'archived'
    `).bind(token, adminId, now, current.profile_id, expectedVersion),
    db.prepare(`
      UPDATE profile_public_projections
      SET publication_status = 'unpublished', visibility_status = 'suspended', updated_at = ?
      WHERE profile_id = ?
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(now, current.profile_id, current.profile_id, token),
    db.prepare(`
      INSERT INTO person_publication_reviews (
        id, profile_id, profile_version, status, reason_code, note,
        submitted_by, reviewed_by, submitted_at, reviewed_at
      )
      SELECT ?, id, COALESCE(live_content_version, content_version), 'suspended', ?, ?, ?, ?, ?, ?
      FROM person_profiles WHERE id = ? AND mutation_token = ?
    `).bind(
      publicationId,
      reasonCode,
      note,
      adminId,
      adminId,
      now,
      now,
      current.profile_id,
      token,
    ),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.publication_pause',
      profileId: current.profile_id,
      token,
      before: { projectionVersion: current.projection_version, visible: true },
      after: { publicationId, visible: false, reasonCode },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, personId)
}

export async function revokePersonAuthorization(
  db: D1Database,
  personId: string,
  input: RevokeWorkflowRecordInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  const authorizationId = requiredId(input.recordId, 'paut_', '授权记录 ID')
  const authorization = await db.prepare(`${AUTHORIZATION_SELECT} WHERE id = ? AND profile_id = ? LIMIT 1`)
    .bind(authorizationId, current.profile_id).first<AuthorizationRow>()
  if (!authorization || authorization.status !== 'active') {
    throw new PersonSupplyError(409, 'AUTHORIZATION_NOT_ACTIVE', '授权记录不存在或已失效')
  }
  const reasonCode = requiredCode(input.reasonCode, '撤销原因码')
  const note = optionalText(input.note, 500)
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET publication_status = CASE
            WHEN EXISTS (
              SELECT 1 FROM profile_public_projections
              WHERE profile_id = person_profiles.id AND authorization_id = ?
            ) THEN 'suspended'
            ELSE publication_status
          END,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ?
    `).bind(authorizationId, token, adminId, now, current.profile_id, expectedVersion),
    db.prepare(`
      UPDATE person_authorizations
      SET status = 'revoked', reason_code = ?, note = ?, revoked_by = ?, revoked_at = ?
      WHERE id = ? AND profile_id = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(reasonCode, note, adminId, now, authorizationId, current.profile_id, current.profile_id, token),
    db.prepare(`
      UPDATE profile_public_projections
      SET authorization_status = 'revoked', visibility_status = 'suspended',
          publication_status = 'unpublished', updated_at = ?
      WHERE profile_id = ? AND authorization_id = ?
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(now, current.profile_id, authorizationId, current.profile_id, token),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.authorization_revoke',
      profileId: current.profile_id,
      token,
      before: { authorizationId, status: 'active' },
      after: { authorizationId, status: 'revoked', reasonCode },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, personId)
}

export async function revokePersonVerification(
  db: D1Database,
  personId: string,
  input: RevokeWorkflowRecordInput,
  adminId: number,
) {
  const current = await requireProfileRow(db, personId)
  const expectedVersion = expectedLockVersion(input.expectedVersion)
  assertExpectedVersion(current, expectedVersion)
  const verificationId = requiredId(input.recordId, 'pver_', '认证记录 ID')
  const verification = await db.prepare(`${VERIFICATION_SELECT} WHERE id = ? AND profile_id = ? LIMIT 1`)
    .bind(verificationId, current.profile_id).first<VerificationRow>()
  if (!verification || verification.status !== 'verified') {
    throw new PersonSupplyError(409, 'VERIFICATION_NOT_ACTIVE', '认证记录不存在或已失效')
  }
  const reasonCode = requiredCode(input.reasonCode, '撤销原因码')
  const note = optionalText(input.note, 500)
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET verification_status = CASE WHEN content_version = ? THEN 'revoked' ELSE verification_status END,
          publication_status = CASE
            WHEN EXISTS (
              SELECT 1 FROM profile_public_projections
              WHERE profile_id = person_profiles.id AND verification_id = ?
            ) THEN 'suspended'
            ELSE publication_status
          END,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ?
    `).bind(
      verification.profile_version,
      verificationId,
      token,
      adminId,
      now,
      current.profile_id,
      expectedVersion,
    ),
    db.prepare(`
      UPDATE person_verifications
      SET status = 'revoked', reason_code = ?, note = ?, revoked_by = ?, revoked_at = ?
      WHERE id = ? AND profile_id = ? AND status = 'verified'
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(reasonCode, note, adminId, now, verificationId, current.profile_id, current.profile_id, token),
    db.prepare(`
      UPDATE profile_public_projections
      SET verification_status = 'suspended', visibility_status = 'suspended',
          publication_status = 'unpublished', updated_at = ?
      WHERE profile_id = ? AND verification_id = ?
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(now, current.profile_id, verificationId, current.profile_id, token),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.verification_revoke',
      profileId: current.profile_id,
      token,
      before: { verificationId, status: 'verified' },
      after: { verificationId, status: 'revoked', reasonCode },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, personId)
}

async function rejectPublication(
  db: D1Database,
  current: ProfileRow,
  pending: PublicationRow,
  expectedVersion: number,
  reasonCode: string,
  note: string | null,
  adminId: number,
) {
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET publication_status = 'draft', lock_version = lock_version + 1,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ? AND content_version = ?
        AND publication_status = 'pending_review'
    `).bind(token, adminId, now, current.profile_id, expectedVersion, current.content_version),
    db.prepare(`
      UPDATE person_publication_reviews
      SET status = 'rejected', reason_code = ?, note = ?, reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending_review'
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(reasonCode, note, adminId, now, pending.id, current.profile_id, token),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.publication_reject',
      profileId: current.profile_id,
      token,
      after: { publicationId: pending.id, profileVersion: current.content_version, reasonCode },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version)
  return getAdminPersonDetail(db, current.person_id)
}

async function publishProjection(
  db: D1Database,
  current: ProfileRow,
  pending: PublicationRow,
  expectedVersion: number,
  reasonCode: string,
  note: string | null,
  adminId: number,
) {
  const [authorization, verification] = await Promise.all([
    getLatestAuthorization(db, current.profile_id, current.content_version),
    getLatestVerification(db, current.profile_id, current.content_version),
  ])
  const gates = buildPublicationGates(current, authorization, verification, new Date())
  if (!authorization || !verification || gates.some(gate => !gate.passed)) {
    throw new PersonSupplyError(422, 'PUBLICATION_GATES_FAILED', '发布门禁已变化，请刷新后重新复核', { gates })
  }
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  const results = await db.batch([
    db.prepare(`
      UPDATE person_profiles
      SET publication_status = 'published', live_content_version = content_version,
          lock_version = lock_version + 1, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lock_version = ? AND content_version = ?
        AND publication_status = 'pending_review' AND safety_status = 'clear'
        AND operation_mode = 'platform_managed'
        AND EXISTS (SELECT 1 FROM persons WHERE id = person_profiles.person_id AND lifecycle_status = 'active')
        AND EXISTS (SELECT 1 FROM galleries WHERE id = person_profiles.source_gallery_id AND status = 'published' AND cover_key IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM person_authorizations
          WHERE id = ? AND profile_id = person_profiles.id
            AND profile_version = person_profiles.content_version AND status = 'active'
            AND datetime(valid_from) <= datetime(?)
            AND (valid_until IS NULL OR datetime(valid_until) > datetime(?))
        )
        AND EXISTS (
          SELECT 1 FROM person_verifications
          WHERE id = ? AND profile_id = person_profiles.id
            AND profile_version = person_profiles.content_version AND status = 'verified'
            AND (valid_until IS NULL OR datetime(valid_until) > datetime(?))
        )
        AND EXISTS (
          SELECT 1 FROM person_publication_reviews
          WHERE id = ? AND profile_id = person_profiles.id
            AND profile_version = person_profiles.content_version AND status = 'pending_review'
        )
    `).bind(
      token,
      adminId,
      now,
      current.profile_id,
      expectedVersion,
      current.content_version,
      authorization.id,
      now,
      now,
      verification.id,
      now,
      pending.id,
    ),
    db.prepare(`
      UPDATE person_publication_reviews
      SET status = 'published', reason_code = ?, note = ?, reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending_review'
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(reasonCode, note, adminId, now, pending.id, current.profile_id, token),
    db.prepare(`
      INSERT INTO profile_public_projections (
        profile_id, person_id, display_name, summary, source_gallery_id, tags_json,
        verification_status, publication_status, authorization_status,
        authorization_valid_until, visibility_status, operation_mode, operation_label,
        region_code, region_label, region_precision, recommendation_score, heat_score,
        recommendation_reason_code, recommendation_rule_version, published_at,
        source_updated_at, projection_version, verification_valid_until,
        profile_version, authorization_id, verification_id, publication_id,
        authorization_valid_from, created_at, updated_at
      )
      SELECT
        p.id, p.person_id, p.display_name, p.summary, p.source_gallery_id, p.tags_json,
        'verified', 'published', 'active', a.valid_until, 'visible',
        p.operation_mode, p.operation_label, p.region_code, p.region_label, p.region_precision,
        p.recommendation_score, p.heat_score, p.recommendation_reason_code, 'discovery_v1',
        ?, ?, 1, v.valid_until, p.content_version, a.id, v.id, ?, a.valid_from, ?, ?
      FROM person_profiles p
      JOIN person_authorizations a ON a.id = ?
      JOIN person_verifications v ON v.id = ?
      WHERE p.id = ? AND p.mutation_token = ?
      ON CONFLICT(profile_id) DO UPDATE SET
        person_id = excluded.person_id,
        display_name = excluded.display_name,
        summary = excluded.summary,
        source_gallery_id = excluded.source_gallery_id,
        tags_json = excluded.tags_json,
        verification_status = excluded.verification_status,
        publication_status = excluded.publication_status,
        authorization_status = excluded.authorization_status,
        authorization_valid_until = excluded.authorization_valid_until,
        visibility_status = excluded.visibility_status,
        operation_mode = excluded.operation_mode,
        operation_label = excluded.operation_label,
        region_code = excluded.region_code,
        region_label = excluded.region_label,
        region_precision = excluded.region_precision,
        recommendation_score = excluded.recommendation_score,
        heat_score = excluded.heat_score,
        recommendation_reason_code = excluded.recommendation_reason_code,
        recommendation_rule_version = excluded.recommendation_rule_version,
        published_at = excluded.published_at,
        source_updated_at = excluded.source_updated_at,
        projection_version = profile_public_projections.projection_version + 1,
        verification_valid_until = excluded.verification_valid_until,
        profile_version = excluded.profile_version,
        authorization_id = excluded.authorization_id,
        verification_id = excluded.verification_id,
        publication_id = excluded.publication_id,
        authorization_valid_from = excluded.authorization_valid_from,
        updated_at = excluded.updated_at
    `).bind(
      now,
      now,
      pending.id,
      now,
      now,
      authorization.id,
      verification.id,
      current.profile_id,
      token,
    ),
    db.prepare(`
      UPDATE person_publication_reviews
      SET projection_version = (
        SELECT projection_version FROM profile_public_projections WHERE profile_id = ?
      )
      WHERE id = ?
        AND EXISTS (SELECT 1 FROM person_profiles WHERE id = ? AND mutation_token = ?)
    `).bind(current.profile_id, pending.id, current.profile_id, token),
    auditForClaimedProfile(db, {
      adminId,
      action: 'app_person.publication_publish',
      profileId: current.profile_id,
      token,
      after: {
        publicationId: pending.id,
        profileVersion: current.content_version,
        authorizationId: authorization.id,
        verificationId: verification.id,
        reasonCode,
      },
      now,
    }),
  ])
  assertClaimed(results, current.lock_version, '发布门禁已变化，请刷新后重新复核')
  return getAdminPersonDetail(db, current.person_id)
}

function buildPublicationGates(
  row: ProfileRow,
  authorization: AuthorizationRow | null,
  verification: VerificationRow | null,
  now: Date,
): PersonWorkflowGate[] {
  const authorizationStatus = effectiveAuthorizationStatus(authorization, now)
  const verificationStatus = effectiveVerificationStatus(verification, now)
  return [
    gate('PERSON_ACTIVE', '人物状态正常', row.lifecycle_status === 'active', `当前：${row.lifecycle_status}`),
    gate('PROFILE_COMPLETE', '公开资料完整', Boolean(row.display_name.trim()), '展示名不能为空'),
    gate('PLATFORM_MANAGED', '运营主体已披露', row.operation_mode === 'platform_managed', 'App 1.0 仅开放平台运营模式'),
    gate('SOURCE_GALLERY_PUBLISHED', '来源图库已发布', row.gallery_status === 'published', `当前：${row.gallery_status}`),
    gate('SOURCE_COVER_READY', '来源图库已有封面', Boolean(row.cover_key), row.cover_key ? '封面可用' : '缺少封面'),
    gate('SAFETY_CLEAR', '安全状态正常', row.safety_status === 'clear', `当前：${row.safety_status}`),
    gate('AUTHORIZATION_ACTIVE', '当前版本用途授权有效', authorizationStatus === 'active', `当前：${authorizationStatus}`),
    gate('VERIFICATION_VALID', '当前版本认证有效', verificationStatus === 'verified', `当前：${verificationStatus}`),
  ]
}

function gate(code: string, label: string, passed: boolean, detail: string): PersonWorkflowGate {
  return { code, label, passed, detail }
}

async function getProfileRow(db: D1Database, personId: string) {
  if (!/^per_[A-Za-z0-9_-]{1,76}$/u.test(personId)) return null
  return db.prepare(`
    SELECT ${PROFILE_SELECT}
    FROM person_profiles p
    JOIN persons pe ON pe.id = p.person_id
    JOIN galleries g ON g.id = p.source_gallery_id
    LEFT JOIN profile_public_projections proj ON proj.profile_id = p.id
    WHERE p.person_id = ?
    LIMIT 1
  `).bind(personId).first<ProfileRow>()
}

async function requireProfileRow(db: D1Database, personId: string) {
  const row = await getProfileRow(db, personId)
  if (!row) throw new PersonSupplyError(404, 'PERSON_NOT_FOUND', '人物候选不存在')
  return row
}

async function getLatestAuthorization(db: D1Database, profileId: string, profileVersion: number) {
  return db.prepare(`
    ${AUTHORIZATION_SELECT}
    WHERE profile_id = ? AND profile_version = ?
    ORDER BY created_at DESC,
      CASE status WHEN 'active' THEN 4 WHEN 'pending' THEN 3 WHEN 'expired' THEN 2 ELSE 1 END DESC,
      id DESC LIMIT 1
  `).bind(profileId, profileVersion).first<AuthorizationRow>()
}

async function listLatestAuthorizations(db: D1Database, profileIds: string[]) {
  const records = new Map<string, AuthorizationRow>()
  if (!profileIds.length) return records
  const placeholders = profileIds.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT id, profile_id, profile_version, status, evidence_ref, valid_from, valid_until,
           reason_code, note, created_by, reviewed_by, revoked_by, created_at, reviewed_at, revoked_at
    FROM (
      SELECT a.*,
        ROW_NUMBER() OVER (
          PARTITION BY a.profile_id
          ORDER BY a.created_at DESC,
            CASE a.status WHEN 'active' THEN 4 WHEN 'pending' THEN 3 WHEN 'expired' THEN 2 ELSE 1 END DESC,
            a.id DESC
        ) AS row_number
      FROM person_authorizations a
      JOIN person_profiles p ON p.id = a.profile_id AND p.content_version = a.profile_version
      WHERE a.profile_id IN (${placeholders})
    ) ranked
    WHERE row_number = 1
  `).bind(...profileIds).all<AuthorizationRow>()
  for (const row of result.results) records.set(row.profile_id, row)
  return records
}

async function getLatestVerification(db: D1Database, profileId: string, profileVersion: number) {
  return db.prepare(`
    ${VERIFICATION_SELECT}
    WHERE profile_id = ? AND profile_version = ?
    ORDER BY submitted_at DESC,
      CASE status WHEN 'pending' THEN 5 WHEN 'verified' THEN 4 WHEN 'rejected' THEN 3 WHEN 'expired' THEN 2 ELSE 1 END DESC,
      id DESC LIMIT 1
  `).bind(profileId, profileVersion).first<VerificationRow>()
}

async function listLatestVerifications(db: D1Database, profileIds: string[]) {
  const records = new Map<string, VerificationRow>()
  if (!profileIds.length) return records
  const placeholders = profileIds.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT id, profile_id, profile_version, status, evidence_ref, verification_items_json,
           policy_version, valid_until, reason_code, note, submitted_by, reviewed_by,
           submitted_at, reviewed_at, revoked_by, revoked_at
    FROM (
      SELECT v.*,
        ROW_NUMBER() OVER (
          PARTITION BY v.profile_id
          ORDER BY v.submitted_at DESC,
            CASE v.status WHEN 'pending' THEN 5 WHEN 'verified' THEN 4 WHEN 'rejected' THEN 3 WHEN 'expired' THEN 2 ELSE 1 END DESC,
            v.id DESC
        ) AS row_number
      FROM person_verifications v
      JOIN person_profiles p ON p.id = v.profile_id AND p.content_version = v.profile_version
      WHERE v.profile_id IN (${placeholders})
    ) ranked
    WHERE row_number = 1
  `).bind(...profileIds).all<VerificationRow>()
  for (const row of result.results) records.set(row.profile_id, row)
  return records
}

async function getPendingPublication(db: D1Database, profileId: string, profileVersion: number) {
  return db.prepare(`
    ${PUBLICATION_SELECT}
    WHERE profile_id = ? AND profile_version = ? AND status = 'pending_review'
    ORDER BY submitted_at DESC LIMIT 1
  `).bind(profileId, profileVersion).first<PublicationRow>()
}

function effectiveAuthorizationStatus(row: AuthorizationRow | null, now: Date) {
  if (!row) return 'missing'
  if (row.status !== 'active') return row.status
  const nowMs = now.getTime()
  if (Date.parse(row.valid_from) > nowMs) return 'pending'
  if (row.valid_until && Date.parse(row.valid_until) <= nowMs) return 'expired'
  return 'active'
}

function effectiveVerificationStatus(row: VerificationRow | null, now: Date) {
  if (!row) return 'unverified'
  if (row.status !== 'verified') return row.status
  if (row.valid_until && Date.parse(row.valid_until) <= now.getTime()) return 'expired'
  return 'verified'
}

function mapAuthorization(row: AuthorizationRow, now: Date) {
  return {
    id: row.id,
    profileVersion: row.profile_version,
    storedStatus: row.status,
    effectiveStatus: effectiveAuthorizationStatus(row, now),
    purpose: 'app_public_display',
    evidenceRef: row.evidence_ref,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    reasonCode: row.reason_code,
    note: row.note,
    createdBy: row.created_by,
    reviewedBy: row.reviewed_by,
    revokedBy: row.revoked_by,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    revokedAt: row.revoked_at,
  }
}

function mapVerification(row: VerificationRow, now: Date) {
  return {
    id: row.id,
    profileVersion: row.profile_version,
    storedStatus: row.status,
    effectiveStatus: effectiveVerificationStatus(row, now),
    evidenceRef: row.evidence_ref,
    verificationItems: parseStringArray(row.verification_items_json),
    policyVersion: row.policy_version,
    validUntil: row.valid_until,
    reasonCode: row.reason_code,
    note: row.note,
    submittedBy: row.submitted_by,
    reviewedBy: row.reviewed_by,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
  }
}

function mapPublication(row: PublicationRow) {
  return {
    id: row.id,
    profileVersion: row.profile_version,
    status: row.status,
    reasonCode: row.reason_code,
    note: row.note,
    projectionVersion: row.projection_version,
    submittedBy: row.submitted_by,
    reviewedBy: row.reviewed_by,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
  }
}

function mapListItem(row: ProfileRow, authorization: AuthorizationRow | null, verification: VerificationRow | null) {
  const now = new Date()
  return {
    personId: row.person_id,
    profileId: row.profile_id,
    displayName: row.display_name,
    sourceGalleryTitle: row.gallery_title,
    verificationStatus: effectiveVerificationStatus(verification, now),
    authorizationStatus: effectiveAuthorizationStatus(authorization, now),
    publicationStatus: row.publication_status,
    contentVersion: row.content_version,
    liveContentVersion: row.live_content_version,
    lockVersion: row.lock_version,
    liveVisible: row.projection_publication_status === 'published' && row.projection_visibility_status === 'visible',
    updatedAt: row.updated_at,
  }
}

function normalizeProfileInput(input: PersonProfileInput) {
  const sourceGalleryId = requiredText(input.sourceGalleryId, '来源图库', 80)
  const displayName = requiredText(input.displayName, '展示名', 80)
  const summary = optionalText(input.summary, 500)
  const tags = normalizeTags(input.tags)
  const rawRegionCode = optionalText(input.regionCode, 32)?.toLowerCase() ?? null
  const regionLabel = optionalText(input.regionLabel, 80)
  const regionPrecision = optionalEnum(input.regionPrecision, ['city', 'province', 'country', 'broad']) as RegionPrecision | null
  if (rawRegionCode && !/^[a-z0-9-]{2,32}$/u.test(rawRegionCode)) {
    throw new PersonSupplyError(400, 'INVALID_REGION_CODE', '地区代码仅支持 2-32 位小写字母、数字和连字符')
  }
  const regionParts = [rawRegionCode, regionLabel, regionPrecision]
  if (regionParts.some(Boolean) && !regionParts.every(Boolean)) {
    throw new PersonSupplyError(400, 'INCOMPLETE_REGION', '地区代码、名称和精度必须同时填写或同时留空')
  }
  return {
    sourceGalleryId,
    displayName,
    summary,
    tags,
    regionCode: rawRegionCode,
    regionLabel,
    regionPrecision,
    recommendationScore: nonNegativeInteger(input.recommendationScore, 0, '推荐分'),
    heatScore: nonNegativeInteger(input.heatScore, 0, '热度分'),
    recommendationReasonCode: optionalCode(input.recommendationReasonCode) ?? 'EDITORIAL_QUALITY',
  }
}

function normalizeTags(value: unknown) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new PersonSupplyError(400, 'INVALID_TAGS', '标签必须为数组')
  const tags = [...new Set(value.map(item => requiredText(item, '标签', 40)))]
  if (tags.length > 8) throw new PersonSupplyError(400, 'TOO_MANY_TAGS', '人物标签最多 8 个')
  return tags
}

function normalizeVerificationItems(value: unknown): VerificationItem[] {
  if (!Array.isArray(value)) {
    throw new PersonSupplyError(400, 'INVALID_VERIFICATION_ITEMS', '通过认证时必须提交完整认证项')
  }
  const items = [...new Set(value.map(item => String(item)))]
  const unknown = items.filter(item => !PERSON_VERIFICATION_ITEMS.includes(item as VerificationItem))
  const missing = PERSON_VERIFICATION_ITEMS.filter(item => !items.includes(item))
  if (unknown.length || missing.length) {
    throw new PersonSupplyError(400, 'INCOMPLETE_VERIFICATION_ITEMS', '四项认证检查必须全部通过', {
      required: PERSON_VERIFICATION_ITEMS,
      missing,
      unknown,
    })
  }
  return PERSON_VERIFICATION_ITEMS.slice()
}

async function assertGalleryAvailable(db: D1Database, galleryId: string) {
  const gallery = await db.prepare('SELECT id FROM galleries WHERE id = ? LIMIT 1').bind(galleryId).first()
  if (!gallery) throw new PersonSupplyError(400, 'SOURCE_GALLERY_NOT_FOUND', '来源图库不存在')
}

async function assertGalleryNotAssigned(db: D1Database, galleryId: string, excludedProfileId?: string) {
  const existing = await db.prepare(`
    SELECT id FROM person_profiles
    WHERE source_gallery_id = ? AND (? IS NULL OR id <> ?)
    LIMIT 1
  `).bind(galleryId, excludedProfileId ?? null, excludedProfileId ?? null).first<{ id: string }>()
  if (existing) {
    throw new PersonSupplyError(409, 'SOURCE_GALLERY_ALREADY_ASSIGNED', '该图库已关联其他人物候选')
  }
}

function assertExpectedVersion(row: ProfileRow, expectedVersion: number) {
  if (row.lock_version !== expectedVersion) {
    throw new PersonSupplyError(409, 'VERSION_CONFLICT', '资料已被其他操作更新，请刷新后重试', {
      expectedVersion,
      currentVersion: row.lock_version,
    })
  }
}

function assertClaimed(results: D1Result<unknown>[], previousVersion: number, message = '资料已被其他操作更新，请刷新后重试') {
  const changes = Number(results[0]?.meta?.changes ?? 0)
  if (changes !== 1) {
    throw new PersonSupplyError(409, 'VERSION_CONFLICT', message, { currentVersionAtRead: previousVersion })
  }
}

function auditForClaimedProfile(
  db: D1Database,
  input: {
    adminId: number
    action: string
    profileId: string
    token: string
    before?: unknown
    after?: unknown
    now: string
  },
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, 'person_profile', id, ?, ?, ?
    FROM person_profiles WHERE id = ? AND mutation_token = ?
  `).bind(
    generateId('log'),
    input.adminId,
    input.action,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.now,
    input.profileId,
    input.token,
  )
}

function suspendProjectionForClaim(
  db: D1Database,
  profileId: string,
  token: string,
  input: { authorizationStatus?: 'revoked'; verificationStatus?: 'suspended'; now: string },
) {
  return db.prepare(`
    UPDATE profile_public_projections
    SET authorization_status = COALESCE(?, authorization_status),
        verification_status = COALESCE(?, verification_status),
        publication_status = 'unpublished', visibility_status = 'suspended', updated_at = ?
    WHERE profile_id = ? AND profile_version = (
      SELECT content_version FROM person_profiles WHERE id = ? AND mutation_token = ?
    )
  `).bind(
    input.authorizationStatus ?? null,
    input.verificationStatus ?? null,
    input.now,
    profileId,
    profileId,
    token,
  )
}

function profileAuditSnapshot(row: ProfileRow) {
  return {
    sourceGalleryId: row.source_gallery_id,
    displayName: row.display_name,
    contentVersion: row.content_version,
    verificationStatus: row.verification_status,
    publicationStatus: row.publication_status,
    liveContentVersion: row.live_content_version,
  }
}

function requiredText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string') throw new PersonSupplyError(400, 'INVALID_INPUT', `${label}不能为空`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new PersonSupplyError(400, 'INVALID_INPUT', `${label}长度必须为 1-${maxLength} 个字符`)
  }
  return normalized
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new PersonSupplyError(400, 'INVALID_INPUT', '文本字段格式不正确')
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > maxLength) throw new PersonSupplyError(400, 'INVALID_INPUT', `文本长度不能超过 ${maxLength} 个字符`)
  return normalized
}

function optionalCode(value: unknown) {
  const code = optionalText(value, 80)
  if (code && !/^[A-Z0-9_:-]+$/u.test(code)) {
    throw new PersonSupplyError(400, 'INVALID_REASON_CODE', '原因码仅支持大写字母、数字、下划线、冒号和连字符')
  }
  return code
}

function requiredCode(value: unknown, label: string) {
  const code = optionalCode(value)
  if (!code) throw new PersonSupplyError(400, 'MISSING_REASON_CODE', `${label}不能为空`)
  return code
}

function requiredId(value: unknown, prefix: string, label: string) {
  const id = requiredText(value, label, 80)
  if (!id.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/u.test(id)) {
    throw new PersonSupplyError(400, 'INVALID_RECORD_ID', `${label}格式不正确`)
  }
  return id
}

function dateText(value: unknown, label: string) {
  const raw = optionalText(value, 40)
  if (!raw) return null
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) throw new PersonSupplyError(400, 'INVALID_DATE', `${label}格式不正确`)
  return new Date(time).toISOString()
}

function expectedLockVersion(value: unknown) {
  const version = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new PersonSupplyError(400, 'INVALID_EXPECTED_VERSION', 'expectedVersion 必须为正整数')
  }
  return version
}

function nonNegativeInteger(value: unknown, fallback: number, label: string) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new PersonSupplyError(400, 'INVALID_SCORE', `${label}必须为 0-1000000 的整数`)
  }
  return parsed
}

function positiveInteger(value: string | undefined, fallback: number, max: number) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new PersonSupplyError(400, 'INVALID_ENUM', '枚举字段取值不正确')
  }
  return value as T
}

function requiredEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const result = optionalEnum(value, allowed)
  if (!result) throw new PersonSupplyError(400, 'INVALID_ENUM', `${label}不能为空`)
  return result
}

function parseStringArray(raw: string) {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, match => `\\${match}`)
}

const PROFILE_SELECT = `
  pe.id AS person_id,
  pe.lifecycle_status,
  p.id AS profile_id,
  p.source_gallery_id,
  g.title AS gallery_title,
  g.status AS gallery_status,
  g.cover_key,
  p.display_name,
  p.summary,
  p.tags_json,
  p.operation_mode,
  p.operation_label,
  p.region_code,
  p.region_label,
  p.region_precision,
  p.recommendation_score,
  p.heat_score,
  p.recommendation_reason_code,
  p.verification_status,
  p.publication_status,
  p.safety_status,
  p.content_version,
  p.live_content_version,
  p.lock_version,
  p.created_at,
  p.updated_at,
  proj.visibility_status AS projection_visibility_status,
  proj.publication_status AS projection_publication_status,
  proj.projection_version,
  proj.profile_version AS projection_profile_version,
  proj.authorization_id AS projection_authorization_id,
  proj.verification_id AS projection_verification_id,
  proj.publication_id AS projection_publication_id
`

const AUTHORIZATION_SELECT = `
  SELECT id, profile_id, profile_version, status, evidence_ref, valid_from, valid_until,
         reason_code, note, created_by, reviewed_by, revoked_by, created_at, reviewed_at, revoked_at
  FROM person_authorizations
`

const VERIFICATION_SELECT = `
  SELECT id, profile_id, profile_version, status, evidence_ref, verification_items_json,
         policy_version, valid_until, reason_code, note, submitted_by, reviewed_by,
         submitted_at, reviewed_at, revoked_by, revoked_at
  FROM person_verifications
`

const PUBLICATION_SELECT = `
  SELECT id, profile_id, profile_version, status, reason_code, note, projection_version,
         submitted_by, reviewed_by, submitted_at, reviewed_at
  FROM person_publication_reviews
`
