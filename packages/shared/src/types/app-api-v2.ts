/**
 * App API v2 公共发现与保守账号访问契约。
 *
 * M0 公开发现已冻结；账号访问当前仍是默认关闭、可回滚的开发基线。
 */

export type AppDiscoverySort = 'recommended' | 'popular' | 'latest'

export interface AppApiMeta {
  requestId: string
  serverTime: string
  apiVersion: '2'
  contractVersion: '1.1.0'
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
    challenge: { type: 'none' } | { type: 'turnstile'; siteKey: string }
    documents: null | {
      termsVersion: string
      privacyVersion: string
      platformOperationVersion: string
      eligibilityVersion: string
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
