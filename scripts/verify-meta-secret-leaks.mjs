#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const MAX_TEXT_FILE_BYTES = 1024 * 1024
const EVIDENCE_DIRECTORIES = [
  'reports/release-verification',
  'reports/meta-live-verification',
]
const EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.nuxt',
  '.output',
  'dist',
  'coverage',
  '.wrangler',
  '.wrangler-release-verify',
])
const HASH_PATTERN = /^[0-9a-f]{64}$/
const EVIDENCE_MATCH_IDENTIFIER_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/i
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/i
const SECRET_ASSIGNMENT_PATTERN = /(?:["']?)(META_CAPI_ACCESS_TOKEN|META_CAPI_TEST_EVENT_CODE|META_CAPI_DATA_KEY_CURRENT|META_CAPI_DATA_KEY_PREVIOUS)(?:["']?)\s*(?:=|:)\s*(?:(["'])([^"'\r\n]+)\2|([^\s,;}\r\n]+))/g
const CAPI_MATCH_PATTERN = /(?:^|[,{]\s*)["']?(em|external_id)["']?\s*:\s*(?:\[\s*)?["']([^"']+)["']/gm
const PERSISTENCE_PATTERN = /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|INSERT\s+INTO|UPDATE)\b/i
const MATCH_SIGNAL_PATTERN = /(?:\bclient_ip_address\b|\bclient_user_agent\b|(?<![A-Za-z0-9_])fbp(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])fbc(?![A-Za-z0-9_]))/i

export async function scanMetaSecretLeaks(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd())
  const findings = []
  const trackedFiles = options.trackedFiles ?? await readTrackedFiles(rootDir)
  const candidates = new Map()

  for (const relativePath of trackedFiles) {
    const normalized = normalizeRelativePath(relativePath)
    if (isExcludedTrackedPath(normalized)) continue
    candidates.set(normalized, { path: normalized, evidence: false })
  }
  for (const directory of EVIDENCE_DIRECTORIES) {
    await collectEvidenceFiles(rootDir, directory, candidates, findings)
  }

  let scannedFileCount = 0
  for (const candidate of candidates.values()) {
    const loaded = await readSafeTextFile(rootDir, candidate.path, findings)
    if (!loaded) continue
    if (loaded.kind === 'binary') continue
    scannedFileCount += 1
    scanText(candidate.path, loaded.text, findings)
    if (candidate.evidence) scanEvidence(candidate.path, loaded.text, findings)
  }

  const normalizedFindings = uniqueFindings(findings)
  return {
    status: normalizedFindings.length === 0 ? 'passed' : 'failed',
    scannedFileCount,
    findingCount: normalizedFindings.length,
    findings: normalizedFindings,
  }
}

export async function main(options = {}) {
  const stdout = options.stdout || process.stdout
  const report = await scanMetaSecretLeaks(options)
  for (const finding of report.findings) {
    stdout.write(`${finding.path} ${finding.ruleId}\n`)
  }
  stdout.write(`META_SECRET_SCAN_${report.status === 'passed' ? 'PASSED' : 'FAILED'} total=${report.findingCount} files=${report.scannedFileCount}\n`)
  return report
}

async function readTrackedFiles(rootDir) {
  try {
    const { stdout } = await execFile('git', ['ls-files', '-z'], {
      cwd: rootDir,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    })
    return Buffer.from(stdout).toString('utf8').split('\0').filter(Boolean)
  }
  catch {
    return ['.meta-git-files-unavailable']
  }
}

async function collectEvidenceFiles(rootDir, relativeDirectory, candidates, findings) {
  const safe = resolveInsideRoot(rootDir, relativeDirectory)
  if (!safe) {
    addFinding(findings, relativeDirectory, 'META_PATH_UNSAFE')
    return
  }
  let entries
  try {
    const stats = await lstat(safe)
    if (stats.isSymbolicLink()) {
      const target = await realpath(safe)
      if (!isInsideRoot(rootDir, target)) {
        addFinding(findings, relativeDirectory, 'META_PATH_UNSAFE')
        return
      }
    } else if (!stats.isDirectory()) {
      addFinding(findings, relativeDirectory, 'META_PATH_UNSAFE')
      return
    }
    entries = await readdir(safe, { withFileTypes: true })
  }
  catch (error) {
    if (error?.code !== 'ENOENT') addFinding(findings, relativeDirectory, 'META_FILE_UNREADABLE')
    return
  }
  for (const entry of entries) {
    const child = normalizeRelativePath(path.posix.join(relativeDirectory, entry.name))
    if (entry.isSymbolicLink()) {
      addFinding(findings, child, 'META_PATH_UNSAFE')
    } else if (entry.isDirectory()) {
      await collectEvidenceFiles(rootDir, child, candidates, findings)
    } else if (entry.isFile() && child.endsWith('.json')) {
      candidates.set(child, { path: child, evidence: true })
    }
  }
}

async function readSafeTextFile(rootDir, relativePath, findings) {
  const filePath = resolveInsideRoot(rootDir, relativePath)
  if (!filePath) {
    addFinding(findings, relativePath, 'META_PATH_UNSAFE')
    return null
  }

  let stats
  try {
    stats = await lstat(filePath)
    if (stats.isSymbolicLink()) {
      const target = await realpath(filePath)
      if (!isInsideRoot(rootDir, target)) {
        addFinding(findings, relativePath, 'META_PATH_UNSAFE')
        return null
      }
      stats = await lstat(target)
    }
  }
  catch {
    addFinding(findings, relativePath, 'META_FILE_UNREADABLE')
    return null
  }
  if (!stats.isFile()) {
    addFinding(findings, relativePath, 'META_PATH_UNSAFE')
    return null
  }
  if (stats.size > MAX_TEXT_FILE_BYTES) {
    addFinding(findings, relativePath, 'META_FILE_TOO_LARGE')
    return null
  }

  let bytes
  try {
    bytes = await readFile(filePath)
  }
  catch {
    addFinding(findings, relativePath, 'META_FILE_UNREADABLE')
    return null
  }
  if (bytes.includes(0)) return { kind: 'binary' }
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  }
  catch {
    return { kind: 'binary' }
  }
}

function scanText(relativePath, text, findings) {
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0
  for (const match of text.matchAll(SECRET_ASSIGNMENT_PATTERN)) {
    if (isSuspiciousSecretValue(match[3] ?? match[4])) {
      addFinding(findings, relativePath, 'META_SECRET_ASSIGNMENT')
      break
    }
  }

  const tokenInUrlPattern = new RegExp('[?&]access_' + `token=[^&\\s"'${String.fromCharCode(96)}]+`, 'i')
  if (tokenInUrlPattern.test(text)) addFinding(findings, relativePath, 'META_TOKEN_IN_URL')

  CAPI_MATCH_PATTERN.lastIndex = 0
  for (const match of text.matchAll(CAPI_MATCH_PATTERN)) {
    if (!HASH_PATTERN.test(match[2])) {
      addFinding(findings, relativePath, 'META_CAPI_MATCH_UNHASHED')
      break
    }
  }

  if (hasUnsafePersistence(relativePath, text)) {
    addFinding(findings, relativePath, 'META_MATCH_SQL_PERSISTENCE')
  }
}

function scanEvidence(relativePath, text, findings) {
  let parsed
  try {
    parsed = JSON.parse(text)
  }
  catch {
    addFinding(findings, relativePath, 'META_EVIDENCE_JSON_INVALID')
    return
  }
  walkEvidence(parsed, '', (key, value) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (typeof value !== 'string' || value.length === 0) return
    if (EMAIL_PATTERN.test(value)) addFinding(findings, relativePath, 'META_EVIDENCE_RAW_EMAIL')
    if (isIP(value) !== 0) addFinding(findings, relativePath, 'META_EVIDENCE_RAW_IP')
    if (normalizedKey.includes('useragent')) addFinding(findings, relativePath, 'META_EVIDENCE_RAW_USER_AGENT')
    if (normalizedKey === 'fbp' || normalizedKey === 'fbc' || /^fb\.1\./.test(value)) {
      addFinding(findings, relativePath, 'META_EVIDENCE_BROWSER_ID')
    }
    if (EVIDENCE_MATCH_IDENTIFIER_PATTERN.test(value)) {
      addFinding(findings, relativePath, 'META_EVIDENCE_MATCH_IDENTIFIER')
    }
  })
}

