#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const MAX_TEXT_FILE_BYTES = 1024 * 1024
const MAX_EVIDENCE_DEPTH = 64
const MAX_EVIDENCE_NODES = 10_000
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
const SECRET_ASSIGNMENT_PATTERN = /(?:["']?)(META_CAPI_ACCESS_TOKEN|META_CAPI_TEST_EVENT_CODE|META_CAPI_DATA_KEY_CURRENT|META_CAPI_DATA_KEY_PREVIOUS)(?:["']?)\s*(?:=(?!=|\|)|:)\s*(?:(["'])([^"'\r\n]+)\2|([^\s,;}\r\n]+))/g
const PERSISTENCE_PATTERN = /\b(?:CREATE|ALTER|INSERT|UPDATE)\b/i
const MATCH_SIGNAL_PATTERN = /(?:\bclient_ip_address\b|\bclient_user_agent\b|(?<![A-Za-z0-9_])fbp(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])fbc(?![A-Za-z0-9_]))/i
const EXPLICIT_SECRET_PLACEHOLDER_PATTERN = /^(?:<[^>\r\n]{1,80}>|\$\{?[A-Z][A-Z0-9_]*\}?|configured|present|missing|unset|disabled|redacted|placeholder|not[-_ ]?configured|undefined|null)$/i
const BARE_VARIABLE_REFERENCE_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/
const SOURCE_CODE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|vue)$/i
const CAPI_FIELD_PATTERN = /(?:\b(em|external_id)\b|["'](em|external_id)["'])\s*:\s*/g
const SQL_IDENTIFIER = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)(?:\\s*\\.\\s*(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*))?'
const WRITE_TARGET_PATTERNS = [
  new RegExp(`\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})`, 'i'),
  new RegExp(`\\bALTER\\s+TABLE\\s+(${SQL_IDENTIFIER})`, 'i'),
  new RegExp(`\\bINSERT\\s+(?:OR\\s+[A-Z]+\\s+)?INTO\\s+(${SQL_IDENTIFIER})`, 'i'),
  new RegExp(`\\bUPDATE\\s+(?:OR\\s+[A-Z]+\\s+)?(${SQL_IDENTIFIER})`, 'i'),
]

export async function scanMetaSecretLeaks(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd())
  const findings = []
  const trackedFiles = options.trackedFiles ?? await readTrackedFiles(rootDir)
  const candidates = new Map()

  for (const relativePath of trackedFiles) {
    const normalized = normalizeRelativePath(relativePath)
    if (isExcludedTrackedPath(normalized) && isSafeReportPath(String(relativePath ?? ''), normalized)) continue
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
    if (isSuspiciousSecretAssignment(
      match[3] ?? match[4],
      Boolean(match[2]),
      SOURCE_CODE_EXTENSION_PATTERN.test(relativePath),
    )) {
      addFinding(findings, relativePath, 'META_SECRET_ASSIGNMENT')
      break
    }
  }

  const tokenInUrlPattern = new RegExp('[?&]access_' + `token=[^&\\s"'${String.fromCharCode(96)}]+`, 'i')
  if (tokenInUrlPattern.test(text)) addFinding(findings, relativePath, 'META_TOKEN_IN_URL')

  if (hasUnsafeCapiMatch(relativePath, text)) addFinding(findings, relativePath, 'META_CAPI_MATCH_UNHASHED')

  if (hasUnsafePersistence(relativePath, text)) {
    addFinding(findings, relativePath, 'META_MATCH_SQL_PERSISTENCE')
  }
}

function hasUnsafeCapiMatch(relativePath, text) {
  if (relativePath.toLowerCase().endsWith('.json')) return hasUnsafeJsonCapiMatch(text)
  return hasUnsafeSourceCapiMatch(text)
}

