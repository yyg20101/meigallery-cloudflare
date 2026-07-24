import { describe, expect, it, vi } from 'vitest'
import { createMetaAdapter, metaAdapter } from './meta'
import type {
  BrowserInstructionInput,
  CandidateValidationInput,
  ServerDeliveryInput,
} from './types'

describe('Meta Adapter', () => {
  it('保持标准事件名并构造最小 Browser 指令', () => {
    expect(metaAdapter.eventName('Contact')).toBe('Contact')
    expect(metaAdapter.eventName('CompleteRegistration')).toBe(
      'CompleteRegistration',
    )

    const instruction = metaAdapter.buildBrowserInstruction(
      browserInput('meta', 'Contact', 'meta_pixel'),
    )
    expect(instruction).toEqual({
      schemaVersion: 1,
      deliveryId: 'delivery_meta_1',
      provider: 'meta',
      canonicalEvent: 'Contact',
      eventName: 'Contact',
      destination: 'meta_pixel',
      externalEventId: 'attr1_meta_contact_event',
      receiptToken: 'receipt_meta_1',
      payload: {},
    })
    expect(JSON.stringify(instruction)).not.toMatch(
      /credential|accessToken|server|fbclid|clientIp|userAgent/i,
    )
  })

  it('校验精确配置、凭证格式和完整事件绑定', async () => {
    await expect(metaAdapter.validateCandidate(
      candidate('meta'),
    )).resolves.toMatchObject({
      schemaVersion: 1,
      provider: 'meta',
      publicConfigValid: true,
      credentialFormatValid: true,
      bindingsValid: true,
    })

    await expect(metaAdapter.validateCandidate({
      ...candidate('meta'),
      publicConfig: {
        pixelId: '1234567890123456',
        pixelCode: 'TIKTOKPIXELDEMOABCDEF',
      },
    })).rejects.toThrow('ATTRIBUTION_ADAPTER_INPUT_INVALID')
  })

  it('只向匹配 Pixel 发送 Meta CAPI 请求且复用 event id', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events_received: 1,
    }), {
      status: 200,
      headers: { 'x-fb-trace-id': 'trace_meta_1' },
    }))
    const adapter = createMetaAdapter({ fetcher })
    const result = await adapter.deliverServerEvent(
      serverInput('meta', {
        destination: 'meta_capi',
        publicConfig: { pixelId: '1234567890123456' },
        identifiers: { fbclid: 'fb-click-1' },
      }),
    )

    expect(result).toEqual({
      classification: 'accepted',
      provider: 'meta',
      httpStatus: 200,
      requestId: 'trace_meta_1',
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(
      'https://graph.facebook.com/v25.0/1234567890123456/events',
    )
    expect(String(url)).not.toContain('access_token')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer meta-access-token',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse(String(init.body))
    expect(body.data[0]).toMatchObject({
      event_name: 'Contact',
      event_id: 'attr1_meta_contact_event',
      action_source: 'website',
    })
    expect(body.data[0].user_data).toMatchObject({
      fbc: 'fb.1.1784851200000.fb-click-1',
      client_ip_address: '192.0.2.10',
      client_user_agent: 'Adapter Test/1.0',
    })
    expect(JSON.stringify(body)).not.toMatch(
      /ttclid|gclid|gbraid|wbraid|access_token/i,
    )
  })

  it('测试码只进入 validateOnly 请求，正式事件明确拒绝携带', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events_received: 1,
    }), { status: 200 }))
    const adapter = createMetaAdapter({ fetcher })

    expect(adapter.normalizeTestEventCode(' test12345 ')).toBe(
      'TEST12345',
    )
    await adapter.deliverServerEvent(serverInput('meta', {
      validateOnly: true,
      testEventCode: 'TEST12345',
    }))
    const body = JSON.parse(String(fetcher.mock.calls[0]![1].body))
    expect(body.test_event_code).toBe('TEST12345')

    await expect(adapter.deliverServerEvent(serverInput('meta', {
      validateOnly: false,
      testEventCode: 'TEST12345',
    }))).rejects.toThrow('ATTRIBUTION_ADAPTER_INPUT_INVALID')
  })

  it('拒绝 TikTok connection 和跨平台标识符', async () => {
    await expect(metaAdapter.deliverServerEvent({
      ...serverInput('meta'),
      provider: 'tiktok',
    } as ServerDeliveryInput)).rejects.toThrow(
      'ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH',
    )
    await expect(metaAdapter.deliverServerEvent(serverInput('meta', {
      identifiers: { ttclid: 'foreign-click' },
    }))).rejects.toThrow('ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH')
  })

  it.each([
    [401, { error: { code: 190 } }, 'credential_invalid'],
    [429, { error: { code: 4, is_transient: true } }, 'retryable'],
    [503, {}, 'retryable'],
    [400, { error: { code: 100 } }, 'destination_invalid'],
  ] as const)('将 HTTP %s 分类为 %s', async (
    status,
    body,
    classification,
  ) => {
    const adapter = createMetaAdapter({
      fetcher: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), { status }),
      ),
    })

    await expect(adapter.deliverServerEvent(
      serverInput('meta'),
    )).resolves.toMatchObject({
      provider: 'meta',
      classification,
      httpStatus: status,
    })
  })

  it('读取 Dataset Quality 且不把凭证放入 URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      web: {
        data: [{
          event_name: 'Contact',
          event_match_quality: {
            composite_score: 7.2,
            match_key_feedback: [{
              identifier: 'fbc',
              coverage: { percentage: 88 },
            }],
          },
        }],
      },
    }), { status: 200 }))
    const adapter = createMetaAdapter({
      fetcher,
      now: () => new Date('2026-07-24T01:00:00.000Z'),
    })

    await expect(adapter.readQualitySignal({
      provider: 'meta',
      connectionId: 'conn_meta',
      versionId: 'ver_meta',
      publicConfig: { pixelId: '1234567890123456' },
      credential: 'meta-access-token',
    })).resolves.toEqual({
      availability: 'available',
      provider: 'meta',
      metrics: [
        { canonicalEvent: 'Contact', key: 'emq_score', value: 7.2 },
        { canonicalEvent: 'Contact', key: 'fbc_coverage', value: 88 },
      ],
      checkedAt: '2026-07-24T01:00:00.000Z',
    })
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toContain('dataset_quality')
    expect(String(url)).not.toContain('meta-access-token')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer meta-access-token',
    })
  })

  it('Dataset Quality 事件结构异常时明确返回错误', async () => {
    const adapter = createMetaAdapter({
      fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        web: {
          data: [{
            event_name: 'Contact',
            event_match_quality: 'invalid',
          }],
        },
      }), { status: 200 })),
      now: () => new Date('2026-07-24T01:00:00.000Z'),
    })

    await expect(adapter.readQualitySignal({
      provider: 'meta',
      connectionId: 'conn_meta',
      versionId: 'ver_meta',
      publicConfig: { pixelId: '1234567890123456' },
      credential: 'meta-access-token',
    })).resolves.toEqual({
      availability: 'error',
      provider: 'meta',
      reason: 'invalid_response',
      checkedAt: '2026-07-24T01:00:00.000Z',
    })
  })
})

