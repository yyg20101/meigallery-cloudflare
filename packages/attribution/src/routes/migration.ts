import type {
  AttributionMigrationSnapshotV1,
} from '@meigallery/shared'
import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'
import { Hono } from 'hono'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import {
  AttributionMigrationError,
  importAttributionMigrationSnapshot,
  readAttributionMigrationImportResult,
  type AttributionMigrationImportEnvironment,
  type AttributionMigrationImportRequest,
} from '../services/migration-import'

interface MigrationActor {
  actorId: number
  role: 'admin' | 'owner'
}

interface MigrationVariables {
  attributionEnvironment: AttributionEnvironment
  attributionMigrationActor: MigrationActor
}

interface MigrationRouteOptions {
  authorize: (
    request: Request,
    bindings: AttributionBindings,
  ) => Promise<MigrationActor | null>
  importSnapshot?: (
    environment: AttributionMigrationImportEnvironment,
    request: AttributionMigrationImportRequest,
  ) => Promise<unknown>
  readResult?: typeof readAttributionMigrationImportResult
}

type MigrationRouteEnvironment = {
  Bindings: AttributionBindings
  Variables: MigrationVariables
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/

export function createAttributionMigrationRoutes(
  options: MigrationRouteOptions,
) {
  const routes = new Hono<MigrationRouteEnvironment>()
  const importSnapshot = options.importSnapshot
    ?? importAttributionMigrationSnapshot
  const readResult = options.readResult
    ?? readAttributionMigrationImportResult

  routes.use('*', async (c, next) => {
    let actor: MigrationActor | null
    try {
      actor = await options.authorize(c.req.raw, c.env)
    } catch {
      actor = null
    }
    if (!actor) return c.notFound()
    if (actor.role !== 'owner') {
      return migrationErrorResponse(
        c,
        403,
        'ATTRIBUTION_MIGRATION_OWNER_REQUIRED',
      )
    }
    c.set('attributionMigrationActor', actor)
    await next()
  })

  routes.post('/import', async (c) => {
    let body: MigrationBody | null = null
    try {
      body = parseMigrationBody(await readBoundedJson(c.req.raw))
      const idempotencyKey = c.req.header('Idempotency-Key') ?? ''
      if (idempotencyKey !== body.runId) {
        return migrationErrorResponse(
          c,
          400,
          'ATTRIBUTION_MIGRATION_IDEMPOTENCY_KEY_INVALID',
        )
      }
      const actor = c.get('attributionMigrationActor')
      const environment = c.get('attributionEnvironment')
      const result = await importSnapshot({
        db: c.env.DB,
        credentialKeys: environment.credentialMasterKeys,
      }, {
        runId: body.runId,
        actorId: actor.actorId,
        snapshot: body.snapshot,
      })
      return c.json({ data: result })
    } catch (error) {
      return migrationFailureResponse(c, error)
    } finally {
      clearMigrationBodySecrets(body)
    }
  })

  routes.get('/imports/:runId', async (c) => {
    const runId = c.req.param('runId')
    if (!IDENTIFIER_PATTERN.test(runId)) {
      return migrationErrorResponse(
        c,
        400,
        'ATTRIBUTION_MIGRATION_INPUT_INVALID',
      )
    }
    try {
      const result = await readResult(c.env.DB, runId)
      if (!result) {
        return migrationErrorResponse(
          c,
          404,
          'ATTRIBUTION_MIGRATION_NOT_FOUND',
        )
      }
      return c.json({ data: result })
    } catch (error) {
      return migrationFailureResponse(c, error)
    }
  })

  return routes
}

interface MigrationBody {
  runId: string
  snapshot: AttributionMigrationSnapshotV1
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (
      !Number.isSafeInteger(size)
      || size < 0
      || size > ATTRIBUTION_SERVICE_BINDING.MIGRATION_MAX_BODY_BYTES
    ) {
      throw routeError(
        413,
        'ATTRIBUTION_MIGRATION_BODY_TOO_LARGE',
      )
    }
  }
  const raw = await request.arrayBuffer()
  if (
    raw.byteLength
    > ATTRIBUTION_SERVICE_BINDING.MIGRATION_MAX_BODY_BYTES
  ) {
    throw routeError(413, 'ATTRIBUTION_MIGRATION_BODY_TOO_LARGE')
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw routeError(400, 'ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
}

function parseMigrationBody(value: unknown): MigrationBody {
  if (!isRecord(value)) {
    throw routeError(400, 'ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
  const keys = Object.keys(value)
  if (
    keys.length !== 2
    || !keys.includes('runId')
    || !keys.includes('snapshot')
    || typeof value.runId !== 'string'
    || !IDENTIFIER_PATTERN.test(value.runId)
    || !isRecord(value.snapshot)
  ) {
    throw routeError(400, 'ATTRIBUTION_MIGRATION_INPUT_INVALID')
  }
  return {
    runId: value.runId,
    snapshot: value.snapshot as unknown as AttributionMigrationSnapshotV1,
  }
}

function clearMigrationBodySecrets(value: MigrationBody | null): void {
  const snapshot = value?.snapshot
  if (!snapshot || snapshot.phase !== 'initial') return
  const connections = snapshot.connections
  if (!Array.isArray(connections)) return
  for (const connection of connections) {
    if (
      isRecord(connection)
      && isRecord(connection.credential)
      && typeof connection.credential.plaintext === 'string'
    ) {
      connection.credential.plaintext = ''
    }
  }
}

function migrationFailureResponse(
  c: Parameters<typeof migrationErrorResponse>[0],
  error: unknown,
) {
  if (error instanceof MigrationRouteError) {
    return migrationErrorResponse(c, error.status, error.code)
  }
  if (error instanceof AttributionMigrationError) {
    if (error.code === 'ATTRIBUTION_MIGRATION_INPUT_INVALID') {
      return migrationErrorResponse(c, 400, error.code)
    }
    if (
      error.code === 'ATTRIBUTION_MIGRATION_IDEMPOTENCY_CONFLICT'
      || error.code === 'ATTRIBUTION_MIGRATION_RUNTIME_MODE_INVALID'
      || error.code === 'ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY'
      || error.code === 'ATTRIBUTION_MIGRATION_SOURCE_CHANGED'
      || error.code === 'ATTRIBUTION_MIGRATION_ALREADY_RECONCILED'
      || error.code === 'ATTRIBUTION_MIGRATION_INITIAL_IMPORT_MISSING'
    ) {
      return migrationErrorResponse(c, 409, error.code)
    }
  }
  return migrationErrorResponse(
    c,
    503,
    'ATTRIBUTION_MIGRATION_UNAVAILABLE',
  )
}

function migrationErrorResponse(
  c: {
    json: (
      body: unknown,
      status: 400 | 403 | 404 | 409 | 413 | 503,
    ) => Response
  },
  status: 400 | 403 | 404 | 409 | 413 | 503,
  code: string,
) {
  return c.json({ error: { code } }, status)
}

function routeError(
  status: 400 | 413,
  code: string,
): MigrationRouteError {
  return new MigrationRouteError(status, code)
}

class MigrationRouteError extends Error {
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
