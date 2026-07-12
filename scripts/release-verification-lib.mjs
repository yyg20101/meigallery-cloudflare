import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPORT_DIR = new URL('../reports/release-verification/', import.meta.url)

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000

const REDACTION_PATTERNS = [
  /(access[_-]?token\s*[=:]\s*)(?:(["'`])[^"'`\r\n]*\2|([^\s,;&}"'`\]]+))/gi,
  /(token\s*[=:]\s*)(?:(["'`])[^"'`\r\n]*\2|([^\s,;&}"'`\]]+))/gi,
  /(secret\s*[=:]\s*)(?:(["'`])[^"'`\r\n]*\2|([^\s,;&}"'`\]]+))/gi,
  /(password\s*[=:]\s*)(?:(["'`])[^"'`\r\n]*\2|([^\s,;&}"'`\]]+))/gi,
  /(session\s*[=:]\s*)(?:(["'`])[^"'`\r\n]*\2|([^\s,;&}"'`\]]+))/gi,
  /(cookie\s*[=:]\s*)(?:(["'`])[^"'`\r\n]*\2|([^\s,;&}"'`\]]+))/gi,
]
const CREDENTIAL_CONTEXT_KEYS = new Set([
  'authorization',
  'cookie',
  'session',
  'setcookie',
])
const CREDENTIAL_CONTEXT_SUFFIXES = [
  'token',
  'secret',
  'password',
  'apikey',
  'privatekey',
  'credential',
  'credentials',
  'authorizationheader',
  'cookieheader',
]
const PRIVATE_EMAIL_PATTERN = /(?<![A-Z0-9.!#$%&'*+=?^_{|}~-])[A-Z0-9.!#$%&'*+=?^_{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,63}(?![A-Z0-9-])/gi
const PRIVATE_BROWSER_ID_PATTERN = /\bfb\.1\.\d{10,}\.[A-Z0-9._-]+\b/gi
const PRIVATE_MATCH_ID_PATTERN = /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{32})(?![0-9a-f])/gi
const PRIVATE_IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const PRIVATE_IPV6_PATTERN = /(?<![0-9a-f:])[0-9a-f]*:[0-9a-f:.]*:[0-9a-f:.]*(?![0-9a-f:])/gi
const PRIVATE_USER_AGENT_PATTERNS = [
  /\bMozilla\/5\.0[^\r\n|]{0,512}/gi,
  /\b(?:curl|Wget|PostmanRuntime|okhttp)\/\d+(?:\.\d+)*(?:[^\r\n|]{0,200})?/gi,
  /\b(?:[A-Z][A-Z0-9._-]*)?(?:Agent|Browser|Client)\/\d+(?:\.\d+)*(?:[^\r\n|,;]{0,200})?/gi,
]
const PRIVACY_REDACTION = '[PRIVATE_REDACTED]'
const SANITIZED_PRIVATE_VALUES = new Set([PRIVACY_REDACTION, '[REDACTED]'])
const SUMMARY_LIMIT = 1200
const REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const VALID_REPORT_MODES = new Set(['quick', 'local-runtime', 'dev-rehearsal', 'release'])
const VALID_REPORT_STATUSES = new Set(['passed', 'failed', 'skipped'])
const RELEASE_CHILD_MODES = ['quick', 'local-runtime', 'dev-rehearsal']

export function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const redactedText = REDACTION_PATTERNS.reduce((current, pattern) => (
    current.replace(pattern, (_, prefix, quote) => `${prefix}${quote || ''}[REDACTED]${quote || ''}`)
  ), text)

  return redactCredentialUrl(redactedText)
}

export function redactMachineOutput(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const parsed = parseStructuredJsonString(text)
  if (parsed === null) return redact(text)
  return JSON.stringify(redactMachineValue(parsed))
}

export function createStep(name) {
  return {
    name,
    status: 'skipped',
    durationMs: 0,
    command: '',
    exitCode: null,
    summary: '',
  }
}

export async function runCommand(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    name = args[0] || command,
    reportCommand,
  } = options

  const startedAt = Date.now()
  const stdoutChunks = []
  const stderrChunks = []
  const renderedCommand = reportCommand || [command, ...args].join(' ')

  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', chunk => {
      stdoutChunks.push(String(chunk))
    })

    child.stderr.on('data', chunk => {
      stderrChunks.push(String(chunk))
    })

    child.on('error', error => {
      const durationMs = Date.now() - startedAt
      const stderr = redactMachineOutput(error instanceof Error ? error.message : String(error))
      resolve({
        ...createStep(name),
        status: 'failed',
        durationMs,
        command: renderedCommand,
        exitCode: null,
        summary: summarizeOutput('', stderr),
        stdout: '',
        stderr,
      })
    })

    child.on('close', code => {
      const durationMs = Date.now() - startedAt
      const stdout = redactMachineOutput(stdoutChunks.join('').trim())
      const stderr = redactMachineOutput(stderrChunks.join('').trim())
      resolve({
        ...createStep(name),
        status: code === 0 ? 'passed' : 'failed',
        durationMs,
        command: renderedCommand,
        exitCode: code,
        summary: summarizeOutput(stdout, stderr),
        stdout,
        stderr,
      })
    })
  })
}

export async function fetchWithTimeout(fetchFn, input, init = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_FETCH_TIMEOUT_MS
  const timeoutController = new AbortController()
  const callerSignal = init?.signal
  let timeoutId
  let rejectAbortPromise = () => {}

  const abortPromise = new Promise((_, reject) => {
    rejectAbortPromise = reject
  })

  const abortRequest = (reason) => {
    const error = reason instanceof Error ? reason : new Error('请求已取消')
    if (!timeoutController.signal.aborted) timeoutController.abort(error)
    rejectAbortPromise(error)
  }

  const onCallerAbort = () => {
    abortRequest(callerSignal.reason)
  }

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`请求超时：${safeTimeoutMs}ms`)
      if (!timeoutController.signal.aborted) timeoutController.abort(error)
      reject(error)
    }, safeTimeoutMs)
  })

  if (isAbortSignal(callerSignal)) {
    if (callerSignal.aborted) {
      abortRequest(callerSignal.reason)
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
  }

  const requestPromise = Promise.resolve().then(() => fetchFn(input, {
    ...(init || {}),
    signal: timeoutController.signal,
  }))

  try {
    return await Promise.race([requestPromise, timeoutPromise, abortPromise])
  } finally {
    clearTimeout(timeoutId)
    if (isAbortSignal(callerSignal)) callerSignal.removeEventListener('abort', onCallerAbort)
  }
}

