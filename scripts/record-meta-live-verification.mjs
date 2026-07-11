#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import {
  assertMetaLiveEvidenceCanGateProduction,
  META_LIVE_EVENTS,
  writeMetaLiveEvidence,
} from './meta-live-verification-lib.mjs'
import { fetchWithTimeout, runCommand } from './release-verification-lib.mjs'

const YES_VALUES = new Set(['y', 'yes', '是'])
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000
const VERIFY_TIMEOUT_MS = 20_000
const REQUIRED_VERIFY_URLS = ['VERIFY_DEV_API_URL', 'VERIFY_DEV_WEB_URL']
const OPAQUE_EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{16,160}$/
const SESSION_TTL_MS = 60 * 60 * 1000
const SESSION_DIR = new URL('../reports/meta-live-verification/', import.meta.url)

export function buildMetaLiveEvidence(input) {
  const pixelId = String(input?.pixelId || '').trim()
  const commit = String(input?.commit || '').trim()
  const environment = String(input?.environment || '')
  const capturedAt = new Date(input?.now ?? Date.now())
  const connectionVerifiedAt = new Date(input?.connectionVerifiedAt)
  const eventResults = Array.isArray(input?.eventResults) ? input.eventResults : []

  if (!/^\d{5,30}$/.test(pixelId)) throw new Error('测试 Pixel ID 必须为 5 到 30 位数字')
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('当前 commit 必须为 40 位 SHA')
  if (input?.commitSha !== commit) throw new Error('readiness commit 与当前 commit 不一致')
  if (environment !== 'dev') throw new Error('live evidence 只接受 dev readiness')
  if (Number.isNaN(capturedAt.getTime()) || Number.isNaN(connectionVerifiedAt.getTime())) throw new Error('验证时间非法')
  if (connectionVerifiedAt.getTime() > capturedAt.getTime()) throw new Error('连接验证时间晚于 evidence capture')

  const resultMap = new Map(eventResults.map(result => [result?.eventName, result]))
  if (eventResults.length !== META_LIVE_EVENTS.length || resultMap.size !== META_LIVE_EVENTS.length) {
    throw new Error('必须录入固定两事件的验证结果')
  }

  const events = META_LIVE_EVENTS.map(eventName => {
    const result = resultMap.get(eventName)
    const browserEventId = String(result?.browserEventId || '')
    const serverEventId = String(result?.serverEventId || '')
    if (!isOpaqueSyntheticEventId(browserEventId) || !isOpaqueSyntheticEventId(serverEventId)) {
      throw new Error(`${eventName} event ID 必须是本次合成验证的 opaque/non-PII 值`)
    }
    if (browserEventId !== serverEventId) throw new Error(`${eventName} Browser/Server event ID 不一致`)
    if (result?.browserSeen !== true) throw new Error(`${eventName} 未确认 Browser event`)
    if (result?.serverSeen !== true) throw new Error(`${eventName} 未确认 Server event`)
    if (result?.deduplicated !== true) throw new Error(`${eventName} 未确认去重`)
    if (result?.eventsReceived !== 1) throw new Error(`${eventName} eventsReceived 必须为 1`)

    const eventIdDigest = digestEventId(browserEventId)

    return {
      eventName,
      browserEventId: eventIdDigest,
      serverEventId: eventIdDigest,
      browserSeen: true,
      serverSeen: true,
      deduplicated: true,
      eventsReceived: 1,
    }
  })

  const evidence = {
    schemaVersion: 2,
    commitSha: commit.toLowerCase(),
    environment,
    pixelIdMasked: `${pixelId.slice(0, 4)}****${pixelId.slice(-4)}`,
    connectionVerifiedAt: connectionVerifiedAt.toISOString(),
    capturedAt: capturedAt.toISOString(),
    expiresAt: new Date(capturedAt.getTime() + EVIDENCE_TTL_MS).toISOString(),
    events,
    enhancedMatch: input?.enhancedMatch,
    forbiddenEventsAbsent: input?.forbiddenEventsAbsent,
    datasetQualityContractVersion: input?.datasetQualityContractVersion,
    datasetQualityCollectorCurrent: input?.datasetQualityCollectorCurrent,
  }
  assertMetaLiveEvidenceCanGateProduction(evidence, {
    expectedCommit: commit,
    expectedEnvironment: 'dev',
    now: capturedAt,
  })
  return evidence
}

