import { Hono } from 'hono'
import type { Context } from 'hono'
import { ANALYTICS_LIMITS } from '@meigallery/shared/constants'
import type { Bindings, Variables } from '../index'
import { AnalyticsIngestError, ingestAnalyticsBatch, normalizeSessionEndPayload } from '../services/analytics-ingest'
import { errorJson } from '../utils/api-error'

export const analyticsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

analyticsRoutes.post('/events', async (c) => {
  const parsed = await readAnalyticsBody(c)
  if ('error' in parsed) return parsed.error

  try {
    const result = await ingestAnalyticsBatch(c.env, {
      body: parsed.body,
      bodySizeBytes: parsed.bodySizeBytes,
      userId: c.get('userId'),
      currentHost: new URL(c.req.url).hostname,
      country: c.req.header('CF-IPCountry') || '',
      appEnv: c.env.APP_ENV,
    })
    return c.json(stripUsage(result), analyticsStatus(result))
  } catch (error) {
    return analyticsError(c, error)
  }
})

analyticsRoutes.post('/session/end', async (c) => {
  const parsed = await readAnalyticsBody(c)
  if ('error' in parsed) return parsed.error

  const body = normalizeSessionEndPayload(parsed.body)
  try {
    const result = await ingestAnalyticsBatch(c.env, {
      body,
      bodySizeBytes: parsed.bodySizeBytes,
      userId: c.get('userId'),
      currentHost: new URL(c.req.url).hostname,
      country: c.req.header('CF-IPCountry') || '',
      appEnv: c.env.APP_ENV,
    })
    return c.json(stripUsage(result), analyticsStatus(result))
  } catch (error) {
    return analyticsError(c, error)
  }
})

async function readAnalyticsBody(c: Context) {
  const raw = await c.req.text()
  const bodySizeBytes = new TextEncoder().encode(raw).byteLength
  if (bodySizeBytes > ANALYTICS_LIMITS.BATCH_BODY_LIMIT_BYTES) {
    return {
      error: errorJson(c, 413, '分析上报内容不能超过 16KB', { code: 'ANALYTICS_PAYLOAD_TOO_LARGE' }),
    }
  }

  try {
    return {
      body: raw ? JSON.parse(raw) : {},
      bodySizeBytes,
    }
  } catch {
    return {
      error: errorJson(c, 400, '分析上报内容必须是有效 JSON', { code: 'ANALYTICS_JSON_INVALID' }),
    }
  }
}

function analyticsStatus(result: { accepted: number; rejected: number; disabled?: boolean }) {
  if (result.disabled) return 200
  if (result.accepted === 0 && result.rejected > 0) return 400
  if (result.rejected > 0) return 202
  return 200
}

function stripUsage<T extends { usage?: unknown }>(result: T): Omit<T, 'usage'> {
  const { usage: _usage, ...body } = result
  return body
}

function analyticsError(c: Context, error: unknown) {
  if (error instanceof AnalyticsIngestError) {
    return errorJson(c, error.status, error.message, { code: error.code, detail: error.detail })
  }
  throw error
}
