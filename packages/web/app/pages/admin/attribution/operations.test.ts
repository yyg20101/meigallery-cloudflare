import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, ref } from 'vue'
import AttributionDeliveryFunnel from '~/components/admin/attribution/AttributionDeliveryFunnel.vue'
import AttributionIncidentList from '~/components/admin/attribution/AttributionIncidentList.vue'
import AttributionPrivacyPage from './privacy.vue'

const PageShellStub = defineComponent({
  template: '<main><slot /></main>',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('归因运营口径', () => {
  it('业务事实与投递状态分开展示', () => {
    vi.stubGlobal(
      'formatAnalyticsNumber',
      (value: unknown) => String(value ?? 0),
    )
    const wrapper = mount(AttributionDeliveryFunnel, {
      props: {
        metrics: {
          contactCount: 12,
          completeRegistrationCount: 4,
          factCount: 16,
          attributedFactCount: 14,
          unattributedFactCount: 2,
          browserAttempted: 10,
          serverPlanned: 10,
          serverQueued: 9,
          serverProcessed: 8,
          serverRejected: 1,
          serverDeadLetter: 0,
        },
      },
      global: {
        mocks: {
          formatAnalyticsNumber: (value: unknown) => String(value ?? 0),
        },
      },
    })

    expect(wrapper.get('[data-metric="business-contact"]').text())
      .toContain('12')
    expect(wrapper.get('[data-metric="browser-attempted"]').text())
      .toContain('10')
    expect(wrapper.get('[data-metric="server-processed"]').text())
      .toContain('8')
    expect(wrapper.get('[data-metric="unattributed-facts"]').text())
      .toContain('2')
  })

  it('Incident 显示影响范围和恢复状态', () => {
    vi.stubGlobal(
      'formatAnalyticsDateTime',
      (value: unknown) => String(value ?? ''),
    )
    const wrapper = mount(AttributionIncidentList, {
      props: {
        incidents: [{
          id: 'incident_meta_server',
          provider: 'meta',
          connectionId: 'connection_meta_us_bj',
          connectionName: '美国 BJ 团队',
          severity: 'critical',
          code: 'queue_dead_letter',
          affectedChannel: 'server',
          affectedEvent: 'Contact',
          openedAt: '2026-07-24T08:00:00.000Z',
          detectedAt: '2026-07-24T08:01:00.000Z',
          recoveredAt: '2026-07-24T09:00:00.000Z',
          affectedFactCount: 6,
          affectedDeliveryCount: 5,
          automaticAction: 'server_circuit_recovered',
          recoveryStatus: 'recovered',
        }],
      },
      global: {
        mocks: {
          formatAnalyticsNumber: (value: unknown) => String(value ?? 0),
          formatAnalyticsDateTime: (value: unknown) => String(value ?? ''),
        },
      },
    })

    expect(wrapper.text()).toContain('Meta / 美国 BJ 团队')
    expect(wrapper.text()).toContain('Server')
    expect(wrapper.text()).toContain('影响事实 6')
    expect(wrapper.text()).toContain('已恢复')
  })

  it('地区策略明确区分事先同意和告知退出地区', async () => {
    const policy = ref({
      availability: 'available' as const,
      defaultMode: 'notice_opt_out' as const,
      priorConsentCountryCodes: ['DE', 'FR'],
      policyVersion: 3,
      updatedAt: '2026-07-24T09:00:00.000Z',
    })
    vi.stubGlobal('definePageMeta', vi.fn())
    vi.stubGlobal('useAuth', () => ({ isOwner: ref(true) }))
    vi.stubGlobal('useAdminAttributionRange', () => ({
      range: ref('7d'),
      date: ref('2026-07-24'),
      query: computed(() => ({ range: '7d' })),
      queryKey: computed(() => '7d'),
    }))
    vi.stubGlobal('useApi', () => ({
      api: vi.fn().mockResolvedValue({ data: policy.value }),
    }))

    const wrapper = shallowMount(AttributionPrivacyPage, {
      global: {
        stubs: {
          AttributionPageShell: PageShellStub,
        },
      },
    })
    await flushPromises()

    const mode = wrapper.get(
      'select[aria-label="默认地区模式"]',
    ).element as HTMLSelectElement
    const countries = wrapper.get(
      'textarea[aria-label="需事先同意的国家或地区"]',
    ).element as HTMLTextAreaElement
    expect(mode.value).toBe('notice_opt_out')
    expect(countries.value).toContain('DE')
    expect(wrapper.text()).toContain('GPC 和用户明确拒绝始终优先')
    expect(wrapper.text()).not.toMatch(
      /\bMeta\b|\bTikTok\b|\bGoogle\b|\bPixel\b|\bAPI\b|\bCookie\b/i,
    )
  })
})