export async function recordMetaLiveVerification(options = {}) {
  const ask = options.ask || createCliPrompter()
  const output = options.output || console.log
  const getCommit = options.getCommit || readCurrentCommit
  const writeEvidence = options.writeEvidence || writeMetaLiveEvidence
  const readReadiness = options.readReadiness || readDevMetaLiveReadiness
  const createSession = options.createSession || createMetaLiveRecordingSession
  const destroySession = options.destroySession || destroyMetaLiveRecordingSession
  const commit = await getCommit(options)
  await verifyDevReleaseIdentity({ ...options, commit })
  const readiness = await readReadiness({ ...options, commit })
  assertReadinessCanRecord(readiness, commit)
  const session = await createSession({ ...options, commit, environment: 'dev' })

  try {
    assertRecordingSession(session, commit, options.now)
    const eventResults = []
    for (const eventName of META_LIVE_EVENTS) {
      const browserEventId = await ask(`${eventName} Browser event ID：`, { hidden: true })
      const serverEventId = await ask(`${eventName} Server event ID：`, { hidden: true })
      if (browserEventId !== session.eventIds[eventName] || serverEventId !== session.eventIds[eventName]) {
        throw new Error(`${eventName} 不是本次录入会话的预期 event ID`)
      }
      const browserSeen = isYes(await ask(`${eventName} 已在 Events Manager 确认 Browser event？(yes/no)：`, { hidden: false }))
      const serverSeen = isYes(await ask(`${eventName} 已在 Events Manager 确认 Server event？(yes/no)：`, { hidden: false }))
      const deduplicated = isYes(await ask(`${eventName} 已在 Events Manager 确认去重？(yes/no)：`, { hidden: false }))
      const eventsReceived = isYes(await ask(`${eventName} 已确认 Meta events_received=1？(yes/no)：`, { hidden: false })) ? 1 : 0
      eventResults.push({ eventName, browserEventId, serverEventId, browserSeen, serverSeen, deduplicated, eventsReceived })
    }

    const leadAbsent = isYes(await ask('已确认 Test Events 中没有 Lead？(yes/no)：', { hidden: false }))
    const startTrialAbsent = isYes(await ask('已确认 Test Events 中没有 StartTrial？(yes/no)：', { hidden: false }))
    const evidence = buildMetaLiveEvidence({
      ...readiness,
      eventResults,
      forbiddenEventsAbsent: { Lead: leadAbsent, StartTrial: startTrialAbsent },
      commit,
      now: options.now,
    })
    const files = await writeEvidence(evidence, {
      ...options,
      expectedCommit: commit,
      expectedEnvironment: 'dev',
      now: options.now,
    })
    output(`Meta live evidence 已写入：${files.evidenceFile}`)
    return { evidence, ...files }
  } finally {
    await destroySession(session, options)
  }
}

export async function createMetaLiveRecordingSession(options = {}) {
  const commit = String(options.commit || '').trim().toLowerCase()
  const environment = String(options.environment || '')
  const createdAt = new Date(options.now ?? Date.now())
  if (!/^[0-9a-f]{40}$/.test(commit) || environment !== 'dev' || Number.isNaN(createdAt.getTime())) {
    throw new Error('无法创建 Meta live 录入会话')
  }
  const challengeId = `challenge_${randomBytes(16).toString('hex')}`
  const nonce = randomBytes(32).toString('hex')
  const eventIds = Object.fromEntries(META_LIVE_EVENTS.map(eventName => [
    eventName,
    `meta_verify_${eventName.toLowerCase()}_${randomBytes(16).toString('hex')}`,
  ]))
  const session = {
    challengeId,
    nonce,
    commitSha: commit,
    environment,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + SESSION_TTL_MS).toISOString(),
    eventIds,
  }
  const reportDir = options.reportDir instanceof URL ? options.reportDir : options.reportDir || SESSION_DIR
  const directory = reportDir instanceof URL ? reportDir : path.resolve(reportDir)
  await mkdir(directory, { recursive: true })
  const sessionFile = path.join(directory instanceof URL ? directory.pathname : directory, `.session-${challengeId}.json`)
  await writeFile(sessionFile, JSON.stringify(session), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return { ...session, sessionFile }
}

