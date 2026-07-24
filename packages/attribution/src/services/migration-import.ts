import type {
  AttributionMigrationConnectionV1,
  AttributionMigrationHistoryDailyV1,
  AttributionMigrationImportResultV1,
  AttributionMigrationLiveFactV1,
  AttributionMigrationManagedSourceV1,
  AttributionMigrationSnapshotV1,
  AttributionProvider,
} from '@meigallery/shared'
import {
  getProviderAdapter,
  getProviderCredentialType,
} from '../adapters/registry'
import {
  hashCandidateIdentity,
  normalizeCandidateInput,
} from '../domain/normalization'
import { sha256Hex } from '../security/digest'
import {
  fingerprintCredential,
  sealCredential,
} from './credential-vault'
import { readAttributionRuntimeState } from './runtime-state'

export interface AttributionMigrationImportEnvironment {
  db: D1Database
  credentialKeys: {
    current: string
    previous?: string
  }
  now?: () => Date
}

export interface AttributionMigrationImportRequest {
  runId: string
  actorId: number
  snapshot: AttributionMigrationSnapshotV1
}

export async function readAttributionMigrationImportResult(
  db: D1Database,
  runId: string,
): Promise<AttributionMigrationImportResultV1 | null> {
  if (!IDENTIFIER_PATTERN.test(runId)) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
  const row = await readMigrationReceiptRow(
    db,
    migrationReceiptKey(runId),
  )
  if (!row) return null
  if (row.command_type !== MIGRATION_COMMAND) {
    throw migrationError('ATTRIBUTION_MIGRATION_RECEIPT_INVALID')
  }
  return {
    ...parseMigrationReceipt(row, runId),
    replayed: true,
  }
}

interface PreparedConnection {
  input: AttributionMigrationConnectionV1
  versionId: string
  configHash: string
  credential: Awaited<ReturnType<typeof sealCredential>>
}

interface MigrationReceiptRow {
  command_type: string
  request_hash: string
  result_json: string
}

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const PERCENTAGES = new Set([0, 10, 50, 100])
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const PROOF_PATTERN = /^[a-f0-9]{64}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const COUNTRY_PATTERN = /^[A-Z]{2}$/
const MAX_CONNECTIONS = 100
const MAX_SOURCES = 10_000
const MAX_LIVE_FACTS = 20_000
const MAX_HISTORY_ROWS = 20_000
const MIGRATION_COMMAND = 'migration_import'

export async function importAttributionMigrationSnapshot(
  environment: AttributionMigrationImportEnvironment,
  request: AttributionMigrationImportRequest,
): Promise<AttributionMigrationImportResultV1> {
  try {
    validateRequest(request)
    return await importValidatedSnapshot(environment, request)
  } finally {
    clearPlaintextCredentials(request)
  }
}

async function importValidatedSnapshot(
  environment: AttributionMigrationImportEnvironment,
  request: AttributionMigrationImportRequest,
): Promise<AttributionMigrationImportResultV1> {
  const now = validNow(environment.now ?? (() => new Date()))
  const state = await readAttributionRuntimeState(environment.db)
  if (state.mode !== 'shadow' && state.mode !== 'bridge') {
    throw migrationError('ATTRIBUTION_MIGRATION_RUNTIME_MODE_INVALID')
  }

  const prepared = await prepareConnections(
    environment,
    request.snapshot.connections,
  )
  const safeSnapshot = await safeSnapshotIdentity(
    request.snapshot,
    prepared,
  )
  const requestHash = await sha256Hex(stableJson({
    runId: request.runId,
    snapshot: safeSnapshot,
  }))
  const receiptKey = migrationReceiptKey(request.runId)
  const replay = await readMigrationReceipt(
    environment.db,
    receiptKey,
    requestHash,
    request.runId,
  )
  if (replay) return { ...replay, replayed: true }

  await assertEmptyMigrationTarget(environment.db)
  const result = migrationResult(
    request.runId,
    requestHash,
    request.snapshot,
  )
  const statements = await migrationStatements(
    environment.db,
    request,
    prepared,
    result,
    receiptKey,
    now,
  )

  try {
    const outcomes = await environment.db.batch(statements)
    if (
      outcomes.length !== statements.length
      || outcomes.some(outcome =>
        Number(outcome.meta.changes ?? 0) !== 1)
    ) {
      throw migrationError('ATTRIBUTION_MIGRATION_WRITE_FAILED')
    }
  } catch (error) {
    const raced = await readMigrationReceipt(
      environment.db,
      receiptKey,
      requestHash,
      request.runId,
    )
    if (raced) return { ...raced, replayed: true }
    if (error instanceof AttributionMigrationError) throw error
    throw migrationError('ATTRIBUTION_MIGRATION_WRITE_FAILED')
  }

  return result
}

