#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path, { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parsePendingMigrations } from './prepare-dev-wallet1.mjs'
import {
  WALLET1_DOCUMENT_VERSION,
  WALLET1_NOTIFICATION_POLICY_ID,
  WALLET1_POLICY_ID,
  createWallet1SyntheticFixture,
  runWallet1FunctionalSmoke,
} from './verify-wallet1-disposable-flow.mjs'

const execFileAsync = promisify(execFile)
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = dirname(SCRIPTS_DIR)
const API_MAIN = join(ROOT_DIR, 'packages', 'api', 'src', 'index.ts')
const MIGRATIONS_DIR = join(ROOT_DIR, 'packages', 'api', 'migrations')

export const WALLET1_DISPOSABLE_CONFIRMATION = 'wallet1-isolated-smoke'
export const WALLET1_DISPOSABLE_EVIDENCE_PRUNE_CONFIRMATION = 'wallet1-expired-evidence'
export const WALLET1_DISPOSABLE_GATE_KIND = 'wallet1-disposable-smoke-gate'
export const WALLET1_DISPOSABLE_RUN_KIND = 'wallet1-disposable-smoke-run'
export const WALLET1_DISPOSABLE_EVIDENCE_KIND = 'wallet1-disposable-smoke-evidence'
export const WALLET1_DISPOSABLE_GATE_PATH = join(ROOT_DIR, 'docs', 'app', 'WALLET_1_DISPOSABLE_SMOKE_GATE.json')
export const WALLET1_DISPOSABLE_DEFAULT_STATE_ROOT = join(homedir(), '.meigallery', 'wallet1-disposable-smoke')

const ALLOWED_LOCATIONS = new Set(['weur', 'eeur', 'apac', 'oc', 'wnam', 'enam'])
const ALLOWED_JURISDICTIONS = new Set(['eu', 'fedramp'])
const REQUIRED_DECISIONS = ['OQ-018', 'OQ-020', 'OQ-024']
const AUTHORIZATION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_RESOURCE_LIFETIME_MINUTES = 30
const MAX_EVIDENCE_RETENTION_DAYS = 30
const REQUIRED_EVIDENCE_RETENTION_DAYS = 30
const KNOWN_NON_DISPOSABLE_RESOURCE_NAMES = [
  'meigallery-api',
  'meigallery-api-dev',
  'meigallery-db',
  'meigallery-db-dev',
  'meigallery-media',
  'meigallery-media-dev',
]

