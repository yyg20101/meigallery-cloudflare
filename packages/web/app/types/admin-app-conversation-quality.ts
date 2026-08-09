export type QualitySampleStatus = 'pending' | 'in_review' | 'completed' | 'voided'
export type QualityDisclosureStatus = 'verified' | 'missing' | 'mismatch' | 'unverifiable'
export type QualityRating = 'pass' | 'needs_improvement' | 'fail'
export type QualityOutcome = 'pass' | 'coaching_required' | 'safety_referral'

export interface AdminConversationQualitySampleSummary {
  sampleId: string
  selectionRunId: string
  conversationId: string
  messageId: string
  messageCreatedAt: string
  profile: { profileId: string; displayName: string }
  group: { groupId: string | null; name: string | null }
  actualOperator: { adminId: number; displayName: string }
  disclosureVersion: string
  approvedScriptVersionId: string | null
  disclosureIntegrityStatus: QualityDisclosureStatus
  status: QualitySampleStatus
  review: {
    status: 'unassigned' | 'mine' | 'other'
    reviewerAdminId: number | null
    reviewerDisplayName: string | null
    leaseExpiresAt: string | null
    reasonCode: string | null
    canClaim: boolean
  }
  version: number
  conclusion: null | {
    identityDisclosureRating: 'pass' | 'fail'
    serviceQualityRating: QualityRating
    policyLanguageRating: QualityRating
    overallScore: number
    outcome: QualityOutcome
    issueCodes: string[]
    linkedSafetyEscalationId: string | null
    completedAt: string
  }
  voidReasonCode: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminConversationQualitySampleDetail extends AdminConversationQualitySampleSummary {
  bodyAccess: {
    status: 'authorized' | 'closed_after_review'
    purpose: 'quality_review' | null
    reasonCode: string | null
  }
  evidence: null | {
    evidenceDigest: string
    capturedAt: string
    integrityMatches: boolean
    messages: Array<{
      messageId: string
      sequence: number
      role: 'before' | 'target' | 'after'
      senderType: 'viewer' | 'platform_operator' | 'system'
      text: string
      bodySha256: string
      snapshotIntegrityMatches: boolean
    }>
    disclosure: null | {
      messageId: string
      sequence: number
      text: string
      bodySha256: string
      snapshotIntegrityMatches: boolean
      expectedIntegrityMatches: boolean | null
    }
  }
  reviewerSummary: string | null
}

export interface AdminConversationQualityTask {
  taskId: string
  sampleId: string
  group: { groupId: string | null; name: string | null }
  assignee: { adminId: number; displayName: string }
  issueCode: string
  title: string
  guidance: string
  status: 'open' | 'in_progress' | 'completed' | 'cancelled'
  dueAt: string
  version: number
  completionNote: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  canUpdate: boolean
  canCancel: boolean
}

export interface AdminConversationQualitySnapshot {
  generatedAt: string
  timezone: 'Asia/Shanghai'
  permissions: {
    isOwner: boolean
    reviewGroupIds: string[]
    canReviewUnscoped: boolean
    canCreateSelection: boolean
    canViewAllTasks: boolean
  }
  groups: Array<{
    groupId: string
    name: string
    memberRole: 'lead' | 'quality' | 'owner'
    activeOperatorCount: number
  }>
  operators: Array<{
    adminId: number
    displayName: string
    groupIds: string[]
  }>
  samples: AdminConversationQualitySampleSummary[]
  tasks: AdminConversationQualityTask[]
  selectionRuns: Array<{
    selectionRunId: string
    groupId: string | null
    groupName: string | null
    scopeType: 'group' | 'unscoped'
    windowStart: string
    windowEnd: string
    requestedSampleSize: number
    eligibleCount: number
    selectedCount: number
    reasonCode: string
    selectedByDisplayName: string
    createdAt: string
  }>
  counters: {
    pending: number
    inReview: number
    completed: number
    disclosureAttention: number
    overdueTasks: number
  }
  diagnostics: Array<{
    code: 'no_review_scope' | 'unscoped_messages' | 'disclosure_attention' | 'overdue_tasks'
    severity: 'info' | 'warning' | 'critical'
    count: number
    message: string
  }>
}