export async function collectVersions(options = {}) {
  const cwd = options.cwd || process.cwd()
  const [nodeVersion, pnpmVersion, wranglerVersion] = await Promise.all([
    runCommand('node', ['--version'], { cwd, name: 'node-version' }),
    runCommand('corepack', ['pnpm', '--version'], { cwd, name: 'pnpm-version' }),
    runCommand('corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', '--version'], {
      cwd,
      name: 'wrangler-version',
    }),
  ])

  return {
    node: firstLine(nodeVersion.stdout),
    pnpm: firstLine(pnpmVersion.stdout),
    wrangler: firstLine(wranglerVersion.stdout),
  }
}

export async function getGitState(options = {}) {
  const cwd = options.cwd || process.cwd()
  const [branchStep, commitStep, statusStep, remoteStep] = await Promise.all([
    runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, name: 'git-branch' }),
    runCommand('git', ['rev-parse', 'HEAD'], { cwd, name: 'git-commit' }),
    runCommand('git', ['status', '--porcelain'], { cwd, name: 'git-status' }),
    runCommand('git', ['remote', 'get-url', 'origin'], { cwd, name: 'git-remote' }),
  ])

  return {
    branch: branchStep.status === 'passed' ? firstLine(branchStep.stdout) : '',
    commit: commitStep.status === 'passed' ? firstLine(commitStep.stdout) : '',
    isClean: statusStep.status === 'passed' && statusStep.stdout.trim() === '',
    remote: redactCredentialUrl(firstLine(remoteStep.stdout)),
  }
}

