import { describe, expect, it } from 'vitest'
import {
  decryptMetaCapiContext,
  encryptMetaCapiContext,
  loadMetaCapiCryptoKeys,
  metaConnectionFingerprint,
  type MetaCapiCryptoKeys,
  type MetaCapiEncryptedEnvelope,
  type MetaCapiEnvelopeAad,
} from './meta-capi-crypto'

const CURRENT_KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const PREVIOUS_KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
const CURRENT_KEY_BASE64 = bytesToBase64(CURRENT_KEY_BYTES)
const PREVIOUS_KEY_BASE64 = bytesToBase64(PREVIOUS_KEY_BYTES)
const AAD: MetaCapiEnvelopeAad = {
  deliveryId: 'delivery-sensitive-001',
  externalEventId: 'event-sensitive-001',
  eventName: 'CompleteRegistration',
}
const SENSITIVE_CONTEXT = {
  fbp: 'fb.1.1700000000000.123456789',
  fbc: 'fb.1.1700000000000.CLICK_sensitive',
  clientIpAddress: '203.0.113.24',
  clientUserAgent: 'MeiGallery Sensitive Browser/1.0',
  emailSha256: 'a'.repeat(64),
  externalIdSha256: 'b'.repeat(64),
}

describe('Meta CAPI Web Crypto', () => {
  it('使用 32-byte base64 current key 完成 AES-GCM round trip', async () => {
    const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: `  ${CURRENT_KEY_BASE64}\n` })
    const envelope = await encryptMetaCapiContext({ keys, aad: AAD, value: SENSITIVE_CONTEXT })

    expect(keys.current.id).toBe('ae216c2ef5247a37')
    expect(envelope).toMatchObject({ schemaVersion: 2, keyId: keys.current.id })
    expect(base64UrlLength(envelope.iv)).toBe(12)
    expect(base64UrlLength(envelope.tag)).toBe(16)
    expect(envelope.iv).not.toContain('=')
    expect(envelope.ciphertext).not.toContain('=')
    expect(envelope.tag).not.toContain('=')
    await expect(decryptMetaCapiContext({ keys, aad: AAD, envelope })).resolves.toEqual(SENSITIVE_CONTEXT)
  })

  it.each([
    ['缺失', undefined],
    ['空值', '  '],
    ['非 base64', 'not-base64!'],
    ['非 canonical base64', CURRENT_KEY_BASE64.replace(/=$/, '')],
    ['非 canonical 尾位', CURRENT_KEY_BASE64.replace(/A=$/, 'B=')],
    ['31-byte', bytesToBase64(CURRENT_KEY_BYTES.slice(0, 31))],
    ['33-byte', bytesToBase64(Uint8Array.from([...CURRENT_KEY_BYTES, 33]))],
  ])('%s current key fail closed', async (_label, value) => {
    await expect(loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: value }))
      .rejects.toThrow('META_CAPI_DATA_KEY_INVALID')
  })

  it('previous key 配置非法时 fail closed，相同 key ID 时仅保留 current', async () => {
    await expect(loadMetaCapiCryptoKeys({
      META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64,
      META_CAPI_DATA_KEY_PREVIOUS: 'invalid-previous-secret',
    })).rejects.toThrow('META_CAPI_DATA_KEY_INVALID')

    const duplicate = await loadMetaCapiCryptoKeys({
      META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64,
      META_CAPI_DATA_KEY_PREVIOUS: CURRENT_KEY_BASE64,
    })
    expect(duplicate.previous).toBeUndefined()
  })

  it('每次使用不同的 12-byte IV，相同明文生成不同 ciphertext', async () => {
    const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64 })
    const first = await encryptMetaCapiContext({ keys, aad: AAD, value: SENSITIVE_CONTEXT })
    const second = await encryptMetaCapiContext({ keys, aad: AAD, value: SENSITIVE_CONTEXT })

    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it.each([
    ['delivery ID', { ...AAD, deliveryId: 'delivery-sensitive-002' }],
    ['event ID', { ...AAD, externalEventId: 'event-sensitive-002' }],
    ['event name', { ...AAD, eventName: 'Contact' as const }],
  ])('修改 %s 后认证解密失败', async (_label, changedAad) => {
    const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64 })
    const envelope = await encryptMetaCapiContext({ keys, aad: AAD, value: SENSITIVE_CONTEXT })
    await expect(decryptMetaCapiContext({ keys, aad: changedAad, envelope }))
      .rejects.toThrow('META_CAPI_CONTEXT_INVALID')
  })

  it.each(['ciphertext', 'tag'] as const)('修改 %s 后认证解密失败', async (field) => {
    const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64 })
    const envelope = await encryptMetaCapiContext({ keys, aad: AAD, value: SENSITIVE_CONTEXT })
    const changed = { ...envelope, [field]: mutateBase64Url(envelope[field]) }
    await expect(decryptMetaCapiContext({ keys, aad: AAD, envelope: changed }))
      .rejects.toThrow('META_CAPI_CONTEXT_INVALID')
  })

  it('current/previous 轮换窗口均可解密，未知 key ID 拒绝', async () => {
    const previousOnly = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: PREVIOUS_KEY_BASE64 })
    const previousEnvelope = await encryptMetaCapiContext({ keys: previousOnly, aad: AAD, value: SENSITIVE_CONTEXT })
    const rotated = await loadMetaCapiCryptoKeys({
      META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64,
      META_CAPI_DATA_KEY_PREVIOUS: PREVIOUS_KEY_BASE64,
    })
    const currentEnvelope = await encryptMetaCapiContext({ keys: rotated, aad: AAD, value: SENSITIVE_CONTEXT })

    await expect(decryptMetaCapiContext({ keys: rotated, aad: AAD, envelope: currentEnvelope }))
      .resolves.toEqual(SENSITIVE_CONTEXT)
    await expect(decryptMetaCapiContext({ keys: rotated, aad: AAD, envelope: previousEnvelope }))
      .resolves.toEqual(SENSITIVE_CONTEXT)
    await expect(decryptMetaCapiContext({
      keys: rotated,
      aad: AAD,
      envelope: { ...currentEnvelope, keyId: '0123456789abcdef' },
    })).rejects.toThrow('META_CAPI_CONTEXT_INVALID')
  })

  it('严格校验 envelope schema/编码/长度以及活动 AAD 字段', async () => {
    const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64 })
    const envelope = await encryptMetaCapiContext({ keys, aad: AAD, value: SENSITIVE_CONTEXT })
    const invalidEnvelopes: MetaCapiEncryptedEnvelope[] = [
      { ...envelope, schemaVersion: 1 as 2 },
      { ...envelope, iv: `${envelope.iv}=` },
      { ...envelope, iv: envelope.iv.slice(1) },
      { ...envelope, tag: envelope.tag.slice(1) },
      { ...envelope, ciphertext: '*' },
      { ...envelope, expiresAt: '2026-07-12T00:00:00Z' } as MetaCapiEncryptedEnvelope,
    ]

    for (const invalidEnvelope of invalidEnvelopes) {
      await expect(decryptMetaCapiContext({ keys, aad: AAD, envelope: invalidEnvelope }))
        .rejects.toThrow('META_CAPI_CONTEXT_INVALID')
    }
    await expect(decryptMetaCapiContext({
      keys,
      aad: { ...AAD, eventName: 'Lead' as 'Contact' },
      envelope,
    })).rejects.toThrow('META_CAPI_CONTEXT_INVALID')
    await expect(encryptMetaCapiContext({
      keys,
      aad: { ...AAD, deliveryId: '' },
      value: SENSITIVE_CONTEXT,
    })).rejects.toThrow('META_CAPI_CONTEXT_INVALID')
  })

  it('明文仅接受固定 allowlist，并严格校验 hash', async () => {
    const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64 })
    await expect(encryptMetaCapiContext({
      keys,
      aad: AAD,
      value: { ...SENSITIVE_CONTEXT, accessToken: 'must-not-pass' } as typeof SENSITIVE_CONTEXT,
    })).rejects.toThrow('META_CAPI_CONTEXT_INVALID')
    await expect(encryptMetaCapiContext({
      keys,
      aad: AAD,
      value: { ...SENSITIVE_CONTEXT, emailSha256: 'A'.repeat(64) },
    })).rejects.toThrow('META_CAPI_CONTEXT_INVALID')

    const unknownFieldEnvelope = await encryptRawContext(keys, AAD, {
      ...SENSITIVE_CONTEXT,
      accessToken: 'must-not-pass',
    })
    await expect(decryptMetaCapiContext({ keys, aad: AAD, envelope: unknownFieldEnvelope }))
      .rejects.toThrow('META_CAPI_CONTEXT_INVALID')

    const malformedJsonEnvelope = await encryptRawPlaintext(keys, AAD, '{"fbp":')
    const malformedError = await captureError(() => decryptMetaCapiContext({
      keys,
      aad: AAD,
      envelope: malformedJsonEnvelope,
    }))
    expect(malformedError).toMatchObject({ name: 'Error', message: 'META_CAPI_CONTEXT_INVALID' })
    expect(malformedError).not.toHaveProperty('cause')
  })

  it('connection fingerprint 固定使用 token 作为 HMAC key 和指定 message', async () => {
    const token = 'token-sensitive-value'
    const pixelId = 'pixel-123456'
    const first = await metaConnectionFingerprint(pixelId, token)

    expect(first).toBe('00960dcbb0d79af3afa38d42abef685b7187e00d64afd837279699ed1c6795bd')
    await expect(metaConnectionFingerprint(pixelId, token)).resolves.toBe(first)
    await expect(metaConnectionFingerprint(`${pixelId}-changed`, token)).resolves.not.toBe(first)
    await expect(metaConnectionFingerprint(pixelId, `${token}-changed`)).resolves.not.toBe(first)
  })

  it('所有失败 error/cause/序列化结果均不泄漏敏感原值', async () => {
    const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY_BASE64 })
    const envelope = await encryptMetaCapiContext({ keys, aad: AAD, value: SENSITIVE_CONTEXT })
    const failures = [
      () => loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: `${CURRENT_KEY_BASE64}secret` }),
      () => metaConnectionFingerprint('', 'token-sensitive-value'),
      () => decryptMetaCapiContext({
        keys,
        aad: AAD,
        envelope: { ...envelope, tag: mutateBase64Url(envelope.tag) },
      }),
      () => encryptMetaCapiContext({
        keys,
        aad: AAD,
        value: { ...SENSITIVE_CONTEXT, plaintext: JSON.stringify(SENSITIVE_CONTEXT) } as typeof SENSITIVE_CONTEXT,
      }),
    ]
    const forbidden = [
      CURRENT_KEY_BASE64,
      'token-sensitive-value',
      ...Object.values(SENSITIVE_CONTEXT),
      JSON.stringify(SENSITIVE_CONTEXT),
      AAD.deliveryId,
      AAD.externalEventId,
    ]

    for (const fail of failures) {
      const error = await captureError(fail)
      const exposed = errorSurface(error)
      for (const value of forbidden) expect(exposed).not.toContain(value)
    }
  })
})

