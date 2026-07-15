#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
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
