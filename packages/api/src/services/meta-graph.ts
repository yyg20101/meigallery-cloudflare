export const META_GRAPH_API_VERSION = 'v25.0' as const

export function metaEventsEndpoint(pixelId: string) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events`)
  return url.toString()
}

export function metaGraphRequestInit(accessToken: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${accessToken}`)
  return { ...init, headers }
}

const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const MIN_SENSITIVE_TRACE_FRAGMENT_LENGTH = 8

export async function readMetaEventsResponse(
  response: Response,
  sensitiveValues: readonly string[] = [],
) {
  let text: string
  try {
    text = await response.text()
  }
  catch {
    throw new Error('META_GRAPH_RESPONSE_READ_FAILED')
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    body = null
  }

  const eventsReceived = body && typeof body === 'object' && !Array.isArray(body)
    && typeof (body as Record<string, unknown>).events_received === 'number'
    && Number.isFinite((body as Record<string, unknown>).events_received)
    ? (body as Record<string, unknown>).events_received as number
    : undefined
  const error = isPlainRecord(body) && isPlainRecord(body.error) ? body.error : null
  const errorCode = Number.isSafeInteger(error?.code)
    && Number(error?.code) >= 0
    && Number(error?.code) <= 2_147_483_647
    ? Number(error!.code)
    : undefined
  const candidateTraceId = typeof error?.fbtrace_id === 'string' ? error.fbtrace_id : ''
  const traceId = TRACE_ID_PATTERN.test(candidateTraceId)
    && !hasSensitiveTraceConflict(candidateTraceId, sensitiveValues)
    ? candidateTraceId
    : undefined
  return {
    eventsReceived,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(traceId ? { traceId } : {}),
  }
}

function hasSensitiveTraceConflict(traceId: string, sensitiveValues: readonly string[]) {
  return sensitiveValues.some((value) => {
    if (typeof value !== 'string') return false
    const sensitive = value.trim()
    if (sensitive.length < MIN_SENSITIVE_TRACE_FRAGMENT_LENGTH) return false
    return traceId.includes(sensitive) || sensitive.includes(traceId)
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
