import type { AdAttributionProvider } from '@meigallery/shared'
import { hasAdPlatformAdapter } from './registry'

/** 仅供尚未迁移的旧运维模块读取；新转换链路不得引用。 */
export interface AdPlatformConnection {
  provider: AdAttributionProvider
  enabled: boolean
  mode: 'disabled' | 'test' | 'production'
  browserEnabled: boolean
  serverEnabled: boolean
  destinationId: string
  debugEnabled: boolean
  rolloutPercentage: number
  credentialSecretName: string
  revision: string | null
}

export async function readAdPlatformConnection(db: D1Database, provider: AdAttributionProvider): Promise<AdPlatformConnection | null> {
  const row = await db.prepare(`SELECT provider, enabled, mode, browser_enabled, server_enabled, destination_id, debug_enabled, rollout_percentage, credential_secret_name, revision FROM ad_platform_connections WHERE provider = ? LIMIT 1`).bind(provider).first<Record<string, unknown>>()
  return row ? legacyConnection(row) : null
}

export async function listAdPlatformConnections(db: D1Database): Promise<AdPlatformConnection[]> {
  const result = await db.prepare(`SELECT provider, enabled, mode, browser_enabled, server_enabled, destination_id, debug_enabled, rollout_percentage, credential_secret_name, revision FROM ad_platform_connections ORDER BY provider`).all<Record<string, unknown>>()
  return result.results.filter(row => hasAdPlatformAdapter(row.provider)).map(legacyConnection)
}

function legacyConnection(row: Record<string, unknown>): AdPlatformConnection {
  return { provider: row.provider as AdAttributionProvider, enabled: row.enabled === 1, mode: row.mode as AdPlatformConnection['mode'], browserEnabled: row.browser_enabled === 1, serverEnabled: row.server_enabled === 1, destinationId: String(row.destination_id ?? ''), debugEnabled: row.debug_enabled === 1, rolloutPercentage: Number(row.rollout_percentage ?? 0), credentialSecretName: String(row.credential_secret_name ?? ''), revision: typeof row.revision === 'string' ? row.revision : null }
}