export async function runDisposableWallet1Smoke(options = {}) {
  requireRunConfirmation(options.confirmDisposable)
  const now = options.now || (() => new Date())
  const startedAt = now()
  const { gate, source: gateSource } = await loadGate(options)
  const validatedGate = validateDisposableSmokeGate(gate, startedAt)
  const repository = await (options.getRepositoryState || (() => getRepositoryState(options)))()
  validateRepositoryState(repository)

  const identity = options.identity || createDisposableResourceIdentity(startedAt)
  validateDisposableResourceIdentity(identity)
  const stateRoot = await prepareStateRoot(options.stateRoot || WALLET1_DISPOSABLE_DEFAULT_STATE_ROOT)
  const runDir = join(stateRoot, 'runs', identity.runId)
  const evidenceDir = join(stateRoot, 'evidence')
  await mkdir(dirname(runDir), { recursive: true, mode: 0o700 })
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await mkdir(runDir, { mode: 0o700 })
  await chmod(runDir, 0o700)
  const manifestPath = join(runDir, 'manifest.json')
  const configPath = join(runDir, 'wrangler.wallet1-smoke.json')
  const seedPath = join(runDir, '.synthetic-fixture.sql')
  const deadlineAt = new Date(startedAt.getTime() + validatedGate.resourcePolicy.maximumLifetimeMinutes * 60 * 1000)
  const stdout = options.stdout || process.stdout

  const manifest = {
    schemaVersion: 1,
    kind: WALLET1_DISPOSABLE_RUN_KIND,
    runId: identity.runId,
    createdAt: startedAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    gateSha256: createHash('sha256').update(gateSource).digest('hex'),
    git: {
      branch: repository.branch,
      commit: repository.commit,
      originDevCommit: repository.originDevCommit,
    },
    placement: validatedGate.placement,
    evidenceMode: 'aggregate_only',
    evidenceRetentionDays: validatedGate.resourcePolicy.evidenceRetentionDays,
    syntheticDataOnly: true,
    paths: { configPath },
    resources: {
      database: { name: identity.databaseName, id: null, state: 'not_created' },
      worker: { name: identity.workerName, url: null, state: 'not_created' },
    },
    phases: [],
    result: { status: 'running', errorCode: null, aggregate: null, checks: null },
    cleanup: { status: 'pending', worker: 'pending', database: 'pending' },
    updatedAt: startedAt.toISOString(),
  }
  await writeManifest(manifestPath, manifest)

  let primaryError = null
  let cleanupError = null
  let smokeResult = null
  try {
    writeProgress(stdout, identity.runId, 'gate', 'passed')
    assertBeforeDeadline(deadlineAt, now())
    appendPhase(manifest, 'd1_create', 'started', now())
    await writeManifest(manifestPath, manifest)
    const createStep = await runWrangler([
      'd1', 'create', identity.databaseName,
      ...placementArguments(validatedGate.placement),
    ], 'wallet1-disposable-d1-create', options)
    ensurePassed(createStep, 'WALLET1_SMOKE_D1_CREATE_FAILED')
    manifest.resources.database.state = 'created'
    appendPhase(manifest, 'd1_create', 'passed', now())
    await writeManifest(manifestPath, manifest)
    writeProgress(stdout, identity.runId, 'd1_create', 'passed')

    assertBeforeDeadline(deadlineAt, now())
    const infoStep = await runWrangler([
      'd1', 'info', identity.databaseName, '--json',
    ], 'wallet1-disposable-d1-info', options)
    ensurePassed(infoStep, 'WALLET1_SMOKE_D1_INFO_FAILED')
    const databaseInfo = parseD1DatabaseInfo(infoStep.stdout)
    if (databaseInfo.name && databaseInfo.name !== identity.databaseName) {
      throw new Error('WALLET1_SMOKE_D1_INFO_NAME_MISMATCH')
    }
    manifest.resources.database.id = databaseInfo.id

    const workerConfig = createTemporaryWorkerConfig({
      workerName: identity.workerName,
      databaseName: identity.databaseName,
      databaseId: databaseInfo.id,
      commit: repository.commit,
    })
    await writePrivateJson(configPath, workerConfig)
    appendPhase(manifest, 'worker_config', 'passed', now())
    await writeManifest(manifestPath, manifest)

    assertBeforeDeadline(deadlineAt, now())
    appendPhase(manifest, 'migrations', 'started', now())
    await writeManifest(manifestPath, manifest)
    const migrationStep = await runWrangler([
      'd1', 'migrations', 'apply', 'DB', '--config', configPath, '--remote',
    ], 'wallet1-disposable-migrations-apply', options)
    ensurePassed(migrationStep, 'WALLET1_SMOKE_MIGRATIONS_FAILED')
    const migrationListStep = await runWrangler([
      'd1', 'migrations', 'list', 'DB', '--config', configPath, '--remote',
    ], 'wallet1-disposable-migrations-list', options)
    ensurePassed(migrationListStep, 'WALLET1_SMOKE_MIGRATIONS_LIST_FAILED')
    if (parsePendingMigrations(`${migrationListStep.stdout}\n${migrationListStep.stderr}`).length !== 0) {
      throw new Error('WALLET1_SMOKE_PENDING_MIGRATIONS_REMAIN')
    }
    appendPhase(manifest, 'migrations', 'passed', now())
    await writeManifest(manifestPath, manifest)
    writeProgress(stdout, identity.runId, 'migrations', 'passed')

    assertBeforeDeadline(deadlineAt, now())
    const fixture = (options.createFixture || createWallet1SyntheticFixture)({
      now: now(),
      suffix: identity.suffix,
    })
    await writeFile(seedPath, `${fixture.sql}\n`, { mode: 0o600 })
    await chmod(seedPath, 0o600)
    try {
      const seedStep = await runWrangler([
        'd1', 'execute', 'DB', '--config', configPath, '--remote', '--yes', '--file', seedPath,
      ], 'wallet1-disposable-seed', options)
      ensurePassed(seedStep, 'WALLET1_SMOKE_FIXTURE_SEED_FAILED')
    }
    finally {
      await rm(seedPath, { force: true })
    }
    appendPhase(manifest, 'synthetic_fixture', 'passed', now())
    await writeManifest(manifestPath, manifest)

    assertBeforeDeadline(deadlineAt, now())
    manifest.resources.worker.state = 'deployment_started'
    appendPhase(manifest, 'worker_deploy', 'started', now())
    await writeManifest(manifestPath, manifest)
    const deployStep = await runWrangler([
      'deploy', '--config', configPath, '--name', identity.workerName, '--strict',
    ], 'wallet1-disposable-worker-deploy', options)
    ensurePassed(deployStep, 'WALLET1_SMOKE_WORKER_DEPLOY_FAILED')
    const workerUrl = parseTemporaryWorkerUrl(`${deployStep.stdout}\n${deployStep.stderr}`, identity.workerName)
    manifest.resources.worker.url = workerUrl
    manifest.resources.worker.state = 'deployed'
    appendPhase(manifest, 'worker_deploy', 'passed', now())
    await writeManifest(manifestPath, manifest)
    writeProgress(stdout, identity.runId, 'worker_deploy', 'passed')

    await (options.waitForWorker || waitForWorker)(workerUrl, repository.commit, options)
    assertBeforeDeadline(deadlineAt, now())
    appendPhase(manifest, 'functional_smoke', 'started', now())
    await writeManifest(manifestPath, manifest)
    const requestJson = options.requestJson || defaultRequestJson
    const executeD1 = operation => executeDisposableD1(operation, configPath, options)
    smokeResult = await (options.runFunctionalSmoke || runWallet1FunctionalSmoke)({
      baseUrl: workerUrl,
      expectedCommit: repository.commit,
      fixture,
      requestJson,
      executeD1,
    })
    if (smokeResult?.status !== 'passed') throw new Error('WALLET1_SMOKE_FUNCTIONAL_RESULT_INVALID')
    manifest.result.status = 'passed'
    manifest.result.aggregate = smokeResult.aggregate
    manifest.result.checks = smokeResult.checks
    appendPhase(manifest, 'functional_smoke', 'passed', now())
    await writeManifest(manifestPath, manifest)
    writeProgress(stdout, identity.runId, 'functional_smoke', 'passed')
  }
  catch (error) {
    primaryError = error instanceof Error ? error : new Error('WALLET1_SMOKE_UNKNOWN_RUN_FAILURE')
    manifest.result.status = 'failed'
    manifest.result.errorCode = safeErrorCode(primaryError)
    appendPhase(manifest, 'run', 'failed', now(), safeErrorCode(primaryError))
    await writeManifest(manifestPath, manifest)
  }
  finally {
    try {
      const cleanup = await cleanupDisposableResources(manifest, { ...options, manifestPath })
      manifest.cleanup = cleanup
      await writeManifest(manifestPath, manifest)
      writeProgress(stdout, identity.runId, 'cleanup', cleanup.status)
    }
    catch (error) {
      cleanupError = error instanceof Error ? error : new Error('WALLET1_SMOKE_UNKNOWN_CLEANUP_FAILURE')
      manifest.cleanup.status = 'failed'
      manifest.cleanup.errorCode = safeErrorCode(cleanupError)
      await writeManifest(manifestPath, manifest)
    }
  }

  if (manifest.cleanup.status === 'passed') {
    const evidencePath = await persistAggregateEvidence(evidenceDir, manifest, now())
    await rm(runDir, { recursive: true, force: true })
    if (primaryError || cleanupError) {
      const error = primaryError || cleanupError
      error.evidencePath = evidencePath
      throw error
    }
    return {
      status: 'passed',
      runId: identity.runId,
      evidencePath,
      aggregate: smokeResult.aggregate,
    }
  }

  const recoveryCommand = `node scripts/run-wallet1-disposable-smoke.mjs destroy --manifest=${manifestPath} --confirm-destroy=${identity.runId}`
  const error = new Error('WALLET1_SMOKE_CLEANUP_INCOMPLETE')
  error.manifestPath = manifestPath
  error.recoveryCommand = recoveryCommand
  error.cause = cleanupError || primaryError
  throw error
}

