import type { AdminWalletEntryType, AdminWalletReasonCode } from './admin-app-wallet'

export type AdminWalletBatchStatus = 'draft' | 'pending_review' | 'processing' | 'completed' | 'partial_failed' | 'cancelled'
export type AdminWalletBatchItemStatus = 'valid' | 'invalid' | 'submitting' | 'submitted' | 'submit_failed'

export interface AdminWalletBatchItem {
  itemId: string
  rowNumber: number
  accountId: string | null
  actionType: AdminWalletEntryType | null
  amount: number | null
  reasonCode: AdminWalletReasonCode | null
  userVisibleNote: string | null
  internalNote: string | null
  businessReference: string | null
  status: AdminWalletBatchItemStatus
  error: { code: string; summary: string } | null
  adjustmentId: string | null
}

export interface AdminWalletBatch {
  batchId: string
  policyId: string
  status: AdminWalletBatchStatus
  sourceName: string
  sourceSha256: string
  totalCount: number
  validCount: number
  invalidCount: number
  totalAmount: number
  riskCodes: string[]
  submittedCount: number
  version: number
  createdBy: { id: number; label: string }
  processingStartedAt: string | null
  processingLeaseExpiresAt: string | null
  processingRecoverable: boolean
  submittedAt: string | null
  createdAt: string
  updatedAt: string
  items?: AdminWalletBatchItem[]
}

export const WALLET_BATCH_STATUS_LABELS: Record<AdminWalletBatchStatus, string> = {
  draft: '校验完成',
  pending_review: '待复核',
  processing: '提交中',
  completed: '已提交复核',
  partial_failed: '部分失败',
  cancelled: '已取消',
}

export const WALLET_BATCH_ITEM_STATUS_LABELS: Record<AdminWalletBatchItemStatus, string> = {
  valid: '校验通过',
  invalid: '校验失败',
  submitting: '提交中',
  submitted: '已提交复核',
  submit_failed: '提交失败',
}
