import {
  AppMessagingError,
  findConversationForAdmin,
  hashCanonical,
  normalizeConversationId,
  normalizeIdempotencyKey,
  sha256Hex,
} from './app-messaging'
import {
  requireAdminConversationAssignment,
  type ConversationAssignmentRow,
} from './admin-app-messaging'
import { getAppMessagingRuntimeControl } from './app-safety'

const DEFAULT_NOTE_LIMIT = 30
const MAX_NOTE_LIMIT = 100
const MAX_INTERNAL_NOTE_LENGTH = 1000
const MAX_HANDOFF_NOTE_LENGTH = 500

export type AdminConversationInternalNoteType = 'operation' | 'handoff' | 'quality'
export type AdminConversationTransferReason =
  | 'workload_balance'
  | 'expertise_required'
  | 'shift_handoff'
  | 'supervisor_review'
  | 'other'

export interface AdminConversationInternalNote {
  noteId: string
  conversationId: string
  noteType: AdminConversationInternalNoteType
  text: string
  author: {
    adminId: number
    displayName: string
  }
  createdAt: string
}

export interface AdminConversationOperator {
  adminId: number
  displayName: string
  role: 'admin' | 'owner'
  isCurrentAdmin: boolean
  activeAssignmentCount: number
  capacityLimit: number
  canReceiveTransfer: boolean
}

export interface AdminConversationTransfer {
  transferId: string
  conversationId: string
  assignmentVersion: number
  fromOperator: {
    adminId: number
    displayName: string
  }
  toOperator: {
    adminId: number
    displayName: string
  }
  reasonCode: AdminConversationTransferReason
  hasHandoffNote: boolean
  leaseExpiresAt: string
  createdAt: string
}

export interface AdminCreateConversationInternalNoteInput {
  noteType?: unknown
  text?: unknown
}

export interface AdminTransferConversationInput {
  targetAdminId?: unknown
  expectedAssignmentVersion?: unknown
  reasonCode?: unknown
  handoffNote?: unknown
}

type InternalNoteRow = {
  id: string
  conversation_id: string
  note_type: string
  body_text: string
  author_admin_id: number
  author_nickname: string | null
  author_username: string | null
  author_role: string
  created_at: string
}

type OperatorRow = {
  id: number
  nickname: string | null
  username: string | null
  role: string
  active_assignment_count: number
  capacity_limit: number
}

type TransferRow = {
  id: string
  conversation_id: string
  assignment_version: number
  from_admin_id: number
  from_nickname: string | null
  from_username: string | null
  from_role: string
  to_admin_id: number
  to_nickname: string | null
  to_username: string | null
  to_role: string
  reason_code: string
  handoff_note_id: string | null
  lease_expires_at: string
  created_at: string
}

type CollaborationIdempotencyRow = {
  request_hash: string
  conversation_id: string
  result_id: string
  result_version: number
}

type AssignmentStateRow = {
  assigned_admin_id: number | null
  status: string
  version: number
  lease_expires_at: string | null
}

export function parseAdminConversationInternalNoteLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_NOTE_LIMIT)
    : DEFAULT_NOTE_LIMIT
}

export async function listAdminConversationOperators(
  db: D1Database,
  currentAdminId: number,
  now = new Date(),
): Promise<AdminConversationOperator[]> {
  const result = await db.prepare(`
    SELECT admin.id, admin.nickname, admin.username, admin.role,
           runtime_control.max_active_assignments_per_operator AS capacity_limit,
           (
             SELECT COUNT(*)
             FROM app_conversation_assignment_state assignment
             WHERE assignment.assigned_admin_id = admin.id
               AND assignment.status = 'active'
               AND datetime(assignment.lease_expires_at) > datetime(?)
           ) AS active_assignment_count
    FROM users admin
    CROSS JOIN app_messaging_runtime_controls runtime_control
    WHERE runtime_control.scope = 'global'
      AND admin.status = 'active'
      AND admin.role IN ('admin', 'owner')
    ORDER BY
      CASE admin.role WHEN 'owner' THEN 0 ELSE 1 END,
      COALESCE(NULLIF(trim(admin.nickname), ''), NULLIF(trim(admin.username), ''), CAST(admin.id AS TEXT)) ASC,
      admin.id ASC
  `).bind(now.toISOString()).all<OperatorRow>()

  return result.results.map((row) => {
    const activeAssignmentCount = Math.max(0, Number(row.active_assignment_count))
    const capacityLimit = Math.max(1, Number(row.capacity_limit))
    return {
      adminId: Number(row.id),
      displayName: operatorDisplayName(row),
      role: row.role === 'owner' ? 'owner' : 'admin',
      isCurrentAdmin: Number(row.id) === currentAdminId,
      activeAssignmentCount,
      capacityLimit,
      canReceiveTransfer: Number(row.id) !== currentAdminId && activeAssignmentCount < capacityLimit,
    }
  })
}

