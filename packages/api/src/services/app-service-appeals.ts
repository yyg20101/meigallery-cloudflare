import type {
  AppAppealReviewState,
  AppSafetyAppealStatus,
  AppServiceAppealCreateResult,
  AppServiceAppealDetail,
  AppServiceAppealSourceSummary,
  AppServiceAppealSourceType,
  AppServiceAppealSupplementResult,
  AppServiceAppealSummary,
} from '@meigallery/shared'
import { APP_SAFETY_MAX_APPEAL_STATEMENT_LENGTH, AppSafetyError } from './app-safety'
import { requireSafetyAppealPolicy } from './app-safety-appeals'

const APPEAL_ID_PATTERN = /^bap_[A-Za-z0-9_-]{1,76}$/u
const ACCOUNT_RESTRICTION_ID_PATTERN = /^acc_[A-Za-z0-9_-]{1,76}$/u
const WALLET_ENTRY_ID_PATTERN = /^wle_[A-Za-z0-9_-]{1,92}$/u
const SOURCE_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const DEFAULT_LIST_SIZE = 20
const MAX_LIST_SIZE = 40

export interface CreateAppServiceAppealInput {
  sourceType?: unknown
  sourceId?: unknown
  expectedSourceVersion?: unknown
  statement?: unknown
}

export interface AddAppServiceAppealSupplementInput {
  expectedVersion?: unknown
  note?: unknown
}

export interface AppServiceAppealListQuery {
  limit: number
  cursor: null | {
    v: 2
    accountScope: string
    updatedAt: string
    appealId: string
  }
}

type AppealRow = {
  id: string
  source_type: string
  source_id: string
  source_version: string
  source_reference: string
  source_label: string
  statement_text: string
  review_state: string
  user_visible_status: string
  user_visible_message: string
  version: number
  submitted_at: string
  updated_at: string
  supplement_due_at: string | null
  resolved_at: string | null
}

type AppealEventRow = {
  sequence: number
  user_visible_status: string
  user_visible_message: string
  created_at: string
}

type IdempotencyRow = {
  request_hash: string
  result_id: string
  result_version: number
}

type SupplementRow = {
  sequence: number
  note_text: string
  created_at: string
}

type SourceSnapshot = {
  type: AppServiceAppealSourceType
  id: string
  version: string
  reference: string
  label: string
  snapshot: Record<string, unknown>
  originalDecisionAdminId: number | null
}

export function parseAppServiceAppealListQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
}): AppServiceAppealListQuery {
  const parsed = Number.parseInt(input.limit ?? '', 10)
  const limit = Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_LIST_SIZE)
    : DEFAULT_LIST_SIZE
  if (!input.cursor) return { limit, cursor: null }
  const cursor = decodeCursor(input.cursor)
  if (!isCursor(cursor) || cursor.accountScope !== input.accountScope) {
    throw new AppSafetyError(400, 'INVALID_CURSOR', '业务申诉列表游标与当前账号不匹配')
  }
  return { limit, cursor }
}

