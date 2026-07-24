import {
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
  type AttributionProvider,
  type CanonicalConversionEvent,
} from '@meigallery/shared'
import type { AttributionRuntimePolicy } from '../domain/connection'
import { AttributionDomainError } from '../domain/errors'
import {
  sealAttributionData,
  type AttributionDataEnvelope,
  type AttributionEncryptionKeys,
} from '../security/data-envelope'
import { sha256Hex } from '../security/digest'
import {
  encodeBase64Url,
  type AttributionSigningKeys,
} from '../security/signed-token'
import {
  resolveAttributionContext,
  type AttributionContextIdentifiers,
  type ResolvedAttributionContext,
} from './context-service'
import {
  planDeliveries,
  type DeliveryPlanBinding,
  type PlannedDelivery,
} from './delivery-planner'
import {
  issueRuntimeLease,
  verifyDelayedRuntimeEvent,
  verifyRuntimeLease,
  type RuntimeLeasePayload,
} from './runtime-lease'

export interface CanonicalFactEnvironment {
  db: D1Database
  signingKeys: AttributionSigningKeys
  encryptionKeys: AttributionEncryptionKeys
  now?: () => Date
  idFactory?: (prefix: string) => string
}

export interface CanonicalFactOptions {
  runtimeLeaseToken?: string | null
  factOrigin?: 'live' | 'synthetic'
  requestMetadata?: {
    clientIp?: string
    userAgent?: string
  }
}

export interface CanonicalFactDelivery {
  id: string
  provider: AttributionProvider
  connectionId: string
  versionId: string
  transport: 'browser' | 'server'
  destination: string
  externalEventId: string
  status: AttributionDeliveryStatus
}

export type AttributionDeliveryStatus =
  | 'planned'
  | 'queued'
  | 'accepted'
  | 'processed'
  | 'retrying'
  | 'rejected'
  | 'dead_letter'
  | 'cancelled'

export interface CanonicalFactResult {
  factId: string
  externalEventId: string | null
  deliveries: CanonicalFactDelivery[]
}

interface RuntimeSnapshot {
  connectionId: string
  versionId: string
  provider: AttributionProvider
  runtimePolicy: AttributionRuntimePolicy
  binding: DeliveryPlanBinding
}

interface ResolvedFactRoute extends RuntimeSnapshot {
  context: ResolvedAttributionContext
  lease: RuntimeLeasePayload
}

interface FactRow {
  id: string
  event_fingerprint: string
  external_event_id: string | null
}

interface EventIdentityRow {
  event_id: string
}

interface DeliveryRow {
  id: string
  provider: string
  connection_id: string
  version_id: string
  transport: string
  destination: string
  external_event_id: string
  status: string
}

interface RuntimeSnapshotRow {
  connection_id: string
  version_id: string
  provider: string
  enabled: number
  browser_enabled: number
  server_enabled: number
  server_target_percentage: number
  server_effective_percentage: number
  circuit_state: string
  runtime_generation: number
  updated_by: number
  updated_at: string
  binding_enabled: number | null
  browser_destination: string | null
  server_destination: string | null
}

interface PreparedDelivery {
  result: CanonicalFactDelivery
  envelope: AttributionDataEnvelope
}

const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1_000
const OUTBOX_PURPOSE = 'delivery-outbox'
const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const PERCENTAGES = new Set([0, 10, 50, 100])
const DELIVERY_STATUSES = new Set<AttributionDeliveryStatus>([
  'planned',
  'queued',
  'accepted',
  'processed',
  'retrying',
  'rejected',
  'dead_letter',
  'cancelled',
])
const ZERO_DELIVERY_ERRORS = new Set([
  'ATTRIBUTION_CONTEXT_INVALID',
  'ATTRIBUTION_CONTEXT_NOT_GRANTED',
  'ATTRIBUTION_DELAYED_EVENT_INVALID',
  'ATTRIBUTION_RUNTIME_LEASE_EXPIRED',
  'ATTRIBUTION_RUNTIME_LEASE_INVALID',
  'ATTRIBUTION_RUNTIME_LEASE_NOT_GRANTED',
])
const encoder = new TextEncoder()

