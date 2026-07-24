import { describe, expect, it } from 'vitest'
import {
  hashCandidateIdentity,
  normalizeCandidateInput,
} from './normalization'

describe('候选版本标准化', () => {
  it('字段顺序和空白不同但语义相同的候选得到相同 hash', async () => {
    const first = await hashCandidateIdentity(normalizeCandidateInput({
      provider: 'meta',
      publicConfig: { pixelId: ' 1234567890123456 ' },
      bindings: [
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
      credentialFingerprint: 'fp_1',
    }))
    const second = await hashCandidateIdentity(normalizeCandidateInput({
      provider: 'meta',
      publicConfig: { pixelId: '1234567890123456' },
      bindings: [
        {
          canonicalEvent: 'CompleteRegistration',
          enabled: true,
          browserDestination: ' meta_pixel ',
          serverDestination: 'meta_capi',
        },
        {
          canonicalEvent: 'Contact',
          enabled: true,
          browserDestination: 'meta_pixel',
          serverDestination: 'meta_capi',
        },
      ],
      credentialFingerprint: ' fp_1 ',
    }))

    expect(second).toBe(first)
  })

  it('拒绝重复事件绑定和空配置值', () => {
    const binding = {
      canonicalEvent: 'Contact' as const,
      enabled: true,
      browserDestination: 'meta_pixel',
      serverDestination: 'meta_capi',
    }

    expect(() => normalizeCandidateInput({
      provider: 'meta',
      publicConfig: { pixelId: '123' },
      bindings: [binding, binding],
      credentialFingerprint: 'fp_1',
    })).toThrow('ATTRIBUTION_CANDIDATE_INVALID')

    expect(() => normalizeCandidateInput({
      provider: 'meta',
      publicConfig: { pixelId: ' ' },
      bindings: [binding],
      credentialFingerprint: 'fp_1',
    })).toThrow('ATTRIBUTION_CANDIDATE_INVALID')
  })
})
