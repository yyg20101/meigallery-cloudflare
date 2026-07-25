import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildResourcePlan,
  parseD1List,
  parseQueueList,
  provisionAttributionResources,
  updateAttributionDatabaseIds,
} from './provision-attribution-resources.mjs'

test('资源计划只管理独立归因的 2 个 D1 与 6 个生产 Queue', () => {
  const plan = buildResourcePlan()

  assert.deepEqual(plan.d1.map((item) => item.name), [
    'meigallery-attribution-db',
    'meigallery-attribution-db-dev',
  ])
  assert.deepEqual(plan.queues.map((item) => item.name), [
    'meigallery-attribution-meta',
    'meigallery-attribution-meta-dlq',
    'meigallery-attribution-tiktok',
    'meigallery-attribution-tiktok-dlq',
    'meigallery-attribution-google',
    'meigallery-attribution-google-dlq',
  ])
  assert.ok(plan.d1.every((item) => item.name !== 'meigallery-db'))
  assert.ok(plan.queues.every((item) => !item.name.startsWith('meigallery-ad-')))
})

test('D1 JSON 解析仅保留可验证的名称与非敏感 ID', () => {
  const databases = parseD1List(JSON.stringify([
    { name: 'meigallery-attribution-db', uuid: 'prod-id' },
    { name: 'meigallery-attribution-db-dev', id: 'dev-id' },
    { name: '', uuid: 'ignored' },
  ]))

  assert.deepEqual(databases, [
    { name: 'meigallery-attribution-db', id: 'prod-id' },
    { name: 'meigallery-attribution-db-dev', id: 'dev-id' },
  ])
})

test('Queue 表格解析兼容 Wrangler 列表输出且忽略提示信息', () => {
  const queues = parseQueueList(`
 ⛅️ wrangler 4.110.0
───────────────────
┌────────────────────────────────────────┬──────────────────────────────┐
│ name                                   │ id                           │
├────────────────────────────────────────┼──────────────────────────────┤
│ meigallery-attribution-meta            │ queue-meta-id                │
├────────────────────────────────────────┼──────────────────────────────┤
│ meigallery-attribution-meta-dlq        │ queue-meta-dlq-id            │
└────────────────────────────────────────┴──────────────────────────────┘
`)

  assert.deepEqual(queues, [
    { name: 'meigallery-attribution-meta', id: 'queue-meta-id' },
    { name: 'meigallery-attribution-meta-dlq', id: 'queue-meta-dlq-id' },
  ])
})

test('只更新独立归因 production/dev D1 的 database_id', () => {
  const source = `
[[d1_databases]]
binding = "DB"
database_name = "meigallery-attribution-db"
database_id = "00000000-0000-0000-0000-000000000000"

[env.dev]

[[env.dev.d1_databases]]
binding = "DB"
database_name = "meigallery-attribution-db-dev"
database_id = "00000000-0000-0000-0000-000000000000"

# 旧 API 配置文本即使出现也不能被修改
database_name = "meigallery-db"
database_id = "legacy-api-id"
`

  const updated = updateAttributionDatabaseIds(source, new Map([
    ['meigallery-attribution-db', 'production-id'],
    ['meigallery-attribution-db-dev', 'development-id'],
  ]))

  assert.match(
    updated,
    /database_name = "meigallery-attribution-db"\ndatabase_id = "production-id"/,
  )
  assert.match(
    updated,
    /database_name = "meigallery-attribution-db-dev"\ndatabase_id = "development-id"/,
  )
  assert.match(
    updated,
    /database_name = "meigallery-db"\ndatabase_id = "legacy-api-id"/,
  )
})

test('D1 配置缺失、重复或 ID 不合法时拒绝写入', () => {
  const validIds = new Map([
    ['meigallery-attribution-db', 'production-id'],
    ['meigallery-attribution-db-dev', 'development-id'],
  ])

  assert.throws(
    () => updateAttributionDatabaseIds('', validIds),
    /ATTRIBUTION_D1_CONFIG_NOT_FOUND/,
  )
  assert.throws(
    () => updateAttributionDatabaseIds(`
database_name = "meigallery-attribution-db"
database_id = "old"
database_name = "meigallery-attribution-db"
database_id = "old-again"
database_name = "meigallery-attribution-db-dev"
database_id = "old-dev"
`, validIds),
    /ATTRIBUTION_D1_CONFIG_DUPLICATED/,
  )
  assert.throws(
    () => updateAttributionDatabaseIds(`
database_name = "meigallery-attribution-db"
database_id = "old"
database_name = "meigallery-attribution-db-dev"
database_id = "old-dev"
`, new Map([
      ['meigallery-attribution-db', ''],
      ['meigallery-attribution-db-dev', 'development-id'],
    ])),
    /ATTRIBUTION_D1_ID_INVALID/,
  )
})

test('dry-run 只读远端列表，不创建资源或写配置', async () => {
  const calls = []
  let configWritten = false

  const result = await provisionAttributionResources({
    apply: false,
    runWrangler: async (args) => {
      calls.push(args)
      if (args[0] === 'd1') {
        return '[]'
      }
      return `
┌────┬──────┐
│ id │ name │
├────┼──────┤
└────┴──────┘
`
    },
    readConfig: async () => {
      throw new Error('dry-run 不应读取配置')
    },
    writeConfig: async () => {
      configWritten = true
    },
    log: () => {},
  })

  assert.equal(result.applied, false)
  assert.deepEqual(calls, [
    ['d1', 'list', '--json'],
    ['queues', 'list'],
  ])
  assert.equal(configWritten, false)
})
