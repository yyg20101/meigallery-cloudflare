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

  it.each([
    ['ExactTrace_123', ['ExactTrace_123']],
    ['SensitiveToken_123_suffix', ['SensitiveToken_123']],
    ['prefix_SensitiveToken_123', ['SensitiveToken_123']],
    ['TraceToken_123', ['prefix_TraceToken_123_suffix']],
  ])('拒绝与敏感值双向包含的 trace: %s', async (traceId, sensitiveValues) => {
    const parsed = await readMetaEventsResponse(new Response(JSON.stringify({
      error: { code: 190, fbtrace_id: traceId },
    }), { status: 400 }), sensitiveValues)

    expect(parsed).toEqual({ eventsReceived: undefined, errorCode: 190 })
  })

  it('忽略空值和过短敏感片段，不误伤合法 trace', async () => {
    const parsed = await readMetaEventsResponse(new Response(JSON.stringify({
      error: { code: 190, fbtrace_id: 'Trace_safe_123' },
    }), { status: 400 }), ['', ' ', 'Trace', 'safe'])

    expect(parsed).toEqual({
      eventsReceived: undefined,
      errorCode: 190,
      traceId: 'Trace_safe_123',
    })
  })
})
