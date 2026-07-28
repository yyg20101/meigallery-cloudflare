import { describe, expect, it } from 'vitest'
import { readBrowserAdAttributionSignals } from './adAttributionSignals'

describe('浏览器广告来源信号', () => {
  it('只读取受支持的 click ID 与受管来源', () => {
    expect(readBrowserAdAttributionSignals({
      fbclid: 'meta-click',
      ttclid: ['tiktok-click', 'ignored'],
      gclid: 'google-click',
      gbraid: 'google-braid',
      wbraid: 'google-web-braid',
      mg_source: 'ad-meta-team',
      provider: 'tiktok',
      utm_source: 'facebook',
    })).toEqual({
      fbclid: 'meta-click',
      ttclid: 'tiktok-click',
      gclid: 'google-click',
      gbraid: 'google-braid',
      wbraid: 'google-web-braid',
      trackingSourceSlug: 'ad-meta-team',
    })
  })

  it('超长信号保留为服务端可拒绝的长度', () => {
    expect(readBrowserAdAttributionSignals({
      ttclid: 'x'.repeat(1_500),
    }).ttclid).toHaveLength(1_001)
  })
})
