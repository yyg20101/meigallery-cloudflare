import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStep, fetchWithTimeout, redact, runCommand } from './release-verification-lib.mjs'

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
const LOCAL_RUNTIME_DIR = path.join(ROOT_DIR, '.wrangler-release-verify', 'local-runtime')
const LOCAL_RUNTIME_DIR_RELATIVE_TO_API = '../../.wrangler-release-verify/local-runtime'
const LOCAL_SEED_FILE_RELATIVE_TO_API = '../../scripts/fixtures/release-smoke/seed-local.sql'
const LOCAL_API_URL = 'http://127.0.0.1:8789'
const SESSION_COOKIE = 'mei_session'
const LOCAL_API_PORT = '8789'
const LOCAL_SERVER_TIMEOUT_MS = 60_000
const LOCAL_POLL_INTERVAL_MS = 1_000
const LOCAL_REQUEST_TIMEOUT_MS = 15_000

const DEFAULT_WRANGLER_VARS = [
  ['APP_ENV', 'dev'],
  ['CORS_ORIGIN', 'http://localhost:3000'],
  ['EMAIL_FROM', 'noreply@example.test'],
  ['SITE_URL', LOCAL_API_URL],
  ['IMAGE_RESIZING_ENABLED', 'false'],
  ['IMPORT_TOKEN_DAILY_LIMIT', '100'],
  ['SESSION_SECRET', 'local-runtime-session-secret-0123456789abcdef'],
  ['TURNSTILE_SECRET_KEY', 'local-runtime-turnstile-secret'],
  ['STREAM_ACCOUNT_ID', 'local-runtime-stream-account'],
  ['STREAM_API_TOKEN', 'local-runtime-stream-token'],
  ['AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT', crypto.createHash('sha256').update('meigallery-local-attribution-master-key').digest('base64')],
]

