import type { AttributionDashboardProvider } from '~/composables/useAdminAttribution'

export interface AttributionPlatformDefinition {
  provider: AttributionDashboardProvider
  label: string
  destinationLabel: string
  browserLabel: string
  serverLabel: string
  testEventLabel: string
  accentClass: string
  badgeClass: string
  destinationPattern: string
  destinationInputMode: 'text' | 'numeric'
  uppercaseDestination: boolean
  supportsIncidents: boolean
  supportsManagedRollout: boolean
  supportsPlatformQuality: boolean
}

export interface AttributionPlatformConnectionDraft {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  destinationId: string
  debugEnabled: boolean
  mode: 'disabled' | 'test' | 'production'
  rolloutPercentage: 0 | 10 | 50 | 100
}

export function emptyAttributionPlatformConnectionDraft(): AttributionPlatformConnectionDraft {
  return {
    enabled: false,
    browserEnabled: false,
    serverEnabled: false,
    destinationId: '',
    debugEnabled: false,
    mode: 'disabled',
    rolloutPercentage: 0,
  }
}

export const ATTRIBUTION_PLATFORMS: readonly AttributionPlatformDefinition[] = [
  {
    provider: 'meta',
    label: 'Meta',
    destinationLabel: 'Dataset ID',
    browserLabel: 'Meta Pixel',
    serverLabel: 'Conversions API',
    testEventLabel: 'Test Event Code',
    accentClass: 'bg-blue-600',
    badgeClass: 'border-blue-200 bg-blue-50 text-blue-800',
    destinationPattern: '[0-9]{5,30}',
    destinationInputMode: 'numeric',
    uppercaseDestination: false,
    supportsIncidents: true,
    supportsManagedRollout: true,
    supportsPlatformQuality: true,
  },
  {
    provider: 'tiktok',
    label: 'TikTok',
    destinationLabel: 'Pixel ID',
    browserLabel: 'TikTok Pixel',
    serverLabel: 'Events API',
    testEventLabel: 'Test Event Code',
    accentClass: 'bg-cyan-500',
    badgeClass: 'border-cyan-200 bg-cyan-50 text-cyan-900',
    destinationPattern: '[A-Za-z0-9]{10,30}',
    destinationInputMode: 'text',
    uppercaseDestination: true,
    supportsIncidents: false,
    supportsManagedRollout: false,
    supportsPlatformQuality: false,
  },
] as const

export const ATTRIBUTION_PLATFORM_PROVIDERS = ATTRIBUTION_PLATFORMS.map(item => item.provider)

export function attributionPlatformDefinition(provider: AttributionDashboardProvider): AttributionPlatformDefinition {
  return ATTRIBUTION_PLATFORMS.find(item => item.provider === provider) ?? ATTRIBUTION_PLATFORMS[0]!
}

export function normalizeAttributionDashboardProvider(value: unknown): AttributionDashboardProvider {
  const raw = Array.isArray(value) ? value[0] : value
  return ATTRIBUTION_PLATFORM_PROVIDERS.includes(raw as AttributionDashboardProvider)
    ? raw as AttributionDashboardProvider
    : ATTRIBUTION_PLATFORMS[0]!.provider
}

export function attributionConnectionStateLabel(state: string) {
  if (state === 'verified') return '已验证'
  if (state === 'invalidated') return '已失效'
  if (state === 'unverified') return '待验证'
  return '未配置'
}
