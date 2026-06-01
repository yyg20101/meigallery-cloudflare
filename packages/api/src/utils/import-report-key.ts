export function isExpectedImportErrorReportKey(errorReportKey: string, jobId: string): boolean {
  return new RegExp(`^imports/${escapeRegExp(jobId)}/errors\\.csv$`, 'i').test(errorReportKey)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
