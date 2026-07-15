import type { AdPlatformTrackingMode } from '@meigallery/shared'
import type { Bindings } from '../index'
import { readAttributionConnectionSnapshot } from './ad-platform/connections'
import {
  buildTikTokEventsPayload,
  isTikTokEventsSuccess,
  readTikTokEventsResponse,
  TIKTOK_EVENTS_API_ENDPOINT,
  tiktokEventsRequestInit,
} from './tiktok-events'
import { tiktokConnectionFingerprint } from '../utils/tiktok-events-crypto'

const VERIFICATION_TIMEOUT_MS = 8_000
const TEST_EVENT_CODE_PATTERN = /^[A-Za-z0-9_-]{4,128}$/

export type TikTokConnectionEnv = Pick<
  Bindings,
  | 'DB'
  | 'APP_ENV'
  | 'SITE_URL'
  | 'TIKTOK_EVENTS_ACCESS_TOKEN'
  | 'AD_TIKTOK_QUEUE'
  | 'TIKTOK_EVENTS_DATA_KEY_CURRENT'
>

type VerificationRow = {
  pixel_id: string
  credential_fingerprint: string
  revision: string
  verified_at: string
  invalidated_at: string | null
  invalidation_reason: string
}

export interface TikTokConnectionStatus {
  state: 'not_configured' | 'unverified' | 'verified' | 'configuration_changed'
  pixelIdConfigured: boolean
  tokenConfigured: boolean
  verifiedAt: string
  revision: string
  trackingMode: AdPlatformTrackingMode
}

export interface VerifiedTikTokConnection {
  pixelId: string
  accessToken: string
  revision: string
  trackingMode: AdPlatformTrackingMode
}

export async function getTikTokConnectionStatus(env: TikTokConnectionEnv): Promise<TikTokConnectionStatus> {
  const snapshot = await readAttributionConnectionSnapshot(env.DB, 'tiktok')
  const connection = snapshot.state === 'ready' ? snapshot.connection : null
  const pixelId = String(connection?.publicConfig.pixelCode || '').trim().toUpperCase()
  const accessToken = String(env.TIKTOK_EVENTS_ACCESS_TOKEN || '').trim()
  const base = {
    pixelIdConfigured: Boolean(pixelId),
    tokenConfigured: Boolean(accessToken),
    verifiedAt: '',
    revision: '',
    trackingMode: connection?.mode ?? 'disabled' as AdPlatformTrackingMode,
  }
  if (!pixelId && !accessToken) return { ...base, state: 'not_configured' }
  if (!pixelId || !accessToken || env.APP_ENV !== 'production') return { ...base, state: 'unverified' }

  const verification = await readVerification(env.DB)
  if (!verification || verification.invalidated_at) {
    return {
      ...base,
      state: verification?.invalidated_at ? 'configuration_changed' : 'unverified',
      verifiedAt: verification?.verified_at || '',
      revision: verification?.revision || '',
    }
  }
  const fingerprint = await tiktokConnectionFingerprint(pixelId, accessToken)
  if (verification.pixel_id !== pixelId || verification.credential_fingerprint !== fingerprint) {
    return {
      ...base,
      state: 'configuration_changed',
      verifiedAt: verification.verified_at,
      revision: verification.revision,
    }
  }
  return {
    ...base,
    state: 'verified',
    verifiedAt: verification.verified_at,
    revision: verification.revision,
  }
}

export async function requireVerifiedTikTokConnection(
  env: TikTokConnectionEnv,
): Promise<VerifiedTikTokConnection> {
  const [status, connection] = await Promise.all([
    getTikTokConnectionStatus(env),
    readAttributionConnectionSnapshot(env.DB, 'tiktok'),
  ])
  const accessToken = String(env.TIKTOK_EVENTS_ACCESS_TOKEN || '').trim()
  if (status.state !== 'verified'
    || connection.state !== 'ready'
    || connection.connection.mode !== 'production'
    || !status.revision
    || !accessToken) throw new Error('TIKTOK_CONNECTION_UNVERIFIED')
  return {
    pixelId: connection.connection.publicConfig.pixelCode ?? '',
    accessToken,
    revision: status.revision,
    trackingMode: connection.connection.mode,
  }
}