export async function recordCanonicalFact(
  environment: CanonicalFactEnvironment,
  event: AttributionBusinessEventV1,
  options: CanonicalFactOptions = {},
): Promise<CanonicalFactResult> {
  const now = trustedNow(environment.now)
  const factOrigin = options.factOrigin ?? 'live'
  validateEvent(event, factOrigin, now)
  const eventFingerprint = await fingerprintEvent(event, factOrigin)
  const dedupeHash = await sha256Hex(
    `fact-dedupe:v1:${event.dedupeKey}`,
  )
  const existing = await readFact(
    environment.db,
    dedupeHash,
    eventFingerprint,
  )
  if (existing) return existing
  await ensureEventIdAvailable(environment.db, event.eventId)

  const route = await resolveFactRoute(environment, event, options)
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const factId = createIdentifier(idFactory, 'fact')
  const externalEventId = route
    ? await buildExternalEventId(
        environment.signingKeys.current,
        event,
        route,
      )
    : null
  const plans = route && externalEventId
    ? await planDeliveries({
        factId,
        externalEventId,
        connectionId: route.connectionId,
        versionId: route.versionId,
        provider: route.provider,
        eventName: event.eventName,
        runtimePolicy: route.runtimePolicy,
        binding: route.binding,
      })
    : []
  const deliveries = route && externalEventId
    ? await prepareDeliveries(
        environment,
        event,
        options,
        route,
        factId,
        externalEventId,
        plans,
        idFactory,
      )
    : []

  const statements = [
    environment.db.prepare(`
      INSERT INTO attribution_facts (
        id, event_id, event_name, fact_origin, dedupe_hash,
        event_fingerprint,
        connection_id, version_id, provider, external_event_id,
        occurred_at, consent_json, analytics_dimensions_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      factId,
      event.eventId,
      event.eventName,
      factOrigin,
      dedupeHash,
      eventFingerprint,
      route?.connectionId ?? null,
      route?.versionId ?? null,
      route?.provider ?? null,
      externalEventId,
      event.occurredAt,
      JSON.stringify(event.consent),
      JSON.stringify(analyticsDimensions(event)),
      now.toISOString(),
    ),
    ...deliveries.flatMap(delivery => [
      environment.db.prepare(`
        INSERT INTO attribution_deliveries (
          id, fact_id, connection_id, version_id, provider,
          transport, destination, external_event_id, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
      `).bind(
        delivery.result.id,
        factId,
        delivery.result.connectionId,
        delivery.result.versionId,
        delivery.result.provider,
        delivery.result.transport,
        delivery.result.destination,
        delivery.result.externalEventId,
        now.toISOString(),
        now.toISOString(),
      ),
      environment.db.prepare(`
        INSERT INTO attribution_outbox (
          delivery_id, provider, version_id, schema_version,
          key_id, iv, ciphertext, tag, expires_at, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).bind(
        delivery.result.id,
        delivery.result.provider,
        delivery.result.versionId,
        delivery.envelope.keyId,
        delivery.envelope.iv,
        delivery.envelope.ciphertext,
        delivery.envelope.tag,
        new Date(
          new Date(event.occurredAt).getTime() + MAX_EVENT_AGE_MS,
        ).toISOString(),
        now.toISOString(),
      ),
    ]),
  ]

  try {
    const results = await environment.db.batch(statements)
    if (
      results.length !== statements.length
      || results.some(result => Number(result.meta.changes ?? 0) !== 1)
    ) {
      throw factInvalid()
    }
  } catch (error) {
    const raced = await readFact(
      environment.db,
      dedupeHash,
      eventFingerprint,
    )
    if (raced) return raced
    if (await eventIdExists(environment.db, event.eventId)) {
      throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
    }
    throw error
  }

  return {
    factId,
    externalEventId,
    deliveries: deliveries.map(item => item.result),
  }
}