export async function writeReport(report, options = {}) {
  const reportDir = resolveReportDir(options.reportDir)
  const finishedAt = report.finishedAt || new Date().toISOString()
  const safeReport = sanitizeReportValue(report)
  const serializedReport = JSON.stringify(safeReport, null, 2)
  const timestamp = finishedAt.replaceAll(':', '-')
  const commitSuffix = report.git?.commit ? `-${report.git.commit.slice(0, 12)}` : ''
  const reportFile = path.join(reportDir, `${timestamp}-${report.mode}${commitSuffix}.json`)
  const latestFile = path.join(reportDir, 'latest.json')

  await mkdir(reportDir, { recursive: true })
  await writeFile(reportFile, serializedReport)
  await writeFile(latestFile, serializedReport)

  return {
    reportFile,
    latestFile,
  }
}

function sanitizeReportValue(value, contextKey = '') {
  const normalizedKey = normalizeContextKey(contextKey)
  if (isPrivateContextKey(normalizedKey)) {
    return typeof value === 'string' && SANITIZED_PRIVATE_VALUES.has(value)
      ? value
      : PRIVACY_REDACTION
  }
  if (typeof value === 'string') {
    const parsed = parseStructuredJsonString(value)
    if (parsed !== null) return JSON.stringify(sanitizeReportValue(parsed))
    return redactForReport(value)
  }
  if (Array.isArray(value)) return value.map(child => sanitizeReportValue(child, contextKey))
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    const reservedKeys = new Set(entries
      .map(([key]) => key)
      .filter(key => redactForReport(key) === key))
    const sanitizedEntries = []
    let privateKeyIndex = 1
    for (const [key, child] of entries) {
      let safeKey = key
      if (redactForReport(key) !== key) {
        do {
          safeKey = `private_redacted_${privateKeyIndex}`
          privateKeyIndex += 1
        } while (reservedKeys.has(safeKey))
        reservedKeys.add(safeKey)
      }
      sanitizedEntries.push([safeKey, sanitizeReportValue(child, key)])
    }
    return Object.fromEntries(sanitizedEntries)
  }
  return value
}

function redactMachineValue(value) {
  if (Array.isArray(value)) return value.map(redactMachineValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isCredentialContextKey(key) ? '[REDACTED]' : redactMachineValue(child),
  ]))
}

function isCredentialContextKey(key) {
  const normalizedKey = normalizeContextKey(key)
  return CREDENTIAL_CONTEXT_KEYS.has(normalizedKey)
    || CREDENTIAL_CONTEXT_SUFFIXES.some(suffix => normalizedKey.endsWith(suffix))
}

function isPrivateContextKey(normalizedKey) {
  return normalizedKey.includes('useragent') || normalizedKey === 'fbp' || normalizedKey === 'fbc'
}

function normalizeContextKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function redactPrivateData(value) {
  let output = redactPrivateEmails(String(value))
  output = output.replace(PRIVATE_BROWSER_ID_PATTERN, PRIVACY_REDACTION)
  output = output.replace(PRIVATE_MATCH_ID_PATTERN, PRIVACY_REDACTION)
  output = output.replace(PRIVATE_IPV4_PATTERN, candidate => isIP(candidate) === 4 ? PRIVACY_REDACTION : candidate)
  output = output.replace(PRIVATE_IPV6_PATTERN, candidate => isIP(candidate) === 6 ? PRIVACY_REDACTION : candidate)
  for (const pattern of PRIVATE_USER_AGENT_PATTERNS) output = output.replace(pattern, PRIVACY_REDACTION)
  return output
}

function redactForReport(value) {
  return redactPrivateData(redact(value))
}

function redactPrivateEmails(value) {
  return value.replace(PRIVATE_EMAIL_PATTERN, (candidate, offset, source) => {
    const before = source.slice(0, offset)
    const after = source.slice(offset + candidate.length)
    if (candidate.toLowerCase().startsWith('git@')
      && (before.toLowerCase().endsWith('ssh://') || after.startsWith(':') || after.startsWith('/'))) {
      return candidate
    }
    return PRIVACY_REDACTION
  })
}

export async function readLatestReport(options = {}) {
  const reportDir = resolveReportDir(options.reportDir)
  const latestFile = path.join(reportDir, 'latest.json')
  const content = await readFile(latestFile, 'utf8')
  return JSON.parse(content)
}

