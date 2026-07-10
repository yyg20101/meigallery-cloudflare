import type { ActiveMetaEventName, MetaTrackingMode } from '@meigallery/shared'
import { normalizeMetaTrackingMode } from '@meigallery/shared/utils'
import type { Bindings } from '../index'
import { loadMetaCapiCryptoKeys, metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import { parseStoredSettingValue } from '../utils/stored-setting-value'

export const GRAPH_API_VERSION = 'v25.0' as const

const PIXEL_ID_PATTERN = /^\d{5,30}$/
const RELEASE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i
const META_BOOTSTRAP_TIMEOUT_MS = 8_000
const STABLE_INVALIDATION_REASONS = new Set([
  'pixel_id_changed',
  'access_token_changed',
  'graph_api_version_changed',
  'release_commit_changed',
  'verification_invalidated',
])

export type MetaConnectionState =
  | 'not_configured'
  | 'unverified'
  | 'verified'
  | 'configuration_changed'

export interface MetaConnectionStatus {
  state: MetaConnectionState
  environment: 'dev' | 'production'
  pixelIdConfigured: boolean
  tokenConfigured: boolean
  testEventCodeConfigured: boolean
  verifiedAt: string | null
  verifiedCommit: string | null
  graphApiVersion: typeof GRAPH_API_VERSION
  datasetQualityStatus: 'not_checked' | 'available' | 'permission_denied' | 'error'
  invalidationReason: string
}

export type MetaConnectionEnv = Pick<
  Bindings,
  | 'DB'
  | 'APP_ENV'
  | 'META_CAPI_ACCESS_TOKEN'
  | 'META_CAPI_TEST_EVENT_CODE'
  | 'META_CAPI_DATA_KEY_CURRENT'
  | 'META_CAPI_QUEUE'
  | 'RELEASE_COMMIT'
>

type MetaConnectionEnvironment = MetaConnectionStatus['environment']
type DatasetQualityStatus = MetaConnectionStatus['datasetQualityStatus']

type VerificationRow = {
  environment: string
  pixel_id: string
  token_fingerprint: string
  graph_api_version: string
  verified_event_name: string
  verified_commit: string
  dataset_quality_status: string
  verified_at: string
  verified_by_user_id: number | null
  invalidated_at: string | null
  invalidation_reason: string
}

type EvaluatedConnection = {
  status: MetaConnectionStatus
  pixelId: string
  accessToken: string
  testEventCode: string
  trackingMode: MetaTrackingMode
  releaseCommit: string
  fingerprint: string
}

export type MetaConnectionBootstrapResult = {
  connection: MetaConnectionStatus
  deliveryId: string
  eventsReceived: 1
}

export class MetaConnectionError extends Error {
  readonly code: string
  readonly httpStatus: 400 | 403 | 409 | 424 | 503

  constructor(code: string, httpStatus: 400 | 403 | 409 | 424 | 503 = 409) {
    super(code)
    this.name = 'MetaConnectionError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export async function getMetaConnectionStatus(env: MetaConnectionEnv): Promise<MetaConnectionStatus> {
  return (await evaluateMetaConnection(env)).status
}

export async function requireVerifiedMetaConnection(
  env: MetaConnectionEnv,
): Promise<{ pixelId: string; trackingMode: 'test' | 'production' }> {
  const evaluated = await evaluateMetaConnection(env)
  if (evaluated.status.state !== 'verified'
    || (evaluated.trackingMode !== 'test' && evaluated.trackingMode !== 'production')) {
    throw new MetaConnectionError('META_CONNECTION_UNVERIFIED')
  }
  return { pixelId: evaluated.pixelId, trackingMode: evaluated.trackingMode }
}

export async function verifyMetaConnection(
  env: MetaConnectionEnv,
  ownerUserId: number,
  eventName: ActiveMetaEventName,
): Promise<MetaConnectionStatus> {
  return (await bootstrapMetaConnectionVerification(env, ownerUserId, eventName)).connection
}

export async function bootstrapMetaConnectionVerification(
  env: MetaConnectionEnv,
  ownerUserId: number,
  eventName: ActiveMetaEventName,
): Promise<MetaConnectionBootstrapResult> {
  const environment = requireRuntimeEnvironment(env.APP_ENV)
  if (environment === 'production') {
    throw new MetaConnectionError('META_PRODUCTION_TEST_GATE_PENDING', 409)
  }
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
    throw new MetaConnectionError('META_CONNECTION_OWNER_INVALID', 403)
  }
  if (eventName !== 'Contact' && eventName !== 'CompleteRegistration') {
    throw new MetaConnectionError('META_TEST_EVENT_INVALID', 400)
  }

  const settings = await readMetaConnectionSettings(env.DB)
  const pixelId = normalizePixelId(settings.pixelId)
  const accessToken = configuredValue(env.META_CAPI_ACCESS_TOKEN)
  const testEventCode = configuredValue(env.META_CAPI_TEST_EVENT_CODE)
  const releaseCommit = normalizeReleaseCommit(env.RELEASE_COMMIT)

  if (settings.trackingMode !== 'test') {
    throw new MetaConnectionError('META_TEST_MODE_REQUIRED', 409)
  }
  if (!releaseCommit) {
    throw new MetaConnectionError('META_RELEASE_COMMIT_INVALID', 503)
  }
  if (!pixelId || !accessToken || !testEventCode || !env.META_CAPI_QUEUE) {
    throw new MetaConnectionError('META_TEST_EVENT_NOT_CONFIGURED', 503)
  }
  const rawDataKey = env.META_CAPI_DATA_KEY_CURRENT
  if (typeof rawDataKey !== 'string' || rawDataKey.length === 0 || rawDataKey.trim() !== rawDataKey) {
    throw new MetaConnectionError('META_TEST_EVENT_NOT_CONFIGURED', 503)
  }
  try {
    await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: rawDataKey })
  }
  catch {
    throw new MetaConnectionError('META_TEST_EVENT_NOT_CONFIGURED', 503)
  }

  const fingerprint = await metaConnectionFingerprint(pixelId, accessToken)
  const deliveryId = createSyntheticDeliveryId()
  const payload = buildSyntheticBootstrapPayload(eventName, deliveryId, testEventCode)
  const response = await fetchBootstrapEvent(pixelId, accessToken, payload)

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500
    throw new MetaConnectionError(retryable ? 'META_TEST_EVENT_RETRYABLE' : 'META_TEST_EVENT_REJECTED', retryable ? 503 : 424)
  }
  if (response.eventsReceived !== 1) {
    throw new MetaConnectionError('META_TEST_EVENT_REJECTED', 424)
  }

  await env.DB.prepare(`
    INSERT INTO meta_connection_verifications (
      environment, pixel_id, token_fingerprint, graph_api_version,
      verified_event_name, verified_commit, verified_at, verified_by_user_id,
      dataset_quality_status, invalidated_at, invalidation_reason, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, 'not_checked', NULL, '', datetime('now'))
    ON CONFLICT(environment) DO UPDATE SET
      pixel_id = excluded.pixel_id,
      token_fingerprint = excluded.token_fingerprint,
      graph_api_version = excluded.graph_api_version,
      verified_event_name = excluded.verified_event_name,
      verified_commit = excluded.verified_commit,
      verified_at = datetime('now'),
      verified_by_user_id = excluded.verified_by_user_id,
      dataset_quality_status = 'not_checked',
      invalidated_at = NULL,
      invalidation_reason = '',
      updated_at = datetime('now')
  `).bind(
    environment,
    pixelId,
    fingerprint,
    GRAPH_API_VERSION,
    eventName,
    releaseCommit,
    ownerUserId,
  ).run()

  const connection = await getMetaConnectionStatus(env)
  if (connection.state !== 'verified') {
    throw new MetaConnectionError('META_CONNECTION_VERIFICATION_WRITE_FAILED', 503)
  }
  return { connection, deliveryId, eventsReceived: 1 }
}

