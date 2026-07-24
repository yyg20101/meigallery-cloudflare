import { ATTRIBUTION_CONTRACT_VERSION } from '@meigallery/shared'
import { Hono } from 'hono'
import {
  parseAttributionEnvironment,
  type AttributionBindings,
  type AttributionEnvironment,
} from './env'

interface AttributionVariables {
  attributionEnvironment: AttributionEnvironment
}

const app = new Hono<{
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

export default app