async function prepareConnections(
  environment: AttributionMigrationImportEnvironment,
  connections: AttributionMigrationConnectionV1[],
): Promise<PreparedConnection[]> {
  const prepared: PreparedConnection[] = []
  for (const connection of connections) {
    const versionId = await migratedVersionId(connection.id)
    const adapter = getProviderAdapter(connection.provider)
    await adapter.validateCandidate({
      provider: connection.provider,
      connectionId: connection.id,
      versionId,
      publicConfig: connection.publicConfig,
      credential: connection.credential.plaintext,
      bindings: connection.eventBindings,
    })
    const credentialFingerprint = await fingerprintCredential(
      connection.credential.plaintext,
    )
    const candidate = normalizeCandidateInput({
      provider: connection.provider,
      publicConfig: connection.publicConfig,
      bindings: connection.eventBindings,
      credentialFingerprint,
    })
    prepared.push({
      input: connection,
      versionId,
      configHash: await hashCandidateIdentity(candidate),
      credential: await sealCredential(
        { current: environment.credentialKeys.current },
        {
          versionId,
          provider: connection.provider,
          plaintext: connection.credential.plaintext,
        },
      ),
    })
  }
  return prepared
}

async function migrationStatements(
  db: D1Database,
  request: AttributionMigrationImportRequest,
  prepared: PreparedConnection[],
  result: AttributionMigrationImportResultV1,
  receiptKey: string,
  now: string,
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = []
  const versionByConnection = new Map(
    prepared.map(item => [item.input.id, item.versionId]),
  )
  const connectionByProvider = new Map(
    prepared
      .filter(item => item.input.isDefault)
      .map(item => [item.input.provider, item.input.id]),
  )

  for (const item of prepared) {
    const connection = item.input
    statements.push(
      db.prepare(`
        INSERT INTO attribution_connections (
          id, provider, name, is_default, active_version_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).bind(
        connection.id,
        connection.provider,
        connection.name,
        connection.isDefault ? 1 : 0,
        connection.createdAt,
        connection.updatedAt,
      ),
      db.prepare(`
        INSERT INTO attribution_connection_versions (
          id, connection_id, provider, base_active_version_id, status,
          public_config_json, config_hash, created_by, created_at,
          validated_at, activated_at
        ) VALUES (?, ?, ?, NULL, 'active', ?, ?, ?, ?, ?, ?)
      `).bind(
        item.versionId,
        connection.id,
        connection.provider,
        JSON.stringify(connection.publicConfig),
        item.configHash,
        request.actorId,
        connection.createdAt,
        connection.updatedAt,
        connection.updatedAt,
      ),
      db.prepare(`
        INSERT INTO attribution_version_credentials (
          version_id, provider, schema_version, key_id, iv, ciphertext,
          tag, credential_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        item.versionId,
        connection.provider,
        item.credential.schemaVersion,
        item.credential.keyId,
        item.credential.iv,
        item.credential.ciphertext,
        item.credential.tag,
        item.credential.fingerprint,
      ),
      ...connection.eventBindings.map(binding => db.prepare(`
        INSERT INTO attribution_version_bindings (
          version_id, canonical_event, enabled,
          browser_destination, server_destination
        ) VALUES (?, ?, ?, ?, ?)
      `).bind(
        item.versionId,
        binding.canonicalEvent,
        binding.enabled ? 1 : 0,
        binding.browserDestination,
        binding.serverDestination,
      )),
      db.prepare(`
        INSERT INTO attribution_runtime_policies (
          connection_id, enabled, browser_enabled, server_enabled,
          server_target_percentage, server_effective_percentage,
          circuit_state, runtime_generation, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).bind(
        connection.id,
        connection.enabled ? 1 : 0,
        connection.browserEnabled ? 1 : 0,
        connection.serverEnabled ? 1 : 0,
        connection.serverTargetPercentage,
        connection.serverEffectivePercentage,
        connection.circuitState,
        request.actorId,
        connection.updatedAt,
      ),
      db.prepare(`
        UPDATE attribution_connections
        SET active_version_id = ?
        WHERE id = ? AND active_version_id IS NULL
      `).bind(item.versionId, connection.id),
    )
  }

  for (const source of request.snapshot.managedSources) {
    statements.push(await managedSourceStatement(db, source, now))
  }
  for (const fact of request.snapshot.liveFacts) {
    statements.push(await liveFactStatement(
      db,
      fact,
      versionByConnection,
      connectionByProvider,
    ))
  }
  for (const history of request.snapshot.historyDaily) {
    statements.push(historyStatement(
      db,
      history,
      request.snapshot.capturedAt,
    ))
  }

  statements.push(
    db.prepare(`
      UPDATE attribution_privacy_policy
      SET default_mode = ?,
          prior_consent_country_codes_json = ?,
          policy_version = ?,
          updated_by = ?,
          updated_at = ?
      WHERE id = 'global'
    `).bind(
      request.snapshot.privacyPolicy.defaultMode,
      JSON.stringify(
        request.snapshot.privacyPolicy.priorConsentCountryCodes,
      ),
      request.snapshot.privacyPolicy.policyVersion,
      request.actorId,
      request.snapshot.privacyPolicy.updatedAt,
    ),
    db.prepare(`
      INSERT INTO attribution_audit_logs (
        id, actor_id, command_type, connection_id, outcome,
        detail_json, created_at
      ) VALUES (?, ?, ?, 'migration', 'imported', ?, ?)
    `).bind(
      `audit_migration_${result.snapshotHash.slice(0, 24)}`,
      request.actorId,
      MIGRATION_COMMAND,
      JSON.stringify({
        runId: result.runId,
        snapshotHash: result.snapshotHash,
        counts: result.counts,
      }),
      now,
    ),
    db.prepare(`
      INSERT INTO attribution_command_receipts (
        idempotency_key, command_type, request_hash,
        result_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      receiptKey,
      MIGRATION_COMMAND,
      result.snapshotHash,
      JSON.stringify(result),
      now,
    ),
  )
  return statements
}

async function managedSourceStatement(
  db: D1Database,
  source: AttributionMigrationManagedSourceV1,
  now: string,
) {
  return db.prepare(`
    INSERT INTO attribution_managed_sources (
      id, provider, connection_id, campaign, medium, content,
      proof_hash, expires_at, enabled, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    source.id,
    source.provider,
    source.connectionId,
    source.campaign,
    source.medium,
    source.content,
    await managedSourceHash(source.proof),
    source.expiresAt,
    source.enabled ? 1 : 0,
    source.createdAt || now,
  )
}

async function liveFactStatement(
  db: D1Database,
  fact: AttributionMigrationLiveFactV1,
  versionByConnection: Map<string, string>,
  connectionByProvider: Map<AttributionProvider, string>,
) {
  const connectionId = fact.provider
    ? connectionByProvider.get(fact.provider) ?? null
    : null
  if (fact.provider && !connectionId) {
    throw migrationError('ATTRIBUTION_MIGRATION_PROVIDER_AMBIGUOUS')
  }
  const versionId = connectionId
    ? versionByConnection.get(connectionId) ?? null
    : null
  return db.prepare(`
    INSERT INTO attribution_facts (
      id, event_id, event_name, fact_origin, dedupe_hash,
      event_fingerprint, connection_id, version_id, provider,
      external_event_id, occurred_at, consent_json,
      analytics_dimensions_json, created_at
    ) VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fact.id,
    fact.eventId,
    fact.eventName,
    await sha256Hex(`fact-dedupe:v1:${fact.dedupeKey}`),
    await sha256Hex(`migrated-fact:v1:${stableJson(fact)}`),
    connectionId,
    versionId,
    fact.provider,
    fact.provider ? fact.externalEventId : null,
    fact.occurredAt,
    JSON.stringify(fact.consent),
    JSON.stringify(fact.analyticsDimensions),
    fact.createdAt,
  )
}

function historyStatement(
  db: D1Database,
  history: AttributionMigrationHistoryDailyV1,
  capturedAt: string,
) {
  return db.prepare(`
    INSERT INTO attribution_history_daily (
      date, event_name, fact_origin, provider, attribution_source,
      fact_count, first_occurred_at, last_occurred_at, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    history.date,
    history.eventName,
    history.factOrigin,
    history.provider ?? 'none',
    history.attributionSource,
    history.factCount,
    history.firstOccurredAt,
    history.lastOccurredAt,
    capturedAt,
  )
}

async function safeSnapshotIdentity(
  snapshot: AttributionMigrationSnapshotV1,
  prepared: PreparedConnection[],
) {
  const credentials = new Map(prepared.map(item => [
    item.input.id,
    item.credential.fingerprint,
  ]))
  return {
    schemaVersion: snapshot.schemaVersion,
    capturedAt: snapshot.capturedAt,
    windowStartedAt: snapshot.windowStartedAt,
    connections: snapshot.connections.map(connection => ({
      ...connection,
      credential: {
        type: connection.credential.type,
        fingerprint: credentials.get(connection.id),
      },
    })),
    managedSources: await Promise.all(snapshot.managedSources.map(
      async source => ({
        ...source,
        proof: await managedSourceHash(source.proof),
      }),
    )),
    liveFacts: snapshot.liveFacts,
    historyDaily: snapshot.historyDaily,
    privacyPolicy: snapshot.privacyPolicy,
  }
}

async function readMigrationReceipt(
  db: D1Database,
  receiptKey: string,
  requestHash: string,
  runId: string,
): Promise<AttributionMigrationImportResultV1 | null> {
  const row = await readMigrationReceiptRow(db, receiptKey)
  if (!row) return null
  if (
    row.command_type !== MIGRATION_COMMAND
    || row.request_hash !== requestHash
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_IDEMPOTENCY_CONFLICT')
  }
  return parseMigrationReceipt(row, runId)
}

async function readMigrationReceiptRow(
  db: D1Database,
  receiptKey: string,
): Promise<MigrationReceiptRow | null> {
  return db.prepare(`
    SELECT command_type, request_hash, result_json
    FROM attribution_command_receipts
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(receiptKey).first<MigrationReceiptRow>()
}

function parseMigrationReceipt(
  row: MigrationReceiptRow,
  runId: string,
): AttributionMigrationImportResultV1 {
  try {
    const parsed = JSON.parse(
      row.result_json,
    ) as AttributionMigrationImportResultV1
    if (
      !isPlainRecord(parsed)
      || parsed.runId !== runId
      || typeof parsed.snapshotHash !== 'string'
      || !PROOF_PATTERN.test(parsed.snapshotHash)
      || parsed.snapshotHash !== row.request_hash
      || typeof parsed.replayed !== 'boolean'
      || !validImportCounts(parsed.counts)
    ) {
      throw new Error('invalid receipt')
    }
    return parsed
  } catch {
    throw migrationError('ATTRIBUTION_MIGRATION_RECEIPT_INVALID')
  }
}

function validImportCounts(
  value: unknown,
): value is AttributionMigrationImportResultV1['counts'] {
  if (!isPlainRecord(value)) return false
  const keys = [
    'connections',
    'versions',
    'credentials',
    'bindings',
    'managedSources',
    'liveFacts',
    'historyRows',
  ] as const
  return keys.every(key =>
    Number.isSafeInteger(value[key])
    && Number(value[key]) >= 0)
}

async function assertEmptyMigrationTarget(db: D1Database): Promise<void> {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM attribution_connections)
      + (SELECT COUNT(*) FROM attribution_managed_sources)
      + (SELECT COUNT(*) FROM attribution_facts)
      + (SELECT COUNT(*) FROM attribution_history_daily) AS row_count
  `).first<{ row_count: number }>()
  if (Number(row?.row_count ?? -1) !== 0) {
    throw migrationError('ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY')
  }
}

function validateRequest(request: AttributionMigrationImportRequest): void {
  if (
    !isPlainRecord(request)
    || !IDENTIFIER_PATTERN.test(request.runId)
    || !Number.isSafeInteger(request.actorId)
    || request.actorId < 1
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
  validateSnapshot(request.snapshot)
}

function validateSnapshot(snapshot: AttributionMigrationSnapshotV1): void {
  if (
    !isPlainRecord(snapshot)
    || snapshot.schemaVersion !== 1
    || !isTimestamp(snapshot.capturedAt)
    || !isTimestamp(snapshot.windowStartedAt)
    || Date.parse(snapshot.windowStartedAt) > Date.parse(snapshot.capturedAt)
    || !Array.isArray(snapshot.connections)
    || snapshot.connections.length < 1
    || snapshot.connections.length > MAX_CONNECTIONS
    || !Array.isArray(snapshot.managedSources)
    || snapshot.managedSources.length > MAX_SOURCES
    || !Array.isArray(snapshot.liveFacts)
    || snapshot.liveFacts.length > MAX_LIVE_FACTS
    || !Array.isArray(snapshot.historyDaily)
    || snapshot.historyDaily.length > MAX_HISTORY_ROWS
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
  snapshot.connections.forEach(validateConnection)
  validateUniqueConnections(snapshot.connections)
  snapshot.managedSources.forEach(source =>
    validateManagedSource(source, snapshot.connections))
  snapshot.liveFacts.forEach(fact =>
    validateLiveFact(fact, snapshot.connections))
  snapshot.historyDaily.forEach(validateHistory)
  validatePrivacyPolicy(snapshot.privacyPolicy)
}

function validateConnection(
  connection: AttributionMigrationConnectionV1,
): void {
  if (
    !isPlainRecord(connection)
    || !IDENTIFIER_PATTERN.test(connection.id)
    || !PROVIDERS.has(connection.provider)
    || !isSafeText(connection.name, 160)
    || typeof connection.isDefault !== 'boolean'
    || typeof connection.enabled !== 'boolean'
    || typeof connection.browserEnabled !== 'boolean'
    || typeof connection.serverEnabled !== 'boolean'
    || !PERCENTAGES.has(connection.serverTargetPercentage)
    || !PERCENTAGES.has(connection.serverEffectivePercentage)
    || !['closed', 'server_open'].includes(connection.circuitState)
    || !isStringRecord(connection.publicConfig)
    || !Array.isArray(connection.eventBindings)
    || connection.eventBindings.length !== 2
    || !isPlainRecord(connection.credential)
    || connection.credential.type
      !== getProviderCredentialType(connection.provider)
    || !isSecret(connection.credential.plaintext)
    || !isTimestamp(connection.createdAt)
    || !isTimestamp(connection.updatedAt)
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
  const events = new Set<string>()
  for (const binding of connection.eventBindings) {
    if (
      !isPlainRecord(binding)
      || (
        binding.canonicalEvent !== 'Contact'
        && binding.canonicalEvent !== 'CompleteRegistration'
      )
      || typeof binding.enabled !== 'boolean'
      || !isSafeText(binding.browserDestination, 1_000)
      || !isSafeText(binding.serverDestination, 1_000)
      || events.has(binding.canonicalEvent)
    ) {
      throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
    }
    events.add(binding.canonicalEvent)
  }
}

function validateUniqueConnections(
  connections: AttributionMigrationConnectionV1[],
): void {
  const ids = new Set<string>()
  const defaults = new Set<string>()
  const providers = new Set<string>()
  for (const connection of connections) {
    if (
      ids.has(connection.id)
      || (
        connection.isDefault
        && defaults.has(connection.provider)
      )
    ) {
      throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
    }
    ids.add(connection.id)
    providers.add(connection.provider)
    if (connection.isDefault) defaults.add(connection.provider)
  }
  if ([...providers].some(provider => !defaults.has(provider))) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
}

function validateManagedSource(
  source: AttributionMigrationManagedSourceV1,
  connections: AttributionMigrationConnectionV1[],
): void {
  const connection = connections.find(item =>
    item.id === source.connectionId)
  if (
    !isPlainRecord(source)
    || !IDENTIFIER_PATTERN.test(source.id)
    || !PROVIDERS.has(source.provider)
    || !connection
    || connection.provider !== source.provider
    || !isSafeText(source.campaign, 1_000)
    || !isSafeText(source.medium, 1_000)
    || !isSafeText(source.content, 1_000, true)
    || !PROOF_PATTERN.test(source.proof)
    || typeof source.enabled !== 'boolean'
    || (
      source.expiresAt !== null
      && !isTimestamp(source.expiresAt)
    )
    || !isTimestamp(source.createdAt)
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
}

function validateLiveFact(
  fact: AttributionMigrationLiveFactV1,
  connections: AttributionMigrationConnectionV1[],
): void {
  if (
    !isPlainRecord(fact)
    || !IDENTIFIER_PATTERN.test(fact.id)
    || !IDENTIFIER_PATTERN.test(fact.eventId)
    || (
      fact.eventName !== 'Contact'
      && fact.eventName !== 'CompleteRegistration'
    )
    || !isSafeText(fact.dedupeKey, 240)
    || (
      fact.provider !== null
      && !PROVIDERS.has(fact.provider)
    )
    || (
      fact.provider !== null
      && !connections.some(item => item.provider === fact.provider)
    )
    || (
      fact.provider === null
        ? fact.externalEventId !== null
        : !IDENTIFIER_PATTERN.test(fact.externalEventId ?? '')
    )
    || !isTimestamp(fact.occurredAt)
    || !isConsent(fact.consent)
    || !isPlainRecord(fact.analyticsDimensions)
    || stableJson(fact.analyticsDimensions).length > 32_768
    || !isTimestamp(fact.createdAt)
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
}

function validateHistory(
  history: AttributionMigrationHistoryDailyV1,
): void {
  if (
    !isPlainRecord(history)
    || !DATE_PATTERN.test(history.date)
    || Number.isNaN(Date.parse(`${history.date}T00:00:00.000Z`))
    || (
      history.eventName !== 'Contact'
      && history.eventName !== 'CompleteRegistration'
    )
    || (
      history.factOrigin !== 'historical_backfill'
      && history.factOrigin !== 'archived_live'
    )
    || (
      history.provider !== null
      && !PROVIDERS.has(history.provider)
    )
    || !isSafeText(history.attributionSource, 80)
    || !Number.isSafeInteger(history.factCount)
    || history.factCount < 1
    || !isTimestamp(history.firstOccurredAt)
    || !isTimestamp(history.lastOccurredAt)
    || Date.parse(history.firstOccurredAt)
      > Date.parse(history.lastOccurredAt)
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
}

function validatePrivacyPolicy(
  policy: AttributionMigrationSnapshotV1['privacyPolicy'],
): void {
  if (
    !isPlainRecord(policy)
    || !['notice_opt_out', 'prior_consent', 'disabled']
      .includes(policy.defaultMode)
    || !Array.isArray(policy.priorConsentCountryCodes)
    || policy.priorConsentCountryCodes.some(code =>
      typeof code !== 'string' || !COUNTRY_PATTERN.test(code))
    || new Set(policy.priorConsentCountryCodes).size
      !== policy.priorConsentCountryCodes.length
    || !Number.isSafeInteger(policy.policyVersion)
    || policy.policyVersion < 1
    || !isTimestamp(policy.updatedAt)
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
}

function migrationResult(
  runId: string,
  snapshotHash: string,
  snapshot: AttributionMigrationSnapshotV1,
): AttributionMigrationImportResultV1 {
  return {
    runId,
    snapshotHash,
    replayed: false,
    counts: {
      connections: snapshot.connections.length,
      versions: snapshot.connections.length,
      credentials: snapshot.connections.length,
      bindings: snapshot.connections.reduce(
        (total, connection) =>
          total + connection.eventBindings.length,
        0,
      ),
      managedSources: snapshot.managedSources.length,
      liveFacts: snapshot.liveFacts.length,
      historyRows: snapshot.historyDaily.length,
    },
  }
}

function migrationReceiptKey(runId: string): string {
  return `migration:${runId}`
}

async function migratedVersionId(connectionId: string): Promise<string> {
  const candidate = `version_migrated_${connectionId}`
  if (candidate.length <= 160 && IDENTIFIER_PATTERN.test(candidate)) {
    return candidate
  }
  return `version_migrated_${(await sha256Hex(connectionId)).slice(0, 32)}`
}

async function managedSourceHash(proof: string): Promise<string> {
  return sha256Hex(`managed-source:v1:${proof}`)
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isPlainRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  )
}

function clearPlaintextCredentials(
  request: unknown,
): void {
  if (!isPlainRecord(request) || !isPlainRecord(request.snapshot)) return
  const connections = request.snapshot.connections
  if (!Array.isArray(connections)) return
  for (const connection of connections) {
    if (
      isPlainRecord(connection)
      && isPlainRecord(connection.credential)
      && typeof connection.credential.plaintext === 'string'
    ) {
      connection.credential.plaintext = ''
    }
  }
}

function validNow(now: () => Date): string {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw migrationError('ATTRIBUTION_MIGRATION_TIME_INVALID')
  }
  return value.toISOString()
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && Number.isFinite(Date.parse(value))
}

function isSafeText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return typeof value === 'string'
    && value.length <= maximum
    && (allowEmpty || value.trim().length > 0)
    && !/\p{Cc}/u.test(value)
}

function isSecret(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 32_768
}

function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return isPlainRecord(value)
    && Object.keys(value).length > 0
    && Object.keys(value).length <= 16
    && Object.entries(value).every(([key, item]) =>
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
      && isSafeText(item, 2_048))
}

function isConsent(
  value: unknown,
): value is AttributionMigrationLiveFactV1['consent'] {
  return isPlainRecord(value)
    && typeof value.marketingAllowed === 'boolean'
    && typeof value.adUserDataAllowed === 'boolean'
    && typeof value.adPersonalizationAllowed === 'boolean'
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export class AttributionMigrationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AttributionMigrationError'
  }
}

function migrationError(code: string): AttributionMigrationError {
  return new AttributionMigrationError(code)
}
