import type { AdminImportJobStatus } from '~/types/admin-import'

export type AdminImportFigmaState = '正常' | '校验中' | '部分失败' | '已暂停' | '已完成'
export type AdminImportStateTone = 'success' | 'warning' | 'danger'

const ACTIVE_STATUSES = new Set(['uploading', 'validating', 'processing', 'finalizing'])

export function isActiveAdminImportStatus(status: string | undefined): boolean {
  return Boolean(status && ACTIVE_STATUSES.has(status))
}

export function adminImportFigmaState(status: string | undefined): AdminImportFigmaState {
  if (status === 'completed') return '已完成'
  if (status === 'partial_failure' || status === 'failed') return '部分失败'
  if (status === 'paused') return '已暂停'
  if (isActiveAdminImportStatus(status)) return '校验中'
  return '正常'
}

export function adminImportStateTone(status: string | undefined): AdminImportStateTone {
  if (status === 'partial_failure' || status === 'failed') return 'danger'
  if (status === 'paused' || isActiveAdminImportStatus(status)) return 'warning'
  return 'success'
}

export function adminImportStatusLabel(status: string | undefined): string {
  return {
    queued: '待执行',
    uploading: '上传中',
    validating: '校验中',
    processing: '导入中',
    finalizing: '汇总中',
    partial_failure: '部分失败',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
  }[status || ''] || status || '未知'
}

export function adminImportStatusClass(status: string | undefined): string {
  if (status === 'completed') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'partial_failure' || status === 'failed') return 'border-rose-200 bg-rose-50 text-rose-700'
  if (status === 'paused') return 'border-amber-200 bg-amber-50 text-amber-800'
  if (isActiveAdminImportStatus(status)) return 'border-sky-200 bg-sky-50 text-sky-700'
  return 'border-[#eaded8] bg-[#fff9f6] text-[#6a5f5a]'
}

export function formatAdminImportBytes(bytes: number | null | undefined): string {
  if (!Number.isFinite(bytes) || Number(bytes) <= 0) return '—'
  const value = Number(bytes)
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}
