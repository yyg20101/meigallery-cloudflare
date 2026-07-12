import type { Bindings } from '../index'
import { parseStoredSettingValue } from '../utils/stored-setting-value'
import { META_GRAPH_API_VERSION, metaEventsEndpoint, metaGraphRequestInit, readMetaEventsResponse } from './meta-graph'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i
const CHALLENGE_ID_PATTERN = /^mlc_[0-9a-f]{32}$/
const EVENT_ID_PATTERN = /^mlv_[a-z]+_[0-9a-f]{32}$/
const CHALLENGE_TTL_MS = 60 * 60 * 1000
const META_TIMEOUT_MS = 8_000
const REGISTRATION_EMAIL_HASH = '6262cb8f3a917e5df0cb4d06a2a906194aa46f45b63af973d7f213fb9722280d'
const REGISTRATION_EXTERNAL_ID_HASH = 'fef50236caaad5477b9d7f64fa68ff922b09cbca76830d5208d115c4e161c8d4'

type ChallengeEnv = Pick<
  Bindings,
  'DB' | 'APP_ENV' | 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_TEST_EVENT_CODE' | 'RELEASE_COMMIT'
>

type ChallengeRow = {
  id: string
  environment: string
  commit_sha: string
  owner_user_id: number
  status: string
  contact_event_id: string | null
  complete_registration_event_id: string | null
  created_at: string
  expires_at: string
}

export class MetaLiveChallengeError extends Error {
  readonly code: string
  readonly httpStatus: 400 | 409 | 424 | 503

