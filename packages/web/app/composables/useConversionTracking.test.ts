import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversionTracking } from './useConversionTracking'

const trackContact = vi.fn()

describe('useConversionTracking', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    trackContact.mockReset()
  })

  it('维持 trackConversion contact 形状并委托 Tracking Facade', async () => {
    trackContact.mockResolvedValue(undefined)
    vi.stubGlobal('useTracking', () => ({ trackContact }))

    await useConversionTracking().trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: { action_type: 'open_link', ignored: 'value' },
    })

    expect(trackContact).toHaveBeenCalledWith({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })
  })

  it('运行时拒绝历史 complete_registration', async () => {
    vi.stubGlobal('useTracking', () => ({ trackContact }))

    await useConversionTracking().trackConversion('complete_registration' as never, {
      methodType: 'email',
      actionTarget: 'register',
    })

    expect(trackContact).not.toHaveBeenCalled()
  })
})
