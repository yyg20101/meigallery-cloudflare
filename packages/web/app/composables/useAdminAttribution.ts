import type {
  AdPlatformProvider,
  AnalyticsRangeQuery,
} from '@meigallery/shared'
import type { ComputedRef, Ref } from 'vue'

export type AttributionRangePreset = '7d' | '30d' | '90d' | 'day'
export type AttributionDashboardProvider = AdPlatformProvider
export type EvidenceLayer = 'business' | 'browser' | 'server' | 'quality'

export interface AdPlatformEventBindingData {
  canonicalEvent: 'Contact' | 'CompleteRegistration'
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface AdPlatformConnectionData {
  connectionId: string
  provider: AdPlatformProvider
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  publicConfig: Record<string, string>
  eventBindings: AdPlatformEventBindingData[]
  credential: {
    configured: true
    type: 'access_token' | 'service_account_json'
  }
}

export interface AdPlatformDiagnosticData {
  provider: AdPlatformProvider
  ok: true
  testedAt: string
  testEventsSent: number
  externalEventIds: string[]
  requestIds: string[]
}

export interface AttributionDeliveryMetrics {
  browserAttempted: number
  server: {
    planned: number
    queued: number
    accepted: number
    processed: number
    retrying: number
    rejected: number
    deadLetter: number
    cancelled: number
  }
  queueRetryCount: number
  queueEnqueueCount: number
}

export interface AttributionBusinessMetrics {
  contactCount: number
  completeRegistrationCount: number
  factCount: number
}

export interface AttributionSummaryData {
  provider: AttributionDashboardProvider
  business: AttributionBusinessMetrics
  delivery: AttributionDeliveryMetrics
  routing: {
    totalFactCount: number
    attributedFactCount: number
    unattributedFactCount: number
    conflictFactCount: number
    byProvider: Record<AdPlatformProvider, number>
  }
}

export interface AttributionTrendRow {
  date: string
  business: AttributionBusinessMetrics
  delivery: AttributionDeliveryMetrics
}

export interface AttributionTrendsData {
  provider: AttributionDashboardProvider
  granularity: 'day'
  rows: AttributionTrendRow[]
}

export interface AttributionMatchMetric {
  availability: 'available' | 'unavailable'
  numerator: number
  denominator: number
  rate: number | null
}

export interface AttributionRateRow extends AttributionMatchMetric {
  date: string
}

export interface PlatformQualityRow {
  date: string
  canonicalEvent: string
  metricKey: string
  value: number | null
  availability: 'available' | 'error' | 'unavailable'
  status: string
  errorCategory: string
  collectedAt: string
}

export interface AttributionQualityData {
  provider: AttributionDashboardProvider
  pairing: {
    summary: AttributionMatchMetric
    rows: AttributionRateRow[]
  }
  match: {
    summary: AttributionMatchMetric
    signals: Array<{ key: string } & AttributionMatchMetric>
    rows: AttributionRateRow[]
  }
  platformQuality: {
    availability: 'available' | 'error' | 'unavailable'
    latest: PlatformQualityRow | null
    rows: PlatformQualityRow[]
  }
}

export interface AttributionCapacityData {
  date: string
  timeZone: 'Asia/Shanghai'
  note: string
  inputs: {
    factCount: number
    deliveryCount: number
    browserAttemptCount: number
    serverDeliveryCount: number
    adapterAttemptCount: number
    queueAttemptCount: number
    terminalServerDeliveryCount: number
    providerReceiptCount: number
    workflowStepCount: number
  }
  metrics: Record<'workerRequests' | 'queueOperations' | 'd1RowsRead' | 'd1RowsWritten' | 'workflowSteps' | 'serverConversions', {
    value: number
    safetyLimit: number
    ratio: number
    warning: boolean
  }>
}

export interface AttributionRangeState {
  range: Ref<AttributionRangePreset>
  date: Ref<string>
  query: ComputedRef<Pick<AnalyticsRangeQuery, 'range' | 'from' | 'to'>>
  queryKey: ComputedRef<string>
}

export interface AttributionApiResponse<T> {
  range?: { from: string; to: string; days: number }
  usage?: { rowsRead: number; rowsWritten: number; durationMs: number }
  data: T
}

export const ATTRIBUTION_RANGE_OPTIONS: Array<{ label: string; value: AttributionRangePreset }> = [
  { label: '7 天', value: '7d' },
  { label: '30 天', value: '30d' },
  { label: '90 天', value: '90d' },
  { label: '单日', value: 'day' },
]

export function useAdminAttributionRange(initialRange: AttributionRangePreset = '7d'): AttributionRangeState {
  const route = useRoute()
  const router = useRouter()
  const state = useState('admin-attribution-range-v2', () => ({
    range: normalizeAttributionRangePreset(route.query.range, rangeFromDates(route.query.from, route.query.to) ?? initialRange),
    date: initialAttributionDate(route.query.date ?? route.query.from),
  }))
  let syncingRoute = false

  const replaceRouteRange = async (nextRange: AttributionRangePreset, nextDate: string) => {
    if (syncingRoute) return
    const query = { ...route.query }
    delete query.range
    delete query.date
    delete query.from
    delete query.to
    Object.assign(query, attributionRouteQuery(nextRange, nextDate))
    await router.replace({ query })
  }

  const range = computed<AttributionRangePreset>({
    get: () => state.value.range,
    set: (value) => {
      const normalized = normalizeAttributionRangePreset(value, '7d')
      state.value.range = normalized
      void replaceRouteRange(normalized, state.value.date)
    },
  })
  const date = computed<string>({
    get: () => state.value.date,
    set: (value) => {
      state.value.date = normalizeDateInput(value) || todayDateInputValue()
      if (state.value.range === 'day') void replaceRouteRange('day', state.value.date)
    },
  })
  const query = computed(() => attributionRangeQuery(range.value, date.value))
  const queryKey = computed(() => JSON.stringify(query.value))

  watch(
    () => [route.query.range, route.query.date, route.query.from, route.query.to] as const,
    ([routeRange, routeDate, from, to]) => {
      syncingRoute = true
      const singleDay = rangeFromDates(from, to)
      state.value.range = normalizeAttributionRangePreset(routeRange, singleDay ?? initialRange)
      state.value.date = initialAttributionDate(routeDate ?? from)
      syncingRoute = false
    },
  )

  onMounted(() => {
    if (!route.query.range && !route.query.from && !route.query.to) {
      void replaceRouteRange(range.value, date.value)
    }
  })

  return { range, date, query, queryKey }
}

export function useAdminAttribution<T>(
  endpoint: string,
  options: {
    rangeState?: AttributionRangeState
    autoRefresh?: boolean
    query?: Record<string, string | number | undefined> | ComputedRef<Record<string, string | number | undefined>>
  } = {},
) {
  const { api } = useApi()
  const rangeState = options.rangeState ?? useAdminAttributionRange()
  const data = ref<T | null>(null)
  const responseRange = ref<AttributionApiResponse<T>['range'] | null>(null)
  const usage = ref<AttributionApiResponse<T>['usage'] | null>(null)
  const extra = ref<Record<string, unknown>>({})
  const loading = ref(false)
  const error = ref('')
  const loadedAt = ref('')
  let requestRevision = 0

  const extraQuery = computed<Record<string, string | number | undefined>>(() => {
    const value = options.query
    return (value && 'value' in value ? value.value : value ?? {}) as Record<string, string | number | undefined>
  })
  const refreshKey = computed(() => JSON.stringify([rangeState.query.value, extraQuery.value]))

  async function refresh() {
    const revision = ++requestRevision
    loading.value = true
    error.value = ''
    try {
      const result = await api<AttributionApiResponse<T>>(endpoint, {
        query: { ...rangeState.query.value, ...extraQuery.value },
      })
      if (revision !== requestRevision) return
      data.value = result.data
      responseRange.value = result.range ?? null
      usage.value = result.usage ?? null
      const { data: _data, range: _range, usage: _usage, ...rest } = result as AttributionApiResponse<T> & Record<string, unknown>
      extra.value = rest
      loadedAt.value = new Date().toISOString()
    }
    catch (err) {
      if (revision === requestRevision) error.value = resolveApiErrorMessage(err, '归因数据加载失败')
    }
    finally {
      if (revision === requestRevision) loading.value = false
    }
  }

  if (options.autoRefresh !== false) {
    watch(refreshKey, () => void refresh())
    onMounted(() => void refresh())
  }

  return {
    range: rangeState.range,
    date: rangeState.date,
    query: rangeState.query,
    responseRange,
    usage,
    extra,
    data,
    loading,
    error,
    loadedAt,
    refresh,
  }
}

export function useAdminAttributionPlatforms() {
  const { api } = useApi()
  const connections = ref<AdPlatformConnectionData[]>([])
  const diagnostics = ref<Partial<Record<AdPlatformProvider, AdPlatformDiagnosticData | null>>>({})
  const loading = ref(false)
  const saving = ref(false)
  const testing = ref(false)
  const error = ref('')
  const message = ref('')

  async function refreshConnections() {
    loading.value = true
    error.value = ''
    try {
      const result = await api<AttributionApiResponse<AdPlatformConnectionData[]>>('/api/admin/attribution/platforms')
      connections.value = result.data
    }
    catch (cause) {
      error.value = resolveApiErrorMessage(cause, '平台连接加载失败')
    }
    finally {
      loading.value = false
    }
  }

  async function saveConnection(provider: AdPlatformProvider, body: Record<string, unknown>) {
    saving.value = true
    error.value = ''
    message.value = ''
    try {
      const result = await api<AttributionApiResponse<AdPlatformConnectionData>>(`/api/admin/attribution/platforms/${provider}`, {
        method: 'PATCH',
        body,
      })
      const index = connections.value.findIndex(item => item.provider === provider)
      if (index >= 0) connections.value.splice(index, 1, result.data)
      else connections.value.push(result.data)
      diagnostics.value[provider] = null
      message.value = '连接已保存'
      return result.data
    }
    catch (cause) {
      error.value = resolveApiErrorMessage(cause, '平台连接保存失败')
      throw cause
    }
    finally {
      saving.value = false
    }
  }

  async function testConnection(provider: AdPlatformProvider, testEventCode = '') {
    testing.value = true
    error.value = ''
    message.value = ''
    try {
      const code = testEventCode.trim()
      const result = await api<AttributionApiResponse<AdPlatformDiagnosticData>>(
        `/api/admin/attribution/platforms/${provider}/test`,
        {
          method: 'POST',
          body: code ? { testEventCode: code } : {},
        },
      )
      diagnostics.value[provider] = result.data
      message.value = '连接测试通过'
      return result.data
    }
    catch (cause) {
      diagnostics.value[provider] = null
      error.value = resolveApiErrorMessage(cause, '连接测试失败')
      throw cause
    }
    finally {
      testing.value = false
    }
  }

  function clearFeedback() {
    error.value = ''
    message.value = ''
  }

  return {
    connections,
    diagnostics,
    loading,
    saving,
    testing,
    error,
    message,
    refreshConnections,
    saveConnection,
    testConnection,
    clearFeedback,
  }
}

export function attributionRangeQuery(range: AttributionRangePreset, date: string): Pick<AnalyticsRangeQuery, 'range' | 'from' | 'to'> {
  if (range === 'day') {
    const day = normalizeDateInput(date) || todayDateInputValue()
    return { from: day, to: day }
  }
  return { range: range as AnalyticsRangeQuery['range'] }
}

export function attributionRouteQuery(range: AttributionRangePreset, date: string): Record<string, string> {
  if (range === 'day') {
    const day = normalizeDateInput(date) || todayDateInputValue()
    return { range, date: day }
  }
  return { range }
}

export function attributionDuplicateRate(duplicate: unknown, total: unknown) {
  const duplicateCount = Math.max(0, Number(duplicate ?? 0))
  const totalCount = Math.max(1, Number(total ?? 0))
  return duplicateCount / totalCount
}

export function normalizeAttributionRangePreset(value: unknown, fallback: AttributionRangePreset = '7d'): AttributionRangePreset {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === '7d' || raw === '30d' || raw === '90d' || raw === 'day') return raw
  return fallback
}

function rangeFromDates(from: unknown, to: unknown): AttributionRangePreset | null {
  const normalizedFrom = normalizeDateInput(Array.isArray(from) ? from[0] : from)
  const normalizedTo = normalizeDateInput(Array.isArray(to) ? to[0] : to)
  return normalizedFrom && normalizedFrom === normalizedTo ? 'day' : null
}

function initialAttributionDate(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  return normalizeDateInput(raw) || todayDateInputValue()
}

function normalizeDateInput(value: unknown) {
  const text = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

function todayDateInputValue() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}
