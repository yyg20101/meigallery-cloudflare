import type {
  AppSafetyAppealCreateResult,
  AppSafetyAppealDetail,
  AppSafetyAppealStatus,
  AppSafetyAppealSummary,
} from '@meigallery/shared'
import { APP_SAFETY_MAX_APPEAL_STATEMENT_LENGTH, AppSafetyError } from './app-safety'

const REPORT_ID_PATTERN = /^rpt_[A-Za-z0-9_-]{1,76}$/u
const APPEAL_ID_PATTERN = /^apl_[A-Za-z0-9_-]{1,76}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const DEFAULT_LIST_SIZE = 20
const MAX_LIST_SIZE = 40

export interface CreateAppSafetyAppealInput {
  reportId?: unknown
  expectedReportVersion?: unknown
  statement?: unknown
}

export interface AppAppealListQuery {
  limit: number
  cursor: null | {
    v: 1
    accountScope: string
    submittedAt: string
    appealId: string
  }
}

export interface SafetyAppealPolicy {
  id: string
  appealWindowDays: number
  maxStatementLength: number
}

type AppealRow = {
  id: string
  report_id: string
  appeal_type: string
  statement_text: string
  user_visible_status: string
  user_visible_message: string
  original_report_version: number
  version: number
  submitted_at: string
  updated_at: string
  resolved_at: string | null
}

type AppealEventRow = {
  sequence: number
  user_visible_status: string
  user_visible_message: string
  created_at: string
}

type AppealIdempotencyRow = {
  request_hash: string
  result_id: string
  result_version: number
}

export function parseAppAppealListQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
}): AppAppealListQuery {
  const parsed = Number.parseInt(input.limit ?? '', 10)
  const limit = Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_LIST_SIZE)
    : DEFAULT_LIST_SIZE
  if (!input.cursor) return { limit, cursor: null }
  const cursor = decodeCursor(input.cursor)
  if (!isAppealCursor(cursor) || cursor.accountScope !== input.accountScope) {
    throw new AppSafetyError(400, 'INVALID_CURSOR', '申诉列表游标与当前账号不匹配')
  }
  return { limit, cursor }
}

