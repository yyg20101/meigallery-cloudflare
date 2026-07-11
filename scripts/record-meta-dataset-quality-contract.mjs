#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const MAX_RAW_BYTES = 1024 * 1024
export const MAX_MANIFEST_BYTES = 128 * 1024

const MAX_JSON_DEPTH = 32
const MAX_SCHEMA_PATHS = 10_000
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const JSON_PATH_PATTERN = /^\$(?:(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63})|\[\])+$/
const ENDPOINT_PATH_PATTERN = /^\/\{dataset_id\}\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/
const PERMISSION_PATTERN = /^[a-z][a-z0-9_]{1,63}$/
const OFFICIAL_META_HOSTS = new Set([
  'business.facebook.com',
  'developers.facebook.com',
  'facebook.com',
  'graph.facebook.com',
  'www.facebook.com',
])
const ERROR_CLASSIFICATIONS = new Set([
  'success',
  'authentication_failed',
  'permission_denied',
  'rate_limited',
  'invalid_request',
  'not_found',
  'server_error',
  'network_error',
  'unknown',
])
const TYPE_ORDER = ['boolean', 'integer', 'number', 'string', 'array', 'object', 'unknown']

const ERROR_MESSAGES = Object.freeze({
  ARGUMENTS_INVALID: '命令参数非法',
  INPUT_PATH_COLLISION: '输入输出路径冲突',
  RAW_UNREADABLE: 'raw 文件不可读取',
  RAW_SYMLINK: 'raw 文件不允许为 symlink',
  RAW_NOT_FILE: 'raw 输入必须为普通文件',
  RAW_TOO_LARGE: 'raw 文件超过大小限制',
  RAW_NOT_JSON: 'raw 文件不是合法 JSON',
  RAW_DELETE_FAILED: 'raw 文件销毁失败',
  MANIFEST_UNREADABLE: 'manifest 文件不可读取',
  MANIFEST_SYMLINK: 'manifest 文件不允许为 symlink',
  MANIFEST_NOT_FILE: 'manifest 输入必须为普通文件',
  MANIFEST_TOO_LARGE: 'manifest 文件超过大小限制',
  MANIFEST_NOT_JSON: 'manifest 文件不是合法 JSON',
  MANIFEST_INVALID: 'manifest 契约非法',
  ENVIRONMENT_INVALID: '只允许 dev capture',
  GRAPH_VERSION_INVALID: '只允许 Graph API v25.0',
  COMMIT_INVALID: 'release commit 非法或不是当前 HEAD',
  COMMIT_UNAVAILABLE: '无法读取当前 Git HEAD',
  OFFICIAL_URL_INVALID: '官方 URL 非法',
  REQUEST_INVALID: '请求元数据非法',
  DATASET_ID_INVALID: 'Dataset ID 非法',
  OWNER_ALLOWLIST_INVALID: 'Owner allowlist 非法',
  SENSITIVE_KEY_REJECTED: 'raw 包含禁止的敏感键',
  RAW_SCHEMA_INVALID: 'raw schema 非法',
  CONTRACT_WRITE_FAILED: 'contract 写入失败',
  INTERNAL_ERROR: '记录器内部错误',
})

export class ContractRecorderError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR)
    this.name = 'ContractRecorderError'
    this.code = ERROR_MESSAGES[code] ? code : 'INTERNAL_ERROR'
  }
}

export async function recordMetaDatasetQualityContract(options = {}) {
  const manifestPath = requirePath(options.manifestPath)
  const rawPath = requirePath(options.rawPath)
  const outputPath = requirePath(options.outputPath)
  assertDistinctPaths(manifestPath, rawPath, outputPath)

  const rawState = { candidate: null, handle: null }
  let staged = null
  let result = null
  let primaryError = null

  try {
    const raw = await readJsonInput(rawPath, {
      kind: 'RAW',
      maxBytes: options.maxRawBytes ?? MAX_RAW_BYTES,
      rawState,
      lstatFile: options.lstatFile,
      openFile: options.openFile,
    })
    const manifest = await readJsonInput(manifestPath, {
      kind: 'MANIFEST',
      maxBytes: options.maxManifestBytes ?? MAX_MANIFEST_BYTES,
      lstatFile: options.lstatFile,
      openFile: options.openFile,
    })
    const currentCommit = await readCurrentCommit(options)
    result = buildContractDocument(manifest, raw, { currentCommit })
    try {
      staged = await (options.stageContract || stageContractFile)(outputPath, result.document)
    } catch {
      throw new ContractRecorderError('CONTRACT_WRITE_FAILED')
    }
  } catch (error) {
    primaryError = asRecorderError(error)
  }

  try {
    await destroyRawFile(rawPath, rawState, options)
  } catch {
    await abortQuietly(staged)
    throw new ContractRecorderError('RAW_DELETE_FAILED')
  }

  if (primaryError) {
    await abortQuietly(staged)
    throw primaryError
  }

  try {
    await staged.finalize()
  } catch {
    await abortQuietly(staged)
    throw new ContractRecorderError('CONTRACT_WRITE_FAILED')
  }

  return result
}

