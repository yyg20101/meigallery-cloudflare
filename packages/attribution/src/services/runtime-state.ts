import { AttributionDomainError } from '../domain/errors'
import { sha256Hex } from '../security/digest'

export type AttributionRuntimeMode =
  | 'shadow'
  | 'bridge'
  | 'active'
  | 'fenced'

export interface AttributionRuntimeState {
  mode: AttributionRuntimeMode
  activatedAt: string | null
  bridgeOwnerEpoch: number | null
  activeOwnerEpoch: number | null
  fencedOwnerEpoch: number | null
  updatedAt: string
}

export interface AttributionRuntimeReadiness
  extends AttributionRuntimeState {
  migrationReconciled: boolean
  inFlightServerDeliveries: number
}

export interface AttributionRuntimeTransitionCommandInput {
  targetMode: 'bridge' | 'active' | 'fenced'
  sourceOwnerEpoch: number
  actorId: number
  reason: string
  idempotencyKey: string
}

export interface AttributionRuntimeTransitionCommandEnvironment {
  db: D1Database
  now?: () => Date
  idFactory?: (prefix: string) => string
}

interface RuntimeStateRow {
  mode: string
  activated_at: string | null
  bridge_owner_epoch: number | null
  active_owner_epoch: number | null
  fenced_owner_epoch: number | null
  updated_at: string
}

interface CommandReceiptRow {
  request_hash: string
  result_json: string
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,240}$/
const REASON_PATTERN = /^[^\p{Cc}]{4,240}$/u

export async function readAttributionRuntimeState(
  db: D1Database,
): Promise<AttributionRuntimeState> {
  const row = await db.prepare(`
    SELECT mode, activated_at, bridge_owner_epoch,
           active_owner_epoch, fenced_owner_epoch, updated_at
    FROM attribution_runtime_state
    WHERE id = 'global'
    LIMIT 1
  `).first<RuntimeStateRow>()

  if (
    !row
    || !isRuntimeMode(row.mode)
    || !isCanonicalTimestamp(row.updated_at)
    || !validRuntimeStateRow(row)
  ) {
    throw new Error('ATTRIBUTION_RUNTIME_STATE_INVALID')
  }

  return runtimeStateFromRow(row)
}

