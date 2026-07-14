import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  hasNoPendingMigrations,
  hasVerifiedMetaConnection,
  main,
  requestLiveResourceAttestations,
  resolveFullSecretIsolation,
  runMetaResourceVerification,
  validateProductionAttestation,
} from './verify-meta-resources.mjs'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'
const NOW = '2026-07-11T00:00:00.000Z'
const NONCE = `nonce_${'a'.repeat(64)}`
const IDENTITIES = {
  pixel: `hmac-sha256:${'1'.repeat(64)}`,
  token: `hmac-sha256:${'2'.repeat(64)}`,
  testEventCode: `hmac-sha256:${'3'.repeat(64)}`,
  dataKey: `hmac-sha256:${'4'.repeat(64)}`,
}

describe('Meta production 资源检查', () => {
  it('默认使用 production，并拒绝 dev 远端验证', async () => {
    await assert.rejects(
      runMetaResourceVerification({ environment: 'dev' }),
      /仅支持 production/,
    )
    await assert.rejects(
      main(['--env', 'dev'], { runCommand: async () => ({ status: 'failed' }) }),
      /仅支持 production|用法/,
    )
  })

  it('production attestation 校验当前 commit、TTL 和全部摘要', () => {
    assert.deepEqual(validateProductionAttestation({
      schemaVersion: 1,
      environment: 'production',
      commitSha: COMMIT,
      nonce: NONCE,
      issuedAt: NOW,
      expiresAt: '2026-07-11T00:05:00.000Z',
      identities: IDENTITIES,
    }, { commit: COMMIT, nonce: NONCE, now: NOW }), {
      pixel: true,
      token: true,
      testEventCode: true,
      dataKey: true,
    })
  })

  it('attestation 只访问 production origin，最终请求不携带 Cookie', async () => {
    const calls = []
    const origin = 'https://production.example'
    const fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/resource-attestation-ticket')) {
        return responseAt(url, { data: {
          schemaVersion: 1,
          environment: 'production',
          commitSha: COMMIT,
          nonce: NONCE,
          ticket: `mrat_${'b'.repeat(64)}`,
          issuedAt: NOW,
          expiresAt: '2026-07-11T00:01:00.000Z',
        } })
      }
      return responseAt(url, { data: {
        schemaVersion: 1,
        environment: 'production',
        commitSha: COMMIT,
        nonce: NONCE,
        issuedAt: NOW,
        expiresAt: '2026-07-11T00:05:00.000Z',
        identities: IDENTITIES,
      } })
    }

    const result = await requestLiveResourceAttestations({
      commit: COMMIT,
      nonce: NONCE,
      now: NOW,
      fetch,
      env: {
        VERIFY_META_API_URL: origin,
        VERIFY_PRODUCTION_OWNER_SESSION_COOKIE: 'mei_session=owner',
      },
    })

    assert.deepEqual(result, { pixel: true, token: true, testEventCode: true, dataKey: true })
    assert.equal(calls.length, 2)
    assert.equal(calls.every(call => call.url.startsWith(origin)), true)
    assert.equal(calls[0].init.headers.Cookie, 'mei_session=owner')
    assert.equal(Object.hasOwn(calls[1].init.headers, 'Cookie'), false)
  })

  it('attestation 拒绝跳转后的响应地址', async () => {
    await assert.rejects(requestLiveResourceAttestations({
      commit: COMMIT,
      nonce: NONCE,
      now: NOW,
      env: {
        VERIFY_META_API_URL: 'https://production.example',
        VERIFY_PRODUCTION_OWNER_SESSION_COOKIE: 'mei_session=owner',
      },
      fetch: async () => responseAt('https://attacker.example/ticket', {}),
    }), /URL|origin|path|响应/)
  })

  it('migration 输出只接受明确的无待应用状态', () => {
    assert.equal(hasNoPendingMigrations('No migrations to apply!'), true)
    assert.equal(hasNoPendingMigrations('0046_meta_live_match_coverage.sql'), false)
    assert.equal(hasNoPendingMigrations('warning: unknown state'), false)
  })

  it('常规发布复用有效 Meta 连接，不要求 verification commit 等于待发布 commit', () => {
    const pixelId = '1234567890'
    const output = JSON.stringify([{ results: [{
      environment: 'production',
      pixel_id: pixelId,
      graph_api_version: 'v25.0',
      verified_commit: 'a'.repeat(40),
      verified_at: '2026-07-13 09:07:35',
      invalidated_at: null,
      invalidation_reason: '',
      revision: 'b'.repeat(32),
    }] }])

    assert.equal(hasVerifiedMetaConnection(output, 'production', pixelId), true)
  })

  it('常规发布只从有效连接和 Cloudflare secret 名称推导隔离状态', () => {
    const secrets = JSON.stringify([
      { name: 'META_CAPI_TEST_EVENT_CODE' },
      { name: 'META_CAPI_DATA_KEY_CURRENT' },
    ])
    assert.deepEqual(resolveFullSecretIsolation(secrets, true), {
      pixel: true,
      token: true,
      testEventCode: true,
      dataKey: true,
    })
    assert.equal(resolveFullSecretIsolation(secrets, false).token, false)
  })
})

function responseAt(url, body) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url,
    json: async () => body,
  }
}
