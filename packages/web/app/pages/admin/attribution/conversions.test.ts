import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { defineComponent, ref } from 'vue'
import ConversionsPage from './conversions.vue'

const DataTableStub = defineComponent({
  name: 'AnalyticsDataTable',
  props: {
    rows: { type: Array, default: () => [] },
    columns: { type: Array, default: () => [] },
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

  it('来源活动比率只使用有效联系和完成注册', () => {
    const conversions = attributionState({
      byAction: [],
      bySource: [{
        source_name: 'Meta A',
        contact_count: 1,
        complete_registration_count: 1,
        operations: { membershipGrantCount: 9 },
        start_trial_count: 100,
        historical: { leadCount: 1 },
      }],
      historical: { leadCount: 1 },
      operations: { membershipGrantCount: 9 },
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

    expect(sourceRow.contact_rate).toBe(0.5)
    expect(sourceRow.register_rate).toBe(0.5)
    expect(sourceRow.historical_lead_count).toBe(1)
    expect(sourceRow).not.toHaveProperty('membership_grant_count')
    expect(tables[0]!.props('columns')).toContainEqual(expect.objectContaining({ key: 'historical_lead_count', label: '历史 Lead' }))
    expect(wrapper.text()).not.toContain('开始试用')
    expect(wrapper.text()).toContain('有效联系或完成注册事件上报后会出现。')
    expect(wrapper.text()).not.toContain('会员发放')
  })

  it('归因页面只使用“历史 Lead”标签', () => {
    for (const fileName of ['index.vue', 'conversions.vue', 'links.vue']) {
      const source = readFileSync(join(cwd(), 'app/pages/admin/attribution', fileName), 'utf8')
      expect(source).not.toMatch(/label:\s*['"]Lead['"]/)
      expect(source).toContain('历史 Lead')
    }
  })

  it('归因活动 UI 不展示会员发放卡片、比率或活动列', () => {
    const indexSource = readFileSync(join(cwd(), 'app/pages/admin/attribution/index.vue'), 'utf8')
    const conversionsSource = readFileSync(join(cwd(), 'app/pages/admin/attribution/conversions.vue'), 'utf8')
    const linksSource = readFileSync(join(cwd(), 'app/pages/admin/attribution/links.vue'), 'utf8')

    expect(indexSource).not.toContain("label: '会员发放'")
    expect(indexSource).not.toContain('发放 / 注册')
    expect(conversionsSource).not.toContain('会员发放事件')
    expect(linksSource).not.toContain('conversionMembershipGrantCount')
    expect(linksSource).not.toMatch(/label:\s*['"]会员['"]/)
  })
})
