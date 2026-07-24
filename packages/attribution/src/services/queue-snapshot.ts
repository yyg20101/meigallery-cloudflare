import type { AttributionProvider } from '@meigallery/shared'
import {
  asProvider,
  isCanonicalEvent,
  isExternalEventId,
  isIdentifier,
  isRolloutPercentage,
  isSafeText,
  parseStringRecord,
  queueInvalid,
} from './queue-contract'
import type {
  DeliveryHeader,
  DeliverySnapshot,
} from './queue-types'

interface DeliverySnapshotRow {
  delivery_id: string
  fact_id: string
  connection_id: string
  version_id: string
  delivery_provider: string
  transport: string
  destination: string
  external_event_id: string
  status: string
  attempt_count: number
  last_error_code: string
  updated_at: string
  event_name: string
  fact_origin: string
  fact_provider: string | null
  occurred_at: string
  connection_provider: string
  active_version_id: string | null
  version_provider: string
  version_status: string
  public_config_json: string
  policy_enabled: number
  server_enabled: number
  server_effective_percentage: number
  circuit_state: string
  binding_enabled: number | null
  binding_server_destination: string | null
  outbox_provider: string
  outbox_version_id: string
  outbox_schema_version: number
  outbox_key_id: string
  outbox_iv: string
  outbox_ciphertext: string
  outbox_tag: string
  outbox_expires_at: string
  credential_provider: string
  credential_schema_version: number
  credential_key_id: string
  credential_iv: string
  credential_ciphertext: string
  credential_tag: string
  credential_fingerprint: string
  validation_id: string | null
  validation_provider: string | null
  validation_status: string | null
  validation_secret_key_id: string | null
  validation_secret_iv: string | null
  validation_secret_ciphertext: string | null
  validation_secret_tag: string | null
  validation_secret_expires_at: string | null
}

const ACTIVE_VERSION_STATUSES = new Set([
  'active',
  'draining',
  'retired',
])

export async function readDeliveryHeader(
  db: D1Database,
  deliveryId: string,
): Promise<DeliveryHeader | null> {
  if (!isIdentifier(deliveryId)) return null
  const row = await db.prepare(`
    SELECT
      delivery.id,
      delivery.connection_id,
      delivery.provider,
      delivery.status,
      fact.fact_origin
    FROM attribution_deliveries AS delivery
    INNER JOIN attribution_facts AS fact
      ON fact.id = delivery.fact_id
    WHERE delivery.id = ?
      AND delivery.transport = 'server'
    LIMIT 1
  `).bind(deliveryId).first<{
    id: string
    connection_id: string
    provider: string
    status: string
    fact_origin: string
  }>()
  if (
    !row
    || !isIdentifier(row.id)
    || !isIdentifier(row.connection_id)
    || (row.fact_origin !== 'live' && row.fact_origin !== 'synthetic')
  ) {
    return null
  }
  return {
    deliveryId: row.id,
    connectionId: row.connection_id,
    provider: asProvider(row.provider),
    status: row.status,
    factOrigin: row.fact_origin,
  }
}

export async function readDeliverySnapshot(
  db: D1Database,
  deliveryId: string,
): Promise<DeliverySnapshot | null> {
  if (!isIdentifier(deliveryId)) return null
  const row = await db.prepare(`
    SELECT
      delivery.id AS delivery_id,
      delivery.fact_id,
      delivery.connection_id,
      delivery.version_id,
      delivery.provider AS delivery_provider,
      delivery.transport,
      delivery.destination,
      delivery.external_event_id,
      delivery.status,
      delivery.attempt_count,
      delivery.last_error_code,
      delivery.updated_at,
      fact.event_name,
      fact.fact_origin,
      fact.provider AS fact_provider,
      fact.occurred_at,
      connection.provider AS connection_provider,
      connection.active_version_id,
      version.provider AS version_provider,
      version.status AS version_status,
      version.public_config_json,
      policy.enabled AS policy_enabled,
      policy.server_enabled,
      policy.server_effective_percentage,
      policy.circuit_state,
      binding.enabled AS binding_enabled,
      binding.server_destination AS binding_server_destination,
      outbox.provider AS outbox_provider,
      outbox.version_id AS outbox_version_id,
      outbox.schema_version AS outbox_schema_version,
      outbox.key_id AS outbox_key_id,
      outbox.iv AS outbox_iv,
      outbox.ciphertext AS outbox_ciphertext,
      outbox.tag AS outbox_tag,
      outbox.expires_at AS outbox_expires_at,
      credential.provider AS credential_provider,
      credential.schema_version AS credential_schema_version,
      credential.key_id AS credential_key_id,
      credential.iv AS credential_iv,
      credential.ciphertext AS credential_ciphertext,
      credential.tag AS credential_tag,
      credential.credential_fingerprint,
      validation.id AS validation_id,
      validation.provider AS validation_provider,
      validation.status AS validation_status,
      validation_secret.key_id AS validation_secret_key_id,
      validation_secret.iv AS validation_secret_iv,
      validation_secret.ciphertext AS validation_secret_ciphertext,
      validation_secret.tag AS validation_secret_tag,
      validation_secret.expires_at AS validation_secret_expires_at
    FROM attribution_deliveries AS delivery
    INNER JOIN attribution_facts AS fact
      ON fact.id = delivery.fact_id
    INNER JOIN attribution_connections AS connection
      ON connection.id = delivery.connection_id
    INNER JOIN attribution_connection_versions AS version
      ON version.id = delivery.version_id
     AND version.connection_id = connection.id
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
    LEFT JOIN attribution_version_bindings AS binding
      ON binding.version_id = version.id
     AND binding.canonical_event = fact.event_name
    INNER JOIN attribution_outbox AS outbox
      ON outbox.delivery_id = delivery.id
    INNER JOIN attribution_version_credentials AS credential
      ON credential.version_id = version.id
    LEFT JOIN attribution_validations AS validation
      ON validation.candidate_version_id = version.id
     AND validation.provider = delivery.provider
     AND validation.status = 'running'
    LEFT JOIN attribution_validation_secrets AS validation_secret
      ON validation_secret.validation_id = validation.id
    WHERE delivery.id = ?
    LIMIT 1
  `).bind(deliveryId).first<DeliverySnapshotRow>()
  return row ? parseSnapshot(row) : null
}