export async function verifyTikTokConnection(
  env: TikTokConnectionEnv,
  input: {
    testEventCode: string
    fetchFn?: typeof fetch
    timeoutMs?: number
  },
) {
  if (env.APP_ENV !== 'production') throw new Error('TIKTOK_VERIFICATION_PRODUCTION_ONLY')
  const snapshot = await readAttributionConnectionSnapshot(env.DB, 'tiktok')
  const connection = snapshot.state === 'ready' ? snapshot.connection : null
  const pixelId = String(connection?.publicConfig.pixelCode || '').trim().toUpperCase()
  const accessToken = String(env.TIKTOK_EVENTS_ACCESS_TOKEN || '').trim()
  const testEventCode = String(input.testEventCode || '').trim()
  if (!pixelId || !accessToken) throw new Error('TIKTOK_CONNECTION_NOT_CONFIGURED')
  if (connection?.mode !== 'production') throw new Error('TIKTOK_CONNECTION_MODE_INVALID')
  if (!TEST_EVENT_CODE_PATTERN.test(testEventCode)) throw new Error('TIKTOK_TEST_EVENT_CODE_INVALID')

  const current = await getTikTokConnectionStatus(env)
  const pageUrl = verificationPageUrl(env.SITE_URL)
  const eventTime = Math.floor(Date.now() / 1_000)
  const nonce = randomHex(16)
  for (const eventName of ['Contact', 'CompleteRegistration'] as const) {
    const payload = buildTikTokEventsPayload({
      pixelId,
      eventName,
      eventId: `ttv_${eventName === 'Contact' ? 'contact' : 'registration'}_${nonce}`,
      eventTime,
      pageUrl,
      testEventCode,
    })
    const response = await fetchWithTimeout(
      input.fetchFn ?? globalThis.fetch,
      TIKTOK_EVENTS_API_ENDPOINT,
      tiktokEventsRequestInit(accessToken, payload),
      input.timeoutMs ?? VERIFICATION_TIMEOUT_MS,
    )
    const result = await readTikTokEventsResponse(response)
    if (!isTikTokEventsSuccess(response, result)) throw new Error('TIKTOK_VERIFICATION_REJECTED')
  }

  if (current.state === 'verified') {
    return {
      verified: true,
      idempotent: true,
      revision: current.revision,
      verifiedAt: current.verifiedAt,
      testEventsSent: 2,
    }
  }

  const fingerprint = await tiktokConnectionFingerprint(pixelId, accessToken)
  const revision = randomHex(16)
  const verifiedAt = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO tiktok_connection_verifications (
        environment, pixel_id, credential_fingerprint, revision, verified_at,
        invalidated_at, invalidation_reason, updated_at
      )
      VALUES ('production', ?, ?, ?, ?, NULL, '', datetime('now'))
      ON CONFLICT(environment) DO UPDATE SET
        pixel_id = excluded.pixel_id,
        credential_fingerprint = excluded.credential_fingerprint,
        revision = excluded.revision,
        verified_at = excluded.verified_at,
        invalidated_at = NULL,
        invalidation_reason = '',
        updated_at = datetime('now')
    `).bind(pixelId, fingerprint, revision, verifiedAt),
  ])
  return { verified: true, idempotent: false, revision, verifiedAt, testEventsSent: 2 }
}

function readVerification(db: D1Database) {
  return db.prepare(`
    SELECT pixel_id, credential_fingerprint, revision, verified_at,
      invalidated_at, invalidation_reason
    FROM tiktok_connection_verifications
    WHERE environment = 'production'
    LIMIT 1
  `).first<VerificationRow>()
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    return await fetchFn(input, { ...init, signal: controller.signal })
  }
  catch {
    throw new Error('TIKTOK_VERIFICATION_NETWORK_ERROR')
  }
  finally {
    clearTimeout(timeout)
  }
}

function verificationPageUrl(siteUrl: string | undefined) {
  try {
    return new URL('/tiktok-events-verification', String(siteUrl || '')).toString()
  }
  catch {
    throw new Error('TIKTOK_SITE_URL_INVALID')
  }
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), value => value.toString(16).padStart(2, '0')).join('')
}
