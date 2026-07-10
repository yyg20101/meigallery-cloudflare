import { describe, expect, it } from 'vitest'
import {
  META_GRAPH_API_VERSION,
  metaEventsEndpoint,
  readMetaEventsResponse,
} from './meta-graph'

describe('Meta Graph contract', () => {
  it('统一锁定 v25.0 events endpoint', () => {
    const endpoint = new URL(metaEventsEndpoint('1234567890', 'token-sensitive'))

    expect(META_GRAPH_API_VERSION).toBe('v25.0')
    expect(endpoint.pathname).toBe('/v25.0/1234567890/events')
    expect(endpoint.searchParams.get('access_token')).toBe('token-sensitive')
  })

  it.each([
    [JSON.stringify({ events_received: 1, fbtrace_id: 'trace-sensitive' }), 1],
    [JSON.stringify({ events_received: Number.NaN }), undefined],
    ['not-json', undefined],
    [JSON.stringify(['unexpected']), undefined],
  ])('只解析有限 events_received，不返回 Graph 原始响应 %#', async (body, expected) => {
    const parsed = await readMetaEventsResponse(new Response(body, { status: 200 }))

    expect(parsed).toEqual({ eventsReceived: expected })
    expect(JSON.stringify(parsed)).not.toContain('trace-sensitive')
    expect(JSON.stringify(parsed)).not.toContain('not-json')
  })
})
