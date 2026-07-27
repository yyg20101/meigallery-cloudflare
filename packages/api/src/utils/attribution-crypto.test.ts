import { describe, expect, it } from 'vitest'
import {
  AttributionCryptoError,
  decryptAttributionValue,
  deriveAttributionHmacKey,
  encryptAttributionValue,
  loadAttributionCryptoKeys,
  type AttributionAad,
} from './attribution-crypto'

const CURRENT_KEY = toBase64(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
const PREVIOUS_KEY = toBase64(Uint8Array.from({ length: 32 }, (_, index) => 255 - index))
const AAD: AttributionAad = {
  purpose: 'credential',
  provider: 'meta',
  subjectId: 'connection-001',
  scope: 'credential-context-001',
}

describe('归因通用加密域', () => {
  it('使用 HKDF 派生的 AES-256-GCM 密钥完成凭证往返', async () => {
    const keys = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: CURRENT_KEY,
    })
    const envelope = await encryptAttributionValue({ keys, aad: AAD, plaintext: 'credential-value' })

    expect(envelope).toMatchObject({ schemaVersion: 1, keyId: keys.current.id })
    expect(base64UrlLength(envelope.iv)).toBe(12)
    expect(base64UrlLength(envelope.tag)).toBe(16)
    await expect(decryptAttributionValue({ keys, aad: AAD, envelope })).resolves.toBe('credential-value')
  })

  it('按 purpose 隔离 AES 和 HMAC 派生密钥', async () => {
    const keys = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: CURRENT_KEY,
    })
    const envelope = await encryptAttributionValue({ keys, aad: AAD, plaintext: 'credential-value' })
    const eventKey = await deriveAttributionHmacKey({ keys, purpose: 'event_id' })
    const credentialKey = await deriveAttributionHmacKey({ keys, purpose: 'credential' })

    await expect(decryptAttributionValue({
      keys,
      aad: { ...AAD, purpose: 'outbox' },
      envelope,
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CRYPTO_AUTHENTICATION_FAILED' })
    expect(await hmac(eventKey, 'same-input')).not.toBe(await hmac(credentialKey, 'same-input'))
  })

  it.each([
    ['provider', { ...AAD, provider: 'tiktok' }],
    ['subject ID', { ...AAD, subjectId: 'connection-002' }],
    ['scope', { ...AAD, scope: 'credential-context-002' }],
  ])('AAD 的%s变化后拒绝解密', async (_label, changedAad) => {
    const keys = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: CURRENT_KEY,
    })
    const envelope = await encryptAttributionValue({ keys, aad: AAD, plaintext: 'credential-value' })

    await expect(decryptAttributionValue({ keys, aad: changedAad, envelope }))
      .rejects.toMatchObject({ code: 'ATTRIBUTION_CRYPTO_AUTHENTICATION_FAILED' })
  })

  it.each(['ciphertext', 'tag'] as const)('密文%s被篡改后返回安全认证错误码', async (field) => {
    const keys = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: CURRENT_KEY,
    })
    const envelope = await encryptAttributionValue({ keys, aad: AAD, plaintext: 'credential-value' })

    await expect(decryptAttributionValue({
      keys,
      aad: AAD,
      envelope: { ...envelope, [field]: mutateBase64Url(envelope[field]) },
    })).rejects.toEqual(expect.objectContaining({
      name: 'AttributionCryptoError',
      code: 'ATTRIBUTION_CRYPTO_AUTHENTICATION_FAILED',
      message: 'ATTRIBUTION_CRYPTO_AUTHENTICATION_FAILED',
    }))
  })

  it('未知 key ID 和非法主密钥 fail closed', async () => {
    const keys = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: CURRENT_KEY,
    })
    const envelope = await encryptAttributionValue({ keys, aad: AAD, plaintext: 'credential-value' })

    await expect(decryptAttributionValue({
      keys,
      aad: AAD,
      envelope: { ...envelope, keyId: '0123456789abcdef' },
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CRYPTO_CONTEXT_INVALID' })
    await expect(loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'not-a-master-key',
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CRYPTO_KEY_INVALID' })
  })

  it('轮换后 current 写入，previous 仅能读取旧密文', async () => {
    const beforeRotation = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: PREVIOUS_KEY,
    })
    const previousEnvelope = await encryptAttributionValue({
      keys: beforeRotation,
      aad: AAD,
      plaintext: 'credential-value',
    })
    const rotated = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: CURRENT_KEY,
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS: PREVIOUS_KEY,
    })
    const currentEnvelope = await encryptAttributionValue({ keys: rotated, aad: AAD, plaintext: 'credential-value' })

    expect(currentEnvelope.keyId).toBe(rotated.current.id)
    await expect(decryptAttributionValue({ keys: rotated, aad: AAD, envelope: previousEnvelope }))
      .resolves.toBe('credential-value')
    await expect(encryptAttributionValue({
      keys: { current: rotated.previous! },
      aad: AAD,
      plaintext: 'credential-value',
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CRYPTO_CONTEXT_INVALID' })

    const forgedCurrent = { ...rotated.previous!, canEncrypt: true }
    await expect(encryptAttributionValue({
      keys: { current: forgedCurrent as typeof rotated.current },
      aad: AAD,
      plaintext: 'credential-value',
    })).rejects.toMatchObject({ code: 'ATTRIBUTION_CRYPTO_CONTEXT_INVALID' })
  })

  it('空字符串作为通用加密载荷可正确往返', async () => {
    const keys = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: CURRENT_KEY,
    })
    const envelope = await encryptAttributionValue({ keys, aad: AAD, plaintext: '' })

    await expect(decryptAttributionValue({ keys, aad: AAD, envelope })).resolves.toBe('')
  })

  it('不向外暴露 Web Crypto 或明文失败原因', async () => {
    const error = await captureError(async () => {
      const keys = await loadAttributionCryptoKeys({
        AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: CURRENT_KEY,
      })
      await decryptAttributionValue({
        keys,
        aad: AAD,
        envelope: { schemaVersion: 1, keyId: keys.current.id, iv: '*', ciphertext: '*', tag: '*' },
      })
    })

    expect(error).toBeInstanceOf(AttributionCryptoError)
    expect(error).toMatchObject({ code: 'ATTRIBUTION_CRYPTO_CONTEXT_INVALID' })
    expect(error).not.toHaveProperty('cause')
  })
})

async function hmac(key: CryptoKey, input: string) {
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function captureError(run: () => Promise<void>) {
  try {
    await run()
  }
  catch (error) {
    return error
  }
  throw new Error('EXPECTED_ERROR_NOT_THROWN')
}

function mutateBase64Url(value: string) {
  const replacement = value[0] === 'A' ? 'B' : 'A'
  return `${replacement}${value.slice(1)}`
}

function base64UrlLength(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), item => item.charCodeAt(0)).length
}

function toBase64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
}
