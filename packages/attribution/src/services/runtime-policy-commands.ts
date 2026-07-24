import type { AttributionRuntimePolicy } from '../domain/connection'
import { AttributionDomainError } from '../domain/errors'
import { readConnectionAggregate } from '../repositories/connection-repository'

export interface RuntimePromotionHealth {
  activeSnapshotReadable: boolean
  credentialDecryptable: boolean
  queueBound: boolean
  adapterConstructable: boolean
}

export interface RuntimePromotionHealthChecker {
  check(connectionId: string): Promise<RuntimePromotionHealth>
}

export interface RuntimePolicyCommandEnvironment {
  db: D1Database
  health: RuntimePromotionHealthChecker
  now?: () => Date
  idFactory?: (prefix: string) => string
}

export interface RuntimePolicyView {
  connectionId: string
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: 0 | 10 | 50 | 100
  serverEffectivePercentage: 0 | 10 | 50 | 100
  circuitState: 'closed' | 'server_open'
  runtimeGeneration: number
}

interface RuntimeCommandInput {
  connectionId: string
  idempotencyKey: string
  actorId: number
}

export interface SetRuntimePolicyInput extends RuntimeCommandInput {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: 0 | 10 | 50 | 100
}

export type CircuitCommandInput = RuntimeCommandInput

interface CommandReceiptRow {
  request_hash: string
  result_json: string
}

interface DesiredPolicy {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: 0 | 10 | 50 | 100
  serverEffectivePercentage: 0 | 10 | 50 | 100
  circuitState: 'closed' | 'server_open'
}

const encoder = new TextEncoder()
const PERCENTAGES = new Set([0, 10, 50, 100])

export function allRuntimePromotionHealthy(
  health: RuntimePromotionHealth,
): boolean {
  return health.activeSnapshotReadable === true
    && health.credentialDecryptable === true
    && health.queueBound === true
    && health.adapterConstructable === true
}

