import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type {
  AttributionAdminClient,
  AttributionConnectionView,
  CreateCandidateRequest,
} from '~/types/attribution-admin'
import {
  attributionReadModelDateQuery,
  attributionRangeQuery,
  attributionRouteQuery,
  normalizeAttributionRangePreset,
  useAttributionCandidate,
  useAttributionConnections,
  useAttributionManagedSources,
  useAttributionQuality,
  useAttributionRuntimePolicy,
} from './useAdminAttribution'

describe('useAdminAttribution', () => {
  it('单日查询转换为 from/to', () => {
    expect(attributionRangeQuery('day', '2026-07-09')).toEqual({ from: '2026-07-09', to: '2026-07-09' })
  })

  it('单日路由查询保留 range 和 date', () => {
    expect(attributionRouteQuery('day', '2026-07-09')).toEqual({ range: 'day', date: '2026-07-09' })
  })

  it('从路由查询识别归因范围', () => {
    expect(normalizeAttributionRangePreset('day')).toBe('day')
    expect(normalizeAttributionRangePreset('90d')).toBe('90d')
    expect(normalizeAttributionRangePreset('unknown')).toBe('7d')
  })

  it('单日读模型查询只包含同一个北京时间自然日', () => {
    expect(
      attributionReadModelDateQuery(
        'day',
        '2026-07-09',
        new Date('2026-07-24T01:00:00.000Z'),
      ),
    ).toEqual({
      dateFrom: '2026-07-09',
      dateTo: '2026-07-09',
    })
  })
})