export async function createAppServiceAppeal(
  db: D1Database,
  accountId: number,
  policyId: string,
  idempotencyKeyValue: string | null,
  input: CreateAppServiceAppealInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<AppServiceAppealCreateResult> {
  const sourceType = normalizeSourceType(input.sourceType)
  const sourceId = normalizeSourceId(sourceType, input.sourceId)
  const expectedSourceVersion = normalizeSourceVersion(input.expectedSourceVersion)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const policy = await requireSafetyAppealPolicy(db, policyId, requireProductionReady)
  const statement = normalizeStatement(input.statement, policy.maxStatementLength)
  const source = await resolveSource(db, accountId, sourceType, sourceId)
  if (source.version !== expectedSourceVersion) {
    throw new AppSafetyError(409, 'APPEAL_SOURCE_VERSION_CONFLICT', '原业务对象已变化，请刷新后重新提交申诉')
  }

  const actorScope = `viewer:${accountId}`
  const requestHash = await hashCanonical({ sourceType, sourceId, expectedSourceVersion, statement })
  const replay = await findIdempotency(db, actorScope, 'appeal_create', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { appeal: await getAppServiceAppeal(db, accountId, replay.result_id), replayed: true }
  }

  const existing = await findSourceAppeal(db, accountId, source)
  if (existing) throw new AppSafetyError(409, 'APPEAL_ALREADY_EXISTS', '该业务对象已有申诉案件')

  const appealId = prefixedId('bap')
  const eventId = prefixedId('bae')
  const nowIso = now.toISOString()
  const reviewDueAt = policy.reviewSlaApproved && policy.reviewSlaHours !== null
    ? new Date(now.getTime() + policy.reviewSlaHours * 60 * 60 * 1000).toISOString()
    : null
  const sourceSnapshotJson = JSON.stringify(source.snapshot)
  const sourceSnapshotHash = await sha256Hex(sourceSnapshotJson)
  const statementHash = await sha256Hex(statement)
  const message = '申诉已收到，将由独立审核人员处理；原业务状态不会因提交而自动改变。'
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_service_appeals (
          id, account_id, source_type, source_id, source_version,
          source_reference, source_label, source_snapshot_json, source_snapshot_sha256,
          original_decision_admin_id, statement_text, statement_sha256,
          status, review_state, user_visible_status, user_visible_message, assigned_admin_id,
          policy_id, version, mutation_token, submitted_at, updated_at,
          review_due_at, supplement_due_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  'submitted', 'normal', 'submitted', ?, NULL, ?, 1, NULL, ?, ?, ?, NULL, NULL)
      `).bind(
        appealId,
        accountId,
        source.type,
        source.id,
        source.version,
        source.reference,
        source.label,
        sourceSnapshotJson,
        sourceSnapshotHash,
        source.originalDecisionAdminId,
        statement,
        statementHash,
        message,
        policy.id,
        nowIso,
        nowIso,
        reviewDueAt,
      ),
      db.prepare(`
        INSERT INTO app_service_appeal_events (
          id, appeal_id, sequence, actor_type, actor_account_id, actor_admin_id,
          event_type, status_from, status_to, reason_code,
          review_state_from, review_state_to,
          user_visible_status, user_visible_message, created_at
        ) SELECT ?, id, 1, 'viewer', account_id, NULL, 'submitted', NULL,
                 'submitted', 'viewer_requested_review', NULL, 'normal', 'submitted', ?, ?
          FROM app_service_appeals WHERE id = ? AND version = 1
      `).bind(eventId, message, nowIso, appealId),
      db.prepare(`
        INSERT INTO app_service_appeal_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          result_id, result_version, created_at
        ) SELECT ?, 'appeal_create', ?, ?, id, version, ?
          FROM app_service_appeals WHERE id = ? AND version = 1
      `).bind(actorScope, idempotencyKey, requestHash, nowIso, appealId),
    ])
  }
  catch {
    const concurrent = await findIdempotency(db, actorScope, 'appeal_create', idempotencyKey)
    if (concurrent) {
      assertIdempotencyHash(concurrent, requestHash)
      return { appeal: await getAppServiceAppeal(db, accountId, concurrent.result_id), replayed: true }
    }
    if (await findSourceAppeal(db, accountId, source)) {
      throw new AppSafetyError(409, 'APPEAL_ALREADY_EXISTS', '该业务对象已有申诉案件')
    }
    throw new AppSafetyError(409, 'APPEAL_SOURCE_VERSION_CONFLICT', '原业务对象已变化，请刷新后重试', true)
  }
  const persisted = await findIdempotency(db, actorScope, 'appeal_create', idempotencyKey)
  if (!persisted || persisted.result_id !== appealId) {
    throw new AppSafetyError(409, 'APPEAL_SOURCE_VERSION_CONFLICT', '原业务对象已变化，请刷新后重试', true)
  }
  return { appeal: await getAppServiceAppeal(db, accountId, appealId), replayed: false }
}

export async function listAppServiceAppeals(
  db: D1Database,
  accountId: number,
  accountPublicId: string,
  query: AppServiceAppealListQuery,
): Promise<{ data: AppServiceAppealSummary[]; nextCursor: string | null; hasMore: boolean }> {
  const conditions = ['account_id = ?']
  const params: unknown[] = [accountId]
  if (query.cursor) {
    conditions.push('(updated_at < ? OR (updated_at = ? AND id > ?))')
    params.push(query.cursor.updatedAt, query.cursor.updatedAt, query.cursor.appealId)
  }
  const rows = await db.prepare(`${APPEAL_SELECT}
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, id ASC
    LIMIT ?
  `).bind(...params, query.limit + 1).all<AppealRow>()
  const hasMore = rows.results.length > query.limit
  const page = rows.results.slice(0, query.limit)
  const last = page.at(-1)
  return {
    data: page.map(mapSummary),
    nextCursor: hasMore && last
      ? encodeCursor({
          v: 2,
          accountScope: accountPublicId,
          updatedAt: last.updated_at,
          appealId: last.id,
        })
      : null,
    hasMore,
  }
}

export async function getAppServiceAppeal(
  db: D1Database,
  accountId: number,
  appealIdValue: string,
): Promise<AppServiceAppealDetail> {
  const appealId = normalizeAppealId(appealIdValue)
  const appeal = await db.prepare(`${APPEAL_SELECT}
    WHERE id = ? AND account_id = ? LIMIT 1
  `).bind(appealId, accountId).first<AppealRow>()
  if (!appeal) throw appealNotFound()
  const events = await db.prepare(`
    SELECT sequence, user_visible_status, user_visible_message, created_at
    FROM app_service_appeal_events
    WHERE appeal_id = ? ORDER BY sequence ASC
  `).bind(appealId).all<AppealEventRow>()
  const supplements = await db.prepare(`
    SELECT sequence, note_text, created_at
    FROM app_service_appeal_supplements
    WHERE appeal_id = ? ORDER BY sequence ASC
  `).bind(appealId).all<SupplementRow>()
  return {
    ...mapSummary(appeal),
    statement: appeal.statement_text,
    supplements: supplements.results.map(item => ({
      sequence: Number(item.sequence),
      note: item.note_text,
      createdAt: item.created_at,
    })),
    timeline: events.results.map(event => ({
      sequence: Number(event.sequence),
      status: normalizeStatus(event.user_visible_status),
      message: event.user_visible_message,
      createdAt: event.created_at,
    })),
  }
}

export async function addAppServiceAppealSupplement(
  db: D1Database,
  accountId: number,
  appealIdValue: string,
  idempotencyKeyValue: string | null,
  input: AddAppServiceAppealSupplementInput,
  now = new Date(),
): Promise<AppServiceAppealSupplementResult> {
  const appealId = normalizeAppealId(appealIdValue)
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  const note = normalizeStatement(input.note, APP_SAFETY_MAX_APPEAL_STATEMENT_LENGTH)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = `viewer:${accountId}`
  const requestHash = await hashCanonical({ appealId, expectedVersion, note })
  const replay = await findIdempotency(db, actorScope, 'appeal_supplement_add', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { appeal: await getAppServiceAppeal(db, accountId, replay.result_id), replayed: true }
  }

  const current = await db.prepare(`
    SELECT id, version, status, review_state
    FROM app_service_appeals
    WHERE id = ? AND account_id = ? LIMIT 1
  `).bind(appealId, accountId).first<{
    id: string
    version: number
    status: string
    review_state: string
  }>()
  if (!current) throw appealNotFound()
  if (Number(current.version) !== expectedVersion) {
    throw new AppSafetyError(409, 'APPEAL_VERSION_CONFLICT', '申诉已被更新，请刷新后重新补充')
  }
  const currentReviewState = normalizeReviewState(current.review_state)
  if (
    currentReviewState === 'needs_escalation'
    || !['submitted', 'triaged', 'investigating'].includes(current.status)
  ) {
    throw new AppSafetyError(409, 'APPEAL_SUPPLEMENT_UNAVAILABLE', '当前申诉不能补充说明')
  }

  const nowIso = now.toISOString()
  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const noteHash = await sha256Hex(note)
  const supplementId = prefixedId('bas')
  const eventId = prefixedId('bae')
  const message = currentReviewState === 'evidence_insufficient'
    ? '补充说明已收到，申诉已恢复独立复核；原业务状态仍未自动改变。'
    : '补充说明已收到，独立复核继续进行；原业务状态仍未自动改变。'
  await db.batch([
    db.prepare(`
      UPDATE app_service_appeals
      SET status = 'investigating', review_state = 'normal',
          user_visible_status = 'processing', user_visible_message = ?,
          supplement_due_at = NULL, version = ?, mutation_token = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND version = ?
        AND review_state IN ('normal', 'evidence_insufficient')
        AND status IN ('submitted', 'triaged', 'investigating')
    `).bind(message, nextVersion, mutationToken, nowIso, appealId, accountId, expectedVersion),
    db.prepare(`
      INSERT INTO app_service_appeal_supplements (
        id, appeal_id, sequence, account_id, note_text, note_sha256, created_at
      )
      SELECT ?, id,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_service_appeal_supplements WHERE appeal_id = ?),
             account_id, ?, ?, ?
      FROM app_service_appeals
      WHERE id = ? AND version = ? AND mutation_token = ? AND account_id = ?
    `).bind(supplementId, appealId, note, noteHash, nowIso, appealId, nextVersion, mutationToken, accountId),
    db.prepare(`
      INSERT INTO app_service_appeal_events (
        id, appeal_id, sequence, actor_type, actor_account_id, actor_admin_id,
        event_type, status_from, status_to, review_state_from, review_state_to,
        reason_code, user_visible_status, user_visible_message, created_at
      )
      SELECT ?, id,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_service_appeal_events WHERE appeal_id = ?),
             'viewer', account_id, NULL, 'supplement_added', ?, 'investigating',
             ?, 'normal', 'viewer_added_supplement', 'processing', ?, ?
      FROM app_service_appeals
      WHERE id = ? AND version = ? AND mutation_token = ? AND account_id = ?
    `).bind(
      eventId,
      appealId,
      current.status,
      currentReviewState,
      message,
      nowIso,
      appealId,
      nextVersion,
      mutationToken,
      accountId,
    ),
    db.prepare(`
      INSERT INTO app_service_appeal_idempotency (
        actor_scope, operation, idempotency_key, request_hash,
        result_id, result_version, created_at
      )
      SELECT ?, 'appeal_supplement_add', ?, ?, id, version, ?
      FROM app_service_appeals
      WHERE id = ? AND version = ? AND mutation_token = ? AND account_id = ?
    `).bind(actorScope, idempotencyKey, requestHash, nowIso, appealId, nextVersion, mutationToken, accountId),
  ])
  const persisted = await findIdempotency(db, actorScope, 'appeal_supplement_add', idempotencyKey)
  if (!persisted || persisted.result_version !== nextVersion) {
    throw new AppSafetyError(409, 'APPEAL_VERSION_CONFLICT', '申诉已被更新，请刷新后重新补充', true)
  }
  return { appeal: await getAppServiceAppeal(db, accountId, appealId), replayed: false }
}

async function resolveSource(
  db: D1Database,
  accountId: number,
  sourceType: AppServiceAppealSourceType,
  sourceId: string,
): Promise<SourceSnapshot> {
  if (sourceType === 'account_restriction') {
    const row = await db.prepare(`
      SELECT account_public_id, status, restriction_reason_code, restricted_until,
             restriction_version, restriction_reference, restriction_decision_admin_id
      FROM app_account_security
      WHERE account_id = ? AND account_public_id = ? AND status = 'restricted'
        AND restriction_version > 0 AND restriction_reference IS NOT NULL
      LIMIT 1
    `).bind(accountId, sourceId).first<{
      account_public_id: string
      status: string
      restriction_reason_code: string | null
      restricted_until: string | null
      restriction_version: number
      restriction_reference: string
      restriction_decision_admin_id: number | null
    }>()
    if (!row) throw new AppSafetyError(404, 'APPEAL_SOURCE_NOT_FOUND', '账号限制已变化或当前不可申诉')
    return {
      type: sourceType,
      id: row.account_public_id,
      version: String(row.restriction_version),
      reference: row.restriction_reference,
      label: '账号限制',
      snapshot: {
        status: row.status,
        reasonCategory: restrictionReasonCategory(row.restriction_reason_code),
        restrictedUntil: row.restricted_until,
      },
      originalDecisionAdminId: row.restriction_decision_admin_id === null
        ? null
        : Number(row.restriction_decision_admin_id),
    }
  }

  const row = await db.prepare(`
    SELECT entry.id, entry.sequence, entry.public_reference, entry.action_type,
           entry.direction, entry.amount, entry.reason_code, entry.user_visible_note,
           entry.balance_before, entry.balance_after, entry.posted_at,
           entry.original_entry_id, entry.reviewed_by
    FROM app_wallet_entries entry
    WHERE entry.id = ? AND entry.account_id = ? AND entry.status = 'posted'
    LIMIT 1
  `).bind(sourceId, accountId).first<{
    id: string
    sequence: number
    public_reference: string
    action_type: string
    direction: string
    amount: number
    reason_code: string
    user_visible_note: string
    balance_before: number
    balance_after: number
    posted_at: string
    original_entry_id: string | null
    reviewed_by: number
  }>()
  if (!row) throw new AppSafetyError(404, 'APPEAL_SOURCE_NOT_FOUND', '金币分录不存在或不属于当前账号')
  return {
    type: sourceType,
    id: row.id,
    version: String(row.sequence),
    reference: row.public_reference,
    label: '金币分录',
    snapshot: {
      actionType: row.action_type,
      direction: row.direction,
      amount: Number(row.amount),
      reasonCode: row.reason_code,
      userVisibleNote: row.user_visible_note,
      balanceBefore: Number(row.balance_before),
      balanceAfter: Number(row.balance_after),
      postedAt: row.posted_at,
      originalEntryId: row.original_entry_id,
    },
    originalDecisionAdminId: Number(row.reviewed_by),
  }
}

const APPEAL_SELECT = `
  SELECT id, source_type, source_id, source_version, source_reference,
         source_label, statement_text, review_state, user_visible_status, user_visible_message,
         version, submitted_at, updated_at, supplement_due_at, resolved_at
  FROM app_service_appeals
