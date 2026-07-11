import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { redact } from './release-verification-lib.mjs'

export const META_LIVE_REPORT_DIR = new URL('../reports/meta-live-verification/', import.meta.url)
export const META_LIVE_EVENTS = Object.freeze(['Contact', 'CompleteRegistration'])

const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'commitSha',
  'environment',
  'pixelIdMasked',
  'connectionVerifiedAt',
  'capturedAt',
  'expiresAt',
  'events',
  'enhancedMatch',
  'forbiddenEventsAbsent',
  'datasetQualityContractVersion',
  'datasetQualityCollectorCurrent',
])
const EVENT_FIELDS = new Set([
  'eventName',
  'browserEventId',
  'serverEventId',
  'browserSeen',
  'serverSeen',
  'deduplicated',
  'eventsReceived',
])
const ENHANCED_MATCH_FIELDS = new Set([
  'completeRegistrationEmail',
  'completeRegistrationExternalId',
  'contactContainsRegistrationIdentity',
])
const FORBIDDEN_EVENT_FIELDS = new Set(['Lead', 'StartTrial'])
const EVENT_ID_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const SENSITIVE_KEY_PATTERN = /(?:browser[_-]?event[_-]?id|server[_-]?event[_-]?id|access[_-]?token|test[_-]?event[_-]?code|client[_-]?ip|ip[_-]?address|\bfbp\b|\bfbc\b)\s*[:=]/i
const META_BROWSER_ID_PATTERN = /\bfb\.1\.\d{6,}\.[A-Za-z0-9._-]+\b/i
const RAW_EVENT_ID_PATTERN = /(?:raw|browser|server)[-_: ]?event[-_: ]?id|event[_ -]?id\s*[:=]/i

export function assertMetaLiveEvidenceCanGateProduction(evidence, options = {}) {
  const reasons = []
  const now = parseTime(options.now ?? Date.now(), '当前时间', reasons)

  if (!isRecord(evidence)) {
    throw new Error('Meta live evidence 不存在或格式非法')
  }

  rejectUnknownFields(evidence, TOP_LEVEL_FIELDS, 'evidence', reasons)
  if (evidence.schemaVersion !== 2) reasons.push('schemaVersion 必须为 2，Evidence V1 已过期')
  if (!/^[0-9a-f]{40}$/.test(String(evidence.commitSha || ''))) reasons.push('commitSha 必须为 40 位 SHA')
  if (options.expectedCommit && evidence.commitSha !== options.expectedCommit) reasons.push('commit 与当前待发布 commit 不一致')
  if (!['dev', 'production'].includes(evidence.environment)) reasons.push('environment 只允许 dev 或 production')
  if (options.expectedEnvironment && evidence.environment !== options.expectedEnvironment) reasons.push('evidence 环境与预期环境不一致')
  if (!/^\d{4}\*{4}\d{4}$/.test(String(evidence.pixelIdMasked || ''))) reasons.push('pixelIdMasked 格式非法')

  const connectionVerifiedAt = parseTime(evidence.connectionVerifiedAt, 'connectionVerifiedAt', reasons)
  const capturedAt = parseTime(evidence.capturedAt, 'capturedAt', reasons)
  const expiresAt = parseTime(evidence.expiresAt, 'expiresAt', reasons)
  if (Number.isFinite(capturedAt) && Number.isFinite(expiresAt) && expiresAt - capturedAt !== EVIDENCE_TTL_MS) {
    reasons.push('evidence 有效期必须严格为 24 小时')
  }
  if (Number.isFinite(connectionVerifiedAt) && Number.isFinite(capturedAt) && connectionVerifiedAt > capturedAt) {
    reasons.push('connectionVerifiedAt 不能晚于 capturedAt')
  }
  if (Number.isFinite(now) && Number.isFinite(capturedAt) && now < capturedAt) reasons.push('evidence 尚未生效')
  if (Number.isFinite(now) && Number.isFinite(expiresAt) && now >= expiresAt) reasons.push('evidence 已过期')

  validateEvents(evidence.events, reasons)
  validateEnhancedMatch(evidence.enhancedMatch, reasons)
  validateForbiddenEvents(evidence.forbiddenEventsAbsent, reasons)
  assertNoSensitiveContent(evidence, reasons)

  if (reasons.length > 0) throw new Error(reasons.join('；'))
}

export async function writeMetaLiveEvidence(evidence, options = {}) {
  assertMetaLiveEvidenceCanGateProduction(evidence, options)
  const serialized = redact(JSON.stringify(evidence, null, 2))
  const sensitiveReasons = []
  assertNoSensitiveContent(JSON.parse(serialized), sensitiveReasons)
  if (sensitiveReasons.length > 0) throw new Error(sensitiveReasons.join('；'))

  const reportDir = resolveReportDir(options.reportDir)
  const timestamp = evidence.capturedAt.replaceAll(':', '-')
  const evidenceFile = path.join(reportDir, `${timestamp}-${evidence.commitSha.slice(0, 12)}.json`)
  const latestFile = path.join(reportDir, 'latest.json')
  await mkdir(reportDir, { recursive: true })
  await writeFile(evidenceFile, serialized)
  await writeFile(latestFile, serialized)
  return { evidenceFile, latestFile }
}

