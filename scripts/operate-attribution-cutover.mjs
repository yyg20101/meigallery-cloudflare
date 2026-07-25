#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  normalizeOwnerSession,
  readHiddenInput,
  readHiddenOwnerSession,
} from './lib/owner-session.mjs'

const API_URL = 'https://api.616618.xyz'
const DEFAULT_RUN_ID = 'cutover-production-v1'
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{3,160}$/
const PROVIDERS = ['meta', 'tiktok', 'google']
const TERMINAL_VALIDATION_STATES =
  new Set(['verified', 'failed', 'timed_out'])
const MAX_RESPONSE_BYTES = 64 * 1024

export function parseAttributionOperationArgs(argv) {
  const input = argv[0] === '--' ? argv.slice(1) : [...argv]
  const mode = input.shift()
  if (!['synthetic', 'activate', 'restore'].includes(mode)) {
    throw operationError('ARGUMENT_INVALID')
  }
  let runId = DEFAULT_RUN_ID
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]
    if (argument === '--run-id') {
      runId = requireArgument(input[++index])
      continue
    }
    throw operationError('ARGUMENT_INVALID')
  }
  if (!IDENTIFIER_PATTERN.test(runId)) {
    throw operationError('ARGUMENT_INVALID')
  }
  return { mode, runId, apiUrl: API_URL }
}

export async function runAttributionCutoverOperation(options = {}) {
  const parsed = options.parsed
    ?? parseAttributionOperationArgs(options.argv ?? [])
  const promptSession =
    options.promptSession ?? readHiddenOwnerSession
  const cookie = normalizeOwnerSession(await promptSession())
  const context = {
    ...parsed,
    cookie,
    fetch: options.fetch ?? globalThis.fetch,
    promptTestCode:
      options.promptTestCode ?? promptProviderTestCode,
    sleep: options.sleep ?? sleep,
    pollIntervalMs: options.pollIntervalMs ?? 5_000,
    pollTimeoutMs: options.pollTimeoutMs ?? 35 * 60 * 1_000,
    now: options.now ?? Date.now,
  }

  const result = parsed.mode === 'synthetic'
    ? await runSyntheticValidation(context)
    : parsed.mode === 'activate'
      ? await activateRuntime(context)
      : await restoreRuntime(context)
  const log = options.log ?? console.log
  log(JSON.stringify(result))
  return result
}

async function runSyntheticValidation(context) {
  const response = await requestJson(context, {
    path: '/api/admin/attribution-runtime/connections',
  })
  const connections = parseConnections(response)
  const results = []
  const submitted = []

  for (const connection of connections) {
    if (connection.candidate?.state === 'failed') {
      throw operationError('CANDIDATE_FAILED')
    }
    if (!connection.candidate) {
      results.push({
        provider: connection.provider,
        connectionId: connection.id,
        status: connection.state === 'active'
          ? 'already_verified'
          : 'skipped_not_configured',
        pairedEventCount: 0,
      })
      continue
    }
    if (
      connection.candidate.state !== 'candidate'
      && connection.candidate.state !== 'validating'
    ) {
      throw operationError('CANDIDATE_STATE_INVALID')
    }
    const testEventCode = connection.provider === 'google'
      ? undefined
      : await context.promptTestCode(
          connection.provider,
          connection.name,
        )
    const idempotencyKey = operationKey(
      'synthetic',
      context.runId,
      connection.id,
    )
    await requestJson(context, {
      path:
        '/api/admin/attribution-runtime/connections/'
        + `${encodeURIComponent(connection.id)}/candidate/validation`,
      method: 'POST',
      idempotencyKey,
      body: testEventCode === undefined
        ? {}
        : { testEventCode },
    })
    submitted.push({ connection, idempotencyKey })
  }

  results.push(...await Promise.all(submitted.map(input =>
    pollConnectionVerification(
      context,
      input.connection,
      input.idempotencyKey,
    ))))
  results.sort((left, right) =>
    PROVIDERS.indexOf(left.provider) - PROVIDERS.indexOf(right.provider)
    || left.connectionId.localeCompare(right.connectionId))
  return {
    status: 'ATTRIBUTION_SYNTHETIC_VERIFIED',
    results,
  }
}

