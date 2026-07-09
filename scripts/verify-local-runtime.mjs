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
]

export async function runLocalRuntimeVerification(options = {}) {
  const cwd = options.cwd || ROOT_DIR
  const runCommandFn = options.runCommand || runCommand
  const fetchFn = options.fetch || fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS
  const boundedFetch = (input, init) => fetchWithTimeout(fetchFn, input, init, requestTimeoutMs)
  const steps = []
  const notes = []
  const artifacts = [LOCAL_RUNTIME_DIR]
  const sessionToken = crypto.randomBytes(32).toString('hex')
  const sessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex')
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  let server = null
  let serverLogs = { stdout: '', stderr: '' }
  let startedServer = false

  try {
    const cleanStep = await cleanLocalRuntimeDir()
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
    if (sessionStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    server = startLocalApiWorker({ cwd, env: buildLocalDevEnv(options.env) })
    startedServer = true
    const healthStep = await waitForLocalApi(server, boundedFetch)
    serverLogs = healthStep.logs
    steps.push(cleanForReport(healthStep.step))
    if (healthStep.step.status !== 'passed') return { steps, notes, artifacts }

    const contactStep = await postConversion(boundedFetch, 'local-conversion-contact', {
      actionType: 'contact',
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
      consentState: 'limited',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {
        fbclid: 'release-local-fbclid',
        placement: 'local-runtime-smoke',
      },
    })
    steps.push(contactStep)
    if (contactStep.status !== 'passed') return { steps, notes, artifacts }

    const startTrialStep = await postConversion(boundedFetch, 'local-conversion-start-trial', {
      actionType: 'start_trial',
      visitorId: 'visitor_release_local',
      sessionId: 'session_release_local',
      occurredAt: new Date().toISOString(),
      routeName: 'pricing',
      path: '/membership',
      sourceChannel: 'ad',
      sourceName: 'release-local-fb',
      trackingSourceSlug: 'release-local-fb',
      utmSource: 'facebook',
      utmMedium: 'paid_social',
      utmCampaign: 'release-local-runtime',
      utmContent: 'release-local-chat',
      consentState: 'limited',
      actionTarget: 'membership-upgrade',
    })
    steps.push(startTrialStep)
    if (startTrialStep.status !== 'passed') return { steps, notes, artifacts }

    const completeRegistrationStep = await postConversion(boundedFetch, 'local-conversion-complete-registration', {
      actionType: 'complete_registration',
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
      consentState: 'limited',
      actionTarget: 'register-submit',
    })
    steps.push(completeRegistrationStep)
    if (completeRegistrationStep.status !== 'passed') return { steps, notes, artifacts }

    const analyticsIngestStep = await postAnalyticsBatch(boundedFetch)
    steps.push(analyticsIngestStep)
    if (analyticsIngestStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const analyticsStep = await smokeAdminAnalytics(boundedFetch, sessionToken)
    steps.push(analyticsStep)
    if (analyticsStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const attributionStep = await smokeAdminAttribution(boundedFetch, sessionToken)
    steps.push(attributionStep)
    if (attributionStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const metaStep = await smokeMetaDelivery(boundedFetch, sessionToken)
    steps.push(metaStep)
    if (metaStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    notes.push('meta-capi-disabled-in-local')
    return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }
  } finally {
    if (startedServer && server) {
      await stopLocalApiWorker(server)
      if (serverLogs.stdout || serverLogs.stderr) {
        notes.push(`local-api-log:${truncateSummary(`${serverLogs.stdout} ${serverLogs.stderr}`)}`)
      }
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

function startLocalApiWorker(options) {
  const args = [
    'pnpm', '--filter', '@meigallery/api', 'exec',
    'wrangler', 'dev',
    '--local',
    '--persist-to', LOCAL_RUNTIME_DIR_RELATIVE_TO_API,
    '--port', LOCAL_API_PORT,
    '--ip', '127.0.0.1',
    '--log-level', 'info',
    '--show-interactive-dev-session=false',
    ...DEFAULT_WRANGLER_VARS.flatMap(([key, value]) => ['--var', `${key}:${value}`]),
  ]

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

async function waitForLocalApi(server, fetchFn) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < LOCAL_SERVER_TIMEOUT_MS) {
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
      const body = await response.json()
      if (response.ok && body?.status === 'ok' && body?.db === 'ok') {
        return {
          logs: server.readLogs(),
          step: {
            ...createStep('local-api-health'),
            status: 'passed',
            durationMs: Date.now() - startedAt,
            command: `GET ${LOCAL_API_URL}/api/health`,
            exitCode: 0,
            summary: truncateSummary(`健康检查通过，db=${body.db}`),
          },
        }
      }
    } catch {
      // 继续轮询
    }

    await sleep(LOCAL_POLL_INTERVAL_MS)
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

async function postConversion(fetchFn, stepName, payload) {
  return requestStep(fetchFn, stepName, '/api/conversions/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, (body) => {
    if (!body?.data?.id) {
      throw new Error('响应缺少转化事件 ID')
    }
    if (body?.data?.actionType !== payload.actionType) {
      throw new Error(`响应 actionType 不匹配：${String(body?.data?.actionType || '')}`)
    }
    return `${payload.actionType} 已写入，created=${String(body?.data?.created)}`
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
  return requestStep(fetchFn, 'local-admin-attribution', '/api/admin/attribution/conversions?range=7d', {
    headers: {
      Cookie: `${SESSION_COOKIE}=${sessionToken}`,
    },
  }, (body) => {
    const rows = Array.isArray(body?.data?.bySource) ? body.data.bySource : []
    const matched = rows.find(row => String(row?.source_name || '') === 'release-local-fb')
    if (!matched) throw new Error('attribution conversions 未返回 release-local-fb')
    if (Number(matched.contact_count ?? 0) < 1) throw new Error('contact_count 未写入')
    if (Number(matched.complete_registration_count ?? 0) < 1) throw new Error('complete_registration_count 未写入')
    if (Number(matched.start_trial_count ?? 0) < 1) throw new Error('start_trial_count 未写入')
    return `归因来源可读，contact=${matched.contact_count}, complete_registration=${matched.complete_registration_count}, start_trial=${matched.start_trial_count}`
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
    const skippedDelivery = deliveries.find(row => (
      row?.channel === 'meta_capi' &&
      row?.status === 'skipped' &&
      row?.skip_reason === 'disabled'
    ))
    if (settings.meta_capi_enabled !== false) throw new Error('meta_capi_enabled 不是 false')
    if (!skippedDelivery) throw new Error('未发现 meta_capi skipped disabled 记录')
    return 'meta-capi-disabled-in-local'
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
