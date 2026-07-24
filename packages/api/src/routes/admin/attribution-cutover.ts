import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import {
  readAttributionCutoverPreflight,
  readAttributionRestorePreflight,
  type AttributionCutoverTargetOwner,
} from '../../services/attribution-cutover-preflight'
import {
  createAttributionServiceClient,
} from '../../services/attribution-service-client'
import {
  AttributionRuntimeOwnerError,
  restoreAttributionRuntimeOwner,
  transitionAttributionRuntimeOwner,
} from '../../services/attribution-runtime-owner'
import { errorJson } from '../../utils/api-error'

type CutoverRouteEnvironment = {
  Bindings: Bindings
  Variables: Variables
}

interface CutoverRouteOptions {
  now?: () => Date
  idFactory?: (prefix: string) => string
}

interface TransitionRequest {
  targetOwner: AttributionCutoverTargetOwner
  expectedEpoch: number
  reason: string
}

interface RestoreRequest {
  expectedEpoch: number
  reason: string
}

const MAX_BODY_BYTES = 4 * 1024
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,240}$/
const REASON_PATTERN = /^[^\p{Cc}]{4,240}$/u

export function createAdminAttributionCutoverRoutes(
  options: CutoverRouteOptions = {},
) {
  const routes = new Hono<CutoverRouteEnvironment>()

  routes.use('*', requireOwner)
  routes.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })

  routes.get('/', async (c) => {
    const targetOwner = parseTargetOwner(c.req.query('targetOwner'))
    if (!targetOwner) return invalidRequest(c)
    try {
      const preflight = await readAttributionCutoverPreflight(
        c.env.DB,
        createAttributionServiceClient(c.env.ATTRIBUTION),
        targetOwner,
      )
      return c.json({ data: preflight })
    } catch {
      return unavailable(c)
    }
  })

  routes.get('/restore-preflight', async (c) => {
    try {
      return c.json({
        data: await readAttributionRestorePreflight(
          c.env.DB,
          createAttributionServiceClient(c.env.ATTRIBUTION),
        ),
      })
    } catch {
      return unavailable(c)
    }
  })

  routes.post('/transition', async (c) => {
    const actorId = c.get('userId')
    if (!Number.isSafeInteger(actorId) || Number(actorId) <= 0) {
      return errorJson(c, 401, '请先登录', {
        code: 'AUTH_REQUIRED',
      })
    }
    const idempotencyKey =
      c.req.header('Idempotency-Key')?.trim() ?? ''
    if (!IDENTIFIER_PATTERN.test(idempotencyKey)) {
      return invalidRequest(c)
    }

    try {
      const input = parseTransitionRequest(
        await readBoundedJson(c.req.raw),
      )
      const client = createAttributionServiceClient(c.env.ATTRIBUTION)
      const initialPreflight = await readAttributionCutoverPreflight(
        c.env.DB,
        client,
        input.targetOwner,
      )
      if (
        initialPreflight.current.owner === input.targetOwner
        && initialPreflight.current.epoch === input.expectedEpoch + 1
      ) {
        const state = await transitionAttributionRuntimeOwner({
          db: c.env.DB,
          now: options.now,
          idFactory: options.idFactory,
        }, {
          ...input,
          actorId: Number(actorId),
          idempotencyKey,
        })
        return c.json({
          data: {
            state,
            preflight: initialPreflight,
          },
        })
      }
      if (
        initialPreflight.current.epoch !== input.expectedEpoch
        || !initialPreflight.localReady
      ) {
        return c.json({
          error: {
            code: initialPreflight.current.epoch !== input.expectedEpoch
              ? 'ATTRIBUTION_RUNTIME_OWNER_EPOCH_CONFLICT'
              : 'ATTRIBUTION_CUTOVER_PREFLIGHT_BLOCKED',
            message: initialPreflight.current.epoch !== input.expectedEpoch
              ? '归因运行时 epoch 已变化'
              : '归因切换预检未通过',
          },
          data: initialPreflight,
        }, 409)
      }

      const targetMode = input.targetOwner === 'draining'
        ? 'bridge'
        : 'active'
      const remoteAlreadyBeyondDraining =
        input.targetOwner === 'draining'
        && initialPreflight.current.owner === 'draining'
        && initialPreflight.remote.mode === 'active'
        && initialPreflight.remote.bridgeOwnerEpoch
          === initialPreflight.targetEpoch
      if (!remoteAlreadyBeyondDraining) {
        await client.transitionRuntimeState({
          targetMode,
          sourceOwnerEpoch: initialPreflight.targetEpoch,
          actorId: Number(actorId),
          reason: input.reason,
          idempotencyKey: await remoteCommandKey(
            idempotencyKey,
            targetMode,
          ),
        })
      }

      const preflight = await readAttributionCutoverPreflight(
        c.env.DB,
        client,
        input.targetOwner,
      )
      if (!preflight.ready) {
        return c.json({
          error: {
            code: 'ATTRIBUTION_CUTOVER_PREFLIGHT_BLOCKED',
            message: '归因切换预检未通过',
          },
          data: preflight,
        }, 409)
      }
      const state = await transitionAttributionRuntimeOwner({
        db: c.env.DB,
        now: options.now,
        idFactory: options.idFactory,
      }, {
        ...input,
        actorId: Number(actorId),
        idempotencyKey,
      })
      return c.json({
        data: {
          state,
          preflight,
        },
      })
    } catch (error) {
      if (error instanceof CutoverRequestError) {
        return invalidRequest(c, error.status, error.code)
      }
      if (error instanceof AttributionRuntimeOwnerError) {
        const conflictCodes = new Set([
          'ATTRIBUTION_RUNTIME_OWNER_EPOCH_CONFLICT',
          'ATTRIBUTION_RUNTIME_OWNER_REGRESSION',
          'ATTRIBUTION_RUNTIME_OWNER_IDEMPOTENCY_CONFLICT',
          'ATTRIBUTION_RUNTIME_OWNER_PREFLIGHT_CHANGED',
        ])
        if (conflictCodes.has(error.code)) {
          return errorJson(c, 409, '归因切换状态冲突', {
            code: error.code,
          })
        }
        if (error.code === 'ATTRIBUTION_RUNTIME_OWNER_INPUT_INVALID') {
          return invalidRequest(c)
        }
      }
      return unavailable(c)
    }
  })

  routes.post('/restore', async (c) => {
    const actorId = c.get('userId')
    if (!Number.isSafeInteger(actorId) || Number(actorId) <= 0) {
      return errorJson(c, 401, '请先登录', {
        code: 'AUTH_REQUIRED',
      })
    }
    const idempotencyKey =
      c.req.header('Idempotency-Key')?.trim() ?? ''
    if (!IDENTIFIER_PATTERN.test(idempotencyKey)) {
      return invalidRequest(c)
    }

    try {
      const input = parseRestoreRequest(
        await readBoundedJson(c.req.raw),
      )
      const client = createAttributionServiceClient(c.env.ATTRIBUTION)
      const initialPreflight = await readAttributionRestorePreflight(
        c.env.DB,
        client,
      )
      if (
        initialPreflight.current.owner === 'old'
        && initialPreflight.current.epoch === input.expectedEpoch + 1
      ) {
        const state = await restoreAttributionRuntimeOwner({
          db: c.env.DB,
          now: options.now,
          idFactory: options.idFactory,
        }, {
          ...input,
          actorId: Number(actorId),
          idempotencyKey,
        })
        return c.json({
          data: {
            state,
            preflight: initialPreflight,
          },
        })
      }
      if (
        initialPreflight.current.epoch !== input.expectedEpoch
        || !initialPreflight.safeToFence
      ) {
        return c.json({
          error: {
            code: initialPreflight.current.epoch !== input.expectedEpoch
              ? 'ATTRIBUTION_RUNTIME_OWNER_EPOCH_CONFLICT'
              : 'ATTRIBUTION_RESTORE_PREFLIGHT_BLOCKED',
            message: initialPreflight.current.epoch !== input.expectedEpoch
              ? '归因运行时 epoch 已变化'
              : '归因回滚预检未通过',
          },
          data: initialPreflight,
        }, 409)
      }
      if (!initialPreflight.checks.remoteFenced) {
        await client.transitionRuntimeState({
          targetMode: 'fenced',
          sourceOwnerEpoch: initialPreflight.restoredEpoch,
          actorId: Number(actorId),
          reason: input.reason,
          idempotencyKey: await remoteCommandKey(
            idempotencyKey,
            'fenced',
          ),
        })
      }
      const preflight = await readAttributionRestorePreflight(
        c.env.DB,
        client,
      )
      if (!preflight.ready) {
        return c.json({
          error: {
            code: 'ATTRIBUTION_RESTORE_PREFLIGHT_BLOCKED',
            message: '归因回滚预检未通过',
          },
          data: preflight,
        }, 409)
      }
      const state = await restoreAttributionRuntimeOwner({
        db: c.env.DB,
        now: options.now,
        idFactory: options.idFactory,
      }, {
        ...input,
        actorId: Number(actorId),
        idempotencyKey,
      })
      return c.json({
        data: {
          state,
          preflight,
        },
      })
    } catch (error) {
      if (error instanceof CutoverRequestError) {
        return invalidRequest(c, error.status, error.code)
      }
      if (error instanceof AttributionRuntimeOwnerError) {
        const conflictCodes = new Set([
          'ATTRIBUTION_RUNTIME_OWNER_EPOCH_CONFLICT',
          'ATTRIBUTION_RUNTIME_OWNER_IDEMPOTENCY_CONFLICT',
          'ATTRIBUTION_RUNTIME_OWNER_PREFLIGHT_CHANGED',
        ])
        if (conflictCodes.has(error.code)) {
          return errorJson(c, 409, '归因回滚状态冲突', {
            code: error.code,
          })
        }
        if (error.code === 'ATTRIBUTION_RUNTIME_OWNER_INPUT_INVALID') {
          return invalidRequest(c)
        }
      }
      return unavailable(c)
    }
  })

  return routes
}

