#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import {
  assertMetaLiveEvidenceCanGateProduction,
  META_LIVE_EVENTS,
  writeMetaLiveEvidence,
} from './meta-live-verification-lib.mjs'
import { fetchWithTimeout, runCommand } from './release-verification-lib.mjs'
import { verifyApprovedMetaDatasetQualityContract } from './meta-dataset-quality-contract-lib.mjs'

const YES_VALUES = new Set(['y', 'yes', '是'])
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000
const VERIFY_TIMEOUT_MS = 20_000
const REQUIRED_VERIFY_URLS = ['VERIFY_PRODUCTION_API_URL', 'VERIFY_PRODUCTION_WEB_URL']
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const CHALLENGE_PATTERN = /^mlc_[0-9a-f]{32}$/

export function buildMetaLiveEvidence(input) {
  const pixelId = String(input?.pixelId || '').trim()
  const commit = String(input?.commit || '').trim().toLowerCase()
  const capturedAt = new Date(input?.now ?? Date.now())
  const connectionVerifiedAt = new Date(input?.connectionVerifiedAt)
  const eventResults = Array.isArray(input?.eventResults) ? input.eventResults : []
  if (!/^\d{5,30}$/.test(pixelId)) throw new Error('测试 Pixel ID 必须为 5 到 30 位数字')
  if (!/^[0-9a-f]{40}$/.test(commit) || input?.commitSha !== commit) throw new Error('readiness commit 与当前 commit 不一致')
  if (input?.environment !== 'production') throw new Error('live evidence 只接受 production readiness')
  if (!Number.isFinite(capturedAt.getTime()) || !Number.isFinite(connectionVerifiedAt.getTime())) throw new Error('验证时间非法')
  const resultMap = new Map(eventResults.map(result => [result?.eventName, result]))
  if (eventResults.length !== 2 || resultMap.size !== 2) throw new Error('必须录入固定两事件的验证结果')

  const events = META_LIVE_EVENTS.map(eventName => {
    const result = resultMap.get(eventName)
    const digest = String(result?.eventIdDigest || '')
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`${eventName} 缺少 Worker challenge 不可逆摘要`)
    if (result?.browserSeen !== true || result?.serverSeen !== true || result?.deduplicated !== true || result?.eventsReceived !== 1) {
      throw new Error(`${eventName} Browser/Server/去重确认不完整`)
    }
    return {
      eventName,
      browserEventId: digest,
      serverEventId: digest,
      browserSeen: true,
      serverSeen: true,
      deduplicated: true,
      eventsReceived: 1,
    }
  })
  const evidence = {
    schemaVersion: 2,
    commitSha: commit,
    environment: 'production',
    pixelIdMasked: `${pixelId.slice(0, 4)}****${pixelId.slice(-4)}`,
    connectionVerifiedAt: connectionVerifiedAt.toISOString(),
    capturedAt: capturedAt.toISOString(),
    expiresAt: new Date(capturedAt.getTime() + EVIDENCE_TTL_MS).toISOString(),
    events,
    enhancedMatch: input.enhancedMatch,
    forbiddenEventsAbsent: input.forbiddenEventsAbsent,
    datasetQualityContractVersion: input.datasetQualityContractVersion,
    datasetQualityCollectorCurrent: input.datasetQualityCollectorCurrent,
  }
  assertMetaLiveEvidenceCanGateProduction(evidence, { expectedCommit: commit, expectedEnvironment: 'production', now: capturedAt })
  return evidence
}

