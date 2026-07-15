#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))

export const REQUIRED_PRODUCTION_AD_QUEUES = Object.freeze([
  'meigallery-ad-meta',
  'meigallery-ad-meta-dlq',
  'meigallery-ad-tiktok',
  'meigallery-ad-tiktok-dlq',
  'meigallery-ad-google',
  'meigallery-ad-google-dlq',
])

export async function verifyAdPlatformQueues(options = {}) {
  const environment = String(options.environment || '')
  if (environment !== 'production') throw new Error('AD_PLATFORM_QUEUE_ENV_INVALID')
  verifyWranglerAdPlatformConfig(options.configSource ?? readFileSync(new URL('../packages/api/wrangler.toml', import.meta.url), 'utf8'))
  const inspectQueue = options.inspectQueue || defaultInspectQueue

  let inspected = 0
  for (const queue of REQUIRED_PRODUCTION_AD_QUEUES) {
    try {
      await inspectQueue(queue)
      inspected += 1
    }
    catch {
      return { status: 'failed', inspected, required: REQUIRED_PRODUCTION_AD_QUEUES.length, missing: queue }
    }
  }
  return { status: 'passed', inspected, required: REQUIRED_PRODUCTION_AD_QUEUES.length }
}

export function verifyWranglerAdPlatformConfig(source) {
  const tables = parseTomlTables(source)
  const producers = tables.filter(table => table.name === 'queues.producers').map(table => table.values)
  const consumers = tables.filter(table => table.name === 'queues.consumers').map(table => table.values)
  const triggers = tables.find(table => table.name === 'triggers')?.values
  const devTriggers = tables.find(table => table.name === 'env.dev.triggers')?.values
  const devQueues = tables.find(table => table.name === 'env.dev.queues')?.values

  const expectedProducers = new Map([
    ['AD_META_QUEUE', 'meigallery-ad-meta'],
    ['AD_TIKTOK_QUEUE', 'meigallery-ad-tiktok'],
    ['AD_GOOGLE_QUEUE', 'meigallery-ad-google'],
  ])
  const expectedDlq = new Map([
    ['meigallery-ad-meta', 'meigallery-ad-meta-dlq'],
    ['meigallery-ad-tiktok', 'meigallery-ad-tiktok-dlq'],
    ['meigallery-ad-google', 'meigallery-ad-google-dlq'],
  ])

  const validProducers = producers.length === expectedProducers.size
    && producers.every(producer => expectedProducers.get(producer.binding) === producer.queue)
  const queues = new Map(consumers.map(consumer => [consumer.queue, consumer]))
  const validConsumers = consumers.length === REQUIRED_PRODUCTION_AD_QUEUES.length
    && REQUIRED_PRODUCTION_AD_QUEUES.every(queue => queues.has(queue))
    && [...expectedDlq].every(([queue, dlq]) => {
      const consumer = queues.get(queue)
      return consumer?.max_retries === 3 && consumer.dead_letter_queue === dlq
    })
  const productionCron = Array.isArray(triggers?.crons) && triggers.crons.length === 1 ? triggers.crons[0] : ''
  const devCronsEmpty = Array.isArray(devTriggers?.crons) && devTriggers.crons.length === 0
  const devQueuesEmpty = Array.isArray(devQueues?.producers) && devQueues.producers.length === 0
    && Array.isArray(devQueues?.consumers) && devQueues.consumers.length === 0
    && !tables.some(table => table.name === 'env.dev.queues.producers' || table.name === 'env.dev.queues.consumers')

  if (!validProducers || !validConsumers || productionCron !== '*/15 * * * *' || !devCronsEmpty || !devQueuesEmpty) {
    throw new Error('AD_PLATFORM_WRANGLER_CONFIG_INVALID')
  }
  return { producers: producers.length, consumers: consumers.length, productionCron, devQueuesEmpty, devCronsEmpty }
}

function parseTomlTables(source) {
  const tables = []
  let current = null
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line) continue
    const arrayHeader = /^\[\[([^\]]+)\]\]$/.exec(line)
    const tableHeader = /^\[([^\]]+)\]$/.exec(line)
    if (arrayHeader || tableHeader) {
      current = { name: (arrayHeader ?? tableHeader)[1], values: {} }
      tables.push(current)
      continue
    }
    if (!current) continue
    const assignment = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line)
    if (assignment) current.values[assignment[1]] = parseTomlValue(assignment[2])
  }
  return tables
}

function parseTomlValue(value) {
  const trimmed = value.trim()
  if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) return JSON.parse(trimmed)
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed === '[]') return []
  const strings = /^\[(.*)\]$/.exec(trimmed)
  if (strings && strings[1].trim()) return strings[1].split(',').map(item => JSON.parse(item.trim()))
  return trimmed
}

export async function main(options = {}) {
  const stdout = options.stdout || process.stdout
  let report
  try {
    report = await verifyAdPlatformQueues({
      environment: options.environment ?? process.argv[2],
      inspectQueue: options.inspectQueue,
    })
  }
  catch {
    report = { status: 'failed', inspected: 0, required: REQUIRED_PRODUCTION_AD_QUEUES.length }
  }

  if (report.status === 'passed') {
    stdout.write(`AD_PLATFORM_QUEUE_PREFLIGHT_PASSED count=${report.inspected}\n`)
  }
  else {
    stdout.write(`AD_PLATFORM_QUEUE_PREFLIGHT_FAILED inspected=${report.inspected} required=${report.required}\n`)
  }
  return report
}

async function defaultInspectQueue(queue) {
  await execFile('corepack', [
    'pnpm', '--filter', '@meigallery/api', 'exec',
    'wrangler', 'queues', 'info', queue,
  ], {
    cwd: ROOT_DIR,
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await main()
  process.exitCode = report.status === 'passed' ? 0 : 1
}