export function buildContractDocument(manifestInput, raw, options = {}) {
  const manifest = validateManifest(manifestInput, options.currentCommit)
  const schema = collectResponseSchema(raw)
  const responsePaths = validateAllowlistedPaths(
    manifest.ownerAllowlist.responsePaths,
    schema,
    'responsePaths',
    { requireNonEmpty: true },
  )
  const freshnessPaths = validateAllowlistedPaths(
    manifest.ownerAllowlist.freshnessPaths,
    schema,
    'freshnessPaths',
    { subset: responsePaths },
  )
  const windowPaths = validateAllowlistedPaths(
    manifest.ownerAllowlist.windowPaths,
    schema,
    'windowPaths',
    { subset: responsePaths },
  )
  const responsePathSet = new Set(responsePaths)
  const rejectedPaths = [...schema.keys()].filter(jsonPath => !responsePathSet.has(jsonPath)).sort()
  const allowlistedSchema = responsePaths.map(jsonPath => ({ path: jsonPath, ...schema.get(jsonPath) }))
  const datasetMask = maskDatasetId(manifest.request.datasetId)
  const officialUrls = manifest.officialUrls

  return {
    document: renderContract({
      manifest,
      datasetMask,
      officialUrls,
      allowlistedSchema,
      freshnessPaths,
      windowPaths,
      rejectedPaths,
    }),
    summary: {
      environment: manifest.environment,
      graphVersion: manifest.graphVersion,
      releaseCommit: manifest.releaseCommit,
      allowlistedPathCount: allowlistedSchema.length,
      rejectedPathCount: rejectedPaths.length,
    },
  }
}

export async function main(options = {}) {
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const argv = options.argv || process.argv.slice(2)

  if (argv.length !== 3) {
    stderr.write('Dataset Quality contract 记录失败（ARGUMENTS_INVALID）。\n')
    return 1
  }

  try {
    await recordMetaDatasetQualityContract({
      ...options,
      manifestPath: argv[0],
      rawPath: argv[1],
      outputPath: argv[2],
    })
    stdout.write('Dataset Quality contract draft 已生成。\n')
    return 0
  } catch (error) {
    const safeError = asRecorderError(error)
    stderr.write(`Dataset Quality contract 记录失败（${safeError.code}）。\n`)
    return 1
  }
}

