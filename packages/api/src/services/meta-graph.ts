export const META_GRAPH_API_VERSION = 'v25.0' as const

export function metaEventsEndpoint(pixelId: string, accessToken: string) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events`)
  url.searchParams.set('access_token', accessToken)
  return url.toString()
}

export async function readMetaEventsResponse(response: Response) {
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
  return { eventsReceived }
}
