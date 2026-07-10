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
  it('独立展示 Pixel、CAPI 与四类投递数量', () => {
    const wrapper = mount(AttributionHealthStrip, {
      ...mountOptions,
      props: {
        pixelEnabled: true,
        capiEnabled: true,
        pixelAttemptedCount: 12,
        capiSentCount: 9,
        failedCount: 2,
        skippedCount: 1,
      },
    })

    const labels = wrapper.findAll('[data-health-label]').map(item => item.text())
    expect(labels).toEqual(['Pixel 状态', 'CAPI 状态', 'Pixel 尝试', 'CAPI 成功', '失败', '跳过'])
    expect(wrapper.text()).toContain('12')
    expect(wrapper.text()).toContain('9')
    expect(wrapper.text()).toContain('2')
    expect(wrapper.text()).toContain('1')
    expect(wrapper.text()).not.toContain('已同步')
  })

  it('未知状态保持未确认且不误报为关闭', () => {
    const wrapper = mount(AttributionHealthStrip, mountOptions)

    expect(wrapper.text()).toContain('未确认')
    expect(wrapper.text()).not.toContain('关闭')
  })
})
