/**
 * App API v2 公共发现、账号访问、互动、会员申请、平台话题、
 * Message-2 安全、Safety-2 申诉、Message-3 站内通知、Wallet-1 与
 * Interaction-2 收藏历史、Interaction-3 关注更新、Search-1 搜索与
 * Taxonomy-1 稳定分类目录契约。
 *
 * M0 公开发现已冻结；账号访问当前仍是默认关闭、可回滚的开发基线。
 */

export type AppDiscoverySort = 'recommended' | 'popular' | 'latest'
export type AppPersonSearchSort = 'relevance' | 'popular' | 'latest'

export interface AppApiMeta {
  requestId: string
  serverTime: string
  apiVersion: '2'
  contractVersion: '1.14.0'
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
    search: {
      profiles: boolean
      history: boolean
    }
    taxonomy: {
      catalog: boolean
    }
    auth: boolean
    interactions: {
      like: boolean
      follow: boolean
      followUpdates: boolean
      favorite: boolean
      history: boolean
    }
    membership: {
      catalog: boolean
      entitlements: boolean
      applications: boolean
    }
    messaging: boolean
    notifications: boolean
    wallet: boolean
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
  search: {
    policyVersion: string
    transport: 'http_post'
    defaultSort: AppPersonSearchSort
    allowedSorts: AppPersonSearchSort[]
    defaultPageSize: number
    maxPageSize: number
    maxQueryLength: number
    historyRecordingDefault: false
    maxHistoryItems: number
  }
  taxonomy: {
    catalogVersionId: string
    supportedTypes: AppTaxonomyType[]
  }
  interactionCollections: {
    policyVersion: string
    defaultFolderLabel: '默认收藏'
    maxFolderNameLength: number
    maxItemsPerFolder: number
    historyRecordingDefault: false
  }
  followUpdates: {
    policyVersion: string
    transport: 'http_pull'
    maxPageSize: number
    notificationMode: 'in_app_only'
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
  membershipApplications: {
    disclosureVersion: string
    disclosureText: string
    contactMethod: 'verified_email'
    maxStatementLength: number
    contactWindows: Array<{
      code: AppMembershipContactWindow
      label: string
    }>
  }
  messaging: {
    receiverLabel: string
    disclosureVersion: string
    disclosureText: string
    transport: 'http_pull'
    maxTextLength: number
  }
  notifications: {
    policyVersion: string
    transport: 'http_pull'
    maxPageSize: number
    categories: Array<{
      code: AppNotificationCategory
      label: string
      preference: 'optional' | 'required'
    }>
  }
  wallet: {
    policyVersion: string
    currencyCode: 'mei_coin'
    displayName: '金币'
    minorUnit: 0
    maxPageSize: number
    directions: Array<'credit' | 'debit'>
    disclaimer: string
    payments: false
    recharge: false
    spending: false
    transfer: false
    withdrawal: false
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

export type AppTaxonomyType =
  | 'region_scope'
  | 'region_group'
  | 'city_country'
  | 'identity'
  | 'personality'
  | 'style'
  | 'occupation'
  | 'hair'
  | 'clothing'
  | 'scene'
  | 'content_type'

export type AppTaxonomyCatalogState = 'development' | 'published'
export type AppTaxonomyPublicState = 'active' | 'deprecated' | 'redirect'

export interface AppTaxonomyTerm {
  termId: string
  type: AppTaxonomyType
  parentTermId: string | null
  displayName: string
  slug: string
  aliases: string[]
  publicState: AppTaxonomyPublicState
  redirectTargetTermId: string | null
  allowedForProfile: boolean
  sortOrder: number
  termVersion: number
}

export interface AppTaxonomyCatalog {
  catalogVersionId: string
  versionCode: string
  state: AppTaxonomyCatalogState
  productionReady: boolean
  effectiveAt: string
  minimumClientVersion: string
  terms: AppTaxonomyTerm[]
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
export type AppMembershipContactWindow = 'anytime' | 'morning' | 'afternoon' | 'evening'
export type AppMembershipApplicationStatus =
  | 'submitted'
  | 'processing'
  | 'needs_information'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'

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
    applicationEnabled: boolean
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

export interface AppMembershipApplicationTimelineItem {
  sequence: number
  eventType:
    | 'submitted'
    | 'claimed'
    | 'information_requested'
    | 'resubmitted'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'expired'
  status: AppMembershipApplicationStatus
  message: string
  createdAt: string
}

export interface AppMembershipApplication {
  applicationId: string
  catalogVersionId: string
  intendedTier: AppMembershipTierSummary
  contact: {
    method: 'verified_email'
    maskedValue: string
  }
  preferredContactWindow: AppMembershipContactWindow
  statement: string | null
  disclosureVersion: string
  status: AppMembershipApplicationStatus
  statusMessage: string
  version: number
  canCancel: boolean
  canResubmit: boolean
  grantId: string | null
  submittedAt: string
  updatedAt: string
  resolvedAt: string | null
  timeline: AppMembershipApplicationTimelineItem[]
}

export interface AppMembershipApplicationMutationResult {
  application: AppMembershipApplication
  created: boolean
  replayed: boolean
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

export type AppNotificationCategory =
  | 'message'
  | 'interaction'
  | 'membership_coin'
  | 'system_security'
  | 'marketing'

export type AppNotificationState = 'available' | 'read' | 'expired' | 'withdrawn'

export type AppNotificationTargetType =
  | 'conversation'
  | 'person_profile'
  | 'membership'
  | 'membership_application'
  | 'wallet_entry'
  | 'safety_report'
  | 'safety_appeal'
  | 'account_security'
  | 'data_task'
  | 'none'

export type AppNotificationAction =
  | 'open_conversation'
  | 'open_person_profile'
  | 'open_membership'
  | 'open_membership_application'
  | 'open_wallet_entry'
  | 'open_safety_report'
  | 'open_safety_appeal'
  | 'open_account_security'
  | 'open_data_task'
  | 'none'

export interface AppNotificationTarget {
  type: AppNotificationTargetType
  id: string | null
  action: AppNotificationAction
  available: boolean
  unavailableReason: 'FEATURE_DISABLED' | 'TARGET_NOT_AVAILABLE' | null
}

export interface AppNotificationSummary {
  notificationId: string
  category: AppNotificationCategory
  eventType: string
  title: string
  summary: string
  state: AppNotificationState
  target: AppNotificationTarget
  createdAt: string
  expiresAt: string | null
  readAt: string | null
}

export interface AppNotificationDetail extends AppNotificationSummary {
  body: string
  templateVersion: string
  minimumClientVersion: string
}

export interface AppNotificationUnreadCounts {
  total: number
  categories: Record<AppNotificationCategory, number>
  generatedAt: string
}

export interface AppNotificationReadResult {
  notificationId: string
  state: AppNotificationState
  readAt: string
  replayed: boolean
}

export interface AppNotificationReadAllResult {
  category: AppNotificationCategory
  markedCount: number
  readAt: string
}

export interface AppNotificationPreferences {
  policyId: string
  version: number
  optional: {
    message: boolean
    interaction: boolean
    marketing: boolean
  }
  required: {
    membershipCoin: true
    systemSecurity: true
  }
  updatedAt: string
}

export type AppWalletDirection = 'credit' | 'debit'

export type AppWalletEntryType =
  | 'admin_credit'
  | 'admin_debit'
  | 'compensation'
  | 'reversal'

export type AppWalletReasonCode =
  | 'manual_adjustment'
  | 'service_compensation'
  | 'correction'
  | 'reversal'

export interface AppWalletSummary {
  currencyCode: 'mei_coin'
  displayName: '金币'
  balance: number
  ledgerVersion: number
  status: 'active' | 'frozen'
  lastEntryAt: string | null
  lastSyncedAt: string
  disclaimer: string
}

export interface AppWalletEntrySummary {
  entryId: string
  publicReference: string
  type: AppWalletEntryType
  direction: AppWalletDirection
  amount: number
  reason: {
    code: AppWalletReasonCode
    label: string
  }
  userVisibleNote: string
  balanceAfter: number
  sequence: number
  status: 'posted'
  postedAt: string
  originalEntryId: string | null
  reversalEntryId: string | null
}

export interface AppWalletEntryDetail extends AppWalletEntrySummary {
  balanceBefore: number
  relatedEntry: null | {
    entryId: string
    publicReference: string
    direction: AppWalletDirection
    amount: number
    postedAt: string
  }
}

export interface AppPersonRegion {
  code: string
  label: string
  precision: 'city' | 'province' | 'country' | 'broad'
}

export interface AppPersonTaxonomyTerm {
  termId: string
  type: AppTaxonomyType
  displayName: string
  catalogVersionId: string
  termVersion: number
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
  taxonomyTerms: AppPersonTaxonomyTerm[]
  recommendation: {
    mode: 'rule_based'
    reasonCode: string
    ruleVersion: string
  }
  publishedAt: string
}

export type AppPersonSearchMatchField = 'display_name' | 'region' | 'tag'

export interface AppPersonSearchItem {
  profile: AppPersonProfile
  match: {
    field: AppPersonSearchMatchField
    label: string
  }
}

export interface AppSearchHistorySettings {
  recordingEnabled: boolean
  version: number
  retentionDays: number
  maxItems: number
  updatedAt: string | null
}

export interface AppSearchHistoryItem {
  historyId: string
  query: string
  firstSearchedAt: string
  lastSearchedAt: string
  searchCount: number
  expiresAt: string
}

export interface AppSearchHistoryRecordResult {
  historyId: string
  recorded: boolean
  duplicate: boolean
  settingsVersion: number
  lastSearchedAt: string
  expiresAt: string
}

export interface AppSearchHistoryDeleteResult {
  historyId: string
  deleted: boolean
  settingsVersion: number
  updatedAt: string
}

export interface AppSearchHistoryClearResult {
  clearedCount: number
  recordingEnabled: boolean
  settingsVersion: number
  updatedAt: string
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

export interface AppFollowUpdateItem {
  updateId: string
  updateType: 'profile_published'
  profileId: string
  profileVersion: number
  projectionVersion: number
  publishedAt: string
  profile: AppPersonProfile
}

export type AppFavoriteFolderType = 'default' | 'custom'

export interface AppFavoriteFolderSummary {
  folderId: string
  type: AppFavoriteFolderType
  name: string
  sortOrder: number
  version: number
  itemCount: number
  createdAt: string
  updatedAt: string
}

export interface AppFavoriteFolderCollection {
  folders: AppFavoriteFolderSummary[]
  customFolderCount: number
  customFolderLimit: number
  canCreateCustomFolder: boolean
}

export interface AppFavoriteListItem {
  profileId: string
  favoritedAt: string
  folderIds: string[]
  profile: AppPersonProfile | null
  unavailableReason: 'PROFILE_NOT_AVAILABLE' | null
}

export interface AppFavoriteMutationResult {
  profileId: string
  favorited: boolean
  favoritedAt: string | null
  folderIds: string[]
}

export interface AppFavoriteFolderDeleteResult {
  folderId: string
  deleted: boolean
  removedItemCount: number
  removedGlobalFavoriteCount: number
}

export type AppViewHistoryEntitlementStatus = 'available' | 'required' | 'not_ready'

export interface AppViewHistorySettings {
  recordingEnabled: boolean
  version: number
  retentionDays: number | null
  entitlementStatus: AppViewHistoryEntitlementStatus
  sourceTierId: string | null
  updatedAt: string | null
}

export interface AppViewHistoryItem {
  profileId: string
  firstViewedAt: string
  lastViewedAt: string
  viewCount: number
  expiresAt: string
  profile: AppPersonProfile | null
  unavailableReason: 'PROFILE_NOT_AVAILABLE' | null
}

export interface AppViewHistoryRecordResult {
  profileId: string
  recorded: boolean
  duplicate: boolean
  settingsVersion: number
  lastViewedAt: string | null
  expiresAt: string | null
}

export interface AppViewHistoryDeleteResult {
  profileId: string
  deleted: boolean
  settingsVersion: number
  updatedAt: string
}

export interface AppViewHistoryClearResult {
  clearedCount: number
  recordingEnabled: boolean
  settingsVersion: number
  updatedAt: string
}
