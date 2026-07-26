import { Hono, type Context } from 'hono'
import type {
  AdAttributionProvider,
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
import { testPlatformConnection } from '../../services/ad-platform/connection-diagnostics'
import { getAdPlatformDefinition } from '../../services/ad-platform/registry'
import { errorJson } from '../../utils/api-error'
import { generateId } from '../../utils/db'

type AdminAdPlatformContext = Context<{ Bindings: Bindings; Variables: Variables }>
type MutationGuardResult = ReturnType<typeof errorJson> | null

const CONNECTION_FIELDS = new Set([
  'enabled',
  'browserEnabled',
  'serverEnabled',
  'publicConfig',
  'eventBindings',
  'credential',
])
const TEST_FIELDS = new Set(['testEventCode'])
const MAX_CONNECTION_BODY_BYTES = 64 * 1024
const MAX_TEST_BODY_BYTES = 4 * 1024

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

adminAdPlatformRoutes.post('/:provider/test', async (c) => {
  const blocked = guardMutation(c)
  if (blocked) return blocked
  const provider = providerFromPath(c.req.param('provider'))
  if (!provider) return unsupportedProvider(c)
  try {
    const body = await readJsonRecord(c, MAX_TEST_BODY_BYTES)
    if (!hasOnlyFields(body, TEST_FIELDS)
      || body.testEventCode !== undefined && !validShortText(body.testEventCode, 128)) {
      return invalidRequest(c)
    }
    await recordConnectionTestAudit(c.env.DB, Number(c.get('userId')), provider)
    const result = await testPlatformConnection(c.env, {
      provider,
      ...(body.testEventCode === undefined ? {} : { testEventCode: String(body.testEventCode).trim() }),
    })
    return c.json({ data: result })
  }
  catch (error) {
    return diagnosticErrorResponse(c, error)
  }
})

async function recordConnectionTestAudit(
  db: D1Database,
  actorId: number,
  provider: AdAttributionProvider,
) {
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    ) VALUES (?, ?, 'test_attribution_platform_connection',
      'attribution_platform_connection', ?, NULL, ?)
  `).bind(
    generateId('audit'),
    actorId,
    `conn_${provider}`,
    JSON.stringify({ provider }),
  ).run()
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
    || !Number.isSafeInteger(actorId) || Number(actorId) <= 0
    || !isPlainRecord(body.publicConfig)
    || !Array.isArray(body.eventBindings)) {
    throw new PlatformConnectionError('AD_PLATFORM_CONNECTION_CONFIG_INVALID')
  }
  const credential = parseCredential(body.credential)
  return {
    provider,
    enabled: body.enabled,
    browserEnabled: body.browserEnabled,
    serverEnabled: body.serverEnabled,
    publicConfig: body.publicConfig as PlatformPublicConfig,
    eventBindings: body.eventBindings as PlatformEventBindingInput[],
    ...(credential ? { credential } : {}),
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

function diagnosticErrorResponse(c: AdminAdPlatformContext, error: unknown) {
  const code = safeErrorCode(error)
  if (code === 'AD_PLATFORM_REQUEST_TOO_LARGE') {
    return errorJson(c, 413, '请求体过大', { code })
  }
  if (code === 'AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID'
    || code === 'AD_PLATFORM_REQUEST_INVALID') {
    return errorJson(c, 400, '连接验证参数无效', { code })
  }
  if (code === 'AD_PLATFORM_CONNECTION_INVALID'
    || code === 'AD_PLATFORM_CONNECTION_TEST_CODE_REQUIRED') {
    return errorJson(c, 409, '连接配置不完整，无法测试', { code })
  }
  return errorJson(c, 503, '广告平台连接测试暂时不可用', {
    code: code || 'AD_PLATFORM_CONNECTION_TEST_UNAVAILABLE',
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