export async function destroyDisposableWallet1Resources(options = {}) {
  const manifestPath = resolve(String(options.manifestPath || ''))
  assertOutsideRepository(manifestPath)
  if (!manifestPath || (await lstat(manifestPath)).isSymbolicLink()) {
    throw new Error('WALLET1_SMOKE_DESTROY_MANIFEST_INVALID')
  }
  const physicalManifestPath = await realpath(manifestPath)
  assertOutsideRepository(physicalManifestPath)
  const manifest = JSON.parse(await readFile(physicalManifestPath, 'utf8'))
  validateRunManifestForCleanup(manifest)
  const recoveryPaths = resolveRecoveryPaths(physicalManifestPath, manifest.runId)
  if (options.confirmDestroy !== manifest.runId) {
    throw new Error('WALLET1_SMOKE_DESTROY_CONFIRMATION_REQUIRED')
  }
  const cleanup = await cleanupDisposableResources(manifest, {
    ...options,
    manifestPath: physicalManifestPath,
  })
  await writeManifest(physicalManifestPath, manifest)
  await mkdir(recoveryPaths.evidenceDir, { recursive: true, mode: 0o700 })
  const finishedAt = (options.now || (() => new Date()))()
  const evidencePath = await persistAggregateEvidence(recoveryPaths.evidenceDir, manifest, finishedAt)
  await rm(recoveryPaths.runDir, { recursive: true, force: true })
  return { status: cleanup.status, runId: manifest.runId, evidencePath }
}

export async function pruneDisposableWallet1Evidence(options = {}) {
  if (options.confirmPrune !== WALLET1_DISPOSABLE_EVIDENCE_PRUNE_CONFIRMATION) {
    throw new Error('WALLET1_SMOKE_EVIDENCE_PRUNE_CONFIRMATION_REQUIRED')
  }
  const now = options.now || (() => new Date())
  const stateRoot = await prepareStateRoot(options.stateRoot || WALLET1_DISPOSABLE_DEFAULT_STATE_ROOT)
  const evidenceDir = join(stateRoot, 'evidence')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  const entries = await readdir(evidenceDir, { withFileTypes: true })
  const result = { inspected: 0, deleted: 0, retained: 0 }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith('.json')) continue
    const evidencePath = join(evidenceDir, entry.name)
    const stats = await lstat(evidencePath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('WALLET1_SMOKE_EVIDENCE_FILE_INVALID')
    }
    let evidence
    try {
      evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    }
    catch {
      throw new Error('WALLET1_SMOKE_EVIDENCE_JSON_INVALID')
    }
    validateEvidenceForPrune(evidence, entry.name)
    result.inspected += 1
    if (Date.parse(evidence.retention.deleteAfter) <= now().getTime()) {
      await rm(evidencePath)
      result.deleted += 1
    }
    else {
      result.retained += 1
    }
  }
  return result
}

export function validateDisposableSmokeGate(gate, now = new Date()) {
  if (gate?.schemaVersion !== 1 || gate?.kind !== WALLET1_DISPOSABLE_GATE_KIND) {
    throw new Error('WALLET1_SMOKE_GATE_INVALID')
  }
  if (gate.remoteSmokeAuthorized !== true) throw new Error('WALLET1_SMOKE_GATE_NOT_AUTHORIZED')
  const authorization = gate.authorization
  if (authorization?.scope !== 'wallet1_disposable_synthetic_smoke'
    || authorization?.status !== 'approved'
    || !validApproval(authorization)
    || !validDate(authorization.expiresAt)) {
    throw new Error('WALLET1_SMOKE_GATE_AUTHORIZATION_INVALID')
  }
  const approvedAt = Date.parse(authorization.approvedAt)
  const expiresAt = Date.parse(authorization.expiresAt)
  const nowMs = now.getTime()
  if (nowMs < approvedAt || nowMs > expiresAt || expiresAt - approvedAt > AUTHORIZATION_MAX_AGE_MS) {
    throw new Error('WALLET1_SMOKE_GATE_AUTHORIZATION_EXPIRED')
  }

  for (const decisionId of REQUIRED_DECISIONS) {
    const decision = gate.decisions?.[decisionId]
    if (decision?.status !== 'approved'
      || decision?.scope !== 'wallet1_disposable_synthetic_smoke'
      || !validApproval(decision)) {
      throw new Error(`WALLET1_SMOKE_GATE_${decisionId.replace('-', '_')}_UNRESOLVED`)
    }
    const decisionApprovedAt = Date.parse(decision.approvedAt)
    if (decisionApprovedAt > nowMs || decisionApprovedAt > expiresAt) {
      throw new Error(`WALLET1_SMOKE_GATE_${decisionId.replace('-', '_')}_APPROVAL_TIME_INVALID`)
    }
  }

  const resourcePolicy = gate.resourcePolicy
  if (resourcePolicy?.syntheticDataOnly !== true
    || resourcePolicy?.evidenceMode !== 'aggregate_only'
    || resourcePolicy?.requireIndependentReview !== true
    || resourcePolicy?.allowNegativeBalance !== false
    || resourcePolicy?.batchAdjustmentsEnabled !== false
    || resourcePolicy?.evidenceRetentionDays !== REQUIRED_EVIDENCE_RETENTION_DAYS
    || !Number.isSafeInteger(resourcePolicy?.maximumLifetimeMinutes)
    || resourcePolicy.maximumLifetimeMinutes < 5
    || resourcePolicy.maximumLifetimeMinutes > MAX_RESOURCE_LIFETIME_MINUTES) {
    throw new Error('WALLET1_SMOKE_GATE_RESOURCE_POLICY_INVALID')
  }

  const placement = gate.placement
  if (placement?.mode === 'location' && ALLOWED_LOCATIONS.has(placement.value)) {
    return { authorization, decisions: gate.decisions, resourcePolicy, placement: { mode: 'location', value: placement.value } }
  }
  if (placement?.mode === 'jurisdiction' && ALLOWED_JURISDICTIONS.has(placement.value)) {
    return { authorization, decisions: gate.decisions, resourcePolicy, placement: { mode: 'jurisdiction', value: placement.value } }
  }
  throw new Error('WALLET1_SMOKE_GATE_PLACEMENT_UNRESOLVED')
}

