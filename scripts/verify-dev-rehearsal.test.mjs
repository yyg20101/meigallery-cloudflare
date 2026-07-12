import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { runDevRehearsalVerification } from './verify-dev-rehearsal.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'

describe('开发环境发布预演边界', () => {
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
  })
})
