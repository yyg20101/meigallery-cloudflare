/**
 * App API v2 公共发现、保守账号访问、Interaction-1 与 Membership-1 契约。
 *
 * M0 公开发现已冻结；账号访问当前仍是默认关闭、可回滚的开发基线。
 */

export type AppDiscoverySort = 'recommended' | 'popular' | 'latest'

export interface AppApiMeta {
  requestId: string
  serverTime: string
  apiVersion: '2'
  contractVersion: '1.4.0'
}

export interface AppApiSuccess<T> {
  data: T
  meta: AppApiMeta
}

export interface AppApiListMeta extends AppApiMeta {
  nextCursor: string | null
  hasMore: boolean
}

export interface AppApiListSuccess<T> {
  data: T[]
  meta: AppApiListMeta
}

export interface AppApiError {
  code: string
  message: string
  retryable: boolean
}

export interface AppApiErrorResponse {
  error: AppApiError
  meta: AppApiMeta
}

export interface AppBootstrapConfig {
  product: 'meigallery'
  appVersion: '1.0'
  capabilities: {
    discovery: boolean
    auth: boolean
    interactions: {
      like: boolean
      follow: boolean
      favorite: false
      history: false
    }
    membership: {
      catalog: boolean
      entitlements: boolean
      applications: false
    }
    messaging: false
    payments: false
    systemPush: false
  }
  discovery: {
    defaultSort: AppDiscoverySort
    allowedSorts: AppDiscoverySort[]
    defaultPageSize: number
    maxPageSize: number
  }
  auth: {
    methods: Array<'email'>
    registrationEnabled: boolean
    deviceManagementEnabled: boolean
    accessTokenTtlSeconds: number
    challenge: { type: 'none' } | {
      type: 'turnstile'
      siteKey: string
      pagePath: '/api/v2/auth/turnstile'
      resultPath: '/api/v2/auth/turnstile/result'
    }
    documents: null | {
      termsVersion: string
      privacyVersion: string
      platformOperationVersion: string
      eligibilityVersion: string
      termsUrl: string
      privacyUrl: string
      platformOperationUrl: string
      eligibilityUrl: string
    }
  }
}

export interface AppDeviceDescriptor {
  installationId: string
  platform: 'android' | 'ios'
  displayName: string
  appVersion: string
}

export interface AppAccountSummary {
  accountId: string
  email: string
  nickname: string | null
  role: string
  status: 'active'
}

export interface AppDeviceSummary {
  deviceId: string
  platform: 'android' | 'ios'
  displayName: string
  appVersion: string
  status: 'active' | 'revoked'
  signedIn: boolean
  current: boolean
  firstSeenAt: string
  lastSeenAt: string
  revokedAt: string | null
}

export interface AppAuthTokenPair {
  tokenType: 'Bearer'
  accessToken: string
  refreshToken: string
  accessExpiresAt: string
  refreshExpiresAt: string
}

export interface AppAuthSession {
  account: AppAccountSummary
  device: AppDeviceSummary
  tokens: AppAuthTokenPair
}

export interface AppMeSummary {
  account: AppAccountSummary
  membership: {
    code: string
    name: string
    rank: number
    expiresAt: string | null
  }
  currentDeviceId: string
}

export type AppMembershipCatalogState = 'development' | 'published'
export type AppMembershipEntitlementValueType = 'boolean' | 'integer' | 'enum'
export type AppMembershipEntitlementValue = boolean | number | string
export type AppMembershipEntitlementAvailability = 'available' | 'planned'

export interface AppMembershipEntitlementDefinition {
  key: string
  schemaVersion: number
  valueType: AppMembershipEntitlementValueType
  defaultValue: AppMembershipEntitlementValue
  mergeStrategy: 'highest_rank'
  periodRule: string | null
  clientCapability: string
  displayName: string
  description: string
  unitLabel: string | null
}

export interface AppMembershipTierEntitlement {
  key: string
  value: AppMembershipEntitlementValue
  availability: AppMembershipEntitlementAvailability
}

export interface AppMembershipTier {
  tierId: string
  code: string
  displayName: string
  tagline: string
  rank: number
  accentToken: string
  acquisitionLabel: string
  serviceDisclosure: string
  entitlements: AppMembershipTierEntitlement[]
}

export interface AppMembershipCatalog {
  catalogVersionId: string
  versionCode: string
  state: AppMembershipCatalogState
  productionReady: boolean
  effectiveAt: string
  timezone: string
  minimumClientVersion: string
  acquisition: {
    mode: 'contact_platform'
    applicationEnabled: false
    paymentEnabled: false
    label: string
  }
  definitions: AppMembershipEntitlementDefinition[]
  tiers: AppMembershipTier[]
}

export interface AppMembershipTierSummary {
  tierId: string
  code: string
  displayName: string
  rank: number
  accentToken: string
}

export interface AppMembershipResolvedEntitlement extends AppMembershipEntitlementDefinition {
  value: AppMembershipEntitlementValue
  availability: AppMembershipEntitlementAvailability
  executable: boolean
  sourceTierId: string | null
  usage: null | {
    used: number
    remaining: number
    resetAt: string | null
  }
}

export interface AppMembershipSnapshot {
  catalogVersionId: string
  versionCode: string
  generatedAt: string
  status: 'free' | 'active'
  tier: AppMembershipTierSummary | null
  grant: null | {
    grantId: string
    sourceType: 'manual_admin'
    startsAt: string
    expiresAt: string
    userVisibleNote: string
  }
  entitlements: AppMembershipResolvedEntitlement[]
}

export interface AppPersonRegion {
  code: string
  label: string
  precision: 'city' | 'province' | 'country' | 'broad'
}

export interface AppPersonProfile {
  profileId: string
  personId: string
  displayName: string
  summary: string | null
  coverUrl: string | null
  verification: {
    status: 'verified'
    label: string
  }
  operation: {
    mode: 'platform_managed' | 'self_managed'
    label: string
  }
  region: AppPersonRegion | null
  tags: string[]
  recommendation: {
    mode: 'rule_based'
    reasonCode: string
    ruleVersion: string
  }
  publishedAt: string
}

export interface AppDiscoveryRegion {
  code: string
  label: string
  profileCount: number
}

export type AppViewerInteractionType = 'like' | 'follow'

export interface AppViewerInteractionState {
  profileId: string
  liked: boolean
  followed: boolean
  likedAt: string | null
  followedAt: string | null
}

export interface AppViewerInteractionListItem {
  profileId: string
  interactionType: AppViewerInteractionType
  createdAt: string
  profile: AppPersonProfile | null
  unavailableReason: 'PROFILE_NOT_AVAILABLE' | null
}
