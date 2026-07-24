import type {
  AttributionMigrationConnectionV1,
  AttributionMigrationHistoryDailyV1,
  AttributionMigrationImportResultV1,
  AttributionMigrationLiveFactV1,
  AttributionMigrationManagedSourceV1,
  AttributionMigrationRolloutPercentage,
  AttributionMigrationSnapshotV1,
  AttributionProvider,
  AttributionCredentialType,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import {
  readAttributionCredential,
} from './ad-platform/credential-vault'
import { createAttributionMigrationClient } from './attribution-service-client'

export interface AttributionMigrationExportEnvironment {
  DB: D1Database
  ATTRIBUTION: {
    fetch(request: Request): Promise<Response>
  }
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT?: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
  readCredential?: typeof readAttributionCredential
}

export interface AttributionMigrationExportOptions {
  runId: string
  actorId: number
  now?: Date
  logger?: {
    info(message: string, detail?: Record<string, unknown>): void
    error(message: string, detail?: Record<string, unknown>): void
  }
}

interface ConnectionRow {
  id: string
  provider: string
  enabled: number
  mode: string
  browser_enabled: number
  server_enabled: number
  public_config_json: string
  attribution_window_days: number
  rollout_target_percentage: number
  rollout_effective_percentage: number
  credential_revision: string
  created_at: string
  updated_at: string
}

interface BindingRow {
  connection_id: string
  provider: string
  canonical_event: string
  enabled: number
  browser_destination: string
  server_destination: string
}

interface CredentialRow {
  connection_id: string
  provider: string
  credential_type: string
  credential_revision: string
}

interface SourceRow {
  id: string
  ad_provider: string
  utm_campaign: string
  utm_medium: string
  utm_content: string
  link_proof: string
  status: string
  created_at: string
}

interface LiveFactRow {
  id: string
  canonical_event: string
  external_event_id: string
  attribution_provider: string | null
  occurred_at: string
  dedupe_key: string
  consent_snapshot_json: string
  analytics_dimensions_json: string
  created_at: string
}

interface HistoryRow {
  date: string
  canonical_event: string
  fact_origin: string
  attribution_provider: string | null
  attribution_source: string
  fact_count: number
  first_occurred_at: string
  last_occurred_at: string
}

interface PrivacyPolicyRow {
  default_mode: string
  prior_consent_country_codes_json: string
  policy_version: number
  updated_at: string
}

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const PERCENTAGES = new Set<AttributionMigrationRolloutPercentage>([
  0,
  10,
  50,
  100,
])
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const MINIMUM_WINDOW_DAYS = 30
const MAXIMUM_WINDOW_DAYS = 365
const MAX_IMPORT_RESPONSE_BYTES = 64 * 1024

export async function exportAndImportAttributionMigration(
  environment: AttributionMigrationExportEnvironment,
  options: AttributionMigrationExportOptions,
): Promise<AttributionMigrationImportResultV1> {
  validateOptions(options)
  const client = createAttributionMigrationClient(
    environment.ATTRIBUTION,
  )
  const replay = await readExistingImportResult(client, options)
  if (replay) return replay

  const capturedAt = validDate(options.now ?? new Date())
  const source = await readSourceRows(environment.DB)
  const windowDays = migrationWindowDays(source.connections)
  const windowStartedAt = new Date(
    capturedAt.getTime() - windowDays * 24 * 60 * 60 * 1_000,
  )
  let snapshot: AttributionMigrationSnapshotV1 | null = null

  try {
    snapshot = await buildSnapshot(
      environment,
      source,
      capturedAt,
      windowStartedAt,
    )
    const response = await client.importSnapshot({
      runId: options.runId,
      actorId: options.actorId,
      snapshot,
    })
    const body = await readBoundedJson(response)
    if (!response.ok) {
      const code = safeErrorCode(body)
      options.logger?.error('归因迁移导入失败', {
        runId: options.runId,
        status: response.status,
        code,
      })
      throw migrationError(code)
    }
    const result = parseImportResult(body, options.runId)
    options.logger?.info('归因迁移导入完成', {
      runId: result.runId,
      replayed: result.replayed,
      counts: result.counts,
    })
    return result
  } finally {
    if (snapshot) clearSnapshotCredentials(snapshot)
  }
}

async function readExistingImportResult(
  client: ReturnType<typeof createAttributionMigrationClient>,
  options: AttributionMigrationExportOptions,
): Promise<AttributionMigrationImportResultV1 | null> {
  const response = await client.readImportResult({
    runId: options.runId,
    actorId: options.actorId,
  })
  const body = await readBoundedJson(response)
  if (
    response.status === 404
    && safeErrorCode(body) === 'ATTRIBUTION_MIGRATION_NOT_FOUND'
  ) {
    return null
  }
  if (!response.ok) {
    const code = safeErrorCode(body)
    options.logger?.error('归因迁移回执查询失败', {
      runId: options.runId,
      status: response.status,
      code,
    })
    throw migrationError(code)
  }
  const result = parseImportResult(body, options.runId)
  options.logger?.info('归因迁移已完成，返回原回执', {
    runId: result.runId,
    counts: result.counts,
  })
  return {
    ...result,
    replayed: true,
  }
}

async function readSourceRows(db: D1Database) {
  const connections = (await db.prepare(`
    SELECT id, provider, enabled, mode, browser_enabled, server_enabled,
           public_config_json, attribution_window_days,
           rollout_target_percentage, rollout_effective_percentage,
           credential_revision, created_at, updated_at
    FROM attribution_platform_connections
    ORDER BY provider, id
  `).all<ConnectionRow>()).results
  const bindings = (await db.prepare(`
    SELECT connection_id, provider, canonical_event, enabled,
           browser_destination, server_destination
    FROM attribution_event_bindings
    ORDER BY connection_id, canonical_event
  `).all<BindingRow>()).results
  const credentials = (await db.prepare(`
    SELECT connection_id, provider, credential_type, credential_revision
    FROM attribution_credentials
    ORDER BY connection_id, credential_type
  `).all<CredentialRow>()).results
  const sources = (await db.prepare(`
    SELECT id, ad_provider, utm_campaign, utm_medium, utm_content,
           link_proof, status, created_at
    FROM analytics_tracking_sources
    WHERE channel = 'ad'
      AND ad_provider IN ('meta','tiktok','google')
    ORDER BY created_at, id
  `).all<SourceRow>()).results
  const privacyPolicy = await db.prepare(`
    SELECT default_mode, prior_consent_country_codes_json,
           policy_version, updated_at
    FROM attribution_privacy_policy
    WHERE id = 'global'
    LIMIT 1
  `).first<PrivacyPolicyRow>()

  return {
    connections,
    bindings,
    credentials,
    sources,
    privacyPolicy,
  }
}

async function buildSnapshot(
  environment: AttributionMigrationExportEnvironment,
  source: Awaited<ReturnType<typeof readSourceRows>>,
  capturedAt: Date,
  windowStartedAt: Date,
): Promise<AttributionMigrationSnapshotV1> {
  const connections = await buildConnections(environment, source)
  try {
    const connectionByProvider = new Map(
      connections.map(connection => [connection.provider, connection.id]),
    )
    const liveFacts = await readLiveFacts(
      environment.DB,
      windowStartedAt,
    )
    const historyDaily = await readHistory(
      environment.DB,
      windowStartedAt,
    )

    return {
      schemaVersion: 1,
      capturedAt: capturedAt.toISOString(),
      windowStartedAt: windowStartedAt.toISOString(),
      connections,
      managedSources: source.sources.map(row =>
        managedSource(row, connectionByProvider)),
      liveFacts: liveFacts.map(liveFact),
      historyDaily: historyDaily.map(historyRow),
      privacyPolicy: privacyPolicy(source.privacyPolicy),
    }
  } catch (error) {
    clearSnapshotCredentials({ connections } as AttributionMigrationSnapshotV1)
    throw error
  }
}

async function buildConnections(
  environment: AttributionMigrationExportEnvironment,
  source: Awaited<ReturnType<typeof readSourceRows>>,
): Promise<AttributionMigrationConnectionV1[]> {
  if (source.connections.length === 0) {
    throw migrationError('ATTRIBUTION_MIGRATION_CONNECTIONS_MISSING')
  }
  const readCredential = environment.readCredential
    ?? readAttributionCredential
  const result: AttributionMigrationConnectionV1[] = []

  try {
    for (const row of source.connections) {
      const provider = providerValue(row.provider)
      const credential = source.credentials.filter(item =>
        item.connection_id === row.id)
      const bindings = source.bindings.filter(item =>
        item.connection_id === row.id)
      if (
        credential.length !== 1
        || credential[0]!.provider !== provider
        || credential[0]!.credential_revision !== row.credential_revision
        || bindings.length !== 2
        || bindings.some(binding => binding.provider !== provider)
      ) {
        throw migrationError('ATTRIBUTION_MIGRATION_CONNECTION_INVALID')
      }
      const credentialType = credentialTypeValue(
        credential[0]!.credential_type,
      )
      const plaintext = await readCredential(
        environment as Parameters<typeof readAttributionCredential>[0],
        {
          connectionId: row.id,
          provider,
          credentialType,
          credentialRevision: row.credential_revision,
        },
      )
      result.push({
        id: identifier(row.id),
        provider,
        name: `${providerLabel(provider)} 默认连接`,
        isDefault: true,
        enabled: row.enabled === 1 && row.mode === 'production',
        browserEnabled: booleanInteger(row.browser_enabled),
        serverEnabled: booleanInteger(row.server_enabled),
        serverTargetPercentage: percentage(
          row.rollout_target_percentage,
        ),
        serverEffectivePercentage: percentage(
          row.rollout_effective_percentage,
        ),
        circuitState: 'closed',
        publicConfig: stringRecord(row.public_config_json),
        eventBindings: bindings.map(binding => ({
          canonicalEvent: canonicalEvent(binding.canonical_event),
          enabled: booleanInteger(binding.enabled),
          browserDestination: safeText(binding.browser_destination),
          serverDestination: safeText(binding.server_destination),
        })),
        credential: {
          type: credentialType,
          plaintext,
        },
        createdAt: isoTimestamp(row.created_at),
        updatedAt: isoTimestamp(row.updated_at),
      })
    }
    return result
  } catch (error) {
    for (const connection of result) {
      connection.credential.plaintext = ''
    }
    throw error
  }
}

async function readLiveFacts(
  db: D1Database,
  windowStartedAt: Date,
): Promise<LiveFactRow[]> {
  return (await db.prepare(`
    SELECT id, canonical_event, external_event_id,
           attribution_provider, occurred_at, dedupe_key,
           consent_snapshot_json, analytics_dimensions_json, created_at
    FROM attribution_conversion_facts
    WHERE fact_origin = 'live'
      AND julianday(occurred_at) >= julianday(?)
    ORDER BY occurred_at, id
  `).bind(windowStartedAt.toISOString()).all<LiveFactRow>()).results
}

async function readHistory(
  db: D1Database,
  windowStartedAt: Date,
): Promise<HistoryRow[]> {
  return (await db.prepare(`
    SELECT
      date(datetime(occurred_at, '+8 hours')) AS date,
      canonical_event,
      CASE
        WHEN fact_origin = 'live' THEN 'archived_live'
        ELSE fact_origin
      END AS fact_origin,
      attribution_provider,
      attribution_source,
      COUNT(*) AS fact_count,
      MIN(occurred_at) AS first_occurred_at,
      MAX(occurred_at) AS last_occurred_at
    FROM attribution_conversion_facts
    WHERE fact_origin = 'historical_backfill'
       OR (
         fact_origin = 'live'
         AND julianday(occurred_at) < julianday(?)
       )
    GROUP BY
      date(datetime(occurred_at, '+8 hours')),
      canonical_event,
      CASE
        WHEN fact_origin = 'live' THEN 'archived_live'
        ELSE fact_origin
      END,
      attribution_provider,
      attribution_source
    ORDER BY date, canonical_event, attribution_provider
  `).bind(windowStartedAt.toISOString()).all<HistoryRow>()).results
}

function managedSource(
  row: SourceRow,
  connectionByProvider: Map<AttributionProvider, string>,
): AttributionMigrationManagedSourceV1 {
  const provider = providerValue(row.ad_provider)
  const connectionId = connectionByProvider.get(provider)
  if (!connectionId || !/^[a-f0-9]{64}$/.test(row.link_proof)) {
    throw migrationError('ATTRIBUTION_MIGRATION_SOURCE_INVALID')
  }
  return {
    id: identifier(row.id),
    provider,
    connectionId,
    campaign: safeText(row.utm_campaign || row.id),
    medium: safeText(row.utm_medium),
    content: optionalText(row.utm_content),
    proof: row.link_proof,
    enabled: row.status === 'active',
    expiresAt: null,
    createdAt: isoTimestamp(row.created_at),
  }
}

function liveFact(row: LiveFactRow): AttributionMigrationLiveFactV1 {
  const provider = row.attribution_provider === null
    ? null
    : providerValue(row.attribution_provider)
  const eventId = identifier(row.external_event_id)
  const consent = jsonRecord(row.consent_snapshot_json)
  return {
    id: identifier(row.id),
    eventId,
    eventName: canonicalEvent(row.canonical_event),
    dedupeKey: safeText(row.dedupe_key, 240),
    provider,
    externalEventId: provider ? eventId : null,
    occurredAt: isoTimestamp(row.occurred_at),
    consent: {
      marketingAllowed: booleanValue(consent.marketingAllowed),
      adUserDataAllowed: booleanValue(consent.adUserDataAllowed),
      adPersonalizationAllowed: booleanValue(
        consent.adPersonalizationAllowed,
      ),
    },
    analyticsDimensions: jsonRecord(row.analytics_dimensions_json),
    createdAt: isoTimestamp(row.created_at),
  }
}

function historyRow(
  row: HistoryRow,
): AttributionMigrationHistoryDailyV1 {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
    || !Number.isSafeInteger(row.fact_count)
    || row.fact_count < 1
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_HISTORY_INVALID')
  }
  return {
    date: row.date,
    eventName: canonicalEvent(row.canonical_event),
    factOrigin: row.fact_origin === 'archived_live'
      ? 'archived_live'
      : 'historical_backfill',
    provider: row.attribution_provider === null
      ? null
      : providerValue(row.attribution_provider),
    attributionSource: safeText(row.attribution_source, 80),
    factCount: row.fact_count,
    firstOccurredAt: isoTimestamp(row.first_occurred_at),
    lastOccurredAt: isoTimestamp(row.last_occurred_at),
  }
}