export function createDisposableResourceIdentity(now = new Date(), suffix = randomBytes(6).toString('hex')) {
  const normalizedSuffix = String(suffix).toLowerCase()
  if (!/^[a-f0-9]{12}$/u.test(normalizedSuffix)) throw new Error('WALLET1_SMOKE_RESOURCE_SUFFIX_INVALID')
  const day = now.toISOString().slice(0, 10).replaceAll('-', '')
  const timestamp = now.toISOString().replace(/[-:.]/gu, '').toLowerCase()
  return {
    runId: `wallet1-smoke-${timestamp}-${normalizedSuffix}`,
    suffix: normalizedSuffix,
    databaseName: `mei-w1-db-${day}-${normalizedSuffix}`,
    workerName: `mei-w1-api-${day}-${normalizedSuffix}`,
  }
}

export function validateDisposableResourceIdentity(identity) {
  const runMatch = String(identity?.runId || '').match(/^wallet1-smoke-(\d{8})t\d{6}\d{3}z-([a-f0-9]{12})$/u)
  if (!runMatch) {
    throw new Error('WALLET1_SMOKE_RUN_ID_INVALID')
  }
  const databaseMatch = String(identity?.databaseName || '').match(/^mei-w1-db-(\d{8})-([a-f0-9]{12})$/u)
  if (!databaseMatch) {
    throw new Error('WALLET1_SMOKE_DATABASE_NAME_INVALID')
  }
  const workerMatch = String(identity?.workerName || '').match(/^mei-w1-api-(\d{8})-([a-f0-9]{12})$/u)
  if (!workerMatch) {
    throw new Error('WALLET1_SMOKE_WORKER_NAME_INVALID')
  }
  if (identity.databaseName.length > 63 || identity.workerName.length > 63) {
    throw new Error('WALLET1_SMOKE_RESOURCE_NAME_TOO_LONG')
  }
  if (KNOWN_NON_DISPOSABLE_RESOURCE_NAMES.includes(identity.databaseName)
    || KNOWN_NON_DISPOSABLE_RESOURCE_NAMES.includes(identity.workerName)) {
    throw new Error('WALLET1_SMOKE_NON_DISPOSABLE_RESOURCE_FORBIDDEN')
  }
  if (databaseMatch[1] !== workerMatch[1]
    || databaseMatch[1] !== runMatch[1]
    || databaseMatch[2] !== identity.suffix
    || workerMatch[2] !== identity.suffix
    || runMatch[2] !== identity.suffix) {
    throw new Error('WALLET1_SMOKE_RESOURCE_IDENTITY_MISMATCH')
  }
  return true
}

