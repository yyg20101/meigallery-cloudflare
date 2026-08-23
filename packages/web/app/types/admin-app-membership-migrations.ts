export type MembershipLegacyJobStatus =
  | 'dry_run'
  | 'pending_review'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'partial_failed'
  | 'cancelled'

export type MembershipLegacyItemStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'conflict'
  | 'evidence_insufficient'
  | 'migrated'
  | 'failed'
  | 'stale'

export interface MembershipLegacyMapping {
  legacyLevelCode: string
  targetTierId: string
  targetTierName: string
  targetRank: number
}

export interface MembershipLegacyJob {
  jobId: string
  catalogVersionId: string
  status: MembershipLegacyJobStatus
  version: number
  mappings: MembershipLegacyMapping[]
  mappingSha256: string
  counts: Record<MembershipLegacyItemStatus, number>
  total: number
  createdBy: { id: number; label: string }
  createdAt: string
  submittedAt: string | null
  executedBy: { id: number; label: string } | null
  executionStartedAt: string | null
  executionLeaseExpiresAt: string | null
  executedAt: string | null
}

export interface MembershipLegacyItem {
  itemId: string
  legacyMembershipId: string
  userId: number
  accountId: string | null
  emailMasked: string
  legacyLevel: { id: string; code: string; name: string; rank: number }
  legacyStartsAt: string | null
  legacyExpiresAt: string | null
  targetTier: { tierId: string; code: string; name: string; rank: number }
  evidenceSha256: string
  status: MembershipLegacyItemStatus
  version: number
  conflict: { code: string; summary: string } | null
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  reviewedAt: string | null
  resultGrantId: string | null
  failure: { code: string; summary: string } | null
  createdAt: string
  updatedAt: string
}

export interface MembershipLegacyWorkspace {
  job: MembershipLegacyJob
  items: MembershipLegacyItem[]
  permissions: {
    canSubmit: boolean
    canReview: boolean
    canExecute: boolean
    executionRecoverable: boolean
    selfReviewBlocked: boolean
    executionBlockedReason: string | null
  }
}

export const MEMBERSHIP_LEGACY_JOB_LABELS: Record<MembershipLegacyJobStatus, string> = {
  dry_run: 'Dry-run 待提交',
  pending_review: '逐项复核中',
  ready: '待受控执行',
  executing: '执行中',
  completed: '已完成',
  partial_failed: '部分失败',
  cancelled: '已取消',
}

export const MEMBERSHIP_LEGACY_ITEM_LABELS: Record<MembershipLegacyItemStatus, string> = {
  draft: 'Dry-run 可迁移',
  pending_review: '待独立复核',
  approved: '已批准',
  rejected: '已拒绝',
  conflict: '映射冲突',
  evidence_insufficient: '证据不足',
  migrated: '已迁移',
  failed: '执行失败',
  stale: '证据已变化',
}
