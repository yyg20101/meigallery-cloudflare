import type { AttributionBusinessEventV1 } from '@meigallery/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  AttributionServiceClientError,
  createAttributionServiceClient,
  type AttributionServiceBinding,
} from './attribution-service-client'

describe('Attribution Service Binding client', () => {
  it('仅向固定内部路径发送不透明隐私凭据并严格读取判定', async () => {
    const fetch = vi.fn(async () => Response.json({
      state: 'granted',
      reason: 'explicit',
    }))
    const client = createAttributionServiceClient(binding(fetch))
    const input = {
      privacyToken: 'opaque_signed_privacy_token',
      country: 'US',
      gpc: false,
    }

    await expect(client.resolvePrivacyDecision(input)).resolves.toEqual({
      state: 'granted',
      reason: 'explicit',
    })

    const request = fetch.mock.calls[0]?.[0]
    expect(request?.url).toBe(
      'https://attribution.internal/internal/v1/privacy-decision',
    )
    expect(request?.method).toBe('POST')
    expect(await request?.json()).toEqual(input)
  })

  it('隐私判定拒绝额外输入和不可能的响应状态组合', async () => {
    const fetch = vi.fn(async () => Response.json({
      state: 'granted',
      reason: 'gpc',
    }))
    const client = createAttributionServiceClient(binding(fetch))

    await expect(client.resolvePrivacyDecision({
      privacyToken: null,
      country: 'us',
      gpc: false,
    })).rejects.toMatchObject({
      code: 'ATTRIBUTION_PRIVACY_DECISION_INPUT_INVALID',
    })
    expect(fetch).not.toHaveBeenCalled()

    await expect(client.resolvePrivacyDecision({
      privacyToken: null,
      country: null,
      gpc: false,
    })).rejects.toMatchObject({
      code: 'ATTRIBUTION_PRIVACY_DECISION_RESPONSE_INVALID',
    })
  })

  it('仅向固定内部注册路径发送通过 V1 guard 的 CompleteRegistration', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({
      accepted: true,
      eventId: 'registration_user_42',
    }))
    const client = createAttributionServiceClient(binding(fetch))
    const event = registrationEvent()

    await expect(client.ingestRegistrationEvent(event)).resolves.toEqual({
      accepted: true,
      eventId: event.eventId,
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const request = fetch.mock.calls[0]?.[0]
    expect(request?.url).toBe(
      'https://attribution.internal/internal/v1/registration-events',
    )
    expect(request?.method).toBe('POST')
    expect(request?.headers.get('Content-Type')).toBe('application/json')
    expect(await request?.json()).toEqual(event)
  })

  it('拒绝 Contact、额外字段和不合法 hashedEmail，且不触发 Binding', async () => {
    const fetch = vi.fn()
    const client = createAttributionServiceClient(binding(fetch))
    const valid = registrationEvent()

    await expect(client.ingestRegistrationEvent({
      ...valid,
      eventName: 'Contact',
      payload: {
        contactMethodId: 'telegram',
        contactPlatform: 'telegram',
        contactAction: 'open_link',
      },
    })).rejects.toMatchObject({
      code: 'ATTRIBUTION_REGISTRATION_EVENT_INVALID',
    })
    await expect(client.ingestRegistrationEvent({
      ...valid,
      payload: { userId: 42, unexpected: true },
    } as unknown as AttributionBusinessEventV1)).rejects.toMatchObject({
      code: 'ATTRIBUTION_REGISTRATION_EVENT_INVALID',
    })
    await expect(client.ingestRegistrationEvent({
      ...valid,
      payload: { userId: 42, hashedEmail: 'not-a-sha256' },
    })).rejects.toMatchObject({
      code: 'ATTRIBUTION_REGISTRATION_EVENT_INVALID',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('严格校验 ingest 响应中的 accepted 与 eventId', async () => {
    const client = createAttributionServiceClient(binding(
      vi.fn(async () => Response.json({
        accepted: true,
        eventId: 'registration_user_other',
      })),
    ))

    await expect(client.ingestRegistrationEvent(registrationEvent()))
      .rejects.toMatchObject({
        code: 'ATTRIBUTION_REGISTRATION_INGEST_RESPONSE_INVALID',
      })
  })

  it('非成功响应只暴露稳定错误码与状态，不读取远端错误正文', async () => {
    const client = createAttributionServiceClient(binding(
      vi.fn(async () => new Response('private upstream detail', {
        status: 503,
      })),
    ))

    const error = await client.ingestRegistrationEvent(registrationEvent())
      .catch(value => value)
    expect(error).toBeInstanceOf(AttributionServiceClientError)
    expect(error).toMatchObject({
      code: 'ATTRIBUTION_REGISTRATION_INGEST_FAILED',
      status: 503,
    })
    expect(String(error)).not.toContain('private upstream detail')
  })

  it('通过固定事件路径获取签名 Browser instruction', async () => {
    const fetch = vi.fn(async () => Response.json({
      instructionToken: 'instruction_token_0123456789',
    }))
    const client = createAttributionServiceClient(binding(fetch))

    await expect(client.getSignedBrowserInstruction({
      eventId: 'registration_user_42',
    })).resolves.toEqual({
      instructionToken: 'instruction_token_0123456789',
    })

    const request = fetch.mock.calls[0]?.[0]
    expect(request?.url).toBe(
      'https://attribution.internal/internal/v1/events/registration_user_42/browser-instruction',
    )
    expect(request?.method).toBe('GET')
  })

  it('拒绝把路径、URL 或空值当作 eventId', async () => {
    const fetch = vi.fn()
    const client = createAttributionServiceClient(binding(fetch))

    for (const eventId of ['', '../admin', 'https://example.com']) {
      await expect(client.getSignedBrowserInstruction({ eventId }))
        .rejects.toMatchObject({
          code: 'ATTRIBUTION_BROWSER_INSTRUCTION_INPUT_INVALID',
        })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('批量请求联系人 capability，并按请求顺序返回严格匹配的签名结果', async () => {
    const telegram = contact('telegram', 'telegram', 'a')
    const whatsapp = contact('whatsapp', 'whatsapp', 'b')
    const fetch = vi.fn(async () => Response.json({
      capabilities: [
        {
          ...whatsapp,
          attributionCapability: 'capability_whatsapp_0123456789',
        },
        {
          ...telegram,
          attributionCapability: 'capability_telegram_0123456789',
        },
      ],
    }))
    const client = createAttributionServiceClient(binding(fetch))

    await expect(client.getSignedContactCapabilities([
      telegram,
      whatsapp,
    ])).resolves.toEqual([
      {
        ...telegram,
        attributionCapability: 'capability_telegram_0123456789',
      },
      {
        ...whatsapp,
        attributionCapability: 'capability_whatsapp_0123456789',
      },
    ])

    const request = fetch.mock.calls[0]?.[0]
    expect(request?.url).toBe(
      'https://attribution.internal/internal/v1/contact-capabilities',
    )
    expect(request?.method).toBe('POST')
    expect(await request?.json()).toEqual({
      contacts: [telegram, whatsapp],
    })
  })

  it('联系人 capability 请求拒绝明文目标、重复项和不匹配响应', async () => {
    const valid = contact('telegram', 'telegram', 'a')
    const fetch = vi.fn(async () => Response.json({
      capabilities: [{
        ...valid,
        contactMethodId: 'other',
        attributionCapability: 'capability_telegram_0123456789',
      }],
    }))
    const client = createAttributionServiceClient(binding(fetch))

    await expect(client.getSignedContactCapabilities([{
      ...valid,
      destinationDigest: 'https://t.me/plain-destination',
    }])).rejects.toMatchObject({
      code: 'ATTRIBUTION_CONTACT_CAPABILITY_INPUT_INVALID',
    })
    await expect(client.getSignedContactCapabilities([
      valid,
      valid,
    ])).rejects.toMatchObject({
      code: 'ATTRIBUTION_CONTACT_CAPABILITY_INPUT_INVALID',
    })
    expect(fetch).not.toHaveBeenCalled()

    await expect(client.getSignedContactCapabilities([valid]))
      .rejects.toMatchObject({
        code: 'ATTRIBUTION_CONTACT_CAPABILITY_RESPONSE_INVALID',
      })
  })
})

function binding(
  fetch: (request: Request) => Promise<Response>,
): AttributionServiceBinding {
  return { fetch }
}

function registrationEvent(): AttributionBusinessEventV1 {
  return {
    schemaVersion: 1,
    eventId: 'registration_user_42',
    eventName: 'CompleteRegistration',
    occurredAt: '2026-07-24T08:00:00.000Z',
    pagePath: '/register?source=campaign',
    dedupeKey: 'registration_user_42',
    sourceContextToken: 'opaque_context_token',
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: true,
    },
    payload: {
      userId: 42,
      hashedEmail: 'a'.repeat(64),
    },
  }
}

function contact(
  contactMethodId: string,
  platform: string,
  digestCharacter: string,
) {
  return {
    contactMethodId,
    platform,
    destinationDigest: digestCharacter.repeat(64),
  }
}
