export type ConversationGroupStatus = 'active' | 'inactive'
export type ConversationGroupMemberRole = 'operator' | 'lead' | 'quality'
export type ConversationRoutingMode = 'manual' | 'automatic'
export type ConversationRoutingMatchType = 'default' | 'profile' | 'region'

export interface AdminConversationRoutingPolicy {
  mode: ConversationRoutingMode
  strategy: 'least_loaded_oldest'
  unassignedBehavior: 'keep_unassigned'
  timezone: 'Asia/Shanghai'
  maxDispatchBatch: number
  version: number
  updatedAt: string
}

export interface AdminConversationGroupMember {
  adminId: number
  displayName: string
  accountRole: 'admin' | 'owner'
  memberRole: ConversationGroupMemberRole
  status: ConversationGroupStatus
  acceptsNewAssignments: boolean
  maxActiveAssignments: number
  maxNewFirstResponsesPerServiceDay: number
  activeAssignmentCount: number
  newFirstResponsesToday: number
  version: number
  updatedAt: string
}

export interface AdminConversationGroupShift {
  shiftId: string
  name: string
  weekday: number
  startMinute: number
  endMinute: number
  overnight: boolean
  status: ConversationGroupStatus
  version: number
  updatedAt: string
}

export interface AdminConversationGroup {
  groupId: string
  code: string
  name: string
  status: ConversationGroupStatus
  timezone: 'Asia/Shanghai'
  maxActiveAssignments: number
  maxNewFirstResponsesPerServiceDay: number
  activeAssignmentCount: number
  newFirstResponsesToday: number
  loadPercent: number
  onDuty: boolean
  configurationState: 'ready' | 'no_member' | 'no_shift' | 'inactive'
  version: number
  updatedAt: string
  members: AdminConversationGroupMember[]
  shifts: AdminConversationGroupShift[]
}

export interface AdminConversationRoutingRule {
  ruleId: string
  name: string
  matchType: ConversationRoutingMatchType
  matchValue: string
  groupId: string
  groupName: string
  groupStatus: ConversationGroupStatus
  priority: number
  status: ConversationGroupStatus
  version: number
  updatedAt: string
}

export interface AdminConversationRoutingSnapshot {
  generatedAt: string
  localTime: string
  serviceDay: string
  permissions: {
    canManageGlobal: boolean
    manageableGroupIds: string[]
  }
  policy: AdminConversationRoutingPolicy | null
  queue: {
    awaitingOperator: number
    unassignedAwaitingOperator: number
    assignedAwaitingOperator: number
  }
  diagnostics: {
    state: 'normal' | 'no_shift' | 'overloaded' | 'configuration_conflict'
    messages: string[]
  }
  operators: Array<{
    adminId: number
    displayName: string
    accountRole: 'admin' | 'owner'
    accountStatus: string
  }>
  groups: AdminConversationGroup[]
  rules: AdminConversationRoutingRule[]
}

export interface AdminConversationRoutingMutationResult {
  snapshot: AdminConversationRoutingSnapshot
  replayed: boolean
}

export interface AdminConversationDispatchResult {
  dispatchId: string
  requested: number
  assigned: number
  alreadyAssigned: number
  skipped: number
  outcomes: Array<{
    conversationId: string
    status: string
    assignmentVersion: number | null
    groupId: string | null
    adminId: number | null
  }>
  replayed: boolean
}
