import type {
  AttributionProvider,
  ConnectionVersionStatus,
} from '@meigallery/shared'
import type {
  AttributionCandidateBindingInput,
  AttributionConnectionAggregate,
  AttributionConnectionVersion,
  AttributionRuntimePolicy,
} from '../domain/connection'
import { AttributionDomainError } from '../domain/errors'
import {
  hashCandidateIdentity,
  normalizeCandidateInput,
} from '../domain/normalization'
import { readConnectionAggregate } from '../repositories/connection-repository'
import {
  fingerprintCredential,
  sealCredential,
} from './credential-vault'

export interface ConnectionView {
  id: string
  provider: AttributionProvider
  name: string
  isDefault: boolean
  activeVersionId: string | null
}

export interface CandidateView {
  id: string
  connectionId: string
  provider: AttributionProvider
  status: ConnectionVersionStatus
  configHash: string
  baseActiveVersionId: string | null
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

interface CommandInput {
  idempotencyKey: string
  actorId: number
}

export interface CreateConnectionInput extends CommandInput {
  id: string
  provider: AttributionProvider
  name: string
  isDefault: boolean
}

export interface CreateCandidateInput extends CommandInput {
  connectionId: string
  publicConfig: Record<string, string>
  bindings: readonly AttributionCandidateBindingInput[]
  credential: string
}

export interface BeginValidationInput extends CommandInput {
  connectionId: string
  candidateId: string
}

export type MarkReadyInput = BeginValidationInput

export interface ActivateCandidateInput extends CommandInput {
  connectionId: string
  candidateId: string
  expectedBaseActiveVersionId: string | null
}

export interface RollbackInput extends CommandInput {
  connectionId: string
  targetVersionId: string
  expectedActiveVersionId: string
}

export interface DisableConnectionInput extends CommandInput {
  connectionId: string
}

export interface AttributionConnectionCommands {
  createConnection(input: CreateConnectionInput): Promise<ConnectionView>
  createCandidate(input: CreateCandidateInput): Promise<CandidateView>
  beginCandidateValidation(input: BeginValidationInput): Promise<CandidateView>
  markCandidateReady(input: MarkReadyInput): Promise<CandidateView>
  activateCandidate(input: ActivateCandidateInput): Promise<ConnectionView>
  rollbackActiveVersion(input: RollbackInput): Promise<ConnectionView>
  disableConnection(input: DisableConnectionInput): Promise<RuntimePolicyView>
}

interface CommandOptions {
  db: D1Database
  credentialKeys: {
    current: string
    previous?: string
  }
  now?: () => Date
  idFactory?: (prefix: string) => string
}

interface CommandReceiptRow {
  request_hash: string
  result_json: string
}

interface RollbackTargetRow {
  id: string
  connection_id: string
  provider: string
  status: string
  credential_version_id: string | null
}

const encoder = new TextEncoder()
const TRANSITIONS = new Set<string>([
  'candidate:validating',
  'candidate:superseded',
  'candidate:failed',
  'validating:ready',
  'validating:superseded',
  'validating:failed',
  'ready:active',
  'ready:superseded',
  'ready:failed',
  'active:draining',
  'draining:retired',
])

export function canTransitionConnectionVersion(
  from: ConnectionVersionStatus,
  to: ConnectionVersionStatus,
): boolean {
  return TRANSITIONS.has(`${from}:${to}`)
}

export function createAttributionConnectionCommands(
  options: CommandOptions,
): AttributionConnectionCommands {
  const db = options.db
  const now = options.now ?? (() => new Date())
  const idFactory = options.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)

  return {
    createConnection,
    createCandidate,
    beginCandidateValidation: input =>
      transitionCandidate(input, 'candidate', 'validating'),
    markCandidateReady: input =>
      transitionCandidate(input, 'validating', 'ready'),
    activateCandidate,
    rollbackActiveVersion,
    disableConnection,
  }