export function assertReportCanGateProduction(report, options = {}) {
  const now = options.now ? new Date(options.now).getTime() : Date.now()
  const maxAgeMs = options.maxAgeMs ?? REPORT_MAX_AGE_MS
  const reasons = []

  if (!report || typeof report !== 'object') {
    reasons.push('报告不存在或格式非法')
  } else {
    validateReportShape(report, reasons)
    if (!VALID_REPORT_MODES.has(report.mode)) reasons.push(`不支持的报告模式：${String(report.mode)}`)
    if (!VALID_REPORT_STATUSES.has(report.status)) reasons.push(`不支持的报告状态：${String(report.status)}`)
    if (report.status !== 'passed') reasons.push('报告状态不是 passed')
    if (report.mode !== 'release') reasons.push('生产部署只接受 release 模式报告')
    if (!report.git?.isClean) reasons.push('报告对应工作区不是干净状态')

    if (options.expectedCommit && report.git?.commit !== options.expectedCommit) {
      reasons.push('报告 commit 与当前待发布 commit 不一致')
    }

    if (options.currentBranch && !isProductionBranchAllowed(options.currentBranch, options)) {
      reasons.push('当前分支不是 main 或 release/*，拒绝放行生产部署')
    }
    if (report.git?.branch && !isProductionBranchAllowed(report.git.branch, options)) {
      reasons.push('报告生成分支不是 main 或 release/*，拒绝放行生产部署')
    }

    const startedAt = Date.parse(report.startedAt || '')
    if (Number.isNaN(startedAt)) {
      reasons.push('报告缺少有效的 startedAt 时间')
    } else if (now - startedAt > maxAgeMs) {
      reasons.push('报告已过期')
    }

    if (report.mode === 'release') {
      validateReleaseSummary(report, reasons, now)
    }
  }

  if (reasons.length > 0) {
    throw new Error(reasons.join('；'))
  }
}

