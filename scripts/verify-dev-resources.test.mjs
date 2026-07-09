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

[[env.dev.d1_databases]]
binding = "DB"
database_name = "meigallery-db-dev"
database_id = "dev-d1-id"

[[env.dev.r2_buckets]]
binding = "R2"
bucket_name = "meigallery-media-dev"
`.trim()

describe('开发环境资源校验', () => {
  it('能读取生产和开发环境的 D1/R2 配置', async () => {
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