export async function recordMetaLiveVerification(options = {}) {
  const getCommit = options.getCommit || readCurrentCommit
  const writeEvidence = options.writeEvidence || writeMetaLiveEvidence
  const readReadiness = options.readReadiness || readProductionMetaLiveReadiness
  const destroyChallenge = options.destroyChallenge || destroyRemoteChallenge
  const commit = await getCommit(options)
  const contract = await (options.verifyContract || verifyApprovedMetaDatasetQualityContract)({ cwd: options.cwd || process.cwd() })
  await verifyProductionReleaseIdentity({ ...options, commit })
  const readiness = await readReadiness({ ...options, commit, expectedDatasetQualityContract: contract })
  assertReadinessCanRecord(readiness, commit, options.now, contract)
  const ask = options.ask || createCliPrompter()

  try {
    const eventResults = []
    for (const eventName of META_LIVE_EVENTS) {
      const browserSeen = isYes(await ask(`${eventName} 已在 Events Manager 确认 Browser event？(yes/no)：`))
      const serverSeen = isYes(await ask(`${eventName} 已在 Events Manager 确认 Server event？(yes/no)：`))
      const deduplicated = isYes(await ask(`${eventName} 已确认 Browser/Server 去重为 1 条？(yes/no)：`))
      const eventsReceived = isYes(await ask(`${eventName} 已确认事件计数为 1？(yes/no)：`)) ? 1 : 0
      eventResults.push({
        eventName,
        eventIdDigest: readiness.eventDigests[eventName],
        browserSeen,
        serverSeen,
        deduplicated,
        eventsReceived,
      })
    }
    const forbiddenEventsAbsent = {
      Lead: isYes(await ask('已确认 Test Events 中没有 Lead？(yes/no)：')),
      StartTrial: isYes(await ask('已确认 Test Events 中没有 StartTrial？(yes/no)：')),
    }
    const evidence = buildMetaLiveEvidence({ ...readiness, eventResults, forbiddenEventsAbsent, commit, now: options.now })
    const files = await writeEvidence(evidence, {
      ...options,
      expectedCommit: commit,
      expectedEnvironment: 'production',
      now: options.now,
    })
    options.output?.(`Meta live evidence 已写入：${files.evidenceFile}`)
    return { evidence, ...files }
  }
  finally {
    await destroyChallenge(readiness.challengeId, { ...options, commit })
  }
}

export async function readProductionMetaLiveReadiness(options = {}) {
  const commit = String(options.commit || '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('readiness 查询需要当前 40 位 commit')
  const contract = options.expectedDatasetQualityContract
  if (!Number.isSafeInteger(contract?.version)
    || !/^sha256:[0-9a-f]{64}$/.test(String(contract?.digest || ''))) {
    throw new Error('readiness 查询需要 approved Dataset Quality contract')
  }
  const sql = buildProductionMetaLiveReadinessSql(commit, contract)
  const step = await (options.runCommand || runCommand)('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'd1', 'execute', 'meigallery-db',
    '--env', '', '--remote', '--command', sql, '--json',
  ], { cwd: options.cwd || process.cwd(), name: 'meta-live-production-readiness', reportCommand: '读取 production D1 Meta live challenge 脱敏摘要' })
  if (step.status !== 'passed') throw new Error('production Meta live readiness 查询失败')
  const rows = parseD1Rows(step.stdout)
  if (rows.length !== 1) throw new Error('production Meta live readiness 不完整')
  const row = rows[0]
  return {
    environment: row.environment,
    commitSha: String(row.verified_commit || '').toLowerCase(),
    pixelId: String(row.pixel_id || ''),
    connectionVerifiedAt: row.connection_verified_at,
    challengeId: row.challenge_id,
    eventDigests: {
      Contact: row.contact_event_digest,
      CompleteRegistration: row.complete_registration_event_digest,
    },
    enhancedMatch: {
      completeRegistrationEmail: row.registration_email === 1,
      completeRegistrationExternalId: row.registration_external_id === 1,
      contactContainsRegistrationIdentity: row.contact_registration_identity !== 0,
    },
    datasetQualityContractVersion: contract.version,
    datasetQualityContractDigest: contract.digest,
    datasetQualityCollectorCurrent: false,
  }
}

export function buildProductionMetaLiveReadinessSql(commit, contract) {
  if (!/^[0-9a-f]{40}$/.test(String(commit || ''))
    || !Number.isSafeInteger(contract?.version)
    || !/^sha256:[0-9a-f]{64}$/.test(String(contract?.digest || ''))) {
    throw new Error('readiness SQL 需要当前 commit 与 approved Dataset Quality contract')
  }
  return `
    SELECT c.environment, c.pixel_id, c.verified_commit, c.verified_at AS connection_verified_at,
      ch.id AS challenge_id, ch.contact_event_digest, ch.complete_registration_event_digest,
      ch.registration_email_covered AS registration_email,
      ch.registration_external_id_covered AS registration_external_id,
      CASE WHEN ch.contact_registration_identity_absent = 1 THEN 0 ELSE 1 END AS contact_registration_identity
    FROM meta_connection_verifications c
    JOIN meta_live_challenges ch ON ch.environment = c.environment AND ch.commit_sha = c.verified_commit
    WHERE c.environment = 'production' AND c.verified_commit = '${commit}' AND c.invalidated_at IS NULL
      AND ch.status = 'server_sent' AND ch.events_received = 2 AND datetime(ch.expires_at) > datetime('now')
    ORDER BY ch.consumed_at DESC LIMIT 1
  `.replace(/\s+/g, ' ').trim()
}

