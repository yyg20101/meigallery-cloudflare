export type WalletReconciliationDifferenceType = 'balance_mismatch' | 'sequence_mismatch' | 'entry_chain_break'
export type WalletReconciliationCaseStatus = 'open' | 'claimed' | 'creating_forward_fix' | 'forward_fix_requested' | 'resolved' | 'dismissed'

export interface WalletReconciliationRun {
  runId: string
  status: 'running' | 'completed' | 'failed'
  walletCount: number
  differenceCount: number
  createdBy: { id: number; label: string }
  leaseExpiresAt: string | null
  executionRecoverable: boolean
  failureCode: string | null
  completedAt: string | null
  createdAt: string
}

export interface WalletReconciliationCase {
  caseId: string
  runId: string
  accountId: string
  differenceType: WalletReconciliationDifferenceType
  severity: 'p0' | 'p1' | 'p2'
  walletBalance: number
  expectedBalance: number
  walletSequence: number
  expectedSequence: number
  evidenceSha256: string
  status: WalletReconciliationCaseStatus
  version: number
  assignedTo: { id: number; label: string } | null
  claimedAt: string | null
  resolutionNote: string | null
  forwardFixAdjustmentId: string | null
  walletStatus: 'active' | 'frozen' | null
  latestRecovery: {
    commandId: string
    appliedAt: string
  } | null
  forwardFix: {
    eligible: boolean
    direction: 'credit' | 'debit' | null
    amount: number
    reason: string
  }
  createdAt: string
  updatedAt: string
}

export interface WalletReconciliationRecoveryPreview {
  caseId: string
  accountId: string
  anchorVersion: number
  walletStatus: 'active' | 'frozen'
  walletBalance: number
  walletSequence: number
  rebuiltBalance: number
  rebuiltSequence: number
  snapshotChangeRequired: boolean
  coveredCases: Array<{
    caseId: string
    differenceType: WalletReconciliationDifferenceType
    status: WalletReconciliationCaseStatus
    version: number
  }>
  caseSetDigest: string
  eligible: boolean
  blockers: string[]
}

export interface WalletRecovery {
  commandId: string
  caseId: string
  accountId: string
  status: 'applied'
  previousSnapshot: { status: 'frozen'; balance: number; sequence: number }
  rebuiltSnapshot: { status: 'active'; balance: number; sequence: number }
  coveredCaseCount: number
  resolutionNote: string
  evidenceReference: string
  appliedAt: string
}

export const WALLET_RECONCILIATION_TYPE_LABELS: Record<WalletReconciliationDifferenceType, string> = {
  balance_mismatch: '余额快照差异',
  sequence_mismatch: 'Sequence 差异',
  entry_chain_break: '分录链断点',
}

export const WALLET_RECONCILIATION_STATUS_LABELS: Record<WalletReconciliationCaseStatus, string> = {
  open: '待认领',
  claimed: '处理中',
  creating_forward_fix: '创建纠正申请中',
  forward_fix_requested: '等待纠正入账',
  resolved: '已验证解决',
  dismissed: '已排除',
}
