import type {
  AdAttributionProvider,
  AdPlatformTrackingMode,
  CanonicalConversionEvent,
  PlatformPublicConfig,
} from '@meigallery/shared'
import {
  CredentialVaultError,
  prepareAttributionCredential,
  type CredentialVaultEnv,
  type PreparedAttributionCredential,
} from './credential-vault'
import { readAttributionConnectionSnapshot } from './connections'
import { getAdPlatformDefinition, listAdPlatformProviders } from './registry'

const CANONICAL_EVENTS = ['Contact', 'CompleteRegistration'] as const
const ROLLOUT_PERCENTAGES = new Set([0, 10, 50, 100])
const MODE_VALUES = new Set<AdPlatformTrackingMode>(['disabled', 'test', 'production'])
const REVISION_BYTES = 12
const BINDING_FIELDS = new Set(['canonicalEvent', 'enabled', 'browserDestination', 'serverDestination'])

export interface PlatformEventBindingInput {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination?: string
  serverDestination?: string
}

export interface SavePlatformConnectionCommand {
  provider: AdAttributionProvider
  enabled: boolean
  mode: AdPlatformTrackingMode
  browserEnabled: boolean
  serverEnabled: boolean
  publicConfig: PlatformPublicConfig
  eventBindings: PlatformEventBindingInput[]
  credential?: { type: 'access_token' | 'service_account_json'; plaintext: string }
  rolloutTargetPercentage: 0 | 10 | 50 | 100
  actorId: number
}

export interface PlatformConnectionView {
  connectionId: string
  provider: AdAttributionProvider
  enabled: boolean
  mode: AdPlatformTrackingMode
  browserEnabled: boolean
  serverEnabled: boolean
  publicConfig: PlatformPublicConfig
  eventBindings: Array<Required<PlatformEventBindingInput>>
  rolloutTargetPercentage: 0 | 10 | 50 | 100
  rolloutEffectivePercentage: 0 | 10 | 50 | 100
  connectionRevision: string
  credential: {
    configured: true
    type: 'access_token' | 'service_account_json'
    revision: string
  }
}

export type PlatformConnectionServiceEnv = CredentialVaultEnv

export type PlatformConnectionErrorCode =
  | 'AD_PLATFORM_CONNECTION_PROVIDER_INVALID'
  | 'AD_PLATFORM_CONNECTION_CONFIG_INVALID'
  | 'AD_PLATFORM_CONNECTION_BINDINGS_INVALID'
  | 'AD_PLATFORM_CONNECTION_MODE_INVALID'
  | 'AD_PLATFORM_CONNECTION_ROLLOUT_INVALID'
  | 'AD_PLATFORM_CONNECTION_ACTOR_INVALID'
  | 'AD_PLATFORM_CONNECTION_CREDENTIAL_REQUIRED'
  | 'AD_PLATFORM_CONNECTION_CREDENTIAL_INVALID'
  | 'AD_PLATFORM_CONNECTION_CREDENTIAL_CRYPTO_UNAVAILABLE'
  | 'AD_PLATFORM_CONNECTION_STATE_INVALID'
  | 'AD_PLATFORM_CONNECTION_READ_FAILED'
  | 'AD_PLATFORM_CONNECTION_WRITE_FAILED'

export class PlatformConnectionError extends Error {
  readonly code: PlatformConnectionErrorCode

  constructor(code: PlatformConnectionErrorCode) {
    super(code)
    this.name = 'PlatformConnectionError'
    this.code = code
  }
}

type ExistingConnectionRow = {
  id: string
  provider: string
  enabled: number
  mode: string
  browser_enabled: number
  server_enabled: number
  rollout_target_percentage: number
  rollout_effective_percentage: number
  connection_revision: string
  credential_revision: string
}

type ExistingCredentialRow = {
  id: string
  provider: string
  credential_type: string
  credential_revision: string
}

type ExistingState = {
  connection: ExistingConnectionRow
  credentials: ExistingCredentialRow[]
}

type ValidatedBinding = Required<PlatformEventBindingInput>

