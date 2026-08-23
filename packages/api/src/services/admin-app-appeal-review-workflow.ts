import type { AppAppealReviewState } from '@meigallery/shared'
import { AppSafetyError } from './app-safety'

const APPEAL_ID_PATTERN = /^(?:apl|bap)_[A-Za-z0-9_-]{1,76}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const REASON_CODE_PATTERN = /^[a-z0-9_]{3,80}$/u
const FINAL_STATUSES = new Set(['upheld', 'changed', 'closed'])

export interface AdminAppealReviewWorkflowInput {
  expectedVersion?: unknown
  reasonCode?: unknown
  userVisibleMessage?: unknown
}

type WorkflowAction = 'request_supplement' | 'escalate'

type AppealRow = {
  id: string
  status: string
  review_state: string
  assigned_admin_id: number | null
  original_decision_admin_id: number | null
  version: number
  review_due_at: string | null
}

type CommandRow = {
  request_hash: string
  result_id: string
  result_version: number
}

export async function updateAdminAppealReviewWorkflow(
  db: D1Database,
  adminId: number,
  appealIdValue: string,
  action: WorkflowAction,
  idempotencyKeyValue: string | null,
  input: AdminAppealReviewWorkflowInput,
  now = new Date(),
): Promise<{ appealId: string; reviewState: AppAppealReviewState; version: number; replayed: boolean }> {
  const appealId = normalizeAppealId(appealIdValue)
  const appealKind = appealId.startsWith('bap_') ? 'service' : 'report'
  const table = appealKind === 'service' ? 'app_service_appeals' : 'app_safety_appeals'
  const operation = action === 'request_supplement' ? 'appeal_supplement_request' : 'appeal_escalate'
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  const reasonCode = normalizeReasonCode(input.reasonCode)
  const userVisibleMessage = normalizeUserVisibleMessage(input.userVisibleMessage)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = `admin:${adminId}`
  const requestHash = await hashCanonical({ appealId, action, expectedVersion, reasonCode, userVisibleMessage })

  const replay = await findCommand(db, actorScope, operation, idempotencyKey)
  if (replay) {
    assertCommandHash(replay, requestHash)
    return {
      appealId: replay.result_id,
      reviewState: await loadReviewState(db, table, replay.result_id),
      version: Number(replay.result_version),
      replayed: true,
    }
  }

  const appeal = await db.prepare(`
    SELECT id, status, review_state, assigned_admin_id,
           original_decision_admin_id, version, review_due_at
    FROM ${table} WHERE id = ? LIMIT 1
  `).bind(appealId).first<AppealRow>()
  if (!appeal) throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  if (appeal.original_decision_admin_id === adminId) {
    throw new AppSafetyError(403, 'APPEAL_REVIEWER_SEPARATION_REQUIRED', '原业务审核人不能更新该申诉')
  }
  if (appeal.assigned_admin_id !== adminId) {
    throw new AppSafetyError(403, 'APPEAL_ASSIGNMENT_REQUIRED', '只有已领取的独立复核人可以更新复核状态')
  }
  if (Number(appeal.version) !== expectedVersion) {
    throw new AppSafetyError(409, 'APPEAL_VERSION_CONFLICT', '申诉已被更新，请刷新后重试')
  }
  if (FINAL_STATUSES.has(appeal.status)) {
    throw new AppSafetyError(409, 'APPEAL_ALREADY_RESOLVED', '申诉已形成复核结论')
  }
  const currentReviewState = normalizeReviewState(appeal.review_state)
  if (action === 'request_supplement' && currentReviewState === 'needs_escalation') {
    throw new AppSafetyError(409, 'APPEAL_ESCALATION_REQUIRED', '该申诉已升级，不能回退为待补充状态')
  }
  if (action === 'escalate' && currentReviewState === 'needs_escalation') {
    throw new AppSafetyError(409, 'APPEAL_ALREADY_ESCALATED', '该申诉已经升级复核')
  }

  const reviewState: AppAppealReviewState = action === 'request_supplement'
    ? 'evidence_insufficient'
    : 'needs_escalation'
  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  // 补充截止仅复用已经批准并固化到案件的 review_due_at；未批准 SLA 时保持 NULL。
  const supplementDueAt = action === 'request_supplement' ? appeal.review_due_at : null
  const reviewEventId = `are_${crypto.randomUUID().replace(/-/gu, '')}`
  const auditAction = action === 'request_supplement'
    ? 'moderation.appeal.supplement_requested'
    : 'moderation.appeal.escalated'
  const eventType = action === 'request_supplement' ? 'supplement_requested' : 'escalated'
  const targetType = appealKind === 'service' ? 'app_service_appeal' : 'app_safety_appeal'

  const statements: D1PreparedStatement[] = [
    db.prepare(`
      UPDATE ${table}
      SET status = 'investigating', review_state = ?, user_visible_status = 'processing',
          user_visible_message = ?, supplement_due_at = ?,
          version = ?, mutation_token = ?, updated_at = ?
      WHERE id = ? AND version = ? AND assigned_admin_id = ?
        AND status IN ('submitted', 'triaged', 'investigating')
        AND (original_decision_admin_id IS NULL OR original_decision_admin_id <> ?)
    `).bind(
      reviewState,
      userVisibleMessage,
      supplementDueAt,
      nextVersion,
      mutationToken,
      nowIso,
      appealId,
      expectedVersion,
      adminId,
      adminId,
    ),
    db.prepare(`
      INSERT INTO app_appeal_review_events (
        id, appeal_kind, appeal_id, appeal_version, actor_type,
        actor_account_id, actor_admin_id, event_type,
        review_state_from, review_state_to, reason_code,
        user_visible_message, created_at
      )
      SELECT ?, ?, id, version, 'admin', NULL, ?, ?, ?, ?, ?, ?, ?
      FROM ${table}
      WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
    `).bind(
      reviewEventId,
      appealKind,
      adminId,
      eventType,
      currentReviewState,
      reviewState,
      reasonCode,
      userVisibleMessage,
      nowIso,
      appealId,
      nextVersion,
      mutationToken,
      adminId,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, ?, ?, id, ?, ?, ?
      FROM ${table}
      WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
    `).bind(
      crypto.randomUUID(),
      adminId,
      auditAction,
      targetType,
      JSON.stringify({ reviewState: currentReviewState, version: expectedVersion }),
      JSON.stringify({ reviewState, version: nextVersion, reasonCode, supplementDueAt }),
      nowIso,
      appealId,
      nextVersion,
      mutationToken,
      adminId,
    ),
  ]

  statements.push(db.prepare(`
    INSERT INTO app_appeal_review_commands (
      actor_scope, appeal_kind, operation, idempotency_key, request_hash,
      result_id, result_version, created_at
    )
    SELECT ?, ?, ?, ?, ?, id, version, ?
    FROM ${table}
    WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
  `).bind(
    actorScope,
    appealKind,
    operation,
    idempotencyKey,
    requestHash,
    nowIso,
    appealId,
    nextVersion,
    mutationToken,
    adminId,
  ))

  await db.batch(statements)
  const persisted = await findCommand(db, actorScope, operation, idempotencyKey)
  if (!persisted || Number(persisted.result_version) !== nextVersion) {
    throw new AppSafetyError(409, 'APPEAL_VERSION_CONFLICT', '申诉状态已变化，请刷新后重试', true)
  }
  return { appealId, reviewState, version: nextVersion, replayed: false }
}

async function loadReviewState(db: D1Database, table: string, appealId: string) {
  const row = await db.prepare(`SELECT review_state FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(appealId).first<{ review_state: string }>()
  if (!row) throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  return normalizeReviewState(row.review_state)
}

async function findCommand(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT request_hash, result_id, result_version
    FROM app_appeal_review_commands
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ? LIMIT 1
  `).bind(actorScope, operation, idempotencyKey).first<CommandRow>()
}

function normalizeAppealId(value: unknown) {
  if (typeof value !== 'string' || !APPEAL_ID_PATTERN.test(value)) {
    throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  }
  return value
}

function normalizeExpectedVersion(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new AppSafetyError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  return Number(value)
}

function normalizeReasonCode(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!REASON_CODE_PATTERN.test(normalized)) {
    throw new AppSafetyError(400, 'REASON_CODE_INVALID', '原因码必须为 3 至 80 位小写字母、数字或下划线')
  }
  return normalized
}

function normalizeUserVisibleMessage(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 300 || containsControl(normalized)) {
    throw new AppSafetyError(400, 'USER_VISIBLE_MESSAGE_INVALID', '用户可见说明必须为 1 至 300 个字符且不能包含控制字符')
  }
  return normalized
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppSafetyError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return normalized
}

function normalizeReviewState(value: string): AppAppealReviewState {
  if (value === 'normal' || value === 'evidence_insufficient' || value === 'needs_escalation') return value
  return 'normal'
}

function assertCommandHash(row: CommandRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppSafetyError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同申诉操作')
  }
}

function containsControl(value: string) {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point === 0x7f || (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d)
  })
}

async function hashCanonical(value: unknown) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
