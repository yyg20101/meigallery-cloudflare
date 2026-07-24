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
import { runAttributionMaintenance } from './scheduled'
import { consumeAttributionQueue } from './services/queue-consumer'
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

app.get('/health', c => c.json({
  service: 'meigallery-attribution',
  status: 'ok',
  contractVersion: ATTRIBUTION_CONTRACT_VERSION,
}))
app.route('/', browserAttributionRoutes)

attributionServiceApp.route('/internal/v1', internalRoutes)
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
    let parsed: AttributionEnvironment
    try {
      parsed = parseAttributionEnvironment(env)
    } catch {
      return
    }
    const task = controller.cron === '17 3 * * *'
      ? 'daily'
      : 'interval'
    ctx.waitUntil(
      runAttributionMaintenance({
        db: env.DB,
        queues: parsed.queues,
        credentialMasterKeys: parsed.credentialMasterKeys,
      }, new Date(controller.scheduledTime), task),
    )
  },
  async queue(batch, env) {
    let parsed: AttributionEnvironment
    try {
      parsed = parseAttributionEnvironment(env)
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