async function resolveFactRoute(
  environment: CanonicalFactEnvironment,
  event: AttributionBusinessEventV1,
  options: CanonicalFactOptions,
): Promise<ResolvedFactRoute | null> {
  if (
    !event.consent.marketingAllowed
    || event.sourceContextToken === null
  ) {
    return null
  }
  if (
    event.eventName === 'Contact'
    && !options.runtimeLeaseToken
  ) {
    return null
  }

  try {
    const context = await resolveAttributionContext({
      db: environment.db,
      signingKeys: environment.signingKeys,
      encryptionKeys: environment.encryptionKeys,
      nowSeconds: () => Math.floor(
        trustedNow(environment.now).getTime() / 1_000,
      ),
    }, event.sourceContextToken)

    let lease: RuntimeLeasePayload
    if (options.runtimeLeaseToken) {
      lease = await verifyDelayedRuntimeEvent({
        db: environment.db,
        signingKeys: environment.signingKeys,
        now: environment.now,
      }, options.runtimeLeaseToken, {
        occurredAt: event.occurredAt,
      })
    } else {
      const token = await issueRuntimeLease({
        db: environment.db,
        signingKeys: environment.signingKeys,
        now: environment.now,
      }, {
        connectionId: context.connectionId,
        provider: context.provider,
        privacyState: 'granted',
      })
      lease = await verifyRuntimeLease({
        db: environment.db,
        signingKeys: environment.signingKeys,
        now: environment.now,
      }, token)
    }
    if (
      context.connectionId !== lease.connectionId
      || context.provider !== lease.provider
    ) {
      return null
    }
    return {
      ...await readRuntimeSnapshot(environment.db, lease, event.eventName),
      context,
      lease,
    }
  } catch (error) {
    if (
      error instanceof AttributionDomainError
      && ZERO_DELIVERY_ERRORS.has(error.code)
    ) {
      return null
    }
    throw error
  }
}

async function readRuntimeSnapshot(
  db: D1Database,
  lease: RuntimeLeasePayload,
  eventName: CanonicalConversionEvent,
): Promise<RuntimeSnapshot> {
  const row = await db.prepare(`
    SELECT
      connection.id AS connection_id,
      version.id AS version_id,
      connection.provider,
      policy.enabled,
      policy.browser_enabled,
      policy.server_enabled,
      policy.server_target_percentage,
      policy.server_effective_percentage,
      policy.circuit_state,
      policy.runtime_generation,
      policy.updated_by,
      policy.updated_at,
      binding.enabled AS binding_enabled,
      binding.browser_destination,
      binding.server_destination
    FROM attribution_connections AS connection
    INNER JOIN attribution_connection_versions AS version
      ON version.id = ?
     AND version.connection_id = connection.id
     AND version.provider = connection.provider
     AND version.status IN ('active','draining','retired')
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = connection.id
     AND policy.enabled = 1
     AND (policy.browser_enabled = 1 OR policy.server_enabled = 1)
    LEFT JOIN attribution_version_bindings AS binding
      ON binding.version_id = version.id
     AND binding.canonical_event = ?
    WHERE connection.id = ?
      AND connection.provider = ?
    LIMIT 1
  `).bind(
    lease.versionId,
    eventName,
    lease.connectionId,
    lease.provider,
  ).first<RuntimeSnapshotRow>()

  if (
    !row
    || row.connection_id !== lease.connectionId
    || row.version_id !== lease.versionId
    || row.provider !== lease.provider
    || !PROVIDERS.has(row.provider as AttributionProvider)
    || row.enabled !== 1
    || !isBooleanInteger(row.browser_enabled)
    || !isBooleanInteger(row.server_enabled)
    || !PERCENTAGES.has(row.server_target_percentage)
    || !PERCENTAGES.has(row.server_effective_percentage)
    || (
      row.circuit_state !== 'closed'
      && row.circuit_state !== 'server_open'
    )
    || !Number.isSafeInteger(row.runtime_generation)
    || row.runtime_generation < 1
    || !Number.isSafeInteger(row.updated_by)
    || !isCanonicalTimestamp(row.updated_at)
  ) {
    throw factInvalid()
  }

  const provider = row.provider as AttributionProvider
  return {
    connectionId: row.connection_id,
    versionId: row.version_id,
    provider,
    runtimePolicy: {
      enabled: true,
      browserEnabled: row.browser_enabled === 1,
      serverEnabled: row.server_enabled === 1,
      serverTargetPercentage: percentage(row.server_target_percentage),
      serverEffectivePercentage: percentage(
        row.server_effective_percentage,
      ),
      circuitState: row.circuit_state,
      runtimeGeneration: row.runtime_generation,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    },
    binding: {
      enabled: row.binding_enabled === 1,
      browserDestination: validDestination(
        row.browser_destination ?? '',
      ),
      serverDestination: validDestination(
        row.server_destination ?? '',
      ),
    },
  }
}