export async function destroyMetaLiveRecordingSession(session) {
  if (typeof session?.sessionFile === 'string' && session.sessionFile) {
    await unlink(session.sessionFile).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

function assertRecordingSession(session, commit, nowValue) {
  const now = new Date(nowValue ?? Date.now()).getTime()
  const createdAt = new Date(session?.createdAt).getTime()
  const expiresAt = new Date(session?.expiresAt).getTime()
  if (!/^challenge_[0-9a-f]{16,64}$/.test(String(session?.challengeId || ''))
    || !/^[0-9a-f]{16,128}$/.test(String(session?.nonce || ''))
    || session?.commitSha !== commit.toLowerCase()
    || session?.environment !== 'dev'
    || !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || expiresAt - createdAt !== SESSION_TTL_MS
    || now < createdAt
    || now >= expiresAt) {
    throw new Error('Meta live 录入会话无效或已过期')
  }
  for (const eventName of META_LIVE_EVENTS) {
    if (!isOpaqueSyntheticEventId(String(session?.eventIds?.[eventName] || ''))) {
      throw new Error('Meta live 录入会话缺少预期 event ID')
    }
  }
}

export async function readDevMetaLiveReadiness(options = {}) {
  const commit = String(options.commit || '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('readiness 查询需要当前 40 位 commit')
  const runCommandFn = options.runCommand || runCommand
  const sql = `
    WITH quality AS (
      SELECT contract_version, COUNT(DISTINCT event_name) AS event_count,
        MIN(CASE WHEN collection_status = 'success' AND datetime(collected_at) > datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS collector_current
      FROM meta_dataset_quality_snapshots
      WHERE environment = 'dev'
        AND collected_at = (SELECT MAX(q2.collected_at) FROM meta_dataset_quality_snapshots q2 WHERE q2.environment = 'dev' AND q2.event_name = meta_dataset_quality_snapshots.event_name)
      GROUP BY contract_version
      ORDER BY contract_version DESC
      LIMIT 1
    ), matching AS (
      SELECT
        MAX(CASE WHEN event_name = 'CompleteRegistration' AND has_email = 1 THEN 1 ELSE 0 END) AS registration_email,
        MAX(CASE WHEN event_name = 'CompleteRegistration' AND has_external_id = 1 THEN 1 ELSE 0 END) AS registration_external_id,
        MAX(CASE WHEN event_name = 'Contact' AND (has_email = 1 OR has_external_id = 1) THEN 1 ELSE 0 END) AS contact_registration_identity
      FROM analytics_conversion_deliveries
      WHERE channel = 'meta_capi' AND status = 'sent'
    )
    SELECT c.environment, c.pixel_id, c.verified_commit, c.verified_at AS connection_verified_at,
      matching.registration_email, matching.registration_external_id, matching.contact_registration_identity,
      quality.contract_version, CASE WHEN quality.event_count = 2 AND quality.collector_current = 1 THEN 1 ELSE 0 END AS collector_current
    FROM meta_connection_verifications c CROSS JOIN matching LEFT JOIN quality ON 1 = 1
    WHERE c.environment = 'dev' AND c.verified_commit = '${commit}' AND c.invalidated_at IS NULL
    LIMIT 1
  `.replace(/\s+/g, ' ').trim()
  const step = await runCommandFn('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'd1', 'execute', 'meigallery-db-dev',
    '--env', 'dev', '--remote', '--command', sql, '--json',
  ], {
    cwd: options.cwd || process.cwd(),
    name: 'meta-live-dev-readiness',
    reportCommand: '读取 dev D1 Meta live readiness 脱敏布尔摘要',
  })
  if (step.status !== 'passed') throw new Error('dev Meta live readiness 查询失败')
  const rows = parseD1Rows(step.stdout)
  if (rows.length !== 1) throw new Error('dev Meta live readiness 不完整')
  const row = rows[0]
  return {
    environment: row.environment,
    commitSha: String(row.verified_commit || '').toLowerCase(),
    pixelId: String(row.pixel_id || ''),
    connectionVerifiedAt: row.connection_verified_at,
    enhancedMatch: {
      completeRegistrationEmail: row.registration_email === 1,
      completeRegistrationExternalId: row.registration_external_id === 1,
      contactContainsRegistrationIdentity: row.contact_registration_identity !== 0,
    },
    datasetQualityContractVersion: Number(row.contract_version || 0),
    datasetQualityCollectorCurrent: row.collector_current === 1,
  }
}

export async function verifyDevReleaseIdentity(options = {}) {
  const commit = String(options.commit || '').trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('本地 Git HEAD 必须为 40 位 SHA')

  const env = options.env || process.env
  const apiOrigin = readRequiredVerifyOrigin(env, 'VERIFY_DEV_API_URL')
  const webOrigin = readRequiredVerifyOrigin(env, 'VERIFY_DEV_WEB_URL')
  const fetchFn = options.fetch || fetch
  const timeoutMs = options.requestTimeoutMs ?? VERIFY_TIMEOUT_MS

  await Promise.all([
    requestReleaseIdentity(fetchFn, new URL('/api/health', apiOrigin), 'API', commit, timeoutMs),
    requestReleaseIdentity(fetchFn, new URL('/__release', webOrigin), 'Web', commit, timeoutMs),
  ])
}

function readRequiredVerifyOrigin(env, key) {
  const value = String(env?.[key] || '').trim()
  if (!value) throw new Error(`缺少必需环境变量 ${key}；必需变量：${REQUIRED_VERIFY_URLS.join(', ')}`)

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${key} 必须是合法的 dev Worker HTTPS 地址`)
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${key} 必须是不含凭证的 dev Worker HTTPS 地址`)
  }
  return url.origin
}

