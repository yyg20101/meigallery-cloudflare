import type { AdPlatformProvider, AdPlatformTrackingMode } from '@meigallery/shared'
import type { MetaConnectionStatus, MetaConnectionEnv } from '../meta-connection'
import { getMetaConnectionStatus } from '../meta-connection'
import type { TikTokConnectionEnv } from '../tiktok-connection'
import { getTikTokConnectionStatus } from '../tiktok-connection'
import {
  listAdPlatformConnections as readAdPlatformConnections,
  type AdPlatformConnection,
} from './connections'
import { listAdPlatformProviders } from './registry'

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
  serverQueueConfigured: boolean
  serverDataKeyConfigured: boolean
  testCredentialConfigured: boolean
  mode: AdPlatformTrackingMode
  state: 'not_configured' | 'unverified' | 'verified' | 'invalidated'
  verifiedAt: string
  verifiedCommit: string
}

export async function listAdPlatformConnections(env: MetaConnectionEnv & TikTokConnectionEnv) {
  const [meta, tiktok, connections] = await Promise.all([
    getMetaConnectionStatus(env),
    getTikTokConnectionStatus(env),
    readAdPlatformConnections(env.DB),
  ])
  const byProvider = new Map(connections.map(connection => [connection.provider, connection]))
  return listAdPlatformProviders().map(provider => provider === 'meta'
    ? fromMetaConnection(meta, byProvider.get(provider) ?? null, env)
    : provider === 'tiktok'
      ? fromTikTokConnection(tiktok, byProvider.get(provider) ?? null, env)
      : fromBrowserConnection(provider, byProvider.get(provider) ?? null))
}

function fromTikTokConnection(
  status: Awaited<ReturnType<typeof getTikTokConnectionStatus>>,
  connection: AdPlatformConnection | null,
  env: TikTokConnectionEnv,
): AdPlatformConnectionStatus {
  return {
    provider: 'tiktok',
    environment: 'production',
    enabled: connection?.enabled ?? false,
    browserEnabled: connection?.browserEnabled ?? false,
    serverEnabled: connection?.serverEnabled ?? false,
    destinationId: connection?.destinationId ?? '',
    debugEnabled: connection?.debugEnabled ?? false,
    rolloutPercentage: connection?.rolloutPercentage ?? 0,
    destinationConfigured: status.pixelIdConfigured,
    serverCredentialConfigured: status.tokenConfigured,
    serverQueueConfigured: Boolean(env.TIKTOK_EVENTS_QUEUE),
    serverDataKeyConfigured: hasConfiguredValue(env.TIKTOK_EVENTS_DATA_KEY_CURRENT),
    testCredentialConfigured: false,
    mode: connection?.mode ?? 'disabled',
    state: normalizeState(status.state),
    verifiedAt: status.verifiedAt,
    verifiedCommit: '',
  }
}

function fromBrowserConnection(
  provider: AdPlatformProvider,
  connection: AdPlatformConnection | null,
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
    serverQueueConfigured: false,
    serverDataKeyConfigured: false,
    testCredentialConfigured: false,
    mode: connection?.mode ?? 'disabled',
    state: configured ? 'unverified' : 'not_configured',
    verifiedAt: '',
    verifiedCommit: '',
  }
}

function fromMetaConnection(
  status: MetaConnectionStatus,
  connection: AdPlatformConnection | null,
  env: MetaConnectionEnv,
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
    serverQueueConfigured: Boolean(env.META_CAPI_QUEUE),
    serverDataKeyConfigured: hasConfiguredValue(env.META_CAPI_DATA_KEY_CURRENT),
    testCredentialConfigured: status.testEventCodeConfigured,
    mode: connection?.mode ?? 'disabled',
    state: normalizeState(status.state),
    verifiedAt: status.verifiedAt || '',
    verifiedCommit: status.verifiedCommit || '',
  }
}

function hasConfiguredValue(value: unknown) {
  return String(value ?? '').trim().length > 0
}

function normalizeState(
  state: MetaConnectionStatus['state'] | Awaited<ReturnType<typeof getTikTokConnectionStatus>>['state'],
): AdPlatformConnectionStatus['state'] {
  if (state === 'verified') return 'verified'
  if (state === 'not_configured') return 'not_configured'
  if (state === 'configuration_changed') return 'invalidated'
  return 'unverified'
}