async function prepareDeliveries(
  environment: CanonicalFactEnvironment,
  event: AttributionBusinessEventV1,
  options: CanonicalFactOptions,
  route: ResolvedFactRoute,
  factId: string,
  externalEventId: string,
  plans: PlannedDelivery[],
  idFactory: (prefix: string) => string,
): Promise<PreparedDelivery[]> {
  const requestMetadata = normalizeRequestMetadata(
    options.requestMetadata,
    event.consent.adUserDataAllowed,
  )
  return Promise.all(plans.map(async plan => {
    if (plan.provider !== route.provider) throw factInvalid()
    const id = createIdentifier(idFactory, 'delivery')
    const result: CanonicalFactDelivery = {
      id,
      provider: route.provider,
      connectionId: route.connectionId,
      versionId: route.versionId,
      transport: plan.transport,
      destination: plan.destination,
      externalEventId,
      status: 'planned',
    }
    const payload = plan.transport === 'browser'
      ? {
          schemaVersion: 1,
          factId,
          deliveryId: id,
          provider: route.provider,
          connectionId: route.connectionId,
          versionId: route.versionId,
          transport: plan.transport,
          destination: plan.destination,
          externalEventId,
          eventName: event.eventName,
          occurredAt: event.occurredAt,
        }
      : {
          schemaVersion: 1,
          factId,
          deliveryId: id,
          provider: route.provider,
          connectionId: route.connectionId,
          versionId: route.versionId,
          transport: plan.transport,
          destination: plan.destination,
          externalEventId,
          eventName: event.eventName,
          occurredAt: event.occurredAt,
          consent: event.consent,
          payload: serverEventPayload(event),
          context: {
            sourceId: route.context.sourceId,
            identifiers: route.context.identifiers,
          },
          requestMetadata,
        }
    const envelope = await sealAttributionData(
      environment.encryptionKeys,
      {
        purpose: OUTBOX_PURPOSE,
        identity: outboxIdentity(result),
        plaintext: JSON.stringify(payload),
      },
    )
    return { result, envelope }
  }))
}

async function readFact(
  db: D1Database,
  dedupeHash: string,
  expectedFingerprint: string,
): Promise<CanonicalFactResult | null> {
  const fact = await db.prepare(`
    SELECT id, event_fingerprint, external_event_id
    FROM attribution_facts
    WHERE dedupe_hash = ?
    LIMIT 1
  `).bind(dedupeHash).first<FactRow>()
  if (!fact) return null
  if (fact.event_fingerprint !== expectedFingerprint) {
    throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  }
  if (
    !isIdentifier(fact.id)
    || (
      fact.external_event_id !== null
      && !isIdentifier(fact.external_event_id)
    )
  ) {
    throw factInvalid()
  }
  const rows = await db.prepare(`
    SELECT
      id, provider, connection_id, version_id,
      transport, destination, external_event_id, status
    FROM attribution_deliveries
    WHERE fact_id = ?
    ORDER BY CASE transport
      WHEN 'browser' THEN 0
      WHEN 'server' THEN 1
      ELSE 2
    END
  `).bind(fact.id).all<DeliveryRow>()
  return {
    factId: fact.id,
    externalEventId: fact.external_event_id,
    deliveries: rows.results.map(parseDeliveryRow),
  }
}

function parseDeliveryRow(row: DeliveryRow): CanonicalFactDelivery {
  if (
    !isIdentifier(row.id)
    || !PROVIDERS.has(row.provider as AttributionProvider)
    || !isIdentifier(row.connection_id)
    || !isIdentifier(row.version_id)
    || (row.transport !== 'browser' && row.transport !== 'server')
    || !isDestination(row.destination)
    || !isIdentifier(row.external_event_id)
    || !DELIVERY_STATUSES.has(row.status as AttributionDeliveryStatus)
  ) {
    throw factInvalid()
  }
  return {
    id: row.id,
    provider: row.provider as AttributionProvider,
    connectionId: row.connection_id,
    versionId: row.version_id,
    transport: row.transport,
    destination: row.destination,
    externalEventId: row.external_event_id,
    status: row.status as AttributionDeliveryStatus,
  }
}

