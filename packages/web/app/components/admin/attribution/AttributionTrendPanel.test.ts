import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AttributionTrendPanel from './AttributionTrendPanel.vue'

vi.stubGlobal('formatAnalyticsNumber', (value: unknown) => String(value ?? 0))

describe('AttributionTrendPanel', () => {
  it('输出固定高度、非空 SVG path、可读摘要与证据层标记', () => {
    const wrapper = mount(AttributionTrendPanel, {
      props: {
        title: '投递趋势',
        description: '逐日对比 Pixel 尝试和 CAPI 接收。',
        rows: [
          { date: '2026-07-09', delivery: { pixelAttempted: 2, capiSent: 1 } },
          { date: '2026-07-10', delivery: { pixelAttempted: 4, capiSent: 3 } },
        ],
        series: [
          { key: 'delivery.pixelAttempted', label: 'Pixel 尝试', layer: 'pixel' },
          { key: 'delivery.capiSent', label: 'CAPI 接收', layer: 'capi' },
        ],
      },
    })

    const chart = wrapper.get('[data-attribution-chart]')
    expect(chart.classes()).toContain('h-60')
    expect(chart.attributes('aria-label')).toContain('投递趋势')
    expect(wrapper.findAll('[data-trend-path]')).toHaveLength(2)
    for (const path of wrapper.findAll('[data-trend-path]')) {
      expect(path.attributes('d')?.trim().length).toBeGreaterThan(0)
    }
    expect(wrapper.get('[data-trend-summary]').text()).toContain('Pixel 尝试 6')
    expect(wrapper.get('[data-trend-summary]').text()).toContain('CAPI 接收 4')
    expect(wrapper.find('[data-evidence-layer="pixel"]').exists()).toBe(true)
    expect(wrapper.find('[data-evidence-layer="capi"]').exists()).toBe(true)
  })

  it('单日零值仍生成稳定 path，不把空序列渲染为空图', () => {
    const wrapper = mount(AttributionTrendPanel, {
      props: {
        title: '业务转化趋势',
        rows: [{ date: '2026-07-10', business: { contactCount: 0 } }],
        series: [{ key: 'business.contactCount', label: '有效联系', layer: 'business' }],
      },
    })

    expect(wrapper.get('[data-trend-path]').attributes('d')).toMatch(/^M /)
    expect(wrapper.text()).toContain('2026-07-10')
    expect(wrapper.text()).toContain('有效联系 0')
  })
})
