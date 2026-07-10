#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { recordReleaseVerificationSummary } from './release-verification-store.mjs'
import { runCommand } from './release-verification-lib.mjs'

const RESOURCE_CONFIG = {
  production: {
    envArgs: ['--env', ''],
    database: 'meigallery-db',
    worker: 'meigallery-api',
    mainQueue: 'meigallery-meta-capi',
    dlq: 'meigallery-meta-capi-dlq',
  },
  dev: {
    envArgs: ['--env', 'dev'],
    database: 'meigallery-db-dev',
    worker: 'meigallery-api-dev',
    mainQueue: 'meigallery-meta-capi-dev',
    dlq: 'meigallery-meta-capi-dev-dlq',
  },
}
const REQUIRED_SECRETS = ['META_CAPI_ACCESS_TOKEN', 'META_CAPI_TEST_EVENT_CODE']
const SETTING_SQL = "SELECT value FROM site_settings WHERE key = 'meta_capi_enabled'"

export async function runMetaResourceVerification(options = {}) {
  const environment = String(options.environment || '')
  const config = RESOURCE_CONFIG[environment]
  if (!config) throw new Error('--env 只允许 dev 或 production')
  if (options.initialMetaRollout !== undefined && typeof options.initialMetaRollout !== 'boolean') throw new Error('initialMetaRollout 必须为布尔值')
  const runCommandFn = options.runCommand || runCommand
  const recordSummary = options.recordSummary || recordReleaseVerificationSummary
  const calls = [
    command('queue-main', ['queues', 'info', config.mainQueue]),
    command('queue-dlq', ['queues', 'info', config.dlq]),
    command('consumer-main', ['queues', 'consumer', 'worker', 'list', config.mainQueue, '--json']),
    command('consumer-dlq', ['queues', 'consumer', 'worker', 'list', config.dlq, '--json']),
    command('secrets', ['secret', 'list', ...config.envArgs, '--format', 'json']),
    command('migrations', ['d1', 'migrations', 'list', config.database, ...config.envArgs, '--remote']),
    command('capi-setting', ['d1', 'execute', config.database, ...config.envArgs, '--remote', '--command', SETTING_SQL]),
  ]
  const results = []
  for (const definition of calls) {
    results.push(await runCommandFn('corepack', [
      'pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...definition.args,
    ], {
      cwd: options.cwd || process.cwd(),
      name: `meta-resources-${environment}-${definition.name}`,
      reportCommand: definition.reportCommand,
    }))
  }

  const byName = new Map(calls.map((definition, index) => [definition.name, results[index]]))
  const commandsPassed = results.every(result => result.status === 'passed')
  const mainConsumerPresent = hasExpectedConsumer(byName.get('consumer-main')?.stdout, config.worker)
  const dlqConsumerPresent = hasExpectedConsumer(byName.get('consumer-dlq')?.stdout, config.worker)
  const secretsPresent = hasRequiredSecrets(byName.get('secrets')?.stdout)
  const migrationsCurrent = !/Migrations to be applied/i.test(String(byName.get('migrations')?.stdout || ''))
  const capiEnabled = parseCapiEnabled(byName.get('capi-setting')?.stdout)
  const initialMetaRollout = options.initialMetaRollout === true
  const initialStateReady = !initialMetaRollout || capiEnabled === false
  let status = commandsPassed && mainConsumerPresent && dlqConsumerPresent && secretsPresent && migrationsCurrent && capiEnabled !== null && initialStateReady
    ? 'passed'
    : 'failed'
  let summaryRecorded = false

  if (status === 'passed' && options.reportOnly !== true) {
    if (!/^[0-9a-f]{40}$/i.test(String(options.commit || ''))) {
      status = 'failed'
    } else {
      const storeStep = await recordSummary({
        environment,
        verificationType: 'meta_resources',
        commit: options.commit,
        verifiedAt: options.now,
        summary: {
          queuesReady: mainConsumerPresent && dlqConsumerPresent,
          secretsReady: secretsPresent,
          migrationsCurrent,
          capiEnabled,
          initialMetaRollout,
        },
        cwd: options.cwd,
        runCommand: options.runCommand,
      })
      summaryRecorded = storeStep?.status === 'passed'
      if (!summaryRecorded) status = 'failed'
    }
  }

  return {
    schemaVersion: 1,
    status,
    environment,
    commit: /^[0-9a-f]{40}$/i.test(String(options.commit || '')) ? String(options.commit) : '',
    database: config.database,
    queues: [config.mainQueue, config.dlq],
    consumersPresent: mainConsumerPresent && dlqConsumerPresent,
    secretsPresent,
    migrationsCurrent,
    capiEnabled,
    initialMetaRollout,
    reportOnly: options.reportOnly === true,
    summaryRecorded,
  }
}

function command(name, args) {
  return {
    name,
    args,
    reportCommand: `corepack pnpm --filter @meigallery/api exec wrangler ${args.map(arg => arg === '' ? '""' : arg).join(' ')}`,
  }
}

function hasExpectedConsumer(stdout, worker) {
  try {
    const parsed = JSON.parse(String(stdout || ''))
    const consumers = Array.isArray(parsed) ? parsed : parsed?.consumers
    return Array.isArray(consumers) && consumers.some(consumer => (
      consumer?.service_name === worker || consumer?.serviceName === worker || consumer?.script_name === worker
    ))
  } catch {
    return false
  }
}

function hasRequiredSecrets(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || ''))
    const secrets = Array.isArray(parsed) ? parsed : parsed?.secrets
    const names = new Set(Array.isArray(secrets) ? secrets.map(secret => secret?.name) : [])
    return REQUIRED_SECRETS.every(name => names.has(name))
  } catch {
    return false
  }
}

function parseCapiEnabled(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || ''))
    const containers = Array.isArray(parsed) ? parsed : [parsed]
    const value = containers.flatMap(container => Array.isArray(container?.results) ? container.results : [])
      .find(row => Object.hasOwn(row || {}, 'value'))?.value
    if (value === true || value === 1 || value === 'true' || value === '1' || value === '"true"') return true
    if (value === false || value === 0 || value === 'false' || value === '0' || value === '"false"') return false
    return null
  } catch {
    return null
  }
}

async function readCommit(options = {}) {
  const runCommandFn = options.runCommand || runCommand
  const result = await runCommandFn('git', ['rev-parse', 'HEAD'], {
    cwd: options.cwd || process.cwd(),
    name: 'git-commit',
  })
  if (result.status !== 'passed') throw new Error('无法读取当前 Git commit')
  return String(result.stdout || '').trim()
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const environmentIndex = argv.indexOf('--env')
  const environment = environmentIndex >= 0 ? argv[environmentIndex + 1] : ''
  const reportOnly = argv.includes('--report-only')
  const initialMetaRollout = argv.includes('--initial-meta-rollout')
  const allowed = new Set(['--env', environment, '--report-only', '--initial-meta-rollout'])
  if (!environment || argv.some(argument => !allowed.has(argument))) throw new Error('用法：verify-meta-resources.mjs --env dev|production [--initial-meta-rollout] [--report-only]')
  const commit = reportOnly ? undefined : await readCommit(options)
  const report = await runMetaResourceVerification({ ...options, environment, reportOnly, initialMetaRollout, commit })
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'passed') throw new Error(`Meta ${environment} 资源检查失败`)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
