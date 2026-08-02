/**
 * App API v2 首条公开发现契约。
 *
 * 这里仅包含已冻结的 M0 只读字段；登录、认领、消息、会员和钱包契约继续保持未冻结。
 */

export type AppDiscoverySort = 'recommended' | 'popular' | 'latest'

export interface AppApiMeta {
  requestId: string
  serverTime: string
  apiVersion: '2'
  contractVersion: '1.0.0'
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
    discovery: true
    auth: false
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
