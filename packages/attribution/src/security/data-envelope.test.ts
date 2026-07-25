import { describe, expect, it } from 'vitest'
import {
  openAttributionData,
  sealAttributionData,
} from './data-envelope'

const current = 'data-envelope-current-key-with-32-bytes'
const next = 'data-envelope-next-key-with-32-bytes'

describe('归因敏感数据封装', () => {
  it('只允许相同用途和身份解密', async () => {
    const envelope = await sealAttributionData({ current }, {
      purpose: 'context-identifiers',
      identity: 'context_1:meta:conn_meta:ver_meta',
      plaintext: '{"fbclid":"secret-click"}',
    })

    expect(JSON.stringify(envelope)).not.toContain('secret-click')
    expect(await openAttributionData({ current }, {
      purpose: 'context-identifiers',
      identity: 'context_1:meta:conn_meta:ver_meta',
      envelope,
    })).toBe('{"fbclid":"secret-click"}')

    await expect(openAttributionData({ current }, {
      purpose: 'context-identifiers',
      identity: 'context_2:meta:conn_meta:ver_meta',
      envelope,
    })).rejects.toThrow('ATTRIBUTION_DATA_ENVELOPE_INVALID')
  })

  it('密钥轮换期间 previous 可以读取旧密文', async () => {
    const envelope = await sealAttributionData({ current }, {
      purpose: 'context-identifiers',
      identity: 'context_1:meta:conn_meta:ver_meta',
      plaintext: '{"fbclid":"secret-click"}',
    })

    expect(await openAttributionData({
      current: next,
      previous: current,
    }, {
      purpose: 'context-identifiers',
      identity: 'context_1:meta:conn_meta:ver_meta',
      envelope,
    })).toContain('secret-click')
  })

  it('密文、标签或 key id 被修改后均拒绝', async () => {
    const envelope = await sealAttributionData({ current }, {
      purpose: 'context-identifiers',
      identity: 'context_1:meta:conn_meta:ver_meta',
      plaintext: '{"fbclid":"secret-click"}',
    })

    await expect(openAttributionData({ current }, {
      purpose: 'context-identifiers',
      identity: 'context_1:meta:conn_meta:ver_meta',
      envelope: {
        ...envelope,
        ciphertext: mutate(envelope.ciphertext),
      },
    })).rejects.toThrow('ATTRIBUTION_DATA_ENVELOPE_INVALID')
    await expect(openAttributionData({ current }, {
      purpose: 'context-identifiers',
      identity: 'context_1:meta:conn_meta:ver_meta',
      envelope: {
        ...envelope,
        tag: mutate(envelope.tag),
      },
    })).rejects.toThrow('ATTRIBUTION_DATA_ENVELOPE_INVALID')
    await expect(openAttributionData({ current }, {
      purpose: 'context-identifiers',
      identity: 'context_1:meta:conn_meta:ver_meta',
      envelope: {
        ...envelope,
        keyId: '0'.repeat(32),
      },
    })).rejects.toThrow('ATTRIBUTION_DATA_ENVELOPE_INVALID')
  })
})

function mutate(value: string): string {
  const first = value.at(0)
  return `${first === 'A' ? 'B' : 'A'}${value.slice(1)}`
}
