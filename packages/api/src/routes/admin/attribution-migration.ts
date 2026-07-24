import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireOwner } from '../../middleware/auth'
import {
  AttributionMigrationExportError,
  exportAndImportAttributionMigration,
} from '../../services/attribution-migration-export'
import { errorJson } from '../../utils/api-error'
import { writeAuditLog } from '../../utils/permission'

type MigrationRouteEnvironment = {
  Bindings: Bindings
  Variables: Variables
}

interface MigrationRouteOptions {
  runMigration?: typeof exportAndImportAttributionMigration
  writeAudit?: typeof writeAuditLog
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const MAX_BODY_BYTES = 4 * 1024

export function createAdminAttributionMigrationRoutes(
  options: MigrationRouteOptions = {},
) {
  const routes = new Hono<MigrationRouteEnvironment>()
  const runMigration = options.runMigration
    ?? exportAndImportAttributionMigration
  const audit = options.writeAudit ?? writeAuditLog

  routes.use('*', requireOwner)
  routes.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })

  routes.post('/', async (c) => {
    const actorId = c.get('userId')
    if (!Number.isSafeInteger(actorId) || Number(actorId) <= 0) {
      return errorJson(c, 401, '请先登录', {
        code: 'AUTH_REQUIRED',
      })
    }

    try {
      const body = parseBody(await readBoundedJson(c.req.raw))
      if (c.req.header('Idempotency-Key') !== body.runId) {
        return invalidRequest(c)
      }
      const result = await runMigration(c.env, {
        runId: body.runId,
        actorId: Number(actorId),
        phase: body.phase,
        initialRunId: body.initialRunId,
      })
      await audit(c.env.DB, {
        adminId: Number(actorId),
        action: 'attribution.runtime.migrate',
        targetType: 'attribution_runtime',
        targetId: body.runId,
        afterValue: {
          runId: result.runId,
          phase: result.phase,
          snapshotHash: result.snapshotHash,
          sourceConfigurationHash: result.sourceConfigurationHash,
          capturedAt: result.capturedAt,
          replayed: result.replayed,
          counts: result.counts,
        },
      })
      return c.json({ data: result })
    } catch (error) {
      if (error instanceof MigrationRequestError) {
        return errorJson(c, error.status, '归因迁移请求无效', {
          code: error.code,
        })
      }
      if (error instanceof AttributionMigrationExportError) {
        if (
          error.code === 'ATTRIBUTION_MIGRATION_OPTIONS_INVALID'
          || error.code === 'ATTRIBUTION_MIGRATION_INPUT_INVALID'
        ) {
          return invalidRequest(c)
        }
        if (
          error.code === 'ATTRIBUTION_MIGRATION_IDEMPOTENCY_CONFLICT'
          || error.code === 'ATTRIBUTION_MIGRATION_RUNTIME_MODE_INVALID'
          || error.code === 'ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY'
          || error.code === 'ATTRIBUTION_MIGRATION_SOURCE_CHANGED'
          || error.code === 'ATTRIBUTION_MIGRATION_ALREADY_RECONCILED'
          || error.code
            === 'ATTRIBUTION_MIGRATION_INITIAL_IMPORT_MISSING'
        ) {
          return errorJson(c, 409, '归因迁移状态冲突', {
            code: error.code,
          })
        }
      }
      return errorJson(c, 503, '归因迁移暂时不可用', {
        code: 'ATTRIBUTION_MIGRATION_UNAVAILABLE',
      })
    }
  })

  return routes
}

export const adminAttributionMigrationRoutes =
  createAdminAttributionMigrationRoutes()

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
        'ATTRIBUTION_MIGRATION_REQUEST_TOO_LARGE',
      )
    }
  }
  const raw = await request.arrayBuffer()
  if (raw.byteLength > MAX_BODY_BYTES) {
    throw requestError(
      413,
      'ATTRIBUTION_MIGRATION_REQUEST_TOO_LARGE',
    )
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw requestError(400, 'ATTRIBUTION_MIGRATION_REQUEST_INVALID')
  }
}

function parseBody(value: unknown): {
  runId: string
  phase: 'initial' | 'reconcile'
  initialRunId?: string
} {
  if (
    !isRecord(value)
    || typeof value.runId !== 'string'
    || !IDENTIFIER_PATTERN.test(value.runId)
  ) {
    throw requestError(400, 'ATTRIBUTION_MIGRATION_REQUEST_INVALID')
  }
  const phase = value.phase ?? 'initial'
  if (
    (phase !== 'initial' && phase !== 'reconcile')
    || (
      phase === 'initial'
        ? (
          value.initialRunId !== undefined
          || Object.keys(value).some(key =>
            !['runId', 'phase'].includes(key))
        )
        : (
          typeof value.initialRunId !== 'string'
          || !IDENTIFIER_PATTERN.test(value.initialRunId)
          || Object.keys(value).some(key =>
            !['runId', 'phase', 'initialRunId'].includes(key))
        )
    )
  ) {
    throw requestError(400, 'ATTRIBUTION_MIGRATION_REQUEST_INVALID')
  }
  return phase === 'initial'
    ? { runId: value.runId, phase }
    : {
      runId: value.runId,
      phase,
      initialRunId: value.initialRunId as string,
    }
}

function invalidRequest(c: Parameters<typeof errorJson>[0]) {
  return errorJson(c, 400, '归因迁移请求无效', {
    code: 'ATTRIBUTION_MIGRATION_REQUEST_INVALID',
  })
}

function requestError(
  status: 400 | 413,
  code: string,
): MigrationRequestError {
  return new MigrationRequestError(status, code)
}

class MigrationRequestError extends Error {
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