export function createTemporaryWorkerConfig({ workerName, databaseName, databaseId, commit }) {
  const databaseParts = String(databaseName).match(/^mei-w1-db-(\d{8})-([a-f0-9]{12})$/u)
  if (!databaseParts) throw new Error('WALLET1_SMOKE_DATABASE_NAME_INVALID')
  const identity = {
    runId: `wallet1-smoke-${databaseParts[1]}t000000000z-${databaseParts[2]}`,
    suffix: databaseParts[2],
    databaseName,
    workerName,
  }
  validateDisposableResourceIdentity(identity)
  if (!/^[0-9a-f-]{36}$/u.test(databaseId)) throw new Error('WALLET1_SMOKE_DATABASE_ID_INVALID')
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('WALLET1_SMOKE_COMMIT_INVALID')
  const config = {
    name: workerName,
    main: API_MAIN,
    compatibility_date: '2026-05-26',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    preview_urls: false,
    observability: { enabled: false },
    d1_databases: [{
      binding: 'DB',
      database_name: databaseName,
      database_id: databaseId,
      migrations_dir: MIGRATIONS_DIR,
    }],
    vars: {
      APP_ENV: 'dev',
      RELEASE_COMMIT: commit,
      CORS_ORIGIN: '',
      EMAIL_FROM: 'noreply@example.invalid',
      SITE_URL: '',
      IMAGE_RESIZING_ENABLED: 'false',
      IMPORT_TOKEN_DAILY_LIMIT: '1',
      APP_AUTH_ENABLED: 'true',
      APP_AUTH_REGISTRATION_ENABLED: 'false',
      APP_AUTH_TERMS_VERSION: WALLET1_DOCUMENT_VERSION,
      APP_AUTH_PRIVACY_VERSION: WALLET1_DOCUMENT_VERSION,
      APP_AUTH_PLATFORM_NOTICE_VERSION: WALLET1_DOCUMENT_VERSION,
      APP_AUTH_ELIGIBILITY_VERSION: WALLET1_DOCUMENT_VERSION,
      APP_AUTH_TERMS_URL: 'https://example.invalid/wallet1-smoke/terms',
      APP_AUTH_PRIVACY_URL: 'https://example.invalid/wallet1-smoke/privacy',
      APP_AUTH_PLATFORM_NOTICE_URL: 'https://example.invalid/wallet1-smoke/platform-operation',
      APP_AUTH_ELIGIBILITY_URL: 'https://example.invalid/wallet1-smoke/eligibility',
      APP_MEMBERSHIP_ENABLED: 'false',
      APP_MEMBERSHIP_ADMIN_ENABLED: 'false',
      APP_MEMBERSHIP_APPLICATIONS_ENABLED: 'false',
      APP_MEMBERSHIP_CATALOG_VERSION: 'amc_app_1_0_draft_1',
      APP_MEMBERSHIP_PRODUCTION_READY: 'false',
      APP_MESSAGING_ENABLED: 'false',
      APP_MESSAGING_ADMIN_ENABLED: 'false',
      APP_MESSAGING_DISCLOSURE_VERSION: 'managed_message_1',
      APP_MESSAGING_PRODUCTION_READY: 'false',
      APP_SAFETY_ENABLED: 'false',
      APP_SAFETY_ADMIN_ENABLED: 'false',
      APP_SAFETY_REASON_CATALOG_VERSION: 'src_app_1_0_message_2_dev_1',
      APP_SAFETY_PRODUCTION_READY: 'false',
      APP_SAFETY_APPEALS_ENABLED: 'false',
      APP_SAFETY_APPEALS_ADMIN_ENABLED: 'false',
      APP_SAFETY_APPEAL_POLICY_VERSION: 'sap_app_1_0_safety_2_dev_1',
      APP_SAFETY_APPEALS_PRODUCTION_READY: 'false',
      APP_NOTIFICATIONS_ENABLED: 'true',
      APP_NOTIFICATIONS_ADMIN_ENABLED: 'true',
      APP_NOTIFICATIONS_POLICY_VERSION: WALLET1_NOTIFICATION_POLICY_ID,
      APP_NOTIFICATIONS_PRODUCTION_READY: 'false',
      APP_WALLET_ENABLED: 'true',
      APP_WALLET_ADMIN_ENABLED: 'true',
      APP_WALLET_POLICY_VERSION: WALLET1_POLICY_ID,
      APP_WALLET_PRODUCTION_READY: 'false',
    },
  }
  validateTemporaryWorkerConfig(config)
  return config
}

export function validateTemporaryWorkerConfig(config) {
  const source = JSON.stringify(config)
  for (const name of KNOWN_NON_DISPOSABLE_RESOURCE_NAMES) {
    if (source.includes(`"${name}"`)) throw new Error('WALLET1_SMOKE_CONFIG_SHARED_RESOURCE_FORBIDDEN')
  }
  for (const key of ['routes', 'route', 'r2_buckets', 'queues', 'send_email', 'triggers', 'services', 'durable_objects']) {
    if (Object.hasOwn(config, key)) throw new Error('WALLET1_SMOKE_CONFIG_EXTERNAL_BINDING_FORBIDDEN')
  }
  for (const secretKey of [
    'SESSION_SECRET', 'TURNSTILE_SECRET_KEY', 'STREAM_ACCOUNT_ID', 'STREAM_API_TOKEN',
    'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT', 'TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT',
  ]) {
    if (source.includes(secretKey)) throw new Error('WALLET1_SMOKE_CONFIG_SECRET_FORBIDDEN')
  }
  if (config.workers_dev !== true
    || config.preview_urls !== false
    || config.d1_databases?.length !== 1
    || config.d1_databases[0]?.binding !== 'DB'
    || config.vars?.APP_ENV !== 'dev'
    || config.vars?.APP_AUTH_REGISTRATION_ENABLED !== 'false'
    || config.vars?.APP_WALLET_ENABLED !== 'true'
    || config.vars?.APP_WALLET_ADMIN_ENABLED !== 'true'
    || config.vars?.APP_WALLET_PRODUCTION_READY !== 'false'
    || config.vars?.APP_NOTIFICATIONS_ENABLED !== 'true'
    || config.vars?.APP_NOTIFICATIONS_PRODUCTION_READY !== 'false') {
    throw new Error('WALLET1_SMOKE_CONFIG_BOUNDARY_INVALID')
  }
  for (const capability of ['APP_MEMBERSHIP_ENABLED', 'APP_MESSAGING_ENABLED', 'APP_SAFETY_ENABLED']) {
    if (config.vars?.[capability] !== 'false') throw new Error('WALLET1_SMOKE_CONFIG_SCOPE_TOO_BROAD')
  }
  return true
}

export function parseD1DatabaseInfo(output) {
  let payload
  try {
    payload = typeof output === 'string' ? JSON.parse(output) : output
  }
  catch {
    throw new Error('WALLET1_SMOKE_D1_INFO_JSON_INVALID')
  }
  const candidates = []
  collectObjects(payload, candidates)
  for (const candidate of candidates) {
    const id = candidate.uuid ?? candidate.database_id ?? candidate.id
    if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(id)) {
      return { id: id.toLowerCase(), name: typeof candidate.name === 'string' ? candidate.name : null }
    }
  }
  throw new Error('WALLET1_SMOKE_D1_INFO_ID_INVALID')
}

