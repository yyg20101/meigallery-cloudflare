import { beforeEach, describe, expect, it, vi } from 'vitest'

const standardEvent = vi.fn(() => true)
vi.mock('./metaPixel.client', () => ({ metaPixelAdapter: { standardEvent } }))

describe('浏览器广告平台 adapter registry', () => {
  beforeEach(() => standardEvent.mockClear())

  it('按 provider 分发 Meta 指令', async () => {
    const { executeAdBrowserInstruction } = await import('./adPlatformBrowser.client')
    expect(executeAdBrowserInstruction({
      provider: 'meta',
      deliveryId: 'delivery_1',
      eventName: 'Contact',
      eventId: 'event_1',
      payload: {},
      receiptToken: 'receipt_1',
    })).toBe(true)
    expect(standardEvent).toHaveBeenCalledWith('Contact', {}, { eventID: 'event_1' })
  })
})

