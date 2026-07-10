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
  'status',
  'commit',
  'verifiedAt',
  'expiresAt',
  'pixelIdSuffix',
  'events',
  'confirmedBy',
])
const EVENT_FIELDS = new Set([
  'eventName',
  'browser',
  'server',
  'eventIdMatched',
  'eventIdDigest',
  'deduplicated',
])
const OWNER_IDENTIFIER_PATTERN = /^owner(?::[a-z0-9][a-z0-9._-]{0,31})?$/
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
  if (evidence.schemaVersion !== 1) reasons.push('schemaVersion 必须为 1')
  if (evidence.status !== 'passed') reasons.push('status 必须为 passed')
  if (typeof evidence.commit !== 'string' || evidence.commit.trim() === '') reasons.push('commit 缺失或格式非法')
  if (options.expectedCommit && evidence.commit !== options.expectedCommit) reasons.push('commit 与当前待发布 commit 不一致')
  if (!/^\d{4}$/.test(String(evidence.pixelIdSuffix || ''))) reasons.push('pixelIdSuffix 必须为四位数字')
  if (!isValidMetaOwnerIdentifier(evidence.confirmedBy)) reasons.push('confirmedBy 只允许 owner 或 owner:<短标识>')

  const verifiedAt = parseTime(evidence.verifiedAt, 'verifiedAt', reasons)
  const expiresAt = parseTime(evidence.expiresAt, 'expiresAt', reasons)
  if (Number.isFinite(verifiedAt) && Number.isFinite(expiresAt) && expiresAt - verifiedAt !== EVIDENCE_TTL_MS) {
    reasons.push('evidence 有效期必须严格为 24 小时')
  }
  if (Number.isFinite(now) && Number.isFinite(verifiedAt) && now < verifiedAt) reasons.push('evidence 尚未生效')
  if (Number.isFinite(now) && Number.isFinite(expiresAt) && now >= expiresAt) reasons.push('evidence 已过期')

  validateEvents(evidence.events, reasons)
  assertNoSensitiveContent(evidence, reasons)

  if (reasons.length > 0) throw new Error(reasons.join('；'))
}

export function isValidMetaOwnerIdentifier(value) {
  return OWNER_IDENTIFIER_PATTERN.test(String(value || '').trim())
}

export async function writeMetaLiveEvidence(evidence, options = {}) {
  assertMetaLiveEvidenceCanGateProduction(evidence, options)
  const serialized = redact(JSON.stringify(evidence, null, 2))
  const sensitiveReasons = []
  assertNoSensitiveContent(JSON.parse(serialized), sensitiveReasons)
  if (sensitiveReasons.length > 0) throw new Error(sensitiveReasons.join('；'))

  const reportDir = resolveReportDir(options.reportDir)
  const timestamp = evidence.verifiedAt.replaceAll(':', '-')
  const evidenceFile = path.join(reportDir, `${timestamp}-${evidence.commit.slice(0, 12)}.json`)
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
    if (event.browser !== true) reasons.push(`${String(event.eventName)} Browser event 未确认`)
    if (event.server !== true) reasons.push(`${String(event.eventName)} Server event 未确认`)
    if (event.eventIdMatched !== true) reasons.push(`${String(event.eventName)} event ID 不一致`)
    if (!/^sha256:[0-9a-f]{12}$/.test(String(event.eventIdDigest || ''))) reasons.push(`${String(event.eventName)} eventIdDigest 格式非法`)
    if (event.deduplicated !== true) reasons.push(`${String(event.eventName)} 未确认去重`)
  })
}

function assertNoSensitiveContent(value, reasons) {
  const serialized = JSON.stringify(value)
  const stringValues = collectStringValues(value)
  if (
    SENSITIVE_KEY_PATTERN.test(serialized)
    || stringValues.some(item => META_BROWSER_ID_PATTERN.test(item))
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
