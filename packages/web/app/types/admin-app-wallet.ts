export type AdminWalletDirection = 'credit' | 'debit'
export type AdminWalletEntryType = 'admin_credit' | 'admin_debit' | 'compensation' | 'reversal'
export type AdminWalletReasonCode = 'manual_adjustment' | 'service_compensation' | 'correction' | 'reversal'
export type AdminWalletAdjustmentStatus =
  | 'pending_review'
  | 'executing'
  | 'applied'
  | 'rejected'
  | 'cancelled'
  | 'failed'

export interface AdminWalletAccountSummary {
  accountId: string
  emailMasked: string
  nickname: string | null
  accountStatus: string
  balance: number
  ledgerVersion: number
  walletStatus: 'active' | 'frozen'
  lastEntryAt: string | null
}

export interface AdminWalletEntry {
  entryId: string
  publicReference: string
  type: AdminWalletEntryType
  direction: AdminWalletDirection
  amount: number
  reason: { code: AdminWalletReasonCode; label: string }
  userVisibleNote: string
  balanceAfter: number
  sequence: number
  status: 'posted'
  postedAt: string
  originalEntryId: string | null
  reversalEntryId: string | null
}

export interface AdminWalletAdjustment {
  adjustmentId: string
  account: AdminWalletAccountSummary
  actionType: AdminWalletEntryType
  direction: AdminWalletDirection
  amount: number
  reason: { code: AdminWalletReasonCode; label: string }
  userVisibleNote: string
  internalNote: string
  businessReference: string
  originalEntryId: string | null
  balanceBefore: number
  balanceAfter: number
  previewLedgerVersion: number
  currentBalance: number
  currentLedgerVersion: number
  status: AdminWalletAdjustmentStatus
  version: number
  requestedBy: { id: number; label: string }
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  entryId: string | null
  createdAt: string
  reviewedAt: string | null
  appliedAt: string | null
}

export interface AdminWalletAdjustmentPreview {
  account: AdminWalletAccountSummary
  actionType: AdminWalletEntryType
  direction: AdminWalletDirection
  amount: number
  reason: { code: AdminWalletReasonCode; label: string }
  userVisibleNote: string
  businessReference: string
  originalEntryId: string | null
  balanceBefore: number
  balanceAfter: number
  ledgerVersion: number
  requiresIndependentReview: true
  canSubmit: boolean
  riskCodes: string[]
}

export interface AdminWalletState {
  account: AdminWalletAccountSummary
  wallet: {
    currencyCode: 'mei_coin'
    displayName: '金币'
    balance: number
    ledgerVersion: number
    status: 'active' | 'frozen'
    lastEntryAt: string | null
    lastSyncedAt: string
    disclaimer: string
  }
  entries: AdminWalletEntry[]
  adjustments: AdminWalletAdjustment[]
}