export async function listAdminConversationInternalNotes(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  limit: number,
  requestId: string,
  now = new Date(),
): Promise<{ items: AdminConversationInternalNote[] }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  await requireAdminConversationAssignment(db, adminId, conversationId, now)
  const result = await db.prepare(`
    SELECT note.id, note.conversation_id, note.note_type, note.body_text,
           note.author_admin_id, author.nickname AS author_nickname,
           author.username AS author_username, author.role AS author_role,
           note.created_at
    FROM app_conversation_internal_notes note
    JOIN users author ON author.id = note.author_admin_id
    WHERE note.conversation_id = ?
    ORDER BY note.created_at DESC, note.id DESC
    LIMIT ?
  `).bind(conversationId, limit).all<InternalNoteRow>()

  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app_conversation.internal_notes_access', 'app_conversation', ?, NULL, ?, ?)
  `).bind(
    auditId(),
    adminId,
    conversationId,
    JSON.stringify({ requestId, returnedCount: result.results.length }),
    now.toISOString(),
  ).run()

  return { items: result.results.map(mapInternalNote) }
}

export async function createAdminConversationInternalNote(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  idempotencyKeyValue: string | null,
  body: AdminCreateConversationInternalNoteInput,
  now = new Date(),
): Promise<{ note: AdminConversationInternalNote; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const noteType = normalizeInternalNoteType(body.noteType)
  const text = normalizeRequiredText(body.text, '内部备注', MAX_INTERNAL_NOTE_LENGTH)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ conversationId, noteType, text })
  const assignment = await requireAdminConversationAssignment(db, adminId, conversationId, now)
  const replay = await findCollaborationIdempotency(
    db,
    adminId,
    'internal_note_create',
    idempotencyKey,
  )
  if (replay) {
    assertCollaborationIdempotency(replay, requestHash)
    return {
      note: await getInternalNote(db, conversationId, replay.result_id),
      replayed: true,
    }
  }

  const noteId = prefixedId('cin')
  const bodySha256 = await sha256Hex(text)
  const nowIso = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_conversation_internal_notes (
          id, conversation_id, note_type, body_text, body_sha256,
          body_length, author_admin_id, created_at
        )
        SELECT ?, assignment.conversation_id, ?, ?, ?, ?, ?, ?
        FROM app_conversation_assignment_state assignment
        WHERE assignment.conversation_id = ?
          AND assignment.status = 'active'
          AND assignment.assigned_admin_id = ?
          AND assignment.version = ?
          AND datetime(assignment.lease_expires_at) > datetime(?)
      `).bind(
        noteId,
        noteType,
        text,
        bodySha256,
        text.length,
        adminId,
        nowIso,
        conversationId,
        adminId,
        assignment.version,
        nowIso,
      ),
      db.prepare(`
        INSERT INTO app_conversation_admin_idempotency (
          admin_id, operation, idempotency_key, request_hash,
          conversation_id, result_id, result_version, created_at
        )
        SELECT ?, 'internal_note_create', ?, ?, conversation_id, id, ?, ?
        FROM app_conversation_internal_notes
        WHERE id = ?
      `).bind(
        adminId,
        idempotencyKey,
        requestHash,
        assignment.version,
        nowIso,
        noteId,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation.internal_note_create', 'app_conversation',
               conversation_id, NULL, ?, ?
        FROM app_conversation_internal_notes
        WHERE id = ?
      `).bind(
        auditId(),
        adminId,
        JSON.stringify({
          noteId,
          noteType,
          bodySha256,
          bodyLength: text.length,
          assignmentVersion: assignment.version,
        }),
        nowIso,
        noteId,
      ),
    ])
  }
  catch {
    const concurrent = await findCollaborationIdempotency(
      db,
      adminId,
      'internal_note_create',
      idempotencyKey,
    )
    if (concurrent) {
      assertCollaborationIdempotency(concurrent, requestHash)
      return {
        note: await getInternalNote(db, conversationId, concurrent.result_id),
        replayed: true,
      }
    }
    throw new AppMessagingError(409, 'INTERNAL_NOTE_CONFLICT', '话题分配状态已变化，内部备注未保存，请刷新后重试', true)
  }

  const stored = await findCollaborationIdempotency(
    db,
    adminId,
    'internal_note_create',
    idempotencyKey,
  )
  if (!stored) {
    throw new AppMessagingError(409, 'INTERNAL_NOTE_CONFLICT', '话题分配状态已变化，内部备注未保存，请刷新后重试', true)
  }
  return { note: await getInternalNote(db, conversationId, noteId), replayed: false }
}

export async function transferAdminConversation(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  idempotencyKeyValue: string | null,
  body: AdminTransferConversationInput,
  now = new Date(),
): Promise<{ transfer: AdminConversationTransfer; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const targetAdminId = normalizePositiveInteger(body.targetAdminId, '目标运营人员')
  const expectedAssignmentVersion = normalizePositiveInteger(body.expectedAssignmentVersion, '分配版本')
  const reasonCode = normalizeTransferReason(body.reasonCode)
  const handoffNote = normalizeRequiredText(body.handoffNote, '交接说明', MAX_HANDOFF_NOTE_LENGTH)
  if (targetAdminId === adminId) {
    throw new AppMessagingError(400, 'TRANSFER_TARGET_INVALID', '不能把话题转派给自己')
  }
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({
    conversationId,
    targetAdminId,
    expectedAssignmentVersion,
    reasonCode,
    handoffNote,
  })
  const replay = await findCollaborationIdempotency(
    db,
    adminId,
    'assignment_transfer',
    idempotencyKey,
  )
  if (replay) {
    assertCollaborationIdempotency(replay, requestHash)
    return { transfer: await getTransfer(db, replay.result_id), replayed: true }
  }

  const assignment = await requireAdminConversationAssignment(db, adminId, conversationId, now)
  if (assignment.version !== expectedAssignmentVersion) {
    throw new AppMessagingError(409, 'ASSIGNMENT_VERSION_CONFLICT', '话题分配版本已变化，请刷新后重试', true)
  }
  await requireEligibleTransferTarget(db, targetAdminId)
  const control = await getAppMessagingRuntimeControl(db)
  await requireTargetCapacity(
    db,
    targetAdminId,
    conversationId,
    control.maxActiveAssignmentsPerOperator,
    now,
  )
  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation || conversation.status === 'closed') {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '已关闭话题不能转派')
  }

  const nextVersion = assignment.version + 1
  const mutationToken = crypto.randomUUID()
  const transferId = prefixedId('cte')
  const noteId = prefixedId('cin')
  const handoffSha256 = await sha256Hex(handoffNote)
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(
    now.getTime() + control.assignmentLeaseMinutes * 60_000,
  ).toISOString()

  try {
    await db.batch([
      db.prepare(`
        UPDATE app_conversation_assignment_state
        SET assigned_admin_id = ?, version = ?, lease_expires_at = ?,
            mutation_token = ?, assigned_at = ?, released_at = NULL, updated_at = ?
        WHERE conversation_id = ?
          AND status = 'active'
          AND assigned_admin_id = ?
          AND version = ?
          AND datetime(lease_expires_at) > datetime(?)
          AND EXISTS (
            SELECT 1 FROM users target
            WHERE target.id = ? AND target.status = 'active'
              AND target.role IN ('admin', 'owner')
          )
          AND (
            SELECT COUNT(*) FROM app_conversation_assignment_state target_assignment
            WHERE target_assignment.status = 'active'
              AND target_assignment.assigned_admin_id = ?
              AND target_assignment.conversation_id <> ?
              AND datetime(target_assignment.lease_expires_at) > datetime(?)
          ) < (
            SELECT max_active_assignments_per_operator
            FROM app_messaging_runtime_controls WHERE scope = 'global'
          )
          AND EXISTS (
            SELECT 1 FROM app_conversations conversation
            WHERE conversation.id = ? AND conversation.status <> 'closed'
          )
      `).bind(
        targetAdminId,
        nextVersion,
        leaseExpiresAt,
        mutationToken,
        nowIso,
        nowIso,
        conversationId,
        adminId,
        expectedAssignmentVersion,
        nowIso,
        targetAdminId,
        targetAdminId,
        conversationId,
        nowIso,
        conversationId,
      ),
      db.prepare(`
        INSERT INTO app_conversation_internal_notes (
          id, conversation_id, note_type, body_text, body_sha256,
          body_length, author_admin_id, created_at
        )
        SELECT ?, conversation_id, 'handoff', ?, ?, ?, ?, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ?
          AND assigned_admin_id = ? AND status = 'active'
      `).bind(
        noteId,
        handoffNote,
        handoffSha256,
        handoffNote.length,
        adminId,
        nowIso,
        conversationId,
        nextVersion,
        mutationToken,
        targetAdminId,
      ),
      db.prepare(`
        INSERT INTO app_conversation_transfer_events (
          id, conversation_id, assignment_version, from_admin_id, to_admin_id,
          reason_code, handoff_note_id, lease_expires_at, actor_admin_id, created_at
        )
        SELECT ?, assignment.conversation_id, assignment.version, ?, assignment.assigned_admin_id,
               ?, ?, assignment.lease_expires_at, ?, ?
        FROM app_conversation_assignment_state assignment
        JOIN app_conversation_internal_notes note ON note.id = ?
        WHERE assignment.conversation_id = ? AND assignment.version = ?
          AND assignment.mutation_token = ? AND assignment.assigned_admin_id = ?
          AND assignment.status = 'active' AND note.conversation_id = assignment.conversation_id
      `).bind(
        transferId,
        adminId,
        reasonCode,
        noteId,
        adminId,
        nowIso,
        noteId,
        conversationId,
        nextVersion,
        mutationToken,
        targetAdminId,
      ),
      db.prepare(`
        INSERT INTO app_conversation_admin_idempotency (
          admin_id, operation, idempotency_key, request_hash,
          conversation_id, result_id, result_version, created_at
        )
        SELECT ?, 'assignment_transfer', ?, ?, conversation_id, id, assignment_version, ?
        FROM app_conversation_transfer_events
        WHERE id = ?
      `).bind(adminId, idempotencyKey, requestHash, nowIso, transferId),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation.assignment_transfer', 'app_conversation',
               conversation_id, ?, ?, ?
        FROM app_conversation_transfer_events
        WHERE id = ?
      `).bind(
        auditId(),
        adminId,
        JSON.stringify({
          status: assignment.status,
          version: assignment.version,
          assignedAdminId: adminId,
          leaseExpiresAt: assignment.lease_expires_at,
        }),
        JSON.stringify({
          version: nextVersion,
          assignedAdminId: targetAdminId,
          leaseExpiresAt,
          reasonCode,
          handoffNoteId: noteId,
          handoffBodySha256: handoffSha256,
          handoffBodyLength: handoffNote.length,
        }),
        nowIso,
        transferId,
      ),
    ])
  }
  catch {
    const concurrent = await findCollaborationIdempotency(
      db,
      adminId,
      'assignment_transfer',
      idempotencyKey,
    )
    if (concurrent) {
      assertCollaborationIdempotency(concurrent, requestHash)
      return { transfer: await getTransfer(db, concurrent.result_id), replayed: true }
    }
    await diagnoseTransferFailure(
      db,
      adminId,
      targetAdminId,
      conversationId,
      expectedAssignmentVersion,
      now,
    )
  }

  const stored = await findCollaborationIdempotency(
    db,
    adminId,
    'assignment_transfer',
    idempotencyKey,
  )
  if (!stored) {
    await diagnoseTransferFailure(
      db,
      adminId,
      targetAdminId,
      conversationId,
      expectedAssignmentVersion,
      now,
    )
  }
  return { transfer: await getTransfer(db, transferId), replayed: false }
}

