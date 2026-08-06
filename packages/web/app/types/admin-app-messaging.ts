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