export const adminAttributionCutoverRoutes =
  createAdminAttributionCutoverRoutes()

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (
      !Number.isSafeInteger(size)
      || size < 0
      || size > MAX_BODY_BYTES
    ) {
      throw requestError(
        413,
        'ATTRIBUTION_CUTOVER_REQUEST_TOO_LARGE',
      )
    }
  }
  const body = await request.arrayBuffer()
  if (body.byteLength > MAX_BODY_BYTES) {
    throw requestError(
      413,
      'ATTRIBUTION_CUTOVER_REQUEST_TOO_LARGE',
    )
  }
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw requestError(400, 'ATTRIBUTION_CUTOVER_REQUEST_INVALID')
  }
}

function parseTransitionRequest(value: unknown): TransitionRequest {
  if (
    !isRecord(value)
    || Object.keys(value).some(key =>
      !['targetOwner', 'expectedEpoch', 'reason'].includes(key))
    || Object.keys(value).length !== 3
  ) {
    throw requestError(400, 'ATTRIBUTION_CUTOVER_REQUEST_INVALID')
  }
  const targetOwner = parseTargetOwner(value.targetOwner)
  if (
    !targetOwner
    || !Number.isSafeInteger(value.expectedEpoch)
    || Number(value.expectedEpoch) < 1
    || typeof value.reason !== 'string'
    || !REASON_PATTERN.test(value.reason.trim())
  ) {
    throw requestError(400, 'ATTRIBUTION_CUTOVER_REQUEST_INVALID')
  }
  return {
    targetOwner,
    expectedEpoch: Number(value.expectedEpoch),
    reason: value.reason.trim(),
  }
}

