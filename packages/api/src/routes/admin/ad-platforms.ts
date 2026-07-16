import { Hono, type Context } from 'hono'
import type {
  AdAttributionProvider,
  AdPlatformTrackingMode,
  PlatformPublicConfig,
} from '@meigallery/shared'
import type { Bindings, Variables } from '../../index'
import {
  getPlatformConnection,
  listPlatformConnections,
  PlatformConnectionError,
  savePlatformConnection,
  type PlatformEventBindingInput,
  type SavePlatformConnectionCommand,
} from '../../services/ad-platform/connection-service'
import { getAdPlatformDefinition } from '../../services/ad-platform/registry'
import {
  getPlatformVerification,
  startPlatformVerification,
  submitPlatformVerificationEvidence,
} from '../../workflows/ad-platform-verification'
import { migrateMetaWorkerSecret } from '../../services/ad-platform/worker-secret-migration'
import { errorJson } from '../../utils/api-error'

type AdminAdPlatformContext = Context<{ Bindings: Bindings; Variables: Variables }>
type MutationGuardResult = ReturnType<typeof errorJson> | null

const CONNECTION_FIELDS = new Set([
  'enabled',
  'mode',
  'browserEnabled',
  'serverEnabled',
  'publicConfig',
  'eventBindings',
  'credential',
  'rolloutTargetPercentage',
])
const VERIFY_FIELDS = new Set(['testEventCode'])
const EVIDENCE_FIELDS = new Set(['confirmed', 'reference'])
const META_SECRET_MIGRATION_FIELDS = new Set(['pixelId'])
const MAX_CONNECTION_BODY_BYTES = 64 * 1024
const MAX_VERIFICATION_BODY_BYTES = 4 * 1024
const TRACKING_MODES = new Set<AdPlatformTrackingMode>(['disabled', 'test', 'production'])
const ROLLOUT_PERCENTAGES = new Set([0, 10, 50, 100])

export const adminAdPlatformRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAdPlatformRoutes.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

adminAdPlatformRoutes.get('/', async (c) => {
  try {
    return c.json({ data: await listPlatformConnections(c.env) })
  }
  catch (error) {
    return connectionErrorResponse(c, error)
  }
})

adminAdPlatformRoutes.get('/:provider', async (c) => {
  const provider = providerFromPath(c.req.param('provider'))
  if (!provider) return unsupportedProvider(c)
  try {
    const connection = await getPlatformConnection(c.env, provider)
    return connection
      ? c.json({ data: connection })
      : errorJson(c, 404, '广告平台连接不存在', { code: 'AD_PLATFORM_CONNECTION_NOT_FOUND' })
  }
  catch (error) {
    return connectionErrorResponse(c, error)
  }
})

adminAdPlatformRoutes.patch('/:provider', async (c) => {
  const blocked = guardMutation(c)
  if (blocked) return blocked
  const provider = providerFromPath(c.req.param('provider'))
  if (!provider) return unsupportedProvider(c)
  try {
    const body = await readJsonRecord(c, MAX_CONNECTION_BODY_BYTES)
    const command = parseConnectionCommand(provider, body, c.get('userId'))
    return c.json({ data: await savePlatformConnection(c.env, command) })
  }
  catch (error) {
    return connectionErrorResponse(c, error)
  }
})

adminAdPlatformRoutes.post('/meta/migrate-worker-secret', async (c) => {
  const blocked = guardMutation(c)
  if (blocked) return blocked
  try {
    const body = await readJsonRecord(c, MAX_VERIFICATION_BODY_BYTES)
    if (!hasOnlyFields(body, META_SECRET_MIGRATION_FIELDS)
      || !validShortText(body.pixelId, 30)) {
      return invalidRequest(c)
    }
    const result = await migrateMetaWorkerSecret(c.env, {
      pixelId: String(body.pixelId).trim(),
      actorId: c.get('userId')!,
    })
    if (result.status === 'already_completed') {
      return errorJson(c, 409, 'Meta 凭证迁移已完成', {
        code: 'AD_PLATFORM_SECRET_MIGRATION_ALREADY_COMPLETED',
      })
    }
    if (result.status === 'source_unavailable') {
      return errorJson(c, 409, '旧 Meta 凭证不可用', {
        code: 'AD_PLATFORM_SECRET_MIGRATION_SOURCE_UNAVAILABLE',
      })
    }
    return c.json({ data: result.data }, 201)
  }
  catch (error) {
    return connectionErrorResponse(c, error)
  }
})

adminAdPlatformRoutes.post('/:provider/verify', async (c) => startVerificationRoute(c, false))
adminAdPlatformRoutes.post('/:provider/reverify', async (c) => startVerificationRoute(c, true))

adminAdPlatformRoutes.get('/:provider/verification', async (c) => {
  const provider = providerFromPath(c.req.param('provider'))
  if (!provider) return unsupportedProvider(c)
  try {
    const verification = await getPlatformVerification(c.env.DB, provider)
    return verification
      ? c.json({ data: verification })
      : errorJson(c, 404, '尚无连接验证记录', { code: 'AD_PLATFORM_VERIFICATION_NOT_FOUND' })
  }
  catch {
    return errorJson(c, 503, '连接验证状态暂时不可用', { code: 'AD_PLATFORM_VERIFICATION_READ_FAILED' })
  }
})

