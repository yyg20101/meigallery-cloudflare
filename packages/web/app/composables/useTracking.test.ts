import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTracking } from './useTracking'

const api = vi.fn()
const trackStandardEvent = vi.fn()

describe('useTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api.mockReset()
    api.mockResolvedValue({ data: { attempted: true } })
    trackStandardEvent.mockReset()
    trackStandardEvent.mockReturnValue(true)
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useFacebookPixel', () => ({ trackStandardEvent }))
    vi.stubGlobal('useMarketingConsent', () => ({
      state: { value: 'granted' },
      canTrackMarketing: { value: true },
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(['Contact', 'CompleteRegistration'] as const)('执行活动 %s 指令并上报 attempted 回执', async eventName => {
    await useTracking().executePixelInstructions([instruction(eventName)])

    expect(trackStandardEvent).toHaveBeenCalledWith(
      eventName,
      { method: 'email' },
      { eventID: `meta:${eventName}:event_1` },
    )
    expect(api).toHaveBeenCalledWith('/api/conversions/pixel-receipts', {
      method: 'POST',
      body: {
        deliveryId: 'cdlv_1',
        attempted: true,
        receiptToken: 'receipt_1',
      },
    })
  })

  it('拒绝 Lead 与结构不完整指令', async () => {
    await useTracking().executePixelInstructions([
      instruction('Lead'),
      { ...instruction('Contact'), receiptToken: '' },
    ])

    expect(trackStandardEvent).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('当前营销授权不可用时不执行响应中的历史指令', async () => {
    vi.stubGlobal('useMarketingConsent', () => ({
      state: { value: 'denied' },
      canTrackMarketing: { value: false },
    }))

    await useTracking().executePixelInstructions([instruction('CompleteRegistration')])

    expect(trackStandardEvent).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('Pixel 回执失败时沿用有界重试且不重复执行 Pixel', async () => {
    api.mockRejectedValue(new Error('receipt failed'))

    await useTracking().executePixelInstructions([instruction('Contact')])
    await vi.runAllTimersAsync()

    expect(trackStandardEvent).toHaveBeenCalledOnce()
    expect(api).toHaveBeenCalledTimes(4)
  })
})

function instruction(eventName: 'Contact' | 'Lead' | 'CompleteRegistration') {
  return {
    deliveryId: 'cdlv_1',
    eventName,
    eventId: `meta:${eventName}:event_1`,
    payload: { method: 'email' },
    receiptToken: 'receipt_1',
  }
}
