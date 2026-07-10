import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import MetaPage from './meta.vue'

const MetricStub = defineComponent({
  name: 'AnalyticsMetricCard',
  props: {
    label: { type: String, default: '' },
    value: { type: [String, Number], default: '' },
    hint: { type: String, default: '' },
  },
  template: '<div data-metric>{{ label }}|{{ value }}|{{ hint }}</div>',
})

function connection(overrides: Record<string, unknown> = {}) {
  return {
    state: 'unverified',
    environment: 'dev',
    pixelIdConfigured: true,
    tokenConfigured: true,
    testEventCodeConfigured: true,
    verifiedAt: null,
    verifiedCommit: null,
    graphApiVersion: 'v25.0',
    datasetQualityStatus: 'not_checked',
    invalidationReason: 'verification_missing',
    ...overrides,
  }
}

function mountPage(options: {
  isOwner?: boolean
  connection?: Record<string, unknown>
  api?: ReturnType<typeof vi.fn>
} = {}) {
  const refresh = vi.fn()
  const api = options.api ?? vi.fn()
  const toastAdd = vi.fn()
  const attribution = {
    range: ref('30d'),
    date: ref('2026-07-11'),
    data: ref({
      totals: {},
      deliveries: [],
      lastSentAt: '',
      queueBindingPresent: true,
      settings: {
        facebook_pixel_enabled: true,
        meta_capi_enabled: true,
        meta_tracking_mode: 'test',
      },
      connection: options.connection ?? connection(),
    }),
    loading: ref(false),
    error: ref(''),
    usage: ref(null),
    refresh,
  }

  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useApi', () => ({ api }))
  vi.stubGlobal('useAuth', () => ({ isOwner: ref(options.isOwner ?? true) }))
  vi.stubGlobal('useToast', () => ({ add: toastAdd }))
  vi.stubGlobal('useAdminAttribution', () => attribution)
  vi.stubGlobal('formatAnalyticsNumber', (value: unknown) => String(value ?? 0))
  vi.stubGlobal('formatAnalyticsDateTime', (value: unknown) => String(value || '暂无'))
  vi.stubGlobal('resolveApiErrorMessage', (_error: unknown, fallback: string) => fallback)

  const wrapper = shallowMount(MetaPage, {
    global: {
      stubs: {
        AnalyticsMetricCard: MetricStub,
        AnalyticsDataTable: true,
        AttributionHealthStrip: true,
        AttributionPageShell: { template: '<main><slot /></main>' },
      },
    },
  })
  return { wrapper, api, refresh, toastAdd }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MetaConnection 后台状态', () => {
  it('明确区分已配置与已验证，并展示 Graph 版本和稳定失效原因', () => {
    const { wrapper } = mountPage({
      connection: connection({
        state: 'configuration_changed',
        verifiedAt: '2026-07-11T00:00:00.000Z',
        verifiedCommit: 'a'.repeat(40),
        invalidationReason: 'release_commit_changed',
      }),
    })

    expect(wrapper.text()).toContain('Pixel ID 配置|已配置')
    expect(wrapper.text()).toContain('CAPI token 配置|已配置')
    expect(wrapper.text()).toContain('连接验证|配置已变更')
    expect(wrapper.text()).toContain('Graph API|v25.0')
    expect(wrapper.text()).toContain('发布 commit 已变化')
    expect(wrapper.text()).not.toContain('fingerprint')
  })

  it('历史 verification 缺少 revision 时提示重新验证', () => {
    const { wrapper } = mountPage({
      connection: connection({
        state: 'configuration_changed',
        invalidationReason: 'verification_revision_missing',
      }),
    })

    expect(wrapper.text()).toContain('连接验证|配置已变更|历史连接验证需要重新验证')
  })

  it('只有 Owner 且 dev 环境可操作验证按钮', () => {
    const ownerDev = mountPage({ isOwner: true })
    expect(ownerDev.wrapper.find('[data-meta-connection-verify]').exists()).toBe(true)

    const adminDev = mountPage({ isOwner: false })
    expect(adminDev.wrapper.find('[data-meta-connection-verify]').exists()).toBe(false)

    const ownerProduction = mountPage({
      isOwner: true,
      connection: connection({ environment: 'production' }),
    })
    expect(ownerProduction.wrapper.find('[data-meta-connection-verify]').exists()).toBe(false)
    expect(ownerProduction.wrapper.text()).toContain('production 验证门禁尚未开放')
  })

  it('dev 验证成功后刷新连接状态，响应不依赖 trace 或 fingerprint', async () => {
    const api = vi.fn().mockResolvedValue({
      data: {
        status: 'verified',
        eventsReceived: 1,
        connection: connection({ state: 'verified' }),
      },
    })
    const { wrapper, refresh, toastAdd } = mountPage({ api })

    await wrapper.get('[data-meta-connection-verify]').trigger('click')
    await nextTick()

    expect(api).toHaveBeenCalledWith('/api/admin/attribution/meta/test-event', { method: 'POST' })
    expect(toastAdd).toHaveBeenCalledWith({ title: 'MetaConnection 验证成功', color: 'success' })
    expect(refresh).toHaveBeenCalledOnce()
  })
})
