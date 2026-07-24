import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import { Hono } from 'hono'
import { getProviderAdapter } from '../adapters/registry'
import type {
  AttributionProviderAdapter,
} from '../adapters/types'
import type {
  AttributionCandidateBindingInput,
} from '../domain/connection'
import { AttributionDomainError } from '../domain/errors'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import {
  listAdminAttributionConnections,
  readAdminAttributionConnection,
} from '../read-models/admin-connections'
import {
  listAdminAttributionIncidents,
  type AdminAttributionIncidentProvider,
} from '../read-models/admin-incidents'
import {
  readAdminAttributionPrivacyPolicy,
} from '../read-models/admin-privacy'
import {
  listAdminAttributionQuality,
} from '../read-models/admin-quality'
import { sha256Hex } from '../security/digest'
import {
  createAttributionConnectionCommands,
} from '../services/connection-commands'
import {
  createAdminManagedSource,
  disableAdminManagedSource,
  listAdminManagedSources,
} from '../services/managed-source-service'
import {
  savePrivacyPolicy,
  type AttributionPrivacyDefaultMode,
} from '../services/privacy-policy'
import {
  setRuntimePolicy,
  type RuntimePromotionHealthChecker,
} from '../services/runtime-policy-commands'
import {
  startCandidateValidation,
} from '../services/validation-service'

export interface AdminAttributionActor {
  actorId: number
  role: 'admin' | 'owner'
}

export interface AdminAttributionVariables {
  attributionEnvironment: AttributionEnvironment
  adminAttributionActor: AdminAttributionActor
}

export interface AdminAttributionRouteOptions {
  authorize?: (
    request: Request,
    bindings: AttributionBindings,
  ) => Promise<AdminAttributionActor | null>
  now?: () => Date
  runtimeHealth?: RuntimePromotionHealthChecker
  adapterFor?: (
    provider: AttributionProvider,
  ) => AttributionProviderAdapter
}

type AdminRouteEnvironment = {
  Bindings: AttributionBindings
  Variables: AdminAttributionVariables
}

interface CreateConnectionRequest {
  provider: AttributionProvider
  name: string
  isDefault: boolean
}

interface CreateCandidateRequest {
  publicConfig: Record<string, string>
  credential?: {
    type: 'access_token' | 'service_account_json'
    plaintext: string
  }
  eventBindings: AttributionCandidateBindingInput[]
  testEventCode?: string
}

interface SetRuntimePolicyRequest {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: 0 | 10 | 50 | 100
}

interface CreateManagedSourceRequest {
  campaign: string
  medium: string
  content: string
  expiresAt?: string
}

interface SavePrivacyPolicyRequest {
  defaultMode: AttributionPrivacyDefaultMode
  priorConsentCountryCodes: string[]
}

const MAX_JSON_BYTES = 64 * 1024
const MAX_CREDENTIAL_BYTES = 32 * 1024
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,240}$/
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const PERCENTAGES = new Set([0, 10, 50, 100])
const CANONICAL_EVENTS = new Set<CanonicalConversionEvent>([
  'Contact',
  'CompleteRegistration',
])
const DEFAULT_BLOCKED_HEALTH: RuntimePromotionHealthChecker = {
  check: async () => ({
    activeSnapshotReadable: false,
    credentialDecryptable: false,
    queueBound: false,
    adapterConstructable: false,
  }),
}

