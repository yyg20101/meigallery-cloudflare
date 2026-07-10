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

    const result = await runLocalRuntimeVerification({
      getCommit: async () => COMMIT,
      cleanLocalRuntimeDir: async () => passedStep('local-runtime-clean'),
      runCommand: async (_command, _args, options) => passedStep(options.name),
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
      fetch: localSmokeFetch,
    })

    assert.equal(startedWithCommit, COMMIT)
    assert.equal(waitedForCommit, COMMIT)
    assert.equal(stopped, true)
    assert.equal(result.steps.every(step => step.status === 'passed'), true)
    assert.deepEqual(result.notes, ['meta-capi-disabled-in-local'])
    assert.equal(result.notes.some(note => note.startsWith('local-api-log:')), false)
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
  if (url.pathname === '/api/conversions/events') {
    const body = JSON.parse(String(init.body || '{}'))
    return jsonResponse({ data: { id: `conv_${body.actionType}`, actionType: body.actionType, created: true } }, 201)
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
    return jsonResponse({
      data: {
        bySource: [{ source_name: 'release-local-fb', contact_count: 1, complete_registration_count: 1 }],
      },
    })
  }
  if (url.pathname === '/api/admin/attribution/meta') {
    return jsonResponse({
      data: {
        settings: { meta_capi_enabled: false },
        deliveries: [],
      },
    })
  }
  return jsonResponse({ message: 'unexpected route' }, 404)
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
