import {
  ATTRIBUTION_CONTEXT_COOKIE_NAME,
  type AttributionProvider,
} from '@meigallery/shared'
import type { AttributionRouteCandidate } from '../domain/routing'
import { AttributionDomainError } from '../domain/errors'
import {
  openAttributionData,
  sealAttributionData,
  type AttributionDataEnvelope,
  type AttributionEncryptionKeys,
} from '../security/data-envelope'
import { sha256Hex } from '../security/digest'
import {
  signAttributionToken,
  verifyAttributionToken,
  type AttributionSigningKeys,
} from '../security/signed-token'
import type { AttributionPrivacyDecision } from './privacy-policy'

export interface AttributionContextEnvironment {
  db: D1Database
  signingKeys: AttributionSigningKeys
  encryptionKeys: AttributionEncryptionKeys
  cookieDomain?: string
  nowSeconds?: () => number
  idFactory?: (prefix: string) => string
}

export interface AttributionContextIdentifiers {
  fbclid?: string
  ttclid?: string
  gclid?: string
  gbraid?: string
  wbraid?: string
}

export interface IssueAttributionContextInput {
  privacyDecision: AttributionPrivacyDecision
  route: AttributionRouteCandidate
  sourceId: string | null
  identifiers: AttributionContextIdentifiers
  idempotencyKey: string
}

export interface ResolvedAttributionContext extends AttributionRouteCandidate {
  contextId: string
  issuedVersionId: string
  sourceId: string | null
  identifiers: AttributionContextIdentifiers
  issuedAt: number
  expiresAt: number
}

interface ContextPayload {
  schemaVersion: 1
  contextId: string
  connectionId: string
  versionId: string
  provider: AttributionProvider
  issuedAt: number
  expiresAt: number
}

interface EligibleConnectionRow {
  provider: string
  connection_id: string
  version_id: string
}

interface ContextRow {
  provider: string
  connection_id: string
  source_id: string | null
  identifiers_envelope_json: string
  issued_at: number
  expires_at: number
}

interface CommandReceiptRow {
  command_type: string
  request_hash: string
  result_json: string
}

const CONTEXT_PURPOSE = 'context'
const CONTEXT_IDENTIFIERS_PURPOSE = 'context-identifiers'
const CONTEXT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const IDENTIFIER_KEYS = [
  'fbclid',
  'ttclid',
  'gclid',
  'gbraid',
  'wbraid',
] as const
const PROVIDER_IDENTIFIER_KEYS: Readonly<
  Record<AttributionProvider, readonly (keyof AttributionContextIdentifiers)[]>
