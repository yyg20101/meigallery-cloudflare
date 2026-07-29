import type {
  AdAttributionProvider,
  CanonicalConversionEvent,
  PlatformPublicConfig,
} from '@meigallery/shared'
import {
  CANONICAL_CONVERSION_EVENTS,
  isCanonicalConversionEvent,
} from '@meigallery/shared/constants'
import {
  CredentialVaultError,
  prepareAttributionCredential,
  type CredentialVaultEnv,
  type PreparedAttributionCredential,
} from './credential-vault'
import { readAttributionConnectionSnapshot } from './connections'
import { getAdPlatformDefinition, listAdPlatformProviders } from './registry'

const OPAQUE_ID_BYTES = 12
const BINDING_FIELDS = new Set(['canonicalEvent', 'enabled', 'browserDestination', 'serverDestination'])
const BINDING_ID_SUFFIX: Record<CanonicalConversionEvent, string> = {
  Contact: 'contact',
  CompleteRegistration: 'registration',
}

export interface PlatformEventBindingInput {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination?: string
  serverDestination?: string
}

export interface SavePlatformConnectionCommand {
  provider: AdAttributionProvider
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  publicConfig: PlatformPublicConfig
  eventBindings: PlatformEventBindingInput[]
  credential?: { type: 'access_token' | 'service_account_json'; plaintext: string }
  actorId: number
}

export interface PlatformConnectionView {
  connectionId: string
  provider: AdAttributionProvider
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  publicConfig: PlatformPublicConfig
  eventBindings: Array<Required<PlatformEventBindingInput>>
  credential: {
    configured: true
    type: 'access_token' | 'service_account_json'
  }
}

type PersistedPlatformConnection = Omit<PlatformConnectionView, 'credential'> & {
  outboxScope: string
  credential: PlatformConnectionView['credential'] & { encryptionContext: string }
}

export type PlatformConnectionServiceEnv = CredentialVaultEnv

export type PlatformConnectionErrorCode =
  | 'AD_PLATFORM_CONNECTION_PROVIDER_INVALID'
  | 'AD_PLATFORM_CONNECTION_CONFIG_INVALID'
  | 'AD_PLATFORM_CONNECTION_BINDINGS_INVALID'
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
  browser_enabled: number
  server_enabled: number
  outbox_scope: string
}