  constructor(code: string, httpStatus: 400 | 409 | 424 | 503 = 409) {
    super(code)
    this.name = 'MetaLiveChallengeError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export async function createMetaLiveChallenge(env: ChallengeEnv, ownerUserId: number) {
  const config = await requireChallengeConfiguration(env, ownerUserId)
  const createdAt = new Date()
  const challengeId = `mlc_${randomHex(16)}`
  const eventIds = {
    Contact: `mlv_contact_${randomHex(16)}`,
    CompleteRegistration: `mlv_registration_${randomHex(16)}`,
  }
  await env.DB.prepare("DELETE FROM meta_live_challenges WHERE datetime(expires_at) <= datetime('now')").run()
  await env.DB.prepare(`
    INSERT INTO meta_live_challenges (
      id, environment, commit_sha, owner_user_id, status,
      contact_event_id, complete_registration_event_id, created_at, expires_at
    ) VALUES (?, 'production', ?, ?, 'pending', ?, ?, ?, ?)
  `).bind(
    challengeId,
    config.commitSha,
    ownerUserId,
    eventIds.Contact,
    eventIds.CompleteRegistration,
    createdAt.toISOString(),
    new Date(createdAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
  ).run()
  return {
    challengeId,
    environment: 'production' as const,
    commitSha: config.commitSha,
    pixelId: config.pixelId,
    expiresAt: new Date(createdAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
    eventIds,
  }
}

export async function consumeMetaLiveChallenge(env: ChallengeEnv, ownerUserId: number, challengeId: string) {
  const config = await requireChallengeConfiguration(env, ownerUserId)
  if (!CHALLENGE_ID_PATTERN.test(challengeId)) throw new MetaLiveChallengeError('META_LIVE_CHALLENGE_INVALID', 400)
  const row = await env.DB.prepare(`
    SELECT id, environment, commit_sha, owner_user_id, status,
      contact_event_id, complete_registration_event_id, created_at, expires_at
    FROM meta_live_challenges WHERE id = ? LIMIT 1
  `).bind(challengeId).first<ChallengeRow>()

  if (!validPendingChallenge(row, config.commitSha, ownerUserId)) {
    await destroyChallenge(env.DB, challengeId)
    throw new MetaLiveChallengeError('META_LIVE_CHALLENGE_INVALID')
  }
  const contactEventId = row!.contact_event_id!
  const registrationEventId = row!.complete_registration_event_id!
  const eventDigests = {
    Contact: await digestEventId(contactEventId),
    CompleteRegistration: await digestEventId(registrationEventId),
  }
  const claimedAt = new Date().toISOString()
  const claim = await env.DB.prepare(`
    UPDATE meta_live_challenges
    SET status = 'consuming',
        contact_event_id = NULL,
        complete_registration_event_id = NULL,
        contact_event_digest = ?,
        complete_registration_event_digest = ?,
        registration_email_covered = 1,
        registration_external_id_covered = 1,
        contact_registration_identity_absent = 1,
        consumed_at = ?
    WHERE id = ? AND status = 'pending' AND environment = 'production'
      AND commit_sha = ? AND owner_user_id = ? AND expires_at > ?
  `).bind(
    eventDigests.Contact,
    eventDigests.CompleteRegistration,
    claimedAt,
    challengeId,
    config.commitSha,
    ownerUserId,
    claimedAt,
  ).run()
  if (!d1ChangedExactlyOnce(claim)) throw new MetaLiveChallengeError('META_LIVE_CHALLENGE_INVALID')

  const payload = buildChallengePayload(contactEventId, registrationEventId, config.testEventCode)
  try {
    const response = await fetchChallengeEvents(config.pixelId, config.accessToken, payload)
    if (!response.ok || response.eventsReceived !== 2) {
      throw new MetaLiveChallengeError('META_LIVE_CHALLENGE_DELIVERY_FAILED', response.status >= 500 ? 503 : 424)
    }
    const consumedAt = new Date().toISOString()
    const consumed = await env.DB.prepare(`
      UPDATE meta_live_challenges
      SET status = 'server_sent',
          events_received = 2,
          consumed_at = ?
      WHERE id = ? AND status = 'consuming' AND commit_sha = ? AND owner_user_id = ?
    `).bind(
      consumedAt,
      challengeId,
      config.commitSha,
      ownerUserId,
    ).run()
    if (!d1ChangedExactlyOnce(consumed)) throw new MetaLiveChallengeError('META_LIVE_CHALLENGE_INVALID')
    return { challengeId, eventsReceived: 2 as const, eventDigests }
  }
  catch (error) {
    await destroyChallenge(env.DB, challengeId)
    if (error instanceof MetaLiveChallengeError) throw error
    throw new MetaLiveChallengeError('META_LIVE_CHALLENGE_DELIVERY_FAILED', 503)
  }
}

export function isOpaqueSyntheticEventId(value: string) {
  if (!EVENT_ID_PATTERN.test(value)) return false
  if (/^[+() .-]*\d(?:[+() .-]*\d){6,14}[+() .-]*$/.test(value)) return false
  return !value.includes('@') && !/fb\.1\.|access[_-]?token|test[_-]?event[_-]?code|client[_-]?ip/i.test(value)
}

async function requireChallengeConfiguration(env: ChallengeEnv, ownerUserId: number) {
  if (env.APP_ENV !== 'production' || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
    throw new MetaLiveChallengeError('META_LIVE_CHALLENGE_INVALID')
  }
  const commitSha = normalizeCommit(env.RELEASE_COMMIT)
  const accessToken = configuredValue(env.META_CAPI_ACCESS_TOKEN)
  const testEventCode = configuredValue(env.META_CAPI_TEST_EVENT_CODE)
  const [pixelRow, modeRow] = await Promise.all([
    env.DB.prepare("SELECT value FROM site_settings WHERE key = 'facebook_pixel_id' LIMIT 1").first<{ value: string }>(),
    env.DB.prepare("SELECT value FROM site_settings WHERE key = 'meta_tracking_mode' LIMIT 1").first<{ value: string }>(),
  ])
  const pixelId = String(parseStoredSettingValue(pixelRow?.value || '""', '') || '').trim()
  const trackingMode = parseStoredSettingValue(modeRow?.value || '"disabled"', 'disabled')
  if (!commitSha || !/^\d{5,30}$/.test(pixelId) || trackingMode !== 'test' || !accessToken || !testEventCode) {
    throw new MetaLiveChallengeError('META_LIVE_CHALLENGE_NOT_CONFIGURED', 503)
  }
  return { commitSha, pixelId, accessToken, testEventCode }
}

function validPendingChallenge(row: ChallengeRow | null, commitSha: string, ownerUserId: number) {
  if (!row || row.status !== 'pending' || row.environment !== 'production' || row.commit_sha !== commitSha || row.owner_user_id !== ownerUserId) return false
  const createdAt = Date.parse(row.created_at)
  const expiresAt = Date.parse(row.expires_at)
  const now = Date.now()
  return Number.isFinite(createdAt)
    && Number.isFinite(expiresAt)
    && expiresAt - createdAt === CHALLENGE_TTL_MS
    && now >= createdAt
    && now < expiresAt
    && isOpaqueSyntheticEventId(String(row.contact_event_id || ''))
    && isOpaqueSyntheticEventId(String(row.complete_registration_event_id || ''))
    && row.contact_event_id !== row.complete_registration_event_id
}

function buildChallengePayload(contactEventId: string, registrationEventId: string, testEventCode: string) {
  const eventTime = Math.floor(Date.now() / 1000)
  return {
    data: [
      syntheticEvent('Contact', contactEventId, eventTime),
      syntheticEvent('CompleteRegistration', registrationEventId, eventTime),
    ],
    test_event_code: testEventCode,
  }
}

function syntheticEvent(eventName: 'Contact' | 'CompleteRegistration', eventId: string, eventTime: number) {
  return {
    event_name: eventName,
    event_time: eventTime,
    event_id: eventId,
    event_source_url: 'https://616618.xyz/meta-live-verification',
    action_source: 'website',
    user_data: {
      client_ip_address: '192.0.2.1',
      client_user_agent: 'MeiGallery Meta Live Synthetic Test/2.0',
      ...(eventName === 'CompleteRegistration'
        ? { em: [REGISTRATION_EMAIL_HASH], external_id: [REGISTRATION_EXTERNAL_ID_HASH] }
        : {}),
    },
    custom_data: { content_category: 'meta_live_synthetic_test' },
  }
}

async function fetchChallengeEvents(
  pixelId: string,
  accessToken: string,
  payload: ReturnType<typeof buildChallengePayload>,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS)
  try {
    const response = await fetch(metaEventsEndpoint(pixelId), metaGraphRequestInit(accessToken, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }))
    const result = await readMetaEventsResponse(response, [
      accessToken,
      payload.test_event_code,
      ...payload.data.flatMap(event => [
        event.event_id,
        event.user_data.client_ip_address,
        event.user_data.client_user_agent,
        ...('em' in event.user_data ? (event.user_data.em ?? []) : []),
        ...('external_id' in event.user_data ? (event.user_data.external_id ?? []) : []),
      ]),
    ])
    return { ok: response.ok, status: response.status, eventsReceived: result.eventsReceived }
  }
  finally {
    clearTimeout(timeout)
  }
}

async function digestEventId(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

async function destroyChallenge(db: D1Database, challengeId: string) {
  try {
    await db.prepare('DELETE FROM meta_live_challenges WHERE id = ?').bind(challengeId).run()
  }
  catch {
    // 调用方保持 fail closed；下一次读取仍因 consuming/过期状态被拒绝。
  }
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeCommit(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return COMMIT_PATTERN.test(normalized) ? normalized : ''
}

function configuredValue(value: unknown) {
  const normalized = String(value ?? '')
  return normalized && normalized.trim() === normalized ? normalized : ''
}

function d1ChangedExactlyOnce(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 0) === 1
}

export const META_LIVE_CHALLENGE_GRAPH_VERSION = META_GRAPH_API_VERSION
