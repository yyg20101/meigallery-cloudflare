import type { AnalyticsRangeQuery } from '@meigallery/shared'

export type AnalyticsRangePreset = NonNullable<AnalyticsRangeQuery['range']>
export type AnalyticsExportKind = 'overview' | 'sources' | 'pages' | 'paths' | 'clicks' | 'durations' | 'invites' | 'sessions'

export interface AnalyticsApiResponse<T> {
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

export const ANALYTICS_RANGE_OPTIONS: Array<{ label: string; value: AnalyticsRangePreset }> = [
  { label: '7 天', value: '7d' },
  { label: '30 天', value: '30d' },
  { label: '90 天', value: '90d' },
]

export function useAdminAnalytics<T>(endpoint: string, initialRange: AnalyticsRangePreset = '30d') {
  const { api } = useApi()
  const range = ref<AnalyticsRangePreset>(initialRange)
  const data = ref<T | null>(null)
  const responseRange = ref<AnalyticsApiResponse<T>['range'] | null>(null)
  const usage = ref<AnalyticsApiResponse<T>['usage'] | null>(null)
  const extra = ref<Record<string, unknown>>({})
  const loading = ref(false)
  const error = ref('')
  const loadedAt = ref('')

  async function refresh() {
    loading.value = true
    error.value = ''
    try {
      const result = await api<AnalyticsApiResponse<T>>(endpoint, {
        query: { range: range.value },
      })
      data.value = result.data
      responseRange.value = result.range ?? null
      usage.value = result.usage ?? null
      const { data: _data, range: _range, usage: _usage, ...rest } = result as AnalyticsApiResponse<T> & Record<string, unknown>
      extra.value = rest
      loadedAt.value = new Date().toISOString()
    } catch (err) {
      error.value = resolveApiErrorMessage(err, '分析数据加载失败')
    } finally {
      loading.value = false
    }
  }

  watch(range, () => {
    void refresh()
  })

  onMounted(() => {
    void refresh()
  })

  return {
    range,
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

export function useAnalyticsExport() {
  const { api } = useApi()
  const toast = useToast()

  return async function createExport(kind: AnalyticsExportKind, range: AnalyticsRangePreset) {
    try {
      await api('/api/admin/analytics/exports', {
        method: 'POST',
        body: { kind, range },
      })
      toast.add({ title: '导出任务已创建', color: 'success' })
    } catch (error) {
      toast.add({ title: resolveApiErrorMessage(error, '导出任务创建失败'), color: 'error' })
    }
  }
}

export function formatAnalyticsNumber(value: unknown) {
  const num = Number(value ?? 0)
  if (!Number.isFinite(num)) return '0'
  return new Intl.NumberFormat('zh-CN').format(num)
}

export function formatAnalyticsPercent(numerator: unknown, denominator: unknown, digits = 1) {
  const top = Number(numerator ?? 0)
  const bottom = Number(denominator ?? 0)
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= 0) return '0%'
  return `${((top / bottom) * 100).toFixed(digits)}%`
}

export function formatAnalyticsDuration(seconds: unknown) {
  const value = Math.max(0, Math.round(Number(seconds ?? 0)))
  if (!Number.isFinite(value) || value <= 0) return '0 秒'
  const minutes = Math.floor(value / 60)
  const rest = value % 60
  if (minutes <= 0) return `${rest} 秒`
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const minuteRest = minutes % 60
  return minuteRest ? `${hours} 小时 ${minuteRest} 分` : `${hours} 小时`
}

export function formatAnalyticsDateTime(value: unknown) {
  const text = String(value ?? '')
  if (!text) return '-'
  return text.replace('T', ' ').slice(0, 16)
}