export function createAdminAttributionRoutes(
  options: AdminAttributionRouteOptions = {},
) {
  const routes = new Hono<AdminRouteEnvironment>()
  const authorize = options.authorize ?? (async () => null)
  const now = options.now ?? (() => new Date())

  routes.use('*', async (c, next) => {
    let actor: AdminAttributionActor | null = null
    try {
      actor = await authorize(c.req.raw, c.env)
    } catch {
      actor = null
    }
    if (!isActor(actor)) return c.notFound()
    if (actor.role !== 'owner') {
      throw routeError(403, 'ATTRIBUTION_OWNER_REQUIRED')
    }
    c.set('adminAttributionActor', actor)
    await next()
  })

  routes.onError((error, c) => {
    const response = errorResponse(error)
    return c.json({
      error: {
        code: response.code,
        message: response.message,
      },
    }, response.status)
  })

  routes.get('/connections', async (c) => {
    return c.json({
      data: await listAdminAttributionConnections(c.env.DB),
    })
  })

  routes.get('/connections/:id', async (c) => {
    return c.json({
      data: await requireConnectionView(c.env.DB, c.req.param('id')),
    })
  })

  routes.post('/connections', async (c) => {
    const idempotencyKey = requireIdempotencyKey(c.req.raw)
    const input = parseCreateConnectionRequest(
      await readJson(c.req.raw),
    )
    const connectionId = await deterministicConnectionId(
      input.provider,
      idempotencyKey,
    )
    const actor = c.get('adminAttributionActor')
    const commands = connectionCommands(c, now)
    await commands.createConnection({
      id: connectionId,
      provider: input.provider,
      name: input.name,
      isDefault: input.isDefault,
      actorId: actor.actorId,
      idempotencyKey,
    })
    return c.json({
      data: await requireConnectionView(c.env.DB, connectionId),
    })
  })

  routes.post('/connections/:id/candidates', async (c) => {
    const idempotencyKey = requireIdempotencyKey(c.req.raw)
    const input = parseCreateCandidateRequest(
      await readJson(c.req.raw),
    )
    const connectionId = identifier(c.req.param('id'))
    const actor = c.get('adminAttributionActor')
    const commands = connectionCommands(c, now)
    const validationContextDigest = await sha256Hex(
      `candidate-validation:v1:${input.testEventCode ?? ''}`,
    )
    const candidate = await commands.createCandidate({
      connectionId,
      publicConfig: input.publicConfig,
      bindings: input.eventBindings,
      credential: input.credential?.plaintext,
      validationContextDigest,
      actorId: actor.actorId,
      idempotencyKey,
    })

    if (candidate.status === 'candidate') {
      const runtime = c.get('attributionEnvironment')
      await startCandidateValidation({
        db: c.env.DB,
        appEnvironment: runtime.appEnvironment,
        credentialMasterKeys: runtime.credentialMasterKeys,
        dataEncryptionKeys: runtime.dataEncryptionKeys,
        signingKeys: runtime.signingKeys,
        queues: runtime.queues,
        workflow: runtime.validationWorkflow,
        adapterFor: options.adapterFor,
        now,
      }, {
        connectionId,
        candidateId: candidate.id,
        actorId: actor.actorId,
        testEventCode: input.testEventCode,
      })
    }

    return c.json({
      data: await requireConnectionView(c.env.DB, connectionId),
    })
  })

  routes.get('/connections/:id/candidate', async (c) => {
    const view = await requireConnectionView(
      c.env.DB,
      c.req.param('id'),
    )
    return c.json({ data: view.candidate })
  })

  routes.patch('/connections/:id/runtime-policy', async (c) => {
    const idempotencyKey = requireIdempotencyKey(c.req.raw)
    const input = parseRuntimePolicyRequest(
      await readJson(c.req.raw),
    )
    const connectionId = identifier(c.req.param('id'))
    const actor = c.get('adminAttributionActor')
    await setRuntimePolicy({
      db: c.env.DB,
      health: options.runtimeHealth ?? DEFAULT_BLOCKED_HEALTH,
      now,
    }, {
      connectionId,
      ...input,
      actorId: actor.actorId,
      idempotencyKey,
    })
    return c.json({
      data: await requireConnectionView(c.env.DB, connectionId),
    })
  })

  routes.post('/connections/:id/rollback', async (c) => {
    const idempotencyKey = requireIdempotencyKey(c.req.raw)
    const connectionId = identifier(c.req.param('id'))
    const actor = c.get('adminAttributionActor')
    await connectionCommands(c, now).rollbackPreviousVersion({
      connectionId,
      actorId: actor.actorId,
      idempotencyKey,
    })
    return c.json({
      data: await requireConnectionView(c.env.DB, connectionId),
    })
  })

  routes.post('/connections/:id/disable', async (c) => {
    const idempotencyKey = requireIdempotencyKey(c.req.raw)
    const connectionId = identifier(c.req.param('id'))
    const actor = c.get('adminAttributionActor')
    await connectionCommands(c, now).disableConnection({
      connectionId,
      actorId: actor.actorId,
      idempotencyKey,
    })
    return c.json({
      data: await requireConnectionView(c.env.DB, connectionId),
    })
  })

  routes.get('/connections/:id/sources', async (c) => {
    return c.json({
      data: await listAdminManagedSources({
        db: c.env.DB,
        now,
      }, {
        connectionId: identifier(c.req.param('id')),
      }),
    })
  })

  routes.post('/connections/:id/sources', async (c) => {
    const idempotencyKey = requireIdempotencyKey(c.req.raw)
    const input = parseCreateManagedSourceRequest(
      await readJson(c.req.raw),
    )
    const actor = c.get('adminAttributionActor')
    return c.json({
      data: await createAdminManagedSource({
        db: c.env.DB,
        now,
      }, {
        connectionId: identifier(c.req.param('id')),
        ...input,
        actorId: actor.actorId,
        idempotencyKey,
      }),
    })
  })

  routes.post(
    '/connections/:id/sources/:sourceId/disable',
    async (c) => {
      const idempotencyKey = requireIdempotencyKey(c.req.raw)
      const actor = c.get('adminAttributionActor')
      return c.json({
        data: await disableAdminManagedSource({
          db: c.env.DB,
          now,
        }, {
          connectionId: identifier(c.req.param('id')),
          sourceId: identifier(c.req.param('sourceId')),
          actorId: actor.actorId,
          idempotencyKey,
        }),
      })
    },
  )

  routes.get('/quality', async (c) => {
    const limit = optionalLimit(c.req.query('limit'))
    return c.json({
      data: await listAdminAttributionQuality(c.env.DB, {
        dateFrom: optionalQuery(c.req.query('dateFrom')),
        dateTo: optionalQuery(c.req.query('dateTo')),
        provider: optionalProvider(c.req.query('provider')),
        connectionId: optionalQuery(c.req.query('connectionId')),
        ...(limit === undefined ? {} : { limit }),
      }),
    })
  })

  routes.get('/incidents', async (c) => {
    const limit = optionalLimit(c.req.query('limit'))
    return c.json({
      data: await listAdminAttributionIncidents(c.env.DB, {
        provider: optionalIncidentProvider(c.req.query('provider')),
        connectionId: optionalQuery(c.req.query('connectionId')),
        severity: optionalSeverity(c.req.query('severity')),
        status: optionalIncidentStatus(c.req.query('status')),
        ...(limit === undefined ? {} : { limit }),
      }),
    })
  })

  routes.get('/privacy-policy', async (c) => {
    const policy = await readAdminAttributionPrivacyPolicy(c.env.DB)
    if (policy.availability !== 'available') {
      throw routeError(
        503,
        'ATTRIBUTION_PRIVACY_POLICY_UNAVAILABLE',
      )
    }
    return c.json({ data: policy })
  })

  routes.patch('/privacy-policy', async (c) => {
    const idempotencyKey = requireIdempotencyKey(c.req.raw)
    const input = parsePrivacyPolicyRequest(
      await readJson(c.req.raw),
    )
    const actor = c.get('adminAttributionActor')
    await savePrivacyPolicy({
      db: c.env.DB,
      now,
    }, {
      ...input,
      actorId: actor.actorId,
      idempotencyKey,
    })
    const policy = await readAdminAttributionPrivacyPolicy(c.env.DB)
    if (policy.availability !== 'available') {
      throw routeError(
        503,
        'ATTRIBUTION_PRIVACY_POLICY_UNAVAILABLE',
      )
    }
    return c.json({ data: policy })
  })

  return routes
}

