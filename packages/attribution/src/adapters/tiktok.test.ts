import { describe, expect, it, vi } from 'vitest'
import { createTikTokAdapter, tiktokAdapter } from './tiktok'
import type {
  BrowserInstructionInput,
  CandidateValidationInput,
  ServerDeliveryInput,
} from './types'

describe('TikTok Adapter', () => {
  it('保持标准事件名并构造最小 Browser 指令', () => {
    expect(tiktokAdapter.eventName('Contact')).toBe('Contact')
    expect(tiktokAdapter.eventName('CompleteRegistration')).toBe(
      'CompleteRegistration',
    )

    expect(tiktokAdapter.buildBrowserInstruction(
      browserInput(),
    )).toEqual({
      schemaVersion: 1,
      deliveryId: 'delivery_tiktok_1',
      provider: 'tiktok',
      canonicalEvent: 'CompleteRegistration',
      eventName: 'CompleteRegistration',
      destination: 'tiktok_pixel',
      externalEventId: 'attr1_tiktok_registration_event',
      receiptToken: 'receipt_tiktok_1',
      payload: {},
    })
  })

  it('校验 TikTok Pixel 配置和唯一事件绑定', async () => {
    await expect(tiktokAdapter.validateCandidate(
      candidate(),
    )).resolves.toMatchObject({
      provider: 'tiktok',
      publicConfigValid: true,
      credentialFormatValid: true,
      bindingsValid: true,
    })

    await expect(tiktokAdapter.validateCandidate({
      ...candidate(),
      bindings: candidate().bindings.slice(0, 1),
    })).rejects.toThrow('ATTRIBUTION_ADAPTER_INPUT_INVALID')
  })

  it('使用 Events API v1.3 且只携带 TikTok 标识符', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      request_id: 'request_tiktok_1',
    }), { status: 200 }))
    const adapter = createTikTokAdapter({ fetcher })
    const result = await adapter.deliverServerEvent(serverInput())

    expect(result).toEqual({
      classification: 'accepted',
      provider: 'tiktok',
      httpStatus: 200,
      requestId: 'request_tiktok_1',
      providerCode: 0,
    })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(
      'https://business-api.tiktok.com/open_api/v1.3/event/track/',
    )
    expect(init.headers).toMatchObject({
      'Access-Token': 'tiktok-access-token',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      event_source: 'web',
      event_source_id: 'D9AF43RC77U133LMNMM0',
    })
    expect(body.data[0]).toMatchObject({
      event: 'Contact',
      event_id: 'attr1_tiktok_contact_event',
      user: {
        ttclid: 'tt-click-1',
        ip: '192.0.2.11',
        user_agent: 'Adapter Test/1.0',
      },
    })
    expect(JSON.stringify(body)).not.toMatch(
      /fbclid|fbc|fbp|gclid|gbraid|wbraid/i,
    )
  })

  it('拒绝 Meta connection 和跨平台标识符', async () => {
    await expect(tiktokAdapter.deliverServerEvent({
      ...serverInput(),
      provider: 'meta',
    } as ServerDeliveryInput)).rejects.toThrow(
      'ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH',
    )
    await expect(tiktokAdapter.deliverServerEvent({
      ...serverInput(),
      identifiers: { gclid: 'foreign-click' },
    })).rejects.toThrow('ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH')
  })

  it.each([
    [401, { code: 40101 }, 'credential_invalid'],
    [429, { code: 40100 }, 'retryable'],
    [503, { code: 50000 }, 'retryable'],
    [400, { code: 40002 }, 'destination_invalid'],
  ] as const)('将 HTTP %s 分类为 %s', async (
    status,
    body,
    classification,
  ) => {
    const adapter = createTikTokAdapter({
      fetcher: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), { status }),
      ),
    })

    await expect(adapter.deliverServerEvent(
      serverInput(),
    )).resolves.toMatchObject({
      provider: 'tiktok',
      classification,
      httpStatus: status,
    })
  })

  it('质量 API 未配置时只返回 unavailable', async () => {
    await expect(tiktokAdapter.readQualitySignal({
      provider: 'tiktok',
      connectionId: 'conn_tiktok',
      versionId: 'ver_tiktok',
      publicConfig: { pixelCode: 'D9AF43RC77U133LMNMM0' },
      credential: 'tiktok-access-token',
    })).resolves.toMatchObject({
      availability: 'unavailable',
      provider: 'tiktok',
      reason: 'account_quality_api_not_configured',
    })
  })
})

function candidate(): CandidateValidationInput {
  return {
    provider: 'tiktok',
    connectionId: 'conn_tiktok',
    versionId: 'ver_tiktok',
    publicConfig: { pixelCode: 'D9AF43RC77U133LMNMM0' },
    credential: 'tiktok-access-token',
    bindings: [
      {
        canonicalEvent: 'Contact',
        enabled: true,
        browserDestination: 'tiktok_pixel',
        serverDestination: 'tiktok_events_api',
      },
      {
        canonicalEvent: 'CompleteRegistration',
        enabled: true,
        browserDestination: 'tiktok_pixel',
        serverDestination: 'tiktok_events_api',
      },
    ],
  }
}

function browserInput(): BrowserInstructionInput {
  return {
    provider: 'tiktok',
    connectionId: 'conn_tiktok',
    versionId: 'ver_tiktok',
    deliveryId: 'delivery_tiktok_1',
    canonicalEvent: 'CompleteRegistration',
    externalEventId: 'attr1_tiktok_registration_event',
    destination: 'tiktok_pixel',
    receiptToken: 'receipt_tiktok_1',
  }
}

function serverInput(): ServerDeliveryInput {
  return {
    provider: 'tiktok',
    connectionId: 'conn_tiktok',
    versionId: 'ver_tiktok',
    deliveryId: 'delivery_tiktok_1',
    canonicalEvent: 'Contact',
    externalEventId: 'attr1_tiktok_contact_event',
    occurredAt: '2026-07-24T00:00:00.000Z',
    pageUrl: 'https://example.test/contact',
    destination: 'tiktok_events_api',
    publicConfig: { pixelCode: 'D9AF43RC77U133LMNMM0' },
    credential: 'tiktok-access-token',
    identifiers: { ttclid: 'tt-click-1' },
    contextIssuedAt: 1_784_851_200,
    clientIp: '192.0.2.11',
    userAgent: 'Adapter Test/1.0',
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: false,
    },
    validateOnly: false,
  }
}
