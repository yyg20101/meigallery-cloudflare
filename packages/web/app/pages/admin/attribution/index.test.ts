import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, ref } from 'vue'
import AttributionIndexPage from './index.vue'

const TextStub = (name: string, text: string) => defineComponent({
  name,
  template: `<div>${text}</div>`,
})

function state(data: unknown) {
  return {
    range: ref('7d'),
    date: ref('2026-07-10'),
    data: ref(data),
    loading: ref(false),
    error: ref(''),
    usage: ref(null),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
}

function mountPage(datasetAvailable = false) {
  const states: Record<string, ReturnType<typeof state>> = {
    '/api/admin/attribution/summary': state({
      business: { contactCount: 3, completeRegistrationCount: 2, actionCount: 5 },
      historical: { leadCount: 9 },
      delivery: { pixelAttempted: 5, capiSent: 4, failed: 1, skipped: 0, pending: 0, retryExhausted: 0 },
    }),
    '/api/admin/attribution/trends': state({
      granularity: 'day',
      rows: [{
        date: '2026-07-10',
        business: { contactCount: 3, completeRegistrationCount: 2, actionCount: 5 },
        delivery: { pixelAttempted: 5, capiSent: 4, failed: 1, skipped: 0, pending: 0, retryExhausted: 0 },
      }],
    }),
    '/api/admin/attribution/quality': state({
      match: {
        summary: {
          fbp: { availability: 'available', numerator: 3, denominator: 4, rate: 0.75 },
          fbc: { availability: 'unavailable', numerator: 0, denominator: 0, rate: null },
          email: { availability: 'available', numerator: 4, denominator: 4, rate: 1 },
          externalId: { availability: 'available', numerator: 1, denominator: 4, rate: 0.25 },
        },
        rows: [],
      },
      datasetQuality: datasetAvailable
        ? { availability: 'available', latest: { value: 0.82 }, rows: [] }
        : { availability: 'unavailable', latest: null, rows: [] },
    }),
    '/api/admin/attribution/meta/status': state({
      connection: { state: 'verified', environment: 'dev', pixelIdConfigured: true, tokenConfigured: true },
      rollout: { targetPercentage: 10, effectivePercentage: 10, openIncident: null },
      activity: {},
    }),
    '/api/admin/attribution/readiness': state({ ready: true, checks: [], settings: {}, verifications: {} }),
    '/api/admin/attribution/breakdown': state({ dimension: 'utm_campaign', rows: [] }),
    '/api/admin/attribution/duplicates': state({ duplicateRate: 0, samples: [] }),
    '/api/admin/attribution/meta/incidents': state({ items: [], pagination: { hasMore: false } }),
  }

  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useAdminAttribution', (endpoint: string) => states[endpoint] ?? state({}))
  vi.stubGlobal('useAdminAttributionRange', () => ({
    range: states['/api/admin/attribution/summary']!.range,
    date: states['/api/admin/attribution/summary']!.date,
    queryKey: computed(() => '7d'),
  }))
  vi.stubGlobal('useAuth', () => ({ isOwner: ref(true) }))
  vi.stubGlobal('formatAnalyticsNumber', (value: unknown) => String(value ?? 0))
  vi.stubGlobal('formatAnalyticsPercent', (numerator: unknown, denominator?: unknown) => denominator === undefined ? `${Number(numerator) * 100}%` : `${Number(numerator) / Math.max(1, Number(denominator)) * 100}%`)

  return shallowMount(AttributionIndexPage, {
    global: {
      stubs: {
        AttributionPageShell: { template: '<main><slot /></main>' },
        AttributionTrendPanel: TextStub('AttributionTrendPanel', '趋势图'),
        MetaConnectionStatus: TextStub('MetaConnectionStatus', '连接状态组件'),
        MetaRolloutControl: TextStub('MetaRolloutControl', '发布控制组件'),
        MetaIncidentList: TextStub('MetaIncidentList', 'incident 列表'),
        AnalyticsDataTable: true,
        NuxtLink: { template: '<a><slot /></a>' },
      },
    },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Meta 归因质量总览', () => {
  it('按固定顺序展示五个全宽区域与四层证据轨', () => {
    const wrapper = mountPage()
    expect(wrapper.findAll('[data-attribution-section]').map(section => section.attributes('data-attribution-section'))).toEqual([
      'connection',
      'business',
      'delivery',
      'quality',
      'rollout',
    ])
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('站内事实')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('Pixel 尝试')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('CAPI 接收')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('Meta 质量')
    expect(wrapper.text()).not.toContain('Meta 归因成功')
  })

  it('Dataset Quality 与 match 按 availability 渲染，不把 null 显示为 0 分', () => {
    const wrapper = mountPage(false)
    expect(wrapper.text()).toContain('尚未取得 Meta 质量数据')
    expect(wrapper.text()).toContain('暂无可发送样本')
    expect(wrapper.text()).not.toContain('Meta 质量 0 分')
    expect(wrapper.text()).not.toContain('fbc 0%')
  })
})
