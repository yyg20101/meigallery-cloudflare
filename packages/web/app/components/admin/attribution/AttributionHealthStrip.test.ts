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
  it('按平台标签独立展示 Browser、Server 与投递数量', () => {
    const wrapper = mount(AttributionHealthStrip, {
      ...mountOptions,
      props: {
        browserLabel: 'TikTok Pixel',
        serverLabel: 'TikTok Events API',
        browserEnabled: true,
        serverEnabled: true,
        browserPlanned: 12,
        serverAccepted: 9,
        serverPending: 1,
        serverFailed: 2,
      },
    })

    const labels = wrapper.findAll('[data-health-label]').map(item => item.text())
    expect(labels).toEqual(['TikTok Pixel 状态', 'TikTok Events API 状态', 'Browser 指令', 'Server 已接收', 'Server 处理中', 'Server 失败'])
    expect(wrapper.text()).toContain('12')
    expect(wrapper.text()).toContain('9')
    expect(wrapper.text()).toContain('2')
    expect(wrapper.text()).toContain('1')
    expect(wrapper.text()).not.toContain('Meta')
  })

  it('未知状态保持未确认且不误报为关闭', () => {
    const wrapper = mount(AttributionHealthStrip, mountOptions)

    expect(wrapper.text()).toContain('未确认')
    expect(wrapper.text()).not.toContain('关闭')
  })
})
