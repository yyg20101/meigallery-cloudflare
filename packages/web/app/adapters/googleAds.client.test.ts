import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const grantedConsent = {
  consentVersion: 1,
  marketingAllowed: true,
  adUserDataAllowed: true,
  adPersonalizationAllowed: false,
  decidedAt: '2026-07-15T00:00:00.000Z',
}

function instruction(destination = 'AW-123456789/Contact_Label', externalEventId = 'mg3_contact_123') {
  return {
    deliveryId: 'delivery_google_contact_1',
    provider: 'google' as const,
    canonicalEvent: 'Contact' as const,
    externalEventId,
    receiptToken: `v1.${'a'.repeat(16)}.${'b'.repeat(43)}`,
    descriptor: {
      provider: 'google' as const,
      canonicalEvent: 'Contact' as const,
      browserEventName: 'conversion',
      browserDestination: destination,
      serverDestination: 'customers/123/conversionActions/456',
    },
    payload: { value: 1, currency: 'CNY', email: 'blocked@example.com', gclid: 'blocked-click' },
  }
}

describe('Google Ads Browser adapter', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (window as Window & { dataLayer?: unknown }).dataLayer
    delete (window as Window & { gtag?: unknown }).gtag
    document.head.querySelectorAll('script[src*="googletagmanager.com/gtag/js"]').forEach(element => element.remove())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as Window & { dataLayer?: unknown }).dataLayer
    delete (window as Window & { gtag?: unknown }).gtag
  })

  it('未同意时零脚本、零 queue、零平台调用', async () => {
    const { createGoogleAdsAdapter } = await import('./googleAds.client')
    const adapter = createGoogleAdsAdapter()
    const append = vi.spyOn(document.head, 'appendChild')

    await expect(adapter.initialize(
      { provider: 'google', tagId: 'AW-123456789' },
      { ...grantedConsent, marketingAllowed: false, adUserDataAllowed: false },
    )).resolves.toBe(false)

    expect(append).not.toHaveBeenCalled()
    expect((window as Window & { dataLayer?: unknown }).dataLayer).toBeUndefined()
    await expect(adapter.track(instruction())).resolves.toBe(false)
  })

  it('按 Basic Consent Mode 顺序设置 denied default、当前授权 update，再加载脚本和配置', async () => {
    const { createGoogleAdsAdapter } = await import('./googleAds.client')
    const adapter = createGoogleAdsAdapter()
    let queueAtAppend: unknown[] = []
    let script: HTMLScriptElement | undefined
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => {
      script = node as unknown as HTMLScriptElement
      queueAtAppend = [...((window as Window & { dataLayer: unknown[] }).dataLayer)]
      return node
    })

    await expect(adapter.initialize(
      { provider: 'google', tagId: 'AW-123456789' },
      grantedConsent,
    )).resolves.toBe(true)

    expect(queueAtAppend).toEqual([
      ['consent', 'default', {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
      }],
      ['consent', 'update', {
        ad_storage: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
      }],
    ])
    const queue = (window as Window & { dataLayer: unknown[] }).dataLayer
    expect(queue[2]).toEqual(['js', expect.any(Date)])
    expect(queue[3]).toEqual(['config', 'AW-123456789'])
    expect(script?.src).toBe('https://www.googletagmanager.com/gtag/js?id=AW-123456789')
  })

  it('conversion 只发送安全 payload、合法 send_to 和不超过 64 字符的 transaction_id', async () => {
    const { createGoogleAdsAdapter } = await import('./googleAds.client')
    const adapter = createGoogleAdsAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)
    await adapter.initialize({ provider: 'google', tagId: 'AW-123456789' }, grantedConsent)

    await expect(adapter.track(instruction())).resolves.toBe(true)

    expect((window as Window & { dataLayer: unknown[] }).dataLayer.at(-1)).toEqual([
      'event',
      'conversion',
      { value: 1, currency: 'CNY', send_to: 'AW-123456789/Contact_Label', transaction_id: 'mg3_contact_123' },
    ])
  })

  it.each([
    ['非法 destination', 'contact', 'mg3_contact_123'],
    ['其他 Google Ads 账户 destination', 'AW-987654321/Contact_Label', 'mg3_contact_123'],
    ['含 PII 的 event id', 'AW-123456789/Contact_Label', 'person@example.com'],
    ['超长 event id', 'AW-123456789/Contact_Label', 'x'.repeat(65)],
  ])('%s 时 fail closed', async (_label, destination, eventId) => {
    const { createGoogleAdsAdapter } = await import('./googleAds.client')
    const adapter = createGoogleAdsAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)
    await adapter.initialize({ provider: 'google', tagId: 'AW-123456789' }, grantedConsent)

    await expect(adapter.track(instruction(destination, eventId))).resolves.toBe(false)
    expect((window as Window & { dataLayer: unknown[] }).dataLayer).toHaveLength(4)
  })

  it('Browser Signal 使用安全事件映射且绝不发送 conversion', async () => {
    const { createGoogleAdsAdapter } = await import('./googleAds.client')
    const adapter = createGoogleAdsAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)
    await adapter.initialize({ provider: 'google', tagId: 'AW-123456789' }, grantedConsent)

    await adapter.trackSignal('PageView', { page_type: 'gallery' })
    await adapter.trackSignal('ViewContent', { content_id: 'gallery_1' })
    await adapter.trackSignal('Search', { search_string: 'portrait' })

    const events = (window as Window & { dataLayer: unknown[][] }).dataLayer.slice(4)
    expect(events.map(item => item[1])).toEqual(['page_view', 'view_item', 'search'])
    expect(events.flat()).not.toContain('conversion')
  })

  it('检测到第三方已有 Google global 时 fail closed 且不接管', async () => {
    const existingQueue: unknown[] = []
    const existingGtag = vi.fn((...args: unknown[]) => existingQueue.push(args))
    ;(window as unknown as { dataLayer: unknown[][] }).dataLayer = existingQueue as unknown[][]
    ;(window as unknown as { gtag: (...args: unknown[]) => void }).gtag = existingGtag
    const { createGoogleAdsAdapter } = await import('./googleAds.client')
    const adapter = createGoogleAdsAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)
    await expect(adapter.initialize({ provider: 'google', tagId: 'AW-123456789' }, grantedConsent)).resolves.toBe(false)

    await adapter.teardown()

    expect((window as Window & { dataLayer: unknown[] }).dataLayer).toBe(existingQueue)
    expect((window as Window & { gtag: unknown }).gtag).toBe(existingGtag)
    expect(existingGtag).not.toHaveBeenCalled()
  })

  it('teardown 在删除自有 global 前将 Google 授权更新为 denied', async () => {
    const { createGoogleAdsAdapter } = await import('./googleAds.client')
    const adapter = createGoogleAdsAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)
    await adapter.initialize({ provider: 'google', tagId: 'AW-123456789' }, grantedConsent)
    const queue = (window as Window & { dataLayer: unknown[][] }).dataLayer

    await adapter.teardown()

    expect(queue.at(-1)).toEqual(['consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    }])
    expect((window as Window & { dataLayer?: unknown }).dataLayer).toBeUndefined()
    expect((window as Window & { gtag?: unknown }).gtag).toBeUndefined()
  })
})
