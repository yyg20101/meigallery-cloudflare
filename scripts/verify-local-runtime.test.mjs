import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildLocalApiWorkerArgs,
  runLocalRuntimeVerification,
  waitForLocalApi,
} from './verify-local-runtime.mjs'

const COMMIT = 'a5eb9494b827c2a1b5c616ed056ca32243aa89ea'

describe('本地运行时发布身份', () => {
  it('Wrangler dev 注入当前 40 位 Git HEAD', () => {
    const args = buildLocalApiWorkerArgs(COMMIT)
    const releaseCommitIndex = args.indexOf(`RELEASE_COMMIT:${COMMIT}`)

    assert.ok(releaseCommitIndex > 0)
    assert.equal(args[releaseCommitIndex - 1], '--var')
    assert.throws(() => buildLocalApiWorkerArgs('fixed-fake-sha'), /40 位 RELEASE_COMMIT/)
  })

  it('getCommit 的真实值会传给 Worker 启动和健康等待', async () => {
    let startedWithCommit = ''
    let waitedForCommit = ''
    let stopped = false
    const commands = []
    const attributionBodies = []
    const conversionBodies = []
    const registrationBodies = []

    const result = await runLocalRuntimeVerification({
      getCommit: async () => COMMIT,
      cleanLocalRuntimeDir: async () => passedStep('local-runtime-clean'),
      runCommand: async (command, args, options) => {
        commands.push({ name: options.name, command, args })
        return passedStep(options.name)
      },
      startLocalApiWorker: (options) => {
        startedWithCommit = options.releaseCommit
        return { child: { exitCode: null }, readLogs: () => ({ stdout: '', stderr: '' }) }
      },
      waitForLocalApi: async (_server, _fetch, expectedCommit) => {
        waitedForCommit = expectedCommit
        return { logs: { stdout: '', stderr: '' }, step: passedStep('local-api-health') }
      },
      stopLocalApiWorker: async () => {
        stopped = true
      },
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/ad-attribution') attributionBodies.push(JSON.parse(init.body))
        if (url.pathname === '/api/conversions/events') conversionBodies.push(JSON.parse(init.body))
        if (url.pathname === '/api/auth/register') registrationBodies.push(JSON.parse(init.body))
        return localSmokeFetch(input, init)
      },
    })

    assert.equal(startedWithCommit, COMMIT)
    assert.equal(waitedForCommit, COMMIT)
    assert.equal(stopped, true)
    assert.equal(result.steps.every(step => step.status === 'passed'), true)
    assert.deepEqual(result.notes, ['ad-platform-server-delivery-disabled-in-local'])
    assert.equal(result.notes.some(note => note.startsWith('local-api-log:')), false)
    assert.equal(attributionBodies.length, 1)
    assert.equal(attributionBodies[0].trackingSourceSlug, 'release-local-fb')
    assert.equal(attributionBodies[0].managedLinkProof, 'b'.repeat(64))
    assert.deepEqual(conversionBodies.map(body => body.actionType), ['open_link'])
    assert.deepEqual(conversionBodies.map(body => body.contactMethodId), ['contact_local_telegram'])
    assert.equal(conversionBodies[0].consentState, 'granted')
    assert.equal(conversionBodies[0].adAttributionState, 'resolved')
    assert.equal(registrationBodies.length, 1)
    assert.match(registrationBodies[0].username, /^rl[0-9a-f]{12}$/)
    assert.ok(registrationBodies[0].username.length <= 20)
    assert.equal(registrationBodies[0].actionType, undefined)
    assert.equal(registrationBodies[0].userId, undefined)
    assert.equal(registrationBodies[0].attribution.consentState, 'granted')
    assert.equal(registrationBodies[0].attribution.adAttributionState, 'resolved')
    const cleanup = commands.find(item => item.name === 'local-registration-cleanup')
    assert.ok(cleanup)
    const cleanupSql = cleanup.args.join(' ')
    assert.match(cleanupSql, new RegExp(`DELETE FROM sessions WHERE user_id IN \\(SELECT id FROM users WHERE username = '${registrationBodies[0].username}'\\)`))
    assert.match(cleanupSql, new RegExp(`UPDATE users SET status = 'disabled'.*WHERE username = '${registrationBodies[0].username}'`))
    const report = JSON.stringify({ steps: result.steps, notes: result.notes, artifacts: result.artifacts })
    assert.equal(report.includes(registrationBodies[0].email), false)
    assert.equal(report.includes(registrationBodies[0].password), false)
  })

  it('拒绝缺失或非法的 Git HEAD，且不启动本地操作', async () => {
    let cleanCount = 0
    for (const commit of ['', 'a5eb949']) {
      await assert.rejects(() => runLocalRuntimeVerification({
        getCommit: async () => commit,
        cleanLocalRuntimeDir: async () => {
          cleanCount += 1
          return passedStep('local-runtime-clean')
        },
      }), /40 位 Git HEAD/)
    }
    assert.equal(cleanCount, 0)
  })

  it('健康响应缺 commit 时立即失败且不写响应原文', async () => {
    const rawMarker = 'raw-response-must-not-enter-report'
    const result = await waitForLocalApi(fakeServer(), async () => jsonResponse({
      status: 'unhealthy',
      db: 'ok',
      environment: 'dev',
      commit: null,
      detail: rawMarker,
    }, 503), COMMIT, { serverTimeoutMs: 20, pollIntervalMs: 0 })

    assert.equal(result.step.status, 'failed')
    assert.match(result.step.summary, /HTTP 503/)
    assert.equal(result.step.summary.includes(rawMarker), false)
  })

  it('健康响应 commit 与 HEAD 不一致时失败', async () => {
    const result = await waitForLocalApi(fakeServer(), async () => jsonResponse({
      status: 'ok',
      db: 'ok',
      environment: 'dev',
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }), COMMIT, { serverTimeoutMs: 20, pollIntervalMs: 0 })

    assert.equal(result.step.status, 'failed')
    assert.match(result.step.summary, /与当前 Git HEAD 不一致/)
  })

  it('status、db、environment 和 commit 全部匹配时通过', async () => {
    const result = await waitForLocalApi(fakeServer(), async () => jsonResponse({
      status: 'ok',
      db: 'ok',
      environment: 'dev',
      commit: COMMIT,
    }), COMMIT, { serverTimeoutMs: 20, pollIntervalMs: 0 })

    assert.equal(result.step.status, 'passed')
    assert.match(result.step.summary, /environment=dev/)
    assert.match(result.step.summary, new RegExp(COMMIT))
  })
})

