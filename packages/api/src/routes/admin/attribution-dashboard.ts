import { Hono, type Context } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  isAttributionBreakdownDimension,
  isAttributionDashboardProvider,
  queryAttributionBreakdown,
  queryAttributionCapacity,
  queryAttributionConversions,
  queryAttributionQuality,
  queryAttributionSummary,
  queryAttributionTrends,
} from '../../services/attribution-dashboard'
import { errorJson } from '../../utils/api-error'
import { parseAnalyticsRange, type AnalyticsDateRange } from '../../utils/analytics-time'

type AdminAttributionDashboardContext = Context<{ Bindings: Bindings; Variables: Variables }>

export const adminAttributionDashboardRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAttributionDashboardRoutes.get('/summary', async (c) => {
  const input = readScopedQuery(c)
  if (input instanceof Response) return input
  return dashboardQuery(c, () => queryAttributionSummary(c.env.DB, input.range, input.provider), input.range)
})

adminAttributionDashboardRoutes.get('/trends', async (c) => {
  const input = readScopedQuery(c)
  if (input instanceof Response) return input
  if ((c.req.query('granularity') || 'day') !== 'day') {
    return errorJson(c, 400, '归因趋势粒度无效', {
      code: 'ATTRIBUTION_TREND_GRANULARITY_INVALID',
    })
  }
  return dashboardQuery(c, () => queryAttributionTrends(c.env.DB, input.range, input.provider), input.range)
})

adminAttributionDashboardRoutes.get('/quality', async (c) => {
  const input = readScopedQuery(c)
  if (input instanceof Response) return input
  return dashboardQuery(c, () => queryAttributionQuality(c.env.DB, input.range, input.provider), input.range)
})

adminAttributionDashboardRoutes.get('/capacity', async (c) => {
  const date = c.req.query('date') || new Date().toISOString().slice(0, 10)
  const parsedDate = new Date(`${date}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== date) {
    return errorJson(c, 400, '容量估算日期无效', { code: 'ATTRIBUTION_CAPACITY_DATE_INVALID' })
  }
  return dashboardQuery(c, () => queryAttributionCapacity(c.env.DB, date))
})

adminAttributionDashboardRoutes.get('/breakdown', async (c) => {
  const input = readScopedQuery(c)
  if (input instanceof Response) return input
  const dimension = c.req.query('dimension')
  if (!isAttributionBreakdownDimension(dimension)) {
    return errorJson(c, 400, '归因拆分维度无效', {
      code: 'ATTRIBUTION_BREAKDOWN_DIMENSION_INVALID',
    })
  }
  const limit = boundedInteger(c.req.query('limit'), 50, 1, 100)
  if (limit === null) {
    return errorJson(c, 400, '归因拆分数量无效', {
      code: 'ATTRIBUTION_BREAKDOWN_LIMIT_INVALID',
    })
  }
  return dashboardQuery(c, () => queryAttributionBreakdown(
    c.env.DB,
    input.range,
    dimension,
    limit,
    input.provider,
  ), input.range)
})

adminAttributionDashboardRoutes.get('/conversions', async (c) => {
  const input = readScopedQuery(c)
  if (input instanceof Response) return input
  const sourceFilter = normalizedQueryValue(c.req.query('sourceCode'))
    || normalizedQueryValue(c.req.query('sourceName'))
    || normalizedQueryValue(c.req.query('source'))
  return dashboardQuery(c, () => queryAttributionConversions(
    c.env.DB,
    input.range,
    input.provider,
    sourceFilter,
  ), input.range)
})

function readScopedQuery(c: AdminAttributionDashboardContext) {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range
  const provider = c.req.query('provider')
  if (!isAttributionDashboardProvider(provider)) {
    return errorJson(c, 400, '归因平台无效', { code: 'ATTRIBUTION_PROVIDER_INVALID' })
  }
  return { range, provider }
}

function parseRangeOrError(c: AdminAttributionDashboardContext): AnalyticsDateRange | Response {
  try {
    return parseAnalyticsRange({
      range: c.req.query('range'),
      from: c.req.query('from'),
      to: c.req.query('to'),
    })
  }
  catch (error) {
    return errorJson(c, 400, error instanceof Error ? error.message : '分析日期范围无效', {
      code: 'ANALYTICS_RANGE_INVALID',
    })
  }
}

async function dashboardQuery<T extends object>(
  c: AdminAttributionDashboardContext,
  query: () => Promise<T>,
  range?: AnalyticsDateRange,
) {
  try {
    const result = await query()
    return c.json(range ? { range, ...result } : result)
  }
  catch {
    return errorJson(c, 503, '归因看板数据暂时不可用', {
      code: 'ATTRIBUTION_DASHBOARD_UNAVAILABLE',
    })
  }
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return parsed >= minimum && parsed <= maximum ? parsed : null
}

function normalizedQueryValue(value: string | undefined) {
  const text = String(value ?? '').trim()
  return text && text !== 'all' ? text : ''
}
