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

function mountPage(
  datasetAvailable = false,
  initialProvider: 'meta' | 'tiktok' = 'meta',
) {
  const states: Record<string, ReturnType<typeof state>> = {
    '/api/admin/attribution/summary': state({
      provider: initialProvider,
      business: { contactCount: 3, completeRegistrationCount: 2, actionCount: 5 },
      historical: { leadCount: 9 },
      delivery: { pixelAttempted: 5, serverSent: 4, failed: 1, skipped: 0, pending: 0, retryExhausted: 0 },
      routing: { mismatchCount: 0, unroutedActionCount: 1 },
    }),
    '/api/admin/attribution/trends': state({
      provider: initialProvider,
      granularity: 'day',
      rows: [{
        date: '2026-07-10',
        business: { contactCount: 3, completeRegistrationCount: 2, actionCount: 5 },
        delivery: { pixelAttempted: 5, serverSent: 4, failed: 1, skipped: 0, pending: 0, retryExhausted: 0 },
      }],
    }),
    '/api/admin/attribution/quality': state({
      provider: initialProvider,
      match: {
        labels: initialProvider === 'meta'
          ? { browserId: 'fbp', clickId: 'fbc', email: 'email', externalId: 'external_id' }
          : { browserId: '_ttp', clickId: 'ttclid', email: 'email', externalId: 'external_id' },
        summary: {
          browserId: { availability: 'available', numerator: 3, denominator: 4, rate: 0.75 },
          clickId: { availability: 'unavailable', numerator: 0, denominator: 0, rate: null },
          email: { availability: 'available', numerator: 4, denominator: 4, rate: 1 },
          externalId: { availability: 'available', numerator: 1, denominator: 4, rate: 0.25 },
        },
        rows: [],
      },
      platformQuality: initialProvider === 'tiktok'
        ? { source: 'not_supported', availability: 'unavailable', latest: null, rows: [] }
        : datasetAvailable
        ? { source: 'meta_dataset_quality', availability: 'available', latest: { value: 0.82 }, rows: [] }
        : { source: 'meta_dataset_quality', availability: 'unavailable', latest: null, rows: [] },
    }),
    '/api/admin/attribution/meta/status': state({
      connection: { state: 'verified', environment: 'dev', pixelIdConfigured: true, tokenConfigured: true },
      rollout: { targetPercentage: 10, effectivePercentage: 10, openIncident: null },
      activity: {},
    }),
    '/api/admin/attribution/platforms': state([
      {
        provider: 'meta',
        environment: 'production',
        destinationConfigured: true,
        serverCredentialConfigured: true,
        serverQueueConfigured: true,
        serverDataKeyConfigured: true,
        mode: 'test',
        state: 'verified',
        verifiedAt: '2026-07-12T00:00:00.000Z',
        verifiedCommit: 'a'.repeat(40),
      },
      {
        provider: 'tiktok',
        environment: 'production',
        enabled: true,
        browserEnabled: true,
        serverEnabled: false,
        destinationId: 'C123456789ABCDEF',
        destinationConfigured: true,
        serverCredentialConfigured: true,
        serverQueueConfigured: true,
        serverDataKeyConfigured: true,
        debugEnabled: false,
        rolloutPercentage: 0,
        mode: 'production',
        state: 'unverified',
        verifiedAt: '',
        verifiedCommit: '',
      },
    ]),
    '/api/admin/attribution/readiness': state({ ready: true, checks: [], settings: {}, verifications: {} }),
    '/api/admin/attribution/breakdown': state({ provider: 'meta', dimension: 'utm_campaign', rows: [] }),
    '/api/admin/attribution/duplicates': state({ duplicateRate: 0, samples: [] }),
    '/api/admin/attribution/meta/incidents': state({ items: [], pagination: { hasMore: false } }),
  }

  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useAttributionProvider', () => ref(initialProvider))
  vi.stubGlobal('useAdminAttribution', (endpoint: string) => states[endpoint] ?? state({}))
  vi.stubGlobal('useAdminAttributionRange', () => ({
    range: states['/api/admin/attribution/summary']!.range,
    date: states['/api/admin/attribution/summary']!.date,
    queryKey: computed(() => '7d'),
  }))
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

describe('多平台归因总览', () => {
  it('按固定顺序展示三个分析区域与四层证据轨', () => {
    const wrapper = mountPage()
    expect(wrapper.findAll('[data-attribution-section]').map(section => section.attributes('data-attribution-section'))).toEqual([
      'business',
      'delivery',
      'quality',
    ])
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('站内事实')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('Pixel 尝试')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('Server API 接收')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('平台质量')
    expect(wrapper.text()).toContain('Meta 连接 已验证')
    expect(wrapper.text()).not.toContain('发布控制组件')
  })

  it('Dataset Quality 与 match 按 availability 渲染，不把 null 显示为 0 分', () => {
    const wrapper = mountPage(false)
    expect(wrapper.text()).toContain('尚未取得平台质量数据')
    expect(wrapper.text()).toContain('暂无可发送样本')
    expect(wrapper.text()).not.toContain('Meta 质量 0 分')
    expect(wrapper.text()).not.toContain('fbc 0%')
  })

  it('切换 TikTok 后只展示 TikTok 术语和独立质量口径', () => {
    const wrapper = mountPage(false, 'tiktok')
    expect(wrapper.text()).toContain('TikTok 连接 待验证')
    expect(wrapper.text()).toContain('TikTok Pixel 与 Events API')
    expect(wrapper.text()).toContain('_ttp coverage')
    expect(wrapper.text()).toContain('当前平台未接入质量诊断 API')
    expect(wrapper.text()).not.toContain('Meta 匹配覆盖与平台质量')
  })
})
