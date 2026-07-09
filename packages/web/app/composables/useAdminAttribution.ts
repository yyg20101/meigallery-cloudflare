import type { AnalyticsRangeQuery } from '@meigallery/shared'

export type AttributionRangePreset = '7d' | '30d' | '90d' | 'day'

export interface AttributionApiResponse<T> {
  range?: {
    from: string
    to: string
    days: number
  }
  usage?: {
    rowsRead: number
    rowsWritten: number
    durationMs: number
  }
  data: T
}

export const ATTRIBUTION_RANGE_OPTIONS: Array<{ label: string; value: AttributionRangePreset }> = [
  { label: '7 天', value: '7d' },
  { label: '30 天', value: '30d' },
  { label: '90 天', value: '90d' },
  { label: '单日', value: 'day' },
]

export function useAdminAttribution<T>(endpoint: string, initialRange: AttributionRangePreset = '30d') {
  const { api } = useApi()
  const route = useRoute()
  const range = ref<AttributionRangePreset>(normalizeAttributionRangePreset(route.query.range, initialRange))
  const date = ref(initialAttributionDate(route.query.date ?? route.query.from))
  const data = ref<T | null>(null)
  const responseRange = ref<AttributionApiResponse<T>['range'] | null>(null)
  const usage = ref<AttributionApiResponse<T>['usage'] | null>(null)
  const extra = ref<Record<string, unknown>>({})
  const loading = ref(false)
  const error = ref('')
  const loadedAt = ref('')

  async function refresh() {
    loading.value = true
    error.value = ''
    try {
      const result = await api<AttributionApiResponse<T>>(endpoint, {
        query: attributionRangeQuery(range.value, date.value),
      })
      data.value = result.data
      responseRange.value = result.range ?? null
      usage.value = result.usage ?? null
      const { data: _data, range: _range, usage: _usage, ...rest } = result as AttributionApiResponse<T> & Record<string, unknown>
      extra.value = rest
      loadedAt.value = new Date().toISOString()
    } catch (err) {
      error.value = resolveApiErrorMessage(err, '归因数据加载失败')
    } finally {
      loading.value = false
    }
  }

  watch([range, date], () => {
    void refresh()
  })

  onMounted(() => {
    void refresh()
  })

  return {
    range,
    date,
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

export function attributionRangeQuery(range: AttributionRangePreset, date: string): Pick<AnalyticsRangeQuery, 'range' | 'from' | 'to'> {
  if (range === 'day') {
    const day = normalizeDateInput(date) || todayDateInputValue()
    return { from: day, to: day }
  }
  return { range: range as AnalyticsRangeQuery['range'] }
}

export function attributionRouteQuery(range: AttributionRangePreset, date: string): Record<string, string> {
  if (range === 'day') {
    return { range, date: normalizeDateInput(date) || todayDateInputValue() }
  }
  return { range }
}

export function attributionDuplicateRate(duplicate: unknown, total: unknown) {
  const duplicateCount = Math.max(0, Number(duplicate ?? 0))
  const totalCount = Math.max(1, Number(total ?? 0))
  return duplicateCount / totalCount
}

export function normalizeAttributionRangePreset(value: unknown, fallback: AttributionRangePreset = '30d'): AttributionRangePreset {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === '7d' || raw === '30d' || raw === '90d' || raw === 'day') return raw
  return fallback
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
