import { ATTRIBUTION_CONTRACT_VERSION } from '@meigallery/shared'
import { Hono } from 'hono'
import {
  parseAttributionEnvironment,
  type AttributionBindings,
  type AttributionEnvironment,
} from './env'
import type { AttributionQueueMessage } from './domain/queue'
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

app.use('*', async (c, next) => {
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

app.get('/health', c => c.json({
  service: 'meigallery-attribution',
  status: 'ok',
  contractVersion: ATTRIBUTION_CONTRACT_VERSION,
}))
app.route('/internal/v1', internalRoutes)

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
      ? 'credentials'
      : 'queue'
    ctx.waitUntil(
      runAttributionMaintenance({
        db: env.DB,
        queues: parsed.queues,
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