async function getInternalNote(
  db: D1Database,
  conversationId: string,
  noteId: string,
): Promise<AdminConversationInternalNote> {
  const row = await db.prepare(`
    SELECT note.id, note.conversation_id, note.note_type, note.body_text,
           note.author_admin_id, author.nickname AS author_nickname,
           author.username AS author_username, author.role AS author_role,
           note.created_at
    FROM app_conversation_internal_notes note
    JOIN users author ON author.id = note.author_admin_id
    WHERE note.id = ? AND note.conversation_id = ?
    LIMIT 1
  `).bind(noteId, conversationId).first<InternalNoteRow>()
  if (!row) {
    throw new AppMessagingError(409, 'INTERNAL_NOTE_CONFLICT', '内部备注结果暂时无法读取，请刷新后重试', true)
  }
  return mapInternalNote(row)
}

async function getTransfer(db: D1Database, transferId: string): Promise<AdminConversationTransfer> {
  const row = await db.prepare(`
    SELECT transfer.id, transfer.conversation_id, transfer.assignment_version,
           transfer.from_admin_id, source.nickname AS from_nickname,
           source.username AS from_username, source.role AS from_role,
           transfer.to_admin_id, target.nickname AS to_nickname,
           target.username AS to_username, target.role AS to_role,
           transfer.reason_code, transfer.handoff_note_id,
           transfer.lease_expires_at, transfer.created_at
    FROM app_conversation_transfer_events transfer
    JOIN users source ON source.id = transfer.from_admin_id
    JOIN users target ON target.id = transfer.to_admin_id
    WHERE transfer.id = ?
    LIMIT 1
  `).bind(transferId).first<TransferRow>()
  if (!row) {
    throw new AppMessagingError(409, 'ASSIGNMENT_TRANSFER_CONFLICT', '转派结果暂时无法读取，请刷新后重试', true)
  }
  return {
    transferId: row.id,
    conversationId: row.conversation_id,
    assignmentVersion: Number(row.assignment_version),
    fromOperator: {
      adminId: Number(row.from_admin_id),
      displayName: operatorDisplayName({
        id: row.from_admin_id,
        nickname: row.from_nickname,
        username: row.from_username,
        role: row.from_role,
      }),
    },
    toOperator: {
      adminId: Number(row.to_admin_id),
      displayName: operatorDisplayName({
        id: row.to_admin_id,
        nickname: row.to_nickname,
        username: row.to_username,
        role: row.to_role,
      }),
    },
    reasonCode: normalizeTransferReason(row.reason_code),
    hasHandoffNote: Boolean(row.handoff_note_id),
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
  }
}

