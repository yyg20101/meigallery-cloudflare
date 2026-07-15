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

[[env.dev.d1_databases]]
binding = "DB"
database_name = "meigallery-db-dev"
database_id = "dev-d1-id"

[[env.dev.r2_buckets]]
binding = "R2"
bucket_name = "meigallery-media-dev"

`.trim()

describe('开发环境资源校验', () => {
  it('能读取 production 广告平台 Queue 与 dev 通用 D1/R2 配置', async () => {
    const wranglerPath = await writeTempWranglerToml(VALID_WRANGLER_TOML)

    try {
      const config = await loadWranglerResourceConfig({ wranglerPath })

      assert.deepEqual(config, {
        production: {
          workerName: 'meigallery-api',
          apiOrigin: 'https://api.example.com',
          d1: {
            databaseName: 'meigallery-db',
            databaseId: 'prod-d1-id',
          },
          r2: {
            bucketName: 'meigallery-media',
          },
          queues: {
            meta: {
              producerName: 'meigallery-ad-meta',
              mainConsumerName: 'meigallery-ad-meta',
              deadLetterQueueName: 'meigallery-ad-meta-dlq',
              dlqConsumerName: 'meigallery-ad-meta-dlq',
              maxRetries: 3,
              retryDelay: 60,
            },
            tiktok: {
              producerName: 'meigallery-ad-tiktok',
              mainConsumerName: 'meigallery-ad-tiktok',
              deadLetterQueueName: 'meigallery-ad-tiktok-dlq',
              dlqConsumerName: 'meigallery-ad-tiktok-dlq',
              maxRetries: 3,
              retryDelay: 60,
            },
            google: {
              producerName: 'meigallery-ad-google',
              mainConsumerName: 'meigallery-ad-google',
              deadLetterQueueName: 'meigallery-ad-google-dlq',
              dlqConsumerName: 'meigallery-ad-google-dlq',
              maxRetries: 3,
              retryDelay: 60,
            },
          },
        },
        dev: {
          d1: {
            databaseName: 'meigallery-db-dev',
            databaseId: 'dev-d1-id',
          },
          r2: {
            bucketName: 'meigallery-media-dev',
          },
        },
      })
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

})

async function writeTempWranglerToml(content) {
  const directory = await mkdtemp(path.join(tmpdir(), 'verify-dev-resources-'))
  const wranglerPath = path.join(directory, 'wrangler.toml')
  await writeFile(wranglerPath, content)
  return wranglerPath
}