function privacyPolicy(
  row: PrivacyPolicyRow | null,
): AttributionMigrationSnapshotV1['privacyPolicy'] {
  if (
    !row
    || !['notice_opt_out', 'prior_consent', 'disabled']
      .includes(row.default_mode)
    || !Number.isSafeInteger(row.policy_version)
    || row.policy_version < 1
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_PRIVACY_POLICY_INVALID')
  }
  let countries: unknown
  try {
    countries = JSON.parse(row.prior_consent_country_codes_json)
  } catch {
    throw migrationError('ATTRIBUTION_MIGRATION_PRIVACY_POLICY_INVALID')
  }
  if (
    !Array.isArray(countries)
    || countries.some(country =>
      typeof country !== 'string' || !/^[A-Z]{2}$/.test(country))
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_PRIVACY_POLICY_INVALID')
  }
  const defaultMode = row.default_mode as
    AttributionMigrationSnapshotV1['privacyPolicy']['defaultMode']
  return {
    defaultMode,
    priorConsentCountryCodes: [...new Set(countries)].sort(),
    policyVersion: row.policy_version,
    updatedAt: isoTimestamp(row.updated_at),
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_IMPORT_RESPONSE_BYTES) {
    throw migrationError('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw migrationError('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
}

function parseImportResult(
  value: unknown,
  runId: string,
): AttributionMigrationImportResultV1 {
  if (!isPlainRecord(value) || !isPlainRecord(value.data)) {
    throw migrationError('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
  const data = value.data
  const counts = isPlainRecord(data.counts)
    ? data.counts
    : null
  if (
    data.runId !== runId
    || typeof data.snapshotHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(data.snapshotHash)
    || typeof data.replayed !== 'boolean'
    || !counts
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
  const keys = [
    'connections',
    'versions',
    'credentials',
    'bindings',
    'managedSources',
    'liveFacts',
    'historyRows',
  ] as const
  if (keys.some(key =>
    !Number.isSafeInteger(counts[key])
    || Number(counts[key]) < 0)) {
    throw migrationError('ATTRIBUTION_MIGRATION_RESPONSE_INVALID')
  }
  return data as unknown as AttributionMigrationImportResultV1
}

function clearSnapshotCredentials(
  snapshot: AttributionMigrationSnapshotV1,
): void {
  for (const connection of snapshot.connections) {
    connection.credential.plaintext = ''
  }
}

function migrationWindowDays(rows: ConnectionRow[]): number {
  const values = rows.map(row => Number(row.attribution_window_days))
  if (values.some(value =>
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAXIMUM_WINDOW_DAYS)) {
    throw migrationError('ATTRIBUTION_MIGRATION_WINDOW_INVALID')
  }
  return Math.max(MINIMUM_WINDOW_DAYS, ...values)
}

function providerValue(value: unknown): AttributionProvider {
  if (typeof value !== 'string' || !PROVIDERS.has(
    value as AttributionProvider,
  )) {
    throw migrationError('ATTRIBUTION_MIGRATION_PROVIDER_INVALID')
  }
  return value as AttributionProvider
}

function credentialTypeValue(value: unknown): AttributionCredentialType {
  if (value !== 'access_token' && value !== 'service_account_json') {
    throw migrationError('ATTRIBUTION_MIGRATION_CREDENTIAL_INVALID')
  }
  return value
}

function percentage(
  value: unknown,
): AttributionMigrationRolloutPercentage {
  if (!PERCENTAGES.has(value as AttributionMigrationRolloutPercentage)) {
    throw migrationError('ATTRIBUTION_MIGRATION_ROLLOUT_INVALID')
  }
  return value as AttributionMigrationRolloutPercentage
}

function canonicalEvent(value: unknown): CanonicalConversionEvent {
  if (value !== 'Contact' && value !== 'CompleteRegistration') {
    throw migrationError('ATTRIBUTION_MIGRATION_EVENT_INVALID')
  }
  return value
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw migrationError('ATTRIBUTION_MIGRATION_IDENTIFIER_INVALID')
  }
  return value
}

function safeText(value: unknown, maximum = 1_000): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > maximum
    || /\p{Cc}/u.test(value)
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_TEXT_INVALID')
  }
  return value
}

function optionalText(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > 1_000
    || /\p{Cc}/u.test(value)
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_TEXT_INVALID')
  }
  return value
}

function booleanInteger(value: unknown): boolean {
  if (value !== 0 && value !== 1) {
    throw migrationError('ATTRIBUTION_MIGRATION_BOOLEAN_INVALID')
  }
  return value === 1
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw migrationError('ATTRIBUTION_MIGRATION_BOOLEAN_INVALID')
  }
  return value
}