type ExistingCredentialRow = {
  id: string
  credential_type: string
  encryption_context: string
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
  const outboxScope = existing?.connection.outbox_scope ?? createOpaqueId()
  const encryptionContext = command.credential
    ? createOpaqueId()
    : existing?.credentials[0]?.encryption_context

  if (!encryptionContext) throw serviceError('AD_PLATFORM_CONNECTION_CREDENTIAL_REQUIRED')
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
      encryptionContext,
      createdBy: command.actorId,
    })
  }

  const result: PersistedPlatformConnection = {
    connectionId,
    provider: definition.provider,
    enabled: command.enabled,
    browserEnabled: command.browserEnabled,
    serverEnabled: command.serverEnabled,
    publicConfig: { provider: definition.provider, ...publicConfig } as PlatformPublicConfig,
    eventBindings,
    outboxScope,
    credential: {
      configured: true,
      type: definition.credentialSchema.type,
      encryptionContext,
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
  return publicConnectionView(result)
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
    return {
      connectionId: snapshot.connection.id,
      provider: snapshot.connection.provider,
      enabled: snapshot.connection.enabled,
      browserEnabled: snapshot.connection.browserEnabled,
      serverEnabled: snapshot.connection.serverEnabled,
      publicConfig: { provider: snapshot.connection.provider, ...snapshot.connection.publicConfig } as PlatformPublicConfig,
      eventBindings: CANONICAL_CONVERSION_EVENTS.map(canonicalEvent => ({
        canonicalEvent,
        enabled: snapshot.bindings.get(canonicalEvent)!.enabled,
        browserDestination: snapshot.bindings.get(canonicalEvent)!.browserDestination,
        serverDestination: snapshot.bindings.get(canonicalEvent)!.serverDestination,
      })),
      credential: {
        configured: true,
        type: snapshot.credential.type,
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
  const hasActiveTransport = command.browserEnabled || command.serverEnabled
  if (command.enabled && !hasActiveTransport) {
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
  if (!Array.isArray(value) || value.length !== CANONICAL_CONVERSION_EVENTS.length) {
    throw serviceError('AD_PLATFORM_CONNECTION_BINDINGS_INVALID')
  }
  const bindings = new Map<CanonicalConversionEvent, ValidatedBinding>()
  for (const input of value) {
    if (!isPlainRecord(input) || !hasOnlyFields(input, BINDING_FIELDS)
      || !isCanonicalConversionEvent(input.canonicalEvent)
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
  if (!CANONICAL_CONVERSION_EVENTS.every(event => bindings.has(event))) {
    throw serviceError('AD_PLATFORM_CONNECTION_BINDINGS_INVALID')
  }
  const ordered = CANONICAL_CONVERSION_EVENTS.map(event => bindings.get(event)!)
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
      SELECT id, provider, enabled, browser_enabled, server_enabled,
        outbox_scope
      FROM attribution_platform_connections
      WHERE id = ? OR provider = ?
    `).bind(connectionId, provider).all<ExistingConnectionRow>()
    if (rows.results.length === 0) return null
    if (rows.results.length !== 1 || rows.results[0]!.id !== connectionId || rows.results[0]!.provider !== provider) {
      throw serviceError('AD_PLATFORM_CONNECTION_STATE_INVALID')
    }
    const credentials = await db.prepare(`
      SELECT id, credential_type, encryption_context
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
  return credential.credential_type === credentialType
    && Boolean(credential.encryption_context)
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
  result: PersistedPlatformConnection,
  publicConfig: Record<string, string>,
  credential: PreparedAttributionCredential,
  actorId: number,
) {
  return [
    db.prepare(`
      INSERT INTO attribution_platform_connections (
        id, provider, enabled, browser_enabled, server_enabled,
        public_config_json, outbox_scope, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      result.connectionId,
      result.provider,
      flag(result.enabled),
      flag(result.browserEnabled),
      flag(result.serverEnabled),
      JSON.stringify(publicConfig),
      result.outboxScope,
    ),
    insertCredentialStatement(db, credential),
    ...replaceBindingStatements(db, result),
    auditStatement(db, null, result, actorId, true),
  ]
}

function updateStatements(
  db: D1Database,
  existing: ExistingState,
  result: PersistedPlatformConnection,
  publicConfig: Record<string, string>,
  credential: PreparedAttributionCredential | null,
  actorId: number,
) {
  const statements: D1PreparedStatement[] = [
    db.prepare(`
    UPDATE attribution_platform_connections
    SET enabled = ?, browser_enabled = ?, server_enabled = ?, public_config_json = ?,
      updated_at = datetime('now')
    WHERE id = ? AND provider = ?
  `).bind(
    flag(result.enabled),
    flag(result.browserEnabled),
    flag(result.serverEnabled),
    JSON.stringify(publicConfig),
    result.connectionId,
    result.provider,
  )]
  if (credential) {
    statements.push(
      db.prepare(`DELETE FROM attribution_credentials WHERE connection_id = ?`).bind(result.connectionId),
      insertCredentialStatement(db, credential),
    )
  }
  else {
    statements.push(db.prepare(`
      UPDATE attribution_credentials SET updated_at = updated_at
      WHERE connection_id = ? AND credential_type = ? AND encryption_context = ?
    `).bind(result.connectionId, result.credential.type, result.credential.encryptionContext))
  }
  statements.push(
    ...replaceBindingStatements(db, result),
    auditStatement(db, existing.connection, result, actorId, credential !== null),
  )
  return statements
}

function replaceBindingStatements(db: D1Database, result: PersistedPlatformConnection) {
  return [
    db.prepare(`DELETE FROM attribution_event_bindings WHERE connection_id = ?`).bind(result.connectionId),
    ...result.eventBindings.map(binding => db.prepare(`
      INSERT INTO attribution_event_bindings (
        id, connection_id, canonical_event, enabled,
        browser_destination, server_destination, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      bindingId(result.provider, binding.canonicalEvent),
      result.connectionId,
      binding.canonicalEvent,
      flag(binding.enabled),
      binding.browserDestination,
      binding.serverDestination,
    )),
  ]
}

function insertCredentialStatement(db: D1Database, credential: PreparedAttributionCredential) {
  return db.prepare(`
    INSERT INTO attribution_credentials (
      id, connection_id, credential_type, schema_version, key_id,
      iv, ciphertext, tag, fingerprint, encryption_context, created_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    credential.id,
    credential.connectionId,
    credential.credentialType,
    credential.schemaVersion,
    credential.keyId,
    credential.iv,
    credential.ciphertext,
    credential.tag,
    credential.fingerprint,
    credential.encryptionContext,
    credential.createdBy,
  )
}

function auditStatement(
  db: D1Database,
  before: ExistingConnectionRow | null,
  result: PersistedPlatformConnection,
  actorId: number,
  credentialRotated: boolean,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    ) VALUES (?, ?, 'save_attribution_platform_connection', 'attribution_platform_connection', ?, ?, ?)
  `).bind(
    `audit_${createOpaqueId()}`,
    actorId,
    result.connectionId,
    before ? JSON.stringify({
      enabled: before.enabled === 1,
      browserEnabled: before.browser_enabled === 1,
      serverEnabled: before.server_enabled === 1,
    }) : null,
    JSON.stringify({
      provider: result.provider,
      enabled: result.enabled,
      browserEnabled: result.browserEnabled,
      serverEnabled: result.serverEnabled,
      boundEvents: result.eventBindings.map(binding => binding.canonicalEvent),
      credentialRotated,
    }),
  )
}

function publicConnectionView(result: PersistedPlatformConnection): PlatformConnectionView {
  return {
    connectionId: result.connectionId,
    provider: result.provider,
    enabled: result.enabled,
    browserEnabled: result.browserEnabled,
    serverEnabled: result.serverEnabled,
    publicConfig: result.publicConfig,
    eventBindings: result.eventBindings,
    credential: {
      configured: true,
      type: result.credential.type,
    },
  }
}

function bindingId(provider: AdAttributionProvider, event: CanonicalConversionEvent) {
  return `binding_${provider}_${BINDING_ID_SUFFIX[event]}`
}

function createOpaqueId() {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(OPAQUE_ID_BYTES))
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