export async function savePlatformConnection(
  env: PlatformConnectionServiceEnv,
  command: SavePlatformConnectionCommand,
): Promise<PlatformConnectionView> {
  const definition = getAdPlatformDefinition(command.provider)
  if (!definition) throw serviceError('AD_PLATFORM_CONNECTION_PROVIDER_INVALID')
  validateCommonCommand(command)

  const publicConfig = validatePublicConfig(command.provider, command.publicConfig, definition.publicConfigSchema)
  const eventBindings = validateEventBindings(command.eventBindings, publicConfig, definition)
  const connectionId = `conn_${definition.provider}`
  const existing = await readExistingState(env.DB, connectionId, definition.provider)
  const connectionRevision = createRevision()
  const credentialRevision = command.credential ? createRevision() : existing?.connection.credential_revision

  if (!credentialRevision) throw serviceError('AD_PLATFORM_CONNECTION_CREDENTIAL_REQUIRED')
  if (!command.credential && !hasReusableCredential(existing, definition.credentialSchema.type)) {
    throw serviceError('AD_PLATFORM_CONNECTION_CREDENTIAL_REQUIRED')
  }

  let preparedCredential: PreparedAttributionCredential | null = null
  if (command.credential) {
    if (command.credential.type !== definition.credentialSchema.type) {
      throw serviceError('AD_PLATFORM_CONNECTION_CREDENTIAL_INVALID')
    }
    preparedCredential = await prepareCredential(env, {
      connectionId,
      provider: definition.provider,
      credentialType: command.credential.type,
      plaintext: command.credential.plaintext,
      credentialRevision,
      createdBy: command.actorId,
    })
  }

  const result: PlatformConnectionView = {
    connectionId,
    provider: definition.provider,
    enabled: command.enabled,
    mode: command.mode,
    browserEnabled: command.browserEnabled,
    serverEnabled: command.serverEnabled,
    publicConfig: { provider: definition.provider, ...publicConfig } as PlatformPublicConfig,
    eventBindings,
    rolloutTargetPercentage: command.rolloutTargetPercentage,
    rolloutEffectivePercentage: 0,
    connectionRevision,
    credential: {
      configured: true,
      type: definition.credentialSchema.type,
      revision: credentialRevision,
    },
  }

  try {
    const statements = existing
      ? updateStatements(env.DB, existing, result, publicConfig, preparedCredential, command.actorId)
      : insertStatements(env.DB, result, publicConfig, preparedCredential!, command.actorId)
    await env.DB.batch(statements)
  }
  catch {
    throw serviceError('AD_PLATFORM_CONNECTION_WRITE_FAILED')
  }
  return result
}

export async function getPlatformConnection(
  env: Pick<PlatformConnectionServiceEnv, 'DB'>,
  provider: unknown,
): Promise<PlatformConnectionView | null> {
  const definition = getAdPlatformDefinition(provider)
  if (!definition) throw serviceError('AD_PLATFORM_CONNECTION_PROVIDER_INVALID')
  try {
    const snapshot = await readAttributionConnectionSnapshot(env.DB, definition.provider)
    if (snapshot.state === 'connection_invalid') {
      if (snapshot.reason === 'not_found') return null
      throw serviceError('AD_PLATFORM_CONNECTION_STATE_INVALID')
    }
    if (!isRolloutPercentage(snapshot.connection.rolloutTargetPercentage)
      || !isRolloutPercentage(snapshot.connection.rolloutEffectivePercentage)) {
      throw serviceError('AD_PLATFORM_CONNECTION_STATE_INVALID')
    }
    return {
      connectionId: snapshot.connection.id,
      provider: snapshot.connection.provider,
      enabled: snapshot.connection.enabled,
      mode: snapshot.connection.mode,
      browserEnabled: snapshot.connection.browserEnabled,
      serverEnabled: snapshot.connection.serverEnabled,
      publicConfig: { provider: snapshot.connection.provider, ...snapshot.connection.publicConfig } as PlatformPublicConfig,
      eventBindings: CANONICAL_EVENTS.map(canonicalEvent => ({
        canonicalEvent,
        enabled: snapshot.bindings.get(canonicalEvent)!.enabled,
        browserDestination: snapshot.bindings.get(canonicalEvent)!.browserDestination,
        serverDestination: snapshot.bindings.get(canonicalEvent)!.serverDestination,
      })),
      rolloutTargetPercentage: snapshot.connection.rolloutTargetPercentage,
      rolloutEffectivePercentage: snapshot.connection.rolloutEffectivePercentage,
      connectionRevision: snapshot.connection.connectionRevision,
      credential: {
        configured: true,
        type: snapshot.credential.type,
        revision: snapshot.credential.credentialRevision,
      },
    }
  }
  catch (error) {
    if (error instanceof PlatformConnectionError) throw error
    throw serviceError('AD_PLATFORM_CONNECTION_READ_FAILED')
  }
}

