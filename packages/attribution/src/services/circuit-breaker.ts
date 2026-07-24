import type { AttributionProvider } from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'

export interface CircuitBreakerEnvironment {
  db: D1Database
  now?: () => Date
  idFactory?: (prefix: string) => string
}

export interface CircuitBreakerInput {
  connectionId: string
  provider: AttributionProvider
}

export interface OpenCircuitInput extends CircuitBreakerInput {
  code: string
}

export interface CircuitFailureResult {
  consecutiveFailures: number
  opened: boolean
}

interface PolicyRow {
  provider: string
  circuit_state: string
}

interface ObservationRow {
  consecutive_transient_failures: number
}

const FAILURE_THRESHOLD = 5
const FAILURE_WINDOW_MS = 15 * 60 * 1_000
const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])

export async function recordTransientFailure(
  environment: CircuitBreakerEnvironment,
  input: CircuitBreakerInput,
): Promise<CircuitFailureResult> {
  validateInput(input)
  const now = trustedNow(environment)
  const policy = await requirePolicy(environment.db, input)
  if (policy.circuit_state === 'server_open') {
    return {
      consecutiveFailures: await currentFailureCount(
        environment.db,
        input.connectionId,
      ),
      opened: true,
    }
  }

  const cutoff = new Date(now.getTime() - FAILURE_WINDOW_MS).toISOString()
  try {
    await environment.db.prepare(`
      INSERT INTO attribution_circuit_observations (
        connection_id, consecutive_transient_failures,
        window_started_at, last_failure_at, opened_at, updated_at
      ) VALUES (?, 1, ?, ?, NULL, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        consecutive_transient_failures = CASE
          WHEN attribution_circuit_observations.opened_at IS NOT NULL
            OR attribution_circuit_observations.last_failure_at IS NULL
            OR attribution_circuit_observations.last_failure_at <= ?
          THEN 1
          ELSE attribution_circuit_observations
            .consecutive_transient_failures + 1
        END,
        window_started_at = CASE
          WHEN attribution_circuit_observations.opened_at IS NOT NULL
            OR attribution_circuit_observations.last_failure_at IS NULL
            OR attribution_circuit_observations.last_failure_at <= ?
          THEN excluded.window_started_at
          ELSE attribution_circuit_observations.window_started_at
        END,
        last_failure_at = excluded.last_failure_at,
        opened_at = NULL,
        updated_at = excluded.updated_at
    `).bind(
      input.connectionId,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      cutoff,
      cutoff,
    ).run()
  } catch {
    throw circuitInvalid()
  }

  const consecutiveFailures = await currentFailureCount(
    environment.db,
    input.connectionId,
  )
  if (consecutiveFailures < FAILURE_THRESHOLD) {
    return { consecutiveFailures, opened: false }
  }

  await openServerCircuitForFailure(environment, {
    ...input,
    code: 'server_transient_failure_threshold',
  })
  try {
    await environment.db.prepare(`
      UPDATE attribution_circuit_observations
      SET opened_at = COALESCE(opened_at, ?), updated_at = ?
      WHERE connection_id = ?
    `).bind(
      now.toISOString(),
      now.toISOString(),
      input.connectionId,
    ).run()
  } catch {
    throw circuitInvalid()
  }
  return { consecutiveFailures, opened: true }
}

export async function recordServerSuccess(
  environment: CircuitBreakerEnvironment,
  input: CircuitBreakerInput,
): Promise<void> {
  validateInput(input)
  const now = trustedNow(environment)
  await requirePolicy(environment.db, input)
  try {
    await environment.db.prepare(`
      INSERT INTO attribution_circuit_observations (
        connection_id, consecutive_transient_failures,
        last_success_at, updated_at
      ) VALUES (?, 0, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        consecutive_transient_failures = 0,
        window_started_at = NULL,
        last_failure_at = NULL,
        last_success_at = excluded.last_success_at,
        updated_at = excluded.updated_at
    `).bind(
      input.connectionId,
      now.toISOString(),
      now.toISOString(),
    ).run()
  } catch {
    throw circuitInvalid()
  }
}

export async function openServerCircuitForFailure(
  environment: CircuitBreakerEnvironment,
  input: OpenCircuitInput,
): Promise<void> {
  validateInput(input)
  if (!/^[a-z0-9_]{1,120}$/.test(input.code)) throw circuitInvalid()
  const now = trustedNow(environment)
  await requirePolicy(environment.db, input)
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const incidentId = idFactory('incident')
  if (!isIdentifier(incidentId)) throw circuitInvalid()

  try {
    await environment.db.batch([
      environment.db.prepare(`
        UPDATE attribution_runtime_policies
        SET server_effective_percentage = 0,
            circuit_state = 'server_open',
            runtime_generation = runtime_generation + 1,
            updated_by = 0,
            updated_at = ?
        WHERE connection_id = ?
          AND circuit_state = 'closed'
      `).bind(now.toISOString(), input.connectionId),
      environment.db.prepare(`
        INSERT OR IGNORE INTO attribution_incidents (
          id, provider, connection_id, severity, status, code,
          affected_transport, affected_fact_count,
          affected_delivery_count, opened_at, detected_at
        ) VALUES (
          ?, ?, ?, 'critical', 'open', ?, 'server', 0, 1, ?, ?
        )
      `).bind(
        incidentId,
        input.provider,
        input.connectionId,
        input.code,
        now.toISOString(),
        now.toISOString(),
      ),
    ])
  } catch {
    throw circuitInvalid()
  }
}

async function requirePolicy(
  db: D1Database,
  input: CircuitBreakerInput,
): Promise<PolicyRow> {
  let row: PolicyRow | null
  try {
    row = await db.prepare(`
      SELECT connection.provider, policy.circuit_state
      FROM attribution_connections AS connection
      INNER JOIN attribution_runtime_policies AS policy
        ON policy.connection_id = connection.id
      WHERE connection.id = ?
      LIMIT 1
    `).bind(input.connectionId).first<PolicyRow>()
  } catch {
    throw circuitInvalid()
  }
  if (
    !row
    || row.provider !== input.provider
    || (
      row.circuit_state !== 'closed'
      && row.circuit_state !== 'server_open'
    )
  ) {
    throw circuitInvalid()
  }
  return row
}

async function currentFailureCount(
  db: D1Database,
  connectionId: string,
): Promise<number> {
  let row: ObservationRow | null
  try {
    row = await db.prepare(`
      SELECT consecutive_transient_failures
      FROM attribution_circuit_observations
      WHERE connection_id = ?
    `).bind(connectionId).first<ObservationRow>()
  } catch {
    throw circuitInvalid()
  }
  const value = Number(row?.consecutive_transient_failures ?? 0)
  if (!Number.isSafeInteger(value) || value < 0) throw circuitInvalid()
  return value
}

function trustedNow(environment: CircuitBreakerEnvironment): Date {
  const value = (environment.now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw circuitInvalid()
  return value
}

function validateInput(input: CircuitBreakerInput): void {
  if (
    !input
    || !isIdentifier(input.connectionId)
    || !PROVIDERS.has(input.provider)
  ) {
    throw circuitInvalid()
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9:_-]{1,240}$/.test(value)
}

function circuitInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_CIRCUIT_STATE_INVALID')
}
