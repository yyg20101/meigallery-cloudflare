import { WorkerEntrypoint } from 'cloudflare:workers'
import { ATTRIBUTION_CONTRACT_VERSION } from '@meigallery/shared'
import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  parseAttributionEnvironment,
  type AttributionBindings,
  type AttributionEnvironment,
} from './env'
import type { AttributionQueueMessage } from './domain/queue'
import {
  createAdminAttributionRoutes,
  type AdminAttributionActor,
} from './routes/admin'
import { browserAttributionRoutes } from './routes/browser'
import { internalRoutes } from './routes/internal'
import { createAttributionMigrationRoutes } from './routes/migration'
import { runAttributionMaintenance } from './scheduled'
import { consumeAttributionQueue } from './services/queue-consumer'
import {
  readAttributionRuntimeState,
  type AttributionRuntimeMode,
} from './services/runtime-state'
export {
  CandidateValidationWorkflow,
} from './workflows/candidate-validation'

interface AttributionVariables {
  attributionEnvironment: AttributionEnvironment
}

export const app = new Hono<{
  Bindings: AttributionBindings
  Variables: AttributionVariables
}>()

export const attributionServiceApp = new Hono<{
  Bindings: AttributionBindings
  Variables: AttributionVariables
}>()

const parseEnvironment = createMiddleware<{
  Bindings: AttributionBindings
  Variables: AttributionVariables
}>(async (c, next) => {
  try {
    c.set('attributionEnvironment', parseAttributionEnvironment(c.env))
  } catch {
    return c.json({
      service: 'meigallery-attribution',
      status: 'error',
      code: 'ATTRIBUTION_CONFIGURATION_INVALID',
      contractVersion: ATTRIBUTION_CONTRACT_VERSION,
    }, 503)
  }

  await next()
})

app.use('*', parseEnvironment)
attributionServiceApp.use('*', parseEnvironment)

app.get('/health', async (c) => {
  try {
    const runtimeState = await readAttributionRuntimeState(c.env.DB)
    return c.json({
      service: 'meigallery-attribution',
      status: 'ok',
      contractVersion: ATTRIBUTION_CONTRACT_VERSION,
      runtimeMode: runtimeState.mode,
    })
  } catch {
    return c.json({
      service: 'meigallery-attribution',
      status: 'error',
      code: 'ATTRIBUTION_RUNTIME_STATE_UNAVAILABLE',
      contractVersion: ATTRIBUTION_CONTRACT_VERSION,
    }, 503)
  }
})
app.use('/v1/*', requireActiveRuntime(true))
app.route('/', browserAttributionRoutes)

attributionServiceApp.use(
  '/internal/v1/*',
  requireActiveRuntime(false),
)
attributionServiceApp.route('/internal/v1', internalRoutes)
attributionServiceApp.route(
  ATTRIBUTION_SERVICE_BINDING.MIGRATION_PATH_PREFIX,
  createAttributionMigrationRoutes({
    authorize: async request => readServiceBindingActor(request),
  }),
)
attributionServiceApp.route(
  '/admin/attribution',
  createAdminAttributionRoutes({
    authorize: async request => readServiceBindingActor(request),
  }),
)

/**
 * 仅可由 Cloudflare Service Binding 指向的命名入口调用。
 * 公网默认 fetch 不挂载内部事件和管理路由。
 */
export class AttributionServiceEntrypoint
  extends WorkerEntrypoint<AttributionBindings> {
  async fetch(request: Request): Promise<Response> {
    return attributionServiceApp.fetch(request, this.env, this.ctx)
  }
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runScheduledIfActive(controller, env),
    )
  },
  async queue(batch, env) {
    let parsed: AttributionEnvironment
    try {
      parsed = parseAttributionEnvironment(env)
      const state = await readAttributionRuntimeState(env.DB)
      if (state.mode !== 'active') {
        batch.retryAll({ delaySeconds: 300 })
        return
      }
    } catch {
      batch.retryAll({ delaySeconds: 300 })
      return
    }
    await consumeAttributionQueue(batch, {
      db: env.DB,
      appEnvironment: parsed.appEnvironment,
      publicOrigins: parsed.publicOrigins,
      credentialMasterKeys: parsed.credentialMasterKeys,
      dataEncryptionKeys: parsed.dataEncryptionKeys,
    })
  },
} satisfies ExportedHandler<AttributionBindings, AttributionQueueMessage>

function requireActiveRuntime(includeCors: boolean) {
  return createMiddleware<{
    Bindings: AttributionBindings
    Variables: AttributionVariables
  }>(async (c, next) => {
    let runtimeMode: AttributionRuntimeMode
    try {
      runtimeMode = (await readAttributionRuntimeState(c.env.DB)).mode
    } catch {
      return c.json({
        statusCode: 503,
        message: '归因运行状态暂时不可用',
        code: 'ATTRIBUTION_RUNTIME_STATE_UNAVAILABLE',
      }, 503)
    }
    if (runtimeMode !== 'active') {
      const response = c.json({
        statusCode: 503,
        message: '归因运行时尚未激活',
        code: 'ATTRIBUTION_NOT_ACTIVE',
        runtimeMode,
      }, 503)
      if (includeCors) applyRuntimeGateCors(
        response.headers,
        c.req.header('Origin'),
        c.get('attributionEnvironment'),
      )
      return response
    }
    await next()
  })
}

async function runScheduledIfActive(
  controller: ScheduledController,
  env: AttributionBindings,
) {
  let parsed: AttributionEnvironment
  try {
    parsed = parseAttributionEnvironment(env)
    const state = await readAttributionRuntimeState(env.DB)
    if (state.mode !== 'active') return
  } catch {
    return
  }
  const task = controller.cron === '17 3 * * *'
    ? 'daily'
    : 'interval'
  await runAttributionMaintenance({
    db: env.DB,
    queues: parsed.queues,
    credentialMasterKeys: parsed.credentialMasterKeys,
  }, new Date(controller.scheduledTime), task)
}

function applyRuntimeGateCors(
  headers: Headers,
  origin: string | undefined,
  environment: AttributionEnvironment,
) {
  if (!origin || !environment.publicOrigins.includes(origin)) return
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Credentials', 'true')
  headers.set('Vary', 'Origin')
}

function readServiceBindingActor(
  request: Request,
): AdminAttributionActor | null {
  const actorId = Number(request.headers.get(
    ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ID,
  ))
  const role = request.headers.get(
    ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ROLE,
  )
  const requestId = request.headers.get(
    ATTRIBUTION_SERVICE_BINDING.HEADERS.REQUEST_ID,
  )
  if (
    !Number.isSafeInteger(actorId)
    || actorId <= 0
    || (role !== 'admin' && role !== 'owner')
    || !requestId
    || !/^[A-Za-z0-9:_-]{16,160}$/.test(requestId)
  ) {
    return null
  }
  return {
    actorId,
    role: role === 'admin' ? 'admin' : 'owner',
  }
}
