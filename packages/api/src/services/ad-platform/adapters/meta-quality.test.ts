import { describe, expect, it, vi } from 'vitest'
import { fetchMetaQuality, parseMetaQualityResponse } from './meta-quality'

const response = {
  web: [
    {
      event_name: 'Contact',
      event_match_quality: {
        composite_score: 6.1,
        match_key_feedback: [
          { identifier: 'fbp', coverage: { percentage: 100 } },
          { identifier: 'fbc', coverage: { percentage: 94.1 } },
        ],
      },
    },
    {
      event_name: 'CompleteRegistration',
      event_match_quality: { composite_score: 7.2, match_key_feedback: [] },
    },
    { event_name: 'Lead', event_match_quality: { composite_score: 9.9 } },
  ],
}

describe('Meta 通用质量 Adapter', () => {
  it('只解析活动事件和批准指标', () => {
    expect(parseMetaQualityResponse(response)).toEqual([
      { canonicalEvent: 'Contact', metricKey: 'emq_score', value: 6.1 },
      { canonicalEvent: 'Contact', metricKey: 'fbp_coverage', value: 100 },
      { canonicalEvent: 'Contact', metricKey: 'fbc_coverage', value: 94.1 },
      { canonicalEvent: 'CompleteRegistration', metricKey: 'emq_score', value: 7.2 },
    ])
  })

  it('使用 Bearer 凭证请求且 URL 不包含凭证', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token')
      expect(url).not.toContain('private-token')
      return new Response(JSON.stringify(response), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchMetaQuality({
      datasetId: '1277657707436781',
      credential: 'private-token',
      fetcher,
    })
    expect(result.metrics).toHaveLength(4)
    expect(result.errorCategory).toBe('')
  })

  it('将权限错误归类为稳定错误码', async () => {
    const result = await fetchMetaQuality({
      datasetId: '1277657707436781',
      credential: 'private-token',
      fetcher: async () => new Response('{}', { status: 403 }),
    })
    expect(result).toEqual({ metrics: [], errorCategory: 'permission_denied' })
  })
})
