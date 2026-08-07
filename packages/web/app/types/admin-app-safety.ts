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

export type AdminSafetyAppealStatus = 'submitted' | 'processing' | 'upheld' | 'changed' | 'closed'

export interface AdminSafetyAppealSummary {
  appealId: string
  reportId: string
  type: 'report_no_violation_review'
  status: AdminSafetyAppealStatus
  userVisibleMessage: string
  originalReportVersion: number
  version: number
  assignedToMe: boolean
  canClaim: boolean
  isolationBlocked: boolean
  submittedAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface AdminSafetyAppealDetail extends AdminSafetyAppealSummary {
  statement: string
  report: {
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
  timeline: Array<{
    sequence: number
    status: AdminSafetyAppealStatus
    message: string
    createdAt: string
  }>
}