function stringRecord(value: string): Record<string, string> {
  const record = jsonRecord(value)
  if (
    Object.keys(record).length === 0
    || Object.values(record).some(item => typeof item !== 'string')
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_CONFIG_INVALID')
  }
  return record as Record<string, string>
}

function jsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    if (!isPlainRecord(parsed)) throw new Error('not a record')
    return parsed
  } catch {
    throw migrationError('ATTRIBUTION_MIGRATION_JSON_INVALID')
  }
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw migrationError('ATTRIBUTION_MIGRATION_TIME_INVALID')
  }
  const canonical = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/
    .test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  return validDate(new Date(canonical)).toISOString()
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw migrationError('ATTRIBUTION_MIGRATION_TIME_INVALID')
  }
  return value
}

function providerLabel(provider: AttributionProvider): string {
  if (provider === 'meta') return 'Meta'
  if (provider === 'tiktok') return 'TikTok'
  return 'Google'
}

function safeErrorCode(value: unknown): string {
  if (
    isPlainRecord(value)
    && isPlainRecord(value.error)
    && typeof value.error.code === 'string'
    && IDENTIFIER_PATTERN.test(value.error.code)
  ) {
    return value.error.code
  }
  return 'ATTRIBUTION_MIGRATION_UPSTREAM_ERROR'
}

function validateOptions(options: AttributionMigrationExportOptions): void {
  if (
    !IDENTIFIER_PATTERN.test(options.runId)
    || !Number.isSafeInteger(options.actorId)
    || options.actorId < 1
  ) {
    throw migrationError('ATTRIBUTION_MIGRATION_OPTIONS_INVALID')
  }
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

export class AttributionMigrationExportError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AttributionMigrationExportError'
  }
}

function migrationError(code: string): AttributionMigrationExportError {
  return new AttributionMigrationExportError(code)
}
