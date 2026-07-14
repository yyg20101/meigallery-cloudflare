import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  main,
  REQUIRED_PRODUCTION_AD_QUEUES,
  verifyAdPlatformQueues,
} from './verify-ad-platform-queues.mjs'

describe('生产广告平台 Queue 前置检查', () => {
  it('按固定顺序检查 Meta 与 TikTok 的主 Queue 和 DLQ', async () => {
    const inspected = []
    const report = await verifyAdPlatformQueues({
      environment: 'production',
      inspectQueue: async queue => inspected.push(queue),
    })

    assert.deepEqual(inspected, [...REQUIRED_PRODUCTION_AD_QUEUES])
    assert.deepEqual(report, { status: 'passed', inspected: 4, required: 4 })
  })

  it('任一 Queue 缺失时立即停止，不继续检查后续资源', async () => {
    const inspected = []
    const report = await verifyAdPlatformQueues({
      environment: 'production',
      inspectQueue: async queue => {
        inspected.push(queue)
        if (queue === 'meigallery-tiktok-events') throw new Error('private provider response')
      },
    })

    assert.deepEqual(inspected, REQUIRED_PRODUCTION_AD_QUEUES.slice(0, 3))
    assert.deepEqual(report, {
      status: 'failed',
      inspected: 2,
      required: 4,
      missing: 'meigallery-tiktok-events',
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
    assert.equal(output, 'AD_PLATFORM_QUEUE_PREFLIGHT_FAILED inspected=0 required=4\n')
    assert.doesNotMatch(output, /private|provider response/)
  })
})