  async function createConnection(
    input: CreateConnectionInput,
  ): Promise<ConnectionView> {
    validateCommandInput(input)
    if (
      !isIdentifier(input.id)
      || !isText(input.name)
      || !['meta', 'tiktok', 'google'].includes(input.provider)
      || typeof input.isDefault !== 'boolean'
    ) {
      throw commandInvalid()
    }

    const requestHash = await hashCommand('createConnection', {
      id: input.id,
      provider: input.provider,
      name: input.name.trim(),
      isDefault: input.isDefault,
    })
    const receipt = await readReceipt<ConnectionView>(
      input.idempotencyKey,
      requestHash,
    )
    if (receipt) return receipt

    const existing = await readConnectionAggregate(db, input.id)
    if (existing) {
      const view = connectionView(existing)
      if (
        view.provider === input.provider
        && view.name === input.name.trim()
        && view.isDefault === input.isDefault
      ) return view
      throw commandInvalid()
    }

    const result: ConnectionView = {
      id: input.id,
      provider: input.provider,
      name: input.name.trim(),
      isDefault: input.isDefault,
      activeVersionId: null,
    }
    const timestamp = validNow(now)
    const auditId = idFactory('audit')

    try {
      await db.batch([
        db.prepare(`
          INSERT INTO attribution_connections (
            id, provider, name, is_default, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          result.id,
          result.provider,
          result.name,
          result.isDefault ? 1 : 0,
          timestamp,
          timestamp,
        ),
        db.prepare(`
          INSERT INTO attribution_runtime_policies (
            connection_id, enabled, browser_enabled, server_enabled,
            server_target_percentage, server_effective_percentage,
            circuit_state, runtime_generation, updated_by, updated_at
          ) VALUES (?, 0, 1, 1, 0, 0, 'closed', 1, ?, ?)
        `).bind(result.id, input.actorId, timestamp),
        auditStatement(db, {
          id: auditId,
          actorId: input.actorId,
          commandType: 'create_connection',
          connectionId: result.id,
          outcome: 'created',
          detail: {
            provider: result.provider,
            isDefault: result.isDefault,
          },
          timestamp,
        }),
        receiptStatement(
          db,
          input.idempotencyKey,
          'create_connection',
          requestHash,
          result,
          timestamp,
        ),
      ])
    } catch (error) {
      if (
        input.isDefault
        && errorMessage(error).includes(
          'UNIQUE constraint failed: attribution_connections.provider',
        )
      ) {
        throw new AttributionDomainError(
          'ATTRIBUTION_DEFAULT_CONNECTION_CONFLICT',
        )
      }
      throw commandFailed()
    }

    return result
  }

  async function createCandidate(
    input: CreateCandidateInput,
  ): Promise<CandidateView> {
    validateCommandInput(input)
    if (!isIdentifier(input.connectionId) || !input.credential) {
      throw commandInvalid()
    }

    const aggregate = await requireAggregate(input.connectionId)
    const credentialFingerprint = await fingerprintCredential(
      input.credential,
    )
    const normalized = normalizeCandidateInput({
      provider: aggregate.connection.provider,
      publicConfig: input.publicConfig,
      bindings: input.bindings,
      credentialFingerprint,
    })
    const requestHash = await hashCandidateIdentity(normalized)

    if (aggregate.activeVersion?.configHash === requestHash) {
      return candidateView(aggregate.activeVersion)
    }
    if (aggregate.liveCandidate?.configHash === requestHash) {
      return candidateView(aggregate.liveCandidate)
    }

    const receipt = await readReceipt<CandidateView>(
      input.idempotencyKey,
      requestHash,
    )
    if (receipt) return receipt

    const versionId = idFactory('version')
    const timestamp = validNow(now)
    const envelope = await sealCredential(
      { current: options.credentialKeys.current },
      {
        versionId,
        provider: aggregate.connection.provider,
        plaintext: input.credential,
      },
    )
    const result: CandidateView = {
      id: versionId,
      connectionId: aggregate.connection.id,
      provider: aggregate.connection.provider,
      status: 'candidate',
      configHash: requestHash,
      baseActiveVersionId: aggregate.connection.activeVersionId,
    }

    const statements: D1PreparedStatement[] = []
    if (aggregate.liveCandidate) {
      statements.push(
        db.prepare(`
          UPDATE attribution_connection_versions
          SET status = 'superseded'
          WHERE id = ?
            AND status IN ('candidate','validating','ready')
        `).bind(aggregate.liveCandidate.id),
        db.prepare(`
          DELETE FROM attribution_version_credentials
          WHERE version_id = ?
        `).bind(aggregate.liveCandidate.id),
      )
    }
    statements.push(
      db.prepare(`
        INSERT INTO attribution_connection_versions (
          id, connection_id, provider, base_active_version_id, status,
          public_config_json, config_hash, created_by, created_at
        ) VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?, ?)
      `).bind(
        result.id,
        result.connectionId,
        result.provider,
        result.baseActiveVersionId,
        JSON.stringify(normalized.publicConfig),
        result.configHash,
        input.actorId,
        timestamp,
      ),
      db.prepare(`
        INSERT INTO attribution_version_credentials (
          version_id, provider, schema_version, key_id, iv, ciphertext,
          tag, credential_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        result.id,
        result.provider,
        envelope.schemaVersion,
        envelope.keyId,
        envelope.iv,
        envelope.ciphertext,
        envelope.tag,
        envelope.fingerprint,
      ),
      ...normalized.bindings.map(binding => db.prepare(`
        INSERT INTO attribution_version_bindings (
          version_id, canonical_event, enabled,
          browser_destination, server_destination
        ) VALUES (?, ?, ?, ?, ?)
      `).bind(
        result.id,
        binding.canonicalEvent,
        binding.enabled ? 1 : 0,
        binding.browserDestination,
        binding.serverDestination,
      )),
      auditStatement(db, {
        id: idFactory('audit'),
        actorId: input.actorId,
        commandType: 'create_candidate',
        connectionId: result.connectionId,
        outcome: 'candidate',
        detail: {
          versionId: result.id,
          configHash: result.configHash,
          supersededVersionId: aggregate.liveCandidate?.id ?? null,
        },
        timestamp,
      }),
      receiptStatement(
        db,
        input.idempotencyKey,
        'create_candidate',
        requestHash,
        result,
        timestamp,
      ),
    )

    try {
      await db.batch(statements)
    } catch {
      throw commandFailed()
    }
    return result
  }

  async function transitionCandidate(
    input: BeginValidationInput,
    expectedStatus: ConnectionVersionStatus,
    targetStatus: ConnectionVersionStatus,
  ): Promise<CandidateView> {
    validateCommandInput(input)
    if (
      !isIdentifier(input.connectionId)
      || !isIdentifier(input.candidateId)
    ) {
      throw commandInvalid()
    }

    const requestHash = await hashCommand('transitionCandidate', {
      connectionId: input.connectionId,
      candidateId: input.candidateId,
      expectedStatus,
      targetStatus,
    })
    const receipt = await readReceipt<CandidateView>(
      input.idempotencyKey,
      requestHash,
    )
    if (receipt) return receipt

    const aggregate = await requireAggregate(input.connectionId)
    const candidate = aggregate.liveCandidate
    if (!candidate || candidate.id !== input.candidateId) {
      throw versionStateInvalid()
    }
    if (candidate.status === targetStatus) return candidateView(candidate)
    if (
      candidate.status !== expectedStatus
      || !canTransitionConnectionVersion(candidate.status, targetStatus)
    ) {
      throw versionStateInvalid()
    }

    const result: CandidateView = {
      ...candidateView(candidate),
      status: targetStatus,
    }
    const timestamp = validNow(now)
    const timestampColumn = targetStatus === 'ready'
      ? ', validated_at = ?'
      : ''
    const updateBindings = targetStatus === 'ready'
      ? [timestamp, candidate.id, expectedStatus]
      : [candidate.id, expectedStatus]
    const batchResults = await db.batch([
      db.prepare(`
        UPDATE attribution_connection_versions
        SET status = ?${timestampColumn}
        WHERE id = ? AND status = ?
      `).bind(targetStatus, ...updateBindings),
      auditStatement(db, {
        id: idFactory('audit'),
        actorId: input.actorId,
        commandType: targetStatus === 'validating'
          ? 'begin_candidate_validation'
          : 'mark_candidate_ready',
        connectionId: input.connectionId,
        outcome: targetStatus,
        detail: { versionId: candidate.id },
        timestamp,
        requirePreviousChange: true,
      }),
      receiptStatement(
        db,
        input.idempotencyKey,
        targetStatus === 'validating'
          ? 'begin_candidate_validation'
          : 'mark_candidate_ready',
        requestHash,
        result,
        timestamp,
        true,
      ),
    ])

    if (Number(batchResults[0]?.meta.changes ?? 0) !== 1) {
      throw versionStateInvalid()
    }
    return result
  }

  async function activateCandidate(
    input: ActivateCandidateInput,
  ): Promise<ConnectionView> {
    validateCommandInput(input)
    if (
      !isIdentifier(input.connectionId)
      || !isIdentifier(input.candidateId)
      || (
        input.expectedBaseActiveVersionId !== null
        && !isIdentifier(input.expectedBaseActiveVersionId)
      )
    ) {
      throw commandInvalid()
    }

    const requestHash = await hashCommand('activateCandidate', {
      connectionId: input.connectionId,
      candidateId: input.candidateId,
      expectedBaseActiveVersionId: input.expectedBaseActiveVersionId,
    })
    const receipt = await readReceipt<ConnectionView>(
      input.idempotencyKey,
      requestHash,
    )
    if (receipt) return receipt

    const aggregate = await requireAggregate(input.connectionId)
    if (aggregate.connection.activeVersionId === input.candidateId) {
      return connectionView(aggregate)
    }
    const candidate = aggregate.liveCandidate
    if (!candidate || candidate.id !== input.candidateId) {
      throw versionStateInvalid()
    }

    const timestamp = validNow(now)
    const result: ConnectionView = {
      ...connectionView(aggregate),
      activeVersionId: candidate.id,
    }
    const statements: D1PreparedStatement[] = [
      db.prepare(`
        INSERT INTO attribution_activation_fences (
          connection_id, candidate_version_id,
          expected_active_version_id, created_at
        ) VALUES (?, ?, ?, ?)
      `).bind(
        input.connectionId,
        input.candidateId,
        input.expectedBaseActiveVersionId,
        timestamp,
      ),
      db.prepare(`
        UPDATE attribution_connection_versions
        SET status = 'retired', retired_at = ?
        WHERE connection_id = ?
          AND status = 'draining'
      `).bind(timestamp, input.connectionId),
    ]
    if (input.expectedBaseActiveVersionId !== null) {
      statements.push(db.prepare(`
        UPDATE attribution_connection_versions
        SET status = 'draining', draining_at = ?
        WHERE id = ? AND connection_id = ? AND status = 'active'
      `).bind(
        timestamp,
        input.expectedBaseActiveVersionId,
        input.connectionId,
      ))
    }
    statements.push(
      db.prepare(`
        UPDATE attribution_connection_versions
        SET status = 'active', activated_at = ?
        WHERE id = ? AND connection_id = ? AND status = 'ready'
      `).bind(timestamp, input.candidateId, input.connectionId),
      db.prepare(`
        UPDATE attribution_connections
        SET active_version_id = ?, updated_at = ?
        WHERE id = ? AND active_version_id IS ?
      `).bind(
        input.candidateId,
        timestamp,
        input.connectionId,
        input.expectedBaseActiveVersionId,
      ),
      auditStatement(db, {
        id: idFactory('audit'),
        actorId: input.actorId,
        commandType: 'activate_candidate',
        connectionId: input.connectionId,
        outcome: 'active',
        detail: {
          versionId: input.candidateId,
          previousActiveVersionId: input.expectedBaseActiveVersionId,
        },
        timestamp,
      }),
      receiptStatement(
        db,
        input.idempotencyKey,
        'activate_candidate',
        requestHash,
        result,
        timestamp,
      ),
      db.prepare(`
        DELETE FROM attribution_activation_fences
        WHERE connection_id = ?
      `).bind(input.connectionId),
    )

    await executeFencedBatch(statements)
    return result
  }

  async function rollbackActiveVersion(
    input: RollbackInput,
  ): Promise<ConnectionView> {
    validateCommandInput(input)
    if (
      !isIdentifier(input.connectionId)
      || !isIdentifier(input.targetVersionId)
      || !isIdentifier(input.expectedActiveVersionId)
    ) {
      throw commandInvalid()
    }

    const requestHash = await hashCommand('rollbackActiveVersion', {
      connectionId: input.connectionId,
      targetVersionId: input.targetVersionId,
      expectedActiveVersionId: input.expectedActiveVersionId,
    })
    const receipt = await readReceipt<ConnectionView>(
      input.idempotencyKey,
      requestHash,
    )
    if (receipt) return receipt

    const aggregate = await requireAggregate(input.connectionId)
    if (aggregate.connection.activeVersionId === input.targetVersionId) {
      return connectionView(aggregate)
    }
    const target = await db.prepare(`
      SELECT
        version.id,
        version.connection_id,
        version.provider,
        version.status,
        credential.version_id AS credential_version_id
      FROM attribution_connection_versions AS version
      LEFT JOIN attribution_version_credentials AS credential
        ON credential.version_id = version.id
      WHERE version.id = ?
    `).bind(input.targetVersionId).first<RollbackTargetRow>()
    if (
      !target
      || target.connection_id !== input.connectionId
      || target.provider !== aggregate.connection.provider
      || target.status !== 'draining'
      || target.credential_version_id !== target.id
    ) {
      throw versionStateInvalid()
    }

    const timestamp = validNow(now)
    const result: ConnectionView = {
      ...connectionView(aggregate),
      activeVersionId: target.id,
    }
    await executeFencedBatch([
      db.prepare(`
        INSERT INTO attribution_activation_fences (
          connection_id, candidate_version_id,
          expected_active_version_id, created_at
        ) VALUES (?, ?, ?, ?)
      `).bind(
        input.connectionId,
        target.id,
        input.expectedActiveVersionId,
        timestamp,
      ),
      db.prepare(`
        UPDATE attribution_connection_versions
        SET status = 'retired', retired_at = ?
        WHERE id = ? AND connection_id = ? AND status = 'active'
      `).bind(
        timestamp,
        input.expectedActiveVersionId,
        input.connectionId,
      ),
      db.prepare(`
        UPDATE attribution_connection_versions
        SET status = 'active',
            draining_at = NULL,
            retired_at = NULL,
            activated_at = ?
        WHERE id = ? AND connection_id = ? AND status = 'draining'
      `).bind(timestamp, target.id, input.connectionId),
      db.prepare(`
        UPDATE attribution_version_credentials
        SET destroy_after = NULL
        WHERE version_id = ?
      `).bind(target.id),
      db.prepare(`
        UPDATE attribution_connections
        SET active_version_id = ?, updated_at = ?
        WHERE id = ? AND active_version_id IS ?
      `).bind(
        target.id,
        timestamp,
        input.connectionId,
        input.expectedActiveVersionId,
      ),
      auditStatement(db, {
        id: idFactory('audit'),
        actorId: input.actorId,
        commandType: 'rollback_active_version',
        connectionId: input.connectionId,
        outcome: 'active',
        detail: {
          versionId: target.id,
          replacedActiveVersionId: input.expectedActiveVersionId,
        },
        timestamp,
      }),
      receiptStatement(
        db,
        input.idempotencyKey,
        'rollback_active_version',
        requestHash,
        result,
        timestamp,
      ),
      db.prepare(`
        DELETE FROM attribution_activation_fences
        WHERE connection_id = ?
      `).bind(input.connectionId),
    ])
    return result
  }

  async function disableConnection(
    input: DisableConnectionInput,
  ): Promise<RuntimePolicyView> {
    validateCommandInput(input)
    if (!isIdentifier(input.connectionId)) throw commandInvalid()

    const requestHash = await hashCommand('disableConnection', {
      connectionId: input.connectionId,
    })
    const receipt = await readReceipt<RuntimePolicyView>(
      input.idempotencyKey,
      requestHash,
    )
    if (receipt) return receipt

    const aggregate = await requireAggregate(input.connectionId)
    if (!aggregate.runtimePolicy.enabled) {
      return runtimePolicyView(input.connectionId, aggregate.runtimePolicy)
    }

    const timestamp = validNow(now)
    const result: RuntimePolicyView = {
      ...runtimePolicyView(input.connectionId, aggregate.runtimePolicy),
      enabled: false,
      serverEffectivePercentage: 0,
      runtimeGeneration: aggregate.runtimePolicy.runtimeGeneration + 1,
    }
    const batchResults = await db.batch([
      db.prepare(`
        UPDATE attribution_runtime_policies
        SET enabled = 0,
            server_effective_percentage = 0,
            runtime_generation = runtime_generation + 1,
            updated_by = ?,
            updated_at = ?
        WHERE connection_id = ? AND enabled = 1
      `).bind(input.actorId, timestamp, input.connectionId),
      auditStatement(db, {
        id: idFactory('audit'),
        actorId: input.actorId,
        commandType: 'disable_connection',
        connectionId: input.connectionId,
        outcome: 'disabled',
        detail: {
          previousEffectivePercentage:
            aggregate.runtimePolicy.serverEffectivePercentage,
        },
        timestamp,
        requirePreviousChange: true,
      }),
      receiptStatement(
        db,
        input.idempotencyKey,
        'disable_connection',
        requestHash,
        result,
        timestamp,
        true,
      ),
    ])
    if (Number(batchResults[0]?.meta.changes ?? 0) !== 1) {
      throw versionStateInvalid()
    }
    return result
  }

  async function requireAggregate(
    connectionId: string,
  ): Promise<AttributionConnectionAggregate> {
    const aggregate = await readConnectionAggregate(db, connectionId)
    if (!aggregate) {
      throw new AttributionDomainError('ATTRIBUTION_CONNECTION_NOT_FOUND')
    }
    return aggregate
  }

  async function readReceipt<T>(
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

  async function executeFencedBatch(
    statements: D1PreparedStatement[],
  ): Promise<void> {
    try {
      await db.batch(statements)
    } catch (error) {
      if (
        errorMessage(error).includes('ATTRIBUTION_ACTIVE_VERSION_CHANGED')
      ) {
        throw new AttributionDomainError(
          'ATTRIBUTION_ACTIVE_VERSION_CHANGED',
        )
      }
      throw commandFailed()
    }
  }
}

function candidateView(
  version: AttributionConnectionVersion,
): CandidateView {
  return {
    id: version.id,
    connectionId: version.connectionId,
    provider: version.provider,
    status: version.status,
    configHash: version.configHash,
    baseActiveVersionId: version.baseActiveVersionId,
  }
}

function connectionView(
  aggregate: AttributionConnectionAggregate,
): ConnectionView {
  return {
    id: aggregate.connection.id,
    provider: aggregate.connection.provider,
    name: aggregate.connection.name,
    isDefault: aggregate.connection.isDefault,
    activeVersionId: aggregate.connection.activeVersionId,
  }
}

function runtimePolicyView(
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

interface AuditStatementInput {
  id: string
  actorId: number
  commandType: string
  connectionId: string
  outcome: string
  detail: Record<string, unknown>
  timestamp: string
  requirePreviousChange?: boolean
}

function auditStatement(
  db: D1Database,
  input: AuditStatementInput,
): D1PreparedStatement {
  const conditional = input.requirePreviousChange ? ' WHERE changes() = 1' : ''
  return db.prepare(`
    INSERT INTO attribution_audit_logs (
      id, actor_id, command_type, connection_id,
      outcome, detail_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?${conditional}
  `).bind(
    input.id,
    input.actorId,
    input.commandType,
    input.connectionId,
    input.outcome,
    JSON.stringify(input.detail),
    input.timestamp,
  )
}

function receiptStatement(
  db: D1Database,
  idempotencyKey: string,
  commandType: string,
  requestHash: string,
  result: unknown,
  timestamp: string,
  requirePreviousChange = false,
): D1PreparedStatement {
  const conditional = requirePreviousChange ? ' WHERE changes() = 1' : ''
  return db.prepare(`
    INSERT INTO attribution_command_receipts (
      idempotency_key, command_type, request_hash, result_json, created_at
    )
    SELECT ?, ?, ?, ?, ?${conditional}
  `).bind(
    idempotencyKey,
    commandType,
    requestHash,
    JSON.stringify(result),
    timestamp,
  )
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

function validateCommandInput(input: CommandInput): void {
  if (
    !isIdentifier(input.idempotencyKey)
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

function isText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 160
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function commandInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_COMMAND_INVALID')
}

function commandFailed(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_COMMAND_FAILED')
}

function versionStateInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_VERSION_STATE_INVALID')
}
