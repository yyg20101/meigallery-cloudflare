const SAFE_IMPORT_JOB_ID = /^[A-Za-z0-9_-]{1,96}$/

export function resolveAdminImportErrorReportUrl(jobId: unknown, baseURL: unknown) {
  const id = String(jobId ?? '').trim()
  if (!SAFE_IMPORT_JOB_ID.test(id)) return ''

  const base = normalizeApiDownloadBaseUrl(baseURL)
  if (!base) return ''

  return `${base}/api/admin/import-jobs/${encodeURIComponent(id)}/errors`
}

function normalizeApiDownloadBaseUrl(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw || hasWhitespaceOrControlCharacter(raw) || hasBackslashOrEncodedBackslash(raw)) return ''

  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
    if (parsed.username || parsed.password) return ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

function hasWhitespaceOrControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

function hasBackslashOrEncodedBackslash(value: string) {
  return value.includes('\\') || /%5c/i.test(value)
}
