import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, ref } from 'vue'
import ReadinessPage from './readiness.vue'

function state(data: unknown) {
  return {
    data: ref(data),
    loading: ref(false),
    error: ref(''),
    usage: ref(null),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
}

function mountPage(provider: 'meta' | 'tiktok') {
  const states: Record<string, ReturnType<typeof state>> = {
    '/api/admin/attribution/platforms': state([{
      provider,
      enabled: true,
      browserEnabled: true,
      serverEnabled: true,
      destinationConfigured: true,
      serverCredentialConfigured: true,
      serverQueueConfigured: true,
      serverDataKeyConfigured: true,
      rolloutPercentage: 10,
      mode: 'production',
      state: 'verified',
    }]),
    '/api/admin/attribution/summary': state({
      provider,
      routing: { mismatchCount: 0, unroutedActionCount: 0 },
      delivery: { failed: 0, retryExhausted: 0 },
    }),
    '/api/admin/attribution/readiness': state({
      ready: true,
      checks: [{ key: 'meta_ready', label: 'Meta 资源', level: 'blocker', ok: true, detail: '已通过' }],
      settings: {},
      verifications: {},
    }),
    '/api/admin/attribution/meta/status': state({ rollout: { targetPercentage: 10, effectivePercentage: 10 } }),
    '/api/admin/attribution/meta/incidents': state({ items: [], pagination: { hasMore: false } }),
  }

  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useAuth', () => ({ isOwner: ref(true) }))
  vi.stubGlobal('useAttributionProvider', () => ref(provider))
  vi.stubGlobal('useAdminAttributionRange', () => ({ range: ref('7d'), date: ref('2026-07-14'), queryKey: computed(() => '7d') }))
  vi.stubGlobal('useAdminAttribution', (endpoint: string) => states[endpoint] ?? state(null))
  vi.stubGlobal('formatAnalyticsDateTime', (value: unknown) => String(value ?? '-'))

  const textStub = (text: string) => defineComponent({ template: `<div>${text}</div>` })
  return shallowMount(ReadinessPage, {
    global: {
      mocks: { formatAnalyticsDateTime: (value: unknown) => String(value ?? '-') },
      stubs: {
        AttributionPageShell: { template: '<main><slot /></main>' },
        AttributionProviderSwitch: true,
        MetaRolloutControl: textStub('Meta rollout'),
        MetaIncidentList: textStub('Meta incident'),
        NuxtLink: { template: '<a><slot /></a>' },
      },
    },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('归因发布与诊断页', () => {
  it('TikTok 使用独立门禁且不展示 Meta 控制面', () => {
    const wrapper = mountPage('tiktok')
    expect(wrapper.text()).toContain('TikTok 生产阻断项已通过')
    expect(wrapper.text()).toContain('TikTok 连接已验证')
    expect(wrapper.text()).toContain('跨平台路由隔离')
    expect(wrapper.text()).not.toContain('Meta rollout')
    expect(wrapper.text()).not.toContain('Meta incident')
  })

  it('Meta 保留受控放量和 incident 处理', () => {
    const wrapper = mountPage('meta')
    expect(wrapper.text()).toContain('Meta 生产阻断项已通过')
    expect(wrapper.text()).toContain('Meta rollout')
    expect(wrapper.text()).toContain('Meta incident')
  })
})
