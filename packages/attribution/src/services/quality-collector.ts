import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import type {
  AttributionProviderAdapter,
  QualityMetric,
  QualitySignalResult,
} from '../adapters/types'
import type { AttributionEncryptionKeys } from '../security/data-envelope'
import {
  openCredential,
  type CredentialEnvelope,
} from './credential-vault'

export interface QualityCollectorEnvironment {
  db: D1Database
  credentialMasterKeys: AttributionEncryptionKeys
  adapterFor?: (provider: AttributionProvider) => AttributionProviderAdapter
}

export interface QualityCollectionResult {
  attempted: number
  available: number
  unavailable: number
  error: number
}

interface ActiveConnectionRow {
  connection_id: string
  provider: string
  version_id: string
  public_config_json: string
  credential_schema_version: number
  credential_key_id: string
  credential_iv: string
  credential_ciphertext: string
  credential_tag: string
  credential_fingerprint: string
}

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const EVENTS = new Set<CanonicalConversionEvent>([
  'Contact',
  'CompleteRegistration',
])
const STATUS_METRIC_KEY = 'quality_status'

export async function collectQualitySignals(
  environment: QualityCollectorEnvironment,
  operationDate: Date,
): Promise<QualityCollectionResult> {
  const date = utcDate(operationDate)
  const connections = await readActiveConnections(environment.db)
  const result: QualityCollectionResult = {
    attempted: 0,
    available: 0,
    unavailable: 0,
    error: 0,
  }
  for (const connection of connections) {
    result.attempted += 1
    let provider: AttributionProvider | null = null
    try {
      provider = providerFrom(connection.provider)
      const adapter = (
        environment.adapterFor ?? getProviderAdapter
      )(provider)
      if (adapter.provider !== provider) {
        throw new Error('ATTRIBUTION_QUALITY_PROVIDER_MISMATCH')
      }
      const publicConfig = stringRecord(connection.public_config_json)
      const credential = await openCredential(
        environment.credentialMasterKeys,
        {
          provider,
          versionId: identifier(connection.version_id),
          envelope: credentialEnvelope(connection),
        },
      )
      const signal = await adapter.readQualitySignal({
        provider,
        connectionId: identifier(connection.connection_id),
        versionId: identifier(connection.version_id),
        publicConfig,
        credential,
      })
      assertSignal(signal, provider)
      await persistSignal(
        environment.db,
        date,
        connection.connection_id,
        provider,
        signal,
      )
      result[signal.availability] += 1
    } catch {
      if (provider) {
        await persistStatus(
          environment.db,
          date,
          connection.connection_id,
          provider,
          'error',
        )
      }
      result.error += 1
    }
  }
  return result
}

async function readActiveConnections(
  db: D1Database,
): Promise<ActiveConnectionRow[]> {
  const rows = await db.prepare(`
    SELECT
      connection.id AS connection_id,
      connection.provider,
      version.id AS version_id,
      version.public_config_json,
      credential.schema_version AS credential_schema_version,
      credential.key_id AS credential_key_id,
      credential.iv AS credential_iv,
      credential.ciphertext AS credential_ciphertext,
      credential.tag AS credential_tag,
      credential.credential_fingerprint
    FROM attribution_connections AS connection
    INNER JOIN attribution_connection_versions AS version
      ON version.id = connection.active_version_id
     AND version.connection_id = connection.id
     AND version.provider = connection.provider
     AND version.status = 'active'
    INNER JOIN attribution_version_credentials AS credential
      ON credential.version_id = version.id
     AND credential.provider = version.provider
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
     AND policy.enabled = 1
    ORDER BY connection.id
  `).all<ActiveConnectionRow>()
  return rows.results
}

async function persistSignal(
  db: D1Database,
  date: string,
  connectionId: string,
  provider: AttributionProvider,
  signal: QualitySignalResult,
): Promise<void> {
  if (signal.availability !== 'available') {
    await persistStatus(
      db,
      date,
      connectionId,
      provider,
      signal.availability,
    )
    return
  }
  const metrics = normalizeMetrics(signal.metrics)
  if (metrics.length === 0) {
    throw new Error('ATTRIBUTION_QUALITY_SIGNAL_INVALID')
  }
  await db.batch([
    deleteConnectionDay(db, date, connectionId),
    ...metrics.map(metric => db.prepare(`
      INSERT INTO attribution_quality_daily (
        date,
        provider,
        connection_id,
        metric_key,
        numerator,
        denominator,
        value,
        availability
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'available')
    `).bind(
      date,
      provider,
      connectionId,
      `${metric.canonicalEvent}:${metric.key}`,
      metric.value,
    )),
  ])
}