export function parseTemporaryWorkerUrl(output, workerName) {
  if (!/^mei-w1-api-\d{8}-[a-f0-9]{12}$/u.test(workerName)) {
    throw new Error('WALLET1_SMOKE_WORKER_NAME_INVALID')
  }
  const escaped = workerName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = String(output).match(new RegExp(`https://${escaped}\\.[a-z0-9.-]+\\.workers\\.dev`, 'iu'))
  if (!match) throw new Error('WALLET1_SMOKE_WORKER_URL_NOT_FOUND')
  return match[0].toLowerCase()
}

export async function cleanupDisposableResources(manifest, options = {}) {
  validateRunManifestForCleanup(manifest)
  const now = options.now || (() => new Date())
  const result = { status: 'passed', worker: 'not_created', database: 'not_created', errorCode: null }
  const errors = []

  if (manifest.resources.worker.state === 'deployed' || manifest.resources.worker.state === 'deployment_started') {
    const workerStep = await runWrangler([
      'delete', manifest.resources.worker.name, '--force',
    ], 'wallet1-disposable-worker-delete', options)
    if (workerStep.status === 'passed' || isNotFoundStep(workerStep)) {
      result.worker = 'deleted'
      manifest.resources.worker.state = 'deleted'
    }
    else {
      result.worker = 'failed'
      errors.push('WALLET1_SMOKE_WORKER_DELETE_FAILED')
    }
    manifest.updatedAt = now().toISOString()
    if (options.manifestPath) await writeManifest(options.manifestPath, manifest)
  }

  if (manifest.resources.database.state === 'created') {
    const databaseStep = await runWrangler([
      'd1', 'delete', manifest.resources.database.name, '--skip-confirmation',
    ], 'wallet1-disposable-d1-delete', options)
    if (databaseStep.status === 'passed' || isNotFoundStep(databaseStep)) {
      result.database = 'deleted'
      manifest.resources.database.state = 'deleted'
    }
    else {
      result.database = 'failed'
      errors.push('WALLET1_SMOKE_D1_DELETE_FAILED')
    }
    manifest.updatedAt = now().toISOString()
    if (options.manifestPath) await writeManifest(options.manifestPath, manifest)
  }

  if (errors.length) {
    result.status = 'failed'
    result.errorCode = errors.join('+')
    manifest.cleanup = result
    throw Object.assign(new Error('WALLET1_SMOKE_RESOURCE_CLEANUP_FAILED'), { cleanup: result })
  }
  manifest.cleanup = result
  return result
}

export async function main(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const stdout = options.stdout || process.stdout
  const action = argv[0]
  try {
    if (action === 'run') {
      const result = await runDisposableWallet1Smoke({
        ...options,
        confirmDisposable: readArgument(argv, '--confirm-disposable'),
      })
      stdout.write(`WALLET1_DISPOSABLE_SMOKE_PASSED run=${result.runId} evidence=${result.evidencePath}\n`)
      return 0
    }
    if (action === 'destroy') {
      const result = await destroyDisposableWallet1Resources({
        ...options,
        manifestPath: readArgument(argv, '--manifest'),
        confirmDestroy: readArgument(argv, '--confirm-destroy'),
      })
      stdout.write(`WALLET1_DISPOSABLE_SMOKE_DESTROYED run=${result.runId} evidence=${result.evidencePath}\n`)
      return result.status === 'passed' ? 0 : 1
    }
    if (action === 'prune-evidence') {
      const result = await pruneDisposableWallet1Evidence({
        ...options,
        confirmPrune: readArgument(argv, '--confirm-prune'),
      })
      stdout.write(`WALLET1_DISPOSABLE_EVIDENCE_PRUNED inspected=${result.inspected} deleted=${result.deleted} retained=${result.retained}\n`)
      return 0
    }
    throw new Error('WALLET1_SMOKE_ACTION_REQUIRED')
  }
  catch (error) {
    stdout.write(`WALLET1_DISPOSABLE_SMOKE_BLOCKED code=${safeErrorCode(error)}`)
    if (error?.manifestPath) stdout.write(` manifest=${error.manifestPath}`)
    if (error?.recoveryCommand) stdout.write(` recovery=${JSON.stringify(error.recoveryCommand)}`)
    stdout.write('\n')
    return 1
  }
}

async function executeDisposableD1(operation, configPath, options = {}) {
  if (!operation || typeof operation.sql !== 'string' || operation.sql.length < 1) {
    throw new Error('WALLET1_SMOKE_D1_OPERATION_INVALID')
  }
  const step = await runWrangler([
    'd1', 'execute', 'DB', '--config', configPath, '--remote', '--yes', '--json', '--command', operation.sql,
  ], operation.name || 'wallet1-disposable-d1-operation', options)
  if (operation.expectedFailurePattern) {
    if (step.status === 'passed') throw new Error('WALLET1_SMOKE_D1_EXPECTED_FAILURE_MISSING')
    const output = `${step.stdout}\n${step.stderr}`
    if (!output.includes(operation.expectedFailurePattern)) {
      throw new Error('WALLET1_SMOKE_D1_FAILURE_REASON_MISMATCH')
    }
    return []
  }
  ensurePassed(step, 'WALLET1_SMOKE_D1_OPERATION_FAILED')
  return parseD1Rows(step.stdout)
}

function parseD1Rows(output) {
  let payload
  try {
    payload = JSON.parse(output)
  }
  catch {
    throw new Error('WALLET1_SMOKE_D1_RESULT_JSON_INVALID')
  }
  const queue = Array.isArray(payload) ? [...payload] : [payload]
  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current.results)) return current.results
    for (const key of ['result', 'data']) {
      if (current[key]) queue.push(current[key])
    }
  }
  return []
}