function hasUnsafeJsonCapiMatch(text) {
  if (!/["'](?:em|external_id)["']\s*:/.test(text)) return false
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return true
  }
  const stack = [{ value: parsed, depth: 0 }]
  let visited = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current.depth > MAX_EVIDENCE_DEPTH || ++visited > MAX_EVIDENCE_NODES) return true
    if (!current.value || typeof current.value !== 'object') continue
    const entries = Object.entries(current.value)
    if (visited + stack.length + entries.length > MAX_EVIDENCE_NODES) return true
    for (const [key, value] of entries) {
      if (key === 'em' || key === 'external_id') {
        if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string' && HASH_PATTERN.test(item))) {
          return true
        }
      }
      if (value && typeof value === 'object') stack.push({ value, depth: current.depth + 1 })
    }
  }
  return false
}

function hasUnsafeSourceCapiMatch(text) {
  CAPI_FIELD_PATTERN.lastIndex = 0
  for (const match of text.matchAll(CAPI_FIELD_PATTERN)) {
    const start = match.index + match[0].length
    const next = skipSourceWhitespace(text, start)
    if (text[next] === '[') {
      const end = findClosingArray(text, next)
      if (end < 0) return true
      const parsed = inspectSourceArray(text, next, end)
      if (parsed.visibleLiterals.some(value => !HASH_PATTERN.test(value))) return true
      if (parsed.itemCount === 0) return true
      continue
    }
    if (text[next] === '"' || text[next] === "'" || text[next] === '{' || /[0-9]/.test(text[next] || '')) return true
    if (/^(?:null|undefined|true|false)\b/.test(text.slice(next))) return true
  }
  return false
}

function findClosingArray(text, start) {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '[') depth += 1
    else if (char === ']' && --depth === 0) return index
  }
  return -1
}

function inspectSourceArray(text, start, end) {
  const visibleLiterals = []
  let itemCount = 0
  let itemStart = start + 1
  let quote = ''
  let escaped = false
  let nestedDepth = 0

  const inspectItem = (from, to) => {
    const item = text.slice(from, to).trim()
    if (!item) return
    itemCount += 1
    const literalQuote = item[0]
    if (literalQuote !== '"' && literalQuote !== "'") return
    const literal = readSourceString(item, 0, literalQuote, item.length)
    if (literal) visibleLiterals.push(literal.value)
  }

  for (let index = start + 1; index < end; index += 1) {
    const char = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '[' || char === '(' || char === '{') nestedDepth += 1
    else if (char === ']' || char === ')' || char === '}') nestedDepth = Math.max(0, nestedDepth - 1)
    else if (char === ',' && nestedDepth === 0) {
      inspectItem(itemStart, index)
      itemStart = index + 1
    }
  }
  inspectItem(itemStart, end)
  return { itemCount, visibleLiterals }
}

function readSourceString(text, start, quote, limit) {
  let value = ''
  let escaped = false
  for (let index = start + 1; index < limit; index += 1) {
    const char = text[index]
    if (escaped) {
      value += `\\${char}`
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === quote) {
      return { value, end: index + 1 }
    } else {
      value += char
    }
  }
  return null
}

function skipSourceWhitespace(text, start) {
  let index = start
  while (/\s/.test(text[index] || '')) index += 1
  return index
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
  const withinBudget = walkEvidence(parsed, (key, value) => {
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
  if (!withinBudget) addFinding(findings, relativePath, 'META_EVIDENCE_STRUCTURE_LIMIT')
}

function walkEvidence(root, visit) {
  const stack = [{ value: root, key: '', depth: 0 }]
  let visited = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current.depth > MAX_EVIDENCE_DEPTH || ++visited > MAX_EVIDENCE_NODES) return false
    visit(current.key, current.value)
    let children = []
    if (Array.isArray(current.value)) {
      children = current.value.map(value => ({ value, key: current.key, depth: current.depth + 1 }))
    } else if (current.value && typeof current.value === 'object') {
      children = Object.entries(current.value).map(([key, value]) => ({ value, key, depth: current.depth + 1 }))
    }
    if (visited + stack.length + children.length > MAX_EVIDENCE_NODES) return false
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index])
  }
  return true
}