function walkEvidence(value, key, visit) {
  visit(key, value)
  if (Array.isArray(value)) {
    for (const item of value) walkEvidence(item, key, visit)
  } else if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      walkEvidence(childValue, childKey, visit)
    }
  }
}

function hasUnsafePersistence(relativePath, text) {
  const candidates = relativePath.endsWith('.sql')
    ? text.split(';')
    : [...text.matchAll(/`([\s\S]*?)`/g)].map(match => match[1])
  return candidates.some((candidate) => {
    if (!PERSISTENCE_PATTERN.test(candidate) || !MATCH_SIGNAL_PATTERN.test(candidate)) return false
    return !/\bmeta_capi_secure_outbox\b/i.test(candidate)
  })
}

function isSuspiciousSecretValue(value) {
  const normalized = String(value || '').trim()
  if (normalized.length < 8) return false
  if (/^[A-Za-z_$][A-Za-z0-9_.$]*$/.test(normalized)) return false
  return !/^(?:\$|<|your[-_]|replace[-_]|example[-_]|fixture[-_]|process\.env\.|undefined|null)/i.test(normalized)
    && !/^(?:\||\.{2,})/.test(normalized)
}

function isExcludedTrackedPath(relativePath) {
  const segments = relativePath.split('/')
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) return true
  if (segments.some(segment => segment === 'test' || segment === 'tests' || segment === '__tests__' || segment === 'fixtures')) return true
  const basename = segments.at(-1) || ''
  return /(?:^|\.)?(?:test|spec)\.[^.]+$/i.test(basename)
}

function normalizeRelativePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function resolveInsideRoot(rootDir, relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized || normalized.includes('\0') || path.isAbsolute(normalized)) return null
  const resolved = path.resolve(rootDir, normalized)
  return isInsideRoot(rootDir, resolved) ? resolved : null
}

function isInsideRoot(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function addFinding(findings, relativePath, ruleId) {
  findings.push({ path: normalizeRelativePath(relativePath), ruleId })
}

function uniqueFindings(findings) {
  const byKey = new Map()
  for (const finding of findings) byKey.set(`${finding.path}\0${finding.ruleId}`, finding)
  return [...byKey.values()].sort((left, right) => (
    left.path.localeCompare(right.path) || left.ruleId.localeCompare(right.ruleId)
  ))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await main()
    if (report.status !== 'passed') process.exitCode = 1
  }
  catch {
    process.stdout.write('META_SECRET_SCAN_ERROR total=1 files=0\n')
    process.exitCode = 1
  }
}
