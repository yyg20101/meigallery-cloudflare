import type {
  AdPlatformProvider,
  AdPlatformRolloutPercentage,
  AdPlatformTrackingMode,
  AnalyticsRangeQuery,
} from '@meigallery/shared'
import type { ComputedRef, Ref } from 'vue'

export type AttributionRangePreset = '7d' | '30d' | '90d' | 'day'
export type AttributionDashboardProvider = AdPlatformProvider
export type EvidenceLayer = 'business' | 'browser' | 'server' | 'quality'
export type MetaConnectionState = 'not_configured' | 'unverified' | 'verified' | 'configuration_changed'

export interface AdPlatformConnectionStatusData {
  provider: AdPlatformProvider
  environment: 'production'
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  destinationId: string
  debugEnabled: boolean
  rolloutPercentage: AdPlatformRolloutPercentage
  destinationConfigured: boolean
  serverCredentialConfigured: boolean
  serverQueueConfigured: boolean
  serverDataKeyConfigured: boolean
  mode: AdPlatformTrackingMode
  state: 'not_configured' | 'unverified' | 'verified' | 'invalidated'
  verifiedAt: string
  verifiedCommit: string
}

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
  mode: AdPlatformTrackingMode
  browserEnabled: boolean
  serverEnabled: boolean
  publicConfig: Record<string, string>
  eventBindings: AdPlatformEventBindingData[]
  rolloutTargetPercentage: AdPlatformRolloutPercentage
  rolloutEffectivePercentage: AdPlatformRolloutPercentage
  connectionRevision: string
  credential: {
    configured: true
    type: 'access_token' | 'service_account_json'
    revision: string
  }
}

export type AdPlatformVerificationStatus =
  | 'queued'
  | 'running'
  | 'awaiting_human_evidence'
  | 'verified'
  | 'failed'
  | 'timed_out'
  | 'invalidated'

export interface AdPlatformVerificationData {
  id: string
  provider: AdPlatformProvider
  connectionRevision: string
  credentialRevision: string
  attempt: number
  status: AdPlatformVerificationStatus
  evidence: {
    automatic?: Record<string, unknown>
    human?: { confirmed: true; reference?: string; confirmedAt: string }
    failureCode?: string
  }
  startedAt: string
  completedAt: string
  updatedAt: string
}

export interface MetaConnectionStatusData {
  state: MetaConnectionState
  environment: 'dev' | 'production'
  pixelIdConfigured: boolean
  tokenConfigured: boolean
  verifiedAt: string | null
  verifiedCommit: string | null
  graphApiVersion: 'v25.0'
  datasetQualityStatus: 'not_checked' | 'available' | 'permission_denied' | 'error'
  invalidationReason: string
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

export interface MetaIncident {
  id: string
  environment: string
  status: 'open' | 'closed'
  severity: string
  triggerCode: string
  triggerSummary: string
  targetPercentage: number
  effectivePercentage: number
  evidence: Record<string, number | string>
  openedAt: string
  lastObservedAt: string
  closedAt: string | null
  resolution: string
}

export interface MetaRolloutSnapshot {
  environment: 'dev' | 'production' | 'invalid'
  targetPercentage: AdPlatformRolloutPercentage
  effectivePercentage: AdPlatformRolloutPercentage
  connectionVerified: boolean
  liveEvidencePresent: boolean
  openIncident: MetaIncident | null
  metrics: {
    sent: number
    failed: number
    permissionErrors: number
    retryExhausted: number
    stalePending: number
    criticalQualityDiagnostics: number
  }
  metricsStatus: { available: boolean; errorCode: string | null }
  promotion: {
    from: AdPlatformRolloutPercentage
    to: AdPlatformRolloutPercentage
    allowed: boolean
    requiresOverrideReason: boolean
    blockers: string[]
    hardBlockers: string[]
  }
}

export interface MetaStatusData {
  connection: MetaConnectionStatusData
  rollout: MetaRolloutSnapshot
  activity: AttributionSummaryData
}

export interface AttributionReadinessData {
  ready: boolean
  checks: Array<{ key: string; label: string; level: 'blocker' | 'warning'; ok: boolean; detail: string }>
  settings: Record<string, unknown>
  verifications: Record<string, unknown>
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
  const verifications = ref<Partial<Record<AdPlatformProvider, AdPlatformVerificationData | null>>>({})
  const loading = ref(false)
  const saving = ref(false)
  const verifying = ref(false)
  const error = ref('')
  const message = ref('')
  const pollTimers = new Map<AdPlatformProvider, ReturnType<typeof setTimeout>>()
  const evidencePollAttempts = new Map<AdPlatformProvider, number>()

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
      verifications.value[provider] = null
      message.value = '连接已保存，旧验证记录已失效'
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

  async function refreshVerification(provider: AdPlatformProvider, verificationId = '') {
    try {
      const suffix = verificationId ? `/verifications/${encodeURIComponent(verificationId)}` : '/verification'
      const result = await api<AttributionApiResponse<AdPlatformVerificationData>>(`/api/admin/attribution/platforms/${provider}${suffix}`)
      verifications.value[provider] = result.data
      scheduleVerificationPoll(result.data)
      return result.data
    }
    catch (cause) {
      if (apiErrorStatus(cause) === 404) {
        verifications.value[provider] = null
        stopVerificationPoll(provider)
        return null
      }
      error.value = resolveApiErrorMessage(cause, '连接验证状态加载失败')
      throw cause
    }
  }

