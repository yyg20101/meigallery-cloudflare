import type { Bindings } from '../index'
import { loadMetaCapiCryptoKeys } from '../utils/meta-capi-crypto'

export interface MetaCapiKeyRotationStatus {
  currentKeyValid: boolean
  previousKeyConfigured: boolean
  previousKeyValid: boolean
  previousSameAsCurrent: boolean
  previousOutboxCount: number
  previousActiveDeliveryCount: number
  canRemovePrevious: boolean
}

type MetaCapiKeyRotationEnv = Pick<
  Bindings,
  'DB' | 'META_CAPI_DATA_KEY_CURRENT' | 'META_CAPI_DATA_KEY_PREVIOUS'
>

export async function getMetaCapiKeyRotationStatus(
  env: MetaCapiKeyRotationEnv,
): Promise<MetaCapiKeyRotationStatus> {
  const previousKeyConfigured = typeof env.META_CAPI_DATA_KEY_PREVIOUS === 'string'
  const current = await validatedKey(env.META_CAPI_DATA_KEY_CURRENT)
  const previous = previousKeyConfigured
    ? await validatedKey(env.META_CAPI_DATA_KEY_PREVIOUS)
    : null
  const previousSameAsCurrent = Boolean(current && previous && current.id === previous.id)
  const base = {
    currentKeyValid: current !== null,
    previousKeyConfigured,
    previousKeyValid: previous !== null,
    previousSameAsCurrent,
    previousOutboxCount: 0,
    previousActiveDeliveryCount: 0,
  }

  if (!previousKeyConfigured || !current || !previous) {
    return { ...base, canRemovePrevious: false }
  }
  if (previousSameAsCurrent) {
    return { ...base, canRemovePrevious: true }
  }

  try {
    const [previousOutboxCount, previousActiveDeliveryCount] = await Promise.all([
      readReferenceCount(env.DB, `
        SELECT COUNT(*) AS reference_count
        FROM meta_capi_secure_outbox
        WHERE key_id = ?
      `, previous.id),
      readReferenceCount(env.DB, `
        SELECT COUNT(*) AS reference_count
        FROM analytics_conversion_deliveries
        WHERE encryption_key_id = ?
          AND status IN ('pending', 'failed')
      `, previous.id),
    ])
    return {
      ...base,
      previousOutboxCount,
      previousActiveDeliveryCount,
      canRemovePrevious: previousOutboxCount === 0 && previousActiveDeliveryCount === 0,
    }
  }
  catch {
    return { ...base, canRemovePrevious: false }
  }
}

async function validatedKey(value: string | undefined) {
  try {
    return (await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: value })).current
  }
  catch {
    return null
  }
}

async function readReferenceCount(db: D1Database, sql: string, keyId: string) {
  const row = await db.prepare(sql).bind(keyId).first<{ reference_count: unknown }>()
  const count = Number(row?.reference_count)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('META_CAPI_KEY_REFERENCE_QUERY_INVALID')
  return count
}
