const SAFE_IMPORT_JOB_ID = /^[A-Za-z0-9_-]{1,96}$/

export function resolveAdminImportErrorReportUrl(jobId: unknown) {
  const id = String(jobId ?? '').trim()
  if (!SAFE_IMPORT_JOB_ID.test(id)) return ''

  return `/api/admin/import-jobs/${encodeURIComponent(id)}/errors`
}
