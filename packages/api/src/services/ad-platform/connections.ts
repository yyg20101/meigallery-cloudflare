import type {
  AdPlatformProvider,
  AdPlatformTrackingMode,
  MetaCapiRolloutPercentage,
} from '@meigallery/shared'

export interface AdPlatformConnection {
  provider: AdPlatformProvider
  enabled: boolean
  mode: AdPlatformTrackingMode
  browserEnabled: boolean
  serverEnabled: boolean
  destinationId: string
  debugEnabled: boolean
  rolloutPercentage: MetaCapiRolloutPercentage
  credentialSecretName: string
  revision: string | null
}

type ConnectionRow = {
  provider: string
  enabled: number
  mode: string
  browser_enabled: number
  server_enabled: number
  destination_id: string
  debug_enabled: number
  rollout_percentage: number
  credential_secret_name: string
  revision: string | null
}

export async function readAdPlatformConnection(
  db: D1Database,
  provider: AdPlatformProvider,
): Promise<AdPlatformConnection | null> {
  const row = await db.prepare(`
    SELECT provider, enabled, mode, browser_enabled, server_enabled, destination_id,
      debug_enabled, rollout_percentage, credential_secret_name, revision
    FROM ad_platform_connections
    WHERE provider = ?
    LIMIT 1
  `).bind(provider).first<ConnectionRow>()
  return row ? serializeConnection(row) : null
}

export async function listAdPlatformConnections(db: D1Database): Promise<AdPlatformConnection[]> {
  const result = await db.prepare(`
    SELECT provider, enabled, mode, browser_enabled, server_enabled, destination_id,
      debug_enabled, rollout_percentage, credential_secret_name, revision
    FROM ad_platform_connections
    ORDER BY provider
  `).all<ConnectionRow>()
  return result.results
    .filter(row => row.provider === 'meta' || row.provider === 'tiktok' || row.provider === 'google')
    .map(serializeConnection)
}

function serializeConnection(row: ConnectionRow): AdPlatformConnection {
  return {
    provider: row.provider as AdPlatformProvider,
    enabled: row.enabled === 1,
    mode: row.mode as AdPlatformTrackingMode,
    browserEnabled: row.browser_enabled === 1,
    serverEnabled: row.server_enabled === 1,
    destinationId: row.destination_id,
    debugEnabled: row.debug_enabled === 1,
    rolloutPercentage: row.rollout_percentage as MetaCapiRolloutPercentage,
    credentialSecretName: row.credential_secret_name,
    revision: row.revision,
  }
}