async function pollConnectionVerification(
  context,
  connection,
  idempotencyKey,
) {
  const deadline = context.now() + context.pollTimeoutMs
  while (context.now() <= deadline) {
    const response = await requestJson(context, {
      path:
        '/api/admin/attribution-runtime/connections/'
        + `${encodeURIComponent(connection.id)}/candidate/validation`,
      idempotencyKey,
    })
    const verification = parseCurrentVerification(
      response,
      connection,
    )
    if (verification.status === 'verified') {
      if (
        !verification.candidateChecked
        || verification.pairedEventCount !== 2
      ) {
        throw operationError('SYNTHETIC_EVIDENCE_INCOMPLETE')
      }
      return {
        provider: connection.provider,
        connectionId: connection.id,
        status: 'verified',
        pairedEventCount: verification.pairedEventCount,
      }
    }
    if (TERMINAL_VALIDATION_STATES.has(verification.status)) {
      throw operationError(
        verification.status === 'timed_out'
          ? 'SYNTHETIC_TIMED_OUT'
          : safeFailureSuffix(verification.failureCode),
      )
    }
    await context.sleep(context.pollIntervalMs)
  }
  throw operationError('SYNTHETIC_TIMED_OUT')
}

function parseCurrentVerification(value, connection) {
  const row = recordData(value)
  if (
    !isRecord(row)
    || row.connectionId !== connection.id
    || row.provider !== connection.provider
    || typeof row.candidateChecked !== 'boolean'
    || !Number.isSafeInteger(row.pairedEventCount)
    || Number(row.pairedEventCount) < 0
  ) {
    throw operationError('RESPONSE_INVALID')
  }
  return {
    status: validationStatus(row.status),
    failureCode: typeof row.failureCode === 'string'
      ? row.failureCode
      : '',
    candidateChecked: row.candidateChecked,
    pairedEventCount: Number(row.pairedEventCount),
  }
}

async function activateRuntime(context) {
  let preflight = parseCutoverPreflight(await requestJson(context, {
    path: '/api/admin/attribution-cutover?targetOwner=draining',
  }))
  if (preflight.current.owner === 'new') {
    return runtimeResult(preflight.current)
  }
  if (preflight.current.owner === 'old') {
    assertLocalPreflight(preflight)
    const transition = parseTransition(await requestJson(context, {
      path: '/api/admin/attribution-cutover/transition',
      method: 'POST',
      idempotencyKey: operationKey(
        'activate-draining',
        context.runId,
      ),
      body: {
        targetOwner: 'draining',
        expectedEpoch: preflight.current.epoch,
        reason: `归因生产切换 ${context.runId}`,
      },
    }))
    if (transition.owner !== 'draining') {
      throw operationError('TRANSITION_INVALID')
    }
  } else if (preflight.current.owner !== 'draining') {
    throw operationError('TRANSITION_INVALID')
  }

  preflight = await waitForCutoverReady(context, 'new')
  if (preflight.current.owner === 'new') {
    return runtimeResult(preflight.current)
  }
  if (preflight.current.owner !== 'draining') {
    throw operationError('TRANSITION_INVALID')
  }
  const active = parseTransition(await requestJson(context, {
    path: '/api/admin/attribution-cutover/transition',
    method: 'POST',
    idempotencyKey: operationKey('activate-new', context.runId),
    body: {
      targetOwner: 'new',
      expectedEpoch: preflight.current.epoch,
      reason: `归因生产切换 ${context.runId}`,
    },
  }))
  if (active.owner !== 'new') {
    throw operationError('TRANSITION_INVALID')
  }
  return runtimeResult(active)
}

async function waitForCutoverReady(context, targetOwner) {
  const deadline = context.now() + context.pollTimeoutMs
  while (context.now() <= deadline) {
    const preflight = parseCutoverPreflight(await requestJson(context, {
      path:
        '/api/admin/attribution-cutover'
        + `?targetOwner=${encodeURIComponent(targetOwner)}`,
    }))
    if (preflight.current.owner === targetOwner) return preflight
    if (preflight.localReady) return preflight
    if (
      targetOwner !== 'new'
      || preflight.current.owner !== 'draining'
    ) {
      throw operationError('TRANSITION_INVALID')
    }
    await context.sleep(context.pollIntervalMs)
  }
  throw operationError('DRAINING_TIMED_OUT')
}