export async function runLocalRuntimeVerification(options = {}) {
  const cwd = options.cwd || ROOT_DIR
  const runCommandFn = options.runCommand || runCommand
  const getCommitFn = options.getCommit || readCurrentCommit
  const cleanLocalRuntimeDirFn = options.cleanLocalRuntimeDir || cleanLocalRuntimeDir
  const startLocalApiWorkerFn = options.startLocalApiWorker || startLocalApiWorker
  const waitForLocalApiFn = options.waitForLocalApi || waitForLocalApi
  const stopLocalApiWorkerFn = options.stopLocalApiWorker || stopLocalApiWorker
  const fetchFn = options.fetch || fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS
  const boundedFetch = (input, init) => fetchWithTimeout(fetchFn, input, init, requestTimeoutMs)
  const releaseCommit = String(await getCommitFn({ cwd, runCommand: runCommandFn }) || '').trim()
  if (!/^[0-9a-f]{40}$/i.test(releaseCommit)) throw new Error('local-runtime 需要当前 40 位 Git HEAD')
  const steps = []
  const notes = []
  const artifacts = [LOCAL_RUNTIME_DIR]
  const sessionToken = crypto.randomBytes(32).toString('hex')
  const sessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex')
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const runSuffix = crypto.randomBytes(6).toString('hex')
  const registrationEmail = `release-local-${runSuffix}@example.test`
  const registrationUsername = `rl${runSuffix}`
  const registrationPassword = `${crypto.randomBytes(18).toString('base64url')}Aa1!`
  const registrationCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const registrationCodeId = `evc_release_local_${runSuffix}`
  const registrationSettingBackupKey = `release_local_previous_email_verification_${runSuffix}`
  const sensitiveValues = [sessionToken, sessionHash, registrationEmail, registrationPassword, registrationCode]
  let server = null
  let startedServer = false
  let shouldCleanupRegistrationFixture = false

  try {
    const cleanStep = await cleanLocalRuntimeDirFn()
    steps.push(cleanForReport(cleanStep))
    if (cleanStep.status !== 'passed') return { steps, notes, artifacts }

    const migrateStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec',
      'wrangler', 'd1', 'migrations', 'apply', 'meigallery-db',
      '--local',
      '--persist-to', LOCAL_RUNTIME_DIR_RELATIVE_TO_API,
    ], {
      cwd,
      name: 'local-d1-migrate',
    })
    steps.push(cleanForReport(migrateStep))
    if (migrateStep.status !== 'passed') return { steps, notes, artifacts }

    const seedStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec',
      'wrangler', 'd1', 'execute', 'meigallery-db',
      '--local',
      '--persist-to', LOCAL_RUNTIME_DIR_RELATIVE_TO_API,
      '--file', LOCAL_SEED_FILE_RELATIVE_TO_API,
      '--yes',
    ], {
      cwd,
      name: 'local-d1-seed',
    })
    steps.push(cleanForReport(seedStep))
    if (seedStep.status !== 'passed') return { steps, notes, artifacts }

    const sessionSql = [
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)',
      `VALUES ('ses_release_local_runtime', 1, '${sessionHash}', '${sessionExpiresAt}', datetime('now'))`,
      "ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at;",
    ].join(' ')
    const sessionStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec',
      'wrangler', 'd1', 'execute', 'meigallery-db',
      '--local',
      '--persist-to', LOCAL_RUNTIME_DIR_RELATIVE_TO_API,
      '--command', sessionSql,
      '--yes',
    ], {
      cwd,
      name: 'local-session-seed',
      reportCommand: 'corepack pnpm --filter @meigallery/api exec wrangler d1 execute meigallery-db --local --persist-to ../../.wrangler-release-verify/local-runtime --command "INSERT INTO sessions (...)" --yes',
    })
    steps.push(cleanForReport(sessionStep))
    if (sessionStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    shouldCleanupRegistrationFixture = true
    const registrationFixtureSql = [
      'INSERT OR REPLACE INTO site_settings (key, value, updated_at)',
      `SELECT '${registrationSettingBackupKey}', value, datetime('now') FROM site_settings WHERE key = 'email_verification_enabled';`,
      "UPDATE site_settings SET value = '\"true\"', updated_at = datetime('now') WHERE key = 'email_verification_enabled';",
      'INSERT INTO email_verification_codes (id, email, code, purpose, expires_at, used, attempts, created_at)',
      `VALUES ('${registrationCodeId}', '${registrationEmail}', '${registrationCode}', 'register', datetime('now', '+10 minutes'), 0, 0, datetime('now'));`,
    ].join(' ')
    const registrationFixtureStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec',
      'wrangler', 'd1', 'execute', 'meigallery-db',
      '--local',
      '--persist-to', LOCAL_RUNTIME_DIR_RELATIVE_TO_API,
      '--command', registrationFixtureSql,
      '--yes',
    ], {
      cwd,
      name: 'local-registration-fixture',
      reportCommand: 'corepack pnpm --filter @meigallery/api exec wrangler d1 execute meigallery-db --local --persist-to ../../.wrangler-release-verify/local-runtime --command "enable verification; insert one-time registration code" --yes',
    })
    steps.push(cleanForReport({ ...registrationFixtureStep, summary: '一次性本地注册夹具已准备' }))
    if (registrationFixtureStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    server = startLocalApiWorkerFn({
      cwd,
      env: buildLocalDevEnv(options.env),
      releaseCommit,
    })
    startedServer = true
    const healthStep = await waitForLocalApiFn(server, boundedFetch, releaseCommit, {
      serverTimeoutMs: options.serverTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    })
    steps.push(cleanForReport(healthStep.step))
    if (healthStep.step.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    const attributionReceipt = await establishMetaAttribution(boundedFetch)
    steps.push(attributionReceipt.step)
    if (attributionReceipt.step.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    const contactStep = await postConversion(boundedFetch, 'local-conversion-contact', {
      actionType: 'open_link',
      contactMethodId: 'contact_local_telegram',
      visitorId: 'visitor_release_local',
      sessionId: 'session_release_local',
      occurredAt: new Date().toISOString(),
      routeName: 'gallery-detail',
      path: '/gallery/release-local',
      sourceChannel: 'ad',
      sourceName: 'release-local-fb',
      trackingSourceSlug: 'release-local-fb',
      utmSource: 'facebook',
      utmMedium: 'paid_social',
      utmCampaign: 'release-local-runtime',
      utmContent: 'release-local-chat',
      consentState: 'granted',
      adAttributionState: 'resolved',
      methodType: 'telegram',
      metadata: {
        fbclid: 'release-local-fbclid',
        placement: 'local-runtime-smoke',
      },
    }, attributionReceipt.cookieHeader)
    steps.push(contactStep)
    if (contactStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    const completeRegistrationStep = await postRegistration(boundedFetch, {
      email: registrationEmail,
      username: registrationUsername,
      password: registrationPassword,
      code: registrationCode,
      attribution: {
        visitorId: 'visitor_release_local',
        sessionId: 'session_release_local',
        occurredAt: new Date().toISOString(),
        routeName: 'register',
        path: '/register',
        sourceChannel: 'ad',
        sourceName: 'release-local-fb',
        trackingSourceSlug: 'release-local-fb',
        utmSource: 'facebook',
        utmMedium: 'paid_social',
        utmCampaign: 'release-local-runtime',
        utmContent: 'release-local-chat',
        consentState: 'granted',
        adAttributionState: 'resolved',
      },
    }, attributionReceipt.cookieHeader)
    steps.push(completeRegistrationStep)
    if (completeRegistrationStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    const analyticsIngestStep = await postAnalyticsBatch(boundedFetch)
    steps.push(analyticsIngestStep)
    if (analyticsIngestStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    const analyticsStep = await smokeAdminAnalytics(boundedFetch, sessionToken)
    steps.push(analyticsStep)
    if (analyticsStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    const attributionStep = await smokeAdminAttribution(boundedFetch, sessionToken)
    steps.push(attributionStep)
    if (attributionStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    const metaStep = await smokeMetaDelivery(boundedFetch, sessionToken)
    steps.push(metaStep)
    if (metaStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues }

    notes.push('ad-platform-server-delivery-disabled-in-local')
    return { steps, notes, artifacts, sensitiveValues }
  } finally {
    if (startedServer && server) {
      await stopLocalApiWorkerFn(server)
    }
    if (shouldCleanupRegistrationFixture) {
      const cleanupSql = [
        `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = '${registrationUsername}');`,
        `UPDATE users SET status = 'disabled', updated_at = datetime('now') WHERE username = '${registrationUsername}';`,
        `DELETE FROM email_verification_codes WHERE id = '${registrationCodeId}';`,
        `UPDATE site_settings SET value = COALESCE((SELECT value FROM site_settings WHERE key = '${registrationSettingBackupKey}'), '\"false\"'), updated_at = datetime('now') WHERE key = 'email_verification_enabled';`,
        `DELETE FROM site_settings WHERE key = '${registrationSettingBackupKey}';`,
      ].join(' ')
      const cleanupStep = await runCommandFn('corepack', [
        'pnpm', '--filter', '@meigallery/api', 'exec',
        'wrangler', 'd1', 'execute', 'meigallery-db',
        '--local',
        '--persist-to', LOCAL_RUNTIME_DIR_RELATIVE_TO_API,
        '--command', cleanupSql,
        '--yes',
      ], {
        cwd,
        name: 'local-registration-cleanup',
        reportCommand: 'corepack pnpm --filter @meigallery/api exec wrangler d1 execute meigallery-db --local --persist-to ../../.wrangler-release-verify/local-runtime --command "cleanup registration fixture and smoke user" --yes',
      })
      steps.push(cleanForReport({ ...cleanupStep, summary: '本地注册夹具、session 和测试用户已清理' }))
    }
  }
}

async function cleanLocalRuntimeDir() {
  const startedAt = Date.now()
  await rm(LOCAL_RUNTIME_DIR, { recursive: true, force: true })
  return {
    ...createStep('local-runtime-clean'),
    status: 'passed',
    durationMs: Date.now() - startedAt,
    command: 'rm -rf .wrangler-release-verify/local-runtime',
    exitCode: 0,
    summary: '已清理 .wrangler-release-verify/local-runtime',
  }
}

function cleanForReport(step) {
  const { stdout, stderr, logs, ...rest } = step
  return rest
}

function buildLocalDevEnv(extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv,
  }
}

export function buildLocalApiWorkerArgs(releaseCommit) {
  if (!/^[0-9a-f]{40}$/i.test(String(releaseCommit || ''))) {
    throw new Error('Wrangler dev 需要 40 位 RELEASE_COMMIT')
  }
  return [
    'pnpm', '--filter', '@meigallery/api', 'exec',
    'wrangler', 'dev',
    '--local',
    '--persist-to', LOCAL_RUNTIME_DIR_RELATIVE_TO_API,
    '--port', LOCAL_API_PORT,
    '--ip', '127.0.0.1',
    '--log-level', 'info',
    '--show-interactive-dev-session=false',
    ...DEFAULT_WRANGLER_VARS.flatMap(([key, value]) => ['--var', `${key}:${value}`]),
    '--var', `RELEASE_COMMIT:${releaseCommit}`,
  ]
}

function startLocalApiWorker(options) {
  const args = buildLocalApiWorkerArgs(options.releaseCommit)

  const child = spawn('corepack', args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  return {
    child,
    readLogs() {
      return {
        stdout: redact(stdout.trim()),
        stderr: redact(stderr.trim()),
      }
    },
  }
}

export async function waitForLocalApi(server, fetchFn, expectedCommit, options = {}) {
  const startedAt = Date.now()
  const serverTimeoutMs = options.serverTimeoutMs ?? LOCAL_SERVER_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? LOCAL_POLL_INTERVAL_MS
  while (Date.now() - startedAt < serverTimeoutMs) {
    if (server.child.exitCode !== null) {
      const logs = server.readLogs()
      return {
        logs,
        step: {
          ...createStep('local-api-health'),
          status: 'failed',
          durationMs: Date.now() - startedAt,
          command: `GET ${LOCAL_API_URL}/api/health`,
          exitCode: server.child.exitCode,
          summary: truncateSummary(`本地 API 提前退出。${logs.stderr || logs.stdout || '无额外日志'}`),
        },
      }
    }

    try {
      const response = await fetchFn(`${LOCAL_API_URL}/api/health`)
      if (!response.ok) {
        return failedLocalApiHealth(server, startedAt, `本地 API 健康端点返回 HTTP ${response.status}`, response.status)
      }

      let body
      try {
        body = await response.json()
      } catch {
        return failedLocalApiHealth(server, startedAt, '本地 API 健康端点未返回合法 JSON', response.status)
      }
      const identityError = validateLocalApiHealth(body, expectedCommit)
      if (!identityError) {
        return {
          logs: server.readLogs(),
          step: {
            ...createStep('local-api-health'),
            status: 'passed',
            durationMs: Date.now() - startedAt,
            command: `GET ${LOCAL_API_URL}/api/health`,
            exitCode: 0,
            summary: truncateSummary(`健康检查通过，db=${body.db}，environment=dev，commit=${expectedCommit}`),
          },
        }
      }
      return failedLocalApiHealth(server, startedAt, identityError, response.status)
    } catch {
      // 继续轮询
    }

    await sleep(pollIntervalMs)
  }

  const logs = server.readLogs()
  return {
    logs,
    step: {
      ...createStep('local-api-health'),
      status: 'failed',
      durationMs: Date.now() - startedAt,
      command: `GET ${LOCAL_API_URL}/api/health`,
      exitCode: null,
      summary: truncateSummary(`等待本地 API 超时。${logs.stderr || logs.stdout || '无额外日志'}`),
    },
  }
}

function validateLocalApiHealth(body, expectedCommit) {
  if (body?.environment !== 'dev') return '本地 API environment 不是 dev'
  if (!/^[0-9a-f]{40}$/i.test(String(body?.commit || ''))) return '本地 API commit 缺失或非法'
  if (body.commit !== expectedCommit) return '本地 API commit 与当前 Git HEAD 不一致'
  if (body?.status !== 'ok') return '本地 API status 非 ok'
  if (body?.db !== 'ok') return '本地 API db 非 ok'
  return ''
}

function failedLocalApiHealth(server, startedAt, summary, exitCode) {
  return {
    logs: server.readLogs(),
    step: {
      ...createStep('local-api-health'),
      status: 'failed',
      durationMs: Date.now() - startedAt,
      command: `GET ${LOCAL_API_URL}/api/health`,
      exitCode,
      summary: truncateSummary(summary),
    },
  }
}

async function readCurrentCommit(options = {}) {
  const runCommandFn = options.runCommand || runCommand
  const step = await runCommandFn('git', ['rev-parse', 'HEAD'], {
    cwd: options.cwd || ROOT_DIR,
    name: 'git-commit',
  })
  if (step.status !== 'passed') throw new Error('无法读取当前 Git HEAD')
  return String(step.stdout || '').trim()
}

async function establishMetaAttribution(fetchFn) {
  const startedAt = Date.now()
  const command = 'PUT /api/marketing-consent -> PUT /api/ad-attribution'
  try {
    const consentResponse = await fetchFn(`${LOCAL_API_URL}/api/marketing-consent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'granted' }),
    })
    if (!consentResponse.ok) throw new Error(`营销授权 HTTP ${consentResponse.status}`)
    const consentBody = await consentResponse.json()
    if (consentBody?.state !== 'granted') throw new Error('营销授权未进入 granted')
    const consentCookie = readResponseCookie(consentResponse, 'mei_marketing_consent_receipt')

    const attributionResponse = await fetchFn(`${LOCAL_API_URL}/api/ad-attribution`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: consentCookie,
      },
      body: JSON.stringify({
        fbclid: 'release-local-fbclid',
        utmSource: 'facebook',
        trackingSourceSlug: 'release-local-fb',
      }),
    })
    if (!attributionResponse.ok) throw new Error(`广告来源验证 HTTP ${attributionResponse.status}`)
    const attributionBody = await attributionResponse.json()
    if (attributionBody?.provider !== 'meta' || attributionBody?.resolution !== 'matched') {
      throw new Error('广告来源未解析为 Meta')
    }
    const attributionCookie = readResponseCookie(attributionResponse, 'mei_ad_attribution')

    return {
      cookieHeader: `${consentCookie}; ${attributionCookie}`,
      step: {
        ...createStep('local-meta-attribution-context'),
        status: 'passed',
        durationMs: Date.now() - startedAt,
        command,
        exitCode: 200,
        summary: '营销授权和 Meta 来源上下文已由本地 Worker 签发',
      },
    }
  }
  catch (error) {
    return {
      cookieHeader: '',
      step: {
        ...createStep('local-meta-attribution-context'),
        status: 'failed',
        durationMs: Date.now() - startedAt,
        command,
        exitCode: null,
        summary: truncateSummary(error instanceof Error ? error.message : 'Meta 来源上下文创建失败'),
      },
    }
  }
}

function readResponseCookie(response, name) {
  const setCookie = response.headers.get('set-cookie') || ''
  const cookiePair = setCookie.split(';', 1)[0]
  if (!cookiePair.startsWith(`${name}=`) || cookiePair.length <= name.length + 1) {
    throw new Error(`${name} 未签发`)
  }
  return cookiePair
}

async function postConversion(fetchFn, stepName, payload, cookieHeader = '') {
  return requestStep(fetchFn, stepName, '/api/conversions/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify(payload),
  }, (body) => {
    if (!body?.data?.id) {
      throw new Error('响应缺少转化事件 ID')
    }
    if (body?.data?.actionType !== 'contact') {
      throw new Error(`响应 actionType 不匹配：${String(body?.data?.actionType || '')}`)
    }
    return `Contact 已写入，created=${String(body?.data?.created)}`
  })
}

async function postRegistration(fetchFn, payload, cookieHeader = '') {
  return requestStep(fetchFn, 'local-auth-register', '/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify(payload),
  }, (body) => {
    if (!Number.isInteger(body?.id) || Number(body.id) <= 0) throw new Error('注册响应缺少合法用户 ID')
    if (!Array.isArray(body?.trackingInstructions)) throw new Error('注册响应缺少浏览器追踪指令数组')
    return '真实注册 API 已创建用户和 CompleteRegistration 第一方事实'
  })
}

async function postAnalyticsBatch(fetchFn) {
  return requestStep(fetchFn, 'local-analytics-events', '/api/analytics/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Analytics-Visitor-Id': 'visitor_release_local_analytics',
      'X-Analytics-Session-Id': 'session_release_local_analytics',
    },
    body: JSON.stringify({
      visitorId: 'visitor_release_local_analytics',
      sessionId: 'session_release_local_analytics',
      events: [
        {
          eventId: 'event_release_local_page_view',
          eventName: 'page_view',
          occurredAt: new Date().toISOString(),
          routeName: '/gallery/:slug',
          path: '/gallery/release-local',
          entityType: 'gallery',
          entityId: 'gallery-release-local',
          sourceChannel: 'ad',
          sourceName: 'release-local-fb',
          trackingSourceSlug: 'release-local-fb',
          utmSource: 'release-local-fb',
          utmMedium: 'paid_social',
          utmCampaign: 'release-local-runtime',
          utmContent: 'release-local-chat',
        },
        {
          eventId: 'event_release_local_contact_click',
          eventName: 'contact_method_click',
          occurredAt: new Date().toISOString(),
          routeName: '/gallery/:slug',
          path: '/gallery/release-local',
          entityType: 'contact',
          entityId: 'floating_contact_panel',
          sourceChannel: 'ad',
          sourceName: 'release-local-fb',
          trackingSourceSlug: 'release-local-fb',
          utmSource: 'release-local-fb',
          utmMedium: 'paid_social',
          utmCampaign: 'release-local-runtime',
          utmContent: 'release-local-chat',
          props: {
            element_id: 'contact_method_click',
            element_type: 'button',
            location: 'floating_contact_panel',
            target_type: 'contact',
            target_id: 'floating_contact_panel',
            method_type: 'telegram',
          },
        },
        {
          eventId: 'event_release_local_register_success',
          eventName: 'register_success',
          occurredAt: new Date().toISOString(),
          routeName: 'register',
          path: '/register',
          entityType: 'auth',
          entityId: 'register-submit',
          sourceChannel: 'ad',
          sourceName: 'release-local-fb',
          trackingSourceSlug: 'release-local-fb',
          utmSource: 'release-local-fb',
          utmMedium: 'paid_social',
          utmCampaign: 'release-local-runtime',
          utmContent: 'release-local-chat',
        },
      ],
    }),
  }, (body) => {
    if (Number(body?.accepted ?? 0) < 3) {
      throw new Error(`analytics events accepted 不足：${String(body?.accepted ?? 0)}`)
    }
    if (Number(body?.rejected ?? 0) !== 0) {
      throw new Error(`analytics events rejected=${String(body?.rejected ?? 0)}`)
    }
    return `analytics events 已写入，accepted=${String(body.accepted)}`
  })
}

async function smokeAdminAnalytics(fetchFn, sessionToken) {
  return requestStep(fetchFn, 'local-admin-analytics', '/api/admin/analytics/funnel?range=7d&sourceCode=release-local-fb', {
    headers: {
      Cookie: `${SESSION_COOKIE}=${sessionToken}`,
    },
  }, (body) => {
    const stages = Array.isArray(body?.data?.stages) ? body.data.stages : []
    const pageViews = stages.find(stage => stage?.key === 'page_views')
    const keyClicks = stages.find(stage => stage?.key === 'key_clicks')
    const contactsOrRegisters = stages.find(stage => stage?.key === 'contacts_or_registers')
    if (Number(pageViews?.value ?? 0) < 1) throw new Error('analytics funnel page_views 未写入')
    if (Number(keyClicks?.value ?? 0) < 1) throw new Error('analytics funnel key_clicks 未写入')
    if (Number(contactsOrRegisters?.value ?? 0) < 2) throw new Error('analytics funnel contacts_or_registers 未写入')
    return `analytics funnel 可读，page_views=${pageViews.value}, key_clicks=${keyClicks.value}, contacts_or_registers=${contactsOrRegisters.value}`
  })
}

async function smokeAdminAttribution(fetchFn, sessionToken) {
  return requestStep(fetchFn, 'local-admin-attribution', '/api/admin/attribution/conversions?provider=meta&range=7d', {
    headers: {
      Cookie: `${SESSION_COOKIE}=${sessionToken}`,
    },
  }, (body) => {
    const rows = Array.isArray(body?.data?.bySource) ? body.data.bySource : []
    const matched = rows.find(row => String(row?.source_name || '') === 'release-local-fb')
    if (!matched) throw new Error('attribution conversions 未返回 release-local-fb')
    if (Number(matched.contact_count ?? 0) < 1) throw new Error('contact_count 未写入')
    if (Number(matched.complete_registration_count ?? 0) < 1) throw new Error('complete_registration_count 未写入')
    return `归因来源可读，contact=${matched.contact_count}, complete_registration=${matched.complete_registration_count}`
  })
}

async function smokeMetaDelivery(fetchFn, sessionToken) {
  return requestStep(fetchFn, 'local-meta-delivery', '/api/admin/attribution/meta?range=7d', {
    headers: {
      Cookie: `${SESSION_COOKIE}=${sessionToken}`,
    },
  }, (body) => {
    const settings = body?.data?.settings || {}
    const deliveries = Array.isArray(body?.data?.deliveries) ? body.data.deliveries : []
    if (settings.server_enabled !== false) throw new Error('本地 Meta Server 投递未关闭')
    if (deliveries.some(row => row?.provider === 'meta' && row?.transport === 'server')) throw new Error('Server 投递关闭时仍创建了 Meta delivery')
    return 'meta-server-delivery-disabled-in-local'
  })
}

async function requestStep(fetchFn, stepName, route, init, assertBody) {
  const startedAt = Date.now()
  const command = `${init?.method || 'GET'} ${route}`
  try {
    const response = await fetchFn(`${LOCAL_API_URL}${route}`, init)
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }

    if (!response.ok) {
      return {
        ...createStep(stepName),
        status: 'failed',
        durationMs: Date.now() - startedAt,
        command,
        exitCode: response.status,
        summary: truncateSummary(`HTTP ${response.status} ${typeof body === 'string' ? body : JSON.stringify(body)}`),
      }
    }

    const message = assertBody(body)
    return {
      ...createStep(stepName),
      status: 'passed',
      durationMs: Date.now() - startedAt,
      command,
      exitCode: response.status,
      summary: truncateSummary(message),
    }
  } catch (error) {
    return {
      ...createStep(stepName),
      status: 'failed',
      durationMs: Date.now() - startedAt,
      command,
      exitCode: null,
      summary: truncateSummary(error instanceof Error ? error.message : String(error)),
    }
  }
}

async function stopLocalApiWorker(server) {
  const child = server.child
  if (child.exitCode !== null) return

  child.kill('SIGTERM')
  const stopped = await waitForExit(child, 5_000)
  if (!stopped) {
    child.kill('SIGKILL')
    await waitForExit(child, 2_000)
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)

    const onExit = () => {
      cleanup()
      resolve(true)
    }

    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
    }

    child.once('exit', onExit)
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function truncateSummary(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  return compact.length > 600 ? `${compact.slice(0, 600)}...` : compact
}
