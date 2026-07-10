import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import ConversionsPage from './conversions.vue'

const DataTableStub = defineComponent({
  name: 'AnalyticsDataTable',
  props: {
    rows: { type: Array, default: () => [] },
    emptyText: { type: String, default: '' },
  },
  template: '<div class="data-table">{{ emptyText }}</div>',
})

function attributionState(data: Record<string, unknown>) {
  return {
    range: ref('30d'),
    date: ref('2026-07-10'),
    data: ref(data),
    loading: ref(false),
    error: ref(''),
    usage: ref(null),
    refresh: vi.fn(),
  }
}

describe('归因转化页当前口径', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('来源分母和默认文案不包含历史 start_trial', () => {
    const conversions = attributionState({
      byAction: [],
      bySource: [{
        source_name: 'Meta A',
        contact_count: 1,
        lead_count: 1,
        complete_registration_count: 1,
        membership_grant_count: 1,
        start_trial_count: 100,
      }],
      samples: [],
    })
    const overview = attributionState({ trend: [] })

    vi.stubGlobal('definePageMeta', vi.fn())
    vi.stubGlobal('useAdminAttribution', (endpoint: string) => endpoint.endsWith('/overview') ? overview : conversions)

    const wrapper = shallowMount(ConversionsPage, {
      global: {
        stubs: {
          AnalyticsDataTable: DataTableStub,
          AnalyticsTrendPanel: true,
          AttributionPageShell: {
            template: '<main><slot /></main>',
          },
        },
      },
    })
    const tables = wrapper.findAllComponents(DataTableStub)
    expect(tables.length).toBe(3)
    const sourceRow = (tables[0]!.props('rows') as Array<Record<string, unknown>>)[0]!

    expect(sourceRow.contact_rate).toBe(0.25)
    expect(sourceRow.register_rate).toBe(0.25)
    expect(wrapper.text()).not.toContain('开始试用')
    expect(wrapper.text()).toContain('有效联系、Lead、完成注册或会员发放事件上报后会出现。')
  })
})
