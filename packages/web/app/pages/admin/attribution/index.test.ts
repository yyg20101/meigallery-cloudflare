import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, ref } from 'vue'
import AttributionIndexPage from './index.vue'

const TextStub = (name: string, text: string) => defineComponent({ name, template: `<div>${text}</div>` })

function state(data: unknown) {
  return {
    range: ref('7d'), date: ref('2026-07-15'), data: ref(data), loading: ref(false), error: ref(''), usage: ref(null),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
}

function mountPage(
  initialProvider: 'meta' | 'tiktok' | 'google' = 'meta',
  capacityWarning = false,
  platformQualityLatest: Record<string, unknown> | null = null,
) {
  const server = { planned: 0, queued: 1, accepted: 3, processed: 1, retrying: 0, rejected: 1, deadLetter: 0, cancelled: 0 }
  const delivery = { browserPlanned: 4, server, queueRetryCount: 1, queueEnqueueCount: 5 }
  const metric = { availability: 'available', numerator: 3, denominator: 4, rate: 0.75 }
  const states: Record<string, ReturnType<typeof state>> = {
    '/api/admin/attribution/summary': state({
      provider: initialProvider,
      business: { contactCount: 3, completeRegistrationCount: 2, factCount: 5 },
      delivery,
      routing: { totalFactCount: 8, attributedFactCount: 6, unattributedFactCount: 1, conflictFactCount: 1, byProvider: { meta: 3, tiktok: 2, google: 1 } },
    }),
    '/api/admin/attribution/trends': state({ provider: initialProvider, granularity: 'day', rows: [{ date: '2026-07-15', business: { contactCount: 3, completeRegistrationCount: 2, factCount: 5 }, delivery }] }),
    '/api/admin/attribution/quality': state({
      provider: initialProvider,
      pairing: { summary: metric, rows: [{ date: '2026-07-15', ...metric }] },
      match: { summary: metric, signals: [{ key: initialProvider === 'google' ? 'gclid' : 'fbp', ...metric }], rows: [{ date: '2026-07-15', ...metric }] },
      platformQuality: { availability: 'unavailable', latest: platformQualityLatest, rows: [] },
    }),
    '/api/admin/attribution/platforms': state(['meta', 'tiktok', 'google'].map(provider => ({
      provider, enabled: true, browserEnabled: true, serverEnabled: true,
    }))),
    '/api/admin/attribution/breakdown': state({ provider: initialProvider, dimension: 'utm_campaign', rows: [] }),
    '/api/admin/attribution/capacity': state({
      date: '2026-07-15', timeZone: 'Asia/Shanghai', note: '项目内部估算', inputs: {},
      metrics: {
        workerRequests: { value: capacityWarning ? 70_000 : 100, safetyLimit: 70_000, ratio: capacityWarning ? 1 : 0.0014, warning: capacityWarning },
      },
    }),
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

  return shallowMount(AttributionIndexPage, {
    global: {
      stubs: {
        AttributionPageShell: { template: '<main><slot /></main>' },
        AttributionTrendPanel: TextStub('AttributionTrendPanel', '趋势图'),
        AttributionHealthStrip: TextStub('AttributionHealthStrip', '投递健康'),
        NuxtLink: { template: '<a><slot /></a>' },
      },
    },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('统一广告归因总览', () => {
  it('按固定顺序展示事实、投递、质量和容量四层', () => {
    const wrapper = mountPage()
    expect(wrapper.findAll('[data-attribution-section]').map(section => section.attributes('data-attribution-section'))).toEqual([
      'business', 'delivery', 'quality', 'capacity',
    ])
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('站内事实')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('Browser 计划')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('Server 状态')
    expect(wrapper.get('[data-evidence-rail]').text()).toContain('质量证据')
    expect(wrapper.text()).toContain('Meta · 生产运行')
    expect(wrapper.text()).toContain('项目内部估算')
  })

  it('Google 使用同一数据口径并保留 canonical 质量信号', () => {
    const wrapper = mountPage('google')
    expect(wrapper.text()).toContain('Google Ads · 生产运行')
    expect(wrapper.text()).toContain('gclid')
    expect(wrapper.text()).toContain('Browser/Server 计划配对率')
    expect(wrapper.text()).toContain('等待 Data Manager 异步诊断')
    expect(wrapper.text()).not.toContain('CAPI 成功')
  })

  it('TikTok 无自动质量快照时明确要求 Events Manager 人工证据', () => {
    const wrapper = mountPage('tiktok')
    expect(wrapper.text()).toContain('需在 TikTok Events Manager 人工确认')
    expect(wrapper.text()).not.toContain('质量为 0')
  })

  it('unavailable 快照显示平台注册语义，不把内部原因当分数', () => {
    const wrapper = mountPage('meta', false, {
      availability: 'unavailable',
      canonicalEvent: 'Contact',
      metricKey: 'emq_score',
      value: null,
      errorCategory: 'no_recent_metrics',
    })
    expect(wrapper.text()).toContain('等待 Meta Dataset Quality 数据')
    expect(wrapper.text()).not.toContain('no_recent_metrics')
  })

  it('容量达到 70% 安全线时显示预警', () => {
    const wrapper = mountPage('meta', true)
    expect(wrapper.get('[data-attribution-section="capacity"]').text()).toContain('至少一项已达到项目 70% 安全线')
    expect(wrapper.get('[data-attribution-section="capacity"]').text()).toContain('预警')
  })
})
