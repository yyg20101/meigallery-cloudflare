import { describe, expect, it } from 'vitest'
import {
  CONTACT_CAPABILITY_MAX_AGE_SECONDS,
  issueContactCapability,
  stableJson,
  verifyContactCapability,
  type ContactCapabilityV1,
} from './contact-capability'

const currentKey = 'contact-capability-current-key-at-least-32-bytes'
const previousKey = 'contact-capability-previous-key-at-least-32-bytes'
const nowSeconds = 1_785_024_000

describe('联系人归因 capability', () => {
  it('按固定 payload 和精确 HMAC 输入使用 current 签发', async () => {
    const token = await issueContactCapability({
      signingKeys: { current: currentKey },
      nowSeconds: () => nowSeconds,
    }, input(), 3_600)
    const payload: ContactCapabilityV1 = {
      schemaVersion: 1,
      contactMethodId: 'contact_telegram_1',
      platform: 'telegram',
      destinationDigest: 'a'.repeat(64),
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + 3_600,
    }
    const encodedPayload = base64Url(
      new TextEncoder().encode(stableJson(payload)),
    )
    const signature = await hmac(
      currentKey,
      `contact-capability:v1:${encodedPayload}`,
    )

    expect(token).toBe(`v1.${encodedPayload}.${base64Url(signature)}`)
    expect(await verifyContactCapability({
      signingKeys: { current: currentKey },
      nowSeconds: () => nowSeconds,
    }, token)).toEqual(payload)
  })

  it('密钥轮换时只允许 current 签发并由 current/previous 验证', async () => {
    const oldToken = await issueContactCapability({
      signingKeys: { current: previousKey },
      nowSeconds: () => nowSeconds,
    }, input())
    const newToken = await issueContactCapability({
      signingKeys: { current: currentKey, previous: previousKey },
      nowSeconds: () => nowSeconds,
    }, input())
    const rotated = {
      signingKeys: { current: currentKey, previous: previousKey },
      nowSeconds: () => nowSeconds,
    }

    expect(await verifyContactCapability(rotated, oldToken)).not.toBeNull()
    expect(await verifyContactCapability(rotated, newToken)).not.toBeNull()
    expect(await verifyContactCapability({
      signingKeys: { current: currentKey },
      nowSeconds: () => nowSeconds,
    }, oldToken)).toBeNull()
  })

  it('最长签发 24 小时并拒绝过期、超长和篡改 token', async () => {
    const environment = {
      signingKeys: { current: currentKey },
      nowSeconds: () => nowSeconds,
    }
    const token = await issueContactCapability(environment, input())

    expect((await verifyContactCapability(
      environment,
      token,
    ))?.expiresAt).toBe(nowSeconds + CONTACT_CAPABILITY_MAX_AGE_SECONDS)
    await expect(issueContactCapability(
      environment,
      input(),
      CONTACT_CAPABILITY_MAX_AGE_SECONDS + 1,
    )).rejects.toThrow('ATTRIBUTION_CONTACT_CAPABILITY_INVALID')
    expect(await verifyContactCapability({
      ...environment,
      nowSeconds: () => nowSeconds + CONTACT_CAPABILITY_MAX_AGE_SECONDS,
    }, token)).toBeNull()

    const parts = token.split('.')
    expect(await verifyContactCapability(
      environment,
      `${parts[0]}.${parts[1]}.${parts[2]!.replace(/^./u, 'A')}`,
    )).toBeNull()
  })

  it.each([
    [{ ...input(), contactMethodId: '' }, '空联系人 ID'],
    [{ ...input(), platform: 'telegram\n' }, '控制字符'],
    [{ ...input(), destinationDigest: 'A'.repeat(64) }, '非规范摘要'],
    [{ ...input(), destinationDigest: 'a'.repeat(63) }, '摘要长度错误'],
  ])('拒绝非法签发输入：%s（%s）', async (value) => {
    await expect(issueContactCapability({
      signingKeys: { current: currentKey },
      nowSeconds: () => nowSeconds,
    }, value)).rejects.toThrow('ATTRIBUTION_CONTACT_CAPABILITY_INVALID')
  })

  it('拒绝 payload 多字段、非稳定 JSON 和超过 24 小时的已签名 token', async () => {
    const payload = {
      schemaVersion: 1,
      contactMethodId: 'contact_telegram_1',
      platform: 'telegram',
      destinationDigest: 'a'.repeat(64),
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + CONTACT_CAPABILITY_MAX_AGE_SECONDS + 1,
      credential: 'must-not-exist',
    }
    const encoded = base64Url(
      new TextEncoder().encode(JSON.stringify(payload)),
    )
    const signature = await hmac(
      currentKey,
      `contact-capability:v1:${encoded}`,
    )

    expect(await verifyContactCapability({
      signingKeys: { current: currentKey },
      nowSeconds: () => nowSeconds,
    }, `v1.${encoded}.${base64Url(signature)}`)).toBeNull()
  })
})

function input() {
  return {
    contactMethodId: 'contact_telegram_1',
    platform: 'telegram',
    destinationDigest: 'a'.repeat(64),
  }
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  ))
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}