export function providerConsistent(
  row: DeliverySnapshot,
  provider: AttributionProvider,
): boolean {
  return row.provider === provider && row.providerChainValid
}

function parseSnapshot(row: DeliverySnapshotRow): DeliverySnapshot {
  const provider = asProvider(row.delivery_provider)
  const publicConfig = parseStringRecord(row.public_config_json)
  if (
    !isIdentifier(row.delivery_id)
    || !isIdentifier(row.fact_id)
    || !isIdentifier(row.connection_id)
    || !isIdentifier(row.version_id)
    || row.transport !== 'server'
    || !isSafeText(row.destination, 512)
    || !isExternalEventId(row.external_event_id)
    || !Number.isSafeInteger(row.attempt_count)
    || row.attempt_count < 0
    || !isCanonicalEvent(row.event_name)
    || (row.fact_origin !== 'live' && row.fact_origin !== 'synthetic')
    || (
      row.fact_origin === 'live'
      && !ACTIVE_VERSION_STATUSES.has(row.version_status)
    )
    || (
      row.fact_origin === 'synthetic'
      && row.version_status !== 'validating'
    )
    || (row.policy_enabled !== 0 && row.policy_enabled !== 1)
    || (row.server_enabled !== 0 && row.server_enabled !== 1)
    || !isRolloutPercentage(row.server_effective_percentage)
    || (
      row.circuit_state !== 'closed'
      && row.circuit_state !== 'server_open'
    )
    || row.outbox_schema_version !== 1
    || row.credential_schema_version !== 1
  ) {
    throw queueInvalid()
  }
  const validationSecretEnvelope = validationSecret(row)
  const candidateValidationValid = row.fact_origin === 'synthetic'
    && isIdentifier(row.validation_id)
    && row.validation_provider === provider
    && row.validation_status === 'running'
  return {
    deliveryId: row.delivery_id,
    factId: row.fact_id,
    connectionId: row.connection_id,
    versionId: row.version_id,
    provider,
    destination: row.destination,
    externalEventId: row.external_event_id,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    updatedAt: row.updated_at,
    eventName: row.event_name,
    factOrigin: row.fact_origin,
    publicConfig,
    circuitState: row.circuit_state,
    outboxExpiresAt: row.outbox_expires_at,
    outboxEnvelope: {
      schemaVersion: 1,
      keyId: row.outbox_key_id,
      iv: row.outbox_iv,
      ciphertext: row.outbox_ciphertext,
      tag: row.outbox_tag,
    },
    credentialEnvelope: {
      schemaVersion: 1,
      keyId: row.credential_key_id,
      iv: row.credential_iv,
      ciphertext: row.credential_ciphertext,
      tag: row.credential_tag,
      fingerprint: row.credential_fingerprint,
    },
    providerChainValid: row.fact_provider === provider
      && row.connection_provider === provider
      && row.version_provider === provider
      && row.outbox_provider === provider
      && row.credential_provider === provider
      && row.outbox_version_id === row.version_id,
    bindingValid: row.binding_enabled === 1
      && row.binding_server_destination === row.destination,
    runtimeEnabled: row.policy_enabled === 1,
    serverEnabled: row.server_enabled === 1,
    serverEffectivePercentage: row.server_effective_percentage,
    validationId: isIdentifier(row.validation_id)
      ? row.validation_id
      : null,
    validationSecretEnvelope,
    validationSecretExpiresAt:
      row.validation_secret_expires_at,
    candidateValidationValid,
  }
}

function validationSecret(
  row: DeliverySnapshotRow,
): DeliverySnapshot['validationSecretEnvelope'] {
  const values = [
    row.validation_secret_key_id,
    row.validation_secret_iv,
    row.validation_secret_ciphertext,
    row.validation_secret_tag,
  ]
  if (values.every(value => value === null)) return null
  if (!values.every(value => typeof value === 'string' && value.length > 0)) {
    throw queueInvalid()
  }
  return {
    schemaVersion: 1,
    keyId: row.validation_secret_key_id!,
    iv: row.validation_secret_iv!,
    ciphertext: row.validation_secret_ciphertext!,
    tag: row.validation_secret_tag!,
  }
}
