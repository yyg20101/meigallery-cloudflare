import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, reactive, ref } from 'vue'
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
  api = vi.fn().mockResolvedValue({}),
  initialProvider: 'meta' | 'tiktok' = 'meta',
) {
  const states: Record<string, ReturnType<typeof state>> = {
    '/api/admin/attribution/summary': state({
      provider: 'meta',
      business: { contactCount: 3, completeRegistrationCount: 2, actionCount: 5 },
      historical: { leadCount: 9 },
      delivery: { pixelAttempted: 5, serverSent: 4, failed: 1, skipped: 0, pending: 0, retryExhausted: 0 },
    }),
    '/api/admin/attribution/trends': state({
      provider: 'meta',
      granularity: 'day',
      rows: [{
        date: '2026-07-10',
        business: { contactCount: 3, completeRegistrationCount: 2, actionCount: 5 },
        delivery: { pixelAttempted: 5, serverSent: 4, failed: 1, skipped: 0, pending: 0, retryExhausted: 0 },
      }],
    }),
    '/api/admin/attribution/quality': state({
      provider: 'meta',
      match: {
        labels: { browserId: 'fbp', clickId: 'fbc', email: 'email', externalId: 'external_id' },
        summary: {
          browserId: { availability: 'available', numerator: 3, denominator: 4, rate: 0.75 },
          clickId: { availability: 'unavailable', numerator: 0, denominator: 0, rate: null },
          email: { availability: 'available', numerator: 4, denominator: 4, rate: 1 },
          externalId: { availability: 'available', numerator: 1, denominator: 4, rate: 0.25 },
        },
        rows: [],
      },
      platformQuality: datasetAvailable
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
  vi.stubGlobal('useAdminAttribution', (endpoint: string) => states[endpoint] ?? state({}))
  vi.stubGlobal('useAdminAttributionRange', () => ({
    range: states['/api/admin/attribution/summary']!.range,
    date: states['/api/admin/attribution/summary']!.date,
    queryKey: computed(() => '7d'),
  }))
  vi.stubGlobal('useAuth', () => ({ isOwner: ref(true) }))
  vi.stubGlobal('useApi', () => ({ api }))
  const route = reactive({ query: { provider: initialProvider } })
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({
    replace: vi.fn(async ({ query }: { query: Record<string, string> }) => Object.assign(route.query, query)),
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
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('Server API 接收')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('平台质量')
    expect(wrapper.text()).not.toContain('Meta 归因成功')
  })

  it('Dataset Quality 与 match 按 availability 渲染，不把 null 显示为 0 分', () => {
    const wrapper = mountPage(false)
    expect(wrapper.text()).toContain('尚未取得平台质量数据')
    expect(wrapper.text()).toContain('暂无可发送样本')
    expect(wrapper.text()).not.toContain('Meta 质量 0 分')
    expect(wrapper.text()).not.toContain('fbc 0%')
  })

  it('TikTok Test Event Code 仅用于单次验证请求并在成功后清空', async () => {
    const api = vi.fn().mockResolvedValue({ data: { verified: true, idempotent: false, testEventsSent: 2 } })
    const wrapper = mountPage(false, api, 'tiktok')
    const tiktokForm = wrapper.findAll('form').find(form => form.text().includes('TikTok Pixel ID'))
    expect(tiktokForm).toBeDefined()
    const codeInput = tiktokForm!.get('input[type="password"]')
    await codeInput.setValue('TEST_TIKTOK_2026')

    await tiktokForm!.get('button[type="button"]').trigger('click')
    await flushPromises()

    expect(api).toHaveBeenCalledWith('/api/admin/attribution/platforms/tiktok/verify', {
      method: 'POST',
      body: { testEventCode: 'TEST_TIKTOK_2026' },
    })
    expect((codeInput.element as HTMLInputElement).value).toBe('')
    expect(tiktokForm!.text()).toContain('TikTok Events API 已验证')
  })

  it('TikTok 已验证连接复测时提示 revision 保持有效并展示独立发布检查', async () => {
    const api = vi.fn().mockResolvedValue({ data: { verified: true, idempotent: true, testEventsSent: 2 } })
    const wrapper = mountPage(false, api, 'tiktok')
    const tiktokForm = wrapper.findAll('form').find(form => form.text().includes('TikTok Pixel ID'))!
    await tiktokForm.get('input[type="password"]').setValue('TEST_TIKTOK_REPEAT')
    await tiktokForm.get('button[type="button"]').trigger('click')
    await flushPromises()

    expect(tiktokForm.text()).toContain('TikTok 测试事件已发送，连接验证保持有效')
    expect(wrapper.text()).toContain('Events API rollout 与发布检查')
    expect(wrapper.text()).toContain('Events API Queue 已配置')
    expect(wrapper.text()).not.toContain('incident 记录')
  })
})