export async function listPlatformConnections(
  env: Pick<PlatformConnectionServiceEnv, 'DB'>,
): Promise<PlatformConnectionView[]> {
  const connections: PlatformConnectionView[] = []
  for (const provider of listAdPlatformProviders()) {
    const connection = await getPlatformConnection(env, provider)
    if (connection) connections.push(connection)
  }
  return connections
}

function validateCommonCommand(command: SavePlatformConnectionCommand) {
  if (typeof command.enabled !== 'boolean' || typeof command.browserEnabled !== 'boolean'
    || typeof command.serverEnabled !== 'boolean') {
    throw serviceError('AD_PLATFORM_CONNECTION_STATE_INVALID')
  }
  if (!MODE_VALUES.has(command.mode)) throw serviceError('AD_PLATFORM_CONNECTION_MODE_INVALID')
  if (!isRolloutPercentage(command.rolloutTargetPercentage)) {
    throw serviceError('AD_PLATFORM_CONNECTION_ROLLOUT_INVALID')
  }
  const hasActiveTransport = command.browserEnabled
    || (command.serverEnabled && command.rolloutTargetPercentage > 0)
  if (command.enabled && command.mode === 'production' && !hasActiveTransport) {
    throw serviceError('AD_PLATFORM_CONNECTION_STATE_INVALID')
  }
  if (!Number.isSafeInteger(command.actorId) || command.actorId <= 0) {
    throw serviceError('AD_PLATFORM_CONNECTION_ACTOR_INVALID')
  }
}

function validatePublicConfig(
  provider: AdAttributionProvider,
  value: PlatformPublicConfig,
  schema: { parse(value: unknown): Record<string, string> | null },
) {
  if (!isPlainRecord(value) || value.provider !== provider) {
    throw serviceError('AD_PLATFORM_CONNECTION_CONFIG_INVALID')
  }
  const { provider: _provider, ...config } = value
  const parsed = schema.parse(config)
  if (!parsed) throw serviceError('AD_PLATFORM_CONNECTION_CONFIG_INVALID')
  return parsed
}

function validateEventBindings(
  value: PlatformEventBindingInput[],
  publicConfig: Record<string, string>,
  definition: NonNullable<ReturnType<typeof getAdPlatformDefinition>>,
): ValidatedBinding[] {
  if (!Array.isArray(value) || value.length !== CANONICAL_EVENTS.length) {
    throw serviceError('AD_PLATFORM_CONNECTION_BINDINGS_INVALID')
  }
  const bindings = new Map<CanonicalConversionEvent, ValidatedBinding>()
  for (const input of value) {
    if (!isPlainRecord(input) || !hasOnlyFields(input, BINDING_FIELDS)
      || !CANONICAL_EVENTS.includes(input.canonicalEvent as CanonicalConversionEvent)
      || typeof input.enabled !== 'boolean' || bindings.has(input.canonicalEvent as CanonicalConversionEvent)) {
      throw serviceError('AD_PLATFORM_CONNECTION_BINDINGS_INVALID')
    }
    const canonicalEvent = input.canonicalEvent as CanonicalConversionEvent
    const destinations = definition.resolveEventBinding({
      canonicalEvent,
      publicConfig,
      browserDestination: input.browserDestination,
      serverDestination: input.serverDestination,
    })
    if (!destinations) throw serviceError('AD_PLATFORM_CONNECTION_BINDINGS_INVALID')
    bindings.set(canonicalEvent, { canonicalEvent, enabled: input.enabled, ...destinations })
  }
  if (!CANONICAL_EVENTS.every(event => bindings.has(event))) {
    throw serviceError('AD_PLATFORM_CONNECTION_BINDINGS_INVALID')
  }
  const ordered = CANONICAL_EVENTS.map(event => bindings.get(event)!)
  if (!definition.validateEventBindingSet(ordered)) {
    throw serviceError('AD_PLATFORM_CONNECTION_BINDINGS_INVALID')
  }
  return ordered
}

async function readExistingState(
  db: D1Database,
  connectionId: string,
  provider: AdAttributionProvider,
): Promise<ExistingState | null> {
  try {
    const rows = await db.prepare(`
      SELECT id, provider, enabled, mode, browser_enabled, server_enabled,
        rollout_target_percentage, rollout_effective_percentage,
        connection_revision, credential_revision
      FROM attribution_platform_connections
      WHERE id = ? OR provider = ?
    `).bind(connectionId, provider).all<ExistingConnectionRow>()
    if (rows.results.length === 0) return null
    if (rows.results.length !== 1 || rows.results[0]!.id !== connectionId || rows.results[0]!.provider !== provider) {
      throw serviceError('AD_PLATFORM_CONNECTION_STATE_INVALID')
    }
    const credentials = await db.prepare(`
      SELECT id, provider, credential_type, credential_revision
      FROM attribution_credentials
      WHERE connection_id = ?
      ORDER BY id
    `).bind(connectionId).all<ExistingCredentialRow>()
    return { connection: rows.results[0]!, credentials: credentials.results }
  }
  catch (error) {
    if (error instanceof PlatformConnectionError) throw error
    throw serviceError('AD_PLATFORM_CONNECTION_READ_FAILED')
  }
}