function validateManifest(input, currentCommit) {
  assertRecordWithKeys(input, [
    'schemaVersion',
    'environment',
    'graphVersion',
    'releaseCommit',
    'capturedAt',
    'officialUrls',
    'request',
    'ownerAllowlist',
    'errorClassifications',
  ], 'MANIFEST_INVALID')
  if (input.schemaVersion !== 1) throw new ContractRecorderError('MANIFEST_INVALID')
  if (input.environment !== 'dev') throw new ContractRecorderError('ENVIRONMENT_INVALID')
  if (input.graphVersion !== 'v25.0') throw new ContractRecorderError('GRAPH_VERSION_INVALID')
  if (!/^[0-9a-f]{40}$/.test(input.releaseCommit) || input.releaseCommit !== currentCommit) {
    throw new ContractRecorderError('COMMIT_INVALID')
  }
  if (!isCanonicalIsoTimestamp(input.capturedAt)) throw new ContractRecorderError('MANIFEST_INVALID')

  assertRecordWithKeys(input.request, ['method', 'endpointPath', 'queryKeys', 'permissions', 'datasetId'], 'REQUEST_INVALID')
  if (input.request.method !== 'GET' || !ENDPOINT_PATH_PATTERN.test(input.request.endpointPath)) {
    throw new ContractRecorderError('REQUEST_INVALID')
  }
  if (!/^\d{9,30}$/.test(input.request.datasetId)) throw new ContractRecorderError('DATASET_ID_INVALID')
  const queryKeys = validateNameList(input.request.queryKeys, FIELD_NAME_PATTERN, 'REQUEST_INVALID', { allowEmpty: true })
  if (queryKeys.some(isSensitiveKey)) throw new ContractRecorderError('REQUEST_INVALID')
  assertDatasetIdAbsent(queryKeys, input.request.datasetId, 'REQUEST_INVALID')
  const permissions = validateNameList(input.request.permissions, PERMISSION_PATTERN, 'REQUEST_INVALID')

  if (!Array.isArray(input.officialUrls) || input.officialUrls.length === 0 || input.officialUrls.length > 8) {
    throw new ContractRecorderError('OFFICIAL_URL_INVALID')
  }
  const officialUrls = input.officialUrls.map(value => sanitizeOfficialUrl(value, input.request.datasetId))
  if (new Set(officialUrls).size !== officialUrls.length) throw new ContractRecorderError('OFFICIAL_URL_INVALID')

  assertRecordWithKeys(input.ownerAllowlist, ['approved', 'responsePaths', 'freshnessPaths', 'windowPaths'], 'OWNER_ALLOWLIST_INVALID')
  if (input.ownerAllowlist.approved !== true) throw new ContractRecorderError('OWNER_ALLOWLIST_INVALID')
  for (const field of ['responsePaths', 'freshnessPaths', 'windowPaths']) {
    validatePathListShape(input.ownerAllowlist[field], field === 'responsePaths')
  }

  const errorClassifications = validateNameList(
    input.errorClassifications,
    PERMISSION_PATTERN,
    'MANIFEST_INVALID',
  )
  if (errorClassifications.some(category => !ERROR_CLASSIFICATIONS.has(category))) {
    throw new ContractRecorderError('MANIFEST_INVALID')
  }

  return {
    ...input,
    officialUrls,
    request: { ...input.request, queryKeys, permissions },
    errorClassifications,
  }
}