export async function readAttributionRuntimeReadiness(
  db: D1Database,
): Promise<AttributionRuntimeReadiness> {
  const [state, manifest, inFlight] = await Promise.all([
    readAttributionRuntimeState(db),
    db.prepare(`
      SELECT 1 AS ready
      FROM attribution_migration_manifests
      WHERE status = 'reconciled'
      LIMIT 1
    `).first<{ ready: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS value
      FROM attribution_deliveries
      WHERE transport = 'server'
        AND status = 'retrying'
        AND last_error_code = 'processing'
    `).first<{ value: number }>(),
  ])
  if (
    !Number.isSafeInteger(inFlight?.value)
    || Number(inFlight?.value) < 0
  ) {
    throw new Error('ATTRIBUTION_RUNTIME_STATE_INVALID')
  }
  return {
    ...state,
    migrationReconciled: manifest?.ready === 1,
    inFlightServerDeliveries: Number(inFlight?.value),
  }
}

export async function transitionAttributionRuntimeModeCommand(
  environment: AttributionRuntimeTransitionCommandEnvironment,
  input: AttributionRuntimeTransitionCommandInput,
): Promise<AttributionRuntimeState> {
  validateTransitionCommand(input)
  const requestHash = await sha256Hex(JSON.stringify({
    targetMode: input.targetMode,
    sourceOwnerEpoch: input.sourceOwnerEpoch,
    actorId: input.actorId,
    reason: input.reason.trim(),
  }))
  const receipt = await readTransitionReceipt(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (receipt) return receipt

  const readiness = await readAttributionRuntimeReadiness(environment.db)
  if (!readiness.migrationReconciled) {
    throw new AttributionDomainError(
      'ATTRIBUTION_RUNTIME_MIGRATION_NOT_READY',
    )
  }
  if (
    input.targetMode === 'fenced'
    && readiness.inFlightServerDeliveries > 0
  ) {
    throw new AttributionDomainError(
      'ATTRIBUTION_RUNTIME_IN_FLIGHT_DELIVERY',
    )
  }

  const sameTarget = stateEpochForMode(
    readiness,
    input.targetMode,
  ) === input.sourceOwnerEpoch
    && readiness.mode === input.targetMode
  if (
    readiness.mode === input.targetMode
    && !sameTarget
  ) {
    throw new AttributionDomainError(
      'ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID',
    )
  }
  if (
    !sameTarget
    && !isValidTransition(
      readiness,
      input.targetMode,
      input.sourceOwnerEpoch,
    )
  ) {
    throw new AttributionDomainError(
      isTransitionShapeAllowed(readiness.mode, input.targetMode)
        ? 'ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID'
        : 'ATTRIBUTION_RUNTIME_TRANSITION_INVALID',
    )
  }

  const timestamp = canonicalTimestamp(
    (environment.now ?? (() => new Date()))(),
  )
  const result = sameTarget
    ? readinessToState(readiness)
    : nextRuntimeState(
        readiness,
        input.targetMode,
        input.sourceOwnerEpoch,
        timestamp,
      )
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const auditId = idFactory('audit')
  if (!IDENTIFIER_PATTERN.test(auditId)) {
    throw new AttributionDomainError('ATTRIBUTION_COMMAND_INVALID')
  }

  const stateWrite = sameTarget
    ? environment.db.prepare(`
        UPDATE attribution_runtime_state
        SET updated_at = updated_at
        WHERE id = 'global'
          AND mode = ?
          AND activated_at IS ?
          AND bridge_owner_epoch IS ?
          AND active_owner_epoch IS ?
          AND fenced_owner_epoch IS ?
          AND updated_at = ?
      `).bind(
        readiness.mode,
        readiness.activatedAt,
        readiness.bridgeOwnerEpoch,
        readiness.activeOwnerEpoch,
        readiness.fencedOwnerEpoch,
        readiness.updatedAt,
      )
    : environment.db.prepare(`
        UPDATE attribution_runtime_state
        SET mode = ?,
            activated_at = ?,
            bridge_owner_epoch = ?,
            active_owner_epoch = ?,
            fenced_owner_epoch = ?,
            updated_at = ?
        WHERE id = 'global'
          AND mode = ?
          AND activated_at IS ?
          AND bridge_owner_epoch IS ?
          AND active_owner_epoch IS ?
          AND fenced_owner_epoch IS ?
          AND updated_at = ?
          ${fenceWriteGuard(input.targetMode)}
      `).bind(
        result.mode,
        result.activatedAt,
        result.bridgeOwnerEpoch,
        result.activeOwnerEpoch,
        result.fencedOwnerEpoch,
        result.updatedAt,
        readiness.mode,
        readiness.activatedAt,
        readiness.bridgeOwnerEpoch,
        readiness.activeOwnerEpoch,
        readiness.fencedOwnerEpoch,
        readiness.updatedAt,
      )

  try {
    const outcomes = await environment.db.batch([
      stateWrite,
      environment.db.prepare(`
        INSERT INTO attribution_audit_logs (
          id, actor_id, command_type, connection_id,
          outcome, detail_json, created_at
        )
        SELECT ?, ?, 'transition_runtime_mode', 'global',
               ?, ?, ?
        WHERE changes() = 1
      `).bind(
        auditId,
        input.actorId,
        result.mode,
        JSON.stringify({
          fromMode: readiness.mode,
          toMode: result.mode,
          transitionKind: sameTarget ? 'noop' : 'advance',
          sourceOwnerEpoch: input.sourceOwnerEpoch,
          reason: input.reason.trim(),
        }),
        timestamp,
      ),
      environment.db.prepare(`
        INSERT INTO attribution_command_receipts (
          idempotency_key, command_type, request_hash,
          result_json, created_at
        )
        SELECT ?, 'transition_runtime_mode', ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM attribution_audit_logs
          WHERE id = ?
        )
      `).bind(
        input.idempotencyKey,
        requestHash,
        JSON.stringify(result),
        timestamp,
        auditId,
      ),
    ])
    if (
      outcomes.length !== 3
      || outcomes.some(outcome =>
        Number(outcome.meta.changes ?? 0) !== 1)
    ) {
      throw new AttributionDomainError('ATTRIBUTION_COMMAND_FAILED')
    }
  } catch (error) {
    const raced = await readTransitionReceipt(
      environment.db,
      input.idempotencyKey,
      requestHash,
    )
    if (raced) return raced
    if (error instanceof AttributionDomainError) throw error
    throw new AttributionDomainError('ATTRIBUTION_COMMAND_FAILED')
  }

  return result
}

/**
 * 仅供运行时门禁单元测试使用；生产切换必须走带审计的 command。
 */
export async function transitionAttributionRuntimeMode(
  db: D1Database,
  targetMode: 'bridge' | 'active' | 'fenced',
  input: {
    sourceOwnerEpoch: number
    now?: () => Date
  },
): Promise<AttributionRuntimeState> {
  if (
    !Number.isSafeInteger(input.sourceOwnerEpoch)
    || input.sourceOwnerEpoch < 2
  ) {
    throw new Error('ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID')
  }
  const current = await readAttributionRuntimeState(db)
  if (current.mode === targetMode) {
    if (
      stateEpochForMode(current, targetMode)
      !== input.sourceOwnerEpoch
    ) {
      throw new Error('ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID')
    }
    return current
  }
  if (!isTransitionShapeAllowed(current.mode, targetMode)) {
    throw new Error('ATTRIBUTION_RUNTIME_TRANSITION_INVALID')
  }
  if (
    !isValidTransition(current, targetMode, input.sourceOwnerEpoch)
  ) {
    throw new Error('ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID')
  }

  const timestamp = canonicalTimestamp((input.now ?? (() => new Date()))())
  const next = nextRuntimeState(
    current,
    targetMode,
    input.sourceOwnerEpoch,
    timestamp,
  )
  const result = await db.prepare(`
    UPDATE attribution_runtime_state
    SET mode = ?,
        activated_at = ?,
        bridge_owner_epoch = ?,
        active_owner_epoch = ?,
        fenced_owner_epoch = ?,
        updated_at = ?
    WHERE id = 'global'
      AND mode = ?
      AND activated_at IS ?
      AND bridge_owner_epoch IS ?
      AND active_owner_epoch IS ?
      AND fenced_owner_epoch IS ?
      AND updated_at = ?
      ${fenceWriteGuard(targetMode)}
  `).bind(
    next.mode,
    next.activatedAt,
    next.bridgeOwnerEpoch,
    next.activeOwnerEpoch,
    next.fencedOwnerEpoch,
    next.updatedAt,
    current.mode,
    current.activatedAt,
    current.bridgeOwnerEpoch,
    current.activeOwnerEpoch,
    current.fencedOwnerEpoch,
    current.updatedAt,
  ).run()

  if (Number(result.meta.changes ?? 0) !== 1) {
    const concurrent = await readAttributionRuntimeState(db)
    if (
      concurrent.mode === targetMode
      && stateEpochForMode(concurrent, targetMode)
        === input.sourceOwnerEpoch
    ) return concurrent
    throw new Error('ATTRIBUTION_RUNTIME_TRANSITION_CONFLICT')
  }
  return readAttributionRuntimeState(db)
}

function nextRuntimeState(
  current: AttributionRuntimeState,
  targetMode: 'bridge' | 'active' | 'fenced',
  sourceOwnerEpoch: number,
  timestamp: string,
): AttributionRuntimeState {
  if (targetMode === 'bridge') {
    return {
      mode: 'bridge',
      activatedAt: null,
      bridgeOwnerEpoch: sourceOwnerEpoch,
      activeOwnerEpoch: null,
      fencedOwnerEpoch: null,
      updatedAt: timestamp,
    }
  }
  if (targetMode === 'active') {
    return {
      mode: 'active',
      activatedAt: timestamp,
      bridgeOwnerEpoch: current.bridgeOwnerEpoch,
      activeOwnerEpoch: sourceOwnerEpoch,
      fencedOwnerEpoch: null,
      updatedAt: timestamp,
    }
  }
  return {
    mode: 'fenced',
    activatedAt: null,
    bridgeOwnerEpoch: null,
    activeOwnerEpoch: null,
    fencedOwnerEpoch: sourceOwnerEpoch,
    updatedAt: timestamp,
  }
}

function isValidTransition(
  current: AttributionRuntimeState,
  targetMode: 'bridge' | 'active' | 'fenced',
  sourceOwnerEpoch: number,
): boolean {
  if (!isTransitionShapeAllowed(current.mode, targetMode)) return false
  if (targetMode === 'bridge') {
    return current.mode === 'shadow'
      ? sourceOwnerEpoch === 2
      : sourceOwnerEpoch === Number(current.fencedOwnerEpoch) + 1
  }
  if (targetMode === 'active') {
    return sourceOwnerEpoch === Number(current.bridgeOwnerEpoch) + 1
  }
  if (current.mode === 'bridge') {
    return sourceOwnerEpoch === Number(current.bridgeOwnerEpoch) + 1
  }
  return sourceOwnerEpoch === current.activeOwnerEpoch
    || sourceOwnerEpoch === Number(current.activeOwnerEpoch) + 1
}

function isTransitionShapeAllowed(
  currentMode: AttributionRuntimeMode,
  targetMode: 'bridge' | 'active' | 'fenced',
): boolean {
  return (
    (currentMode === 'shadow' && targetMode === 'bridge')
    || (currentMode === 'fenced' && targetMode === 'bridge')
    || (currentMode === 'bridge' && targetMode === 'active')
    || (
      (currentMode === 'bridge' || currentMode === 'active')
      && targetMode === 'fenced'
    )
  )
}

function stateEpochForMode(
  state: AttributionRuntimeState,
  mode: 'bridge' | 'active' | 'fenced',
): number | null {
  if (mode === 'bridge') return state.bridgeOwnerEpoch
  if (mode === 'active') return state.activeOwnerEpoch
  return state.fencedOwnerEpoch
}

function fenceWriteGuard(
  targetMode: 'bridge' | 'active' | 'fenced',
): string {
  return targetMode === 'fenced'
    ? `
      AND NOT EXISTS (
        SELECT 1
        FROM attribution_deliveries
        WHERE transport = 'server'
          AND status = 'retrying'
          AND last_error_code = 'processing'
      )
    `
    : ''
}

async function readTransitionReceipt(
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
): Promise<AttributionRuntimeState | null> {
  const receipt = await db.prepare(`
    SELECT request_hash, result_json
    FROM attribution_command_receipts
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(idempotencyKey).first<CommandReceiptRow>()
  if (!receipt) return null
  if (receipt.request_hash !== requestHash) {
    throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(receipt.result_json)
  } catch {
    throw new AttributionDomainError('ATTRIBUTION_COMMAND_FAILED')
  }
  if (!isRuntimeStateValue(parsed)) {
    throw new AttributionDomainError('ATTRIBUTION_COMMAND_FAILED')
  }
  return parsed
}

function validateTransitionCommand(
  input: AttributionRuntimeTransitionCommandInput,
): void {
  if (
    (
      input.targetMode !== 'bridge'
      && input.targetMode !== 'active'
      && input.targetMode !== 'fenced'
    )
    || !Number.isSafeInteger(input.sourceOwnerEpoch)
    || input.sourceOwnerEpoch < 2
    || !Number.isSafeInteger(input.actorId)
    || input.actorId < 1
    || typeof input.reason !== 'string'
    || !REASON_PATTERN.test(input.reason.trim())
    || typeof input.idempotencyKey !== 'string'
    || !IDENTIFIER_PATTERN.test(input.idempotencyKey)
  ) {
    throw new AttributionDomainError('ATTRIBUTION_COMMAND_INVALID')
  }
}

function runtimeStateFromRow(
  row: RuntimeStateRow,
): AttributionRuntimeState {
  return {
    mode: row.mode as AttributionRuntimeMode,
    activatedAt: row.activated_at,
    bridgeOwnerEpoch: row.bridge_owner_epoch,
    activeOwnerEpoch: row.active_owner_epoch,
    fencedOwnerEpoch: row.fenced_owner_epoch,
    updatedAt: row.updated_at,
  }
}

function readinessToState(
  readiness: AttributionRuntimeReadiness,
): AttributionRuntimeState {
  return {
    mode: readiness.mode,
    activatedAt: readiness.activatedAt,
    bridgeOwnerEpoch: readiness.bridgeOwnerEpoch,
    activeOwnerEpoch: readiness.activeOwnerEpoch,
    fencedOwnerEpoch: readiness.fencedOwnerEpoch,
    updatedAt: readiness.updatedAt,
  }
}

function isRuntimeStateValue(
  value: unknown,
): value is AttributionRuntimeState {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
  ) {
    return false
  }
  const row = value as Record<string, unknown>
  if (
    !isRuntimeMode(String(row.mode))
    || !isCanonicalTimestamp(row.updatedAt)
  ) {
    return false
  }
  return validRuntimeStateShape({
    mode: row.mode as AttributionRuntimeMode,
    activatedAt: row.activatedAt,
    bridgeOwnerEpoch: row.bridgeOwnerEpoch,
    activeOwnerEpoch: row.activeOwnerEpoch,
    fencedOwnerEpoch: row.fencedOwnerEpoch,
  })
}

function validRuntimeStateRow(row: RuntimeStateRow): boolean {
  return validRuntimeStateShape({
    mode: row.mode as AttributionRuntimeMode,
    activatedAt: row.activated_at,
    bridgeOwnerEpoch: row.bridge_owner_epoch,
    activeOwnerEpoch: row.active_owner_epoch,
    fencedOwnerEpoch: row.fenced_owner_epoch,
  })
}

function validRuntimeStateShape(input: {
  mode: AttributionRuntimeMode
  activatedAt: unknown
  bridgeOwnerEpoch: unknown
  activeOwnerEpoch: unknown
  fencedOwnerEpoch: unknown
}): boolean {
  if (input.mode === 'shadow') {
    return input.activatedAt === null
      && input.bridgeOwnerEpoch === null
      && input.activeOwnerEpoch === null
      && input.fencedOwnerEpoch === null
  }
  if (input.mode === 'bridge') {
    return input.activatedAt === null
      && validEpoch(input.bridgeOwnerEpoch, 2)
      && input.activeOwnerEpoch === null
      && input.fencedOwnerEpoch === null
  }
  if (input.mode === 'active') {
    return isCanonicalTimestamp(input.activatedAt)
      && validEpoch(input.bridgeOwnerEpoch, 2)
      && validEpoch(input.activeOwnerEpoch, 3)
      && Number(input.activeOwnerEpoch)
        === Number(input.bridgeOwnerEpoch) + 1
      && input.fencedOwnerEpoch === null
  }
  return input.activatedAt === null
    && input.bridgeOwnerEpoch === null
    && input.activeOwnerEpoch === null
    && validEpoch(input.fencedOwnerEpoch, 3)
}

function validEpoch(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum
}

function isRuntimeMode(value: string): value is AttributionRuntimeMode {
  return value === 'shadow'
    || value === 'bridge'
    || value === 'active'
    || value === 'fenced'
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('ATTRIBUTION_RUNTIME_TIMESTAMP_INVALID')
  }
  return value.toISOString()
}