async function evaluateMetaConnection(env: MetaConnectionEnv): Promise<EvaluatedConnection> {
  const environment = requireRuntimeEnvironment(env.APP_ENV)
  const settings = await readMetaConnectionSettings(env.DB)
  const pixelId = normalizePixelId(settings.pixelId)
  const accessToken = configuredValue(env.META_CAPI_ACCESS_TOKEN)
  const testEventCode = configuredValue(env.META_CAPI_TEST_EVENT_CODE)
  const releaseCommit = normalizeReleaseCommit(env.RELEASE_COMMIT)
  const base = {
    environment,
    pixelIdConfigured: Boolean(pixelId),
    tokenConfigured: Boolean(accessToken),
    testEventCodeConfigured: Boolean(testEventCode),
    graphApiVersion: GRAPH_API_VERSION,
  }

  const configuredReason = !pixelId
    ? 'pixel_id_missing'
    : !accessToken
      ? 'access_token_missing'
      : settings.trackingMode === 'test' && !testEventCode
        ? 'test_event_code_missing'
        : ''
  if (configuredReason) {
    return evaluatedResult(baseStatus(base, 'not_configured', configuredReason), {
      pixelId,
      accessToken,
      testEventCode,
      trackingMode: settings.trackingMode,
      releaseCommit,
    })
  }
  if (settings.trackingMode !== 'test' && settings.trackingMode !== 'production') {
    return evaluatedResult(baseStatus(base, 'unverified', 'tracking_mode_disabled'), {
      pixelId,
      accessToken,
      testEventCode,
      trackingMode: settings.trackingMode,
      releaseCommit,
    })
  }
  if (!releaseCommit) {
    return evaluatedResult(baseStatus(base, 'unverified', 'release_commit_invalid'), {
      pixelId,
      accessToken,
      testEventCode,
      trackingMode: settings.trackingMode,
      releaseCommit,
    })
  }

  const row = await readVerification(env.DB, environment)
  if (!row) {
    return evaluatedResult(baseStatus(base, 'unverified', 'verification_missing'), {
      pixelId,
      accessToken,
      testEventCode,
      trackingMode: settings.trackingMode,
      releaseCommit,
    })
  }

  const fingerprint = await metaConnectionFingerprint(pixelId, accessToken)
  const invalidationReason = connectionInvalidationReason(row, pixelId, fingerprint, releaseCommit)
  if (invalidationReason) {
    await persistInvalidation(env.DB, environment, invalidationReason)
    return {
      status: statusFromRow(base, row, 'configuration_changed', invalidationReason),
      pixelId,
      accessToken,
      testEventCode,
      trackingMode: settings.trackingMode,
      releaseCommit,
      fingerprint,
    }
  }

  return {
    status: statusFromRow(base, row, 'verified', ''),
    pixelId,
    accessToken,
    testEventCode,
    trackingMode: settings.trackingMode,
    releaseCommit,
    fingerprint,
  }
}