function hasReusableCredential(
  existing: ExistingState | null,
  credentialType: 'access_token' | 'service_account_json',
) {
  if (!existing || existing.credentials.length !== 1) return false
  const credential = existing.credentials[0]!
  return credential.provider === existing.connection.provider
    && credential.credential_type === credentialType
    && credential.credential_revision === existing.connection.credential_revision
}

async function prepareCredential(
  env: PlatformConnectionServiceEnv,
  input: Parameters<typeof prepareAttributionCredential>[1],
) {
  try {
    return await prepareAttributionCredential(env, input)
  }
  catch (error) {
    if (error instanceof CredentialVaultError
      && error.code === 'ATTRIBUTION_CREDENTIAL_INPUT_INVALID') {
      throw serviceError('AD_PLATFORM_CONNECTION_CREDENTIAL_INVALID')
    }
    throw serviceError('AD_PLATFORM_CONNECTION_CREDENTIAL_CRYPTO_UNAVAILABLE')
  }
}

function insertStatements(
  db: D1Database,
  result: PlatformConnectionView,
  publicConfig: Record<string, string>,
  credential: PreparedAttributionCredential,
  actorId: number,
) {
  return [
    db.prepare(`
      INSERT INTO attribution_platform_connections (
        id, provider, enabled, mode, browser_enabled, server_enabled,
        public_config_json, attribution_window_days, rollout_target_percentage,
        rollout_effective_percentage, connection_revision, credential_revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 30, ?, 0, ?, ?, datetime('now'))
    `).bind(
      result.connectionId,
      result.provider,
      flag(result.enabled),
      result.mode,
      flag(result.browserEnabled),
      flag(result.serverEnabled),
      JSON.stringify(publicConfig),
      result.rolloutTargetPercentage,
      result.connectionRevision,
      result.credential.revision,
    ),
    insertCredentialStatement(db, credential),
    ...replaceBindingStatements(db, result),
    auditStatement(db, null, result, actorId, true),
  ]
}

