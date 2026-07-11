import type { ActiveMetaEventName, MetaTrackingMode } from '@meigallery/shared'
import { normalizeMetaTrackingMode } from '@meigallery/shared/utils'
import type { Bindings } from '../index'
import { loadMetaCapiCryptoKeys, metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import { parseStoredSettingValue } from '../utils/stored-setting-value'
import { META_GRAPH_API_VERSION, metaEventsEndpoint, metaGraphRequestInit, readMetaEventsResponse } from './meta-graph'
import {
  createMetaIncidentTrigger,
  openMetaCapiIncidentSafely,
} from './meta-capi-circuit-breaker'

const PIXEL_ID_PATTERN = /^\d{5,30}$/
const RELEASE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i
const VERIFICATION_REVISION_PATTERN = /^[0-9a-f]{32}$/
const META_BOOTSTRAP_TIMEOUT_MS = 8_000
const STABLE_INVALIDATION_REASONS = new Set([
  'pixel_id_changed',
  'access_token_changed',
  'graph_api_version_changed',
  'release_commit_changed',
  'verification_revision_missing',
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
  graphApiVersion: typeof META_GRAPH_API_VERSION
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
  revision: string | null
}

type EvaluatedConnection = {
  status: MetaConnectionStatus
  pixelId: string
  accessToken: string
  testEventCode: string
  trackingMode: MetaTrackingMode
  releaseCommit: string
  fingerprint: string
  verificationRevision: string
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
): Promise<{ pixelId: string; trackingMode: 'test' | 'production'; revision: string }> {
  const evaluated = await evaluateMetaConnection(env)
  if (evaluated.status.state !== 'verified'
    || (evaluated.trackingMode !== 'test' && evaluated.trackingMode !== 'production')
    || !normalizeVerificationRevision(evaluated.verificationRevision)) {
    const originalError = new MetaConnectionError('META_CONNECTION_UNVERIFIED')
    if (evaluated.status.invalidationReason === 'pixel_id_changed'
      || evaluated.status.invalidationReason === 'access_token_changed') {
      await openMetaCapiIncidentSafely(
        env,
        createMetaIncidentTrigger('connection_fingerprint_changed'),
      )
    }
    throw originalError
  }
  return {
    pixelId: evaluated.pixelId,
    trackingMode: evaluated.trackingMode,
    revision: evaluated.verificationRevision,
  }
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
  const initialVerification = await readVerification(env.DB, environment)
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

  const currentSettings = await readMetaConnectionSettings(env.DB)
  if (normalizePixelId(currentSettings.pixelId) !== pixelId || currentSettings.trackingMode !== settings.trackingMode) {
    throw new MetaConnectionError('META_CONNECTION_CONFIGURATION_CHANGED', 409)
  }

  const revision = createVerificationRevision()
  let writeResult: D1Result<unknown>
  try {
    writeResult = await persistVerificationCas(env.DB, {
      environment,
      pixelId,
      fingerprint,
      eventName,
      releaseCommit,
      ownerUserId,
      revision,
      initialVerification,
    })
  }
  catch {
    throw new MetaConnectionError('META_CONNECTION_VERIFICATION_WRITE_FAILED', 503)
  }
  if (!d1ChangedExactlyOnce(writeResult)) {
    throw new MetaConnectionError('META_CONNECTION_VERIFICATION_WRITE_FAILED', 503)
  }

  const evaluated = await evaluateMetaConnection(env)
  if (evaluated.status.state !== 'verified' || evaluated.verificationRevision !== revision) {
    throw new MetaConnectionError('META_CONNECTION_VERIFICATION_WRITE_FAILED', 503)
  }
  return { connection: evaluated.status, deliveryId, eventsReceived: 1 }
}

function persistVerificationCas(
  db: D1Database,
  input: {
    environment: MetaConnectionEnvironment
    pixelId: string
    fingerprint: string
    eventName: ActiveMetaEventName
    releaseCommit: string
    ownerUserId: number
    revision: string
    initialVerification: VerificationRow | null
  },
) {
  if (!input.initialVerification) {
    return db.prepare(`
      INSERT INTO meta_connection_verifications (
        environment, pixel_id, token_fingerprint, graph_api_version,
        verified_event_name, verified_commit, revision, verified_at,
        verified_by_user_id, dataset_quality_status, invalidated_at,
        invalidation_reason, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'not_checked', NULL, '', datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM meta_connection_verifications WHERE environment = ?
      )
    `).bind(
      input.environment,
      input.pixelId,
      input.fingerprint,
      META_GRAPH_API_VERSION,
      input.eventName,
      input.releaseCommit,
      input.revision,
      input.ownerUserId,
      input.environment,
    ).run()
  }

  return db.prepare(`
    UPDATE meta_connection_verifications
    SET pixel_id = ?,
        token_fingerprint = ?,
        graph_api_version = ?,
        verified_event_name = ?,
        verified_commit = ?,
        revision = ?,
        verified_at = datetime('now'),
        verified_by_user_id = ?,
        dataset_quality_status = 'not_checked',
        invalidated_at = NULL,
        invalidation_reason = '',
        updated_at = datetime('now')
    WHERE environment = ?
      AND revision IS ?
  `).bind(
    input.pixelId,
    input.fingerprint,
    META_GRAPH_API_VERSION,
    input.eventName,
    input.releaseCommit,
    input.revision,
    input.ownerUserId,
    input.environment,
    input.initialVerification.revision,
  ).run()
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
    graphApiVersion: META_GRAPH_API_VERSION,
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
    await persistInvalidation(env.DB, environment, row.revision, invalidationReason)
    return {
      status: statusFromRow(base, row, 'configuration_changed', invalidationReason),
      pixelId,
      accessToken,
      testEventCode,
      trackingMode: settings.trackingMode,
      releaseCommit,
      fingerprint,
      verificationRevision: normalizeVerificationRevision(row.revision),
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
    verificationRevision: normalizeVerificationRevision(row.revision),
  }
}

function evaluatedResult(
  status: MetaConnectionStatus,
  values: Omit<EvaluatedConnection, 'status' | 'fingerprint' | 'verificationRevision'>,
): EvaluatedConnection {
  return { status, ...values, fingerprint: '', verificationRevision: '' }
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
  if (!normalizeVerificationRevision(row.revision)) return 'verification_revision_missing'
  if (row.pixel_id !== pixelId) return 'pixel_id_changed'
  if (row.token_fingerprint !== fingerprint) return 'access_token_changed'
  if (row.graph_api_version !== META_GRAPH_API_VERSION) return 'graph_api_version_changed'
  if (normalizeReleaseCommit(row.verified_commit) !== releaseCommit) return 'release_commit_changed'
  return ''
}

async function persistInvalidation(
  db: D1Database,
  environment: MetaConnectionEnvironment,
  revision: string | null,
  reason: string,
) {
  try {
    await db.prepare(`
      UPDATE meta_connection_verifications
      SET invalidated_at = COALESCE(invalidated_at, datetime('now')),
          invalidation_reason = ?,
          updated_at = datetime('now')
      WHERE environment = ?
        AND revision IS ?
        AND invalidated_at IS NULL
    `).bind(reason, environment, revision).run()
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
      verified_by_user_id, invalidated_at, invalidation_reason, revision
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

function normalizeVerificationRevision(value: unknown) {
  const normalized = String(value ?? '').trim()
  return VERIFICATION_REVISION_PATTERN.test(normalized) ? normalized : ''
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

function createVerificationRevision() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
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
    const response = await fetch(metaEventsEndpoint(pixelId), metaGraphRequestInit(accessToken, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }))
    const { eventsReceived } = await readMetaEventsResponse(response, [
      accessToken,
      payload.test_event_code,
      payload.data[0]!.user_data.client_ip_address,
      payload.data[0]!.user_data.client_user_agent,
    ])
    return { ok: response.ok, status: response.status, eventsReceived }
  }
  catch {
    throw new MetaConnectionError('META_TEST_EVENT_RETRYABLE', 503)
  }
  finally {
    clearTimeout(timeoutId)
  }
}

function d1ChangedExactlyOnce(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 0) === 1
}