function connectionCommands(
  c: {
    env: AttributionBindings
    get(key: 'attributionEnvironment'): AttributionEnvironment
  },
  now: () => Date,
) {
  return createAttributionConnectionCommands({
    db: c.env.DB,
    credentialKeys: c.get('attributionEnvironment').credentialMasterKeys,
    now,
  })
}

async function requireConnectionView(
  db: D1Database,
  rawId: string,
) {
  const view = await readAdminAttributionConnection(
    db,
    identifier(rawId),
  )
  if (!view) {
    throw new AttributionDomainError('ATTRIBUTION_CONNECTION_NOT_FOUND')
  }
  return view
}

async function deterministicConnectionId(
  provider: AttributionProvider,
  idempotencyKey: string,
): Promise<string> {
  const digest = await sha256Hex(
    `admin-connection:v1:${idempotencyKey}`,
  )
  return `connection_${provider}_${digest.slice(0, 32)}`
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (
      !Number.isSafeInteger(declared)
      || declared < 0
      || declared > MAX_JSON_BYTES
    ) {
      throw routeError(413, 'ATTRIBUTION_REQUEST_TOO_LARGE')
    }
  }
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw routeError(413, 'ATTRIBUTION_REQUEST_TOO_LARGE')
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
}

function parseCreateConnectionRequest(
  value: unknown,
): CreateConnectionRequest {
  const input = exactRecord(value, ['provider', 'name', 'isDefault'])
  return {
    provider: provider(input.provider),
    name: text(input.name, 160),
    isDefault: booleanValue(input.isDefault),
  }
}

