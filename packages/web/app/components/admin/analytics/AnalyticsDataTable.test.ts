import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AnalyticsDataTable from './AnalyticsDataTable.vue'

vi.stubGlobal('formatAnalyticsNumber', (value: unknown) => String(value ?? 0))
vi.stubGlobal('formatAnalyticsDuration', (value: unknown) => `${value ?? 0} 秒`)

describe('AnalyticsDataTable', () => {
  it('空数据时展示埋点提示', () => {
    const wrapper = mount(AnalyticsDataTable, {
      props: {
        columns: [{ key: 'source', label: '来源' }],
        rows: [],
      },
      global: { stubs: { AnalyticsEmptyState: { template: '<p>暂无数据，部署埋点后会在这里展示</p>' } } },
    })

    expect(wrapper.text()).toContain('暂无数据，部署埋点后会在这里展示')
  })

  it('点击可排序表头按数值排序', async () => {
    const wrapper = mount(AnalyticsDataTable, {
      props: {
        columns: [
          { key: 'name', label: '名称' },
          { key: 'count', label: '次数', type: 'number', sortable: true },
        ],
        rows: [
          { name: 'A', count: 1 },
          { name: 'B', count: 5 },
        ],
      },
    })

    await wrapper.get('button').trigger('click')
    const firstRow = wrapper.findAll('tbody tr')[0]!
    expect(firstRow.text()).toContain('B')
  })

  it('按比例值显示百分比列', () => {
    const wrapper = mount(AnalyticsDataTable, {
      props: {
        columns: [
          { key: 'route', label: 'Route' },
          { key: 'bounceRate', label: '跳出率', type: 'percent' },
        ],
        rows: [
          { route: '/gallery/:slug', bounceRate: 0.1234 },
        ],
      },
    })

    expect(wrapper.text()).toContain('12.3%')
  })
})