export async function setRuntimePolicy(
  environment: RuntimePolicyCommandEnvironment,
  input: SetRuntimePolicyInput,
): Promise<RuntimePolicyView> {
  validateRuntimeCommand(input)
  if (
    typeof input.enabled !== 'boolean'
    || typeof input.browserEnabled !== 'boolean'
    || typeof input.serverEnabled !== 'boolean'
    || !PERCENTAGES.has(input.serverTargetPercentage)
  ) {
    throw commandInvalid()
  }

  const requestHash = await hashCommand('setRuntimePolicy', {
    connectionId: input.connectionId,
    enabled: input.enabled,
    browserEnabled: input.browserEnabled,
    serverEnabled: input.serverEnabled,
    serverTargetPercentage: input.serverTargetPercentage,
    actorId: input.actorId,
  })
  const receipt = await readReceipt<RuntimePolicyView>(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (receipt) return receipt

  const aggregate = await requireAggregate(environment, input.connectionId)
  const current = aggregate.runtimePolicy
  let effectivePercentage: 0 | 10 | 50 | 100

  if (
    !input.enabled
    || !input.serverEnabled
    || current.circuitState === 'server_open'
  ) {
    effectivePercentage = 0
  } else if (
    input.serverTargetPercentage <= current.serverEffectivePercentage
  ) {
    effectivePercentage = input.serverTargetPercentage
  } else {
    await requirePromotionHealth(environment, input.connectionId)
    effectivePercentage = input.serverTargetPercentage
  }

  const desired: DesiredPolicy = {
    enabled: input.enabled,
    browserEnabled: input.browserEnabled,
    serverEnabled: input.serverEnabled,
    serverTargetPercentage: input.serverTargetPercentage,
    serverEffectivePercentage: effectivePercentage,
    circuitState: current.circuitState,
  }
  if (policyMatches(current, desired)) {
    return persistNoopReceipt(
      environment,
      input,
      'set_runtime_policy',
      requestHash,
      policyView(input.connectionId, current),
    )
  }

  return writeRuntimePolicy(environment, {
    input,
    current,
    desired,
    requestHash,
    commandType: 'set_runtime_policy',
    outcome: 'updated',
    detail: {
      previousTargetPercentage: current.serverTargetPercentage,
      previousEffectivePercentage: current.serverEffectivePercentage,
      targetPercentage: desired.serverTargetPercentage,
      effectivePercentage: desired.serverEffectivePercentage,
    },
  })
}

export async function openServerCircuit(
  environment: RuntimePolicyCommandEnvironment,
  input: CircuitCommandInput,
): Promise<RuntimePolicyView> {
  validateRuntimeCommand(input)
  const requestHash = await hashCommand('openServerCircuit', {
    connectionId: input.connectionId,
    actorId: input.actorId,
  })
  const receipt = await readReceipt<RuntimePolicyView>(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (receipt) return receipt

  const aggregate = await requireAggregate(environment, input.connectionId)
  const current = aggregate.runtimePolicy
  const desired: DesiredPolicy = {
    enabled: current.enabled,
    browserEnabled: current.browserEnabled,
    serverEnabled: current.serverEnabled,
    serverTargetPercentage: current.serverTargetPercentage,
    serverEffectivePercentage: 0,
    circuitState: 'server_open',
  }
  if (policyMatches(current, desired)) {
    return persistNoopReceipt(
      environment,
      input,
      'open_server_circuit',
      requestHash,
      policyView(input.connectionId, current),
    )
  }

  return writeRuntimePolicy(environment, {
    input,
    current,
    desired,
    requestHash,
    commandType: 'open_server_circuit',
    outcome: 'server_open',
    detail: {
      previousEffectivePercentage: current.serverEffectivePercentage,
    },
  })
}

export async function closeServerCircuit(
  environment: RuntimePolicyCommandEnvironment,
  input: CircuitCommandInput,
): Promise<RuntimePolicyView> {
  validateRuntimeCommand(input)
  const requestHash = await hashCommand('closeServerCircuit', {
    connectionId: input.connectionId,
    actorId: input.actorId,
  })
  const receipt = await readReceipt<RuntimePolicyView>(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (receipt) return receipt

  const aggregate = await requireAggregate(environment, input.connectionId)
  const current = aggregate.runtimePolicy
  if (current.circuitState === 'closed') {
    return persistNoopReceipt(
      environment,
      input,
      'close_server_circuit',
      requestHash,
      policyView(input.connectionId, current),
    )
  }

  const effectivePercentage = current.enabled
    && current.serverEnabled
    && current.serverTargetPercentage > 0
    ? await checkedEffectivePercentage(environment, input.connectionId, current)
    : 0
  const desired: DesiredPolicy = {
    enabled: current.enabled,
    browserEnabled: current.browserEnabled,
    serverEnabled: current.serverEnabled,
    serverTargetPercentage: current.serverTargetPercentage,
    serverEffectivePercentage: effectivePercentage,
    circuitState: 'closed',
  }

  return writeRuntimePolicy(environment, {
    input,
    current,
    desired,
    requestHash,
    commandType: 'close_server_circuit',
    outcome: 'closed',
    detail: {
      restoredEffectivePercentage: effectivePercentage,
    },
  })
}

interface WritePolicyInput {
  input: RuntimeCommandInput
  current: AttributionRuntimePolicy
  desired: DesiredPolicy
  requestHash: string
  commandType: string
  outcome: string
  detail: Record<string, unknown>
}

async function writeRuntimePolicy(
  environment: RuntimePolicyCommandEnvironment,
  command: WritePolicyInput,
): Promise<RuntimePolicyView> {
  const timestamp = validNow(environment.now ?? (() => new Date()))
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const result: RuntimePolicyView = {
    connectionId: command.input.connectionId,
    ...command.desired,
    runtimeGeneration: command.current.runtimeGeneration + 1,
  }

  let batchResults: D1Result<unknown>[]
  try {
    batchResults = await environment.db.batch([
      environment.db.prepare(`
        UPDATE attribution_runtime_policies
        SET enabled = ?,
            browser_enabled = ?,
            server_enabled = ?,
            server_target_percentage = ?,
            server_effective_percentage = ?,
            circuit_state = ?,
            runtime_generation = runtime_generation + 1,
            updated_by = ?,
            updated_at = ?
        WHERE connection_id = ?
          AND runtime_generation = ?
      `).bind(
        command.desired.enabled ? 1 : 0,
        command.desired.browserEnabled ? 1 : 0,
        command.desired.serverEnabled ? 1 : 0,
        command.desired.serverTargetPercentage,
        command.desired.serverEffectivePercentage,
        command.desired.circuitState,
        command.input.actorId,
        timestamp,
        command.input.connectionId,
        command.current.runtimeGeneration,
      ),
      environment.db.prepare(`
        INSERT INTO attribution_audit_logs (
          id, actor_id, command_type, connection_id,
          outcome, detail_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1
      `).bind(
        idFactory('audit'),
        command.input.actorId,
        command.commandType,
        command.input.connectionId,
        command.outcome,
        JSON.stringify(command.detail),
        timestamp,
      ),
      environment.db.prepare(`
        INSERT INTO attribution_command_receipts (
          idempotency_key, command_type, request_hash,
          result_json, created_at
        )
        SELECT ?, ?, ?, ?, ?
        WHERE changes() = 1
      `).bind(
        command.input.idempotencyKey,
        command.commandType,
        command.requestHash,
        JSON.stringify(result),
        timestamp,
      ),
    ])
  } catch {
    const raced = await readReceipt<RuntimePolicyView>(
      environment.db,
      command.input.idempotencyKey,
      command.requestHash,
    )
    if (raced) return raced
    throw commandFailed()
  }

  if (Number(batchResults[0]?.meta.changes ?? 0) !== 1) {
    const raced = await readReceipt<RuntimePolicyView>(
      environment.db,
      command.input.idempotencyKey,
      command.requestHash,
    )
    if (raced) return raced
    throw commandFailed()
  }
  return result
}

async function checkedEffectivePercentage(
  environment: RuntimePolicyCommandEnvironment,
  connectionId: string,
  current: AttributionRuntimePolicy,
): Promise<0 | 10 | 50 | 100> {
  await requirePromotionHealth(environment, connectionId)
  return current.serverTargetPercentage
}

async function requirePromotionHealth(
  environment: RuntimePolicyCommandEnvironment,
  connectionId: string,
): Promise<void> {
  try {
    if (allRuntimePromotionHealthy(await environment.health.check(connectionId))) {
      return
    }
  } catch {
    // 健康检查异常与明确不健康统一阻断，避免部分策略落库。
  }
  throw new AttributionDomainError('ATTRIBUTION_RUNTIME_PROMOTION_BLOCKED')
}

async function requireAggregate(
  environment: RuntimePolicyCommandEnvironment,
  connectionId: string,
) {
  const aggregate = await readConnectionAggregate(environment.db, connectionId)
  if (!aggregate) {
    throw new AttributionDomainError('ATTRIBUTION_CONNECTION_NOT_FOUND')
  }
  return aggregate
}

async function readReceipt<T>(
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
): Promise<T | null> {
  const row = await db.prepare(`
    SELECT request_hash, result_json
    FROM attribution_command_receipts
    WHERE idempotency_key = ?
  `).bind(idempotencyKey).first<CommandReceiptRow>()
  if (!row) return null
  if (row.request_hash !== requestHash) {
    throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  }
  try {
    return JSON.parse(row.result_json) as T
  } catch {
    throw commandFailed()
  }
}

async function persistNoopReceipt<T>(
  environment: RuntimePolicyCommandEnvironment,
  input: RuntimeCommandInput,
  commandType: string,
  requestHash: string,
  result: T,
): Promise<T> {
  const timestamp = validNow(environment.now ?? (() => new Date()))
  try {
    const write = await environment.db.prepare(`
      INSERT INTO attribution_command_receipts (
        idempotency_key, command_type, request_hash,
        result_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      input.idempotencyKey,
      commandType,
      requestHash,
      JSON.stringify(result),
      timestamp,
    ).run()
    if (Number(write.meta.changes ?? 0) === 1) return result
  } catch {
    const raced = await readReceipt<T>(
      environment.db,
      input.idempotencyKey,
      requestHash,
    )
    if (raced) return raced
    throw commandFailed()
  }
  const raced = await readReceipt<T>(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (raced) return raced
  throw commandFailed()
}

function policyMatches(
  current: AttributionRuntimePolicy,
  desired: DesiredPolicy,
): boolean {
  return current.enabled === desired.enabled
    && current.browserEnabled === desired.browserEnabled
    && current.serverEnabled === desired.serverEnabled
    && current.serverTargetPercentage === desired.serverTargetPercentage
    && current.serverEffectivePercentage
      === desired.serverEffectivePercentage
    && current.circuitState === desired.circuitState
}

function policyView(
  connectionId: string,
  policy: AttributionRuntimePolicy,
): RuntimePolicyView {
  return {
    connectionId,
    enabled: policy.enabled,
    browserEnabled: policy.browserEnabled,
    serverEnabled: policy.serverEnabled,
    serverTargetPercentage: policy.serverTargetPercentage,
    serverEffectivePercentage: policy.serverEffectivePercentage,
    circuitState: policy.circuitState,
    runtimeGeneration: policy.runtimeGeneration,
  }
}

async function hashCommand(
  commandType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(JSON.stringify({ commandType, payload })),
  )
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function validateRuntimeCommand(input: RuntimeCommandInput): void {
  if (
    !isIdentifier(input.connectionId)
    || !isIdentifier(input.idempotencyKey)
    || !Number.isSafeInteger(input.actorId)
    || input.actorId < 1
  ) {
    throw commandInvalid()
  }
}

function validNow(now: () => Date): string {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw commandInvalid()
  return value.toISOString()
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function commandInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_COMMAND_INVALID')
}

function commandFailed(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_COMMAND_FAILED')
}
