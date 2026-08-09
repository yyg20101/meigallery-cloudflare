export type AdminSearchReadinessItem = {
  ready: boolean
  blockers: string[]
}

export type AdminSearchPolicy = {
  policyId: string
  state: string
  productionReady: boolean
  selected: boolean
  effectiveAt: string
  createdAt: string
  capabilities: {
    profiles: boolean
    history: boolean
    historyProductionReady: boolean
    structuredFilters: boolean
    filterPreview: boolean
    savedFilters: boolean
  }
  privacy: {
    historyRecordingDefault: false
    historyRetentionDecisionStatus: string
    purgeEnabled: boolean
    historyRetentionDays: number
  }
  limits: {
    maxQueryLength: number
    maxHistoryItems: number
    maxFilterTerms: number
    maxSavedFilterNameLength: number
  }
  readyForCurrentEnvironment: boolean
  blockers: string[]
}

export type AdminSearchCatalogDependency = {
  featureEnabled: boolean
  catalogConfigured: boolean
  configuredCatalogVersionId: string | null
  ready: boolean
  blockers: string[]
  catalog: {
    catalogVersionId: string
    versionCode: string
    state: string
    productionReady: boolean
    effectiveAt: string
    minimumClientVersion: string
    itemCount?: number
    closureCount?: number
    tierCount?: number
  } | null
}

export type AdminSearchMembershipDependency = AdminSearchCatalogDependency & {
  entitlementKeys: {
    advanced: string
    savedFilterMax: string
  }
  tiers: Array<{
    tierId: string
    code: string
    displayName: string
    rank: number
    advancedTier: string | number | boolean | null
    savedFilterMax: string | number | boolean | null
    available: boolean
    valid: boolean
  }>
}

export type AdminSearchOverview = {
  generatedAt: string
  runtime: {
    environment: string
    authEnabled: boolean
    search: {
      featureFlagEnabled: boolean
      productionGateEnabled: boolean
      policyConfigured: boolean
      selectedPolicyId: string
      runtimeEnabled: boolean
      requireProductionReady: boolean
    }
  }
  readiness: {
    profiles: AdminSearchReadinessItem
    history: AdminSearchReadinessItem
    filters: AdminSearchReadinessItem
    savedFilters: AdminSearchReadinessItem
  }
  policies: AdminSearchPolicy[]
  taxonomy: AdminSearchCatalogDependency
  membership: AdminSearchMembershipDependency
  privacy: {
    historyPreferenceCount: number
    historyRecordingEnabledCount: number
    historyAccountCount: number
    activeHistoryItemCount: number
    expiredHistoryItemCount: number
    expiringSoonHistoryItemCount: number
    savedFilterAccountCount: number
    activeSavedFilterCount: number
    deletedSavedFilterCount: number
    currentCatalogSavedFilterCount: number
    otherCatalogSavedFilterCount: number
    latestSavedFilterUpdatedAt: string | null
    activeSavedFilterReferenceCount: number
    needsReviewSavedFilterCount: number
    missingSavedFilterReferenceCount: number
    redirectedSavedFilterCount: number
    deprecatedSavedFilterCount: number
    restrictedSavedFilterCount: number
  }
  savedFilterCatalogUsage: Array<{
    catalogVersionId: string
    versionCode: string | null
    state: string | null
    activeFilterCount: number
    accountCount: number
    latestUpdatedAt: string | null
  }>
}

export const SEARCH_READINESS_LABELS = {
  profiles: '人物搜索',
  history: '搜索历史',
  filters: '结构化筛选',
  savedFilters: '保存条件',
} as const

export function formatAdminSearchDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    : value
}

export function adminSearchApiError(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback
  const candidate = error as { data?: unknown; message?: unknown }
  const body = parseAdminSearchError(candidate.data)
  if (body?.message) return body.message
  if (typeof candidate.message === 'string' && candidate.message.length < 180) {
    return candidate.message
  }
  return fallback
}

function parseAdminSearchError(value: unknown): { message?: string } | null {
  if (value && typeof value === 'object') return value as { message?: string }
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value) as { message?: string }
  }
  catch {
    return null
  }
}