> = {
  meta: ['fbclid'],
  tiktok: ['ttclid'],
  google: ['gclid', 'gbraid', 'wbraid'],
}
export async function issueAttributionContextResponse(
  environment: AttributionContextEnvironment,
  input: IssueAttributionContextInput,
): Promise<Response> {
  if (input.privacyDecision.state !== 'granted') {
    throw new AttributionDomainError('ATTRIBUTION_CONTEXT_NOT_GRANTED')
  }
  validateRoute(input.route)
  validateIdentifier(input.idempotencyKey)
  const now = validNowSeconds(environment.nowSeconds ?? unixNow)
  const identifiers = normalizeIdentifiers(
    input.route.provider,
    input.identifiers,
  )
  const requestHash = await hashContextRequest({
    privacyDecision: {
      state: input.privacyDecision.state,
      reason: input.privacyDecision.reason,
    },
    route: {
      provider: input.route.provider,
      connectionId: input.route.connectionId,
    },
    sourceId: input.sourceId,
    identifiers,
  })
  const existing = await readContextReceipt(
    environment.db,
    input.idempotencyKey,
    requestHash,
  )
  if (existing) return contextResponse(environment, existing, now)

  const connection = await requireEligibleConnection(
    environment.db,
    input.route,
  )
  await validateSource(
    environment.db,
    input.sourceId,
    connection,
    now,
  )

  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const contextId = idFactory('context')
  validateIdentifier(contextId)
  const expiresAt = now + CONTEXT_MAX_AGE_SECONDS
  if (!Number.isSafeInteger(expiresAt)) throw contextInvalid()
  const payload: ContextPayload = {
    schemaVersion: 1,
    contextId,
    connectionId: connection.connectionId,
    versionId: connection.versionId,
    provider: connection.provider,
    issuedAt: now,
    expiresAt,
  }
  const encryptedIdentifiers = await sealAttributionData(
    environment.encryptionKeys,
    {
      purpose: CONTEXT_IDENTIFIERS_PURPOSE,
      identity: contextEnvelopeIdentity(payload),
      plaintext: JSON.stringify(identifiers),
    },
  )

  try {
    const results = await environment.db.batch([
      environment.db.prepare(`
        INSERT INTO attribution_contexts (
          id, provider, connection_id, source_id,
          identifiers_envelope_json, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        contextId,
        connection.provider,
        connection.connectionId,
        input.sourceId,
        JSON.stringify(encryptedIdentifiers),
        now,
        expiresAt,
      ),
      environment.db.prepare(`
        INSERT INTO attribution_command_receipts (
          idempotency_key, command_type, request_hash,
          result_json, created_at
        ) VALUES (?, 'issue_attribution_context', ?, ?, ?)
      `).bind(
        input.idempotencyKey,
        requestHash,
        JSON.stringify(payload),
        new Date(now * 1_000).toISOString(),
      ),
    ])
    if (
      Number(results[0]?.meta.changes ?? 0) !== 1
      || Number(results[1]?.meta.changes ?? 0) !== 1
    ) {
      throw contextInvalid()
    }
  } catch {
    const raced = await readContextReceipt(
      environment.db,
      input.idempotencyKey,
      requestHash,
    )
    if (raced) return contextResponse(environment, raced, now)
    throw contextInvalid()
  }
  return contextResponse(environment, payload, now)
}

async function contextResponse(
  environment: AttributionContextEnvironment,
  payload: ContextPayload,
  now: number,
): Promise<Response> {
  if (now < payload.issuedAt || now >= payload.expiresAt) {
    throw contextInvalid()
  }
  let token: string
  try {
    token = await signAttributionToken(
      environment.signingKeys.current,
      CONTEXT_PURPOSE,
      { ...payload },
    )
  } catch {
    throw contextInvalid()
  }
  return new Response(JSON.stringify({
    data: {
      issued: true,
      expiresAt: payload.expiresAt,
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': contextCookie(
        token,
        Math.min(
          CONTEXT_MAX_AGE_SECONDS,
          Math.max(0, payload.expiresAt - now),
        ),
        environment.cookieDomain,
      ),
    },
  })
}

export async function resolveAttributionContext(
  environment: AttributionContextEnvironment,
  token: string,
): Promise<ResolvedAttributionContext> {
  const parsed = await verifyAttributionToken(
    environment.signingKeys,
    CONTEXT_PURPOSE,
    token,
  )
  const payload = contextPayload(parsed)
  const now = validNowSeconds(environment.nowSeconds ?? unixNow)
  if (now >= payload.expiresAt) throw contextInvalid()

  const row = await environment.db.prepare(`
    SELECT
      context.provider,
      context.connection_id,
      context.source_id,
      context.identifiers_envelope_json,
      context.issued_at,
      context.expires_at
    FROM attribution_contexts AS context
    INNER JOIN attribution_connections AS connection
      ON connection.id = context.connection_id
     AND connection.provider = context.provider
    INNER JOIN attribution_connection_versions AS active_version
      ON active_version.id = connection.active_version_id
     AND active_version.connection_id = connection.id
     AND active_version.provider = connection.provider
     AND active_version.status = 'active'
    INNER JOIN attribution_connection_versions AS issued_version
      ON issued_version.id = ?
     AND issued_version.connection_id = connection.id
     AND issued_version.provider = connection.provider
     AND issued_version.status IN ('active','draining','retired')
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
     AND policy.enabled = 1
     AND (policy.browser_enabled = 1 OR policy.server_enabled = 1)
    WHERE context.id = ?
      AND context.provider = ?
      AND context.connection_id = ?
      AND context.issued_at = ?
      AND context.expires_at = ?
      AND context.expires_at > ?
      AND (
        context.source_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM attribution_managed_sources AS source
          WHERE source.id = context.source_id
            AND source.provider = context.provider
            AND source.connection_id = context.connection_id
            AND source.enabled = 1
        )
      )
    LIMIT 1
  `).bind(
    payload.versionId,
    payload.contextId,
    payload.provider,
    payload.connectionId,
    payload.issuedAt,
    payload.expiresAt,
    now,
  ).first<ContextRow>()

  if (
    !row
    || row.provider !== payload.provider
    || row.connection_id !== payload.connectionId
    || Number(row.issued_at) !== payload.issuedAt
    || Number(row.expires_at) !== payload.expiresAt
  ) {
    throw contextInvalid()
  }

  let identifiers: AttributionContextIdentifiers
  try {
    const envelope = JSON.parse(
      row.identifiers_envelope_json,
    ) as AttributionDataEnvelope
    const plaintext = await openAttributionData(
      environment.encryptionKeys,
      {
        purpose: CONTEXT_IDENTIFIERS_PURPOSE,
        identity: contextEnvelopeIdentity(payload),
        envelope,
      },
    )
    identifiers = normalizeIdentifiers(
      payload.provider,
      JSON.parse(plaintext),
    )
  } catch {
    throw contextInvalid()
  }
  return {
    contextId: payload.contextId,
    provider: payload.provider,
    connectionId: payload.connectionId,
    // 仅用于证明上下文签发快照，运行租约必须重新锁定当前 Active。
    issuedVersionId: payload.versionId,
    sourceId: row.source_id,
    identifiers,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  }
}

async function requireEligibleConnection(
  db: D1Database,
  route: AttributionRouteCandidate,
): Promise<{
  provider: AttributionProvider
  connectionId: string
  versionId: string
}> {
  const row = await db.prepare(`
    SELECT
      connection.provider,
      connection.id AS connection_id,
      version.id AS version_id
    FROM attribution_connections AS connection
    INNER JOIN attribution_connection_versions AS version
      ON version.id = connection.active_version_id
     AND version.connection_id = connection.id
     AND version.provider = connection.provider
     AND version.status = 'active'
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
     AND policy.enabled = 1
     AND (policy.browser_enabled = 1 OR policy.server_enabled = 1)
    WHERE connection.id = ?
      AND connection.provider = ?
    LIMIT 1
  `).bind(route.connectionId, route.provider).first<EligibleConnectionRow>()
  if (
    !row
    || !PROVIDERS.has(row.provider as AttributionProvider)
    || !isIdentifier(row.connection_id)
    || !isIdentifier(row.version_id)
  ) {
    throw contextInvalid()
  }
  return {
    provider: row.provider as AttributionProvider,
    connectionId: row.connection_id,
    versionId: row.version_id,
  }
}

async function validateSource(
  db: D1Database,
  sourceId: string | null,
  connection: {
    provider: AttributionProvider
    connectionId: string
  },
  now: number,
): Promise<void> {
  if (sourceId === null) return
  validateIdentifier(sourceId)
  const row = await db.prepare(`
    SELECT id
    FROM attribution_managed_sources
    WHERE id = ?
      AND provider = ?
      AND connection_id = ?
      AND enabled = 1
      AND (
        expires_at IS NULL
        OR julianday(expires_at) > julianday(?)
      )
    LIMIT 1
  `).bind(
    sourceId,
    connection.provider,
    connection.connectionId,
    new Date(now * 1_000).toISOString(),
  ).first<{ id: string }>()
  if (row?.id !== sourceId) throw contextInvalid()
}

function contextPayload(
  value: Record<string, unknown> | null,
): ContextPayload {
  if (
    !value
    || value.schemaVersion !== 1
    || !isIdentifier(value.contextId)
    || !isIdentifier(value.connectionId)
    || !isIdentifier(value.versionId)
    || !PROVIDERS.has(value.provider as AttributionProvider)
    || !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || Number(value.issuedAt) < 1
    || Number(value.expiresAt) <= Number(value.issuedAt)
    || Number(value.expiresAt) - Number(value.issuedAt)
      !== CONTEXT_MAX_AGE_SECONDS
  ) {
    throw contextInvalid()
  }
  return {
    schemaVersion: 1,
    contextId: value.contextId,
    connectionId: value.connectionId,
    versionId: value.versionId,
    provider: value.provider as AttributionProvider,
    issuedAt: Number(value.issuedAt),
    expiresAt: Number(value.expiresAt),
  }
}

function normalizeIdentifiers(
  provider: AttributionProvider,
  value: unknown,
): AttributionContextIdentifiers {
  if (!isPlainRecord(value)) throw contextInvalid()
  const unknownKeys = Object.keys(value).filter(
    key => !IDENTIFIER_KEYS.includes(
      key as typeof IDENTIFIER_KEYS[number],
    ),
  )
  if (unknownKeys.length > 0) throw contextInvalid()

  const result: AttributionContextIdentifiers = {}
  for (const key of PROVIDER_IDENTIFIER_KEYS[provider]) {
    const identifier = value[key]
    if (identifier === undefined) continue
    if (
      typeof identifier !== 'string'
      || identifier.length === 0
      || identifier.length > 1024
    ) {
      throw contextInvalid()
    }
    result[key] = identifier
  }
  return result
}

async function readContextReceipt(
  db: D1Database,
  idempotencyKey: string,
  requestHash: string,
): Promise<ContextPayload | null> {
  const row = await db.prepare(`
    SELECT command_type, request_hash, result_json
    FROM attribution_command_receipts
    WHERE idempotency_key = ?
  `).bind(idempotencyKey).first<CommandReceiptRow>()
  if (!row) return null
  if (
    row.command_type !== 'issue_attribution_context'
    || row.request_hash !== requestHash
  ) {
    throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  }
  try {
    return contextPayload(JSON.parse(row.result_json))
  } catch {
    throw contextInvalid()
  }
}

async function hashContextRequest(
  value: Record<string, unknown>,
): Promise<string> {
  return sha256Hex(JSON.stringify(value))
}

function contextEnvelopeIdentity(payload: ContextPayload): string {
  return [
    payload.contextId,
    payload.provider,
    payload.connectionId,
    payload.versionId,
  ].join(':')
}

function contextCookie(
  token: string,
  maxAge: number,
  configuredDomain: string | undefined,
): string {
  const attributes = [
    `${ATTRIBUTION_CONTEXT_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ]
  const domain = normalizeCookieDomain(configuredDomain)
  if (domain) attributes.push(`Domain=${domain}`)
  return attributes.join('; ')
}

function normalizeCookieDomain(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  if (
    value.length > 253
    || !/^\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
      value,
    )
  ) {
    throw contextInvalid()
  }
  return value.toLowerCase()
}

function validateRoute(route: AttributionRouteCandidate): void {
  if (
    !route
    || !PROVIDERS.has(route.provider)
    || !isIdentifier(route.connectionId)
  ) {
    throw contextInvalid()
  }
}

function validateIdentifier(value: unknown): asserts value is string {
  if (!isIdentifier(value)) throw contextInvalid()
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function validNowSeconds(now: () => number): number {
  const value = now()
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || !Number.isFinite(new Date(value * 1_000).getTime())
  ) {
    throw contextInvalid()
  }
  return value
}

function unixNow(): number {
  return Math.floor(Date.now() / 1_000)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function contextInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_CONTEXT_INVALID')
}
