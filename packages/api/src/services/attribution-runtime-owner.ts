export type AttributionRuntimeOwner = 'old' | 'draining' | 'new'

export interface AttributionRuntimeOwnerState {
  owner: AttributionRuntimeOwner
  epoch: number
  changedBy: number | null
  changedAt: string
}

export interface AttributionRuntimeOwnerTransitionInput {
  targetOwner: AttributionRuntimeOwner
  expectedEpoch: number
  actorId: number
  reason: string
  idempotencyKey: string
}

export interface AttributionRuntimeOwnerEnvironment {
  db: D1Database
  now?: () => Date
  idFactory?: (prefix: string) => string
}

interface RuntimeOwnerRow {
  owner: string
  owner_epoch: number
  changed_by: number | null
  changed_at: string
}

interface RuntimeOwnerReceiptRow {
  request_hash: string
  result_json: string
}

const NEXT_OWNER: Readonly<
  Record<AttributionRuntimeOwner, AttributionRuntimeOwner | null>
> = Object.freeze({
  old: 'draining',
  draining: 'new',
  new: null,
})

const OWNER_PATTERN = /^(old|draining|new)$/
const REASON_PATTERN = /^[^\p{Cc}]{4,240}$/u
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,240}$/

export async function readAttributionRuntimeOwner(
  db: D1Database,
): Promise<AttributionRuntimeOwnerState> {
  const row = await db.prepare(`
    SELECT owner, owner_epoch, changed_by, changed_at
    FROM attribution_runtime_cutover
    WHERE id = 'global'
    LIMIT 1
  `).first<RuntimeOwnerRow>()

  if (
    !row
    || !isRuntimeOwner(row.owner)
    || !Number.isSafeInteger(row.owner_epoch)
    || row.owner_epoch < 1
    || (
      row.changed_by !== null
      && (
        !Number.isSafeInteger(row.changed_by)
        || row.changed_by < 1
      )
    )
    || !isCanonicalTimestamp(row.changed_at)
  ) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_STATE_INVALID')
  }

  return {
    owner: row.owner,
    epoch: row.owner_epoch,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  }
}

export async function transitionAttributionRuntimeOwner(
  environment: AttributionRuntimeOwnerEnvironment,
  input: AttributionRuntimeOwnerTransitionInput,
): Promise<AttributionRuntimeOwnerState> {
  validateTransitionInput(input)
  const requestHash = await transitionRequestHash(
    'attribution_runtime_owner_transition',
    input,
  )
  const receipt = await readTransitionReceipt(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (receipt) return receipt
  const current = await readAttributionRuntimeOwner(environment.db)
  if (current.epoch !== input.expectedEpoch) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_EPOCH_CONFLICT')
  }
  if (current.owner === input.targetOwner) {
    return persistOwnerNoop(
      environment,
      input,
      current,
      'attribution_runtime_owner_transition',
      requestHash,
    )
  }
  if (NEXT_OWNER[current.owner] !== input.targetOwner) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_REGRESSION')
  }

  return applyOwnerTransition(
    environment,
    input,
    current,
    'attribution_runtime_owner_transition',
    requestHash,
  )
}

export async function restoreAttributionRuntimeOwner(
  environment: AttributionRuntimeOwnerEnvironment,
  input: Omit<AttributionRuntimeOwnerTransitionInput, 'targetOwner'>,
): Promise<AttributionRuntimeOwnerState> {
  validateTransitionInput({ ...input, targetOwner: 'old' })
  const commandInput = { ...input, targetOwner: 'old' as const }
  const requestHash = await transitionRequestHash(
    'attribution_runtime_owner_restore',
    commandInput,
  )
  const receipt = await readTransitionReceipt(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (receipt) return receipt
  const current = await readAttributionRuntimeOwner(environment.db)
  if (current.epoch !== input.expectedEpoch) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_EPOCH_CONFLICT')
  }
  if (current.owner === 'old') {
    return persistOwnerNoop(
      environment,
      commandInput,
      current,
      'attribution_runtime_owner_restore',
      requestHash,
    )
  }
  return applyOwnerTransition(
    environment,
    commandInput,
    current,
    'attribution_runtime_owner_restore',
    requestHash,
  )
}

export async function assertAttributionRuntimeOwner(
  db: D1Database,
  expected: Pick<AttributionRuntimeOwnerState, 'owner' | 'epoch'>,
): Promise<AttributionRuntimeOwnerState> {
  const current = await readAttributionRuntimeOwner(db)
  if (
    current.owner !== expected.owner
    || current.epoch !== expected.epoch
  ) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_CHANGED')
  }
  return current
}

export function isAttributionForwardingOwner(
  state: AttributionRuntimeOwnerState,
): state is AttributionRuntimeOwnerState & {
  owner: 'draining' | 'new'
} {
  return state.owner === 'draining' || state.owner === 'new'
}

