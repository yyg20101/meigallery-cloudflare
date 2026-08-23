export type AdminSafetyPriority = 'p0' | 'p1' | 'p2' | 'p3'
export type AdminSafetyTargetType = 'person_profile' | 'media' | 'conversation' | 'message'
export type AdminSafetyUserStatus = 'submitted' | 'processing' | 'actioned' | 'no_violation' | 'closed'

export interface AdminSafetyReportSummary {
  reportId: string
  target: {
    type: AdminSafetyTargetType
    profileId: string
    mediaId: string | null
    conversationId: string | null
    messageId: string | null
  }
  reasonCode: string
  reasonLabel: string
  priority: AdminSafetyPriority
  status: string
  userVisibleStatus: AdminSafetyUserStatus
  assignment: {
    status: 'unassigned' | 'mine' | 'other'
    canClaim: boolean
  }
  version: number
  submittedAt: string
  updatedAt: string
}

export interface AdminSafetyReportDetail extends AdminSafetyReportSummary {
  description: string
  userVisibleMessage: string
  evidence: {
    profileContentVersion: number | null
    profileProjectionVersion: number | null
    mediaId: string | null
    conversationId: string | null
    messageId: string | null
    evidenceDigest: string
    capturedAt: string
    messages: Array<{
      messageId: string
      sequence: number
      role: 'before' | 'target' | 'after'
      senderType: 'viewer' | 'platform_operator' | 'system'
      text: string
      bodySha256: string
      snapshotIntegrityMatches: boolean | null
    }>
  }
  timeline: Array<{
    sequence: number
    eventType: string
    statusFrom: string | null
    statusTo: string
    reasonCode: string
    userVisibleStatus: AdminSafetyUserStatus
    userVisibleMessage: string
    createdAt: string
  }>
}

export interface AdminMessagingRuntimeControl {
  newConversationsPaused: boolean
  viewerSendsPaused: boolean
  operatorSendsPaused: boolean
  emergencyReasonCode: string | null
  userVisibleMessage: string
  maxOpenConversations: number
  maxActiveAssignmentsPerOperator: number
  assignmentLeaseMinutes: number
  retentionPolicyId: string
  retentionDecisionStatus: 'unresolved' | 'approved'
  retentionProductionReady: boolean
  purgeEnabled: boolean
  version: number
  updatedAt: string
}

export type AdminConversationSafetyEscalationPriority = 'p0' | 'p1' | 'p2' | 'p3'
export type AdminConversationSafetyEscalationStatus = 'submitted' | 'investigating' | 'actioned' | 'no_action'
export type AdminConversationSafetyEscalationReason =
  | 'suspected_impersonation'
  | 'harassment_threat'
  | 'fraud_inducement'
  | 'privacy_exposure'
  | 'minor_safety'
  | 'imminent_danger'
  | 'other'

export interface AdminConversationSafetyEscalationSummary {
  escalationId: string
  conversationId: string
  profileId: string
  reasonCode: AdminConversationSafetyEscalationReason
  reasonLabel: string
  priority: AdminConversationSafetyEscalationPriority
  status: AdminConversationSafetyEscalationStatus
  assignment: {
    status: 'unassigned' | 'mine' | 'other'
    canClaim: boolean
    isolationBlocked: boolean
  }
  version: number
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface AdminConversationSafetyEscalationDetail extends AdminConversationSafetyEscalationSummary {
  summaryText: string
  evidence: {
    targetMessageId: string | null
    targetMessageSequence: number | null
    conversationLastSequence: number
    evidenceDigest: string
    capturedAt: string
    messages: Array<{
      messageId: string
      sequence: number
      role: 'before' | 'target' | 'after'
      senderType: 'viewer' | 'platform_operator' | 'system'
      text: string
      bodySha256: string
      snapshotIntegrityMatches: boolean | null
    }>
  }
  decision: {
    actionType: 'none' | 'conversation_restricted' | 'conversation_closed'
    reasonCode: string
    summaryText: string
  } | null
  timeline: Array<{
    sequence: number
    eventType: 'submitted' | 'claimed' | 'actioned' | 'no_action'
    statusFrom: 'submitted' | 'investigating' | null
    statusTo: AdminConversationSafetyEscalationStatus
    reasonCode: string
    createdAt: string
  }>
}

export type AdminSafetyAppealStatus = 'submitted' | 'processing' | 'upheld' | 'changed' | 'closed'

export interface AdminSafetyAppealSummary {
  appealId: string
  accountPublicId: string
  reportId?: string
  type: 'report_no_violation_review' | 'account_restriction_review' | 'wallet_entry_review'
  source?: {
    type: 'account_restriction' | 'wallet_entry'
    sourceId: string
    sourceVersion: string
    reference: string
    label: string
  }
  status: AdminSafetyAppealStatus
  workflowStatus: string
  reviewState: 'normal' | 'evidence_insufficient' | 'needs_escalation'
  userVisibleMessage: string
  originalReportVersion?: number
  version: number
  assignedToMe: boolean
  canClaim: boolean
  isolationBlocked: boolean
  overdue: boolean
  submittedAt: string
  updatedAt: string
  reviewDueAt: string | null
  supplementDueAt: string | null
  resolvedAt: string | null
}

export interface AdminSafetyAppealDetail extends AdminSafetyAppealSummary {
  statement: string
  report?: {
    targetType: string
    profileId: string
    mediaId: string | null
    conversationId: string | null
    messageId: string | null
    reasonCode: string
    reasonLabel: string
    description: string
    status: string
    version: number
    evidence: {
      profileContentVersion: number | null
      profileProjectionVersion: number | null
      messageSequence: number | null
      messageSenderType: string | null
      messageBodySha256: string | null
      contextBeforeMessageId: string | null
      contextAfterMessageId: string | null
      evidenceDigest: string
      capturedAt: string
    }
  }
  sourceSnapshotSha256?: string
  sourceFacts?: Record<string, string | number | null>
  supplements?: Array<{
    sequence: number
    note: string
    createdAt: string
  }>
  timeline: Array<{
    sequence: number
    status: AdminSafetyAppealStatus
    message: string
    createdAt: string
  }>
}