function validateRunManifestForCleanup(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== WALLET1_DISPOSABLE_RUN_KIND) {
    throw new Error('WALLET1_SMOKE_DESTROY_MANIFEST_INVALID')
  }
  const placementValid = (manifest.placement?.mode === 'location' && ALLOWED_LOCATIONS.has(manifest.placement.value))
    || (manifest.placement?.mode === 'jurisdiction' && ALLOWED_JURISDICTIONS.has(manifest.placement.value))
  if (!validDate(manifest.createdAt)
    || !validDate(manifest.deadlineAt)
    || Date.parse(manifest.deadlineAt) <= Date.parse(manifest.createdAt)
    || !/^[0-9a-f]{64}$/u.test(manifest.gateSha256 || '')
    || manifest.git?.branch !== 'dev'
    || !/^[0-9a-f]{40}$/u.test(manifest.git?.commit || '')
    || manifest.git.commit !== manifest.git?.originDevCommit
    || manifest.syntheticDataOnly !== true
    || manifest.evidenceMode !== 'aggregate_only'
    || !placementValid) {
    throw new Error('WALLET1_SMOKE_DESTROY_PROVENANCE_INVALID')
  }
  validateDisposableResourceIdentity({
    runId: manifest.runId,
    suffix: manifest.resources?.database?.name?.split('-').at(-1),
    databaseName: manifest.resources?.database?.name,
    workerName: manifest.resources?.worker?.name,
  })
  const allowedDatabaseStates = ['not_created', 'created', 'deleted']
  const allowedWorkerStates = ['not_created', 'deployment_started', 'deployed', 'deleted']
  if (!allowedDatabaseStates.includes(manifest.resources.database.state)
    || !allowedWorkerStates.includes(manifest.resources.worker.state)) {
    throw new Error('WALLET1_SMOKE_DESTROY_RESOURCE_STATE_INVALID')
  }
  if (manifest.resources.database.id !== null
    && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(manifest.resources.database.id)) {
    throw new Error('WALLET1_SMOKE_DESTROY_DATABASE_ID_INVALID')
  }
  if (!Number.isSafeInteger(manifest.evidenceRetentionDays)
    || manifest.evidenceRetentionDays < 1
    || manifest.evidenceRetentionDays > MAX_EVIDENCE_RETENTION_DAYS) {
    throw new Error('WALLET1_SMOKE_DESTROY_EVIDENCE_RETENTION_INVALID')
  }
  return true
}

async function loadGate(options) {
  if (options.gate) {
    return { gate: options.gate, source: `${JSON.stringify(options.gate)}\n` }
  }
  const source = await readFile(options.gatePath || WALLET1_DISPOSABLE_GATE_PATH, 'utf8')
  return { gate: JSON.parse(source), source }
}

