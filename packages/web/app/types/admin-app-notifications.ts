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
  title: string
  summary: string
  body: string
  effectiveAt: string | null
  createdAt: string
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
  createdAt: string
  processedAt: string | null
}
