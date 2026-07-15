import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { requestJsonStepWithRetry, runDevRehearsalVerification, toShanghaiOperationDate } from './verify-dev-rehearsal.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'

describe('开发环境发布预演边界', () => {
  it('后台查询日期始终使用 Asia/Shanghai 自然日', () => {
    assert.equal(toShanghaiOperationDate('2026-07-15T15:59:59.999Z'), '2026-07-15')
    assert.equal(toShanghaiOperationDate('2026-07-15T16:00:00.000Z'), '2026-07-16')
    assert.throws(() => toShanghaiOperationDate('invalid-date'), /日期无效/)
  })

  it('缺少 dev Web/API 地址时直接拒绝执行', async () => {
    await assert.rejects(
      runDevRehearsalVerification({ env: {}, releaseCommit: COMMIT }),
      /VERIFY_DEV_API_URL/,
    )
  })

  it('dev rehearsal 不调用 Meta 管理接口或等待 CAPI sent', async () => {
    const source = await readFile(new URL('./verify-dev-rehearsal.mjs', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /api\/admin\/attribution\/meta/)
    assert.doesNotMatch(source, /pollMetaDeliveries|readMetaDeliveryBaseline|META_POLL/)
    assert.match(source, /dev-meta-delivery-deferred-to-production/)
    assert.match(source, /requirePixelEvent: false/)
  })

  it('仍保留 dev migration、部署、站内转化与注册逻辑验证', async () => {
    const source = await readFile(new URL('./verify-dev-rehearsal.mjs', import.meta.url), 'utf8')
    assert.match(source, /verify-meta-migration\.mjs', 'preflight', '--env', 'dev'/)
    assert.match(source, /wrangler', 'deploy', '--env', 'dev'/)
    assert.match(source, /postConversion/)
    assert.match(source, /postRegistration/)
    assert.match(source, /dev-admin-attribution/)
    assert.match(source, /api\/marketing-consent/)
    assert.match(source, /api\/ad-attribution/)
    assert.match(source, /adAttributionState: 'resolved'/)
    assert.match(source, /conversions\?provider=meta&from=/)
  })

  it('部署身份传播期间轮询到新 commit 后通过', async () => {
    let calls = 0
    const step = await requestJsonStepWithRetry(
      async () => {
        calls += 1
        return new Response(JSON.stringify({ commit: calls === 1 ? 'old' : COMMIT }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
      'dev-api-health',
      'https://dev.example.test/api/health',
      {},
      (body) => {
        if (body.commit !== COMMIT) throw new Error('commit 尚未传播')
        return 'commit 已传播'
      },
      { maxAttempts: 3, retryDelayMs: 0, sleep: async () => {} },
    )

    assert.equal(step.status, 'passed')
    assert.equal(calls, 2)
    assert.match(step.summary, /传播检查 2\/3/)
  })

  it('部署身份超过轮询上限后仍保持失败', async () => {
    let calls = 0
    const step = await requestJsonStepWithRetry(
      async () => {
        calls += 1
        return new Response(JSON.stringify({ commit: 'old' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
      'dev-web-release',
      'https://dev.example.test/__release',
      {},
      () => {
        throw new Error('commit 尚未传播')
      },
      { maxAttempts: 3, retryDelayMs: 0, sleep: async () => {} },
    )

    assert.equal(step.status, 'failed')
    assert.equal(calls, 3)
    assert.match(step.summary, /连续 3 次检查仍未传播/)
  })
})
