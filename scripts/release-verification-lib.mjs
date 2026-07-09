import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPORT_DIR = new URL('../reports/release-verification/', import.meta.url)

const REDACTION_PATTERNS = [
  /(access[_-]?token\s*[=:]\s*)([^\s,;]+)/gi,
  /(token\s*[=:]\s*)([^\s,;]+)/gi,
  /(secret\s*[=:]\s*)([^\s,;]+)/gi,
  /(password\s*[=:]\s*)([^\s,;]+)/gi,
  /(session\s*[=:]\s*)([^\s,;]+)/gi,
  /(cookie\s*[=:]\s*)([^\s,;]+)/gi,
]
const SUMMARY_LIMIT = 1200
const REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const VALID_REPORT_MODES = new Set(['quick', 'local-runtime', 'dev-rehearsal', 'release'])
const VALID_REPORT_STATUSES = new Set(['passed', 'failed', 'skipped'])
const RELEASE_CHILD_MODES = ['quick', 'local-runtime', 'dev-rehearsal']

export function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const redactedText = REDACTION_PATTERNS.reduce((current, pattern) => (
    current.replace(pattern, (_, prefix) => `${prefix}[REDACTED]`)
  ), text)

  return redactCredentialUrl(redactedText)
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
      const stderr = redact(error instanceof Error ? error.message : String(error))
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
      const stdout = redact(stdoutChunks.join('').trim())
      const stderr = redact(stderrChunks.join('').trim())
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
  const serializedReport = JSON.stringify(report, null, 2)
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

    const finishedAt = Date.parse(report.finishedAt || report.startedAt || '')
    if (Number.isNaN(finishedAt)) {
      reasons.push('报告缺少有效的 finishedAt 或 startedAt 时间')
    } else if (now - finishedAt > maxAgeMs) {
      reasons.push('报告已过期')
    }

    if (report.mode === 'release') {
      validateReleaseSummary(report, reasons)
    }
  }

  if (reasons.length > 0) {
    throw new Error(reasons.join('；'))
  }
}

function summarizeOutput(stdout, stderr) {
  const chunks = []
  if (stdout) chunks.push(`stdout: ${compactWhitespace(stdout)}`)
  if (stderr) chunks.push(`stderr: ${compactWhitespace(stderr)}`)
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
    if (typeof report.git.commit !== 'string' || report.git.commit.trim() === '') reasons.push('报告 git.commit 缺失、为空或类型非法')
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

function validateReleaseSummary(report, reasons) {
  if (!Array.isArray(report.steps)) return

  const stepMap = new Map(report.steps.map(step => [step?.name, step]))
  for (const mode of RELEASE_CHILD_MODES) {
    const step = stepMap.get(mode)
    if (!step) {
      reasons.push(`release 报告缺少 ${mode} 子模式摘要`)
      continue
    }

    if (step.status !== 'passed') {
      reasons.push(`release 报告中的 ${mode} 子模式未通过`)
    }

    if (typeof step.summary !== 'string' || step.summary.trim() === '') {
      reasons.push(`release 报告中的 ${mode} 子模式摘要为空`)
    }
  }
}

function validateNonEmptyString(value, reason, reasons) {
  if (typeof value !== 'string' || value.trim() === '') {
    reasons.push(reason)
  }
}

function compactWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
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

function isProductionBranchAllowed(branch, options) {
  const currentBranch = String(branch || '').trim()
  if (!currentBranch) return false

  const env = options.env || process.env
  const overrideBranch = String(env.VERIFY_RELEASE_ALLOW_BRANCH || '').trim()
  if (overrideBranch && currentBranch === overrideBranch) return true

  return currentBranch === 'main' || currentBranch.startsWith('release/')
}
