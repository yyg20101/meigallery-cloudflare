import type { AdPlatformProvider, AdPlatformTrackingMode } from '@meigallery/shared'
import type { MetaConnectionStatus, MetaConnectionEnv } from '../meta-connection'
import { getMetaConnectionStatus } from '../meta-connection'
import { readAdPlatformConnection } from './connections'

export interface AdPlatformConnectionStatus {
  provider: AdPlatformProvider
  environment: 'production'
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  destinationId: string
  debugEnabled: boolean
  rolloutPercentage: number
  destinationConfigured: boolean
  serverCredentialConfigured: boolean
  testCredentialConfigured: boolean
  mode: AdPlatformTrackingMode
  state: 'not_configured' | 'unverified' | 'verified' | 'invalidated'
  verifiedAt: string
  verifiedCommit: string
}

export async function listAdPlatformConnections(env: MetaConnectionEnv) {
  const [meta, metaConnection, tiktokConnection] = await Promise.all([
    getMetaConnectionStatus(env),
    readAdPlatformConnection(env.DB, 'meta'),
    readAdPlatformConnection(env.DB, 'tiktok'),
  ])
  return [
    fromMetaConnection(meta, metaConnection),
    fromBrowserConnection('tiktok', tiktokConnection),
  ]
}

function fromBrowserConnection(
  provider: AdPlatformProvider,
  connection: Awaited<ReturnType<typeof readAdPlatformConnection>>,
): AdPlatformConnectionStatus {
  const configured = Boolean(connection?.destinationId)
  return {
    provider,
    environment: 'production',
    enabled: connection?.enabled ?? false,
    browserEnabled: connection?.browserEnabled ?? false,
    serverEnabled: false,
    destinationId: connection?.destinationId ?? '',
    debugEnabled: connection?.debugEnabled ?? false,
    rolloutPercentage: 0,
    destinationConfigured: configured,
    serverCredentialConfigured: false,
    testCredentialConfigured: false,
    mode: connection?.mode ?? 'disabled',
    state: configured ? 'unverified' : 'not_configured',
    verifiedAt: '',
    verifiedCommit: '',
  }
}

function fromMetaConnection(
  status: MetaConnectionStatus,
  connection: Awaited<ReturnType<typeof readAdPlatformConnection>>,
): AdPlatformConnectionStatus {
  return {
    provider: 'meta',
    environment: 'production',
    enabled: connection?.enabled ?? false,
    browserEnabled: connection?.browserEnabled ?? false,
    serverEnabled: connection?.serverEnabled ?? false,
    destinationId: connection?.destinationId ?? '',
    debugEnabled: connection?.debugEnabled ?? false,
    rolloutPercentage: connection?.rolloutPercentage ?? 0,
    destinationConfigured: status.pixelIdConfigured,
    serverCredentialConfigured: status.tokenConfigured,
    testCredentialConfigured: status.testEventCodeConfigured,
    mode: connection?.mode ?? 'disabled',
    state: normalizeState(status.state),
    verifiedAt: status.verifiedAt || '',
    verifiedCommit: status.verifiedCommit || '',
  }
}

function normalizeState(state: MetaConnectionStatus['state']): AdPlatformConnectionStatus['state'] {
  if (state === 'verified') return 'verified'
  if (state === 'not_configured') return 'not_configured'
  if (state === 'configuration_changed') return 'invalidated'
  return 'unverified'
}