function parseRestoreRequest(value: unknown): RestoreRequest {
  if (
    !isRecord(value)
    || Object.keys(value).some(key =>
      !['expectedEpoch', 'reason'].includes(key))
    || Object.keys(value).length !== 2
    || !Number.isSafeInteger(value.expectedEpoch)
    || Number(value.expectedEpoch) < 2
    || typeof value.reason !== 'string'
    || !REASON_PATTERN.test(value.reason.trim())
  ) {
    throw requestError(400, 'ATTRIBUTION_CUTOVER_REQUEST_INVALID')
  }
  return {
    expectedEpoch: Number(value.expectedEpoch),
    reason: value.reason.trim(),
  }
}

function parseTargetOwner(
  value: unknown,
): AttributionCutoverTargetOwner | null {
  return value === 'draining' || value === 'new' ? value : null
}

function invalidRequest(
  c: Parameters<typeof errorJson>[0],
  status: 400 | 413 = 400,
  code = 'ATTRIBUTION_CUTOVER_REQUEST_INVALID',
) {
  return errorJson(c, status, '归因切换请求无效', { code })
}

function unavailable(c: Parameters<typeof errorJson>[0]) {
  return errorJson(c, 503, '归因切换控制面暂时不可用', {
    code: 'ATTRIBUTION_CUTOVER_UNAVAILABLE',
  })
}

function requestError(
  status: 400 | 413,
  code: string,
): CutoverRequestError {
  return new CutoverRequestError(status, code)
}

async function remoteCommandKey(
  idempotencyKey: string,
  targetMode: 'bridge' | 'active' | 'fenced',
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(idempotencyKey),
  )
  const hex = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  return `cutover_${targetMode}_${hex}`
}

class CutoverRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: string,
  ) {
    super(code)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