function fakeServer() {
  return {
    child: { exitCode: null },
    readLogs: () => ({ stdout: '', stderr: '' }),
  }
}

function passedStep(name) {
  return {
    name,
    status: 'passed',
    durationMs: 1,
    command: name,
    exitCode: 0,
    summary: 'ok',
    stdout: '',
    stderr: '',
  }
}

async function localSmokeFetch(input, init = {}) {
  const url = new URL(String(input))
  const cookie = String(init.headers?.Cookie || '')
  if (url.pathname === '/api/marketing-consent') {
    return jsonResponse({ state: 'granted' }, 200, {
      'set-cookie': 'mei_marketing_consent_choice=choice; Path=/; HttpOnly, mei_marketing_consent_receipt=marketing_receipt; Path=/; HttpOnly',
    })
  }
  if (url.pathname === '/api/ad-attribution') {
    if (!cookie.includes('mei_marketing_consent_receipt=marketing_receipt')) {
      return jsonResponse({ code: 'MARKETING_CONSENT_REQUIRED' }, 400)
    }
    return jsonResponse({ provider: 'meta', resolution: 'matched' }, 200, {
      'set-cookie': 'mei_ad_attribution=attribution_context; Path=/; HttpOnly',
    })
  }
  if (url.pathname === '/api/conversions/events') {
    if (!hasAttributionCookies(cookie)) return jsonResponse({ code: 'ATTRIBUTION_RECEIPT_REQUIRED' }, 400)
    const body = JSON.parse(String(init.body || '{}'))
    return jsonResponse({ data: { id: `conv_${body.actionType}`, actionType: 'contact', created: true } }, 201)
  }
  if (url.pathname === '/api/auth/register') {
    if (!hasAttributionCookies(cookie)) return jsonResponse({ code: 'ATTRIBUTION_RECEIPT_REQUIRED' }, 400)
    return jsonResponse({ id: 42, trackingInstructions: [] }, 201)
  }
  if (url.pathname === '/api/analytics/events') return jsonResponse({ accepted: 3, rejected: 0 })
  if (url.pathname === '/api/admin/analytics/funnel') {
    return jsonResponse({
      data: {
        stages: [
          { key: 'page_views', value: 1 },
          { key: 'key_clicks', value: 1 },
          { key: 'contacts_or_registers', value: 2 },
        ],
      },
    })
  }
  if (url.pathname === '/api/admin/attribution/conversions') {
    if (url.searchParams.get('provider') !== 'meta') {
      return jsonResponse({ code: 'ATTRIBUTION_PROVIDER_INVALID' }, 400)
    }
    return jsonResponse({
      data: {
        bySource: [{ source_name: 'release-local-fb', contact_count: 1, complete_registration_count: 1 }],
      },
    })
  }
  return jsonResponse({ message: 'unexpected route' }, 404)
}

function hasAttributionCookies(cookie) {
  return cookie.includes('mei_marketing_consent_receipt=marketing_receipt')
    && cookie.includes('mei_ad_attribution=attribution_context')
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