describe('归因控制面 composable', () => {
  it('候选连接加载完成前禁止保存，不会提交空默认值', async () => {
    const pending = deferred<{ data: AttributionConnectionView }>()
    const client = mockClient()
    client.request.mockReturnValueOnce(pending.promise)
    const state = useAttributionCandidate(client)
    const loading = state.load('conn_meta_a')

    expect(state.canSave.value).toBe(false)
    await expect(
      state.saveCandidate('conn_meta_a', candidateRequest()),
    ).rejects.toThrow('ATTRIBUTION_FORM_NOT_READY')
    expect(client.request).toHaveBeenCalledOnce()

    pending.resolve({ data: connectionFixture() })
    await loading
    await nextTick()

    expect(state.canSave.value).toBe(true)
    expect(state.connection.value?.activeTarget).toBe('1234567890123456')
  })

  it('重复点击候选保存复用同一个 Promise 和幂等键', async () => {
    const client = mockClient()
    client.request.mockResolvedValueOnce({ data: connectionFixture() })
    const state = useAttributionCandidate(client)
    await state.load('conn_meta_a')

    const pending = deferred<{ data: AttributionConnectionView }>()
    client.request.mockReturnValueOnce(pending.promise)
    const first = state.saveCandidate(
      'conn_meta_a',
      candidateRequest(),
    )
    const second = state.saveCandidate(
      'conn_meta_a',
      candidateRequest(),
    )

    expect(second).toBe(first)
    expect(client.request).toHaveBeenCalledTimes(2)
    expect(client.request).toHaveBeenLastCalledWith(
      '/api/admin/attribution-runtime/connections/conn_meta_a/candidates',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Idempotency-Key': '00000000-0000-4000-8000-000000000001',
        },
      }),
    )

    pending.resolve({
      data: connectionFixture({
        candidate: {
          state: 'validating',
          createdAt: '2026-07-24T09:30:00.000Z',
          failureCode: '',
          productionContinues: true,
        },
      }),
    })
    await first
    expect(state.saving.value).toBe(false)
  })

  it('运行策略使用独立写命令且不会写入候选配置', async () => {
    const client = mockClient()
    const state = useAttributionRuntimePolicy(client)
    state.initialize(connectionFixture())
    client.request.mockResolvedValueOnce({
      data: connectionFixture({
        runtime: {
          enabled: true,
          browserEnabled: true,
          serverEnabled: true,
          serverTargetPercentage: 50,
          serverEffectivePercentage: 50,
          circuitState: 'closed',
        },
      }),
    })

    await state.saveRuntimePolicy('conn_meta_a', {
      enabled: true,
      browserEnabled: true,
      serverEnabled: true,
      serverTargetPercentage: 50,
    })

    expect(client.request).toHaveBeenCalledWith(
      '/api/admin/attribution-runtime/connections/conn_meta_a/runtime-policy',
      {
        method: 'PATCH',
        headers: {
          'Idempotency-Key': '00000000-0000-4000-8000-000000000001',
        },
        body: {
          enabled: true,
          browserEnabled: true,
          serverEnabled: true,
          serverTargetPercentage: 50,
        },
      },
    )
  })

  it('连接和质量读取只访问新的归因控制面', async () => {
    const client = mockClient()
    client.request
      .mockResolvedValueOnce({ data: [connectionFixture()] })
      .mockResolvedValueOnce({ data: [] })
    const connections = useAttributionConnections(client, {
      autoLoad: false,
    })
    const quality = useAttributionQuality(client)

    await connections.refresh()
    await quality.refresh({
      dateFrom: '2026-07-23',
      dateTo: '2026-07-24',
      provider: 'meta',
      connectionId: 'conn_meta_a',
    })

    expect(client.request.mock.calls.map(call => call[0])).toEqual([
      '/api/admin/attribution-runtime/connections',
      '/api/admin/attribution-runtime/quality',
    ])
    expect(connections.initialized.value).toBe(true)
    expect(quality.rows.value).toEqual([])
  })

  it('管理投放来源只在创建响应中交付一次性凭证', async () => {
    const client = mockClient()
    client.request.mockResolvedValueOnce({
      data: { connectionId: 'conn_meta_a', sources: [] },
    })
    const state = useAttributionManagedSources(client)
    await state.load('conn_meta_a')

    const pending = deferred<{
      data: {
        source: {
          id: string
          provider: 'meta'
          connectionId: string
          campaign: string
          medium: string
          content: string
          expiresAt: null
          enabled: true
          createdAt: string
        }
        proof: string
        proofDelivery: 'issued_once'
        replayed: false
      }
    }>()
    client.request.mockReturnValueOnce(pending.promise)
    const input = {
      campaign: 'us_bj',
      medium: 'paid_social',
      content: 'creative_a',
    }
    const first = state.create('conn_meta_a', input)
    const second = state.create('conn_meta_a', input)
    expect(second).toBe(first)

    pending.resolve({
      data: {
        source: {
          id: 'source_meta_a',
          provider: 'meta',
          connectionId: 'conn_meta_a',
          campaign: input.campaign,
          medium: input.medium,
          content: input.content,
          expiresAt: null,
          enabled: true,
          createdAt: '2026-07-24T10:00:00.000Z',
        },
        proof: 'proof_issued_once',
        proofDelivery: 'issued_once',
        replayed: false,
      },
    })

    const created = await first
    expect(created.proof).toBe('proof_issued_once')
    expect(JSON.stringify(state.sources.value)).not.toContain('proof')
    expect(client.request).toHaveBeenLastCalledWith(
      '/api/admin/attribution-runtime/connections/conn_meta_a/sources',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Idempotency-Key': '00000000-0000-4000-8000-000000000001',
        },
      }),
    )
  })
})

function mockClient(): AttributionAdminClient & {
  request: ReturnType<typeof vi.fn>
} {
  let id = 0
  return {
    request: vi.fn(),
    createIdempotencyKey: () => {
      id += 1
      return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`
    },
  } as unknown as AttributionAdminClient & {
    request: ReturnType<typeof vi.fn>
  }
}

function connectionFixture(
  override: Partial<AttributionConnectionView> = {},
): AttributionConnectionView {
  return {
    id: 'conn_meta_a',
    provider: 'meta',
    name: '美国 BJ 团队',
    isDefault: true,
    state: 'active',
    activeTarget: '1234567890123456',
    candidate: null,
    runtime: {
      enabled: true,
      browserEnabled: true,
      serverEnabled: true,
      serverTargetPercentage: 10,
      serverEffectivePercentage: 10,
      circuitState: 'closed',
    },
    health: {
      level: 'healthy',
      lastDeliveryAt: '2026-07-24T09:00:00.000Z',
    },
    ...override,
  }
}

function candidateRequest(): CreateCandidateRequest {
  return {
    publicConfig: { pixelId: '1234567890123456' },
    credential: {
      type: 'access_token',
      plaintext: 'secret-value',
    },
    eventBindings: [
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
    testEventCode: 'TEST12345',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