function evaluatedResult(
  status: MetaConnectionStatus,
  values: Omit<EvaluatedConnection, 'status' | 'fingerprint'>,
): EvaluatedConnection {
  return { status, ...values, fingerprint: '' }
}

function baseStatus(
  base: Pick<MetaConnectionStatus, 'environment' | 'pixelIdConfigured' | 'tokenConfigured' | 'testEventCodeConfigured' | 'graphApiVersion'>,
  state: MetaConnectionState,
  invalidationReason: string,
): MetaConnectionStatus {
  return {
    ...base,
    state,
    verifiedAt: null,
    verifiedCommit: null,
    datasetQualityStatus: 'not_checked',
    invalidationReason,
  }
}

function statusFromRow(
  base: Pick<MetaConnectionStatus, 'environment' | 'pixelIdConfigured' | 'tokenConfigured' | 'testEventCodeConfigured' | 'graphApiVersion'>,
  row: VerificationRow,
  state: MetaConnectionState,
  invalidationReason: string,
): MetaConnectionStatus {
  return {
    ...base,
    state,
    verifiedAt: normalizeTimestamp(row.verified_at),
    verifiedCommit: normalizeReleaseCommit(row.verified_commit) || null,
    datasetQualityStatus: normalizeDatasetQualityStatus(row.dataset_quality_status),
    invalidationReason,
  }
}

function connectionInvalidationReason(
  row: VerificationRow,
  pixelId: string,
  fingerprint: string,
  releaseCommit: string,
) {
  if (row.invalidated_at) return stableInvalidationReason(row.invalidation_reason)
  if (row.pixel_id !== pixelId) return 'pixel_id_changed'
  if (row.token_fingerprint !== fingerprint) return 'access_token_changed'
  if (row.graph_api_version !== GRAPH_API_VERSION) return 'graph_api_version_changed'
  if (normalizeReleaseCommit(row.verified_commit) !== releaseCommit) return 'release_commit_changed'
  return ''
}