function parseCreateCandidateRequest(
  value: unknown,
): CreateCandidateRequest {
  const input = exactRecord(value, [
    'publicConfig',
    'credential',
    'eventBindings',
    'testEventCode',
  ])
  const result: CreateCandidateRequest = {
    publicConfig: publicConfig(input.publicConfig),
    eventBindings: eventBindings(input.eventBindings),
  }
  if (input.credential !== undefined) {
    const credential = exactRecord(
      input.credential,
      ['type', 'plaintext'],
    )
    if (
      credential.type !== 'access_token'
      && credential.type !== 'service_account_json'
    ) {
      throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
    }
    const plaintext = text(credential.plaintext, MAX_CREDENTIAL_BYTES)
    if (
      new TextEncoder().encode(plaintext).byteLength
      > MAX_CREDENTIAL_BYTES
    ) {
      throw routeError(413, 'ATTRIBUTION_CREDENTIAL_TOO_LARGE')
    }
    result.credential = {
      type: credential.type,
      plaintext,
    }
  }
  if (input.testEventCode !== undefined) {
    result.testEventCode = text(input.testEventCode, 256)
  }
  return result
}

function parseRuntimePolicyRequest(
  value: unknown,
): SetRuntimePolicyRequest {
  const input = exactRecord(value, [
    'enabled',
    'browserEnabled',
    'serverEnabled',
    'serverTargetPercentage',
  ])
  const percentage = input.serverTargetPercentage
  if (
    typeof percentage !== 'number'
    || !PERCENTAGES.has(percentage)
  ) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return {
    enabled: booleanValue(input.enabled),
    browserEnabled: booleanValue(input.browserEnabled),
    serverEnabled: booleanValue(input.serverEnabled),
    serverTargetPercentage:
      percentage as SetRuntimePolicyRequest['serverTargetPercentage'],
  }
}

function parseCreateManagedSourceRequest(
  value: unknown,
): CreateManagedSourceRequest {
  const input = exactRecord(value, [
    'campaign',
    'medium',
    'content',
    'expiresAt',
  ])
  const result: CreateManagedSourceRequest = {
    campaign: text(input.campaign, 1024),
    medium: text(input.medium, 1024),
    content: text(input.content, 1024),
  }
  if (input.expiresAt !== undefined) {
    result.expiresAt = text(input.expiresAt, 64)
  }
  return result
}

function parsePrivacyPolicyRequest(
  value: unknown,
): SavePrivacyPolicyRequest {
  const input = exactRecord(value, [
    'defaultMode',
    'priorConsentCountryCodes',
  ])
  if (
    input.defaultMode !== 'notice_opt_out'
    && input.defaultMode !== 'prior_consent'
    && input.defaultMode !== 'disabled'
  ) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  if (
    !Array.isArray(input.priorConsentCountryCodes)
    || input.priorConsentCountryCodes.some(
      item => typeof item !== 'string',
    )
  ) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return {
    defaultMode: input.defaultMode,
    priorConsentCountryCodes: input.priorConsentCountryCodes,
  }
}

function publicConfig(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  const entries = Object.entries(value)
  if (
    entries.length === 0
    || entries.length > 32
    || entries.some(([key, item]) => (
      !CONFIG_KEY_PATTERN.test(key)
      || typeof item !== 'string'
      || item.length > 4096
    ))
    || JSON.stringify(value).length > 16 * 1024
  ) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

function eventBindings(
  value: unknown,
): AttributionCandidateBindingInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return value.map((item) => {
    const binding = exactRecord(item, [
      'canonicalEvent',
      'enabled',
      'browserDestination',
      'serverDestination',
    ])
    if (!CANONICAL_EVENTS.has(
      binding.canonicalEvent as CanonicalConversionEvent,
    )) {
      throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
    }
    return {
      canonicalEvent:
        binding.canonicalEvent as CanonicalConversionEvent,
      enabled: booleanValue(binding.enabled),
      browserDestination: text(binding.browserDestination, 512, true),
      serverDestination: text(binding.serverDestination, 512, true),
    }
  })
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  const allowed = new Set(allowedKeys)
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!value) {
    throw routeError(
      400,
      'ATTRIBUTION_IDEMPOTENCY_KEY_REQUIRED',
    )
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw routeError(400, 'ATTRIBUTION_IDEMPOTENCY_KEY_INVALID')
  }
  return value
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return value
}

function provider(value: unknown): AttributionProvider {
  return getProviderAdapter(value).provider
}

function text(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string'
    || value.length > maxLength
    || (!allowEmpty && value.trim().length === 0)
  ) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return value
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return value
}

function optionalQuery(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function optionalProvider(
  value: string | undefined,
): AttributionProvider | undefined {
  return value === undefined || value === ''
    ? undefined
    : provider(value)
}

function optionalIncidentProvider(
  value: string | undefined,
): AdminAttributionIncidentProvider | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'cloudflare' || value === 'system') return value
  return provider(value)
}

