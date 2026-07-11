import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, ref } from 'vue'
import MetaPage from './meta.vue'

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

function mountPage() {
  const status = state({
    connection: {
      state: 'verified',
      environment: 'dev',
      pixelIdConfigured: true,
      tokenConfigured: true,
      testEventCodeConfigured: true,
      graphApiVersion: 'v25.0',
      verifiedAt: '2026-07-10T08:00:00.000Z',
      verifiedCommit: 'a'.repeat(40),
      datasetQualityStatus: 'not_checked',
      invalidationReason: '',
    },
    rollout: {
      targetPercentage: 50,
      effectivePercentage: 0,
      openIncident: { id: 'incident-1', severity: 'critical', targetPercentage: 50, effectivePercentage: 0 },
    },
    activity: {},
  })
  const quality = state({
    match: {
      summary: {
        fbp: { availability: 'unavailable', numerator: 0, denominator: 0, rate: null },
        fbc: { availability: 'unavailable', numerator: 0, denominator: 0, rate: null },
        email: { availability: 'unavailable', numerator: 0, denominator: 0, rate: null },
        externalId: { availability: 'unavailable', numerator: 0, denominator: 0, rate: null },
      },
      rows: [],
    },
    datasetQuality: { availability: 'not_available', latest: null, rows: [] },
  })
  const incidents = state({
    items: [{ id: 'incident-1', status: 'open', severity: 'critical', resolution: '' }],
    pagination: { hasMore: false },
  })

  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useAdminAttributionRange', () => ({
    range: ref('7d'),
    date: ref('2026-07-10'),
    queryKey: computed(() => '7d'),
  }))
  vi.stubGlobal('useAdminAttribution', (endpoint: string) => {
    if (endpoint.endsWith('/quality')) return quality
    if (endpoint.endsWith('/incidents')) return incidents
    return status
  })
  vi.stubGlobal('useAuth', () => ({ isOwner: ref(true) }))

  const passthrough = defineComponent({ template: '<div><slot /></div>' })
  const rolloutStub = defineComponent({
    props: ['rollout'],
    template: '<div data-rollout-stub>target {{ rollout.targetPercentage }} effective {{ rollout.effectivePercentage }}</div>',
  })
  return shallowMount(MetaPage, {
    global: {
      stubs: {
        AttributionPageShell: { template: '<main><slot /></main>' },
        MetaConnectionStatus: passthrough,
        MetaRolloutControl: rolloutStub,
        MetaIncidentList: passthrough,
        AttributionTrendPanel: true,
      },
    },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Meta 运维页', () => {
  it('使用统一 status/quality/incident API，并保留 incident 下的 target 与 effective=0', () => {
    const wrapper = mountPage()
    expect(wrapper.get('[data-rollout-stub]').text()).toContain('target 50')
    expect(wrapper.get('[data-rollout-stub]').text()).toContain('effective 0')
    expect(wrapper.text()).toContain('尚未取得 Meta 质量数据')
    expect(wrapper.text()).not.toContain('Meta 质量 0 分')
  })
})