function updateStatements(
  db: D1Database,
  existing: ExistingState,
  result: PlatformConnectionView,
  publicConfig: Record<string, string>,
  credential: PreparedAttributionCredential | null,
  actorId: number,
) {
  const statements: D1PreparedStatement[] = [db.prepare(`
    UPDATE attribution_platform_connections
    SET enabled = CASE WHEN provider = ? AND connection_revision = ? THEN ? ELSE NULL END,
      mode = ?, browser_enabled = ?, server_enabled = ?, public_config_json = ?,
      rollout_target_percentage = ?, rollout_effective_percentage = 0,
      connection_revision = ?, credential_revision = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    result.provider,
    existing.connection.connection_revision,
    flag(result.enabled),
    result.mode,
    flag(result.browserEnabled),
    flag(result.serverEnabled),
    JSON.stringify(publicConfig),
    result.rolloutTargetPercentage,
    result.connectionRevision,
    result.credential.revision,
    result.connectionId,
  ), invalidateVerificationsStatement(db, result.connectionId)]
  if (credential) {
    statements.push(
      db.prepare(`DELETE FROM attribution_credentials WHERE connection_id = ?`).bind(result.connectionId),
      insertCredentialStatement(db, credential),
    )
  }
  else {
    statements.push(db.prepare(`
      UPDATE attribution_credentials SET updated_at = updated_at
      WHERE connection_id = ? AND provider = ? AND credential_type = ? AND credential_revision = ?
    `).bind(result.connectionId, result.provider, result.credential.type, result.credential.revision))
  }
  statements.push(
    ...replaceBindingStatements(db, result),
    auditStatement(db, existing.connection, result, actorId, credential !== null),
  )
  return statements
}

function replaceBindingStatements(db: D1Database, result: PlatformConnectionView) {
  return [
    db.prepare(`DELETE FROM attribution_event_bindings WHERE connection_id = ?`).bind(result.connectionId),
    ...result.eventBindings.map(binding => db.prepare(`
      INSERT INTO attribution_event_bindings (
        id, connection_id, provider, canonical_event, enabled,
        browser_destination, server_destination, mapping_revision, config_json, updated_at
      ) VALUES (
        ?,
        (SELECT connection.id FROM attribution_platform_connections AS connection
          JOIN attribution_credentials AS credential
            ON credential.connection_id = connection.id AND credential.provider = connection.provider
          WHERE connection.id = ? AND connection.provider = ?
            AND connection.connection_revision = ? AND connection.credential_revision = ?
            AND credential.credential_type = ? AND credential.credential_revision = ?
          LIMIT 1),
        ?, ?, ?, ?, ?, ?, '{}', datetime('now')
      )
    `).bind(
      bindingId(result.provider, binding.canonicalEvent),
      result.connectionId,
      result.provider,
      result.connectionRevision,
      result.credential.revision,
      result.credential.type,
      result.credential.revision,
      result.provider,
      binding.canonicalEvent,
      flag(binding.enabled),
      binding.browserDestination,
      binding.serverDestination,
      result.connectionRevision,
    )),
  ]
}

function insertCredentialStatement(db: D1Database, credential: PreparedAttributionCredential) {
  return db.prepare(`
    INSERT INTO attribution_credentials (
      id, connection_id, provider, credential_type, schema_version, key_id,
      iv, ciphertext, tag, fingerprint, credential_revision, created_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    credential.id,
    credential.connectionId,
    credential.provider,
    credential.credentialType,
    credential.schemaVersion,
    credential.keyId,
    credential.iv,
    credential.ciphertext,
    credential.tag,
    credential.fingerprint,
    credential.credentialRevision,
    credential.createdBy,
  )
}

function invalidateVerificationsStatement(db: D1Database, connectionId: string) {
  return db.prepare(`
    UPDATE attribution_verifications
    SET status = 'invalidated',
      evidence_json = CASE
        WHEN status IN ('queued', 'running', 'awaiting_human_evidence')
          THEN '{"schemaVersion":1,"failureCode":"AD_PLATFORM_VERIFICATION_REVISION_INVALID"}'
        ELSE evidence_json
      END,
      completed_at = COALESCE(completed_at, datetime('now')),
      updated_at = datetime('now')
    WHERE connection_id = ?
      AND status IN ('queued', 'running', 'awaiting_human_evidence', 'verified')
  `).bind(connectionId)
}

function auditStatement(
  db: D1Database,
  before: ExistingConnectionRow | null,
  result: PlatformConnectionView,
  actorId: number,
  credentialRotated: boolean,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    ) VALUES (?, ?, 'save_attribution_platform_connection', 'attribution_platform_connection', ?, ?, ?)
  `).bind(
    `audit_${createRevision()}`,
    actorId,
    result.connectionId,
    before ? JSON.stringify({
      enabled: before.enabled === 1,
      mode: before.mode,
      browserEnabled: before.browser_enabled === 1,
      serverEnabled: before.server_enabled === 1,
      rolloutTargetPercentage: before.rollout_target_percentage,
      rolloutEffectivePercentage: before.rollout_effective_percentage,
      connectionRevision: before.connection_revision,
    }) : null,
    JSON.stringify({
      provider: result.provider,
      enabled: result.enabled,
      mode: result.mode,
      browserEnabled: result.browserEnabled,
      serverEnabled: result.serverEnabled,
      rolloutTargetPercentage: result.rolloutTargetPercentage,
      rolloutEffectivePercentage: result.rolloutEffectivePercentage,
      connectionRevision: result.connectionRevision,
      boundEvents: result.eventBindings.map(binding => binding.canonicalEvent),
      credentialRotated,
    }),
  )
}

function isRolloutPercentage(value: unknown): value is 0 | 10 | 50 | 100 {
  return typeof value === 'number' && ROLLOUT_PERCENTAGES.has(value)
}

function bindingId(provider: AdAttributionProvider, event: CanonicalConversionEvent) {
  return `binding_${provider}_${event === 'Contact' ? 'contact' : 'registration'}`
}

function createRevision() {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(REVISION_BYTES))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  catch {
    throw serviceError('AD_PLATFORM_CONNECTION_WRITE_FAILED')
  }
}

function flag(value: boolean) {
  return value ? 1 : 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyFields(value: object, fields: Set<string>) {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.has(key))
}

function serviceError(code: PlatformConnectionErrorCode) {
  return new PlatformConnectionError(code)
}
