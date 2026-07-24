import { describe, expect, it } from 'vitest'
import {
  attributionCandidatePayload,
  attributionPlatformDefinition,
  attributionRuntimePolicyPayload,
  emptyAttributionCandidateDraft,
} from './attributionPlatforms'

describe('归因平台定义', () => {
  it.each(['meta', 'tiktok', 'google'] as const)(
    '%s 只声明统一 Canonical Event',
    (provider) => {
      expect(
        attributionPlatformDefinition(provider).eventBindings.map(
          binding => binding.canonicalEvent,
        ),
      ).toEqual(['Contact', 'CompleteRegistration'])
    },
  )

  it('身份候选 payload 不包含运行开关或 rollout', () => {
    const platform = attributionPlatformDefinition('meta')
    const draft = emptyAttributionCandidateDraft(platform)
    draft.publicConfig.pixelId = '1234567890123456'

    const payload = attributionCandidatePayload(platform, draft, {
      credentialPlaintext: 'token-value',
      testEventCode: ' TEST12345 ',
    })

    expect(payload).toEqual({
      publicConfig: { pixelId: '1234567890123456' },
      credential: {
        type: 'access_token',
        plaintext: 'token-value',
      },
      eventBindings: [
        {
          canonicalEvent: 'Contact',
          enabled: true,
          browserDestination: 'meta_pixel',
          serverDestination: 'meta_capi',
        },
        {
          canonicalEvent: 'CompleteRegistration',
          enabled: true,
          browserDestination: 'meta_pixel',
          serverDestination: 'meta_capi',
        },
      ],
      testEventCode: 'TEST12345',
    })
    expect(payload).not.toHaveProperty('enabled')
    expect(payload).not.toHaveProperty('browserEnabled')
    expect(payload).not.toHaveProperty('serverEnabled')
    expect(payload).not.toHaveProperty('serverTargetPercentage')
  })

  it('运行策略 payload 不包含身份、凭证或事件映射', () => {
    const payload = attributionRuntimePolicyPayload({
      enabled: true,
      browserEnabled: true,
      serverEnabled: true,
      serverTargetPercentage: 50,
    })

    expect(payload).toEqual({
      enabled: true,
      browserEnabled: true,
      serverEnabled: true,
      serverTargetPercentage: 50,
    })
    expect(payload).not.toHaveProperty('publicConfig')
    expect(payload).not.toHaveProperty('credential')
    expect(payload).not.toHaveProperty('eventBindings')
    expect(payload).not.toHaveProperty('testEventCode')
  })

  it('Google 空白可选配置不会进入候选请求', () => {
    const platform = attributionPlatformDefinition('google')
    const draft = emptyAttributionCandidateDraft(platform)
    draft.publicConfig = {
      tagId: 'AW-123456789',
      customerId: '1234567890',
      loginCustomerId: '',
      cloudProjectId: 'meigallery-ads',
    }

    expect(
      attributionCandidatePayload(platform, draft).publicConfig,
    ).toEqual({
      tagId: 'AW-123456789',
      customerId: '1234567890',
      cloudProjectId: 'meigallery-ads',
    })
  })
})
