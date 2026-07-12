import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { loadWranglerResourceConfig, main } from './verify-dev-resources.mjs'

const VALID_WRANGLER_TOML = `
[[d1_databases]]
binding = "DB"
database_name = "meigallery-db"
database_id = "prod-d1-id"

[[r2_buckets]]
binding = "R2"
bucket_name = "meigallery-media"

[[queues.producers]]
binding = "META_CAPI_QUEUE"
queue = "meigallery-meta-capi"

[[queues.consumers]]
queue = "meigallery-meta-capi"
max_retries = 5
retry_delay = 60
dead_letter_queue = "meigallery-meta-capi-dlq"

[[queues.consumers]]
queue = "meigallery-meta-capi-dlq"

[[env.dev.d1_databases]]
binding = "DB"
database_name = "meigallery-db-dev"
database_id = "dev-d1-id"

[[env.dev.r2_buckets]]
binding = "R2"
bucket_name = "meigallery-media-dev"

[[env.dev.queues.producers]]
binding = "META_CAPI_QUEUE"
queue = "meigallery-meta-capi-dev"

[[env.dev.queues.consumers]]
queue = "meigallery-meta-capi-dev"
max_retries = 5
retry_delay = 60
dead_letter_queue = "meigallery-meta-capi-dev-dlq"

[[env.dev.queues.consumers]]
queue = "meigallery-meta-capi-dev-dlq"
`.trim()

describe('开发环境资源校验', () => {
  it('能读取生产和开发环境的 D1/R2/Queue/DLQ 配置', async () => {
    const wranglerPath = await writeTempWranglerToml(VALID_WRANGLER_TOML)

    try {
      const config = await loadWranglerResourceConfig({ wranglerPath })

      assert.deepEqual(config, {
        production: {
          d1: {
            databaseName: 'meigallery-db',
            databaseId: 'prod-d1-id',
          },
          r2: {
            bucketName: 'meigallery-media',
          },
          queue: {
            producerName: 'meigallery-meta-capi',
            mainConsumerName: 'meigallery-meta-capi',
            deadLetterQueueName: 'meigallery-meta-capi-dlq',
            dlqConsumerName: 'meigallery-meta-capi-dlq',
            maxRetries: 5,
            retryDelay: 60,
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
          queue: {
            producerName: 'meigallery-meta-capi-dev',
            mainConsumerName: 'meigallery-meta-capi-dev',
            deadLetterQueueName: 'meigallery-meta-capi-dev-dlq',
            dlqConsumerName: 'meigallery-meta-capi-dev-dlq',
            maxRetries: 5,
            retryDelay: 60,
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

  it('main 会拒绝开发环境复用生产主 Queue 或 DLQ', async () => {
    const sharedMain = VALID_WRANGLER_TOML.replaceAll('meigallery-meta-capi-dev', 'meigallery-meta-capi')
    const wranglerPath = await writeTempWranglerToml(sharedMain)

    try {
      await assert.rejects(async () => {
        await main({ wranglerPath })
      }, /开发主 Queue 不得与生产相同/)
    } finally {
      await rm(path.dirname(wranglerPath), { recursive: true, force: true })
    }

    const sharedDlqPath = await writeTempWranglerToml(VALID_WRANGLER_TOML.replaceAll('meigallery-meta-capi-dev-dlq', 'meigallery-meta-capi-dlq'))
    try {
      await assert.rejects(async () => {
        await main({ wranglerPath: sharedDlqPath })
      }, /开发 DLQ 不得与生产相同/)
    } finally {
      await rm(path.dirname(sharedDlqPath), { recursive: true, force: true })
    }
  })
})

async function writeTempWranglerToml(content) {
  const directory = await mkdtemp(path.join(tmpdir(), 'verify-dev-resources-'))
  const wranglerPath = path.join(directory, 'wrangler.toml')
  await writeFile(wranglerPath, content)
  return wranglerPath
}
