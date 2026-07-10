import crypto from 'node:crypto'
import { createStep, fetchWithTimeout, runCommand } from './release-verification-lib.mjs'

const SESSION_COOKIE = 'mei_session'
const DEV_DB_NAME = 'meigallery-db-dev'
const DEV_SEED_FILE_RELATIVE_TO_API = '../../scripts/fixtures/release-smoke/seed-dev.sql'
const REQUIRED_ENV_KEYS = ['VERIFY_DEV_API_URL', 'VERIFY_DEV_WEB_URL']
const LEGACY_DEV_WORKERS_SUBDOMAIN = '250770503'
const DEV_REQUEST_TIMEOUT_MS = 20_000
const META_POLL_TIMEOUT_MS = 30_000
const META_POLL_INTERVAL_MS = 1_000
const REQUIRED_META_EVENTS = ['Contact', 'Lead', 'CompleteRegistration']

export async function runDevRehearsalVerification(options = {}) {
  const cwd = options.cwd || process.cwd()
  const runCommandFn = options.runCommand || runCommand
  const fetchFn = options.fetch || fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? DEV_REQUEST_TIMEOUT_MS
  const boundedFetch = (input, init) => fetchWithTimeout(fetchFn, input, init, requestTimeoutMs)
  const env = options.env || process.env
  const apiUrl = readRequiredEnv(env, 'VERIFY_DEV_API_URL')
  const webUrl = readRequiredEnv(env, 'VERIFY_DEV_WEB_URL')
  const releaseCommit = String(options.releaseCommit || '').trim()
  if (!/^[0-9a-f]{40}$/i.test(releaseCommit)) throw new Error('dev rehearsal 需要 40 位 RELEASE_COMMIT')
  const steps = []
  const notes = []
  const artifacts = []
  const runSuffix = crypto.randomBytes(6).toString('hex')
  const sessionToken = crypto.randomBytes(32).toString('hex')
  const sessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex')
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const today = new Date().toISOString().slice(0, 10)
  let shouldCleanupDevSmokeOwner = false

  try {
    const migrateStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec',
      'wrangler', 'd1', 'migrations', 'apply', DEV_DB_NAME,
      '--env', 'dev',
      '--remote',
    ], {
      cwd,
      name: 'dev-d1-migrate',
    })
    steps.push(cleanForReport(migrateStep))
    if (migrateStep.status !== 'passed') return { steps, notes, artifacts }

    const seedStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec',
      'wrangler', 'd1', 'execute', DEV_DB_NAME,
      '--env', 'dev',
      '--remote',
      '--file', DEV_SEED_FILE_RELATIVE_TO_API,
      '--yes',
    ], {
      cwd,
      name: 'dev-d1-seed',
    })
    steps.push(cleanForReport(seedStep))
    if (seedStep.status !== 'passed') return { steps, notes, artifacts }
    shouldCleanupDevSmokeOwner = true

    const sessionSql = [
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)',
      `VALUES ('ses_release_dev_rehearsal', 1, '${sessionHash}', '${sessionExpiresAt}', datetime('now'))`,
      "ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at;",
    ].join(' ')
    const sessionStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec',
      'wrangler', 'd1', 'execute', DEV_DB_NAME,
      '--env', 'dev',
      '--remote',
      '--command', sessionSql,
      '--yes',
    ], {
      cwd,
      name: 'dev-session-seed',
      reportCommand: 'corepack pnpm --filter @meigallery/api exec wrangler d1 execute meigallery-db-dev --env dev --remote --command "INSERT INTO sessions (...)" --yes',
    })
    steps.push(cleanForReport(sessionStep))
    if (sessionStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const apiDeployStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec',
      'wrangler', 'deploy', '--env', 'dev', '--var', `RELEASE_COMMIT:${releaseCommit}`,
    ], {
      cwd,
      name: 'dev-api-deploy',
    })
    steps.push(cleanForReport(apiDeployStep))
    if (apiDeployStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const webDeployStep = await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/web', 'exec',
      'wrangler', 'deploy', '--env', 'dev', '--var', `RELEASE_COMMIT:${releaseCommit}`,
    ], {
      cwd,
      name: 'dev-web-deploy',
    })
    steps.push(cleanForReport(webDeployStep))
    if (webDeployStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const apiHealthStep = await requestJsonStep(boundedFetch, 'dev-api-health', `${apiUrl}/api/health`, {}, (body) => {
      if (body?.status !== 'ok') throw new Error(`健康检查 status 非 ok：${String(body?.status || '')}`)
      if (body?.db !== 'ok') throw new Error(`健康检查 db 非 ok：${String(body?.db || '')}`)
      return `健康检查通过，db=${body.db}`
    })
    steps.push(apiHealthStep)
    if (apiHealthStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const webHealthStep = await requestTextStep(boundedFetch, 'dev-web-health', webUrl, {}, (html) => {
      if (!/<div[^>]+id=["']__nuxt["']/i.test(html)) {
        throw new Error('页面未包含 Nuxt app root')
      }
      if (html.includes(LEGACY_DEV_WORKERS_SUBDOMAIN)) {
        throw new Error(`页面仍包含旧 dev workers 子域标识 ${LEGACY_DEV_WORKERS_SUBDOMAIN}`)
      }
      return 'Web 首页可访问，已检测到 Nuxt app root，且未发现旧 dev workers 子域'
    })
    steps.push(webHealthStep)
    if (webHealthStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const baselineResult = await readMetaDeliveryBaseline(boundedFetch, apiUrl, sessionToken, today)
    steps.push(baselineResult.step)
    if (baselineResult.step.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const conversionVisitorId = `visitor_release_dev_${runSuffix}`
    const conversionSessionId = `session_release_dev_${runSuffix}`

    const contactStep = await postConversion(boundedFetch, apiUrl, 'dev-conversion-contact', {
      actionType: 'contact',
      visitorId: conversionVisitorId,
      sessionId: conversionSessionId,
      occurredAt: new Date().toISOString(),
      routeName: 'gallery-detail',
      path: '/gallery/release-dev-gallery',
      sourceChannel: 'ad',
      sourceName: 'release-dev-fb',
      trackingSourceSlug: 'release-dev-fb',
      utmSource: 'release-dev-fb',
      utmMedium: 'paid_social',
      utmCampaign: 'release-dev-rehearsal',
      utmContent: 'release-dev-chat',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: `floating_contact_panel_${runSuffix}`,
      metadata: {
        fbclid: 'release-dev-fbclid',
        placement: 'dev-rehearsal-smoke',
      },
    })
    steps.push(contactStep)
    if (contactStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const completeRegistrationStep = await postConversion(boundedFetch, apiUrl, 'dev-conversion-complete-registration', {
      actionType: 'complete_registration',
      visitorId: conversionVisitorId,
      sessionId: conversionSessionId,
      occurredAt: new Date().toISOString(),
      routeName: 'register',
      path: '/register',
      sourceChannel: 'ad',
      sourceName: 'release-dev-fb',
      trackingSourceSlug: 'release-dev-fb',
      utmSource: 'release-dev-fb',
      utmMedium: 'paid_social',
      utmCampaign: 'release-dev-rehearsal',
      utmContent: 'release-dev-chat',
      consentState: 'granted',
      actionTarget: `register-submit_${runSuffix}`,
    })
    steps.push(completeRegistrationStep)
    if (completeRegistrationStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const analyticsIngestStep = await postAnalyticsBatch(boundedFetch, apiUrl, runSuffix)
    steps.push(analyticsIngestStep)
    if (analyticsIngestStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const analyticsStep = await requestJsonStep(
      boundedFetch,
      'dev-admin-analytics',
      `${apiUrl}/api/admin/analytics/funnel?from=${today}&to=${today}&sourceCode=release-dev-fb`,
      {
        headers: {
          Cookie: `${SESSION_COOKIE}=${sessionToken}`,
        },
      },
      (body) => {
        const stages = Array.isArray(body?.data?.stages) ? body.data.stages : []
        const pageViews = stages.find(stage => stage?.key === 'page_views')
        const keyClicks = stages.find(stage => stage?.key === 'key_clicks')
        const contactsOrRegisters = stages.find(stage => stage?.key === 'contacts_or_registers')
        if (Number(pageViews?.value ?? 0) < 1) throw new Error('analytics funnel page_views 未写入')
        if (Number(keyClicks?.value ?? 0) < 1) throw new Error('analytics funnel key_clicks 未写入')
        if (Number(contactsOrRegisters?.value ?? 0) < 2) throw new Error('analytics funnel contacts_or_registers 未写入')
        return `analytics 日期/来源查询通过，page_views=${pageViews.value}, key_clicks=${keyClicks.value}, contacts_or_registers=${contactsOrRegisters.value}`
      },
    )
    steps.push(analyticsStep)
    if (analyticsStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const attributionStep = await requestJsonStep(
      boundedFetch,
      'dev-admin-attribution',
      `${apiUrl}/api/admin/attribution/conversions?from=${today}&to=${today}&sourceCode=release-dev-fb`,
      {
        headers: {
          Cookie: `${SESSION_COOKIE}=${sessionToken}`,
        },
      },
      (body) => {
        const rows = Array.isArray(body?.data?.bySource) ? body.data.bySource : []
        if (rows.length === 0) throw new Error('attribution conversions 未返回任何来源数据')
        const matched = rows.find(row => String(row?.source_name || '') === 'release-dev-fb')
        if (!matched) throw new Error('attribution conversions 未返回 release-dev-fb')
        if (!rows.every(row => String(row?.source_name || '') === 'release-dev-fb')) {
          throw new Error('attribution conversions 返回了非 release-dev-fb 的来源数据')
        }
        if (Number(matched.contact_count ?? 0) < 1) throw new Error('contact_count 未写入')
        if (Number(matched.complete_registration_count ?? 0) < 1) throw new Error('complete_registration_count 未写入')
        return `归因来源查询通过，contact=${matched.contact_count}, complete_registration=${matched.complete_registration_count}`
      },
    )
    steps.push(attributionStep)
    if (attributionStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const metaDeliveryStep = await pollMetaDeliveries(boundedFetch, apiUrl, sessionToken, today, {
      timeoutMs: options.pollTimeoutMs ?? META_POLL_TIMEOUT_MS,
      intervalMs: options.pollIntervalMs ?? META_POLL_INTERVAL_MS,
      baseline: baselineResult.counts,
    })
    steps.push(metaDeliveryStep)
    if (metaDeliveryStep.status !== 'passed') return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }

    const metaStep = await requestJsonStep(
      boundedFetch,
      'dev-meta-test-event',
      `${apiUrl}/api/admin/attribution/meta/test-event`,
      {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE}=${sessionToken}`,
        },
      },
      (body) => {
        const data = body?.data || {}
        if (data.status !== 'sent') throw new Error(`Meta Test Event status 非 sent：${String(data.status || 'missing')}`)
        if (data.eventsReceived !== 1) throw new Error(`Meta Test Event eventsReceived 非 1：${String(data.eventsReceived ?? 'missing')}`)
        if (data.testEventCodePresent !== true) throw new Error('Meta Test Event 缺少 Test Event Code')
        return 'Meta Test Event 已由 Meta 确认接收 1 条事件'
      },
    )
    steps.push(metaStep)

    return { steps, notes, artifacts, sensitiveValues: [sessionToken, sessionHash] }
  } finally {
    if (shouldCleanupDevSmokeOwner) {
      const cleanupSql = [
        "DELETE FROM sessions WHERE id = 'ses_release_dev_rehearsal';",
        "UPDATE users SET status = 'disabled', updated_at = datetime('now') WHERE id = 1 AND email = 'release-dev-owner@example.test';",
      ].join(' ')
      const cleanupStep = await runCommandFn('corepack', [
        'pnpm', '--filter', '@meigallery/api', 'exec',
        'wrangler', 'd1', 'execute', DEV_DB_NAME,
        '--env', 'dev',
        '--remote',
        '--command', cleanupSql,
        '--yes',
      ], {
        cwd,
        name: 'dev-smoke-owner-cleanup',
        reportCommand: 'corepack pnpm --filter @meigallery/api exec wrangler d1 execute meigallery-db-dev --env dev --remote --command "DELETE smoke session; disable release-dev-owner" --yes',
      })
      steps.push(cleanForReport(cleanupStep))
      if (cleanupStep.status === 'passed') notes.push('dev-smoke-owner-disabled-after-run')
    }
  }
}

function readRequiredEnv(env, key) {
  const value = String(env?.[key] || '').trim()
  if (!value) {
    throw new Error(`缺少必需环境变量 ${key}，请先导出实际 dev Worker HTTPS 地址后重试。必需变量：${REQUIRED_ENV_KEYS.join(', ')}`)
  }
  return value.replace(/\/+$/, '')
}

function cleanForReport(step) {
  const { stdout, stderr, logs, ...rest } = step
  return rest
}

async function postConversion(fetchFn, apiUrl, stepName, payload) {
  return requestJsonStep(fetchFn, stepName, `${apiUrl}/api/conversions/events`, {
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
    if (body?.data?.created !== true) {
      throw new Error(`${payload.actionType} 响应 created 非 true`)
    }
    return `${payload.actionType} 已写入，created=${String(body?.data?.created)}`
  })
}

async function postAnalyticsBatch(fetchFn, apiUrl, runSuffix) {
  const visitorId = `visitor_release_dev_analytics_${runSuffix}`
  const sessionId = `session_release_dev_analytics_${runSuffix}`
  return requestJsonStep(fetchFn, 'dev-analytics-events', `${apiUrl}/api/analytics/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Analytics-Visitor-Id': visitorId,
      'X-Analytics-Session-Id': sessionId,
    },
    body: JSON.stringify({
      visitorId,
      sessionId,
      events: [
        {
          eventId: `event_release_dev_page_view_${runSuffix}`,
          eventName: 'page_view',
          occurredAt: new Date().toISOString(),
          routeName: '/gallery/:slug',
          path: '/gallery/release-dev-gallery',
          entityType: 'gallery',
          entityId: 'gallery-release-dev',
          sourceChannel: 'ad',
          sourceName: 'release-dev-fb',
          trackingSourceSlug: 'release-dev-fb',
          utmSource: 'release-dev-fb',
          utmMedium: 'paid_social',
          utmCampaign: 'release-dev-rehearsal',
          utmContent: 'release-dev-chat',
        },
        {
          eventId: `event_release_dev_contact_click_${runSuffix}`,
          eventName: 'contact_method_click',
          occurredAt: new Date().toISOString(),
          routeName: '/gallery/:slug',
          path: '/gallery/release-dev-gallery',
          entityType: 'contact',
          entityId: 'floating_contact_panel',
          sourceChannel: 'ad',
          sourceName: 'release-dev-fb',
          trackingSourceSlug: 'release-dev-fb',
          utmSource: 'release-dev-fb',
          utmMedium: 'paid_social',
          utmCampaign: 'release-dev-rehearsal',
          utmContent: 'release-dev-chat',
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
          eventId: `event_release_dev_register_success_${runSuffix}`,
          eventName: 'register_success',
          occurredAt: new Date().toISOString(),
          routeName: 'register',
          path: '/register',
          entityType: 'auth',
          entityId: 'register-submit',
          sourceChannel: 'ad',
          sourceName: 'release-dev-fb',
          trackingSourceSlug: 'release-dev-fb',
          utmSource: 'release-dev-fb',
          utmMedium: 'paid_social',
          utmCampaign: 'release-dev-rehearsal',
          utmContent: 'release-dev-chat',
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

async function pollMetaDeliveries(fetchFn, apiUrl, sessionToken, today, options) {
  const startedAt = Date.now()
  const url = `${apiUrl}/api/admin/attribution/meta?from=${today}&to=${today}`
  const command = `GET ${url}`
  let lastSummary = '尚未返回 delivery 数据'

  while (Date.now() - startedAt <= options.timeoutMs) {
    try {
      const response = await fetchFn(url, {
        headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
      })
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      if (!response.ok) {
        return {
          ...createStep('dev-meta-capi-deliveries'),
          status: 'failed',
          durationMs: Date.now() - startedAt,
          command,
          exitCode: response.status,
          summary: truncateSummary(`HTTP ${response.status}`),
        }
      }

      if (!Array.isArray(body?.data?.deliveries)) throw new Error('Meta delivery 响应缺少 deliveries')
      const counts = countSentMetaEvents(body.data.deliveries)
      if (REQUIRED_META_EVENTS.every(eventName => counts[eventName] >= options.baseline[eventName] + 1)) {
        return {
          ...createStep('dev-meta-capi-deliveries'),
          status: 'passed',
          durationMs: Date.now() - startedAt,
          command,
          exitCode: response.status,
          summary: REQUIRED_META_EVENTS.map(eventName => `${eventName}=${counts[eventName]} (+${counts[eventName] - options.baseline[eventName]})`).join(', '),
        }
      }
      lastSummary = REQUIRED_META_EVENTS.map(eventName => `${eventName}=${counts[eventName]}`).join(', ')
    } catch (error) {
      lastSummary = error instanceof Error ? error.message : String(error)
    }

    if (Date.now() - startedAt >= options.timeoutMs) break
    if (options.intervalMs > 0) await new Promise(resolve => setTimeout(resolve, options.intervalMs))
  }

  return {
    ...createStep('dev-meta-capi-deliveries'),
    status: 'failed',
    durationMs: Date.now() - startedAt,
    command,
    exitCode: null,
    summary: truncateSummary(`30 秒内未等到三事件 CAPI sent 基线增量：${lastSummary}`),
  }
}

async function readMetaDeliveryBaseline(fetchFn, apiUrl, sessionToken, today) {
  const startedAt = Date.now()
  const url = `${apiUrl}/api/admin/attribution/meta?from=${today}&to=${today}`
  const command = `GET ${url}`
  try {
    const response = await fetchFn(url, {
      headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
    })
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!Array.isArray(body?.data?.deliveries)) throw new Error('Meta delivery 基线响应缺少 deliveries')
    const counts = countSentMetaEvents(body.data.deliveries)
    return {
      counts,
      step: {
        ...createStep('dev-meta-capi-baseline'),
        status: 'passed',
        durationMs: Date.now() - startedAt,
        command,
        exitCode: response.status,
        summary: REQUIRED_META_EVENTS.map(eventName => `${eventName}=${counts[eventName]}`).join(', '),
      },
    }
  } catch (error) {
    return {
      counts: Object.fromEntries(REQUIRED_META_EVENTS.map(eventName => [eventName, 0])),
      step: {
        ...createStep('dev-meta-capi-baseline'),
        status: 'failed',
        durationMs: Date.now() - startedAt,
        command,
        exitCode: null,
        summary: truncateSummary(error instanceof Error ? error.message : String(error)),
      },
    }
  }
}

function countSentMetaEvents(deliveries) {
  const counts = Object.fromEntries(REQUIRED_META_EVENTS.map(eventName => [eventName, 0]))
  if (!Array.isArray(deliveries)) return counts
  for (const delivery of deliveries) {
    const eventName = String(delivery?.event_name || delivery?.eventName || '')
    const channel = String(delivery?.channel || '')
    const status = String(delivery?.status || '')
    if (!Object.hasOwn(counts, eventName) || channel !== 'meta_capi' || status !== 'sent') continue
    counts[eventName] += Number(delivery?.delivery_count ?? delivery?.deliveryCount ?? 1) || 0
  }
  return counts
}

async function requestJsonStep(fetchFn, stepName, url, init, assertBody) {
  return requestStep(fetchFn, stepName, url, init, async (response) => {
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    const message = response.ok ? assertBody(body) : ''
    return {
      body,
      message,
    }
  })
}

async function requestTextStep(fetchFn, stepName, url, init, assertBody) {
  return requestStep(fetchFn, stepName, url, init, async (response) => {
    const body = await response.text()
    const message = response.ok ? assertBody(body) : ''
    return {
      body,
      message,
    }
  })
}

async function requestStep(fetchFn, stepName, url, init, readBody) {
  const startedAt = Date.now()
  const command = `${init?.method || 'GET'} ${url}`
  try {
    const response = await fetchFn(url, init)
    const { body, message } = await readBody(response)

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

function truncateSummary(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  return compact.length > 600 ? `${compact.slice(0, 600)}...` : compact
}