function collectResponseSchema(raw) {
  if (raw === null || typeof raw !== 'object') throw new ContractRecorderError('RAW_SCHEMA_INVALID')
  const observations = new Map()
  const state = { visitedNodes: 0 }

  const visit = (value, jsonPath, depth, pathSegments) => {
    state.visitedNodes += 1
    if (depth > MAX_JSON_DEPTH || state.visitedNodes > MAX_SCHEMA_PATHS * 4) {
      throw new ContractRecorderError('RAW_SCHEMA_INVALID')
    }

    if (value === null || typeof value !== 'object') {
      observe(observations, jsonPath, value)
      return
    }
    if (Array.isArray(value)) {
      if (value.length === 0) observe(observations, jsonPath, value)
      for (const item of value) visit(item, `${jsonPath}[]`, depth + 1, pathSegments)
      return
    }

    const entries = Object.entries(value)
    if (entries.length === 0) observe(observations, jsonPath, value)
    for (const [key, child] of entries) {
      if (!FIELD_NAME_PATTERN.test(key)) throw new ContractRecorderError('RAW_SCHEMA_INVALID')
      const childPathSegments = [...pathSegments, key]
      if (isSensitivePath(childPathSegments)) throw new ContractRecorderError('SENSITIVE_KEY_REJECTED')
      visit(child, `${jsonPath}.${key}`, depth + 1, childPathSegments)
    }
  }

  visit(raw, '$', 0, [])
  observations.delete('$')
  if (observations.size === 0 || observations.size > MAX_SCHEMA_PATHS) {
    throw new ContractRecorderError('RAW_SCHEMA_INVALID')
  }

  return new Map([...observations.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function observe(observations, jsonPath, value) {
  const current = observations.get(jsonPath) || { types: new Set(), nullable: false }
  if (value === null) current.nullable = true
  else current.types.add(jsonType(value))
  observations.set(jsonPath, current)
  current.type = TYPE_ORDER.filter(type => current.types.has(type)).join(' | ') || 'unknown'
}

function jsonType(value) {
  if (Array.isArray(value)) return 'array'
  if (value !== null && typeof value === 'object') return 'object'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function validateAllowlistedPaths(paths, schema, field, options = {}) {
  validatePathListShape(paths, options.requireNonEmpty === true)
  const unique = new Set(paths)
  for (const jsonPath of paths) {
    if (!schema.has(jsonPath)) throw new ContractRecorderError('OWNER_ALLOWLIST_INVALID')
    if (options.subset && !options.subset.includes(jsonPath)) throw new ContractRecorderError('OWNER_ALLOWLIST_INVALID')
  }
  if (unique.size !== paths.length) throw new ContractRecorderError('OWNER_ALLOWLIST_INVALID')
  return [...paths].sort()
}

function validatePathListShape(paths, requireNonEmpty) {
  if (!Array.isArray(paths) || paths.length > MAX_SCHEMA_PATHS || (requireNonEmpty && paths.length === 0)) {
    throw new ContractRecorderError('OWNER_ALLOWLIST_INVALID')
  }
  for (const jsonPath of paths) {
    if (typeof jsonPath !== 'string' || !JSON_PATH_PATTERN.test(jsonPath)) {
      throw new ContractRecorderError('OWNER_ALLOWLIST_INVALID')
    }
    const segments = jsonPath.replaceAll('[]', '').split('.').slice(1)
    if (isSensitivePath(segments)) throw new ContractRecorderError('SENSITIVE_KEY_REJECTED')
  }
}

function renderContract(input) {
  const { manifest } = input
  const schemaRows = input.allowlistedSchema
    .map(field => `| \`${field.path}\` | \`${field.type}\` | ${field.nullable ? '是' : '否'} |`)
    .join('\n')
  const officialUrls = input.officialUrls.map(url => `- ${url}`).join('\n')
  const permissions = manifest.request.permissions.map(name => `\`${name}\``).join('、')
  const queryKeys = manifest.request.queryKeys.length > 0
    ? manifest.request.queryKeys.map(name => `\`${name}\``).join('、')
    : '无'
  const errors = manifest.errorClassifications.map(category => `- \`${category}\``).join('\n')
  const freshness = renderSemanticPaths(input.freshnessPaths, '本次 capture 未批准 freshness 字段，不得推断新鲜度。')
  const windows = renderSemanticPaths(input.windowPaths, '本次 capture 未批准 window 字段，不得推断统计窗口。')
  const rejected = input.rejectedPaths.length > 0
    ? input.rejectedPaths.map(jsonPath => `- \`${jsonPath}\``).join('\n')
    : '- 无；本次 capture 未发现 allowlist 之外的字段路径。'

  return `# Meta Dataset Quality 官方契约\n\n` +
    `## 1. 验证环境与 commit\n\n` +
    `- 环境：\`${manifest.environment}\`\n` +
    `- Graph version：\`${manifest.graphVersion}\`\n` +
    `- RELEASE_COMMIT：\`${manifest.releaseCommit}\`\n` +
    `- capturedAt：\`${manifest.capturedAt}\`\n` +
    `- Dataset：\`${input.datasetMask}\`\n\n` +
    `## 2. 官方入口与权限\n\n${officialUrls}\n\n- 所需权限：${permissions}\n\n` +
    `## 3. HTTP request contract\n\n` +
    `- Method：\`${manifest.request.method}\`\n` +
    `- Graph version：\`${manifest.graphVersion}\`\n` +
    `- Endpoint path：\`${manifest.request.endpointPath}\`\n` +
    `- Query keys：${queryKeys}\n` +
    `- Dataset：\`${input.datasetMask}\`\n\n` +
    `## 4. allowlisted response schema\n\n` +
    `| JSON path | Type | Nullable |\n|---|---|---|\n${schemaRows}\n\n` +
    `## 5. error classification\n\n${errors}\n\n` +
    `## 6. freshness/window semantics\n\n` +
    `- Freshness paths：${freshness}\n` +
    `- Window paths：${windows}\n\n` +
    `## 7. retention and privacy\n\n` +
    `- 一次性 raw JSON 在任何处理结果后销毁；契约不保存响应值、完整 Dataset ID、token、用户数据或事件级标识。\n` +
    `- 正式 collector 只能使用本契约批准的 schema path，并从 verified MetaConnection 读取完整 Dataset ID。\n\n` +
    `## 8. redacted acceptance evidence\n\n` +
    `- Owner allowlist：已明确批准。\n` +
    `- 请求绑定：\`${manifest.environment}\` / \`${manifest.graphVersion}\` / \`${manifest.releaseCommit}\`。\n` +
    `- Dataset 证据：\`${input.datasetMask}\`。\n` +
    `- Schema 统计：批准 ${input.allowlistedSchema.length} 个路径，拒绝 ${input.rejectedPaths.length} 个未知路径。\n\n` +
    `## 9. rejected unknown fields\n\n${rejected}\n`
}

function renderSemanticPaths(paths, fallback) {
  return paths.length > 0 ? paths.map(jsonPath => `\`${jsonPath}\``).join('、') : fallback
}

async function readJsonInput(filePath, options) {
  const lstatFile = options.lstatFile || lstat
  const openFile = options.openFile || open
  let stats
  try {
    stats = await lstatFile(filePath)
  } catch {
    throw new ContractRecorderError(`${options.kind}_UNREADABLE`)
  }

  if (options.rawState && (stats.isFile() || stats.isSymbolicLink())) {
    options.rawState.candidate = fileIdentity(stats)
  }
  if (stats.isSymbolicLink()) throw new ContractRecorderError(`${options.kind}_SYMLINK`)
  if (!stats.isFile()) throw new ContractRecorderError(`${options.kind}_NOT_FILE`)
  if (stats.size > options.maxBytes) throw new ContractRecorderError(`${options.kind}_TOO_LARGE`)

  let handle
  try {
    const noFollow = constants.O_NOFOLLOW || 0
    const accessMode = options.rawState ? constants.O_RDWR : constants.O_RDONLY
    handle = await openFile(filePath, accessMode | noFollow)
    const openedStats = await handle.stat()
    if (!openedStats.isFile() || !sameIdentity(stats, openedStats) || openedStats.size > options.maxBytes) {
      throw new ContractRecorderError(`${options.kind}_UNREADABLE`)
    }
    if (options.rawState) {
      options.rawState.candidate = fileIdentity(openedStats)
      options.rawState.handle = handle
    }
    const bytes = await handle.readFile()
    if (bytes.length > options.maxBytes || bytes.includes(0)) throw new ContractRecorderError(`${options.kind}_NOT_JSON`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof ContractRecorderError) throw error
    throw new ContractRecorderError(`${options.kind}_NOT_JSON`)
  } finally {
    if (!options.rawState || options.rawState.handle !== handle) {
      await handle?.close().catch(() => {})
    }
  }
}

async function destroyRawFile(rawPath, rawState, options) {
  if (!rawState.candidate && !rawState.handle) return
  const lstatFile = options.lstatFile || lstat
  const unlinkFile = options.unlinkFile || unlink
  let cleanupFailed = false

  if (rawState.handle) {
    try {
      await rawState.handle.truncate(0)
    } catch {
      cleanupFailed = true
    }
    try {
      await rawState.handle.sync()
    } catch {
      cleanupFailed = true
    }
    try {
      await rawState.handle.close()
    } catch {
      cleanupFailed = true
    }
    rawState.handle = null
  }

  if (rawState.candidate) {
    let current = null
    try {
      current = await lstatFile(rawPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupFailed = true
    }
    if (current) {
      if (!sameIdentity(rawState.candidate, current)) {
        cleanupFailed = true
      } else {
        try {
          await unlinkFile(rawPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') cleanupFailed = true
        }
      }
    }
  }

  if (cleanupFailed) throw new Error('raw cleanup failed')
}

async function stageContractFile(outputPath, document) {
  const parent = path.dirname(outputPath)
  const parentStats = await lstat(parent)
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new Error('invalid output parent')
  try {
    await lstat(outputPath)
    throw new Error('output exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const temporaryPath = path.join(parent, `.${path.basename(outputPath)}.${randomUUID()}.tmp`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(document, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
  await handle.close()

  let active = true
  return {
    async finalize() {
      if (!active) throw new Error('staged contract inactive')
      await link(temporaryPath, outputPath)
      await unlink(temporaryPath)
      active = false
    },
    async abort() {
      if (!active) return
      active = false
      await unlink(temporaryPath).catch(() => {})
    },
  }
}

async function readCurrentCommit(options) {
  if (options.currentCommit) return String(options.currentCommit).trim()
  if (options.getCurrentCommit) {
    try {
      return String(await options.getCurrentCommit()).trim()
    } catch {
      throw new ContractRecorderError('COMMIT_UNAVAILABLE')
    }
  }
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd: options.cwd || process.cwd(),
      encoding: 'utf8',
      maxBuffer: 1024,
    })
    return stdout.trim()
  } catch {
    throw new ContractRecorderError('COMMIT_UNAVAILABLE')
  }
}

function sanitizeOfficialUrl(value, datasetId) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ContractRecorderError('OFFICIAL_URL_INVALID')
  }
  if (
    url.protocol !== 'https:' ||
    !OFFICIAL_META_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) throw new ContractRecorderError('OFFICIAL_URL_INVALID')
  for (const key of url.searchParams.keys()) {
    if (!FIELD_NAME_PATTERN.test(key) || isSensitiveKey(key)) throw new ContractRecorderError('OFFICIAL_URL_INVALID')
  }

  let decodedPath
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    throw new ContractRecorderError('OFFICIAL_URL_INVALID')
  }
  if (decodedPath.includes('%') || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(decodedPath)) {
    throw new ContractRecorderError('OFFICIAL_URL_INVALID')
  }

  const datasetMask = maskDatasetId(datasetId)
  const pathSegments = decodedPath.split('/')
  const datasetSegments = pathSegments.filter(segment => segment === datasetId)
  if (
    datasetSegments.length === 0 ||
    pathSegments.some(segment => segment !== datasetId && segment.includes(datasetId))
  ) {
    throw new ContractRecorderError('OFFICIAL_URL_INVALID')
  }

  const queryKeys = [...new Set(url.searchParams.keys())].sort()
  const safePath = pathSegments.map(segment => segment === datasetId ? datasetMask : segment).join('/')
  assertDatasetIdAbsent([safePath, ...queryKeys], datasetId, 'OFFICIAL_URL_INVALID')
  return `${url.origin}${safePath}${queryKeys.length > 0 ? `?${queryKeys.join('&')}` : ''}`
}

function validateNameList(value, pattern, code, options = {}) {
  if (!Array.isArray(value) || value.length > 32 || (!options.allowEmpty && value.length === 0)) {
    throw new ContractRecorderError(code)
  }
  if (value.some(item => typeof item !== 'string' || !pattern.test(item))) throw new ContractRecorderError(code)
  if (new Set(value).size !== value.length) throw new ContractRecorderError(code)
  return [...value].sort()
}

function assertRecordWithKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractRecorderError(code)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ContractRecorderError(code)
  }
}

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized.includes('accesstoken') ||
    normalized.includes('testeventcode') ||
    normalized.includes('email') ||
    normalized === 'em' ||
    normalized.includes('phone') ||
    normalized === 'ph' ||
    normalized === 'clientip' ||
    normalized === 'clientua' ||
    normalized === 'ip' ||
    normalized.includes('ipaddress') ||
    normalized === 'ua' ||
    normalized.includes('useragent') ||
    normalized === 'fbp' ||
    normalized === 'fbc' ||
    normalized.includes('externalid') ||
    normalized.includes('userid') ||
    normalized.includes('eventid') ||
    normalized.includes('deliveryid') ||
    normalized.includes('visitorid') ||
    normalized.includes('sessionid') ||
    normalized.includes('leadid') ||
    normalized === 'userdata'
}