async function persistInvalidation(
  db: D1Database,
  environment: MetaConnectionEnvironment,
  reason: string,
) {
  try {
    await db.prepare(`
      UPDATE meta_connection_verifications
      SET invalidated_at = COALESCE(invalidated_at, datetime('now')),
          invalidation_reason = ?,
          updated_at = datetime('now')
      WHERE environment = ?
    `).bind(reason, environment).run()
  }
  catch {
    // 运行时判断已 fail closed；持久化失败不能让旧连接恢复可用。
  }
}

async function readMetaConnectionSettings(db: D1Database) {
  const [pixelRow, modeRow] = await Promise.all([
    db.prepare("SELECT value FROM site_settings WHERE key = 'facebook_pixel_id' LIMIT 1").first<{ value: string }>(),
    db.prepare("SELECT value FROM site_settings WHERE key = 'meta_tracking_mode' LIMIT 1").first<{ value: string }>(),
  ])
  return {
    pixelId: String(parseStoredSettingValue(pixelRow?.value || '""', '') || ''),
    trackingMode: normalizeMetaTrackingMode(parseStoredSettingValue(modeRow?.value || '"disabled"', 'disabled')),
  }
}

function readVerification(db: D1Database, environment: MetaConnectionEnvironment) {
  return db.prepare(`
    SELECT environment, pixel_id, token_fingerprint, graph_api_version,
      verified_event_name, verified_commit, dataset_quality_status, verified_at,
      verified_by_user_id, invalidated_at, invalidation_reason
    FROM meta_connection_verifications
    WHERE environment = ?
    LIMIT 1
  `).bind(environment).first<VerificationRow>()
}

function requireRuntimeEnvironment(value: unknown): MetaConnectionEnvironment {
  if (value === 'dev' || value === 'production') return value
  throw new MetaConnectionError('META_CONNECTION_ENV_INVALID', 409)
}

function normalizePixelId(value: unknown) {
  const normalized = String(value ?? '').trim()
  return PIXEL_ID_PATTERN.test(normalized) ? normalized : ''
}

function configuredValue(value: unknown) {
  return String(value ?? '').trim()
}

function normalizeReleaseCommit(value: unknown) {
  const normalized = String(value ?? '').trim()
  return RELEASE_COMMIT_PATTERN.test(normalized) ? normalized.toLowerCase() : ''
}

function normalizeTimestamp(value: unknown) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function normalizeDatasetQualityStatus(value: unknown): DatasetQualityStatus {
  return value === 'available' || value === 'permission_denied' || value === 'error'
    ? value
    : 'not_checked'
}

function stableInvalidationReason(value: unknown) {
  const reason = String(value ?? '').trim()
  return STABLE_INVALIDATION_REASONS.has(reason) ? reason : 'verification_invalidated'
}

function createSyntheticDeliveryId() {
  return `meta_verify_${crypto.randomUUID().replaceAll('-', '')}`
}

function buildSyntheticBootstrapPayload(
  eventName: ActiveMetaEventName,
  deliveryId: string,
  testEventCode: string,
) {
  return {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: deliveryId,
      event_source_url: 'https://example.com/meta-connection-bootstrap',
      action_source: 'website',
      user_data: {
        client_ip_address: '192.0.2.1',
        client_user_agent: 'MeiGallery MetaConnection Synthetic Test/1.0',
      },
      custom_data: {
        content_category: 'meta_connection_synthetic_test',
      },
    }],
    test_event_code: testEventCode,
  }
}

async function fetchBootstrapEvent(
  pixelId: string,
  accessToken: string,
  payload: ReturnType<typeof buildSyntheticBootstrapPayload>,
) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), META_BOOTSTRAP_TIMEOUT_MS)
  try {
    const response = await fetch(metaCapiEndpoint(pixelId, accessToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    let body: unknown = null
    try {
      body = await response.json()
    }
    catch {
      body = null
    }
    const eventsReceived = body && typeof body === 'object' && !Array.isArray(body)
      && typeof (body as Record<string, unknown>).events_received === 'number'
      ? (body as Record<string, unknown>).events_received as number
      : undefined
    return { ok: response.ok, status: response.status, eventsReceived }
  }
  catch {
    throw new MetaConnectionError('META_TEST_EVENT_RETRYABLE', 503)
  }
  finally {
    clearTimeout(timeoutId)
  }
}

function metaCapiEndpoint(pixelId: string, accessToken: string) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events`)
  url.searchParams.set('access_token', accessToken)
  return url.toString()
}
