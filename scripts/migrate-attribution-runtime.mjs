#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import {
  normalizeOwnerSession,
  readHiddenOwnerSession,
} from './lib/owner-session.mjs'

const DEFAULT_API_URL = 'https://api.616618.xyz'
const DEFAULT_RUN_ID = 'migration-production-v1'
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const MAX_RESPONSE_BYTES = 64 * 1024

export {
  normalizeOwnerSession,
  readHiddenOwnerSession,
}

export function parseMigrationArgs(argv) {
  const input = argv[0] === '--' ? argv.slice(1) : [...argv]
  const options = {
    runId: DEFAULT_RUN_ID,
    phase: 'initial',
    initialRunId: undefined,
  }
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]
    if (argument === '--run-id') {
      options.runId = requireArgument(input[++index], argument)
      continue
    }
    if (argument === '--phase') {
      options.phase = requireArgument(input[++index], argument)
      continue
    }
    if (argument === '--initial-run-id') {
      options.initialRunId = requireArgument(input[++index], argument)
      continue
    }
    throw new Error(`ATTRIBUTION_MIGRATION_ARGUMENT_INVALID:${argument}`)
  }
  if (!IDENTIFIER_PATTERN.test(options.runId)) {
    throw new Error('ATTRIBUTION_MIGRATION_RUN_ID_INVALID')
  }
  if (
    (options.phase !== 'initial' && options.phase !== 'reconcile')
    || (
      options.phase === 'initial'
        ? options.initialRunId !== undefined
        : !IDENTIFIER_PATTERN.test(options.initialRunId ?? '')
    )
  ) {
    throw new Error('ATTRIBUTION_MIGRATION_PHASE_INVALID')
  }
  return {
    apiUrl: DEFAULT_API_URL,
    runId: options.runId,
    phase: options.phase,
    initialRunId: options.initialRunId,
  }
}

export async function runAttributionMigration(options = {}) {
  const parsed = parseMigrationArgs(options.argv ?? [])
  const promptSession = options.promptSession ?? readHiddenOwnerSession
  const sessionInput = await promptSession()
  const cookie = normalizeOwnerSession(sessionInput)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const log = options.log ?? console.log

  const response = await fetchImpl(
    `${parsed.apiUrl}/api/admin/attribution-migration`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': parsed.runId,
        Cookie: cookie,
      },
      body: JSON.stringify(parsed.phase === 'initial'
        ? {
          runId: parsed.runId,
          phase: parsed.phase,
        }
        : {
          runId: parsed.runId,
          phase: parsed.phase,
          initialRunId: parsed.initialRunId,
        }),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    },
  )
  const body = await readBoundedJson(response)
  if (!response.ok) {
    throw new Error(
      `ATTRIBUTION_MIGRATION_FAILED:${response.status}:${safeCode(body)}`,
    )
  }
  const result = parseResult(body, parsed.runId)
  log(JSON.stringify({
    status: 'completed',
    runId: result.runId,
    phase: result.phase,
    snapshotHash: result.snapshotHash,
    sourceConfigurationHash: result.sourceConfigurationHash,
    capturedAt: result.capturedAt,
    replayed: result.replayed,
    counts: result.counts,
  }))
  return result
}

async function readBoundedJson(response) {
  const raw = await response.arrayBuffer()
  if (raw.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new Error('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
}

function parseResult(value, expectedRunId) {
  const data = isRecord(value) ? value.data : null
  if (
    !isRecord(data)
    || data.runId !== expectedRunId
    || (data.phase !== 'initial' && data.phase !== 'reconcile')
    || typeof data.snapshotHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(data.snapshotHash)
    || typeof data.sourceConfigurationHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(data.sourceConfigurationHash)
    || typeof data.credentialSetHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(data.credentialSetHash)
    || !isCanonicalTimestamp(data.capturedAt)
    || typeof data.replayed !== 'boolean'
    || !isRecord(data.counts)
  ) {
    throw new Error('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
  const countKeys = [
    'connections',
    'versions',
    'credentials',
    'bindings',
    'managedSources',
    'historyRows',
    'historyFacts',
  ]
  if (countKeys.some(key =>
    !Number.isSafeInteger(data.counts[key])
    || data.counts[key] < 0)) {
    throw new Error('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
  return data
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value
}

function safeCode(value) {
  if (
    isRecord(value)
    && typeof value.code === 'string'
    && IDENTIFIER_PATTERN.test(value.code)
  ) {
    return value.code
  }
  return 'ATTRIBUTION_MIGRATION_UPSTREAM_ERROR'
}

function requireArgument(value, name) {
  if (!value || value.startsWith('--')) {
    throw new Error(`ATTRIBUTION_MIGRATION_ARGUMENT_REQUIRED:${name}`)
  }
  return value
}

function isRecord(value) {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

async function main() {
  try {
    await runAttributionMigration({ argv: process.argv.slice(2) })
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'ATTRIBUTION_MIGRATION_FAILED',
    )
    process.exitCode = 1
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