  async function startVerification(
    provider: AdPlatformProvider,
    testEventCode = '',
    reverify = false,
  ) {
    verifying.value = true
    error.value = ''
    message.value = ''
    try {
      const code = testEventCode.trim()
      const result = await api<AttributionApiResponse<AdPlatformVerificationData>>(
        `/api/admin/attribution/platforms/${provider}/${reverify ? 'reverify' : 'verify'}`,
        {
          method: 'POST',
          body: code ? { testEventCode: code } : {},
        },
      )
      verifications.value[provider] = result.data
      message.value = reverify ? '重新验证已启动' : '验证已启动'
      scheduleVerificationPoll(result.data, true)
      return result.data
    }
    catch (cause) {
      error.value = resolveApiErrorMessage(cause, reverify ? '重新验证启动失败' : '连接验证启动失败')
      throw cause
    }
    finally {
      verifying.value = false
    }
  }

  async function confirmVerificationEvidence(
    provider: AdPlatformProvider,
    verificationId: string,
    reference = '',
  ) {
    verifying.value = true
    error.value = ''
    message.value = ''
    try {
      const normalizedReference = reference.trim()
      const result = await api<AttributionApiResponse<AdPlatformVerificationData>>(
        `/api/admin/attribution/platforms/${provider}/verifications/${encodeURIComponent(verificationId)}/evidence`,
        {
          method: 'POST',
          body: { confirmed: true, ...(normalizedReference ? { reference: normalizedReference } : {}) },
        },
      )
      verifications.value[provider] = result.data
      message.value = '人工证据已提交'
      evidencePollAttempts.set(provider, 0)
      scheduleVerificationPoll(result.data, true)
      return result.data
    }
    catch (cause) {
      error.value = resolveApiErrorMessage(cause, '人工证据提交失败')
      throw cause
    }
    finally {
      verifying.value = false
    }
  }

  function scheduleVerificationPoll(verification: AdPlatformVerificationData, immediate = false) {
    stopVerificationPoll(verification.provider)
    if (!['queued', 'running', 'awaiting_human_evidence'].includes(verification.status)) {
      evidencePollAttempts.delete(verification.provider)
      return
    }
    if (verification.status === 'awaiting_human_evidence') {
      const attempt = evidencePollAttempts.get(verification.provider)
      if (attempt === undefined && !immediate) return
      if (attempt !== undefined) {
        if (attempt >= 60) {
          evidencePollAttempts.delete(verification.provider)
          message.value = '验证仍在处理，请稍后刷新状态'
          return
        }
        evidencePollAttempts.set(verification.provider, attempt + 1)
      }
    }
    const delay = immediate ? 800 : 2_000
    pollTimers.set(verification.provider, setTimeout(() => {
      pollTimers.delete(verification.provider)
      void refreshVerification(verification.provider, verification.id).catch(() => undefined)
    }, delay))
  }

  function stopVerificationPoll(provider: AdPlatformProvider) {
    const timer = pollTimers.get(provider)
    if (timer) clearTimeout(timer)
    pollTimers.delete(provider)
  }

  function clearFeedback() {
    error.value = ''
    message.value = ''
  }

  onScopeDispose(() => {
    for (const timer of pollTimers.values()) clearTimeout(timer)
    pollTimers.clear()
    evidencePollAttempts.clear()
  })

  return {
    connections,
    verifications,
    loading,
    saving,
    verifying,
    error,
    message,
    refreshConnections,
    saveConnection,
    refreshVerification,
    startVerification,
    confirmVerificationEvidence,
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

export function metaConnectionStateLabel(state: MetaConnectionState) {
  if (state === 'verified') return '已验证'
  if (state === 'configuration_changed') return '配置已变更'
  if (state === 'not_configured') return '未配置'
  return '未验证'
}

export function metaConnectionReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    pixel_id_missing: 'Pixel ID 未配置',
    access_token_missing: 'CAPI token 未配置',
    tracking_mode_disabled: 'Meta tracking mode 已关闭',
    release_commit_invalid: '当前 release commit 无效',
    verification_missing: '尚未完成连接验证',
    pixel_id_changed: 'Pixel ID 已变化',
    access_token_changed: 'CAPI token 已变化',
    graph_api_version_changed: 'Graph API 版本已变化',
    verification_revision_missing: '历史连接验证需要重新验证',
    verification_invalidated: '原连接验证已失效',
  }
  return labels[reason] || (reason ? '连接状态需要重新验证' : '连接配置与验证记录一致')
}

export function canVerifyMetaConnection(connection: MetaConnectionStatusData | null | undefined, isOwner: boolean) {
  return isOwner && (connection?.environment === 'dev' || connection?.environment === 'production')
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

function apiErrorStatus(error: unknown) {
  if (!error || typeof error !== 'object') return 0
  return Number((error as { statusCode?: unknown; status?: unknown }).statusCode
    ?? (error as { status?: unknown }).status
    ?? 0)
}
