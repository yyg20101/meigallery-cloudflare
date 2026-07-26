import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { computed, defineComponent, ref } from 'vue'
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

  it('来源和标准事件只读取最终事实口径', () => {
    const conversions = attributionState({
      provider: 'meta',
      byEvent: [{ canonical_event: 'Contact', fact_count: 1, unique_session_count: 1 }],
      bySource: [{
        source_name: 'Meta A',
        fact_count: 2,
        contact_count: 1,
        complete_registration_count: 1,
      }],
      samples: [],
    })
    const overview = attributionState({ rows: [] })

    vi.stubGlobal('definePageMeta', vi.fn())
    vi.stubGlobal('useAttributionProvider', () => ref<'meta' | 'tiktok' | 'google'>('meta'))
    vi.stubGlobal('useAdminAttributionRange', () => ({ range: ref('7d'), date: ref('2026-07-10'), queryKey: computed(() => '7d') }))
    vi.stubGlobal('useAdminAttribution', (endpoint: string) => endpoint.endsWith('/trends') ? overview : conversions)

    const wrapper = shallowMount(ConversionsPage, {
      global: {
        stubs: {
          AnalyticsDataTable: DataTableStub,
          AttributionTrendPanel: true,
          AttributionPageShell: {
            template: '<main><slot /></main>',
          },
        },
      },
    })
    const tables = wrapper.findAllComponents(DataTableStub)
    expect(tables.length).toBe(3)
    const sourceRow = (tables[0]!.props('rows') as Array<Record<string, unknown>>)[0]!

    expect(sourceRow.platform).toBe('Meta')
    expect(sourceRow.fact_count).toBe(2)
    expect(sourceRow).not.toHaveProperty('historical_lead_count')
    expect(sourceRow).not.toHaveProperty('membership_grant_count')
    expect(tables[0]!.props('columns')).toContainEqual(expect.objectContaining({ key: 'platform', label: '广告平台' }))
    expect(tables[0]!.props('columns')).not.toContainEqual(expect.objectContaining({ key: 'meta_status' }))
    expect(wrapper.text()).not.toContain('开始试用')
    expect(wrapper.text()).toContain('有效联系或完成注册后会出现。')
    expect(wrapper.text()).not.toContain('会员发放')
  })

  it('活动转化页不混入无法确认平台来源的历史口径', () => {
    const source = readFileSync(join(cwd(), 'app/pages/admin/attribution/conversions.vue'), 'utf8')
    expect(source).not.toContain('历史 Lead')
    expect(source).not.toContain('membershipGrant')
    expect(source).not.toContain('meta_status')
    expect(source).toContain('广告平台')
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
