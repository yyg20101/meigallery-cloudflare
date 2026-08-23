/**
 * App API v2 公共发现、账号访问、互动、会员申请、平台话题、
 * Message-2 安全、Safety-2 申诉、Message-3 站内通知、Message-4 实时刷新、Wallet-1 与
 * Interaction-2 收藏历史、Interaction-3 关注更新、Search-1 搜索、
 * Taxonomy-1 稳定分类目录、Search-2 结构化筛选、Recommendation-1 与
 * Media-1 人物媒体浏览及认证详情契约。
 *
 * M0 公开发现已冻结；账号访问当前仍是默认关闭、可回滚的开发基线。
 */

export type AppDiscoverySort = 'recommended' | 'popular' | 'latest'
export type AppPersonSearchSort = 'relevance' | 'popular' | 'latest'
export type AppRecommendationFeedMode = 'auto' | 'non_personalized' | 'personalized'
export type AppRecommendationMode = Exclude<AppRecommendationFeedMode, 'auto'>

export interface AppApiMeta {
  requestId: string
  serverTime: string
  apiVersion: '2'
  contractVersion: '1.26.0'
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

export type AppRuntimeServiceMode = 'normal' | 'maintenance' | 'partial'
export type AppRuntimeRegionUnavailableReason = 'region_not_supported' | 'policy_changed'

export interface AppRuntimePolicy {
  policyVersion: string
  service: {
    mode: AppRuntimeServiceMode
    title: string
    message: string
    retryAfterSeconds: number
    statusUrl: string | null
  }
  client: {
    minimumVersion: string
    latestVersion: string
    upgradeUrl: string | null
    storeAvailable: boolean
  }
  region: {
    available: boolean
    countryCode: string | null
    unavailableReason: AppRuntimeRegionUnavailableReason | null
    title: string | null
    message: string | null
  }
}

export type AppSupportTopicCategory =
  | 'platform'
  | 'membership'
  | 'messaging'
  | 'wallet'
  | 'safety'
  | 'privacy'

export interface AppSupportTopic {
  topicId: string
  category: AppSupportTopicCategory
  categoryLabel: string
  title: string
  summary: string
  sections: Array<{
    heading: string
    body: string
  }>
  keywords: string[]
  action: 'open_data_export' | 'open_account_deletion' | null
}

export interface AppSupportContact {
  contactId: string
  platform: string
  label: string
  value: string
  linkUrl: string | null
}

export type AppLegalDocumentType = 'terms' | 'privacy' | 'platform_operation' | 'eligibility'

export interface AppLegalDocument {
  type: AppLegalDocumentType
  title: string
  version: string | null
  url: string | null
  available: boolean
}

export interface AppSupportCenter {
  contentVersion: string
  serviceBoundary: string
  topics: AppSupportTopic[]
  contacts: AppSupportContact[]
  legalDocuments: AppLegalDocument[]
}

export interface AppBootstrapConfig {
  product: 'meigallery'
  appVersion: '1.0'
  runtime: AppRuntimePolicy
  capabilities: {
    discovery: boolean
    recommendation: {
      feed: boolean
      preferences: boolean
      personalization: boolean
      editorial: boolean
    }
    search: {
      profiles: boolean
      history: boolean
      filters: boolean
      savedFilters: boolean
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
    media: {
      gallery: boolean
      protectedImages: boolean
      video: false
    }
    messaging: boolean
    notifications: boolean
    realtime: boolean
    wallet: boolean
    safety: {
      reports: boolean
      blocks: boolean
      conversationClose: boolean
      appeals: boolean
      accountRestrictionAppeals: boolean
      walletEntryAppeals: boolean
    }
    dataRights: {
      overview: boolean
      export: boolean
      deletion: boolean
    }
    support: boolean
    payments: false
    systemPush: false
  }
  support: {
    contentVersion: string
    centerPath: '/api/v2/app/support'
  }
  discovery: {
    defaultSort: AppDiscoverySort
    allowedSorts: AppDiscoverySort[]
    defaultPageSize: number
    maxPageSize: number
  }
  media: {
    transport: 'http_get'
    defaultPageSize: number
    maxPageSize: number
    accessTokenHeader: 'X-Media-Access-Token'
    accessTokenTtlSeconds: number
    protectedImageCache: 'memory_only'
    video: false
  }
  recommendation: {
    policyVersion: string
    transport: 'http_post'
    defaultMode: 'auto'
    allowedModes: AppRecommendationFeedMode[]
    defaultPageSize: number
    maxPageSize: number
    personalizationDecisionStatus: 'unresolved' | 'approved'
    evidenceRecording: boolean
    editorialDisclosureLabel: '平台精选'
  }
  search: {
    policyVersion: string
    transport: 'http_post'
    defaultSort: AppPersonSearchSort
    allowedSorts: AppPersonSearchSort[]
    defaultPageSize: number
    maxPageSize: number
    maxQueryLength: number
    maxFilterTerms: number
    maxSavedFilterNameLength: number
    advancedFilterEntitlement: 'discovery.filter.advanced'
    savedFilterMaxEntitlement: 'discovery.saved_filter.max'
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
    accountProfileEnabled: boolean
    initialPreferencesEnabled: boolean
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
    conversationSettingsEnabled: boolean
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
  realtime: {
    policyVersion: string
    transport: 'websocket_refresh'
    protocol: 'meigallery.realtime.v1'
    ticketPath: '/api/v2/realtime/tickets'
    connectPath: '/api/v2/realtime/connect'
    eventSchemaVersion: 1
    ticketTtlSeconds: number
    reconnectMinDelayMs: number
    reconnectMaxDelayMs: number
    maxConnectionsPerAccount: number
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
  dataRights: {
    policyVersion: string
    transport: 'http_poll'
    stepUpTtlSeconds: number
    statusAccessHeader: 'X-Data-Rights-Token'
    downloadTicketHeader: 'X-Data-Rights-Download-Ticket'
    exportFormat: 'tar'
    systemPush: false
    exportProcessing: boolean
    deletionProcessing: boolean
    cancellationEnabled: boolean
  }
}

export type AppRealtimeRefreshScope =
  | 'account'
  | 'conversations'
  | 'messages'
  | 'notifications'
  | 'membership'
  | 'wallet'

export interface AppRealtimeTicket {
  ticket: string
  protocol: 'meigallery.realtime.v1'
  connectPath: '/api/v2/realtime/connect'
  expiresAt: string
}

export interface AppRealtimeClientHelloFrame {
  type: 'client.hello'
  schemaVersion: 1
  lastCursor: number
}

export interface AppRealtimeServerReadyFrame {
  type: 'server.ready'
  schemaVersion: 1
  protocol: 'meigallery.realtime.v1'
  serverTime: string
}

export interface AppRealtimeRefreshRequiredFrame {
  type: 'refresh.required'
  schemaVersion: 1
  eventId: string
  cursor: number
  occurredAt: string
  scopes: AppRealtimeRefreshScope[]
}

export interface AppRealtimeServerSyncedFrame {
  type: 'server.synced'
  schemaVersion: 1
  cursor: number
  serverTime: string
}

export type AppRealtimeServerFrame =
  | AppRealtimeServerReadyFrame
  | AppRealtimeRefreshRequiredFrame
  | AppRealtimeServerSyncedFrame

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
  status: 'active' | 'restricted'
}

export type AppAccountAvatarStyle = 'rose' | 'coral' | 'lilac' | 'sky' | 'mint' | 'sand'

export interface AppAccountProfile {
  accountId: string
  nickname: string | null
  avatarStyle: AppAccountAvatarStyle
  avatarLabel: string
  loginIdentity: {
    provider: 'email'
    maskedValue: string
    verified: boolean
  }
  visibility: 'private'
  publicPersonProfileCreated: false
  requiresReauthenticationForUpdate: true
  version: number
  updatedAt: string | null
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
  restriction: AppAccountRestrictionSummary | null
}

export type AppAccountRestrictionMode = 'partial' | 'full'
export type AppAccountRestrictionReasonCategory =
  | 'security_review'
  | 'account_deletion'
  | 'policy'
  | 'administrative'

export type AppAccountRestrictionAction = 'appeal' | 'help' | 'data_rights' | 'logout'

export interface AppAccountRestrictionSummary {
  mode: AppAccountRestrictionMode
  reasonCategory: AppAccountRestrictionReasonCategory
  title: string
  message: string
  restrictedUntil: string | null
  appealReference: string | null
  sourceVersion: string | null
  actions: AppAccountRestrictionAction[]
}

export type AppDataRightsRequestType = 'export' | 'deletion'

export type AppDataRightsRequestStatus =
  | 'requested'
  | 'verification_required'
  | 'collecting'
  | 'ready'
  | 'expired'
  | 'scheduled'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type AppDataRightsStepUpPurpose =
  | 'export_request'
  | 'deletion_request'
  | 'export_cancel'
  | 'deletion_cancel'
  | 'export_download'

export interface AppDataRightsRequestSummary {
  requestId: string
  type: AppDataRightsRequestType
  status: AppDataRightsRequestStatus
  statusMessage: string
  version: number
  policyVersion: string
  requestedAt: string
  updatedAt: string
  deadlineAt: string | null
  scheduledFor: string | null
  completedAt: string | null
  cancelledAt: string | null
  failureCode: string | null
  canCancel: boolean
  requiresStatusToken: boolean
}

export interface AppDataRightsTimelineItem {
  sequence: number
  eventType: string
  status: AppDataRightsRequestStatus
  message: string
  createdAt: string
}

export type AppDataRightsExportArtifactStatus =
  | 'queued'
  | 'collecting'
  | 'finalizing'
  | 'ready'
  | 'expired'
  | 'failed'

export interface AppDataRightsExportArtifactSummary {
  artifactId: string
  status: AppDataRightsExportArtifactStatus
  format: 'tar'
  fileName: string
  schemaVersion: number
  recordCount: number
  sizeBytes: number | null
  manifestSha256: string | null
  generatedAt: string | null
  expiresAt: string | null
  canDownload: boolean
  downloadRequiresStepUp: true
}

export interface AppDataRightsRequestDetail extends AppDataRightsRequestSummary {
  timeline: AppDataRightsTimelineItem[]
  exportArtifact: AppDataRightsExportArtifactSummary | null
}

export interface AppDataRightsStepUpResult {
  purpose: AppDataRightsStepUpPurpose
  token: string
  expiresAt: string
}

export interface AppDataRightsStatusAccess {
  token: string
  expiresAt: string
}

export interface AppDataRightsMutationResult {
  request: AppDataRightsRequestDetail
  statusAccess: AppDataRightsStatusAccess | null
  replayed: boolean
  sessionRevoked: boolean
}

export interface AppDataRightsDownloadTicketResult {
  ticket: string
  expiresAt: string
  fileName: string
  manifestSha256: string
  replayed: boolean
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
  lifecycle: {
    state: 'free' | 'active' | 'expiring_soon' | 'expired' | 'revoked'
    expiringSoonWindowDays: number
    remainingDays: number | null
    endedGrant: null | {
      tier: AppMembershipTierSummary
      grant: {
        grantId: string
        sourceType: 'manual_admin'
        startsAt: string
        expiresAt: string
        userVisibleNote: string
      }
      endedAt: string
      userVisibleNote: string | null
    }
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

export interface AppConversationViewerSettings {
  conversationId: string
  muted: boolean
  editable: boolean
  lockedReason: 'CONVERSATION_CLOSED' | null
  closedAt: string | null
  version: number
  updatedAt: string | null
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
  reviewState: AppAppealReviewState
  userVisibleMessage: string
  originalReportVersion: number
  version: number
  submittedAt: string
  updatedAt: string
  supplementDueAt: string | null
  resolvedAt: string | null
}

export interface AppSafetyAppealDetail extends AppSafetyAppealSummary {
  statement: string
  supplements: Array<{
    sequence: number
    note: string
    createdAt: string
  }>
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

export interface AppSafetyAppealSupplementResult {
  appeal: AppSafetyAppealDetail
  replayed: boolean
}

export type AppServiceAppealSourceType =
  | 'account_restriction'
  | 'wallet_entry'

export type AppAppealReviewState =
  | 'normal'
  | 'evidence_insufficient'
  | 'needs_escalation'

export interface AppServiceAppealSourceSummary {
  type: AppServiceAppealSourceType
  sourceId: string
  sourceVersion: string
  reference: string
  label: string
}

export interface AppServiceAppealSummary {
  appealId: string
  source: AppServiceAppealSourceSummary
  status: AppSafetyAppealStatus
  reviewState: AppAppealReviewState
  userVisibleMessage: string
  version: number
  submittedAt: string
  updatedAt: string
  supplementDueAt: string | null
  resolvedAt: string | null
}

export interface AppServiceAppealDetail extends AppServiceAppealSummary {
  statement: string
  supplements: Array<{
    sequence: number
    note: string
    createdAt: string
  }>
  timeline: Array<{
    sequence: number
    status: AppSafetyAppealStatus
    message: string
    createdAt: string
  }>
}

export interface AppServiceAppealCreateResult {
  appeal: AppServiceAppealDetail
  replayed: boolean
}

export interface AppServiceAppealSupplementResult {
  appeal: AppServiceAppealDetail
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

export type AppPersonMediaRole = 'content' | 'preview'

export type AppPersonMediaAccess =
  | {
      mode: 'public'
      contentPath: string
      accessPath: null
    }
  | {
      mode: 'membership'
      contentPath: null
      accessPath: string
    }

export interface AppPersonMediaItem {
  mediaId: string
  type: 'image'
  role: AppPersonMediaRole
  sortOrder: number
  requiredRank: number
  altText: string
  access: AppPersonMediaAccess
}

export interface AppPersonMediaAccessGrant {
  mediaId: string
  type: 'image'
  accessToken: string
  expiresAt: string
  expiresInSeconds: number
  contentPath: string
  tokenHeader: 'X-Media-Access-Token'
  cachePolicy: 'memory_only'
}

export interface AppPersonVerificationScope {
  code:
    | 'identity_existence'
    | 'authorization_agency'
    | 'profile_consistency'
    | 'media_rights'
  label: string
}

export interface AppPersonVerificationDetail {
  profileId: string
  status: 'verified'
  label: string
  policyVersion: string
  reviewedAt: string
  validUntil: string | null
  profileVersion: number
  operation: {
    mode: 'platform_managed' | 'self_managed'
    label: string
  }
  scopes: AppPersonVerificationScope[]
  platformNotice: string
  changesRequireReverification: true
}

export type AppRecommendationFallbackReason = 'PERSONALIZATION_NOT_READY'

export interface AppRecommendationReason {
  code: string
  label: string
  source: 'rule' | 'editorial'
  disclosure: string | null
  placementId: string | null
}

export interface AppRecommendationItem {
  profile: AppPersonProfile
  reason: AppRecommendationReason
  score: number | null
}

export interface AppRecommendationPage {
  sessionId: string
  mode: AppRecommendationMode
  personalizedApplied: boolean
  fallbackReason: AppRecommendationFallbackReason | null
  ruleVersionId: string
  heatVersionId: string | null
  evidenceRecorded: boolean
  items: AppRecommendationItem[]
  nextCursor: string | null
  hasMore: boolean
}

export interface AppRecommendationPreference {
  requestedPersonalizationEnabled: boolean
  effectivePersonalizationEnabled: boolean
  catalogVersionId: string | null
  preferredTermIds: string[]
  version: number
  policyVersion: string
  policyDecisionStatus: 'unresolved' | 'approved'
  updatedAt: string | null
}

export type AppPersonSearchMatchField = 'display_name' | 'region' | 'tag' | 'filter'

export interface AppPersonSearchItem {
  profile: AppPersonProfile
  match: {
    field: AppPersonSearchMatchField
    label: string
  }
}

export type AppSearchFilterTier = 'none' | 'basic' | 'full'
export type AppSearchFilterGroup = 'region' | Exclude<
  AppTaxonomyType,
  'region_scope' | 'region_group' | 'city_country'
>

export interface AppSearchFilterInput {
  catalogVersionId: string
  termIds: string[]
}

export interface AppSearchFilterTermResolution {
  sourceTermId: string
  termId: string | null
  type: AppTaxonomyType | null
  displayName: string | null
  status: 'active' | 'redirected' | 'invalid'
  requiredTier: AppSearchFilterTier | null
  accessible: boolean
}

export interface AppSearchFilterSelection {
  sourceCatalogVersionId: string
  catalogVersionId: string
  termIds: string[]
  groups: Array<{
    group: AppSearchFilterGroup
    termIds: string[]
  }>
  resolutions: AppSearchFilterTermResolution[]
  invalidTermIds: string[]
  restrictedTermIds: string[]
  redundantTermIds: string[]
  canApply: boolean
  entitlement: {
    advancedKey: 'discovery.filter.advanced'
    advancedTier: AppSearchFilterTier
    sourceTierId: string | null
    membershipCatalogVersionId: string | null
    membershipReady: boolean
  }
}

export interface AppSearchFilterCapabilities {
  policyVersion: string
  catalogVersionId: string
  maxFilterTerms: number
  typeAccess: {
    basic: AppTaxonomyType[]
    advancedBasic: AppTaxonomyType[]
    advancedFull: AppTaxonomyType[]
  }
  entitlement: {
    advancedKey: 'discovery.filter.advanced'
    advancedTier: AppSearchFilterTier
    savedFilterMaxKey: 'discovery.saved_filter.max'
    savedFilterMax: number
    sourceTierId: string | null
    membershipCatalogVersionId: string | null
    membershipReady: boolean
  }
  savedFilters: {
    count: number
    max: number
    canCreate: boolean
  }
}

export interface AppSearchFilterPreview {
  filters: AppSearchFilterSelection
  resultCount: number | null
  countMode: 'snapshot_exact' | 'not_calculated'
}

export type AppSavedFilterSort = 'popular' | 'latest'

export interface AppSavedFilter {
  filterId: string
  name: string
  defaultSort: AppSavedFilterSort
  version: number
  createdAt: string
  updatedAt: string
  filters: AppSearchFilterSelection
}

export interface AppSavedFilterCollection {
  items: AppSavedFilter[]
  count: number
  max: number
  canCreate: boolean
}

export interface AppSavedFilterCreateResult {
  savedFilter: AppSavedFilter
  replayed: boolean
}

export interface AppSavedFilterDeleteResult {
  filterId: string
  deleted: boolean
  version: number | null
  updatedAt: string | null
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

export interface AppFavoriteFolderPreview {
  profileId: string
  coverUrl: string | null
}

export interface AppFavoriteFolderSummary {
  folderId: string
  type: AppFavoriteFolderType
  name: string
  sortOrder: number
  version: number
  itemCount: number
  previewProfiles: AppFavoriteFolderPreview[]
  createdAt: string
  updatedAt: string
}

export interface AppFavoriteFolderCollection {
  folders: AppFavoriteFolderSummary[]
  totalFavoriteCount: number
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
  /** 兼容字段；自 1.21.0 起删除自定义收藏夹会把条目保留到默认收藏，因此固定为 0。 */
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
