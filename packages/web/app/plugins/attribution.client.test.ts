import type {
  AdBrowserPublicConfig,
  AdConsentSnapshot,
  AttributionBrowserInstructionV1,
} from '@meigallery/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttributionClientDependencies } from './attribution.client'

let createAttributionBrowserClient:
  typeof import('./attribution.client')['createAttributionBrowserClient']

const META_CONFIG = {
  provider: 'meta',
  connectionId: 'connection_meta',
  versionId: 'version_meta',
  publicConfig: { provider: 'meta', pixelId: '1234567890123456' },
  runtimeLeaseToken: 'runtime_lease_token_0123456789',
  expiresAt: 1_800_000_000,
} as const

const META_INSTRUCTION: AttributionBrowserInstructionV1 = {
  schemaVersion: 1,
  deliveryId: 'delivery_meta_browser',
  provider: 'meta',
  canonicalEvent: 'Contact',
  eventName: 'Contact',
  destination: 'meta_pixel',
  externalEventId: 'attr1_meta_contact',
  receiptToken: 'receipt_token_0123456789',
  payload: { method_type: 'telegram' },
}

const consent: AdConsentSnapshot = {
  consentVersion: 1,
  marketingAllowed: true,
  adUserDataAllowed: true,
  adPersonalizationAllowed: false,
  decidedAt: '2026-07-24T00:00:00.000Z',
}

const fetchMock = vi.fn()
const initialize = vi.fn()
const execute = vi.fn()
const signal = vi.fn()
const teardown = vi.fn()
const storage = new Map<string, string>()

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function dependencies(
  overrides: Partial<AttributionClientDependencies> = {},
): AttributionClientDependencies {
  return {
    baseUrl: 'https://track.example.com',
    fetch: fetchMock,
    registry: {
      initialize,
      execute,
      signal,
      teardown,
    },
    storage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value) },
      removeItem: key => { storage.delete(key) },
    },
    now: () => new Date('2026-07-24T00:00:00.000Z'),
    eventId: () => 'contact_browser_123',
    ...overrides,
  }
}

function instructionToken(instruction = META_INSTRUCTION) {
  const issuedAt = Math.floor(
    new Date('2026-07-24T00:00:00.000Z').getTime() / 1_000,
  )
  const payload = btoa(JSON.stringify({
    schemaVersion: 1,
    eventId: 'contact_browser_123',
    issuedAt,
    expiresAt: issuedAt + 300,
    instruction,
  })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  return `v1.${'a'.repeat(32)}.${payload}.${'b'.repeat(43)}`
}

describe('Attribution Browser Client', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    storage.clear()
    vi.stubGlobal('defineNuxtPlugin', <T>(plugin: T) => plugin)
    createAttributionBrowserClient = (
      await import('./attribution.client')
    ).createAttributionBrowserClient
    initialize.mockResolvedValue(true)
    execute.mockResolvedValue(true)
    signal.mockResolvedValue(true)
    teardown.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('只加载可信来源对应的 Pixel', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ data: { issued: true } }))
      .mockResolvedValueOnce(response({ data: META_CONFIG }))
    const client = createAttributionBrowserClient(dependencies())

    await client.start({
      fullPath: '/gallery/one?fbclid=click',
      path: '/gallery/one',
      query: { fbclid: 'click' },
    }, consent)

    expect(initialize).toHaveBeenCalledOnce()
    expect(initialize).toHaveBeenCalledWith(
      META_CONFIG.publicConfig,
      consent,
    )
    expect(signal).toHaveBeenCalledWith('meta', 'PageView', {})
  })

  it('GPC 或地区策略未授权时不加载任何平台脚本', async () => {
    const client = createAttributionBrowserClient(dependencies())

    await client.start({
      fullPath: '/',
      path: '/',
      query: {},
    }, {
      ...consent,
      marketingAllowed: false,
      adUserDataAllowed: false,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(initialize).not.toHaveBeenCalled()
    expect(teardown).toHaveBeenCalledOnce()
  })

  it('建立上下文时不读取响应体且所有跨子域请求携带 credentials', async () => {
    const contextResponse = new Response(null, { status: 204 })
    vi.spyOn(contextResponse, 'json').mockRejectedValue(
      new Error('上下文响应体不应读取'),
    )
    fetchMock
      .mockResolvedValueOnce(contextResponse)
      .mockResolvedValueOnce(response({ data: META_CONFIG }))
    const client = createAttributionBrowserClient(dependencies())

    await expect(client.start({
      fullPath: '/?fbclid=click',
      path: '/',
      query: { fbclid: 'click' },
    }, consent)).resolves.toBeUndefined()

    expect(contextResponse.json).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://track.example.com/v1/context',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://track.example.com/v1/runtime-config',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(client.exposedState()).not.toHaveProperty('sourceContextToken')
  })

  it('Contact 取得服务端指令后只执行当前平台并提交回执', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ data: META_CONFIG }))
      .mockResolvedValueOnce(response({
        accepted: true,
        eventId: 'contact_browser_123',
        instruction: META_INSTRUCTION,
      }))
      .mockResolvedValueOnce(response({ accepted: true }))
    const client = createAttributionBrowserClient(dependencies())
    await client.start({ fullPath: '/', path: '/', query: {} }, consent)

    const result = await client.trackContact({
      contactMethodId: 'contact_1',
      methodType: 'telegram',
      actionType: 'open_link',
      linkUrl: 'https://t.me/example',
      value: '@example',
      attributionCapability: 'capability_0123456789',
      pagePath: '/',
    })

    expect(result).toEqual({
      eventId: 'contact_browser_123',
      externalEventId: 'attr1_meta_contact',
    })
    expect(execute).toHaveBeenCalledWith(META_INSTRUCTION)
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://track.example.com/v1/browser-receipts',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        keepalive: true,
      }),
    )
  })

  it('同一注册 instruction token 只消费一次', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ data: META_CONFIG }))
      .mockResolvedValueOnce(response({ accepted: true }))
    const client = createAttributionBrowserClient(dependencies())
    await client.start({ fullPath: '/', path: '/', query: {} }, consent)
    const token = instructionToken({
      ...META_INSTRUCTION,
      canonicalEvent: 'CompleteRegistration',
      eventName: 'CompleteRegistration',
    })

    await client.consumeInstructionToken(token)
    await client.consumeInstructionToken(token)

    expect(execute).toHaveBeenCalledOnce()
  })

  it('重试队列只保留固定字段并淘汰超过 24 小时或 5 次的事件', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const client = createAttributionBrowserClient(dependencies())

    await client.trackContact({
      contactMethodId: 'contact_1',
      methodType: 'telegram',
      actionType: 'copy',
      linkUrl: null,
      value: '@example',
      attributionCapability: 'capability_0123456789',
      pagePath: '/',
    })

    const pending = JSON.parse(
      storage.values().next().value as string,
    ) as Array<Record<string, unknown>>
    expect(Object.keys(pending[0] ?? {}).sort()).toEqual([
      'attemptCount',
      'body',
      'endpoint',
      'eventId',
      'expiresAt',
      'occurredAt',
    ])
    expect(JSON.stringify(pending)).not.toContain('fbclid')
    expect(JSON.stringify(pending)).not.toContain('userAgent')
  })
})