`

function mapSummary(row: AppealRow): AppServiceAppealSummary {
  return {
    appealId: row.id,
    source: {
      type: normalizeSourceType(row.source_type),
      sourceId: row.source_id,
      sourceVersion: row.source_version,
      reference: row.source_reference,
      label: row.source_label,
    } satisfies AppServiceAppealSourceSummary,
    status: normalizeStatus(row.user_visible_status),
    reviewState: normalizeReviewState(row.review_state),
    userVisibleMessage: row.user_visible_message,
    version: Number(row.version),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    supplementDueAt: row.supplement_due_at,
    resolvedAt: row.resolved_at,
  }
}

function normalizeSourceType(value: unknown): AppServiceAppealSourceType {
  if (value === 'account_restriction' || value === 'wallet_entry') return value
  throw new AppSafetyError(400, 'APPEAL_SOURCE_TYPE_INVALID', '申诉来源类型无效')
}

function normalizeSourceId(type: AppServiceAppealSourceType, value: unknown): string {
  const pattern = type === 'account_restriction'
    ? ACCOUNT_RESTRICTION_ID_PATTERN
    : WALLET_ENTRY_ID_PATTERN
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new AppSafetyError(404, 'APPEAL_SOURCE_NOT_FOUND', '申诉来源不存在或不属于当前账号')
  }
  return value
}

function normalizeSourceVersion(value: unknown): string {
  const normalized = typeof value === 'number' && Number.isInteger(value)
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : ''
  if (!SOURCE_VERSION_PATTERN.test(normalized)) {
    throw new AppSafetyError(400, 'APPEAL_SOURCE_VERSION_INVALID', '申诉来源版本无效')
  }
  return normalized
}

function normalizeStatement(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new AppSafetyError(400, 'APPEAL_STATEMENT_INVALID', '申诉说明必须为文本')
  }
  const normalized = value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').trim()
  if (!normalized || normalized.length > Math.min(maxLength, APP_SAFETY_MAX_APPEAL_STATEMENT_LENGTH) || containsControl(normalized)) {
    throw new AppSafetyError(400, 'APPEAL_STATEMENT_INVALID', `申诉说明必须为 1 至 ${maxLength} 个字符且不能包含控制字符`)
  }
  return normalized
}

function normalizeExpectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new AppSafetyError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  return Number(value)
}

function normalizeIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppSafetyError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return normalized
}

function normalizeAppealId(value: unknown): string {
  if (typeof value !== 'string' || !APPEAL_ID_PATTERN.test(value)) throw appealNotFound()
  return value
}

function normalizeStatus(value: string): AppSafetyAppealStatus {
  if (value === 'submitted' || value === 'processing' || value === 'upheld' || value === 'changed' || value === 'closed') return value
  return 'processing'
}

function normalizeReviewState(value: string): AppAppealReviewState {
  if (value === 'normal' || value === 'evidence_insufficient' || value === 'needs_escalation') return value
  return 'normal'
}

function restrictionReasonCategory(reasonCode: string | null) {
  const value = reasonCode?.toLowerCase() ?? ''
  if (value.includes('deletion')) return 'account_deletion'
  if (value.includes('policy') || value.includes('terms') || value.includes('consent')) return 'policy'
  if (value.includes('admin') || value.includes('manual')) return 'administrative'
  return 'security_review'
}

async function findSourceAppeal(db: D1Database, accountId: number, source: SourceSnapshot) {
  return db.prepare(`
    SELECT id FROM app_service_appeals
    WHERE account_id = ? AND source_type = ? AND source_id = ? AND source_version = ?
    LIMIT 1
  `).bind(accountId, source.type, source.id, source.version).first<{ id: string }>()
}

async function findIdempotency(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT request_hash, result_id, result_version
    FROM app_service_appeal_idempotency
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorScope, operation, idempotencyKey).first<IdempotencyRow>()
}

function assertIdempotencyHash(row: IdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppSafetyError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同申诉操作')
  }
}

function containsControl(value: string) {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point === 0x7f || (point < 0x20 && point !== 0x09 && point !== 0x0a)
  })
}

async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function hashCanonical(value: unknown) {
  return sha256Hex(JSON.stringify(value))
}

function prefixedId(prefix: 'bap' | 'bae' | 'bas') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}

function encodeCursor(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeCursor(value: string): unknown {
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  }
  catch {
    throw new AppSafetyError(400, 'INVALID_CURSOR', '业务申诉列表游标无效')
  }
}

function isCursor(value: unknown): value is NonNullable<AppServiceAppealListQuery['cursor']> {
  if (!value || typeof value !== 'object') return false
  const cursor = value as Record<string, unknown>
  return cursor.v === 2
    && typeof cursor.accountScope === 'string'
    && typeof cursor.updatedAt === 'string'
    && !Number.isNaN(Date.parse(cursor.updatedAt))
    && typeof cursor.appealId === 'string'
    && APPEAL_ID_PATTERN.test(cursor.appealId)
}

function appealNotFound() {
  return new AppSafetyError(404, 'APPEAL_NOT_FOUND', '业务申诉不存在或不属于当前账号')
}
