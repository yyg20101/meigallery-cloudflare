import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, ref } from 'vue'
import AttributionIndexPage from './index.vue'

const PageShellStub = defineComponent({
  template: '<main><slot /></main>',
})

function collection<T>(rows: T[]) {
  return {
    rows: ref(rows),
    loading: ref(false),
    initialized: ref(true),
    error: ref(''),
    refresh: vi.fn().mockResolvedValue(rows),
  }
}

function mountPage(options: {
  range?: '7d' | 'day'
  date?: string
  qualityAvailable?: boolean
} = {}) {
  const operationRows = [{
    date: options.date ?? '2026-07-24',
    provider: 'meta' as const,
    connectionId: 'conn_meta_a',
    connectionName: '美国 BJ 团队',
    contactCount: 3,
    completeRegistrationCount: 2,
    factCount: 5,
    attributedFactCount: 4,
    unattributedFactCount: 1,
    browserAttempted: 4,
    serverPlanned: 4,
    serverQueued: 4,
    serverProcessed: 3,
    serverRejected: 1,
    serverDeadLetter: 0,
  }]
  const quality = collection(options.qualityAvailable
    ? [{
        date: options.date ?? '2026-07-24',
        provider: 'meta' as const,
        connectionId: 'conn_meta_a',
        connectionName: '美国 BJ 团队',
        metricKey: 'event_match_quality',
        numerator: 3,
        denominator: 4,
        value: 0.75,
        availability: 'available' as const,
      }]
    : [])
  const connections = {
    connections: ref([]),
    loading: ref(false),
    error: ref(''),
    refresh: vi.fn().mockResolvedValue([]),
  }
  const range = ref(options.range ?? '7d')
  const date = ref(options.date ?? '2026-07-24')
  const api = vi.fn().mockImplementation(
    (path: string) => {
      if (path.endsWith('/operations')) {
        return Promise.resolve({ data: operationRows })
      }
      throw new Error(`未预期的归因请求：${path}`)
    },
  )

  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useRoute', () => ({
    query: {
      provider: 'meta',
      connectionId: 'conn_meta_a',
    },
  }))
  vi.stubGlobal('useRouter', () => ({
    replace: vi.fn().mockResolvedValue(undefined),
  }))
  vi.stubGlobal('useApi', () => ({ api }))
  vi.stubGlobal('useAdminAttributionRange', () => ({
    range,
    date,
    query: computed(() => (
      range.value === 'day'
        ? { from: date.value, to: date.value }
        : { range: range.value }
    )),
    queryKey: computed(() => `${range.value}:${date.value}`),
  }))
  vi.stubGlobal('useAttributionConnections', () => connections)
  vi.stubGlobal('useAttributionQuality', () => quality)
  vi.stubGlobal(
    'formatAnalyticsNumber',
    (value: unknown) => String(value ?? 0),
  )

  const wrapper = shallowMount(AttributionIndexPage, {
    global: {
      stubs: {
        AttributionPageShell: PageShellStub,
        AttributionConnectionFilter: true,
        AttributionDeliveryFunnel: defineComponent({
          props: ['metrics'],
          template: '<div data-funnel>{{ metrics.factCount }}</div>',
        }),
        AttributionTrendPanel: true,
      },
    },
  })

  return { wrapper, api, quality }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('统一广告归因总览', () => {
  it('只展示业务、投递和平台质量读模型', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(
      wrapper.findAll('[data-attribution-section]')
        .map(section => section.attributes('data-attribution-section')),
    ).toEqual(['operations', 'quality'])
    expect(wrapper.get('[data-funnel]').text()).toBe('5')
    expect(wrapper.text()).toContain('平台质量暂不可用')
  })

  it('平台质量有快照时展示样本与结果', async () => {
    const { wrapper } = mountPage({ qualityAvailable: true })
    await flushPromises()

    expect(wrapper.text()).toContain('美国 BJ 团队')
    expect(wrapper.text()).toContain('event_match_quality')
    expect(wrapper.text()).toContain('75%')
    expect(wrapper.text()).not.toContain('平台质量暂不可用')
  })

  it('单日筛选只向读模型请求该北京时间自然日', async () => {
    const { api, quality } = mountPage({
      range: 'day',
      date: '2026-07-09',
    })
    await flushPromises()

    const expected = {
      dateFrom: '2026-07-09',
      dateTo: '2026-07-09',
      provider: 'meta',
      connectionId: 'conn_meta_a',
    }
    expect(api).toHaveBeenCalledWith(
      '/api/admin/attribution-runtime/operations',
      { query: expected },
    )
    expect(quality.refresh).toHaveBeenCalledWith(expected)
  })
})