async function requestReleaseIdentity(fetchFn, url, serviceName, expectedCommit, timeoutMs) {
  let response
  try {
    response = await fetchWithTimeout(fetchFn, url, { headers: { Accept: 'application/json' } }, timeoutMs)
  } catch {
    throw new Error(`${serviceName} 发布身份端点请求失败`)
  }
  if (!response.ok) throw new Error(`${serviceName} 发布身份端点不可用（HTTP ${response.status}）`)

  let body
  try {
    body = await response.json()
  } catch {
    throw new Error(`${serviceName} 发布身份端点未返回合法 JSON`)
  }
  if (body?.status !== 'ok') throw new Error(`${serviceName} 发布身份状态非 ok`)
  if (body?.environment !== 'dev') throw new Error(`${serviceName} 发布环境不是 dev`)
  const deployedCommit = String(body?.commit || '').trim()
  if (!/^[0-9a-f]{40}$/i.test(deployedCommit)) throw new Error(`${serviceName} 发布 commit 缺失或非法`)
  if (deployedCommit !== expectedCommit) throw new Error(`${serviceName} 发布 commit 与本地 Git HEAD 不一致`)
}

function digestEventId(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function isOpaqueSyntheticEventId(value) {
  if (!OPAQUE_EVENT_ID_PATTERN.test(value) || value.includes('@') || /\bfb\.1\./i.test(value)) return false
  return isIP(value) === 0 && !/(?:access[_-]?token|test[_-]?event[_-]?code|client[_-]?ip)/i.test(value)
}

function assertReadinessCanRecord(readiness, commit) {
  if (!Number.isSafeInteger(readiness?.datasetQualityContractVersion)
    || readiness.datasetQualityContractVersion < 1
    || readiness?.datasetQualityCollectorCurrent !== true) {
    throw new Error('dev Dataset Quality contract/collector readiness 未通过')
  }
  buildMetaLiveEvidence({
    ...readiness,
    commit,
    now: readiness.connectionVerifiedAt,
    forbiddenEventsAbsent: { Lead: true, StartTrial: true },
    eventResults: META_LIVE_EVENTS.map((eventName, index) => ({
      eventName,
      browserEventId: `meta_verify_preflight_${index}_0123456789abcdef`,
      serverEventId: `meta_verify_preflight_${index}_0123456789abcdef`,
      browserSeen: true,
      serverSeen: true,
      deduplicated: true,
      eventsReceived: 1,
    })),
  })
}

function parseD1Rows(stdout) {
  const text = String(stdout || '').trim()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('dev Meta live readiness JSON 非法')
  }
  if (!Array.isArray(payload) || payload.length !== 1 || !Array.isArray(payload[0]?.results)) {
    throw new Error('dev Meta live readiness JSON envelope 非法')
  }
  return payload[0].results
}

function isYes(value) {
  return YES_VALUES.has(String(value || '').trim().toLowerCase())
}

async function readCurrentCommit(options = {}) {
  const runCommandFn = options.runCommand || runCommand
  const step = await runCommandFn('git', ['rev-parse', 'HEAD'], {
    cwd: options.cwd || process.cwd(),
    name: 'git-commit',
  })
  if (step.status !== 'passed') throw new Error('无法读取当前 Git commit')
  return String(step.stdout || '').trim()
}

function createCliPrompter() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    return async prompt => readline.question(prompt)
  }

  return (prompt, { hidden }) => new Promise((resolve, reject) => {
    let answer = ''
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdout.write('\n')
    }
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('用户取消录入'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(answer)
          return
        }
        if (character === '\u007f' || character === '\b') {
          if (answer.length > 0) answer = answer.slice(0, -1)
          if (!hidden) process.stdout.write('\b \b')
          continue
        }
        answer += character
        if (!hidden) process.stdout.write(character)
      }
    }
    process.stdin.on('data', onData)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await recordMetaLiveVerification()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
