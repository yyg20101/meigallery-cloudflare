import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runDevRehearsalVerification } from './verify-dev-rehearsal.mjs'

const DEV_SEED_PATH = fileURLToPath(new URL('./fixtures/release-smoke/seed-dev.sql', import.meta.url))
const RELEASE_COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'

describe('开发环境发布预演验证', () => {
  it('缺少 dev URL 环境变量时直接失败', async () => {
    await assert.rejects(async () => {
      await runDevRehearsalVerification({
        env: {},
        releaseCommit: RELEASE_COMMIT,
      })
    }, /VERIFY_DEV_API_URL/)
  })

  it('执行远端迁移、部署和严格 Meta smoke', async () => {
    const commands = []
    const requestedUrls = []
    const conversionBodies = []
    const registrationBodies = []
    const responses = [
      ...successfulResponses({
        baseline: { Contact: 4, CompleteRegistration: 7 },
        after: { Contact: 5, CompleteRegistration: 8 },
        html: '<!doctype html><html><body><div id="__nuxt"></div><script>window.__APP__="wajie"</script></body></html>',
      }),
      jsonResponse(200, {
        data: {
          status: 'sent',
          eventsReceived: 1,
          testEventCodePresent: true,
        },
      }),
    ]

    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      releaseCommit: RELEASE_COMMIT,
      runCommand: async (command, args, options) => {
        commands.push([command, ...args].join(' '))
        return {
          name: options.name,
          status: 'passed',
          durationMs: 1,
          command: options.reportCommand || [command, ...args].join(' '),
          exitCode: 0,
          summary: 'ok',
          stdout: 'ok',
          stderr: '',
        }
      },
      fetch: async (url, init) => {
        requestedUrls.push(String(url))
        if (String(url).endsWith('/api/conversions/events')) conversionBodies.push(JSON.parse(init.body))
        if (String(url).endsWith('/api/auth/register')) registrationBodies.push(JSON.parse(init.body))
        const response = responses.shift()
        if (!response) throw new Error('缺少模拟响应')
        return response
      },
    })

    assert.equal(result.steps.every(step => step.status === 'passed'), true)
    assert.equal(result.notes.includes('meta-test-event-code-missing'), false)
    assert.equal(result.notes.includes('dev-smoke-owner-disabled-after-run'), true)
    assert.equal(commands.some(command => command.includes('wrangler d1 migrations apply meigallery-db-dev --env dev --remote')), true)
    assert.equal(commands.some(command => command.includes('wrangler deploy --env dev')), true)
    assert.equal(commands.some(command => command.includes(`wrangler deploy --env dev --var RELEASE_COMMIT:${RELEASE_COMMIT}`)), true)
    assert.equal(commands.filter(command => command.includes(`wrangler deploy --env dev --var RELEASE_COMMIT:${RELEASE_COMMIT}`)).length, 2)
    assert.equal(commands.some(command => command.includes("UPDATE users SET status = 'disabled'")), true)
    assert.equal(result.steps.some(step => step.name === 'dev-smoke-owner-cleanup' && step.status === 'passed'), true)
    assert.equal(requestedUrls.some(url => url.includes('/api/admin/attribution/conversions?') && url.includes('sourceCode=release-dev-fb')), true)
    assert.equal(requestedUrls.some(url => url.endsWith('/api/health')), true)
    assert.equal(requestedUrls.some(url => url.endsWith('/__release')), true)
    assert.equal(requestedUrls.some(url => url.includes('/api/admin/attribution/meta?')), true)
    assert.equal(conversionBodies.every(body => body.consentState === 'granted'), true)
    assert.deepEqual(conversionBodies.map(body => body.actionType), ['contact'])
    assert.equal(registrationBodies.length, 1)
    assert.equal(registrationBodies[0].actionType, undefined)
    assert.equal(registrationBodies[0].userId, undefined)
    assert.equal(registrationBodies[0].attribution.consentState, 'granted')
    assert.equal(requestedUrls.some(url => url.endsWith('/api/auth/register')), true)
    assert.match(conversionBodies[0].visitorId, /^visitor_release_dev_[0-9a-f]{12}$/)
    assert.match(conversionBodies[0].sessionId, /^session_release_dev_[0-9a-f]{12}$/)
    assert.match(conversionBodies[0].actionTarget, /^floating_contact_panel_[0-9a-f]{12}$/)
    assert.equal(requestedUrls.filter(url => url.includes('/api/admin/attribution/meta?')).length, 2)
    const serializedReport = JSON.stringify({ steps: result.steps, notes: result.notes, artifacts: result.artifacts })
    assert.doesNotMatch(serializedReport, /@example\.test|password|fb\.1\./i)
  })

  it('dev seed 使用严格 test 模式', async () => {
    const seed = await readFile(DEV_SEED_PATH, 'utf8')
    assert.match(seed, /\('meta_tracking_mode', '"test"'/)
    assert.doesNotMatch(seed, /\('meta_tracking_mode', '"hybrid"'/)
  })

  it('Test Event 缺 secret/code 或未 sent 时失败并清理 Owner', async () => {
    const responses = successfulResponses()
    responses.push(jsonResponse(503, {
      code: 'META_TEST_EVENT_NOT_CONFIGURED',
      detail: {
        status: 'failed',
        eventsReceived: 0,
        testEventCodePresent: false,
      },
    }))

    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      releaseCommit: RELEASE_COMMIT,
      pollIntervalMs: 0,
      runCommand: passingCommand,
      fetch: async () => {
        const response = responses.shift()
        if (!response) throw new Error('缺少模拟响应')
        return response
      },
    })

    assert.equal(result.steps.find(step => step.name === 'dev-meta-test-event')?.status, 'failed')
    assert.equal(result.steps.some(step => step.name === 'dev-smoke-owner-cleanup' && step.status === 'passed'), true)
    assert.equal(result.notes.includes('meta-test-event-code-missing'), false)
  })

  it('API 与 Web commit 不一致时在业务 smoke 前失败并清理 Owner', async () => {
    const requestedUrls = []
    const responses = successfulResponses()
    responses[1] = jsonResponse(200, {
      status: 'ok',
      environment: 'dev',
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })

    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev',
      },
      releaseCommit: RELEASE_COMMIT,
      runCommand: passingCommand,
      fetch: async (url) => {
        requestedUrls.push(String(url))
        return responses.shift() || jsonResponse(500, { message: '不应继续请求' })
      },
    })

    expectFailedReleaseStep(result, 'dev-web-release')
    assert.equal(requestedUrls.some(url => url.endsWith('/api/conversions/events')), false)
    assert.equal(result.steps.some(step => step.name === 'dev-smoke-owner-cleanup' && step.status === 'passed'), true)
  })

  it('历史非零 CAPI sent 没有基线增量时失败并清理 Owner', async () => {
    const unchanged = { Contact: 9, CompleteRegistration: 11 }
    const responses = successfulResponses({ baseline: unchanged, after: unchanged })
    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      releaseCommit: RELEASE_COMMIT,
      pollTimeoutMs: 0,
      pollIntervalMs: 0,
      runCommand: passingCommand,
      fetch: async () => responses.shift() || jsonResponse(500, { message: '缺少模拟响应' }),
    })

    const deliveryStep = result.steps.find(step => step.name === 'dev-meta-capi-deliveries')
    assert.equal(deliveryStep?.status, 'failed')
    assert.match(deliveryStep?.summary || '', /基线增量/)
    assert.equal(result.steps.some(step => step.name === 'dev-smoke-owner-cleanup' && step.status === 'passed'), true)
  })

  it('conversion created=false 时失败并清理 Owner', async () => {
    const responses = successfulResponses()
    responses[4] = jsonResponse(200, { data: { id: 'conv_existing', actionType: 'contact', created: false } })
    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      releaseCommit: RELEASE_COMMIT,
      runCommand: passingCommand,
      fetch: async () => responses.shift() || jsonResponse(500, { message: '缺少模拟响应' }),
    })

    const conversionStep = result.steps.find(step => step.name === 'dev-conversion-contact')
    assert.equal(conversionStep?.status, 'failed')
    assert.match(conversionStep?.summary || '', /created 非 true/)
    assert.equal(result.steps.some(step => step.name === 'dev-smoke-owner-cleanup' && step.status === 'passed'), true)
  })

  it('注册 201 但缺少 Pixel 指令时仍按唯一 username 清理用户和 session', async () => {
    const responses = successfulResponses()
    responses[5] = jsonResponse(201, { id: 42, pixelEvents: [] })
    const commands = []
    const registrationBodies = []

    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      releaseCommit: RELEASE_COMMIT,
      runCommand: recordingCommand(commands),
      fetch: async (url, init) => {
        if (String(url).endsWith('/api/auth/register')) registrationBodies.push(JSON.parse(init.body))
        return responses.shift() || jsonResponse(500, { message: '缺少模拟响应' })
      },
    })

    assert.equal(result.steps.find(step => step.name === 'dev-auth-register')?.status, 'failed')
    assert.equal(registrationBodies.length, 1)
    assertUsernameCleanup(commands, registrationBodies[0].username)
    assertReportOmitsRegistrationCredentials(result, registrationBodies[0])
  })

  it('注册请求提交后 fetch 抛错时仍按唯一 username 清理用户和 session', async () => {
    const responses = successfulResponses().slice(0, 5)
    const commands = []
    const registrationBodies = []

    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      releaseCommit: RELEASE_COMMIT,
      runCommand: recordingCommand(commands),
      fetch: async (url, init) => {
        if (String(url).endsWith('/api/auth/register')) {
          registrationBodies.push(JSON.parse(init.body))
          throw new Error('注册提交后连接中断')
        }
        return responses.shift() || jsonResponse(500, { message: '缺少模拟响应' })
      },
    })

    assert.equal(result.steps.find(step => step.name === 'dev-auth-register')?.status, 'failed')
    assert.equal(registrationBodies.length, 1)
    assertUsernameCleanup(commands, registrationBodies[0].username)
    assertReportOmitsRegistrationCredentials(result, registrationBodies[0])
  })

  it('非 2xx smoke 响应会保留 HTTP 状态和响应体摘要', async () => {
    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      releaseCommit: RELEASE_COMMIT,
      runCommand: async (command, args, options) => ({
        name: options.name,
        status: 'passed',
        durationMs: 1,
        command: options.reportCommand || [command, ...args].join(' '),
        exitCode: 0,
        summary: 'ok',
        stdout: 'ok',
        stderr: '',
      }),
      fetch: async () => jsonResponse(500, { message: 'db unavailable' }),
    })

    const healthStep = result.steps.find(step => step.name === 'dev-api-health')
    assert.equal(healthStep?.status, 'failed')
    assert.equal(healthStep?.exitCode, 500)
    assert.match(healthStep?.summary || '', /HTTP 500/)
    assert.match(healthStep?.summary || '', /db unavailable/)
    assert.equal(result.steps.some(step => step.name === 'dev-smoke-owner-cleanup' && step.status === 'passed'), true)
  })

  it('smoke fetch 超时时会失败并继续清理 dev owner', async () => {
    const result = await runDevRehearsalVerification({
      env: {
        VERIFY_DEV_API_URL: 'https://api-dev.example.workers.dev',
        VERIFY_DEV_WEB_URL: 'https://web-dev.example.workers.dev/',
      },
      releaseCommit: RELEASE_COMMIT,
      requestTimeoutMs: 5,
      runCommand: async (command, args, options) => ({
        name: options.name,
        status: 'passed',
        durationMs: 1,
        command: options.reportCommand || [command, ...args].join(' '),
        exitCode: 0,
        summary: 'ok',
        stdout: 'ok',
        stderr: '',
      }),
      fetch: async () => new Promise(() => {}),
    })

    const healthStep = result.steps.find(step => step.name === 'dev-api-health')
    assert.equal(healthStep?.status, 'failed')
    assert.match(healthStep?.summary || '', /请求超时：5ms/)
    assert.equal(result.steps.some(step => step.name === 'dev-smoke-owner-cleanup' && step.status === 'passed'), true)
  })
})

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function successfulResponses(options = {}) {
  const baseline = options.baseline || { Contact: 0, CompleteRegistration: 0 }
  const after = options.after || { Contact: 1, CompleteRegistration: 1 }
  return [
    jsonResponse(200, { status: 'ok', db: 'ok', environment: 'dev', commit: RELEASE_COMMIT }),
    jsonResponse(200, { status: 'ok', environment: 'dev', commit: RELEASE_COMMIT }),
    textResponse(200, options.html || '<!doctype html><html><body><div id="__nuxt"></div></body></html>'),
    metaDeliveryResponse(baseline),
    jsonResponse(200, { data: { id: 'conv_1', actionType: 'contact', created: true } }),
    jsonResponse(201, {
      id: 42,
      username: 'release_dev_registration',
      pixelEvents: [{ eventName: 'CompleteRegistration' }],
    }),
    jsonResponse(200, { accepted: 3, rejected: 0 }),
    jsonResponse(200, {
      data: {
        stages: [
          { key: 'page_views', value: 2 },
          { key: 'key_clicks', value: 1 },
          { key: 'contacts_or_registers', value: 2 },
        ],
      },
    }),
    jsonResponse(200, {
      data: {
        bySource: [{ source_name: 'release-dev-fb', contact_count: 1, complete_registration_count: 1 }],
      },
    }),
    metaDeliveryResponse(after),
  ]
}

