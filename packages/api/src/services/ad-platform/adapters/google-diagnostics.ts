import { getGoogleAccessToken, GoogleAuthError, parseGoogleServiceAccount } from './google-auth'

const GOOGLE_REQUEST_STATUS_ENDPOINT = 'https://datamanager.googleapis.com/v1/requestStatus:retrieve'
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const REASON_PATTERN = /^(?:PROCESSING_ERROR|PROCESSING_WARNING)_REASON_[A-Z0-9_]{1,120}$/

export type GoogleDiagnosticClassification = 'processed' | 'processing' | 'rejected' | 'retryable' | 'credential_invalid'

export interface GoogleDiagnosticResult {
  classification: GoogleDiagnosticClassification
  status: number
  requestStatus: string
  errorReasons?: string[]
  warningReasons?: string[]
}

export async function retrieveGoogleRequestStatus(input: {
  requestId: string
  cloudProjectId: string
  serviceAccount: string
  fetcher?: typeof fetch
}): Promise<GoogleDiagnosticResult> {
  if (!REQUEST_ID_PATTERN.test(input.requestId) || !GCP_PROJECT_ID_PATTERN.test(input.cloudProjectId)) return result('rejected', 0)
  try {
    const accessToken = await getGoogleAccessToken({ credential: parseGoogleServiceAccount(input.serviceAccount), fetcher: input.fetcher })
    const url = new URL(GOOGLE_REQUEST_STATUS_ENDPOINT)
    url.searchParams.set('requestId', input.requestId)
    const response = await (input.fetcher ?? fetch)(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'x-goog-user-project': input.cloudProjectId },
    })
    if (response.status === 401 || response.status === 403) return result('credential_invalid', response.status)
    if (response.status === 404) return result('processing', response.status)
    if (response.status === 429 || response.status >= 500) return result('retryable', response.status)
    if (!response.ok) return result('rejected', response.status)
    return parseResponse(response)
  }
  catch (error) {
    if (error instanceof GoogleAuthError) return result(error.classification === 'credential_invalid' ? 'credential_invalid' : error.classification === 'retryable' ? 'retryable' : 'rejected', 0)
    return result('retryable', 0)
  }
}

async function parseResponse(response: Response): Promise<GoogleDiagnosticResult> {
  let value: unknown
  try { value = await response.json() } catch { return result('retryable', response.status) }
  if (!isRecord(value) || !Array.isArray(value.requestStatusPerDestination) || value.requestStatusPerDestination.length === 0) return result('processing', response.status)
  const rows = value.requestStatusPerDestination.filter(isRecord)
  if (rows.length !== value.requestStatusPerDestination.length) return result('processing', response.status)
  const statuses = rows.map(row => safeStatus(row.requestStatus))
  const errorReasons = reasons(rows, 'errorInfo', 'errorCounts')
  const warningReasons = reasons(rows, 'warningInfo', 'warningCounts')
  if (statuses.some(status => status === 'FAILED' || status === 'PARTIAL_SUCCESS')) {
    return { ...result('rejected', response.status, statuses.find(status => status === 'FAILED' || status === 'PARTIAL_SUCCESS') ?? ''), errorReasons, warningReasons }
  }
  if (statuses.every(status => status === 'SUCCESS')) return { ...result('processed', response.status, 'SUCCESS'), errorReasons, warningReasons }
  return { ...result('processing', response.status, statuses.find(Boolean) ?? ''), errorReasons, warningReasons }
}

function result(classification: GoogleDiagnosticClassification, status: number, requestStatus = ''): GoogleDiagnosticResult {
  return { classification, status, requestStatus }
}

function reasons(rows: Record<string, unknown>[], infoKey: string, countsKey: string) {
  const values = new Set<string>()
  for (const row of rows) {
    const info = row[infoKey]
    if (!isRecord(info) || !Array.isArray(info[countsKey])) continue
    for (const count of info[countsKey]) {
      if (!isRecord(count) || typeof count.reason !== 'string' || !REASON_PATTERN.test(count.reason)) continue
      values.add(count.reason)
    }
  }
  return [...values].sort()
}

function safeStatus(value: unknown) {
  return value === 'SUCCESS' || value === 'PROCESSING' || value === 'FAILED' || value === 'PARTIAL_SUCCESS' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