async function encryptRawContext(
  keys: MetaCapiCryptoKeys,
  aad: MetaCapiEnvelopeAad,
  value: Record<string, string>,
): Promise<MetaCapiEncryptedEnvelope> {
  return encryptRawPlaintext(keys, aad, JSON.stringify(value))
}

async function encryptRawPlaintext(
  keys: MetaCapiCryptoKeys,
  aad: MetaCapiEnvelopeAad,
  plaintext: string,
): Promise<MetaCapiEncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    deliveryId: aad.deliveryId,
    externalEventId: aad.externalEventId,
    eventName: aad.eventName,
  }))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData,
    tagLength: 128,
  }, keys.current.key, new TextEncoder().encode(plaintext)))
  return {
    schemaVersion: 2,
    keyId: keys.current.id,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(encrypted.slice(0, -16)),
    tag: bytesToBase64Url(encrypted.slice(-16)),
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function bytesToBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlLength(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return atob(padded).length
}

function mutateBase64Url(value: string) {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`
}

async function captureError(action: () => unknown | Promise<unknown>) {
  try {
    await action()
  }
  catch (error) {
    return error
  }
  throw new Error('预期操作失败')
}

function errorSurface(error: unknown) {
  const surfaces: string[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const record = current as { name?: unknown; message?: unknown; cause?: unknown }
    surfaces.push(String(record.name ?? ''), String(record.message ?? ''))
    surfaces.push(JSON.stringify(current, (key, value) => key === 'stack' ? undefined : value) ?? '')
    current = record.cause
  }
  return surfaces.join('\n')
}