async function restoreRuntime(context) {
  const response = await requestJson(context, {
    path: '/api/admin/attribution-cutover/restore-preflight',
  })
  const preflight = parseRestorePreflight(response)
  if (preflight.current.owner === 'old') {
    return {
      status: 'ATTRIBUTION_RUNTIME_OWNER_OLD',
      owner: 'old',
      epoch: preflight.current.epoch,
    }
  }
  if (!preflight.safeToFence) {
    throw operationError('RESTORE_PREFLIGHT_BLOCKED')
  }
  const restored = parseTransition(await requestJson(context, {
    path: '/api/admin/attribution-cutover/restore',
    method: 'POST',
    idempotencyKey: operationKey('restore-old', context.runId),
    body: {
      expectedEpoch: preflight.current.epoch,
      reason: `归因生产回滚 ${context.runId}`,
    },
  }))
  if (restored.owner !== 'old') {
    throw operationError('RESTORE_INVALID')
  }
  return {
    status: 'ATTRIBUTION_RUNTIME_OWNER_OLD',
    owner: restored.owner,
    epoch: restored.epoch,
  }
}

async function requestJson(context, input) {
  const headers = new Headers({
    Accept: 'application/json',
    Cookie: context.cookie,
  })
  if (input.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  if (input.idempotencyKey) {
    headers.set('Idempotency-Key', input.idempotencyKey)
  }
  const response = await context.fetch(
    `${context.apiUrl}${input.path}`,
    {
      method: input.method ?? 'GET',
      headers,
      body: input.body === undefined
        ? undefined
        : JSON.stringify(input.body),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    },
  )
  const body = await readBoundedJson(response)
  if (!response.ok) {
    throw operationError(safeUpstreamCode(body))
  }
  return body
}

function parseConnections(value) {
  const data = recordData(value)
  if (!Array.isArray(data)) throw operationError('RESPONSE_INVALID')
  const connections = data.map(row => {
    if (!isRecord(row)) throw operationError('RESPONSE_INVALID')
    const id = identifier(row.id)
    const provider = providerValue(row.provider)
    const name = safeText(row.name)
    const state = connectionState(row.state)
    let candidate = null
    if (row.candidate !== null) {
      if (!isRecord(row.candidate)) {
        throw operationError('RESPONSE_INVALID')
      }
      candidate = {
        state: candidateState(row.candidate.state),
      }
    }
    return { id, provider, name, state, candidate }
  })
  return connections.sort((left, right) =>
    PROVIDERS.indexOf(left.provider) - PROVIDERS.indexOf(right.provider)
    || left.id.localeCompare(right.id))
}

function parseCutoverPreflight(value) {
  const data = recordData(value)
  if (
    !isRecord(data)
    || typeof data.localReady !== 'boolean'
    || !isRecord(data.current)
  ) {
    throw operationError('RESPONSE_INVALID')
  }
  return {
    localReady: data.localReady,
    current: runtimeState(data.current),
  }
}

function parseRestorePreflight(value) {
  const data = recordData(value)
  if (
    !isRecord(data)
    || typeof data.safeToFence !== 'boolean'
    || !isRecord(data.current)
  ) {
    throw operationError('RESPONSE_INVALID')
  }
  return {
    safeToFence: data.safeToFence,
    current: runtimeState(data.current),
  }
}

function parseTransition(value) {
  const data = recordData(value)
  if (!isRecord(data) || !isRecord(data.state)) {
    throw operationError('RESPONSE_INVALID')
  }
  return runtimeState(data.state)
}

function runtimeState(value) {
  if (
    !isRecord(value)
    || !['old', 'draining', 'new'].includes(value.owner)
    || !Number.isSafeInteger(value.epoch)
    || Number(value.epoch) < 1
  ) {
    throw operationError('RESPONSE_INVALID')
  }
  return {
    owner: value.owner,
    epoch: Number(value.epoch),
  }
}

function runtimeResult(state) {
  return {
    status: 'ATTRIBUTION_RUNTIME_OWNER_NEW',
    owner: state.owner,
    epoch: state.epoch,
  }
}

function assertLocalPreflight(preflight) {
  if (!preflight.localReady) {
    throw operationError('PREFLIGHT_BLOCKED')
  }
}

async function promptProviderTestCode(provider, name) {
  const label = provider === 'meta'
    ? 'Meta'
    : provider === 'tiktok'
      ? 'TikTok'
      : 'Google'
  const value = await readHiddenInput(
    `请输入 ${label}「${name}」当前 Test Event Code（输入不会显示）: `,
    'ATTRIBUTION_OPERATION_TEST_CODE_REQUIRED',
    { maxLength: 256 },
  )
  return String(value).trim()
}

function operationKey(...parts) {
  const hash = createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
  return `attribution-operation:${hash}`
}

function safeUpstreamCode(value) {
  const candidates = [
    isRecord(value) ? value.code : undefined,
    isRecord(value) && isRecord(value.error)
      ? value.error.code
      : undefined,
  ]
  const code = candidates.find(candidate =>
    typeof candidate === 'string'
    && SAFE_CODE_PATTERN.test(candidate))
  return code ?? 'UPSTREAM_FAILED'
}

function safeFailureSuffix(value) {
  if (
    typeof value === 'string'
    && /^[a-z0-9_]{1,120}$/.test(value)
  ) {
    return `SYNTHETIC_FAILED_${value.toUpperCase()}`
  }
  return 'SYNTHETIC_FAILED'
}

async function readBoundedJson(response) {
  const raw = await response.arrayBuffer()
  if (raw.byteLength > MAX_RESPONSE_BYTES) {
    throw operationError('RESPONSE_INVALID')
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw operationError('RESPONSE_INVALID')
  }
}

function recordData(value) {
  if (!isRecord(value) || !('data' in value)) {
    throw operationError('RESPONSE_INVALID')
  }
  return value.data
}

function validationStatus(value) {
  if (
    value === 'queued'
    || value === 'running'
    || value === 'verified'
    || value === 'failed'
    || value === 'timed_out'
  ) {
    return value
  }
  throw operationError('RESPONSE_INVALID')
}

function candidateState(value) {
  if (
    value === 'candidate'
    || value === 'validating'
    || value === 'ready'
    || value === 'failed'
  ) {
    return value
  }
  throw operationError('RESPONSE_INVALID')
}

function connectionState(value) {
  if (
    value === 'not_configured'
    || value === 'active'
    || value === 'disabled'
  ) {
    return value
  }
  throw operationError('RESPONSE_INVALID')
}

function providerValue(value) {
  if (!PROVIDERS.includes(value)) {
    throw operationError('RESPONSE_INVALID')
  }
  return value
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw operationError('RESPONSE_INVALID')
  }
  return value
}

function safeText(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 160
    || /\p{Cc}/u.test(value)
  ) {
    throw operationError('RESPONSE_INVALID')
  }
  return value
}

function requireArgument(value) {
  if (!value || value.startsWith('--')) {
    throw operationError('ARGUMENT_INVALID')
  }
  return value
}

function isRecord(value) {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function operationError(suffix) {
  const normalized = String(suffix ?? '')
    .replace(/^ATTRIBUTION_/, '')
    .replace(/[^A-Z0-9_]/g, '_')
  return new Error(
    `ATTRIBUTION_OPERATION_${normalized || 'UNKNOWN_ERROR'}`,
  )
}

async function main() {
  try {
    await runAttributionCutoverOperation({
      argv: process.argv.slice(2),
    })
  } catch (error) {
    const code = error instanceof Error
      && /^ATTRIBUTION_OPERATION_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'ATTRIBUTION_OPERATION_UNKNOWN_ERROR'
    process.stdout.write(`${JSON.stringify({
      status: 'failed',
      code,
    })}\n`)
    process.exitCode = 1
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
