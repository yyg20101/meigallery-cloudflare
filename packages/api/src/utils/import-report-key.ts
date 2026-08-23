export function isExpectedImportErrorReportKey(errorReportKey: string, jobId: string): boolean {
  return new RegExp(`^imports/${escapeRegExp(jobId)}/errors\\.csv$`, 'i').test(errorReportKey)
}

export function isExpectedImportPackageKey(sourceKey: string, jobId: string): boolean {
  return new RegExp(
    `^imports/${escapeRegExp(jobId)}/packages/[a-f0-9-]{36}\\.zip$`,
    'i',
  ).test(sourceKey)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
