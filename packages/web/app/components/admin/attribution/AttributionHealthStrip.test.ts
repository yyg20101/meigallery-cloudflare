import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AttributionHealthStrip from './AttributionHealthStrip.vue'

vi.stubGlobal('formatAnalyticsNumber', (value: unknown) => String(value ?? 0))
vi.stubGlobal('formatAnalyticsDateTime', (value: unknown) => String(value || '-'))

const mountOptions = {
  global: {
    mocks: {
      formatAnalyticsDateTime: (value: unknown) => String(value || '-'),
    },
  },
}

describe('AttributionHealthStrip', () => {
  it('未知 Pixel 和 CAPI 状态显示为未确认', () => {
    const wrapper = mount(AttributionHealthStrip, mountOptions)

    expect(wrapper.text()).toContain('Pixel')
    expect(wrapper.text()).toContain('CAPI')
    expect(wrapper.text()).toContain('未确认')
    expect(wrapper.text()).not.toContain('关闭')
  })

  it('明确关闭时才显示关闭', () => {
    const wrapper = mount(AttributionHealthStrip, {
      ...mountOptions,
      props: {
        pixelEnabled: false,
        capiEnabled: true,
      },
    })

    expect(wrapper.text()).toContain('关闭')
    expect(wrapper.text()).toContain('已开启')
  })
})
