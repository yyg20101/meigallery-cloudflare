import type {
  AdPlatformProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import type { AdPlatformConnectionData } from '~/composables/useAdminAttribution'

export type AttributionPlatformProvider = AdPlatformProvider
export type AttributionCredentialType = 'access_token' | 'service_account_json'

export interface AttributionPlatformFieldDefinition {
  key: string
  label: string
  required: boolean
  inputMode?: 'text' | 'numeric'
  pattern?: string
  placeholder?: string
  autocomplete?: string
}

export interface AttributionBindingDestinationDefinition {
  label: string
  editable: boolean
  defaultValue: string
  pattern?: string
  placeholder?: string
}

export interface AttributionEventBindingDefinition {
  canonicalEvent: CanonicalConversionEvent
  label: string
  browser: AttributionBindingDestinationDefinition
  server: AttributionBindingDestinationDefinition
}

export interface AttributionPlatformDefinition {
  provider: AttributionPlatformProvider
  label: string
  shortLabel: string
  browserLabel: string
  serverLabel: string
  accentClass: string
  badgeClass: string
  tracking: {
    defaultUtmMedium: string
  }
  quality: {
    unavailableLabel: string
  }
  publicConfigFields: readonly AttributionPlatformFieldDefinition[]
  credential: {
    type: AttributionCredentialType
    label: string
    inputType: 'password' | 'file'
    accept?: string
  }
  testEvent?: {
    label: string
    placeholder: string
    pattern: string
    maxLength: number
  }
  eventBindings: readonly AttributionEventBindingDefinition[]
}

export interface AttributionEventBindingDraft {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface AttributionPlatformConnectionDraft {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  publicConfig: Record<string, string>
  eventBindings: AttributionEventBindingDraft[]
}

const STANDARD_EVENTS = [
  { canonicalEvent: 'Contact', label: '有效联系' },
  { canonicalEvent: 'CompleteRegistration', label: '完成注册' },
] as const

function fixedBindings(browserDestination: string, serverDestination: string): AttributionEventBindingDefinition[] {
  return STANDARD_EVENTS.map(event => ({
    ...event,
    browser: { label: 'Browser 目标', editable: false, defaultValue: browserDestination },
    server: { label: 'Server 目标', editable: false, defaultValue: serverDestination },
  }))
}

export const ATTRIBUTION_PLATFORMS: readonly AttributionPlatformDefinition[] = [
  {
    provider: 'meta',
    label: 'Meta',
    shortLabel: 'Meta',
    browserLabel: 'Meta Pixel',
    serverLabel: 'Conversions API',
    accentClass: 'bg-blue-600',
    badgeClass: 'border-blue-200 bg-blue-50 text-blue-800',
    tracking: { defaultUtmMedium: 'paid_social' },
    quality: { unavailableLabel: '等待 Meta Dataset Quality 数据' },
    publicConfigFields: [
      { key: 'pixelId', label: 'Pixel ID / Dataset ID', required: true, inputMode: 'numeric', pattern: '[0-9]{5,30}', placeholder: '123456789012345', autocomplete: 'off' },
    ],
    credential: { type: 'access_token', label: 'Conversions API Access Token', inputType: 'password' },
    testEvent: { label: 'Test Event Code', placeholder: 'TEST12345', pattern: 'TEST[A-Za-z0-9_-]{1,120}', maxLength: 128 },
    eventBindings: fixedBindings('meta_pixel', 'meta_capi'),
  },
  {
    provider: 'tiktok',
    label: 'TikTok',
    shortLabel: 'TikTok',
    browserLabel: 'TikTok Pixel',
    serverLabel: 'Events API',
    accentClass: 'bg-cyan-500',
    badgeClass: 'border-cyan-200 bg-cyan-50 text-cyan-900',
    tracking: { defaultUtmMedium: 'paid_social' },
    quality: { unavailableLabel: '需在 TikTok Events Manager 人工确认' },
    publicConfigFields: [
      { key: 'pixelCode', label: 'Pixel ID', required: true, pattern: '[A-Z0-9]{10,30}', placeholder: 'C123456789ABCDEF', autocomplete: 'off' },
    ],
    credential: { type: 'access_token', label: 'Events API Access Token', inputType: 'password' },
    testEvent: { label: 'Test Event Code', placeholder: 'TEST12345', pattern: '[A-Za-z0-9_-]{1,128}', maxLength: 128 },
    eventBindings: fixedBindings('tiktok_pixel', 'tiktok_events_api'),
  },
  {
    provider: 'google',
    label: 'Google Ads',
    shortLabel: 'Google',
    browserLabel: 'Google tag',
    serverLabel: 'Google Ads API',
    accentClass: 'bg-emerald-600',
    badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    tracking: { defaultUtmMedium: 'cpc' },
    quality: { unavailableLabel: '等待 Data Manager 异步诊断' },
    publicConfigFields: [
      { key: 'tagId', label: 'Tag ID', required: true, pattern: 'AW-[0-9]{5,20}', placeholder: 'AW-123456789', autocomplete: 'off' },
      { key: 'customerId', label: 'Customer ID', required: true, inputMode: 'numeric', pattern: '[0-9]{1,20}', placeholder: '1234567890', autocomplete: 'off' },
      { key: 'loginCustomerId', label: 'Manager Account ID（可选）', required: false, inputMode: 'numeric', pattern: '[0-9]{1,20}', placeholder: '1234567890', autocomplete: 'off' },
      { key: 'cloudProjectId', label: 'Cloud Project', required: true, pattern: '[a-z][a-z0-9-]{4,28}[a-z0-9]', placeholder: 'meigallery-ads', autocomplete: 'off' },
    ],
    credential: { type: 'service_account_json', label: 'Service Account JSON', inputType: 'file', accept: '.json,application/json' },
    eventBindings: STANDARD_EVENTS.map(event => ({
      ...event,
      browser: {
        label: `${event.label} Label`,
        editable: true,
        defaultValue: '',
        pattern: 'AW-[0-9]{5,20}/[^\\s/]{1,200}',
        placeholder: 'AW-123456789/AbCdEfGhIj',
      },
      server: {
        label: `${event.label} Conversion Action ID`,
        editable: true,
        defaultValue: '',
        pattern: '[0-9]{1,20}',
        placeholder: '1234567890',
      },
    })),
  },
] as const

export const ATTRIBUTION_PLATFORM_PROVIDERS = ATTRIBUTION_PLATFORMS.map(item => item.provider)

export function attributionPlatformDefinition(provider: AttributionPlatformProvider): AttributionPlatformDefinition {
  return ATTRIBUTION_PLATFORMS.find(item => item.provider === provider) ?? ATTRIBUTION_PLATFORMS[0]!
}

export function normalizeAttributionPlatformProvider(value: unknown): AttributionPlatformProvider {
  const raw = Array.isArray(value) ? value[0] : value
  return ATTRIBUTION_PLATFORM_PROVIDERS.includes(raw as AttributionPlatformProvider)
    ? raw as AttributionPlatformProvider
    : ATTRIBUTION_PLATFORMS[0]!.provider
}

export const normalizeAttributionDashboardProvider = normalizeAttributionPlatformProvider

export function emptyAttributionPlatformConnectionDraft(
  platform: AttributionPlatformDefinition = ATTRIBUTION_PLATFORMS[0]!,
): AttributionPlatformConnectionDraft {
  return {
    enabled: false,
    browserEnabled: false,
    serverEnabled: false,
    publicConfig: Object.fromEntries(platform.publicConfigFields.map(field => [field.key, ''])),
    eventBindings: platform.eventBindings.map(binding => ({
      canonicalEvent: binding.canonicalEvent,
      enabled: true,
      browserDestination: binding.browser.defaultValue,
      serverDestination: binding.server.defaultValue,
    })),
  }
}

export function attributionConnectionToDraft(
  connection: AdPlatformConnectionData | null | undefined,
  platform: AttributionPlatformDefinition,
): AttributionPlatformConnectionDraft {
  if (!connection) return emptyAttributionPlatformConnectionDraft(platform)
  const publicConfig = Object.fromEntries(platform.publicConfigFields.map(field => [field.key, String(connection.publicConfig[field.key] ?? '')]))
  return {
    enabled: connection.enabled,
    browserEnabled: connection.browserEnabled,
    serverEnabled: connection.serverEnabled,
    publicConfig,
    eventBindings: platform.eventBindings.map((definition) => {
      const binding = connection.eventBindings.find(item => item.canonicalEvent === definition.canonicalEvent)
      return {
        canonicalEvent: definition.canonicalEvent,
        enabled: binding?.enabled ?? true,
        browserDestination: binding?.browserDestination ?? definition.browser.defaultValue,
        serverDestination: binding?.serverDestination ?? definition.server.defaultValue,
      }
    }),
  }
}

export function attributionConnectionPayload(
  platform: AttributionPlatformDefinition,
  draft: AttributionPlatformConnectionDraft,
  credentialPlaintext = '',
) {
  const publicConfig = Object.fromEntries([
    ['provider', platform.provider],
    ...platform.publicConfigFields
      .map(field => [field.key, String(draft.publicConfig[field.key] ?? '').trim()] as const)
      .filter(([, value], index) => platform.publicConfigFields[index]!.required || value.length > 0),
  ])
  const plaintext = credentialPlaintext.trim()
  return {
    enabled: draft.enabled,
    browserEnabled: draft.browserEnabled,
    serverEnabled: draft.serverEnabled,
    publicConfig,
    eventBindings: draft.eventBindings.map(binding => ({
      canonicalEvent: binding.canonicalEvent,
      enabled: binding.enabled,
      browserDestination: binding.browserDestination.trim(),
      serverDestination: binding.serverDestination.trim(),
    })),
    ...(plaintext ? { credential: { type: platform.credential.type, plaintext } } : {}),
  }
}

export function attributionConnectionStateLabel(connection: AdPlatformConnectionData | null | undefined) {
  if (!connection) return '未配置'
  return connection.enabled ? '生产运行' : '已停用'
}