function optionalSeverity(
  value: string | undefined,
): 'warning' | 'critical' | undefined {
  if (value === undefined || value === '') return undefined
  if (value !== 'warning' && value !== 'critical') {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return value
}

function optionalIncidentStatus(
  value: string | undefined,
): 'open' | 'resolved' | undefined {
  if (value === undefined || value === '') return undefined
  if (value !== 'open' && value !== 'resolved') {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return value
}

function optionalLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^[1-9]\d{0,2}$/.test(value)) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  const parsed = Number(value)
  if (parsed > 500) {
    throw routeError(400, 'ATTRIBUTION_REQUEST_INVALID')
  }
  return parsed
}

function isActor(
  value: AdminAttributionActor | null,
): value is AdminAttributionActor {
  return value !== null
    && Number.isSafeInteger(value.actorId)
    && value.actorId > 0
    && (value.role === 'admin' || value.role === 'owner')
}

class AdminAttributionRouteError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413 | 503
  readonly code: string

  constructor(
    status: 400 | 403 | 404 | 409 | 413 | 503,
    code: string,
  ) {
    super(code)
    this.name = 'AdminAttributionRouteError'
    this.status = status
    this.code = code
  }
}

function routeError(
  status: AdminAttributionRouteError['status'],
  code: string,
): AdminAttributionRouteError {
  return new AdminAttributionRouteError(status, code)
}

function errorResponse(error: unknown): {
  status: AdminAttributionRouteError['status']
  code: string
  message: string
} {
  if (error instanceof AdminAttributionRouteError) {
    return {
      status: error.status,
      code: error.code,
      message: errorMessage(error.code),
    }
  }
  if (error instanceof AttributionDomainError) {
    const status = domainErrorStatus(error.code)
    return {
      status,
      code: error.code,
      message: errorMessage(error.code),
    }
  }
  if (error instanceof Error) {
    if (error.message === 'ATTRIBUTION_VALIDATION_TEST_CODE_INVALID') {
      return {
        status: 400,
        code: error.message,
        message: '测试事件码格式无效',
      }
    }
    if (
      error.message === 'ATTRIBUTION_VALIDATION_CANDIDATE_INVALID'
      || error.message === 'ATTRIBUTION_CAPACITY_NONESSENTIAL_PAUSED'
    ) {
      return {
        status: 409,
        code: error.message,
        message: '当前状态不允许启动候选验证',
      }
    }
  }
  return {
    status: 503,
    code: 'ATTRIBUTION_ADMIN_UNAVAILABLE',
    message: errorMessage('ATTRIBUTION_ADMIN_UNAVAILABLE'),
  }
}

function domainErrorStatus(
  code: AttributionDomainError['code'],
): AdminAttributionRouteError['status'] {
  if (code === 'ATTRIBUTION_CONNECTION_NOT_FOUND') return 404
  if (
    code === 'ATTRIBUTION_IDEMPOTENCY_CONFLICT'
    || code === 'ATTRIBUTION_DEFAULT_CONNECTION_CONFLICT'
    || code === 'ATTRIBUTION_ACTIVE_VERSION_CHANGED'
    || code === 'ATTRIBUTION_VERSION_STATE_INVALID'
    || code === 'ATTRIBUTION_RUNTIME_PROMOTION_BLOCKED'
  ) {
    return 409
  }
  if (
    code === 'ATTRIBUTION_COMMAND_FAILED'
    || code === 'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID'
    || code === 'ATTRIBUTION_RUNTIME_UNAVAILABLE'
  ) {
    return 503
  }
  return 400
}

function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    ATTRIBUTION_OWNER_REQUIRED: '仅 Owner 可以访问归因控制面',
    ATTRIBUTION_IDEMPOTENCY_KEY_REQUIRED: '缺少幂等键',
    ATTRIBUTION_IDEMPOTENCY_KEY_INVALID: '幂等键格式无效',
    ATTRIBUTION_REQUEST_INVALID: '请求格式无效',
    ATTRIBUTION_REQUEST_TOO_LARGE: '请求体过大',
    ATTRIBUTION_CREDENTIAL_TOO_LARGE: '凭据内容过大',
    ATTRIBUTION_PRIVACY_POLICY_UNAVAILABLE: '隐私策略暂时不可用',
    ATTRIBUTION_ADMIN_UNAVAILABLE: '归因控制面暂时不可用',
  }
  return messages[code] ?? '归因控制面请求未完成'
}
