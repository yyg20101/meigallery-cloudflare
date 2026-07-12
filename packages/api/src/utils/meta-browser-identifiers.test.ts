import { describe, expect, it } from 'vitest'
import {
  buildMetaCapiUserData,
  hashMetaExternalId,
  normalizeAndHashEmail,
  normalizeMetaBrowserIdentifiers,
} from './meta-browser-identifiers'

describe('Meta 浏览器标识校验', () => {
  it('接受顶层合法 fbp/fbc，并拒绝控制字符与超长值', () => {
    expect(normalizeMetaBrowserIdentifiers({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
    })).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
    })
    expect(normalizeMetaBrowserIdentifiers({ fbp: 'bad\nvalue', fbc: 'x'.repeat(300) })).toEqual({})
  })

  it('仅合并四个 allow-list 字段，并拒绝含控制字符或超长的 IP 与 User-Agent', () => {
    const request = new Request('https://api.example.test/api/conversions/events', {
      headers: {
        'CF-Connecting-IP': '203.0.113.24',
        'User-Agent': 'MeiGallery Test Browser/1.0',
      },
    })
    expect(buildMetaCapiUserData(request, {
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      ignored: 'must-not-pass',
    })).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      clientIpAddress: '203.0.113.24',
      clientUserAgent: 'MeiGallery Test Browser/1.0',
    })

    expect(buildMetaCapiUserData({
      headers: {
        get(name: string) {
          return name === 'CF-Connecting-IP' ? `${'1'.repeat(65)}\n` : `${'a'.repeat(513)}\n`
        },
      },
    } as Request, {})).toEqual({})
  })

  it('email 仅执行 trim + lowercase 后返回固定 SHA-256 hex', async () => {
    await expect(normalizeAndHashEmail('  User.Name+tag@Example.COM  ')).resolves.toBe(
      '558dc9448370a12a75d02a7d8736f4aa58dcfe2770bcc14c1a55a1a8ec2699b9',
    )
  })

  it('external ID 直接按 UTF-8 计算固定 SHA-256 lowercase hex', async () => {
    const hash = await hashMetaExternalId('external-id-用户-001')
    expect(hash).toBe('64a5aff1d319d3265d5b94f5bc880c1a47876a07828a0a572fbdc48fbc9cf059')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('空 email/external ID fail closed 且错误不泄漏标识原值', async () => {
    await expect(normalizeAndHashEmail(' \n\t ')).rejects.toThrow('META_CAPI_IDENTIFIER_INVALID')
    await expect(hashMetaExternalId('')).rejects.toThrow('META_CAPI_IDENTIFIER_INVALID')

    const sensitiveEmail = 'Private.User+tag@Example.COM'
    const sensitiveExternalId = 'private-external-id'
    for (const error of [
      await captureError(() => normalizeAndHashEmail({ value: sensitiveEmail } as unknown as string)),
      await captureError(() => hashMetaExternalId({ value: sensitiveExternalId } as unknown as string)),
    ]) {
      const surface = `${String((error as Error).name)}\n${String((error as Error).message)}\n${String((error as Error).cause)}\n${JSON.stringify(error)}`
      expect(surface).not.toContain(sensitiveEmail)
      expect(surface).not.toContain(sensitiveExternalId)
    }
  })
})

async function captureError(action: () => unknown | Promise<unknown>) {
  try {
    await action()
  }
  catch (error) {
    return error
  }
  throw new Error('预期操作失败')
}
