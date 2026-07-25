import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AttributionCandidateStatus from '~/components/admin/attribution/AttributionCandidateStatus.vue'
import AttributionIdentityCandidateForm from '~/components/admin/attribution/AttributionIdentityCandidateForm.vue'
import AttributionRuntimePolicyPanel from '~/components/admin/attribution/AttributionRuntimePolicyPanel.vue'
import type { AttributionConnectionView } from '~/types/attribution-admin'
import { buildAttributionManagedSourceUrl } from '~/utils/attributionManagedSourceUrl'

const validatingConnection: AttributionConnectionView = {
  id: 'connection_meta_team_a',
  provider: 'meta',
  name: 'Meta 美国投放团队',
  isDefault: true,
  state: 'active',
  activeTarget: '1615446443914929',
  candidate: {
    state: 'validating',
    createdAt: '2026-07-24T10:00:00.000Z',
    failureCode: '',
    productionContinues: true,
  },
  runtime: {
    enabled: true,
    browserEnabled: true,
    serverEnabled: true,
    serverTargetPercentage: 10,
    serverEffectivePercentage: 10,
    circuitState: 'closed',
  },
  health: {
    level: 'healthy',
    lastDeliveryAt: '2026-07-24T10:02:00.000Z',
  },
}

describe('归因连接控制面', () => {
  it('候选验证中明确显示当前生产版本继续运行', () => {
    const wrapper = mount(AttributionCandidateStatus, {
      props: { candidate: validatingConnection.candidate },
    })

    expect(wrapper.text()).toContain('当前生产版本继续运行')
    expect(wrapper.text()).toContain('验证中')
  })

  it('身份候选表单不包含任何运行开关', () => {
    const wrapper = mount(AttributionIdentityCandidateForm, {
      props: {
        connection: validatingConnection,
        disabled: false,
      },
    })

    expect(wrapper.get('[data-test="identity-candidate-form"]').element)
      .toBeTruthy()
    expect(wrapper.find('input[name="browserEnabled"]').exists()).toBe(false)
    expect(wrapper.find('input[name="serverEnabled"]').exists()).toBe(false)
    expect(wrapper.find('input[name="serverTargetPercentage"]').exists())
      .toBe(false)
  })

  it('运行策略独立呈现 Browser、Server 和灰度比例', () => {
    const wrapper = mount(AttributionRuntimePolicyPanel, {
      props: {
        connection: validatingConnection,
        disabled: false,
      },
    })

    expect(wrapper.get('input[name="browserEnabled"]').element).toBeTruthy()
    expect(wrapper.get('input[name="serverEnabled"]').element).toBeTruthy()
    expect(wrapper.findAll('[data-runtime-percentage]')).toHaveLength(4)
  })

  it('界面不暴露内部版本、提交或凭证指纹字段', () => {
    const candidate = mount(AttributionIdentityCandidateForm, {
      props: {
        connection: validatingConnection,
        disabled: false,
      },
    })
    const runtime = mount(AttributionRuntimePolicyPanel, {
      props: {
        connection: validatingConnection,
        disabled: false,
      },
    })
    const text = `${candidate.text()} ${runtime.text()}`

    expect(text).not.toMatch(
      /revision|commit|version id|credential fingerprint|凭证指纹/i,
    )
  })

  it('Google 身份候选包含完整公开配置和 Service Account 文件', () => {
    const wrapper = mount(AttributionIdentityCandidateForm, {
      props: {
        connection: {
          ...validatingConnection,
          id: 'connection_google_team_a',
          provider: 'google',
          name: 'Google 美国投放团队',
          activeTarget: 'AW-123456789',
          candidate: null,
        },
        disabled: false,
      },
    })

    for (const label of [
      'Tag ID',
      'Customer ID',
      'Manager Account ID（可选）',
      'Cloud Project',
    ]) {
      expect(wrapper.text()).toContain(label)
    }
    expect(wrapper.get('input[type="file"]').attributes('accept'))
      .toContain('.json')
  })

  it('投放链接使用当前站点来源且只绑定指定连接凭证', () => {
    const value = buildAttributionManagedSourceUrl(
      'https://616618.xyz',
      {
        id: 'source_meta_a',
        provider: 'meta',
        connectionId: 'connection_meta_team_a',
        campaign: 'us_bj',
        medium: 'paid_social',
        content: 'video_a_chat',
        expiresAt: null,
        enabled: true,
        createdAt: '2026-07-24T10:00:00.000Z',
      },
      'managed_source_proof',
    )
    const url = new URL(value)

    expect(url.origin).toBe('https://616618.xyz')
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('mg_proof')).toBe('managed_source_proof')
    expect(url.searchParams.get('utm_source')).toBe('meta')
    expect(value).not.toContain('tiktok')
    expect(value).not.toContain('google')
  })
})