function summarizeOutput(stdout, stderr) {
  const chunks = []
  if (stdout) chunks.push(`stdout: ${compactWhitespace(sanitizeReportValue(stdout))}`)
  if (stderr) chunks.push(`stderr: ${compactWhitespace(sanitizeReportValue(stderr))}`)
  if (chunks.length === 0) return '无输出'

  const summary = chunks.join(' | ')
  return summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT)}...` : summary
}

function validateReportShape(report, reasons) {
  if (report.schemaVersion !== 1) reasons.push('报告 schemaVersion 必须为 1')
  if (typeof report.mode !== 'string') reasons.push('报告 mode 缺失或类型非法')
  if (typeof report.status !== 'string') reasons.push('报告 status 缺失或类型非法')
  if (typeof report.startedAt !== 'string') reasons.push('报告 startedAt 缺失或类型非法')
  if (typeof report.finishedAt !== 'string') reasons.push('报告 finishedAt 缺失或类型非法')
  if (typeof report.durationMs !== 'number' || Number.isNaN(report.durationMs)) reasons.push('报告 durationMs 缺失或类型非法')

  if (!report.git || typeof report.git !== 'object' || Array.isArray(report.git)) {
    reasons.push('报告 git 缺失或类型非法')
  } else {
    if (!/^[0-9a-f]{40}$/i.test(String(report.git.commit || '').trim())) reasons.push('报告 git.commit 必须为 40 位 SHA')
    if (typeof report.git.branch !== 'string' || report.git.branch.trim() === '') reasons.push('报告 git.branch 缺失、为空或类型非法')
    if (typeof report.git.isClean !== 'boolean') reasons.push('报告 git.isClean 缺失或类型非法')
  }

  if (!report.versions || typeof report.versions !== 'object' || Array.isArray(report.versions)) {
    reasons.push('报告 versions 缺失或类型非法')
  } else {
    validateNonEmptyString(report.versions.node, '报告 versions.node 缺失、为空或类型非法', reasons)
    validateNonEmptyString(report.versions.pnpm, '报告 versions.pnpm 缺失、为空或类型非法', reasons)
    validateNonEmptyString(report.versions.wrangler, '报告 versions.wrangler 缺失、为空或类型非法', reasons)
  }

  if (!Array.isArray(report.steps)) {
    reasons.push('报告 steps 缺失或类型非法')
  } else {
    report.steps.forEach((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        reasons.push(`报告 steps[${index}] 缺失或类型非法`)
        return
      }

      validateNonEmptyString(step.name, `报告 steps[${index}].name 缺失、为空或类型非法`, reasons)

      if (!VALID_REPORT_STATUSES.has(step.status)) {
        reasons.push(`报告 steps[${index}].status 缺失或不是 passed|failed|skipped`)
      }

      if (typeof step.durationMs !== 'number' || Number.isNaN(step.durationMs) || step.durationMs < 0) {
        reasons.push(`报告 steps[${index}].durationMs 缺失或不是非负数字`)
      }

      if (Object.hasOwn(step, 'command') && typeof step.command !== 'string') {
        reasons.push(`报告 steps[${index}].command 类型非法`)
      }

      if (Object.hasOwn(step, 'summary') && typeof step.summary !== 'string') {
        reasons.push(`报告 steps[${index}].summary 类型非法`)
      }
    })
  }

  if (!Array.isArray(report.artifacts)) {
    reasons.push('报告 artifacts 缺失或类型非法')
  } else {
    report.artifacts.forEach((artifact, index) => {
      validateNonEmptyString(artifact, `报告 artifacts[${index}] 缺失、为空或类型非法`, reasons)
    })
  }

  if (!Array.isArray(report.notes)) {
    reasons.push('报告 notes 缺失或类型非法')
  } else {
    report.notes.forEach((note, index) => {
      if (typeof note !== 'string') {
        reasons.push(`报告 notes[${index}] 缺失或类型非法`)
      }
    })
  }
}

function validateReleaseSummary(report, reasons, now) {
  if (!Array.isArray(report.steps)) return

  const stepMap = new Map(report.steps.map(step => [step?.name, step]))
  const releaseSubModeMap = Array.isArray(report.releaseSubModes)
    ? new Map(report.releaseSubModes.map(item => [item?.mode, item]))
    : null

  if (!releaseSubModeMap) {
    reasons.push('release 报告 releaseSubModes 缺失或类型非法')
  }

  for (const mode of RELEASE_CHILD_MODES) {
    const step = stepMap.get(mode)
    if (!step) {
      reasons.push(`release 报告缺少 ${mode} 子模式摘要`)
    } else {
      if (step.status !== 'passed') {
        reasons.push(`release 报告中的 ${mode} 子模式未通过`)
      }

      if (typeof step.summary !== 'string' || step.summary.trim() === '') {
        reasons.push(`release 报告中的 ${mode} 子模式摘要为空`)
      }

      if (typeof step.summary === 'string' && (step.summary.includes('未生成通过步骤摘要') || step.summary.includes('没有真实通过步骤'))) {
        reasons.push(`release 报告中的 ${mode} 子模式使用了占位摘要`)
      }

      if (!hasNonEmptyStringArray(step.passedStepNames)) {
        reasons.push(`release 报告中的 ${mode} 子模式缺少真实 passed step 摘要`)
      }
    }

    const releaseSubMode = releaseSubModeMap?.get(mode)
    if (!releaseSubMode) {
      reasons.push(`releaseSubModes 缺少 ${mode} 子模式`)
      continue
    }

    if (releaseSubMode.status !== 'passed') {
      reasons.push(`releaseSubModes 中的 ${mode} 子模式未通过`)
    }

    if (!hasNonEmptyStringArray(releaseSubMode.passedStepNames)) {
      reasons.push(`releaseSubModes 中的 ${mode} 子模式缺少 passedStepNames`)
    }
  }

  validateMetaReleaseSummary(report, reasons, now)
}

function validateMetaReleaseSummary(report, reasons, now) {
  const bootstrap = report.initialMetaRollout === true
  const live = report.metaLiveVerification
  if (bootstrap && live?.status === 'skipped') {
    // 冷启动的真实 Test Event 在 production rollout=0 部署后完成。
  } else if (!live || typeof live !== 'object' || Array.isArray(live)) {
    reasons.push('release 报告缺少 Meta live evidence 摘要')
  } else {
    if (live.status !== 'passed') reasons.push('Meta live evidence 未通过')
    if (live.commit !== report.git?.commit) reasons.push('Meta live evidence commit 与报告 commit 不一致')
    if (live.environment !== 'dev') reasons.push('Meta live evidence 必须来自 dev')
    if (!Array.isArray(live.events) || live.events.length !== 2 || !['Contact', 'CompleteRegistration'].every(name => live.events.includes(name))) {
      reasons.push('Meta live evidence 事件集合不完整')
    }
    if (live.enhancedMatchVerified !== true) reasons.push('Meta live evidence 增强匹配未通过')
    if (live.forbiddenEventsAbsent !== true) reasons.push('Meta live evidence 禁止事件缺席未确认')
    const verifiedAt = Date.parse(live.verifiedAt || '')
    const expiresAt = Date.parse(live.expiresAt || '')
    if (Number.isNaN(verifiedAt) || Number.isNaN(expiresAt)) {
      reasons.push('Meta live evidence 时间格式非法')
    } else {
      if (expiresAt - verifiedAt !== 24 * 60 * 60 * 1000) reasons.push('Meta live evidence 有效期不是严格 24 小时')
      if (now >= expiresAt) reasons.push('Meta live evidence 已过期')
    }
  }

  const contract = report.datasetQualityContract
  if (!contract || contract.status !== 'passed'
    || !Number.isSafeInteger(contract.version) || contract.version < 1
    || !/^sha256:[0-9a-f]{64}$/.test(String(contract.digest || ''))) {
    reasons.push('Dataset Quality tracked approved contract/digest 未通过')
  }

  for (const environment of ['dev', 'production']) {
    const resource = report.metaResources?.[environment]
    if (bootstrap && environment === 'dev' && resource?.status === 'skipped') continue
    if (!resource || typeof resource !== 'object' || resource.status !== 'passed' || resource.environment !== environment) {
      reasons.push(`Meta ${environment} 资源检查未通过`)
    } else if (resource.commit !== report.git?.commit) {
      reasons.push(`Meta ${environment} 资源检查 commit 与报告 commit 不一致`)
    } else {
      const bootstrapProduction = environment === 'production'
        && report.initialMetaRollout === true
        && resource.phase === 'bootstrap'
      if (!bootstrapProduction && resource.connectionVerified !== true) reasons.push(`Meta ${environment} connection 未验证`)
      if (resource.openCriticalIncidentCount !== 0) reasons.push(`Meta ${environment} 存在 open critical incident`)
      if (bootstrapProduction) {
        const isolation = resource.environmentIsolation
        if (resource.r2Present !== true || resource.secretsPresent !== true
          || !isolation || !['d1', 'r2', 'queue', 'dlq'].every(key => isolation[key] === true)) {
          reasons.push('Meta production bootstrap 资源或环境隔离证明不完整')
        }
      }
      if (!bootstrap && environment === 'dev') {
        if (resource.datasetQualityContractVersion !== contract?.version
          || resource.datasetQualityContractDigest !== contract?.digest
          || resource.datasetQualityCollectorCurrent !== true) {
          reasons.push('dev Dataset Quality collector/contract digest 不是当前状态')
        }
      }
    }
  }

  if (report.initialMetaRollout === true) {
    const production = report.metaResources?.production
    if (production?.capiEnabled !== false) reasons.push('Meta 首次上线要求生产 CAPI 保持关闭')
    if (production?.targetRolloutPercentage !== 0 || production?.effectiveRolloutPercentage !== 0) {
      reasons.push('Meta 首次上线要求 production target/effective rollout 均为 0')
    }
  }
}

function validateNonEmptyString(value, reason, reasons) {
  if (typeof value !== 'string' || value.trim() === '') {
    reasons.push(reason)
  }
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim() !== '')
}

function compactWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function parseStructuredJsonString(value) {
  const trimmed = value.trim()
  if (!trimmed || !((trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']')))) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/, 1)[0].trim()
}

function resolveReportDir(reportDir) {
  if (reportDir instanceof URL) return fileURLToPath(reportDir)
  return reportDir || fileURLToPath(REPORT_DIR)
}

function redactCredentialUrl(value) {
  return String(value).replace(/(https?:\/\/)([^/\s@]+)@/gi, '$1[REDACTED]@')
}

function isAbortSignal(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function',
  )
}

function isProductionBranchAllowed(branch, options) {
  const currentBranch = String(branch || '').trim()
  if (!currentBranch) return false

  const env = options.env || process.env
  const overrideBranch = String(env.VERIFY_RELEASE_ALLOW_BRANCH || '').trim()
  if (overrideBranch && currentBranch === overrideBranch) return true

  return currentBranch === 'main' || currentBranch.startsWith('release/')
}