function hasUnsafePersistence(relativePath, text) {
  const candidates = relativePath.endsWith('.sql')
    ? splitSqlStatements(stripSqlComments(text))
    : [...text.matchAll(/`([\s\S]*?)`/g)].map(match => match[1])
  return candidates.some((candidate) => {
    const sql = stripSqlComments(candidate)
    if (!PERSISTENCE_PATTERN.test(sql) || !MATCH_SIGNAL_PATTERN.test(sql)) return false
    return parseWriteTarget(sql) !== 'meta_capi_secure_outbox'
  })
}

function stripSqlComments(sql) {
  let result = ''
  let quote = ''
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    if (quote) {
      result += char
      if (char === quote) {
        if (sql[index + 1] === quote) result += sql[++index]
        else quote = ''
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      result += char
      continue
    }
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      result += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1
      index += 1
      result += ' '
      continue
    }
    result += char
  }
  return result
}

function splitSqlStatements(sql) {
  const statements = []
  let start = 0
  let quote = ''
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (quote) {
      if (char === quote) {
        if (sql[index + 1] === quote) index += 1
        else quote = ''
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === ';') {
      statements.push(sql.slice(start, index))
      start = index + 1
    }
  }
  statements.push(sql.slice(start))
  return statements
}

function parseWriteTarget(sql) {
  let first = null
  for (const pattern of WRITE_TARGET_PATTERNS) {
    const match = pattern.exec(sql)
    if (match && (!first || match.index < first.index)) first = { index: match.index, identifier: match[1] }
  }
  if (!first) return ''
  const parts = first.identifier.replace(/\s+/g, '').split('.')
  return unquoteSqlIdentifier(parts.at(-1) || '').toLowerCase()
}

function unquoteSqlIdentifier(identifier) {
  if ((identifier.startsWith('"') && identifier.endsWith('"'))
    || (identifier.startsWith('`') && identifier.endsWith('`'))
    || (identifier.startsWith('[') && identifier.endsWith(']'))) {
    return identifier.slice(1, -1)
  }
  return identifier
}

function isSuspiciousSecretAssignment(value, quoted, sourceExpressionContext) {
  const normalized = String(value || '').trim()
  if (!normalized || EXPLICIT_SECRET_PLACEHOLDER_PATTERN.test(normalized)) return false
  if (!quoted && sourceExpressionContext && BARE_VARIABLE_REFERENCE_PATTERN.test(normalized)) return false
  return true
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

function safeFindingPath(value) {
  const raw = String(value ?? '')
  const normalized = normalizeRelativePath(raw)
  if (isSafeReportPath(raw, normalized)) return normalized
  const id = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  return `opaque-path-${id}`
}

function isSafeReportPath(raw, normalized) {
  if (!normalized || /[\0-\x1f\x7f]/.test(raw) || path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return false
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false
  return !segments.some(isSuspiciousPathSegment)
}

function isSuspiciousPathSegment(segment) {
  if (/(?:access[_-]?token|bearer|(?:^|[_-])token(?:[_-]|$))/i.test(segment)) return true
  if (/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i.test(segment)) return true
  if (/(?:^|[._-])fbp(?:[._-]|$)|fb\.1\./i.test(segment)) return true
  if (/(?:^|[^0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{32})(?=$|[^0-9a-f])/i.test(segment)) return true
  const ipCandidates = segment.match(/(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]{2,}/gi) || []
  if (ipCandidates.some(candidate => isIP(candidate) !== 0)) return true
  const stem = segment.replace(/\.[A-Za-z0-9]{1,10}$/, '')
  const candidates = /^[A-Za-z0-9+/=]+$/.test(stem) ? [stem] : stem.split(/[-_.]/)
  return candidates.some((candidate) => {
    const characterClasses = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(candidate)).length
    return candidate.length >= 24 && characterClasses >= 3 && shannonEntropy(candidate) >= 3.8
  })
}

function shannonEntropy(value) {
  const counts = new Map()
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
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
  findings.push({ path: safeFindingPath(relativePath), ruleId })
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
