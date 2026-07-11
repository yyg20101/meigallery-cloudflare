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

  it('单日零值渲染真实可见 marker，不把只有 M 命令当作趋势图', () => {
    const wrapper = mount(AttributionTrendPanel, {
      props: {
        title: '业务转化趋势',
        rows: [{ date: '2026-07-10', business: { contactCount: 0 } }],
        series: [{ key: 'business.contactCount', label: '有效联系', layer: 'business', aggregation: { type: 'sum' } }],
      },
    })

    expect(wrapper.get('[data-trend-path]').attributes('d')).toMatch(/^M /)
    expect(wrapper.findAll('[data-trend-marker]')).toHaveLength(1)
    expect(Number(wrapper.get('[data-trend-marker]').attributes('r'))).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('2026-07-10')
    expect(wrapper.text()).toContain('有效联系 0')
  })

  it('percent 摘要按 numerator/denominator 加权且不超过 100%', () => {
    const wrapper = mount(AttributionTrendPanel, {
      props: {
        title: '匹配质量趋势',
        rows: [
          { date: '2026-07-09', fbp: { rate: 0.9, numerator: 9, denominator: 10 } },
          { date: '2026-07-10', fbp: { rate: 0.5, numerator: 1, denominator: 2 } },
        ],
        series: [{
          key: 'fbp.rate',
          label: 'fbp',
          layer: 'quality',
          format: 'percent',
          aggregation: { type: 'weightedRate', numeratorKey: 'fbp.numerator', denominatorKey: 'fbp.denominator' },
        }],
      },
    })

    expect(wrapper.get('[data-trend-summary]').text()).toContain('fbp 83.33%')
    expect(wrapper.get('[data-attribution-chart]').attributes('aria-label')).toContain('fbp 83.33%')
    expect(wrapper.text()).not.toContain('140%')
  })

  it('同层多序列使用不同线型，图例与 aria 同步说明', () => {
    const wrapper = mount(AttributionTrendPanel, {
      props: {
        title: '业务转化趋势',
        rows: [
          { date: '2026-07-09', business: { contactCount: 1, completeRegistrationCount: 2 } },
          { date: '2026-07-10', business: { contactCount: 2, completeRegistrationCount: 3 } },
        ],
        series: [
          { key: 'business.contactCount', label: '有效联系', layer: 'business', aggregation: { type: 'sum' } },
          { key: 'business.completeRegistrationCount', label: '完成注册', layer: 'business', aggregation: { type: 'sum' } },
        ],
      },
    })

    const paths = wrapper.findAll('[data-trend-path]')
    const legendSwatches = wrapper.findAll('[data-trend-legend-swatch]')
    expect(paths.map(path => path.attributes('data-series-variant'))).toEqual(['solid', 'dashed'])
    expect(paths[0]!.attributes('stroke-dasharray')).not.toBe(paths[1]!.attributes('stroke-dasharray'))
    expect(wrapper.findAll('[data-trend-legend-variant]').map(item => item.attributes('data-series-variant'))).toEqual(['solid', 'dashed'])
    expect(legendSwatches).toHaveLength(paths.length)
    for (const path of paths) {
      const seriesKey = path.attributes('data-series-key')!
      const legend = wrapper.get(`[data-trend-legend-swatch][data-series-key="${seriesKey}"]`)
      const legendLine = legend.get('[data-trend-legend-line]')
      const legendMarker = legend.get('[data-trend-legend-marker]')
      const chartMarker = wrapper.get(`[data-trend-marker][data-series-key="${seriesKey}"]`)
      expect(legendLine.attributes('stroke')).toBe(path.attributes('stroke'))
      expect(legendLine.attributes('stroke-dasharray')).toBe(path.attributes('stroke-dasharray'))
      expect(legendLine.attributes('opacity')).toBe(path.attributes('opacity'))
      expect(legendMarker.attributes('r')).toBe(chartMarker.attributes('r'))
      expect(legendMarker.attributes('fill')).toBe(chartMarker.attributes('fill'))
      expect(legendMarker.attributes('stroke')).toBe(chartMarker.attributes('stroke'))
      expect(legendMarker.attributes('opacity')).toBe(chartMarker.attributes('opacity'))
    }
    expect(wrapper.get('[data-attribution-chart]').attributes('aria-label')).toContain('实线')
    expect(wrapper.get('[data-attribution-chart]').attributes('aria-label')).toContain('虚线')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s rate 作为缺失样本分段且不画 marker', (_, missingRate) => {
    const wrapper = mount(AttributionTrendPanel, {
      props: {
        title: '匹配质量趋势',
        rows: [
          { date: '2026-07-08', fbp: { rate: 0.75, numerator: 3, denominator: 4 } },
          { date: '2026-07-09', fbp: { rate: missingRate, numerator: 0, denominator: 0 } },
          { date: '2026-07-10', fbp: { rate: 0.5, numerator: 1, denominator: 2 } },
        ],
        series: [{
          key: 'fbp.rate',
          label: 'fbp',
          layer: 'quality',
          format: 'percent',
          aggregation: { type: 'weightedRate', numeratorKey: 'fbp.numerator', denominatorKey: 'fbp.denominator' },
        }],
      },
    })

    const path = wrapper.get('[data-trend-path]').attributes('d')!
    expect(path.match(/\bM\b/g)).toHaveLength(2)
    expect(path).not.toMatch(/\bL\b/)
    expect(wrapper.findAll('[data-trend-marker]')).toHaveLength(2)
    expect(wrapper.find('[data-trend-marker][data-date="2026-07-09"]').exists()).toBe(false)
    expect(wrapper.get('[data-attribution-chart]').attributes('aria-label')).toContain('缺失 1 个样本，缺失处不连线且不显示数据点')
  })

  it('图表由自身横向滚动容器承载', () => {
    const wrapper = mount(AttributionTrendPanel, {
      props: {
        title: '投递趋势',
        rows: [{ date: '2026-07-10', delivery: { capiSent: 1 } }],
        series: [{ key: 'delivery.capiSent', label: 'CAPI 接收', layer: 'capi', aggregation: { type: 'sum' } }],
      },
    })

    expect(wrapper.get('[data-chart-scroll]').classes()).toContain('overflow-x-auto')
    expect(wrapper.get('[data-chart-scroll]').classes()).not.toContain('overflow-hidden')
  })
})
