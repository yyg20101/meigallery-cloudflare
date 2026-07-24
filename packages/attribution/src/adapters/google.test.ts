import { describe, expect, it, vi } from 'vitest'
import { createGoogleAdapter, googleAdapter } from './google'
import type {
  BrowserInstructionInput,
  CandidateValidationInput,
  ServerDeliveryInput,
} from './types'

describe('Google Adapter', () => {
  it('将 Canonical Event 映射为 Google conversion 指令', () => {
    expect(googleAdapter.eventName('Contact')).toBe('conversion')
    expect(googleAdapter.eventName('CompleteRegistration')).toBe(
      'conversion',
    )

    expect(googleAdapter.buildBrowserInstruction(
      browserInput(),
    )).toEqual({
      schemaVersion: 1,
      deliveryId: 'delivery_google_1',
      provider: 'google',
      canonicalEvent: 'Contact',
      eventName: 'conversion',
      destination: 'AW-123456789/CONTACT_LABEL',
      externalEventId: 'attr1_google_contact_event',
      receiptToken: 'receipt_google_1',
      payload: {
        send_to: 'AW-123456789/CONTACT_LABEL',
        transaction_id: 'attr1_google_contact_event',
      },
    })
  })

  it('要求 Google 配置精确且两个转化目标互不复用', async () => {
    await expect(googleAdapter.validateCandidate(
      candidate(),
    )).resolves.toMatchObject({
      provider: 'google',
      publicConfigValid: true,
      credentialFormatValid: true,
      bindingsValid: true,
    })

    const duplicated = candidate()
    duplicated.bindings[1] = {
      ...duplicated.bindings[1]!,
      browserDestination: duplicated.bindings[0]!.browserDestination,
      serverDestination: duplicated.bindings[0]!.serverDestination,
    }
    await expect(googleAdapter.validateCandidate(duplicated)).rejects.toThrow(
      'ATTRIBUTION_ADAPTER_INPUT_INVALID',
    )
  })

  it('通过 Data Manager API 发送 Google 专属标识符', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'request_google_1',
    }), { status: 200 }))
    const tokenProvider = vi.fn().mockResolvedValue('google-oauth-token')
    const adapter = createGoogleAdapter({ fetcher, tokenProvider })
    const result = await adapter.deliverServerEvent(serverInput())

    expect(result).toEqual({
      classification: 'accepted',
      provider: 'google',
      httpStatus: 200,
      requestId: 'request_google_1',
    })
    expect(tokenProvider).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(
      'https://datamanager.googleapis.com/v1/events:ingest',
    )
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer google-oauth-token',
      'Content-Type': 'application/json',
      'x-goog-user-project': 'meigallery-ads',
    })
    const body = JSON.parse(String(init.body))
    expect(body.events[0]).toMatchObject({
      transactionId: 'attr1_google_contact_event',
      eventSource: 'WEB',
      adIdentifiers: { gclid: 'google-click-1' },
    })
    expect(JSON.stringify(body)).not.toMatch(
      /fbclid|fbc|fbp|ttclid|ttp/i,
    )
  })

  it('拒绝 Meta connection 和跨平台标识符', async () => {
    await expect(googleAdapter.deliverServerEvent({
      ...serverInput(),
      provider: 'meta',
    } as ServerDeliveryInput)).rejects.toThrow(
      'ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH',
    )
    await expect(googleAdapter.deliverServerEvent({
      ...serverInput(),
      identifiers: { fbclid: 'foreign-click' },
    })).rejects.toThrow('ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH')
  })

  it.each([
    [401, 'credential_invalid'],
    [429, 'retryable'],
    [503, 'retryable'],
    [400, 'destination_invalid'],
  ] as const)('将 HTTP %s 分类为 %s', async (
    status,
    classification,
  ) => {
    const adapter = createGoogleAdapter({
      tokenProvider: vi.fn().mockResolvedValue('google-oauth-token'),
      fetcher: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          requestId: 'request_google_error',
        }), { status }),
      ),
    })

    await expect(adapter.deliverServerEvent(
      serverInput(),
    )).resolves.toMatchObject({
      provider: 'google',
      classification,
      httpStatus: status,
    })
  })

  it('2xx 缺失异步 requestId 时保守重试', async () => {
    const adapter = createGoogleAdapter({
      tokenProvider: vi.fn().mockResolvedValue('google-oauth-token'),
      fetcher: vi.fn().mockResolvedValue(
        new Response('{}', { status: 200 }),
      ),
    })

    await expect(adapter.deliverServerEvent(
      serverInput(),
    )).resolves.toEqual({
      classification: 'retryable',
      provider: 'google',
      httpStatus: 200,
    })
  })

  it('账户级质量仅依赖 delivery diagnostics 时返回 unavailable', async () => {
    await expect(googleAdapter.readQualitySignal({
      provider: 'google',
      connectionId: 'conn_google',
      versionId: 'ver_google',
      publicConfig: candidate().publicConfig,
      credential: candidate().credential,
    })).resolves.toMatchObject({
      availability: 'unavailable',
      provider: 'google',
      reason: 'delivery_diagnostics_only',
    })
  })
})

function candidate(): CandidateValidationInput {
  return {
    provider: 'google',
    connectionId: 'conn_google',
    versionId: 'ver_google',
    publicConfig: {
      tagId: 'AW-123456789',
      customerId: '1234567890',
      cloudProjectId: 'meigallery-ads',
    },
    credential: JSON.stringify({
      type: 'service_account',
      client_email: 'attribution@meigallery-ads.iam.gserviceaccount.com',
      private_key: [
        '-----BEGIN PRIVATE KEY-----',
        'ZmFrZS1rZXk=',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
    bindings: [
      {
        canonicalEvent: 'Contact',
        enabled: true,
        browserDestination: 'AW-123456789/CONTACT_LABEL',
        serverDestination: '111222333',
      },
      {
        canonicalEvent: 'CompleteRegistration',
        enabled: true,
        browserDestination: 'AW-123456789/REGISTRATION_LABEL',
        serverDestination: '444555666',
      },
    ],
  }
}

function browserInput(): BrowserInstructionInput {
  return {
    provider: 'google',
    connectionId: 'conn_google',
    versionId: 'ver_google',
    deliveryId: 'delivery_google_1',
    canonicalEvent: 'Contact',
    externalEventId: 'attr1_google_contact_event',
    destination: 'AW-123456789/CONTACT_LABEL',
    receiptToken: 'receipt_google_1',
  }
}

function serverInput(): ServerDeliveryInput {
  return {
    provider: 'google',
    connectionId: 'conn_google',
    versionId: 'ver_google',
    deliveryId: 'delivery_google_1',
    canonicalEvent: 'Contact',
    externalEventId: 'attr1_google_contact_event',
    occurredAt: '2026-07-24T00:00:00.000Z',
    pageUrl: 'https://example.test/contact',
    destination: '111222333',
    publicConfig: {
      tagId: 'AW-123456789',
      customerId: '1234567890',
      cloudProjectId: 'meigallery-ads',
    },
    credential: candidate().credential,
    identifiers: { gclid: 'google-click-1' },
    contextIssuedAt: 1_784_851_200,
    clientIp: '192.0.2.12',
    userAgent: 'Adapter Test/1.0',
    consent: {
      marketingAllowed: true,
      adUserDataAllowed: true,
      adPersonalizationAllowed: false,
    },
    validateOnly: false,
  }
}
