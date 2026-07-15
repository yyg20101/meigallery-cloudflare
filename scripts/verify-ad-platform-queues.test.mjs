import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  main,
  REQUIRED_PRODUCTION_AD_QUEUES,
  verifyAdPlatformQueues,
  verifyWranglerAdPlatformConfig,
} from './verify-ad-platform-queues.mjs'
import { readFileSync } from 'node:fs'

describe('生产广告平台 Queue 前置检查', () => {
  it('静态验证生产 3 producer、6 consumer、主 Queue 三次重试与 DLQ、15 分钟 Cron，且 dev 资源为空', () => {
    const source = readFileSync(new URL('../packages/api/wrangler.toml', import.meta.url), 'utf8')
    assert.deepEqual(verifyWranglerAdPlatformConfig(source), {
      producers: 3,
      consumers: 6,
      productionCron: '*/15 * * * *',
      devQueuesEmpty: true,
      devCronsEmpty: true,
    })
  })

  it('静态配置偏离 retry、DLQ 或 dev 隔离时阻断', () => {
    const source = readFileSync(new URL('../packages/api/wrangler.toml', import.meta.url), 'utf8')
    assert.throws(() => verifyWranglerAdPlatformConfig(source.replace('max_retries = 3', 'max_retries = 4')), /AD_PLATFORM_WRANGLER_CONFIG_INVALID/)
    assert.throws(() => verifyWranglerAdPlatformConfig(source.replace('dead_letter_queue = "meigallery-ad-meta-dlq"', 'dead_letter_queue = "wrong-dlq"')), /AD_PLATFORM_WRANGLER_CONFIG_INVALID/)
    assert.throws(() => verifyWranglerAdPlatformConfig(source.replace('[env.dev.triggers]\ncrons = []', '[env.dev.triggers]\ncrons = ["*/15 * * * *"]')), /AD_PLATFORM_WRANGLER_CONFIG_INVALID/)
  })

  it('按固定顺序检查三平台的主 Queue 和 DLQ', async () => {
    const inspected = []
    const report = await verifyAdPlatformQueues({
      environment: 'production',
      inspectQueue: async queue => inspected.push(queue),
    })

    assert.deepEqual(inspected, [...REQUIRED_PRODUCTION_AD_QUEUES])
    assert.deepEqual(report, { status: 'passed', inspected: 6, required: 6 })
  })

  it('任一 Queue 缺失时立即停止，不继续检查后续资源', async () => {
    const inspected = []
    const report = await verifyAdPlatformQueues({
      environment: 'production',
      inspectQueue: async queue => {
        inspected.push(queue)
        if (queue === 'meigallery-ad-tiktok') throw new Error('private provider response')
      },
    })

    assert.deepEqual(inspected, REQUIRED_PRODUCTION_AD_QUEUES.slice(0, 3))
    assert.deepEqual(report, {
      status: 'failed',
      inspected: 2,
      required: 6,
      missing: 'meigallery-ad-tiktok',
    })
  })

  it('拒绝对 dev 执行 production Queue 检查', async () => {
    await assert.rejects(
      verifyAdPlatformQueues({ environment: 'dev', inspectQueue: async () => {} }),
      /AD_PLATFORM_QUEUE_ENV_INVALID/,
    )
  })

  it('CLI 失败输出保持稳定且不回显底层错误', async () => {
    let output = ''
    const report = await main({
      environment: 'production',
      inspectQueue: async () => { throw new Error('private queue provider response') },
      stdout: { write: value => { output += value } },
    })

    assert.equal(report.status, 'failed')
    assert.equal(output, 'AD_PLATFORM_QUEUE_PREFLIGHT_FAILED inspected=0 required=6\n')
    assert.doesNotMatch(output, /private|provider response/)
  })
})