async function applyOwnerTransition(
  environment: AttributionRuntimeOwnerEnvironment,
  input: AttributionRuntimeOwnerTransitionInput,
  current: AttributionRuntimeOwnerState,
  action:
    | 'attribution_runtime_owner_transition'
    | 'attribution_runtime_owner_restore',
  requestHash: string,
): Promise<AttributionRuntimeOwnerState> {
  const changedAt = canonicalTimestamp(
    (environment.now ?? (() => new Date()))(),
  )
  const nextEpoch = current.epoch + 1
  const auditId = (
    environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  )('audit')
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(auditId)) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_INPUT_INVALID')
  }
  const result: AttributionRuntimeOwnerState = {
    owner: input.targetOwner,
    epoch: nextEpoch,
    changedBy: input.actorId,
    changedAt,
  }
  const writeGuard = runtimeOwnerWriteGuard(
    action,
    input.targetOwner,
  )

  const statements = [
    environment.db.prepare(`
      UPDATE attribution_runtime_cutover
      SET owner = ?,
          owner_epoch = ?,
          changed_by = ?,
          changed_at = ?
      WHERE id = 'global'
        AND owner = ?
        AND owner_epoch = ?
        ${writeGuard}
    `).bind(
      input.targetOwner,
      nextEpoch,
      input.actorId,
      changedAt,
      current.owner,
      current.epoch,
    ),
    environment.db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id,
        before_value, after_value, created_at
      )
      SELECT ?, ?, ?, 'attribution_runtime', 'global', ?, ?, ?
      WHERE changes() = 1
    `).bind(
      auditId,
      input.actorId,
      action,
      JSON.stringify({
        owner: current.owner,
        epoch: current.epoch,
      }),
      JSON.stringify({
        owner: input.targetOwner,
        epoch: nextEpoch,
        reason: input.reason.trim(),
      }),
      changedAt,
    ),
    environment.db.prepare(`
      INSERT INTO attribution_runtime_cutover_commands (
        idempotency_key, command_type, request_hash,
        result_json, created_at
      )
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM admin_audit_logs
        WHERE id = ?
      )
    `).bind(
      input.idempotencyKey,
      action,
      requestHash,
      JSON.stringify(result),
      changedAt,
      auditId,
    ),
  ]

  try {
    const outcomes = await environment.db.batch(statements)
    if (
      outcomes.length !== statements.length
      || outcomes.some(outcome =>
        Number(outcome.meta.changes ?? 0) !== 1)
    ) {
      throw ownerError('ATTRIBUTION_RUNTIME_OWNER_WRITE_FAILED')
    }
  } catch (error) {
    const concurrent = await readAttributionRuntimeOwner(environment.db)
    const raced = await readTransitionReceipt(
      environment.db,
      input.idempotencyKey,
      requestHash,
    )
    if (raced) return raced
    if (
      concurrent.owner === current.owner
      && concurrent.epoch === current.epoch
    ) {
      throw ownerError(
        'ATTRIBUTION_RUNTIME_OWNER_PREFLIGHT_CHANGED',
      )
    }
    if (error instanceof AttributionRuntimeOwnerError) throw error
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_WRITE_FAILED')
  }

  return result
}

function runtimeOwnerWriteGuard(
  action:
    | 'attribution_runtime_owner_transition'
    | 'attribution_runtime_owner_restore',
  targetOwner: AttributionRuntimeOwner,
): string {
  if (action === 'attribution_runtime_owner_restore') {
    return `
      AND NOT EXISTS (
        SELECT 1
        FROM attribution_business_outbox
        WHERE routing_owner IN ('draining', 'new')
          AND status IN ('pending', 'dispatching')
      )
    `
  }
  if (targetOwner === 'draining') {
    return `
      AND NOT EXISTS (
        SELECT 1
        FROM attribution_business_outbox
        WHERE routing_owner = 'old'
          AND status IN ('pending', 'dispatching')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM users
        WHERE NOT EXISTS (
          SELECT 1
          FROM attribution_conversion_facts AS fact
          WHERE fact.canonical_event = 'CompleteRegistration'
            AND CAST(json_extract(
              fact.analytics_dimensions_json,
              '$.userId'
            ) AS INTEGER) = users.id
        )
      )
    `
  }
  if (targetOwner === 'new') {
    return `
      AND NOT EXISTS (
        SELECT 1
        FROM attribution_business_outbox
        WHERE routing_owner IN ('old', 'draining', 'new')
          AND status IN ('pending', 'dispatching')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM attribution_deliveries
        WHERE transport = 'server'
          AND (
            status IN (
              'planned',
              'queued',
              'retrying',
              'dead_letter'
            )
            OR (provider = 'google' AND status = 'accepted')
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM attribution_outbox
      )
    `
  }
  return 'AND 0'
}

async function persistOwnerNoop(
  environment: AttributionRuntimeOwnerEnvironment,
  input: AttributionRuntimeOwnerTransitionInput,
  current: AttributionRuntimeOwnerState,
  action:
    | 'attribution_runtime_owner_transition'
    | 'attribution_runtime_owner_restore',
  requestHash: string,
): Promise<AttributionRuntimeOwnerState> {
  const createdAt = canonicalTimestamp(
    (environment.now ?? (() => new Date()))(),
  )
  const auditId = (
    environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  )('audit')
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(auditId)) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_INPUT_INVALID')
  }
  try {
    const outcomes = await environment.db.batch([
      environment.db.prepare(`
        UPDATE attribution_runtime_cutover
        SET changed_at = changed_at
        WHERE id = 'global'
          AND owner = ?
          AND owner_epoch = ?
      `).bind(current.owner, current.epoch),
      environment.db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id,
          before_value, after_value, created_at
        )
        SELECT ?, ?, ?, 'attribution_runtime', 'global', ?, ?, ?
        WHERE changes() = 1
      `).bind(
        auditId,
        input.actorId,
        action,
        JSON.stringify({
          owner: current.owner,
          epoch: current.epoch,
        }),
        JSON.stringify({
          owner: current.owner,
          epoch: current.epoch,
          reason: input.reason.trim(),
          transitionKind: 'noop',
        }),
        createdAt,
      ),
      environment.db.prepare(`
        INSERT INTO attribution_runtime_cutover_commands (
          idempotency_key, command_type, request_hash,
          result_json, created_at
        )
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM admin_audit_logs
          WHERE id = ?
        )
      `).bind(
        input.idempotencyKey,
        action,
        requestHash,
        JSON.stringify(current),
        createdAt,
        auditId,
      ),
    ])
    if (
      outcomes.length !== 3
      || outcomes.some(outcome =>
        Number(outcome.meta.changes ?? 0) !== 1)
    ) {
      throw ownerError('ATTRIBUTION_RUNTIME_OWNER_WRITE_FAILED')
    }
  } catch (error) {
    const raced = await readTransitionReceipt(
      environment.db,
      input.idempotencyKey,
      requestHash,
    )
    if (raced) return raced
    if (error instanceof AttributionRuntimeOwnerError) throw error
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_PREFLIGHT_CHANGED')
  }
  return current
}

