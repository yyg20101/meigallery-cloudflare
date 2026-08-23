import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { loadWranglerResourceConfig, main } from './verify-dev-resources.mjs'

const VALID_WRANGLER_TOML = `
name = "meigallery-api"
routes = [{ pattern = "api.example.com", custom_domain = true }]

[[d1_databases]]
binding = "DB"
database_name = "meigallery-db"
database_id = "prod-d1-id"

[[r2_buckets]]
binding = "R2"
bucket_name = "meigallery-media"

[[queues.producers]]
binding = "AD_META_QUEUE"
queue = "meigallery-ad-meta"

[[queues.consumers]]
queue = "meigallery-ad-meta"
max_retries = 3
retry_delay = 60
dead_letter_queue = "meigallery-ad-meta-dlq"

[[queues.consumers]]
queue = "meigallery-ad-meta-dlq"

[[queues.producers]]
binding = "AD_TIKTOK_QUEUE"
queue = "meigallery-ad-tiktok"

[[queues.consumers]]
queue = "meigallery-ad-tiktok"
max_retries = 3
retry_delay = 60
dead_letter_queue = "meigallery-ad-tiktok-dlq"

[[queues.consumers]]
queue = "meigallery-ad-tiktok-dlq"

[[queues.producers]]
binding = "AD_GOOGLE_QUEUE"
queue = "meigallery-ad-google"

[[queues.consumers]]
queue = "meigallery-ad-google"
max_retries = 3
retry_delay = 60
dead_letter_queue = "meigallery-ad-google-dlq"

[[queues.consumers]]
queue = "meigallery-ad-google-dlq"

${businessQueueToml('', '')}

[[durable_objects.bindings]]
name = "APP_REALTIME_HUB"
class_name = "AppRealtimeHub"

[exports.AppRealtimeHub]
type = "durable-object"
storage = "sqlite"

[[env.dev.d1_databases]]
binding = "DB"
database_name = "meigallery-db-dev"
database_id = "dev-d1-id"

[[env.dev.r2_buckets]]
binding = "R2"
bucket_name = "meigallery-media-dev"

${businessQueueToml('env.dev.', '-dev')}

[[env.dev.durable_objects.bindings]]
name = "APP_REALTIME_HUB"
class_name = "AppRealtimeHub"

`.trim()

describe('开发环境资源校验', () => {
  it('能读取 production 广告平台 Queue 与 dev 通用 D1/R2 配置', async () => {
    const wranglerPath = await writeTempWranglerToml(VALID_WRANGLER_TOML)

    try {
      const config = await loadWranglerResourceConfig({ wranglerPath })

      assert.equal(config.production.workerName, 'meigallery-api')
      assert.equal(config.production.d1.databaseId, 'prod-d1-id')
      assert.equal(config.dev.d1.databaseId, 'dev-d1-id')
      assert.equal(config.production.queues.meta.deadLetterQueueName, 'meigallery-ad-meta-dlq')
      assert.equal(config.production.queues.importZip.producerName, 'meigallery-import-zip')
      assert.equal(config.dev.queues.importZip.producerName, 'meigallery-import-zip-dev')
      assert.equal(config.production.realtimeHub.className, 'AppRealtimeHub')
      assert.deepEqual(config.realtimeExport, { type: 'durable-object', storage: 'sqlite' })
    } finally {
      await rm(path.dirname(wranglerPath), { recursive: true, force: true })
    }
  })

  it('main 会拒绝开发环境复用生产 D1', async () => {
    const wranglerPath = await writeTempWranglerToml(VALID_WRANGLER_TOML.replace('database_id = "dev-d1-id"', 'database_id = "prod-d1-id"'))

    try {
      await assert.rejects(async () => {
        await main({ wranglerPath })
      }, /开发 D1 database_id 不得与生产相同/)
    } finally {
      await rm(path.dirname(wranglerPath), { recursive: true, force: true })
    }
  })

  it('main 会拒绝开发环境复用生产 R2', async () => {
    const wranglerPath = await writeTempWranglerToml(VALID_WRANGLER_TOML.replace('bucket_name = "meigallery-media-dev"', 'bucket_name = "meigallery-media"'))

    try {
      await assert.rejects(async () => {
        await main({ wranglerPath })
      }, /开发 R2 名称必须为 meigallery-media-dev/)
    } finally {
      await rm(path.dirname(wranglerPath), { recursive: true, force: true })
    }
  })

  it('main 会拒绝业务 Queue 或 SQLite Durable Object 契约漂移', async () => {
    const invalidConfigs = [
      [VALID_WRANGLER_TOML.replace('max_concurrency = 1', 'max_concurrency = 2'), /必须保持有界单并发/u],
      [VALID_WRANGLER_TOML.replace('storage = "sqlite"', 'storage = "durable-object"'), /必须使用声明式 SQLite export/u],
      [
        VALID_WRANGLER_TOML.replace(
          '[[env.dev.durable_objects.bindings]]\nname = "APP_REALTIME_HUB"\nclass_name = "AppRealtimeHub"',
          '[[env.dev.durable_objects.bindings]]\nname = "APP_REALTIME_HUB"\nclass_name = "WrongHub"',
        ),
        /dev 实时 Durable Object class 不正确/u,
      ],
    ]

    for (const [source, expectedError] of invalidConfigs) {
      const wranglerPath = await writeTempWranglerToml(source)
      try {
        await assert.rejects(main({ wranglerPath }), expectedError)
      } finally {
        await rm(path.dirname(wranglerPath), { recursive: true, force: true })
      }
    }
  })

})

async function writeTempWranglerToml(content) {
  const directory = await mkdtemp(path.join(tmpdir(), 'verify-dev-resources-'))
  const wranglerPath = path.join(directory, 'wrangler.toml')
  await writeFile(wranglerPath, content)
  return wranglerPath
}

function businessQueueToml(prefix, suffix) {
  const queues = [
    ['IMPORT_QUEUE', 'meigallery-import-zip', 3, 15],
    ['DATA_RIGHTS_EXPORT_QUEUE', 'meigallery-app-data-rights-export', 5, 15],
    ['DATA_RIGHTS_DELETION_QUEUE', 'meigallery-app-data-rights-deletion', 5, 15],
    ['TELEGRAM_IMPORT_QUEUE', 'meigallery-import-telegram', 5, 60],
  ]
  return queues.map(([binding, baseName, retries, retryDelay]) => {
    const queue = `${baseName}${suffix}`
    return `[[${prefix}queues.producers]]
binding = "${binding}"
queue = "${queue}"

[[${prefix}queues.consumers]]
queue = "${queue}"
max_batch_size = 1
max_batch_timeout = 5
max_retries = ${retries}
retry_delay = ${retryDelay}
max_concurrency = 1
dead_letter_queue = "${queue}-dlq"`
  }).join('\n\n')
}