async function persistStatus(
  db: D1Database,
  date: string,
  connectionId: string,
  provider: AttributionProvider,
  availability: 'unavailable' | 'error',
): Promise<void> {
  await db.batch([
    deleteConnectionDay(db, date, connectionId),
    db.prepare(`
      INSERT INTO attribution_quality_daily (
        date,
        provider,
        connection_id,
        metric_key,
        numerator,
        denominator,
        value,
        availability
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
    `).bind(
      date,
      provider,
      connectionId,
      STATUS_METRIC_KEY,
      availability,
    ),
  ])
}

function deleteConnectionDay(
  db: D1Database,
  date: string,
  connectionId: string,
): D1PreparedStatement {
  return db.prepare(`
    DELETE FROM attribution_quality_daily
    WHERE date = ? AND connection_id = ?
  `).bind(date, connectionId)
}

function normalizeMetrics(metrics: QualityMetric[]): QualityMetric[] {
  if (!Array.isArray(metrics)) {
    throw new Error('ATTRIBUTION_QUALITY_SIGNAL_INVALID')
  }
  const seen = new Set<string>()
  return metrics.map(metric => {
    if (
      !metric
      || !EVENTS.has(metric.canonicalEvent)
      || typeof metric.key !== 'string'
      || !/^[a-z][a-z0-9_]{0,63}$/.test(metric.key)
      || !Number.isFinite(metric.value)
      || metric.value < 0
    ) {
      throw new Error('ATTRIBUTION_QUALITY_SIGNAL_INVALID')
    }
    const identity = `${metric.canonicalEvent}:${metric.key}`
    if (seen.has(identity)) {
      throw new Error('ATTRIBUTION_QUALITY_SIGNAL_INVALID')
    }
    seen.add(identity)
    return {
      canonicalEvent: metric.canonicalEvent,
      key: metric.key,
      value: metric.value,
    }
  })
}

function assertSignal(
  signal: QualitySignalResult,
  provider: AttributionProvider,
): void {
  if (
    !signal
    || signal.provider !== provider
    || !isCanonicalTimestamp(signal.checkedAt)
    || (
      signal.availability !== 'available'
      && signal.availability !== 'unavailable'
      && signal.availability !== 'error'
    )
  ) {
    throw new Error('ATTRIBUTION_QUALITY_SIGNAL_INVALID')
  }
  if (
    signal.availability !== 'available'
    && (
      typeof signal.reason !== 'string'
      || !/^[a-z][a-z0-9_]{0,127}$/.test(signal.reason)
    )
  ) {
    throw new Error('ATTRIBUTION_QUALITY_SIGNAL_INVALID')
  }
}

function credentialEnvelope(
  row: ActiveConnectionRow,
): CredentialEnvelope {
  if (row.credential_schema_version !== 1) {
    throw new Error('ATTRIBUTION_QUALITY_CREDENTIAL_INVALID')
  }
  return {
    schemaVersion: 1,
    keyId: safeText(row.credential_key_id),
    iv: safeText(row.credential_iv),
    ciphertext: safeText(row.credential_ciphertext),
    tag: safeText(row.credential_tag),
    fingerprint: safeText(row.credential_fingerprint),
  }
}

function stringRecord(value: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('ATTRIBUTION_QUALITY_CONFIG_INVALID')
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error('ATTRIBUTION_QUALITY_CONFIG_INVALID')
  }
  const entries = Object.entries(parsed)
  if (
    entries.length === 0
    || entries.length > 32
    || entries.some(([key, item]) =>
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
      || typeof item !== 'string'
      || item.length === 0
      || item.length > 4_096)
  ) {
    throw new Error('ATTRIBUTION_QUALITY_CONFIG_INVALID')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

function utcDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('ATTRIBUTION_QUALITY_DATE_INVALID')
  }
  return value.toISOString().slice(0, 10)
}

function providerFrom(value: string): AttributionProvider {
  if (!PROVIDERS.has(value as AttributionProvider)) {
    throw new Error('ATTRIBUTION_QUALITY_PROVIDER_INVALID')
  }
  return value as AttributionProvider
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9:_-]{1,240}$/.test(value)) {
    throw new Error('ATTRIBUTION_QUALITY_IDENTIFIER_INVALID')
  }
  return value
}

function safeText(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw new Error('ATTRIBUTION_QUALITY_VALUE_INVALID')
  }
  return value
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}