export async function createAppSafetyAppeal(
  db: D1Database,
  accountId: number,
  policyId: string,
  idempotencyKeyValue: string | null,
  input: CreateAppSafetyAppealInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<AppSafetyAppealCreateResult> {
  const reportId = normalizeReportId(input.reportId)
  const expectedReportVersion = normalizeExpectedVersion(input.expectedReportVersion)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const policy = await requireSafetyAppealPolicy(db, policyId, requireProductionReady)
  const statement = normalizeStatement(input.statement, policy.maxStatementLength)
  const actorScope = viewerScope(accountId)
  const requestHash = await hashCanonical({ reportId, expectedReportVersion, statement })
  const replay = await findAppealIdempotency(db, actorScope, 'appeal_create', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { appeal: await getAppSafetyAppeal(db, accountId, replay.result_id), replayed: true }
  }

  const report = await db.prepare(`
    SELECT id, status, version, assigned_admin_id, resolved_at
    FROM app_safety_reports
    WHERE id = ? AND account_id = ?
    LIMIT 1
  `).bind(reportId, accountId).first<{
    id: string
    status: string
    version: number
    assigned_admin_id: number | null
    resolved_at: string | null
  }>()
  if (!report) throw new AppSafetyError(404, 'REPORT_NOT_FOUND', '举报记录不存在或不属于当前账号')
  if (Number(report.version) !== expectedReportVersion) {
    throw new AppSafetyError(409, 'REPORT_VERSION_CONFLICT', '举报结论已变化，请刷新后重新申请')
  }
  if (report.status !== 'no_violation' || !report.assigned_admin_id || !report.resolved_at) {
    throw new AppSafetyError(409, 'REPORT_NOT_ELIGIBLE', '只有未发现违规的举报结论可以申请复核')
  }
  const deadline = new Date(report.resolved_at).getTime()
    + policy.appealWindowDays * 24 * 60 * 60 * 1000
  if (!Number.isFinite(deadline) || now.getTime() > deadline) {
    throw new AppSafetyError(409, 'APPEAL_WINDOW_EXPIRED', '该举报结论已超过申请复核期限')
  }
  const existing = await findAppealForReportVersion(db, reportId, expectedReportVersion)
  if (existing) {
    throw new AppSafetyError(409, 'APPEAL_ALREADY_EXISTS', '该举报结论已有复核申请')
  }

  const appealId = prefixedId('apl')
  const eventId = prefixedId('ape')
  const nowIso = now.toISOString()
  const statementHash = await sha256Hex(statement)
  const message = '复核申请已收到，将由与原审核人不同的人员处理。'
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_safety_appeals (
          id, report_id, account_id, appeal_type, original_report_version,
          original_decision_admin_id, statement_text, statement_sha256,
          status, user_visible_status, user_visible_message, assigned_admin_id,
          policy_id, version, mutation_token, submitted_at, updated_at, resolved_at
        )
        SELECT ?, id, account_id, 'report_no_violation_review', version,
               assigned_admin_id, ?, ?, 'submitted', 'submitted', ?, NULL,
               ?, 1, NULL, ?, ?, NULL
        FROM app_safety_reports
        WHERE id = ? AND account_id = ? AND status = 'no_violation'
          AND version = ? AND assigned_admin_id IS NOT NULL AND resolved_at = ?
      `).bind(
        appealId,
        statement,
        statementHash,
        message,
        policy.id,
        nowIso,
        nowIso,
        reportId,
        accountId,
        expectedReportVersion,
        report.resolved_at,
      ),
      db.prepare(`
        INSERT INTO app_safety_appeal_events (
          id, appeal_id, sequence, actor_type, actor_account_id, actor_admin_id,
          event_type, status_from, status_to, reason_code,
          user_visible_status, user_visible_message, created_at
        )
        SELECT ?, id, 1, 'viewer', account_id, NULL, 'submitted', NULL,
               'submitted', 'viewer_requested_review', 'submitted', ?, ?
        FROM app_safety_appeals
        WHERE id = ? AND version = 1
      `).bind(eventId, message, nowIso, appealId),
      db.prepare(`
        INSERT INTO app_safety_appeal_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          result_id, result_version, created_at
        )
        SELECT ?, 'appeal_create', ?, ?, id, version, ?
        FROM app_safety_appeals
        WHERE id = ? AND version = 1
      `).bind(actorScope, idempotencyKey, requestHash, nowIso, appealId),
    ])
  }
  catch {
    const concurrent = await findAppealIdempotency(db, actorScope, 'appeal_create', idempotencyKey)
    if (concurrent) {
      assertIdempotencyHash(concurrent, requestHash)
      return { appeal: await getAppSafetyAppeal(db, accountId, concurrent.result_id), replayed: true }
    }
    if (await findAppealForReportVersion(db, reportId, expectedReportVersion)) {
      throw new AppSafetyError(409, 'APPEAL_ALREADY_EXISTS', '该举报结论已有复核申请')
    }
    throw new AppSafetyError(409, 'REPORT_VERSION_CONFLICT', '举报结论已变化，请刷新后重新申请', true)
  }
  const persisted = await findAppealIdempotency(db, actorScope, 'appeal_create', idempotencyKey)
  if (!persisted || persisted.result_id !== appealId) {
    throw new AppSafetyError(409, 'REPORT_VERSION_CONFLICT', '举报结论已变化，请刷新后重新申请', true)
  }
  return { appeal: await getAppSafetyAppeal(db, accountId, appealId), replayed: false }
}

export async function listAppSafetyAppeals(
  db: D1Database,
  accountId: number,
  accountPublicId: string,
  query: AppAppealListQuery,
): Promise<{ data: AppSafetyAppealSummary[]; nextCursor: string | null; hasMore: boolean }> {
  const conditions = ['account_id = ?']
  const params: unknown[] = [accountId]
  if (query.cursor) {
    conditions.push('(submitted_at < ? OR (submitted_at = ? AND id > ?))')
    params.push(query.cursor.submittedAt, query.cursor.submittedAt, query.cursor.appealId)
  }
  const rows = await db.prepare(`${APPEAL_SELECT}
    WHERE ${conditions.join(' AND ')}
    ORDER BY submitted_at DESC, id ASC
    LIMIT ?
  `).bind(...params, query.limit + 1).all<AppealRow>()
  const hasMore = rows.results.length > query.limit
  const page = rows.results.slice(0, query.limit)
  const last = page.at(-1)
  return {
    data: page.map(mapAppealSummary),
    nextCursor: hasMore && last
      ? encodeCursor({
          v: 1,
          accountScope: accountPublicId,
          submittedAt: last.submitted_at,
          appealId: last.id,
        })
      : null,
    hasMore,
  }
}

export async function getAppSafetyAppeal(
  db: D1Database,
  accountId: number,
  appealIdValue: string,
): Promise<AppSafetyAppealDetail> {
  const appealId = normalizeAppealId(appealIdValue)
  const appeal = await db.prepare(`${APPEAL_SELECT}
    WHERE id = ? AND account_id = ?
    LIMIT 1
  `).bind(appealId, accountId).first<AppealRow>()
  if (!appeal) throw appealNotFound()
  const events = await db.prepare(`
    SELECT sequence, user_visible_status, user_visible_message, created_at
    FROM app_safety_appeal_events
    WHERE appeal_id = ?
    ORDER BY sequence ASC
  `).bind(appealId).all<AppealEventRow>()
  return {
    ...mapAppealSummary(appeal),
    statement: appeal.statement_text,
    timeline: events.results.map(event => ({
      sequence: Number(event.sequence),
      status: normalizeVisibleAppealStatus(event.user_visible_status),
      message: event.user_visible_message,
      createdAt: event.created_at,
    })),
  }
}

export async function requireSafetyAppealPolicy(
  db: D1Database,
  policyId: string,
  requireProductionReady: boolean,
): Promise<SafetyAppealPolicy> {
  const policy = await db.prepare(`
    SELECT policy.id, policy.state, policy.production_ready,
           policy.appeal_window_days, policy.max_statement_length,
           retention.state AS retention_state,
           retention.production_ready AS retention_ready,
           retention.decision_status
    FROM app_safety_appeal_policies policy
    JOIN app_safety_retention_policies retention ON retention.id = policy.retention_policy_id
    WHERE policy.id = ?
    LIMIT 1
  `).bind(policyId).first<{
    id: string
    state: string
    production_ready: number
    appeal_window_days: number
    max_statement_length: number
    retention_state: string
    retention_ready: number
    decision_status: string
  }>()
  if (!policy) {
    throw new AppSafetyError(503, 'APPEAL_POLICY_NOT_READY', '申诉策略尚未完成配置')
  }
  if (
    !Number.isInteger(Number(policy.appeal_window_days))
    || !inRange(Number(policy.appeal_window_days), 1, 365)
    || !Number.isInteger(Number(policy.max_statement_length))
    || !inRange(Number(policy.max_statement_length), 1, APP_SAFETY_MAX_APPEAL_STATEMENT_LENGTH)
  ) {
    throw new AppSafetyError(503, 'APPEAL_POLICY_NOT_READY', '申诉策略参数超出当前契约范围')
  }
  if (
    requireProductionReady
    && (
      policy.state !== 'published'
      || policy.production_ready !== 1
      || policy.retention_state !== 'published'
      || policy.retention_ready !== 1
      || policy.decision_status !== 'approved'
    )
  ) {
    throw new AppSafetyError(503, 'APPEAL_POLICY_NOT_READY', '申诉与保留策略尚未完成生产发布')
  }
  return {
    id: policy.id,
    appealWindowDays: Number(policy.appeal_window_days),
    maxStatementLength: Number(policy.max_statement_length),
  }
}

function inRange(value: number, minimum: number, maximum: number) {
  return value >= minimum && value <= maximum
}

const APPEAL_SELECT = `
  SELECT id, report_id, appeal_type, statement_text, user_visible_status,
         user_visible_message, original_report_version, version,
         submitted_at, updated_at, resolved_at
  FROM app_safety_appeals
`

function mapAppealSummary(row: AppealRow): AppSafetyAppealSummary {
  return {
    appealId: row.id,
    reportId: row.report_id,
    type: 'report_no_violation_review',
    status: normalizeVisibleAppealStatus(row.user_visible_status),
    userVisibleMessage: row.user_visible_message,
    originalReportVersion: Number(row.original_report_version),
    version: Number(row.version),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  }
}

function normalizeVisibleAppealStatus(value: string): AppSafetyAppealStatus {
  switch (value) {
    case 'submitted':
    case 'processing':
    case 'upheld':
    case 'changed':
    case 'closed':
      return value
    default:
      return 'processing'
  }
}

function normalizeReportId(value: unknown): string {
  if (typeof value !== 'string' || !REPORT_ID_PATTERN.test(value)) {
    throw new AppSafetyError(404, 'REPORT_NOT_FOUND', '举报记录不存在或不属于当前账号')
  }
  return value
}

function normalizeAppealId(value: unknown): string {
  if (typeof value !== 'string' || !APPEAL_ID_PATTERN.test(value)) throw appealNotFound()
  return value
}

function normalizeExpectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new AppSafetyError(400, 'EXPECTED_VERSION_INVALID', 'expectedReportVersion 必须为正整数')
  }
  return Number(value)
}

function normalizeStatement(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new AppSafetyError(400, 'APPEAL_STATEMENT_INVALID', '申诉说明必须为文本')
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || containsForbiddenControlCharacter(normalized)) {
    throw new AppSafetyError(400, 'APPEAL_STATEMENT_INVALID', `申诉说明必须为 1 至 ${maxLength} 个字符且不能包含控制字符`)
  }
  return normalized
}

function containsForbiddenControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint === 0x7f || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
  })
}

function normalizeIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppSafetyError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return normalized
}

async function findAppealForReportVersion(
  db: D1Database,
  reportId: string,
  reportVersion: number,
) {
  return db.prepare(`
    SELECT id
    FROM app_safety_appeals
    WHERE report_id = ? AND original_report_version = ?
      AND appeal_type = 'report_no_violation_review'
    LIMIT 1
  `).bind(reportId, reportVersion).first<{ id: string }>()
}

async function findAppealIdempotency(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT request_hash, result_id, result_version
    FROM app_safety_appeal_idempotency
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorScope, operation, idempotencyKey).first<AppealIdempotencyRow>()
}

function assertIdempotencyHash(row: AppealIdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppSafetyError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同申诉操作')
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value))
}

function prefixedId(prefix: 'apl' | 'ape') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}

function viewerScope(accountId: number) {
  return `viewer:${accountId}`
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
    throw new AppSafetyError(400, 'INVALID_CURSOR', '申诉列表游标无效')
  }
}

function isAppealCursor(value: unknown): value is NonNullable<AppAppealListQuery['cursor']> {
  if (!value || typeof value !== 'object') return false
  const cursor = value as Record<string, unknown>
  return cursor.v === 1
    && typeof cursor.accountScope === 'string'
    && typeof cursor.submittedAt === 'string'
    && typeof cursor.appealId === 'string'
    && APPEAL_ID_PATTERN.test(cursor.appealId)
}

function appealNotFound() {
  return new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉记录不存在或不属于当前账号')
}
