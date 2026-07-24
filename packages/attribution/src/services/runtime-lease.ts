import type { AttributionProvider } from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'
import {
  signAttributionToken,
  verifyAttributionToken,
  type AttributionSigningKeys,
} from '../security/signed-token'
import type { AttributionPrivacyDecision } from './privacy-policy'

export interface RuntimeLeaseEnvironment {
  db: D1Database
  signingKeys: AttributionSigningKeys
  now?: () => Date
}

export interface RuntimeLeaseVerificationEnvironment {
  db: D1Database
  signingKeys: AttributionSigningKeys
  now?: () => Date
}

export interface IssueRuntimeLeaseInput {
  connectionId: string
  provider: AttributionProvider
  privacyState: AttributionPrivacyDecision['state']
}

export interface RuntimeLeasePayload {
  schemaVersion: 1
  connectionId: string
  versionId: string
  provider: AttributionProvider
  issuedAt: number
  expiresAt: number
}

export interface DelayedRuntimeEventInput {
  occurredAt: string
}

export interface VerifiedDelayedRuntimeEvent extends RuntimeLeasePayload {
  accepted: true
}

interface EligibleRuntimeRow {
  provider: string
  connection_id: string
  version_id: string
}

const LEASE_PURPOSE = 'runtime-lease'
export const RUNTIME_LEASE_SECONDS = 30 * 60
const DELAYED_EVENT_WINDOW_MS = 24 * 60 * 60 * 1_000
const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])

export async function issueRuntimeLease(
  environment: RuntimeLeaseEnvironment,
  input: IssueRuntimeLeaseInput,
): Promise<string> {
  if (input.privacyState !== 'granted') {
    throw new AttributionDomainError(
      'ATTRIBUTION_RUNTIME_LEASE_NOT_GRANTED',
    )
  }
  validateIdentity(input)
  const now = trustedNowSeconds(environment.now)
  const runtime = await requireEligibleRuntime(environment.db, input)
  const expiresAt = now + RUNTIME_LEASE_SECONDS
  if (!Number.isSafeInteger(expiresAt)) throw leaseInvalid()
  const payload: RuntimeLeasePayload = {
    schemaVersion: 1,
    connectionId: runtime.connectionId,
    versionId: runtime.versionId,
    provider: runtime.provider,
    issuedAt: now,
    expiresAt,
  }
  try {
    return await signAttributionToken(
      environment.signingKeys.current,
      LEASE_PURPOSE,
      { ...payload },
    )
  } catch {
    throw leaseInvalid()
  }
}

export async function verifyRuntimeLease(
  environment: RuntimeLeaseVerificationEnvironment,
  token: string,
): Promise<RuntimeLeasePayload> {
  const payload = await verifiedPayload(environment.signingKeys, token)
  const now = trustedNowSeconds(environment.now)
  if (now < payload.issuedAt) throw leaseInvalid()
  if (now > payload.expiresAt) {
    throw new AttributionDomainError('ATTRIBUTION_RUNTIME_LEASE_EXPIRED')
  }
  await requireLeaseEnabled(environment.db, payload)
  return payload
}

export async function verifyDelayedRuntimeEvent(
  environment: RuntimeLeaseVerificationEnvironment,
  token: string,
  input: DelayedRuntimeEventInput,
): Promise<VerifiedDelayedRuntimeEvent> {
  const payload = await verifiedPayload(environment.signingKeys, token)
  const occurredAt = parseTimestamp(input.occurredAt)
  const receivedAt = trustedNow(environment.now).getTime()
  if (
    occurredAt < payload.issuedAt * 1_000
    || occurredAt > payload.expiresAt * 1_000
    || receivedAt < occurredAt
    || receivedAt - occurredAt > DELAYED_EVENT_WINDOW_MS
  ) {
    throw delayedEventInvalid()
  }
  await requireLeaseEnabled(environment.db, payload)
  return {
    ...payload,
    accepted: true,
  }
}

async function requireEligibleRuntime(
  db: D1Database,
  input: Pick<IssueRuntimeLeaseInput, 'connectionId' | 'provider'>,
): Promise<{
  provider: AttributionProvider
  connectionId: string
  versionId: string
}> {
  let row: EligibleRuntimeRow | null
  try {
    row = await db.prepare(`
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
    `).bind(input.connectionId, input.provider).first<EligibleRuntimeRow>()
  } catch {
    throw runtimeUnavailable()
  }
  if (
    !row
    || !PROVIDERS.has(row.provider as AttributionProvider)
    || !isIdentifier(row.connection_id)
    || !isIdentifier(row.version_id)
    || row.provider !== input.provider
    || row.connection_id !== input.connectionId
  ) {
    throw leaseInvalid()
  }
  return {
    provider: row.provider as AttributionProvider,
    connectionId: row.connection_id,
    versionId: row.version_id,
  }
}

async function requireLeaseEnabled(
  db: D1Database,
  payload: RuntimeLeasePayload,
): Promise<void> {
  let row: { connection_id: string } | null
  try {
    row = await db.prepare(`
      SELECT connection.id AS connection_id
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
      WHERE connection.id = ?
        AND connection.provider = ?
      LIMIT 1
    `).bind(
      payload.versionId,
      payload.connectionId,
      payload.provider,
    ).first<{ connection_id: string }>()
  } catch {
    throw runtimeUnavailable()
  }
  if (row?.connection_id !== payload.connectionId) throw leaseInvalid()
}

async function verifiedPayload(
  keys: AttributionSigningKeys,
  token: string,
): Promise<RuntimeLeasePayload> {
  const parsed = await verifyAttributionToken(keys, LEASE_PURPOSE, token)
  if (
    !parsed
    || parsed.schemaVersion !== 1
    || !isIdentifier(parsed.connectionId)
    || !isIdentifier(parsed.versionId)
    || !PROVIDERS.has(parsed.provider as AttributionProvider)
    || !Number.isSafeInteger(parsed.issuedAt)
    || !Number.isSafeInteger(parsed.expiresAt)
    || Number(parsed.issuedAt) < 1
    || Number(parsed.expiresAt) - Number(parsed.issuedAt)
      !== RUNTIME_LEASE_SECONDS
  ) {
    throw leaseInvalid()
  }
  return {
    schemaVersion: 1,
    connectionId: parsed.connectionId,
    versionId: parsed.versionId,
    provider: parsed.provider as AttributionProvider,
    issuedAt: Number(parsed.issuedAt),
    expiresAt: Number(parsed.expiresAt),
  }
}

function validateIdentity(input: IssueRuntimeLeaseInput): void {
  if (
    !isIdentifier(input.connectionId)
    || !PROVIDERS.has(input.provider)
  ) {
    throw leaseInvalid()
  }
}

function trustedNowSeconds(now: (() => Date) | undefined): number {
  return Math.floor(trustedNow(now).getTime() / 1_000)
}

function trustedNow(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw leaseInvalid()
  return value
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw delayedEventInvalid()
  }
  const parsed = new Date(value)
  const timestamp = parsed.getTime()
  if (!Number.isFinite(timestamp) || parsed.toISOString() !== value) {
    throw delayedEventInvalid()
  }
  return timestamp
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function leaseInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_RUNTIME_LEASE_INVALID')
}

function delayedEventInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_DELAYED_EVENT_INVALID')
}

function runtimeUnavailable(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_RUNTIME_UNAVAILABLE')
}