function validateTransitionInput(
  input: AttributionRuntimeOwnerTransitionInput,
): void {
  if (
    !isRuntimeOwner(input.targetOwner)
    || !Number.isSafeInteger(input.expectedEpoch)
    || input.expectedEpoch < 1
    || !Number.isSafeInteger(input.actorId)
    || input.actorId < 1
    || typeof input.reason !== 'string'
    || !REASON_PATTERN.test(input.reason.trim())
    || typeof input.idempotencyKey !== 'string'
    || !IDENTIFIER_PATTERN.test(input.idempotencyKey)
  ) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_INPUT_INVALID')
  }
}

async function transitionRequestHash(
  commandType: string,
  input: AttributionRuntimeOwnerTransitionInput,
): Promise<string> {
  const value = JSON.stringify({
    commandType,
    targetOwner: input.targetOwner,
    expectedEpoch: input.expectedEpoch,
    actorId: input.actorId,
    reason: input.reason.trim(),
  })
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function readTransitionReceipt(
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
): Promise<AttributionRuntimeOwnerState | null> {
  const receipt = await db.prepare(`
    SELECT request_hash, result_json
    FROM attribution_runtime_cutover_commands
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(idempotencyKey).first<RuntimeOwnerReceiptRow>()
  if (!receipt) return null
  if (receipt.request_hash !== requestHash) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_IDEMPOTENCY_CONFLICT')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(receipt.result_json)
  } catch {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_STATE_INVALID')
  }
  if (!isRuntimeOwnerState(parsed)) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_STATE_INVALID')
  }
  return parsed
}

function isRuntimeOwnerState(
  value: unknown,
): value is AttributionRuntimeOwnerState {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
  ) {
    return false
  }
  const row = value as Record<string, unknown>
  return isRuntimeOwner(row.owner)
    && Number.isSafeInteger(row.epoch)
    && Number(row.epoch) >= 1
    && (
      row.changedBy === null
      || (
        Number.isSafeInteger(row.changedBy)
        && Number(row.changedBy) >= 1
      )
    )
    && isCanonicalTimestamp(row.changedAt)
}

function isRuntimeOwner(value: unknown): value is AttributionRuntimeOwner {
  return typeof value === 'string' && OWNER_PATTERN.test(value)
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw ownerError('ATTRIBUTION_RUNTIME_OWNER_TIME_INVALID')
  }
  return value.toISOString()
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value
}

export class AttributionRuntimeOwnerError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AttributionRuntimeOwnerError'
  }
}

function ownerError(code: string): AttributionRuntimeOwnerError {
  return new AttributionRuntimeOwnerError(code)
}