adminAdPlatformRoutes.get('/:provider/verifications/:verificationId', async (c) => {
  const provider = providerFromPath(c.req.param('provider'))
  if (!provider) return unsupportedProvider(c)
  const verificationId = c.req.param('verificationId')
  if (!validVerificationId(verificationId)) return invalidRequest(c)
  try {
    const verification = await getPlatformVerification(c.env.DB, provider, verificationId)
    return verification
      ? c.json({ data: verification })
      : errorJson(c, 404, '连接验证记录不存在', { code: 'AD_PLATFORM_VERIFICATION_NOT_FOUND' })
  }
  catch {
    return errorJson(c, 503, '连接验证状态暂时不可用', { code: 'AD_PLATFORM_VERIFICATION_READ_FAILED' })
  }
})

adminAdPlatformRoutes.post('/:provider/verifications/:verificationId/evidence', async (c) => {
  const blocked = guardMutation(c)
  if (blocked) return blocked
  const provider = providerFromPath(c.req.param('provider'))
  if (!provider) return unsupportedProvider(c)
  const verificationId = c.req.param('verificationId')
  if (!validVerificationId(verificationId)) return invalidRequest(c)
  try {
    const body = await readJsonRecord(c, MAX_VERIFICATION_BODY_BYTES)
    if (!hasOnlyFields(body, EVIDENCE_FIELDS) || body.confirmed !== true
      || body.reference !== undefined && !validEvidenceReference(body.reference)) {
      return invalidRequest(c)
    }
    const result = await submitPlatformVerificationEvidence(c.env, {
      provider,
      verificationId,
      actorId: c.get('userId')!,
      ...(body.reference === undefined ? {} : { reference: String(body.reference).trim() }),
    })
    return c.json({ data: result }, 202)
  }
  catch (error) {
    return verificationErrorResponse(c, error)
  }
})

async function startVerificationRoute(c: AdminAdPlatformContext, reverify: boolean) {
  const blocked = guardMutation(c)
  if (blocked) return blocked
  const provider = providerFromPath(c.req.param('provider'))
  if (!provider) return unsupportedProvider(c)
  try {
    const body = await readJsonRecord(c, MAX_VERIFICATION_BODY_BYTES)
    if (!hasOnlyFields(body, VERIFY_FIELDS)
      || body.testEventCode !== undefined && !validShortText(body.testEventCode, 128)) {
      return invalidRequest(c)
    }
    const result = await startPlatformVerification(c.env, {
      provider,
      actorId: c.get('userId')!,
      reverify,
      ...(body.testEventCode === undefined ? {} : { testEventCode: String(body.testEventCode).trim() }),
    })
    return c.json({ data: result }, 202)
  }
  catch (error) {
    return verificationErrorResponse(c, error)
  }
}

function parseConnectionCommand(
  provider: AdAttributionProvider,
  body: Record<string, unknown>,
  actorId: number | null,
): SavePlatformConnectionCommand {
  if (!hasOnlyFields(body, CONNECTION_FIELDS)
    || typeof body.enabled !== 'boolean'
    || typeof body.browserEnabled !== 'boolean'
    || typeof body.serverEnabled !== 'boolean'
    || !TRACKING_MODES.has(body.mode as AdPlatformTrackingMode)
    || !ROLLOUT_PERCENTAGES.has(body.rolloutTargetPercentage as number)
    || !Number.isSafeInteger(actorId) || Number(actorId) <= 0
    || !isPlainRecord(body.publicConfig)
    || !Array.isArray(body.eventBindings)) {
    throw new PlatformConnectionError('AD_PLATFORM_CONNECTION_CONFIG_INVALID')
  }
  const credential = parseCredential(body.credential)
  return {
    provider,
    enabled: body.enabled,
    mode: body.mode as AdPlatformTrackingMode,
    browserEnabled: body.browserEnabled,
    serverEnabled: body.serverEnabled,
    publicConfig: body.publicConfig as PlatformPublicConfig,
    eventBindings: body.eventBindings as PlatformEventBindingInput[],
    ...(credential ? { credential } : {}),
    rolloutTargetPercentage: body.rolloutTargetPercentage as 0 | 10 | 50 | 100,
    actorId: Number(actorId),
  }
}

function parseCredential(value: unknown): SavePlatformConnectionCommand['credential'] | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value) || !hasOnlyFields(value, new Set(['type', 'plaintext']))
    || value.type !== 'access_token' && value.type !== 'service_account_json'
    || !validShortText(value.plaintext, 32 * 1024)) {
    throw new PlatformConnectionError('AD_PLATFORM_CONNECTION_CREDENTIAL_INVALID')
  }
  return { type: value.type, plaintext: String(value.plaintext) }
}