async function ensureEventIdAvailable(
  db: D1Database,
  eventId: string,
): Promise<void> {
  if (await eventIdExists(db, eventId)) {
    throw new AttributionDomainError('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
  }
}

async function eventIdExists(
  db: D1Database,
  eventId: string,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT event_id
    FROM attribution_facts
    WHERE event_id = ?
    LIMIT 1
  `).bind(eventId).first<EventIdentityRow>()
  return row?.event_id === eventId
}

async function fingerprintEvent(
  event: AttributionBusinessEventV1,
  factOrigin: 'live' | 'synthetic',
): Promise<string> {
  return sha256Hex(JSON.stringify({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    eventName: event.eventName,
    occurredAt: event.occurredAt,
    dedupeKey: event.dedupeKey,
    factOrigin,
    consent: event.consent,
    payload: normalizedPayload(event),
  }))
}

async function buildExternalEventId(
  secret: string,
  event: AttributionBusinessEventV1,
  route: Pick<ResolvedFactRoute, 'connectionId' | 'versionId'>,
): Promise<string> {
  if (
    typeof secret !== 'string'
    || encoder.encode(secret).byteLength < 32
    || secret.length > 4096
  ) {
    throw factInvalid()
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode([
      'attribution-external-event:v1',
      event.eventName,
      event.eventId,
      route.connectionId,
      route.versionId,
    ].join(':')),
  )
  return `attr1_${encodeBase64Url(new Uint8Array(digest)).slice(0, 43)}`
}

function analyticsDimensions(
  event: AttributionBusinessEventV1,
): Record<string, string> {
  if (event.eventName === 'Contact') {
    const payload = event.payload as {
      contactPlatform: string
      contactAction: string
    }
    return {
      eventName: event.eventName,
      contactPlatform: payload.contactPlatform,
      contactAction: payload.contactAction,
    }
  }
  return { eventName: event.eventName }
}

function normalizedPayload(
  event: AttributionBusinessEventV1,
): Record<string, unknown> {
  if (event.eventName === 'Contact') {
    const payload = event.payload as {
      contactMethodId: string
      contactPlatform: string
      contactAction: string
    }
    return {
      contactMethodId: payload.contactMethodId,
      contactPlatform: payload.contactPlatform,
      contactAction: payload.contactAction,
    }
  }
  const payload = event.payload as {
    userId: number
    hashedEmail?: string
  }
  return {
    userId: payload.userId,
    ...(payload.hashedEmail === undefined
      ? {}
      : { hashedEmail: payload.hashedEmail }),
  }
}

function serverEventPayload(
  event: AttributionBusinessEventV1,
): Record<string, unknown> {
  if (
    event.eventName === 'CompleteRegistration'
    && !event.consent.adUserDataAllowed
  ) {
    return {}
  }
  return normalizedPayload(event)
}

function normalizeRequestMetadata(
  value: CanonicalFactOptions['requestMetadata'],
  allowed: boolean,
): Record<string, string> {
  if (!allowed || value === undefined) return {}
  if (!isPlainRecord(value)) throw factInvalid()
  const unknownKeys = Object.keys(value).filter(
    key => key !== 'clientIp' && key !== 'userAgent',
  )
  if (unknownKeys.length > 0) throw factInvalid()
  const result: Record<string, string> = {}
  if (value.clientIp !== undefined) {
    result.clientIp = safeText(value.clientIp, 128)
  }
  if (value.userAgent !== undefined) {
    result.userAgent = safeText(value.userAgent, 1024)
  }
  return result
}

function validateEvent(
  event: AttributionBusinessEventV1,
  factOrigin: string,
  now: Date,
): void {
  if (
    !isAttributionBusinessEventV1(event)
    || (factOrigin !== 'live' && factOrigin !== 'synthetic')
    || !isCanonicalTimestamp(event.occurredAt)
  ) {
    throw factInvalid()
  }
  const occurredAt = new Date(event.occurredAt).getTime()
  if (
    occurredAt > now.getTime()
    || now.getTime() - occurredAt >= MAX_EVENT_AGE_MS
  ) {
    throw factInvalid()
  }
}

function outboxIdentity(
  delivery: Pick<
    CanonicalFactDelivery,
    'id' | 'provider' | 'versionId'
  >,
): string {
  return [
    delivery.id,
    delivery.provider,
    delivery.versionId,
  ].join(':')
}

function createIdentifier(
  factory: (prefix: string) => string,
  prefix: string,
): string {
  const value = factory(prefix)
  if (!isIdentifier(value)) throw factInvalid()
  return value
}

function trustedNow(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw factInvalid()
  return value
}

function percentage(value: number): 0 | 10 | 50 | 100 {
  if (!PERCENTAGES.has(value)) throw factInvalid()
  return value as 0 | 10 | 50 | 100
}

function validDestination(value: string): string {
  if (!isDestination(value)) throw factInvalid()
  return value
}

function safeText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || /\p{Cc}/u.test(value)
  ) {
    throw factInvalid()
  }
  return value
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false
  }
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function isBooleanInteger(value: number): boolean {
  return value === 0 || value === 1
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function isDestination(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 512
    && !/\p{Cc}/u.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function factInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_FACT_INVALID')
}
