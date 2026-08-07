/**
 * App API v2 公共发现、账号访问、互动、会员、平台话题、Message-2 安全与 Safety-2 申诉契约。
 *
 * M0 公开发现已冻结；账号访问当前仍是默认关闭、可回滚的开发基线。
 */

export type AppDiscoverySort = 'recommended' | 'popular' | 'latest'

export interface AppApiMeta {
  requestId: string
  serverTime: string
  apiVersion: '2'
  contractVersion: '1.7.0'
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
    messaging: boolean
    safety: {
      reports: boolean
      blocks: boolean
      conversationClose: boolean
      appeals: boolean
    }
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
  messaging: {
    receiverLabel: string
    disclosureVersion: string
    disclosureText: string
    transport: 'http_pull'
    maxTextLength: number
  }
  safety: {
    reasonCatalogVersion: string
    appealPolicyVersion: string
    maxDescriptionLength: number
    maxAppealStatementLength: number
    reportTargets: AppSafetyReportTargetType[]
    reasons: AppSafetyReason[]
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

export type AppConversationStatus = 'active' | 'restricted' | 'closed'
export type AppConversationQueueStatus = 'awaiting_viewer' | 'awaiting_operator' | 'closed'
export type AppConversationSenderType = 'viewer' | 'platform_operator' | 'system'
export type AppConversationMessageStatus = 'accepted' | 'review_pending' | 'rejected' | 'recalled'

export interface AppConversationProfileSummary {
  profileId: string
  available: boolean
  displayName: string | null
  coverUrl: string | null
}

export interface AppConversationQuota {
  limit: number
  used: number
  remaining: number
  resetsAt: string
  periodKey: string
}

export interface AppConversationSummary {
  conversationId: string
  profile: AppConversationProfileSummary
  operationMode: 'platform_managed'
  receiverLabel: string
  disclosureVersion: string
  disclosureText: string
  status: AppConversationStatus
  queueStatus: AppConversationQueueStatus
  lastSequence: number
  unreadCount: number
  canSend: boolean
  sendUnavailableReason: string | null
  canClose: boolean
  closeUnavailableReason: string | null
  lastMessageAt: string
  createdAt: string
  updatedAt: string
}

export interface AppConversationMessage {
  messageId: string
  conversationId: string
  sequence: number
  senderType: AppConversationSenderType
  senderLabel: string
  clientMessageId: string
  contentType: 'text' | 'system'
  text: string
  status: AppConversationMessageStatus
  readByReceiver: boolean
  createdAt: string
}

export interface AppConversationCreateResult {
  conversation: AppConversationSummary
  quota: AppConversationQuota | null
  created: boolean
  replayed: boolean
}

export interface AppConversationMessagesPage {
  items: AppConversationMessage[]
  nextAfterSequence: number | null
  hasMore: boolean
}

export type AppSafetyReportTargetType = 'person_profile' | 'media' | 'conversation' | 'message'
export type AppSafetyPriority = 'p0' | 'p1' | 'p2' | 'p3'
export type AppSafetyReportStatus = 'submitted' | 'processing' | 'actioned' | 'no_violation' | 'closed'
export type AppSafetyAppealStatus = 'submitted' | 'processing' | 'upheld' | 'changed' | 'closed'
export type AppSafetyAppealUnavailableReason =
  | 'FEATURE_DISABLED'
  | 'REPORT_NOT_ELIGIBLE'
  | 'APPEAL_WINDOW_EXPIRED'
  | 'APPEAL_ALREADY_EXISTS'
  | 'POLICY_NOT_READY'

export interface AppSafetyReason {
  code: string
  label: string
}

export interface AppProfileBlockState {
  profileId: string
  blocked: boolean
  version: number
  blockedAt: string | null
  updatedAt: string | null
}

export interface AppProfileBlockListItem extends AppProfileBlockState {
  profile: AppPersonProfile | null
  unavailableReason: 'PROFILE_NOT_AVAILABLE' | null
}

export interface AppSafetyReportTarget {
  type: AppSafetyReportTargetType
  profileId: string
  mediaId: string | null
  conversationId: string | null
  messageId: string | null
}

export interface AppSafetyReportSummary {
  reportId: string
  target: AppSafetyReportTarget
  reasonCode: string
  reasonLabel: string
  status: AppSafetyReportStatus
  userVisibleMessage: string
  version: number
  submittedAt: string
  updatedAt: string
}

export interface AppSafetyReportDetail extends AppSafetyReportSummary {
  description: string
  appeal: {
    canAppeal: boolean
    unavailableReason: AppSafetyAppealUnavailableReason | null
    appealId: string | null
    status: AppSafetyAppealStatus | null
  }
  timeline: Array<{
    sequence: number
    status: AppSafetyReportStatus
    message: string
    createdAt: string
  }>
}

export interface AppSafetyReportCreateResult {
  report: AppSafetyReportDetail
  replayed: boolean
}

export interface AppSafetyAppealSummary {
  appealId: string
  reportId: string
  type: 'report_no_violation_review'
  status: AppSafetyAppealStatus
  userVisibleMessage: string
  originalReportVersion: number
  version: number
  submittedAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface AppSafetyAppealDetail extends AppSafetyAppealSummary {
  statement: string
  timeline: Array<{
    sequence: number
    status: AppSafetyAppealStatus
    message: string
    createdAt: string
  }>
}

export interface AppSafetyAppealCreateResult {
  appeal: AppSafetyAppealDetail
  replayed: boolean
}

export interface AppConversationCloseResult {
  conversation: AppConversationSummary
  replayed: boolean
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
