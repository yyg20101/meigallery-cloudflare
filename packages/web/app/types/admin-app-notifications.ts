export type AdminNotificationCategory =
  | 'message'
  | 'interaction'
  | 'membership_coin'
  | 'system_security'
  | 'marketing'

export type AdminNotificationDeliveryStatus =
  | 'pending'
  | 'processing'
  | 'delivered'
  | 'suppressed'
  | 'failed'
  | 'dead_letter'

export interface AdminNotificationOverview {
  policy: {
    policyId: string
    versionCode: string
    state: 'development' | 'published' | 'retired'
    productionReady: boolean
    generationEnabled: boolean
    decisionStatus: 'unresolved' | 'approved'
    retentionDays: number | null
    purgeEnabled: boolean
    minimumClientVersion: string
    effectiveAt: string | null
    createdAt: string
  }
  outbox: Partial<Record<AdminNotificationDeliveryStatus, number>>
  notifications: Array<{
    category: AdminNotificationCategory
    total: number
    unread: number
  }>
}

export interface AdminNotificationDefinition {
  definitionId: string
  eventType: string
  category: AdminNotificationCategory
  necessity: 'required' | 'optional'
  preferenceKey: 'message' | 'interaction' | 'marketing' | null
  sourceDomain: string
  targetType: string
  action: string
  schemaVersion: number
  privacyLevel: 'standard' | 'sensitive'
  minimumClientVersion: string
  variableCatalog: string[]
  active: boolean
  template: null | {
    templateId: string
    version: string
    state: 'development' | 'published'
  }
  createdAt: string
}

export interface AdminNotificationTemplate {
  templateId: string
  eventType: string
  category: AdminNotificationCategory
  version: string
  state: 'development' | 'published' | 'retired'
  locale: 'zh-CN'
  variableAllowlist: string[]
  title: string
  summary: string
  body: string
  effectiveAt: string | null
  createdAt: string
}

export type AdminNotificationTemplateRequestStatus =
  | 'draft'
  | 'pending_review'
  | 'executing'
  | 'approved'
  | 'rejected'
  | 'stale'

export interface AdminNotificationTemplateChangeRequest {
  requestId: string
  baseTemplateId: string
  proposedTemplateId: string
  eventDefinitionId: string
  versionCode: string
  locale: 'zh-CN'
  regionScope: 'all'
  variableAllowlist: string[]
  title: string
  summary: string
  body: string
  status: AdminNotificationTemplateRequestStatus
  version: number
  contentHash: string
  requestedBy: { id: number; label: string }
  reviewedBy: null | { id: number; label: string }
  reviewNote: string | null
  canEdit: boolean
  canSubmit: boolean
  canReview: boolean
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  reviewedAt: string | null
}

export interface AdminNotificationTemplateWorkspace {
  template: AdminNotificationTemplate & {
    definitionId: string
    regionScope: 'all'
    variableCatalog: string[]
  }
  request: AdminNotificationTemplateChangeRequest | null
  canCreateDraft: boolean
}

export interface AdminNotificationDelivery {
  outboxId: string
  accountId: string | null
  eventType: string
  category: AdminNotificationCategory
  targetType: string
  status: AdminNotificationDeliveryStatus
  attempts: number
  lastErrorCode: string | null
  notificationId: string | null
  duplicateSuppressionCount: number
  createdAt: string
  processedAt: string | null
}