async function findCollaborationIdempotency(
  db: D1Database,
  adminId: number,
  operation: 'internal_note_create' | 'assignment_transfer',
  idempotencyKey: string,
): Promise<CollaborationIdempotencyRow | null> {
  return db.prepare(`
    SELECT request_hash, conversation_id, result_id, result_version
    FROM app_conversation_admin_idempotency
    WHERE admin_id = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(adminId, operation, idempotencyKey).first<CollaborationIdempotencyRow>()
}

function assertCollaborationIdempotency(
  row: CollaborationIdempotencyRow,
  requestHash: string,
) {
  if (row.request_hash !== requestHash) {
    throw new AppMessagingError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于另一项操作')
  }
}

async function requireEligibleTransferTarget(db: D1Database, targetAdminId: number) {
  const target = await db.prepare(`
    SELECT id
    FROM users
    WHERE id = ? AND status = 'active' AND role IN ('admin', 'owner')
    LIMIT 1
  `).bind(targetAdminId).first<{ id: number }>()
  if (!target) {
    throw new AppMessagingError(400, 'TRANSFER_TARGET_INVALID', '目标运营人员不存在、已停用或没有后台权限')
  }
}

async function requireTargetCapacity(
  db: D1Database,
  targetAdminId: number,
  conversationId: string,
  capacityLimit: number,
  now: Date,
) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_conversation_assignment_state
    WHERE status = 'active' AND assigned_admin_id = ? AND conversation_id <> ?
      AND datetime(lease_expires_at) > datetime(?)
  `).bind(targetAdminId, conversationId, now.toISOString()).first<{ count: number }>()
  if (Number(row?.count ?? 0) >= capacityLimit) {
    throw new AppMessagingError(429, 'TRANSFER_TARGET_CAPACITY_REACHED', '目标运营人员已达到当前处理容量，请选择其他人员')
  }
}