function expectFailedReleaseStep(result, name) {
  const step = result.steps.find(item => item.name === name)
  assert.equal(step?.status, 'failed')
  assert.match(step?.summary || '', /commit.*不一致/)
}

function metaDeliveryResponse(counts) {
  return jsonResponse(200, {
    data: {
      deliveries: Object.entries(counts).map(([eventName, deliveryCount]) => ({
        channel: 'meta_capi',
        event_name: eventName,
        status: 'sent',
        delivery_count: deliveryCount,
      })),
    },
  })
}

async function passingCommand(command, args, options) {
  return {
    name: options.name,
    status: 'passed',
    durationMs: 1,
    command: options.reportCommand || [command, ...args].join(' '),
    exitCode: 0,
    summary: 'ok',
    stdout: 'ok',
    stderr: '',
  }
}

function recordingCommand(commands) {
  return async (command, args, options) => {
    commands.push({ name: options.name, command, args })
    return passingCommand(command, args, options)
  }
}

function assertUsernameCleanup(commands, username) {
  const cleanup = commands.find(item => item.name === 'dev-smoke-owner-cleanup')
  assert.ok(cleanup)
  const cleanupSql = cleanup.args.join(' ')
  assert.match(cleanupSql, new RegExp(`DELETE FROM sessions WHERE user_id IN \\(SELECT id FROM users WHERE username = '${username}'\\)`))
  assert.match(cleanupSql, new RegExp(`UPDATE users SET status = 'disabled'.*WHERE username = '${username}'`))
}

function assertReportOmitsRegistrationCredentials(result, registrationBody) {
  const report = JSON.stringify({ steps: result.steps, notes: result.notes, artifacts: result.artifacts })
  assert.equal(report.includes(registrationBody.email), false)
  assert.equal(report.includes(registrationBody.password), false)
}