async function getRepositoryState(options = {}) {
  const runCommand = options.runCommand || defaultRunCommand
  const [commit, branch, status, originDev] = await Promise.all([
    runCommand('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, name: 'wallet1-disposable-git-commit' }),
    runCommand('git', ['branch', '--show-current'], { cwd: ROOT_DIR, name: 'wallet1-disposable-git-branch' }),
    runCommand('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT_DIR, name: 'wallet1-disposable-git-status' }),
    runCommand('git', ['rev-parse', 'origin/dev'], { cwd: ROOT_DIR, name: 'wallet1-disposable-git-origin-dev' }),
  ])
  ensurePassed(commit, 'WALLET1_SMOKE_GIT_COMMIT_FAILED')
  ensurePassed(branch, 'WALLET1_SMOKE_GIT_BRANCH_FAILED')
  ensurePassed(status, 'WALLET1_SMOKE_GIT_STATUS_FAILED')
  ensurePassed(originDev, 'WALLET1_SMOKE_GIT_ORIGIN_DEV_FAILED')
  return {
    commit: commit.stdout.trim(),
    branch: branch.stdout.trim(),
    trackedStatus: status.stdout.trim(),
    originDevCommit: originDev.stdout.trim(),
  }
}

function validateRepositoryState(repository) {
  if (!/^[0-9a-f]{40}$/u.test(repository?.commit || '')
    || !/^[0-9a-f]{40}$/u.test(repository?.originDevCommit || '')) {
    throw new Error('WALLET1_SMOKE_GIT_COMMIT_INVALID')
  }
  if (repository.branch !== 'dev') throw new Error('WALLET1_SMOKE_BRANCH_NOT_DEV')
  if (repository.trackedStatus) throw new Error('WALLET1_SMOKE_TRACKED_WORKTREE_DIRTY')
  if (repository.commit !== repository.originDevCommit) throw new Error('WALLET1_SMOKE_ORIGIN_DEV_MISMATCH')
  return true
}

async function prepareStateRoot(value) {
  const stateRoot = resolve(value)
  assertOutsideRepository(stateRoot)
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await chmod(stateRoot, 0o700)
  const physical = await realpath(stateRoot)
  assertOutsideRepository(physical)
  return physical
}

async function persistAggregateEvidence(evidenceDir, manifest, finishedAt) {
  const retentionDays = manifest.evidenceRetentionDays
  if (!Number.isSafeInteger(retentionDays)
    || retentionDays < 1
    || retentionDays > MAX_EVIDENCE_RETENTION_DAYS) {
    throw new Error('WALLET1_SMOKE_EVIDENCE_RETENTION_INVALID')
  }
  const evidencePath = join(evidenceDir, `${manifest.runId}.json`)
  const deleteAfter = new Date(finishedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000)
  const evidence = {
    schemaVersion: 1,
    kind: WALLET1_DISPOSABLE_EVIDENCE_KIND,
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    finishedAt: finishedAt.toISOString(),
    gateSha256: manifest.gateSha256,
    git: manifest.git,
    placement: manifest.placement,
    syntheticDataOnly: true,
    evidenceMode: 'aggregate_only',
    retention: {
      days: retentionDays,
      deleteAfter: deleteAfter.toISOString(),
    },
    resourceIdentitySha256: createHash('sha256')
      .update(`${manifest.resources.database.name}:${manifest.resources.worker.name}`)
      .digest('hex'),
    result: manifest.result,
    cleanup: manifest.cleanup,
  }
  await writePrivateJson(evidencePath, evidence)
  return evidencePath
}

function resolveRecoveryPaths(manifestPath, runId) {
  const runDir = dirname(manifestPath)
  const runsDir = dirname(runDir)
  if (basename(manifestPath) !== 'manifest.json'
    || basename(runDir) !== runId
    || basename(runsDir) !== 'runs') {
    throw new Error('WALLET1_SMOKE_DESTROY_MANIFEST_PATH_INVALID')
  }
  const stateRoot = dirname(runsDir)
  assertOutsideRepository(stateRoot)
  return { runDir, evidenceDir: join(stateRoot, 'evidence') }
}

function validateEvidenceForPrune(evidence, fileName) {
  if (evidence?.schemaVersion !== 1
    || evidence?.kind !== WALLET1_DISPOSABLE_EVIDENCE_KIND
    || `${evidence?.runId}.json` !== fileName
    || !/^wallet1-smoke-\d{8}t\d{9}z-[a-f0-9]{12}$/u.test(evidence?.runId || '')
    || !validDate(evidence?.finishedAt)
    || !Number.isSafeInteger(evidence?.retention?.days)
    || evidence.retention.days < 1
    || evidence.retention.days > MAX_EVIDENCE_RETENTION_DAYS
    || !validDate(evidence?.retention?.deleteAfter)
    || Date.parse(evidence.retention.deleteAfter) <= Date.parse(evidence.finishedAt)) {
    throw new Error('WALLET1_SMOKE_EVIDENCE_CONTENT_INVALID')
  }
  return true
}

async function writeManifest(manifestPath, manifest) {
  manifest.updatedAt = new Date().toISOString()
  await writePrivateJson(manifestPath, manifest)
}

async function writePrivateJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.partial`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, filePath)
  await chmod(filePath, 0o600)
}

function appendPhase(manifest, name, status, at, errorCode = null) {
  manifest.phases.push({ name, status, at: at.toISOString(), ...(errorCode ? { errorCode } : {}) })
}

function placementArguments(placement) {
  return placement.mode === 'location'
    ? ['--location', placement.value]
    : ['--jurisdiction', placement.value]
}

async function waitForWorker(workerUrl, expectedCommit, options = {}) {
  const requestJson = options.requestJson || defaultRequestJson
  const wait = options.wait || (milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)))
  let lastError = null
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const health = await requestJson(`${workerUrl}/api/health`, { expectedStatus: 200 })
      if (health.status === 'ok' && health.commit === expectedCommit) return
      lastError = new Error('WALLET1_SMOKE_WORKER_RELEASE_MISMATCH')
    }
    catch (error) {
      lastError = error
    }
    await wait(5_000)
  }
  throw Object.assign(new Error('WALLET1_SMOKE_WORKER_NOT_READY'), { cause: lastError })
}

async function defaultRequestJson(url, options = {}) {
  let response
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  }
  catch {
    throw new Error('WALLET1_SMOKE_HTTP_REQUEST_FAILED')
  }
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  }
  catch {
    throw new Error('WALLET1_SMOKE_HTTP_RESPONSE_NOT_JSON')
  }
  if (response.status !== options.expectedStatus) {
    throw new Error(`WALLET1_SMOKE_HTTP_STATUS_${response.status}_EXPECTED_${options.expectedStatus}`)
  }
  return payload
}

async function runWrangler(args, name, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand
  return runCommand('corepack', ['pnpm', '--filter', '@meigallery/api', 'exec', 'wrangler', ...args], {
    cwd: ROOT_DIR,
    name,
  })
}

async function defaultRunCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    })
    return { status: 'passed', stdout: result.stdout, stderr: result.stderr }
  }
  catch (error) {
    return {
      status: 'failed',
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    }
  }
}

function ensurePassed(step, code) {
  if (step?.status !== 'passed') throw new Error(code)
}

function isNotFoundStep(step) {
  return /(?:not found|does not exist|code\s*[=:]\s*10090)/iu.test(`${step?.stdout || ''}\n${step?.stderr || ''}`)
}

function requireRunConfirmation(value) {
  if (value !== WALLET1_DISPOSABLE_CONFIRMATION) {
    throw new Error('WALLET1_SMOKE_EXPLICIT_CONFIRMATION_REQUIRED')
  }
}

function validApproval(value) {
  return validDate(value?.approvedAt)
    && Array.isArray(value?.approvedBy)
    && value.approvedBy.length > 0
    && value.approvedBy.every(item => typeof item === 'string' && item.trim().length >= 2)
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function assertBeforeDeadline(deadline, now) {
  if (now.getTime() >= deadline.getTime()) throw new Error('WALLET1_SMOKE_RESOURCE_DEADLINE_EXCEEDED')
}

function assertOutsideRepository(candidate) {
  const relative = path.relative(resolve(ROOT_DIR), resolve(candidate))
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('WALLET1_SMOKE_PATH_INSIDE_REPOSITORY')
  }
}

function collectObjects(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output)
    return
  }
  if (!value || typeof value !== 'object') return
  output.push(value)
  for (const child of Object.values(value)) collectObjects(child, output)
}

function readArgument(argv, name) {
  const prefix = `${name}=`
  const value = argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
  return value || null
}

function safeErrorCode(error) {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[^A-Za-z0-9_+-]/gu, '_').slice(0, 160) || 'UNKNOWN_ERROR'
}

function writeProgress(stdout, runId, phase, status) {
  stdout.write(`WALLET1_DISPOSABLE_SMOKE_PROGRESS run=${runId} phase=${phase} status=${status}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