function isSensitivePath(segments) {
  const normalized = segments.map(segment => String(segment).toLowerCase().replace(/[^a-z0-9]/g, ''))
  if (normalized.some(isSensitiveKey)) return true

  const sensitiveIdParents = new Set(['user', 'users', 'event', 'events', 'session', 'sessions', 'delivery', 'deliveries'])
  let hasSensitiveParent = false
  for (const segment of normalized) {
    if (sensitiveIdParents.has(segment)) hasSensitiveParent = true
    else if (hasSensitiveParent && (segment === 'id' || segment === 'ids')) return true
  }
  return false
}

function assertDatasetIdAbsent(values, datasetId, code) {
  for (const value of values) {
    let decoded = String(value)
    for (let pass = 0; pass <= 2; pass += 1) {
      if (decoded.includes(datasetId)) throw new ContractRecorderError(code)
      if (!decoded.includes('%')) break
      try {
        decoded = decodeURIComponent(decoded)
      } catch {
        break
      }
    }
  }
}

function maskDatasetId(datasetId) {
  return `${datasetId.slice(0, 4)}...${datasetId.slice(-4)}`
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function requirePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new ContractRecorderError('ARGUMENTS_INVALID')
  }
  return path.resolve(value)
}

function assertDistinctPaths(...paths) {
  if (new Set(paths).size !== paths.length) throw new ContractRecorderError('INPUT_PATH_COLLISION')
}

function fileIdentity(stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    kind: stats.isSymbolicLink() ? 'symlink' : stats.isFile() ? 'file' : 'other',
  }
}

function sameIdentity(left, rightStats) {
  const normalizedLeft = 'kind' in left ? left : fileIdentity(left)
  const right = 'kind' in rightStats ? rightStats : fileIdentity(rightStats)
  return normalizedLeft.dev === right.dev && normalizedLeft.ino === right.ino && normalizedLeft.kind === right.kind
}

async function abortQuietly(staged) {
  await staged?.abort?.().catch(() => {})
}

function asRecorderError(error) {
  return error instanceof ContractRecorderError ? error : new ContractRecorderError('INTERNAL_ERROR')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
