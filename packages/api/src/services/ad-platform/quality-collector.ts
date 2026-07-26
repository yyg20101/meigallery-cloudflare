import type { Bindings } from '../../index'
import { fetchMetaQuality } from './adapters/meta-quality'
import { readAttributionConnectionSnapshot } from './connections'
import { readAttributionCredential } from './credential-vault'

type QualityEnv = Pick<Bindings,
  | 'APP_ENV'
  | 'DB'
  | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT'
  | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS'
>

export type AttributionQualityCollectionResult = {
  status: 'success' | 'skipped' | 'error'
  metricCount: number
  errorCategory: string
}

export async function collectAttributionQuality(
  env: QualityEnv,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<AttributionQualityCollectionResult> {
  if (env.APP_ENV !== 'production') return skipped('environment_not_supported')
  const snapshot = await readAttributionConnectionSnapshot(env.DB, 'meta')
  if (snapshot.state !== 'ready'
    || !snapshot.connection.enabled) return skipped('connection_not_ready')

  const datasetId = String(snapshot.connection.publicConfig.pixelId || '')
  if (!/^\d{5,30}$/.test(datasetId)) return skipped('destination_not_configured')

  let credential: string
  try {
    credential = await readAttributionCredential(env, {
      connectionId: snapshot.connection.id,
      provider: 'meta',
      credentialType: 'access_token',
      encryptionContext: snapshot.credential.encryptionContext,
    })
  }
  catch {
    await persistError(env.DB, snapshot.connection.id, now, 'credential_unavailable')
    return failed('credential_unavailable')
  }

  let result: Awaited<ReturnType<typeof fetchMetaQuality>>
  try {
    result = await fetchMetaQuality({ datasetId, credential, fetcher })
  }
  catch {
    await persistError(env.DB, snapshot.connection.id, now, 'network_error')
    return failed('network_error')
  }
  if (result.errorCategory) {
    await persistError(env.DB, snapshot.connection.id, now, result.errorCategory)
    return failed(result.errorCategory)
  }
  if (result.metrics.length === 0) {
    const reason = result.unavailableReason ?? 'no_recent_metrics'
    await persistUnavailable(env.DB, snapshot.connection.id, now, reason)
    return skipped(reason)
  }

  await env.DB.batch(result.metrics.map(metric => env.DB.prepare(`
    INSERT INTO attribution_quality_snapshots (
      id, connection_id, provider, canonical_event, metric_key, metric_value,
      collection_status, error_category, collected_at
    ) VALUES (?, ?, 'meta', ?, ?, ?, 'success', '', ?)
  `).bind(
    crypto.randomUUID(),
    snapshot.connection.id,
    metric.canonicalEvent,
    metric.metricKey,
    String(metric.value),
    now.toISOString(),
  )))
  return { status: 'success', metricCount: result.metrics.length, errorCategory: '' }
}

async function persistError(db: D1Database, connectionId: string, now: Date, errorCategory: string) {
  await db.batch((['Contact', 'CompleteRegistration'] as const).map(canonicalEvent => db.prepare(`
    INSERT INTO attribution_quality_snapshots (
      id, connection_id, provider, canonical_event, metric_key, metric_value,
      collection_status, error_category, collected_at
    ) VALUES (?, ?, 'meta', ?, 'emq_score', NULL, 'error', ?, ?)
  `).bind(crypto.randomUUID(), connectionId, canonicalEvent, errorCategory, now.toISOString())))
}

async function persistUnavailable(db: D1Database, connectionId: string, now: Date, reason: string) {
  await db.batch((['Contact', 'CompleteRegistration'] as const).map(canonicalEvent => db.prepare(`
    INSERT INTO attribution_quality_snapshots (
      id, connection_id, provider, canonical_event, metric_key, metric_value,
      collection_status, error_category, collected_at
    ) VALUES (?, ?, 'meta', ?, 'emq_score', NULL, 'unavailable', ?, ?)
  `).bind(crypto.randomUUID(), connectionId, canonicalEvent, reason, now.toISOString())))
}

function skipped(errorCategory: string): AttributionQualityCollectionResult {
  return { status: 'skipped', metricCount: 0, errorCategory }
}

function failed(errorCategory: string): AttributionQualityCollectionResult {
  return { status: 'error', metricCount: 0, errorCategory }
}
