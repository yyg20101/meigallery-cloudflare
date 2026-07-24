import { describe, expect, it } from 'vitest'
import { openCredential, sealCredential } from './credential-vault'

describe('credential vault', () => {
  it('使用 version/provider 作为 AAD 且不把明文放入 envelope', async () => {
    const keys = { current: '0123456789abcdef0123456789abcdef' }
    const envelope = await sealCredential(keys, {
      versionId: 'ver_1',
      provider: 'meta',
      plaintext: 'secret-token',
    })

    expect(JSON.stringify(envelope)).not.toContain('secret-token')
    await expect(openCredential(keys, {
      versionId: 'ver_2',
      provider: 'meta',
      envelope,
    })).rejects.toThrow('ATTRIBUTION_CREDENTIAL_AAD_MISMATCH')
    await expect(openCredential(keys, {
      versionId: 'ver_1',
      provider: 'tiktok',
      envelope,
    })).rejects.toThrow('ATTRIBUTION_CREDENTIAL_AAD_MISMATCH')
    expect(await openCredential(keys, {
      versionId: 'ver_1',
      provider: 'meta',
      envelope,
    })).toBe('secret-token')
    await expect(openCredential(keys, {
      versionId: 'ver_1',
      provider: 'meta',
      envelope: { ...envelope, fingerprint: '0'.repeat(64) },
    })).rejects.toThrow('ATTRIBUTION_CREDENTIAL_AAD_MISMATCH')
  })

  it('密钥轮换窗口允许 previous 解密但新密文只使用 current', async () => {
    const previous = 'previous-key-material-for-testing'
    const current = 'current-key-material-for-testing!'
    const envelope = await sealCredential({ current: previous }, {
      versionId: 'ver_1',
      provider: 'google',
      plaintext: 'previous-secret',
    })

    expect(await openCredential({ current, previous }, {
      versionId: 'ver_1',
      provider: 'google',
      envelope,
    })).toBe('previous-secret')

    const currentEnvelope = await sealCredential({ current }, {
      versionId: 'ver_2',
      provider: 'google',
      plaintext: 'previous-secret',
    })
    expect(currentEnvelope.fingerprint).toBe(envelope.fingerprint)
    await expect(openCredential({ current: previous }, {
      versionId: 'ver_2',
      provider: 'google',
      envelope: currentEnvelope,
    })).rejects.toThrow('ATTRIBUTION_CREDENTIAL_AAD_MISMATCH')
  })
})