export async function readLatestMetaLiveEvidence(options = {}) {
  const latestFile = path.join(resolveReportDir(options.reportDir), 'latest.json')
  return JSON.parse(await readFile(latestFile, 'utf8'))
}

function validateEvents(events, reasons) {
  if (!Array.isArray(events)) {
    reasons.push('events 缺失或格式非法')
    return
  }
  const names = events.map(event => event?.eventName)
  if (events.length !== META_LIVE_EVENTS.length || new Set(names).size !== META_LIVE_EVENTS.length || !META_LIVE_EVENTS.every(name => names.includes(name))) {
    reasons.push(`events 必须且只能包含 ${META_LIVE_EVENTS.join('、')}`)
  }

  events.forEach((event, index) => {
    if (!isRecord(event)) {
      reasons.push(`events[${index}] 格式非法`)
      return
    }
    rejectUnknownFields(event, EVENT_FIELDS, `events[${index}]`, reasons)
    if (!META_LIVE_EVENTS.includes(event.eventName)) reasons.push(`events[${index}].eventName 非法`)
    if (!EVENT_ID_DIGEST_PATTERN.test(String(event.browserEventId || ''))) reasons.push(`${String(event.eventName)} browserEventId 必须为不可逆摘要`)
    if (!EVENT_ID_DIGEST_PATTERN.test(String(event.serverEventId || ''))) reasons.push(`${String(event.eventName)} serverEventId 必须为不可逆摘要`)
    if (event.browserEventId !== event.serverEventId) reasons.push(`${String(event.eventName)} Browser/Server event ID 不一致`)
    if (event.browserSeen !== true) reasons.push(`${String(event.eventName)} Browser event 未确认`)
    if (event.serverSeen !== true) reasons.push(`${String(event.eventName)} Server event 未确认`)
    if (event.deduplicated !== true) reasons.push(`${String(event.eventName)} 未确认去重`)
    if (event.eventsReceived !== 1) reasons.push(`${String(event.eventName)} eventsReceived 必须为 1`)
  })
}

function validateEnhancedMatch(value, reasons) {
  if (!isRecord(value)) {
    reasons.push('enhancedMatch 缺失或格式非法')
    return
  }
  rejectUnknownFields(value, ENHANCED_MATCH_FIELDS, 'enhancedMatch', reasons)
  if (value.completeRegistrationEmail !== true) reasons.push('CompleteRegistration email 增强匹配未覆盖')
  if (value.completeRegistrationExternalId !== true) reasons.push('CompleteRegistration external_id 增强匹配未覆盖')
  if (value.contactContainsRegistrationIdentity !== false) reasons.push('Contact 不得包含注册身份')
}

function validateForbiddenEvents(value, reasons) {
  if (!isRecord(value)) {
    reasons.push('forbiddenEventsAbsent 缺失或格式非法')
    return
  }
  rejectUnknownFields(value, FORBIDDEN_EVENT_FIELDS, 'forbiddenEventsAbsent', reasons)
  if (value.Lead !== true) reasons.push('必须确认 Lead 缺席')
  if (value.StartTrial !== true) reasons.push('必须确认 StartTrial 缺席')
}

function assertNoSensitiveContent(value, reasons) {
  const serialized = JSON.stringify(value)
  const stringValues = collectStringValues(value)
  if (
    stringValues.some(item => META_BROWSER_ID_PATTERN.test(item))
    || stringValues.some(item => RAW_EVENT_ID_PATTERN.test(item))
    || stringValues.some(containsIpAddress)
  ) reasons.push('evidence 包含原始 event ID、secret、fbp、fbc 或 IP 等敏感内容')
}

function collectStringValues(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach(item => collectStringValues(item, output))
  else if (isRecord(value)) Object.values(value).forEach(item => collectStringValues(item, output))
  return output
}

function containsIpAddress(value) {
  const ipv4Candidates = value.match(/(?:\d{1,3}\.){3}\d{1,3}/g) || []
  const ipv6Candidates = (value.match(/[0-9A-Fa-f:]{2,}/g) || []).filter(candidate => candidate.includes(':'))
  return [...ipv4Candidates, ...ipv6Candidates].some(candidate => isIP(candidate) !== 0)
}

function rejectUnknownFields(value, allowedFields, label, reasons) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) reasons.push(`${label} 包含不允许字段 ${key}`)
  }
}

function parseTime(value, label, reasons) {
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(parsed)) reasons.push(`${label} 不是有效时间`)
  return parsed
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function resolveReportDir(reportDir) {
  if (reportDir instanceof URL) return fileURLToPath(reportDir)
  return reportDir || fileURLToPath(META_LIVE_REPORT_DIR)
}
