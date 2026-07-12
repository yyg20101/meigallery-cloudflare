import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { getMetaCapiKeyRotationStatus } from './meta-capi-key-rotation'

const CURRENT_KEY = Buffer.alloc(32, 11).toString('base64')
const PREVIOUS_KEY = Buffer.alloc(32, 22).toString('base64')

describe('Meta CAPI data key 轮换状态', () => {
  it('无 previous 时只报告 current 有效且不可移除', async () => {
    const db = queryDb(() => {
      throw new Error('无 previous 不应查询引用')
    })

    await expect(getMetaCapiKeyRotationStatus({
      DB: db,
      META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY,
    })).resolves.toEqual({
      currentKeyValid: true,
      previousKeyConfigured: false,
      previousKeyValid: false,
      previousSameAsCurrent: false,
      previousOutboxCount: 0,
      previousActiveDeliveryCount: 0,
      canRemovePrevious: false,
    })
  })

  it('previous 与 current 相同时不误算 current 活跃引用并可移除冗余配置', async () => {
    const db = queryDb(() => {
      throw new Error('same key 不应查询引用')
    })
    const status = await getMetaCapiKeyRotationStatus({
      DB: db,
      META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY,
      META_CAPI_DATA_KEY_PREVIOUS: CURRENT_KEY,
    })

    expect(status).toMatchObject({
      currentKeyValid: true,
      previousKeyConfigured: true,
      previousKeyValid: true,
      previousSameAsCurrent: true,
      previousOutboxCount: 0,
      previousActiveDeliveryCount: 0,
      canRemovePrevious: true,
    })
  })

  it('不同 previous 统计全部 outbox 和 pending/failed delivery', async () => {
    const sqlCalls: Array<{ sql: string; params: unknown[] }> = []
    const db = queryDb((sql, params) => {
      sqlCalls.push({ sql, params })
      if (sql.includes('meta_capi_secure_outbox')) return { reference_count: 3 }
      if (sql.includes('analytics_conversion_deliveries')) return { reference_count: 2 }
      throw new Error('未知查询')
    })
    const status = await getMetaCapiKeyRotationStatus({
      DB: db,
      META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY,
      META_CAPI_DATA_KEY_PREVIOUS: PREVIOUS_KEY,
    })

    expect(status).toMatchObject({
      currentKeyValid: true,
      previousKeyConfigured: true,
      previousKeyValid: true,
      previousSameAsCurrent: false,
      previousOutboxCount: 3,
      previousActiveDeliveryCount: 2,
      canRemovePrevious: false,
    })
    expect(sqlCalls[0]?.sql).toContain('FROM meta_capi_secure_outbox')
    expect(sqlCalls[0]?.sql).not.toContain('expires_at')
    expect(sqlCalls[1]?.sql).toContain("status IN ('pending', 'failed')")
    expect(sqlCalls.every(call => call.params.length === 1)).toBe(true)
    expect(sqlCalls[0]?.params).toEqual(sqlCalls[1]?.params)
    expect(sqlCalls[0]?.params[0]).toMatch(/^[0-9a-f]{16}$/)
  })

  it('不同 previous 仅在两个引用计数均为零时可移除', async () => {
    const db = queryDb(() => ({ reference_count: 0 }))
    const status = await getMetaCapiKeyRotationStatus({
      DB: db,
      META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY,
      META_CAPI_DATA_KEY_PREVIOUS: PREVIOUS_KEY,
    })

    expect(status.canRemovePrevious).toBe(true)
  })

  it.each([
    ['current 无效', 'not-base64', PREVIOUS_KEY],
    ['previous 无效', CURRENT_KEY, 'not-base64'],
  ])('%s 时 fail closed 且不抛出错误', async (_label, current, previous) => {
    const status = await getMetaCapiKeyRotationStatus({
      DB: queryDb(() => ({ reference_count: 0 })),
      META_CAPI_DATA_KEY_CURRENT: current,
      META_CAPI_DATA_KEY_PREVIOUS: previous,
    })

    expect(status.canRemovePrevious).toBe(false)
  })

  it('任一引用查询失败时 fail closed，且响应不包含错误 cause 或密钥派生值', async () => {
    const status = await getMetaCapiKeyRotationStatus({
      DB: queryDb((sql) => {
        if (sql.includes('meta_capi_secure_outbox')) return { reference_count: 0 }
        throw new Error(`query failed with ${PREVIOUS_KEY}`)
      }),
      META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY,
      META_CAPI_DATA_KEY_PREVIOUS: PREVIOUS_KEY,
    })
    const serialized = JSON.stringify(status)

    expect(status.canRemovePrevious).toBe(false)
    expect(Object.keys(status).sort()).toEqual([
      'canRemovePrevious',
      'currentKeyValid',
      'previousActiveDeliveryCount',
      'previousKeyConfigured',
      'previousKeyValid',
      'previousOutboxCount',
      'previousSameAsCurrent',
    ])
    expect(serialized).not.toContain(CURRENT_KEY)
    expect(serialized).not.toContain(PREVIOUS_KEY)
    expect(serialized).not.toContain('query failed')
    expect(serialized).not.toMatch(/[0-9a-f]{16}/)
  })
})

function queryDb(resolver: (sql: string, params: unknown[]) => Record<string, unknown>) {
  return {
    prepare(sql: string) {
      let params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params = values
          return this
        },
        async first<T>() {
          return resolver(sql, params) as T
        },
      }
    },
  } as unknown as D1Database
}
