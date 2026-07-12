import type { AdPlatformProvider, AdPlatformTrackingMode } from '@meigallery/shared'
import { normalizeMetaTrackingMode } from '@meigallery/shared/utils'
import type { MetaConnectionStatus, MetaConnectionEnv } from '../meta-connection'
import { getMetaConnectionStatus } from '../meta-connection'
import { parseStoredSettingValue } from '../../utils/stored-setting-value'

export interface AdPlatformConnectionStatus {
  provider: AdPlatformProvider
  environment: 'production'
  destinationConfigured: boolean
  serverCredentialConfigured: boolean
  testCredentialConfigured: boolean
  mode: AdPlatformTrackingMode
  state: 'not_configured' | 'unverified' | 'verified' | 'invalidated'
  verifiedAt: string
  verifiedCommit: string
}

export async function listAdPlatformConnections(env: MetaConnectionEnv) {
  const [meta, modeRow] = await Promise.all([
    getMetaConnectionStatus(env),
    env.DB.prepare("SELECT value FROM site_settings WHERE key = 'meta_tracking_mode' LIMIT 1").first<{ value: string }>(),
  ])
  const mode = normalizeMetaTrackingMode(parseStoredSettingValue(modeRow?.value || '"disabled"', 'disabled'))
  return [fromMetaConnection(meta, mode)]
}

function fromMetaConnection(status: MetaConnectionStatus, mode: AdPlatformTrackingMode): AdPlatformConnectionStatus {
  return {
    provider: 'meta',
    environment: 'production',
    destinationConfigured: status.pixelIdConfigured,
    serverCredentialConfigured: status.tokenConfigured,
    testCredentialConfigured: status.testEventCodeConfigured,
    mode,
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