function guardMutation(c: AdminAdPlatformContext): MutationGuardResult {
  if (c.get('userRole') !== 'owner' || !Number.isSafeInteger(c.get('userId')) || Number(c.get('userId')) <= 0) {
    return errorJson(c, 403, '需要站长权限', { code: 'OWNER_REQUIRED' })
  }
  if (c.env.APP_ENV !== 'production') {
    return errorJson(c, 409, '广告平台连接只允许在生产环境配置和验证', { code: 'AD_PLATFORM_PRODUCTION_ONLY' })
  }
  const origin = normalizeOrigin(c.req.header('Origin'))
  if (!origin || !trustedOrigins(c.env).has(origin)) {
    return errorJson(c, 403, '请求来源验证失败', { code: 'AD_PLATFORM_ORIGIN_FORBIDDEN' })
  }
  return null
}

function trustedOrigins(env: Bindings) {
  const origins = new Set<string>()
  const siteOrigin = normalizeOrigin(env.SITE_URL)
  if (siteOrigin) origins.add(siteOrigin)
  for (const item of String(env.CORS_ORIGIN || '').split(',')) {
    const origin = normalizeOrigin(item)
    if (origin) origins.add(origin)
  }
  return origins
}

async function readJsonRecord(c: AdminAdPlatformContext, maxBytes: number) {
  const contentLength = Number(c.req.header('Content-Length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('AD_PLATFORM_REQUEST_TOO_LARGE')
  const raw = await c.req.text()
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error('AD_PLATFORM_REQUEST_TOO_LARGE')
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (!isPlainRecord(parsed)) throw new Error()
    return parsed
  }
  catch {
    throw new Error('AD_PLATFORM_REQUEST_INVALID')
  }
}

function connectionErrorResponse(c: AdminAdPlatformContext, error: unknown) {
  if (error instanceof PlatformConnectionError) {
    if (error.code === 'AD_PLATFORM_CONNECTION_READ_FAILED'
      || error.code === 'AD_PLATFORM_CONNECTION_WRITE_FAILED'
      || error.code === 'AD_PLATFORM_CONNECTION_CREDENTIAL_CRYPTO_UNAVAILABLE') {
      return errorJson(c, 503, '广告平台连接暂时不可用', { code: error.code })
    }
    if (error.code === 'AD_PLATFORM_CONNECTION_STATE_INVALID'
      || error.code === 'AD_PLATFORM_CONNECTION_CREDENTIAL_REQUIRED') {
      return errorJson(c, 409, '广告平台连接状态无效', { code: error.code })
    }
    return errorJson(c, 400, '广告平台连接配置无效', { code: error.code })
  }
  if (error instanceof Error && error.message === 'AD_PLATFORM_REQUEST_TOO_LARGE') {
    return errorJson(c, 413, '请求体过大', { code: error.message })
  }
  return invalidRequest(c)
}

function verificationErrorResponse(c: AdminAdPlatformContext, error: unknown) {
  const code = safeErrorCode(error)
  if (code === 'AD_PLATFORM_REQUEST_TOO_LARGE') {
    return errorJson(c, 413, '请求体过大', { code })
  }
  if (code === 'AD_PLATFORM_VERIFICATION_NOT_FOUND') {
    return errorJson(c, 404, '连接验证记录不存在', { code })
  }
  if (code === 'AD_PLATFORM_VERIFICATION_INPUT_INVALID'
    || code === 'AD_PLATFORM_VERIFICATION_TEST_CODE_INVALID'
    || code === 'AD_PLATFORM_REQUEST_INVALID') {
    return errorJson(c, 400, '连接验证参数无效', { code })
  }
  if (code === 'AD_PLATFORM_CONNECTION_INVALID'
    || code === 'AD_PLATFORM_VERIFICATION_PRODUCTION_MODE_REQUIRED'
    || code === 'AD_PLATFORM_VERIFICATION_EVIDENCE_NOT_EXPECTED') {
    return errorJson(c, 409, '连接当前状态不允许执行此操作', { code })
  }
  return errorJson(c, 503, '广告平台连接验证暂时不可用', {
    code: code || 'AD_PLATFORM_VERIFICATION_UNAVAILABLE',
  })
}

function providerFromPath(value: unknown): AdAttributionProvider | null {
  return getAdPlatformDefinition(value)?.provider ?? null
}

function unsupportedProvider(c: AdminAdPlatformContext) {
  return errorJson(c, 404, '广告平台不受支持', { code: 'AD_PLATFORM_NOT_SUPPORTED' })
}

function invalidRequest(c: AdminAdPlatformContext) {
  return errorJson(c, 400, '请求参数无效', { code: 'AD_PLATFORM_REQUEST_INVALID' })
}

function normalizeOrigin(value: unknown) {
  try {
    return new URL(String(value || '')).origin
  }
  catch {
    return ''
  }
}

function validVerificationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(value)
}

function validEvidenceReference(value: unknown) {
  return validShortText(value, 240)
}

function validShortText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !/\p{Cc}/u.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyFields(value: object, fields: Set<string>) {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.has(key))
}

function safeErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : ''
  return /^AD_PLATFORM_[A-Z0-9_]{1,100}$/.test(value) ? value : ''
}
