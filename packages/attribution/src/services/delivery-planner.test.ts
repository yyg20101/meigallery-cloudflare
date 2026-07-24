import { describe, expect, it } from 'vitest'
import type { AttributionRuntimePolicy } from '../domain/connection'
import {
  planDeliveries,
  type DeliveryPlanInput,
} from './delivery-planner'

describe('归因投递 Planner', () => {
  it('同一事实只为已解析的单一 Meta 连接建立 Browser/Server 配对', async () => {
    const deliveries = await planDeliveries(input())

    expect(deliveries).toEqual([
      {
        provider: 'meta',
        transport: 'browser',
        destination: 'meta_browser',
      },
      {
        provider: 'meta',
        transport: 'server',
        destination: 'meta_server',
      },
    ])
    expect(deliveries.some(item => item.provider === 'tiktok')).toBe(false)
    expect(deliveries.some(item => item.provider === 'google')).toBe(false)
  })

  it('运行策略、熔断和事件绑定共同限制投递面', async () => {
    expect(await planDeliveries(input({
      runtimePolicy: policy({
        serverEffectivePercentage: 0,
      }),
    }))).toEqual([
      {
        provider: 'meta',
        transport: 'browser',
        destination: 'meta_browser',
      },
    ])

    expect(await planDeliveries(input({
      runtimePolicy: policy({
        circuitState: 'server_open',
      }),
    }))).toHaveLength(1)

    expect(await planDeliveries(input({
      binding: {
        enabled: false,
        browserDestination: 'meta_browser',
        serverDestination: 'meta_server',
      },
    }))).toEqual([])
  })

  it('拒绝广告用户数据时保留 Browser 且不规划 Server', async () => {
    expect(await planDeliveries(input({
      serverDataAllowed: false,
    }))).toEqual([
      {
        provider: 'meta',
        transport: 'browser',
        destination: 'meta_browser',
      },
    ])
  })

  it('稳定分桶对同一 external event id 始终返回同一计划', async () => {
    const first = await planDeliveries(input({
      runtimePolicy: policy({
        serverEffectivePercentage: 10,
      }),
    }))
    const second = await planDeliveries(input({
      runtimePolicy: policy({
        serverEffectivePercentage: 10,
      }),
    }))

    expect(second).toEqual(first)
  })
})

function input(
  overrides: Partial<DeliveryPlanInput> = {},
): DeliveryPlanInput {
  return {
    factId: 'fact_01',
    externalEventId: 'attr1_stable_external_event',
    connectionId: 'conn_meta',
    versionId: 'ver_meta',
    provider: 'meta',
    eventName: 'Contact',
    serverDataAllowed: true,
    runtimePolicy: policy(),
    binding: {
      enabled: true,
      browserDestination: 'meta_browser',
      serverDestination: 'meta_server',
    },
    ...overrides,
  }
}

function policy(
  overrides: Partial<AttributionRuntimePolicy> = {},
): AttributionRuntimePolicy {
  return {
    enabled: true,
    browserEnabled: true,
    serverEnabled: true,
    serverTargetPercentage: 100,
    serverEffectivePercentage: 100,
    circuitState: 'closed',
    runtimeGeneration: 1,
    updatedBy: 1,
    updatedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  }
}