function candidate(provider: 'meta'): CandidateValidationInput {
  return {
    provider,
    connectionId: 'conn_meta',
    versionId: 'ver_meta',
    publicConfig: { pixelId: '1234567890123456' },
    credential: 'meta-access-token',
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
  }
}

function browserInput(
  provider: 'meta',
  canonicalEvent: 'Contact',
  destination: string,
): BrowserInstructionInput {
  return {
    provider,
    connectionId: 'conn_meta',
    versionId: 'ver_meta',
    deliveryId: 'delivery_meta_1',
    canonicalEvent,
    externalEventId: 'attr1_meta_contact_event',
    destination,
    receiptToken: 'receipt_meta_1',
  }
}

function serverInput(
  provider: 'meta',
  overrides: Partial<ServerDeliveryInput> = {},
): ServerDeliveryInput {
  return {
    provider,
    connectionId: 'conn_meta',
    versionId: 'ver_meta',
    deliveryId: 'delivery_meta_1',
    canonicalEvent: 'Contact',
    externalEventId: 'attr1_meta_contact_event',
    occurredAt: '2026-07-24T00:00:00.000Z',
    pageUrl: 'https://example.test/contact',
    destination: 'meta_capi',
    publicConfig: { pixelId: '1234567890123456' },
    credential: 'meta-access-token',
    identifiers: { fbclid: 'fb-click-1' },
    contextIssuedAt: 1_784_851_200,
    hashedEmail: undefined,
    clientIp: '192.0.2.10',
    userAgent: 'Adapter Test/1.0',
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: false,
    },
    validateOnly: false,
    ...overrides,
  }
}
