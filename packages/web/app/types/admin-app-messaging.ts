export type AdminConversationStatus = 'active' | 'restricted' | 'closed'
export type AdminConversationQueueStatus = 'awaiting_operator' | 'awaiting_viewer' | 'closed'

export interface AdminConversationSummary {
  conversationId: string
  status: AdminConversationStatus
  queueStatus: AdminConversationQueueStatus
  account: {
    accountId: string
    nickname: string | null
  }
  profile: {
    profileId: string
    displayName: string
  }
  operationMode: 'platform_managed'
  receiverLabel: string
  assignment: {
    status: 'unassigned' | 'mine' | 'other'
    version: number
    leaseExpiresAt: string | null
    canClaim: boolean
  }
  routing: {
    groupId: string | null
    groupName: string | null
    claimAccess: 'legacy_unscoped' | 'eligible' | 'no_matching_rule' | 'not_group_member' | 'no_active_shift'
  }
  unreadViewerCount: number
  lastSequence: number
  lastMessageAt: string
  createdAt: string
  updatedAt: string
}

export interface AdminConversationDetail extends AdminConversationSummary {
  disclosureVersion: string
  accessReason: 'service_operation'
  operatorReadSequence: number
  viewerReadSequence: number
}

export interface AdminConversationMessage {
  messageId: string
  conversationId: string
  sequence: number
  senderType: 'viewer' | 'platform_operator' | 'system'
  senderLabel: string
  clientMessageId: string
  contentType: 'text' | 'system'
  text: string
  status: 'accepted' | 'review_pending' | 'rejected' | 'recalled'
  readByReceiver: boolean
  createdAt: string
}

export interface AdminConversationMessagePage {
  items: AdminConversationMessage[]
  nextAfterSequence: number | null
  hasMore: boolean
}

export interface AdminConversationAssignmentResult {
  assignment: {
    status: 'mine' | 'unassigned'
    version: number
    leaseExpiresAt: string | null
  }
  replayed: boolean
}

export type AdminConversationInternalNoteType = 'operation' | 'handoff' | 'quality'
export type AdminConversationTransferReason =
  | 'workload_balance'
  | 'expertise_required'
  | 'shift_handoff'
  | 'supervisor_review'
  | 'other'

export interface AdminConversationInternalNote {
  noteId: string
  conversationId: string
  noteType: AdminConversationInternalNoteType
  text: string
  author: {
    adminId: number
    displayName: string
  }
  createdAt: string
}

export interface AdminConversationOperator {
  adminId: number
  displayName: string
  role: 'admin' | 'owner'
  isCurrentAdmin: boolean
  activeAssignmentCount: number
  capacityLimit: number
  canReceiveTransfer: boolean
}

export interface AdminConversationTransfer {
  transferId: string
  conversationId: string
  assignmentVersion: number
  fromOperator: {
    adminId: number
    displayName: string
  }
  toOperator: {
    adminId: number
    displayName: string
  }
  reasonCode: AdminConversationTransferReason
  hasHandoffNote: boolean
  leaseExpiresAt: string
  createdAt: string
}
