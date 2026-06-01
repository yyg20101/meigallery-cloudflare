interface ApiErrorBody {
  message?: unknown
  error?: unknown
}

function readBodyMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null

  const apiBody = body as ApiErrorBody
  if (typeof apiBody.message === 'string' && apiBody.message.trim()) {
    return apiBody.message
  }
  if (typeof apiBody.error === 'string' && apiBody.error.trim()) {
    return apiBody.error
  }

  return null
}

function parseErrorData(data: unknown): unknown {
  if (typeof data !== 'string') return data

  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback

  const apiError = error as { data?: unknown; message?: unknown }
  const dataMessage = readBodyMessage(parseErrorData(apiError.data))
  if (dataMessage) return dataMessage

  if (typeof apiError.message === 'string' && apiError.message.trim()) {
    return apiError.message
  }

  return fallback
}