async function diagnoseTransferFailure(
  db: D1Database,
  adminId: number,
  targetAdminId: number,
  conversationId: string,
  expectedVersion: number,
  now: Date,
): Promise<never> {
  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation || conversation.status === 'closed') {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '已关闭话题不能转派')
  }
  const assignment = await db.prepare(`
    SELECT assigned_admin_id, status, version, lease_expires_at
    FROM app_conversation_assignment_state
    WHERE conversation_id = ?
    LIMIT 1
  `).bind(conversationId).first<AssignmentStateRow>()
  if (
    !assignment
    || assignment.status !== 'active'
    || assignment.assigned_admin_id !== adminId
    || assignment.version !== expectedVersion
    || !assignment.lease_expires_at
    || new Date(assignment.lease_expires_at).getTime() <= now.getTime()
  ) {
    throw new AppMessagingError(409, 'ASSIGNMENT_VERSION_CONFLICT', '话题分配状态已变化，请刷新后重试', true)
  }
  await requireEligibleTransferTarget(db, targetAdminId)
  const control = await getAppMessagingRuntimeControl(db)
  await requireTargetCapacity(
    db,
    targetAdminId,
    conversationId,
    control.maxActiveAssignmentsPerOperator,
    now,
  )
  throw new AppMessagingError(409, 'ASSIGNMENT_TRANSFER_CONFLICT', '话题转派发生并发冲突，请刷新后重试', true)
}

