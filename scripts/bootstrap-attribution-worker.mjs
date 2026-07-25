#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
const WORKER_NAME = 'meigallery-attribution'

export const ATTRIBUTION_BOOTSTRAP_SECRET_NAMES = Object.freeze([
  'ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT',
  'ATTRIBUTION_SIGNING_KEY_CURRENT',
  'ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT',
])

export async function bootstrapAttributionWorker({
  apply,
  workerExists = inspectWorkerExists,
  generateSecret = () => randomBytes(48).toString('base64url'),
  deployWithSecrets = deployWorkerWithSecrets,
  log = console.log,
} = {}) {
  if (typeof apply !== 'boolean') {
    throw new Error('ATTRIBUTION_BOOTSTRAP_MODE_REQUIRED')
  }

  log(
    `首次部署计划：${WORKER_NAME} / shadow / `
    + `${ATTRIBUTION_BOOTSTRAP_SECRET_NAMES.length} secrets`,
  )
  if (!apply) {
    log('dry-run 完成：未生成 Secret，未部署 Worker')
    return { applied: false }
  }
  if (await workerExists()) {
    throw new Error('ATTRIBUTION_BOOTSTRAP_WORKER_ALREADY_EXISTS')
  }

  const secrets = Object.fromEntries(
    ATTRIBUTION_BOOTSTRAP_SECRET_NAMES.map(name => [
      name,
      generateSecret(),
    ]),
  )
  validateSecrets(secrets)
  await deployWithSecrets(secrets)

  log(
    `首次部署完成：${WORKER_NAME} 已原子配置 `
    + `${ATTRIBUTION_BOOTSTRAP_SECRET_NAMES.length} 个 Secret`,
  )
  return {
    applied: true,
    secretNames: [...ATTRIBUTION_BOOTSTRAP_SECRET_NAMES],
  }
}

async function inspectWorkerExists() {
  const result = await runWrangler([
    'deployments',
    'list',
    '--name',
    WORKER_NAME,
    '--json',
  ], { capture: true, allowMissingWorker: true })
  return result !== null
}

async function deployWorkerWithSecrets(secrets) {
  await runWrangler([
    'deploy',
    '--env=',
    '--strict',
    '--message',
    '归因 Worker 首次 shadow 部署',
    '--secrets-file',
    '/dev/stdin',
  ], {
    stdin: JSON.stringify(secrets),
  })
}

async function runWrangler(args, options = {}) {
  const child = spawn('corepack', [
    'pnpm',
    '--filter',
    '@meigallery/attribution',
    'exec',
    'wrangler',
    ...args,
  ], {
    cwd: ROOT_DIR,
    stdio: [
      options.stdin === undefined ? 'ignore' : 'pipe',
      options.capture ? 'pipe' : 'inherit',
      options.capture ? 'pipe' : 'inherit',
    ],
  })

  let stdout = ''
  let stderr = ''
  if (options.capture) {
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
  }
  if (options.stdin !== undefined) {
    child.stdin?.end(options.stdin)
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  if (exitCode === 0) return stdout
  if (
    options.allowMissingWorker
    && /does not exist on your account|code:\s*10007/i.test(stderr)
  ) {
    return null
  }
  throw new Error(
    `ATTRIBUTION_BOOTSTRAP_WRANGLER_FAILED:${args[0]}`,
  )
}

function validateSecrets(secrets) {
  const values = Object.values(secrets)
  if (
    values.length !== ATTRIBUTION_BOOTSTRAP_SECRET_NAMES.length
    || new Set(values).size !== values.length
    || values.some(value => (
      typeof value !== 'string'
      || new TextEncoder().encode(value).byteLength < 32
      || value.length > 4_096
    ))
  ) {
    throw new Error('ATTRIBUTION_BOOTSTRAP_SECRET_INVALID')
  }
}

function parseMode(args) {
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const unknown = args.filter(
    argument => argument !== '--dry-run' && argument !== '--apply',
  )
  if (unknown.length > 0 || dryRun === apply) {
    throw new Error(
      '用法：node scripts/bootstrap-attribution-worker.mjs --dry-run|--apply',
    )
  }
  return { apply }
}

async function main() {
  const { apply } = parseMode(process.argv.slice(2))
  await bootstrapAttributionWorker({ apply })
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