export async function verifyProductionReleaseIdentity(options = {}) {
  const commit = String(options.commit || '').trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('本地 Git HEAD 必须为 40 位 SHA')
  const env = options.env || process.env
  const fetchFn = options.fetch || fetch
  await Promise.all(REQUIRED_VERIFY_URLS.map(async key => {
    const value = String(env[key] || '').trim()
    let origin
    try { origin = new URL(value) } catch { throw new Error(`${key} 必须是合法的 production Worker HTTPS 地址`) }
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error(`${key} 必须是不含凭证的 production Worker HTTPS 地址`)
    const endpoint = key === 'VERIFY_PRODUCTION_API_URL' ? '/api/health' : '/__release'
    const response = await fetchWithTimeout(fetchFn, new URL(endpoint, origin), { headers: { Accept: 'application/json' } }, options.requestTimeoutMs ?? VERIFY_TIMEOUT_MS)
    const body = response.ok ? await response.json().catch(() => null) : null
    const name = key === 'VERIFY_DEV_API_URL' ? 'API' : 'Web'
    if (!body || body.status !== 'ok' || body.environment !== 'production' || body.commit !== commit) throw new Error(`${name} 发布 commit 与本地 Git HEAD 不一致`)
  }))
}

async function destroyRemoteChallenge(challengeId, options = {}) {
  if (!CHALLENGE_PATTERN.test(String(challengeId || ''))) throw new Error('Meta live challenge ID 非法，拒绝清理')
  const sql = `DELETE FROM meta_live_challenges WHERE id = '${challengeId}' AND environment = 'production' AND commit_sha = '${options.commit}'`
  const step = await (options.runCommand || runCommand)('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', 'd1', 'execute', 'meigallery-db',
    '--env', '', '--remote', '--command', sql,
  ], { cwd: options.cwd || process.cwd(), name: 'meta-live-challenge-destroy', reportCommand: '销毁 production Meta live challenge 脱敏摘要' })
  if (step.status !== 'passed') throw new Error('Meta live challenge 清理失败')
}

function assertReadinessCanRecord(readiness, commit, nowValue, contract) {
  if (readiness?.environment !== 'production' || readiness?.commitSha !== commit.toLowerCase()) throw new Error('production challenge 与当前 commit 不一致')
  if (!CHALLENGE_PATTERN.test(String(readiness.challengeId || ''))
    || !META_LIVE_EVENTS.every(name => DIGEST_PATTERN.test(String(readiness?.eventDigests?.[name] || '')))) {
    throw new Error('production Worker challenge 脱敏摘要缺失')
  }
  if (!Number.isSafeInteger(readiness.datasetQualityContractVersion)
    || readiness.datasetQualityContractVersion < 1
    || readiness.datasetQualityContractVersion !== contract?.version
    || readiness.datasetQualityContractDigest !== contract?.digest) throw new Error('Dataset Quality approved contract 与 production live evidence 不一致')
  buildMetaLiveEvidence({
    ...readiness,
    commit,
    now: nowValue ?? readiness.connectionVerifiedAt,
    forbiddenEventsAbsent: { Lead: true, StartTrial: true },
    eventResults: META_LIVE_EVENTS.map(eventName => ({
      eventName,
      eventIdDigest: readiness.eventDigests[eventName],
      browserSeen: true,
      serverSeen: true,
      deduplicated: true,
      eventsReceived: 1,
    })),
  })
}

function parseD1Rows(stdout) {
  try {
    const payload = JSON.parse(String(stdout || '').trim())
    if (!Array.isArray(payload) || payload.length !== 1 || !Array.isArray(payload[0]?.results)) throw new Error()
    return payload[0].results
  }
  catch { throw new Error('production Meta live readiness JSON 非法') }
}

async function readCurrentCommit(options = {}) {
  const step = await (options.runCommand || runCommand)('git', ['rev-parse', 'HEAD'], { cwd: options.cwd || process.cwd(), name: 'git-commit' })
  if (step.status !== 'passed') throw new Error('无法读取当前 Git commit')
  return String(step.stdout || '').trim()
}

function isYes(value) {
  return YES_VALUES.has(String(value || '').trim().toLowerCase())
}

function createCliPrompter() {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  return prompt => readline.question(prompt)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await recordMetaLiveVerification() }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