function mapInternalNote(row: InternalNoteRow): AdminConversationInternalNote {
  return {
    noteId: row.id,
    conversationId: row.conversation_id,
    noteType: normalizeInternalNoteType(row.note_type),
    text: row.body_text,
    author: {
      adminId: Number(row.author_admin_id),
      displayName: operatorDisplayName({
        id: row.author_admin_id,
        nickname: row.author_nickname,
        username: row.author_username,
        role: row.author_role,
      }),
    },
    createdAt: row.created_at,
  }
}

function operatorDisplayName(row: {
  id: number
  nickname: string | null
  username: string | null
  role: string
}) {
  return row.nickname?.trim()
    || row.username?.trim()
    || `${row.role === 'owner' ? 'Owner' : '运营人员'} #${row.id}`
}

function normalizeInternalNoteType(value: unknown): AdminConversationInternalNoteType {
  if (value === 'operation' || value === 'handoff' || value === 'quality') return value
  throw new AppMessagingError(400, 'INTERNAL_NOTE_TYPE_INVALID', '内部备注类型无效')
}

function normalizeTransferReason(value: unknown): AdminConversationTransferReason {
  if (
    value === 'workload_balance'
    || value === 'expertise_required'
    || value === 'shift_handoff'
    || value === 'supervisor_review'
    || value === 'other'
  ) return value
  throw new AppMessagingError(400, 'TRANSFER_REASON_INVALID', '转派原因无效')
}

function normalizeRequiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new AppMessagingError(400, 'TEXT_REQUIRED', `${label}不能为空`)
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new AppMessagingError(400, 'TEXT_REQUIRED', `${label}不能为空`)
  }
  if (normalized.length > maxLength) {
    throw new AppMessagingError(400, 'TEXT_TOO_LONG', `${label}不能超过 ${maxLength} 个字符`)
  }
  return normalized
}

function normalizePositiveInteger(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppMessagingError(400, 'INTEGER_INVALID', `${label}无效`)
  }
  return parsed
}

function prefixedId(prefix: 'cin' | 'cte') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}

function auditId() {
  return `audit_${crypto.randomUUID().replace(/-/gu, '')}`
}
