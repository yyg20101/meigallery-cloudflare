import type {
  AnalyticsRangeQuery,
  AttributionProvider,
} from '@meigallery/shared'
import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'
import {
  computed,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'
import type {
  AttributionAdminApiResponse,
  AttributionAdminClient,
  AttributionAuditView,
  AttributionConnectionBindingsView,
  AttributionConnectionView,
  AttributionDateRangeQuery,
  AttributionIncidentQuery,
  AttributionIncidentView,
  AttributionManagedSourceView,
  AttributionOperationView,
  AttributionPrivacyPolicyView,
  AttributionQualityQuery,
  AttributionQualityView,
  AttributionVerificationView,
  CreateAttributionManagedSourceRequest,
  CreateAttributionManagedSourceResult,
  CreateAttributionConnectionRequest,
  CreateCandidateRequest,
  DisableAttributionManagedSourceResult,
  SaveAttributionPrivacyPolicyRequest,
  SetRuntimePolicyRequest,
} from '~/types/attribution-admin'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

export type AttributionRangePreset = '7d' | '30d' | '90d' | 'day'
export type EvidenceLayer = 'business' | 'browser' | 'server' | 'quality'

export interface AttributionRangeState {
  range: Ref<AttributionRangePreset>
  date: Ref<string>
  query: ComputedRef<Pick<AnalyticsRangeQuery, 'range' | 'from' | 'to'>>
  queryKey: ComputedRef<string>
}

export interface AttributionConnectionFilterState {
  provider: Ref<AttributionProvider | ''>
  connectionId: Ref<string>
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

export function useAttributionConnectionFilterState():
AttributionConnectionFilterState {
  const route = useRoute()
  const router = useRouter()
  const provider = ref<AttributionProvider | ''>(
    routeProvider(route.query.provider),
  )
  const connectionId = ref(
    routeConnectionId(route.query.connectionId),
  )
  let syncingRoute = false

  watch(
    () => [route.query.provider, route.query.connectionId] as const,
    ([nextProvider, nextConnectionId]) => {
      syncingRoute = true
      provider.value = routeProvider(nextProvider)
      connectionId.value = routeConnectionId(nextConnectionId)
      syncingRoute = false
    },
  )

  watch([provider, connectionId], () => {
    if (syncingRoute) return
    const query = { ...route.query }
    if (provider.value) query.provider = provider.value
    else delete query.provider
    if (connectionId.value) query.connectionId = connectionId.value
    else delete query.connectionId
    void router.replace({ query })
  })

  return { provider, connectionId }
}

const ATTRIBUTION_ADMIN_BASE =
  ATTRIBUTION_SERVICE_BINDING.ADMIN_PROXY_PUBLIC_PATH_PREFIX

export function useAttributionConnections(
  client: AttributionAdminClient = attributionAdminClient(),
  options: { autoLoad?: boolean } = {},
) {
  const connections = ref<AttributionConnectionView[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  const error = ref('')
  let requestRevision = 0
  let pendingCreate: Promise<AttributionConnectionView> | null = null

  async function refresh(): Promise<AttributionConnectionView[]> {
    const revision = ++requestRevision
    loading.value = true
    error.value = ''
    try {
      const result = await client.request<
        AttributionAdminApiResponse<AttributionConnectionView[]>
      >(`${ATTRIBUTION_ADMIN_BASE}/connections`)
      if (revision !== requestRevision) return connections.value
      connections.value = result.data
      initialized.value = true
      return result.data
    } catch (cause) {
      if (revision === requestRevision) {
        initialized.value = false
        error.value = resolveApiErrorMessage(
          cause,
          '归因连接加载失败',
        )
      }
      throw cause
    } finally {
      if (revision === requestRevision) loading.value = false
    }
  }

  function createConnection(
    input: CreateAttributionConnectionRequest,
  ): Promise<AttributionConnectionView> {
    if (pendingCreate) return pendingCreate
    if (!initialized.value || loading.value) {
      return Promise.reject(attributionFormNotReady())
    }
    error.value = ''
    const operation = client.request<
      AttributionAdminApiResponse<AttributionConnectionView>
    >(`${ATTRIBUTION_ADMIN_BASE}/connections`, {
      method: 'POST',
      headers: idempotencyHeaders(client),
      body: input,
    }).then((result) => {
      upsertConnection(connections.value, result.data)
      return result.data
    }).catch((cause) => {
      error.value = resolveApiErrorMessage(
        cause,
        '归因连接创建失败',
      )
      throw cause
    }).finally(() => {
      if (pendingCreate === operation) pendingCreate = null
    })
    pendingCreate = operation
    return operation
  }

  if (options.autoLoad !== false) {
    onMounted(() => void refresh().catch(() => undefined))
  }

  return {
    connections,
    loading,
    initialized,
    creating: computed(() => pendingCreate !== null),
    canCreate: computed(
      () => initialized.value && !loading.value && !pendingCreate,
    ),
    error,
    refresh,
    createConnection,
  }
}

export function useAttributionCandidate(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  const connection = ref<AttributionConnectionView | null>(null)
  const loading = ref(false)
  const initialized = ref(false)
  const error = ref('')
  let requestRevision = 0
  let pending: {
    connectionId: string
    promise: Promise<AttributionConnectionView>
  } | null = null

  async function load(
    connectionId: string,
  ): Promise<AttributionConnectionView> {
    const normalizedId = attributionConnectionId(connectionId)
    const revision = ++requestRevision
    loading.value = true
    initialized.value = false
    error.value = ''
    try {
      const result = await client.request<
        AttributionAdminApiResponse<AttributionConnectionView>
      >(
        `${ATTRIBUTION_ADMIN_BASE}/connections/`
        + encodeURIComponent(normalizedId),
      )
      if (revision === requestRevision) {
        connection.value = result.data
        initialized.value = true
      }
      return result.data
    } catch (cause) {
      if (revision === requestRevision) {
        connection.value = null
        error.value = resolveApiErrorMessage(
          cause,
          '归因连接加载失败',
        )
      }
      throw cause
    } finally {
      if (revision === requestRevision) loading.value = false
    }
  }

  function initialize(value: AttributionConnectionView): void {
    connection.value = value
    initialized.value = true
    loading.value = false
    error.value = ''
  }

  function saveCandidate(
    connectionId: string,
    input: CreateCandidateRequest,
  ): Promise<AttributionConnectionView> {
    const normalizedId = attributionConnectionId(connectionId)
    if (pending?.connectionId === normalizedId) return pending.promise
    if (
      pending
      || !initialized.value
      || loading.value
      || connection.value?.id !== normalizedId
    ) {
      return Promise.reject(attributionFormNotReady())
    }

    error.value = ''
    const operation = client.request<
      AttributionAdminApiResponse<AttributionConnectionView>
    >(
      `${ATTRIBUTION_ADMIN_BASE}/connections/`
      + `${encodeURIComponent(normalizedId)}/candidates`,
      {
        method: 'POST',
        headers: idempotencyHeaders(client),
        body: input,
      },
    ).then((result) => {
      connection.value = result.data
      return result.data
    }).catch((cause) => {
      error.value = resolveApiErrorMessage(
        cause,
        '身份候选保存失败',
      )
      throw cause
    }).finally(() => {
      if (pending?.promise === operation) pending = null
    })
    pending = { connectionId: normalizedId, promise: operation }
    return operation
  }

  return {
    connection,
    candidate: computed(() => connection.value?.candidate ?? null),
    loading,
    initialized,
    saving: computed(() => pending !== null),
    canSave: computed(() => (
      initialized.value
      && !loading.value
      && pending === null
      && connection.value !== null
    )),
    error,
    load,
    initialize,
    saveCandidate,
  }
}

export function useAttributionRuntimePolicy(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  const connection = ref<AttributionConnectionView | null>(null)
  const initialized = ref(false)
  const error = ref('')
  let pending: {
    operation: 'save' | 'rollback' | 'disable'
    connectionId: string
    promise: Promise<AttributionConnectionView>
  } | null = null

  function initialize(value: AttributionConnectionView): void {
    connection.value = value
    initialized.value = true
    error.value = ''
  }

  function saveRuntimePolicy(
    connectionId: string,
    input: SetRuntimePolicyRequest,
  ): Promise<AttributionConnectionView> {
    return runCommand(
      'save',
      connectionId,
      'PATCH',
      'runtime-policy',
      input,
    )
  }

  function rollback(
    connectionId: string,
  ): Promise<AttributionConnectionView> {
    return runCommand('rollback', connectionId, 'POST', 'rollback')
  }

  function disable(
    connectionId: string,
  ): Promise<AttributionConnectionView> {
    return runCommand('disable', connectionId, 'POST', 'disable')
  }

  function runCommand(
    operationName: 'save' | 'rollback' | 'disable',
    connectionId: string,
    method: 'POST' | 'PATCH',
    suffix: string,
    body?: SetRuntimePolicyRequest,
  ): Promise<AttributionConnectionView> {
    const normalizedId = attributionConnectionId(connectionId)
    if (
      pending?.operation === operationName
      && pending.connectionId === normalizedId
    ) {
      return pending.promise
    }
    if (
      pending
      || !initialized.value
      || connection.value?.id !== normalizedId
    ) {
      return Promise.reject(attributionFormNotReady())
    }

    error.value = ''
    const command = client.request<
      AttributionAdminApiResponse<AttributionConnectionView>
    >(
      `${ATTRIBUTION_ADMIN_BASE}/connections/`
      + `${encodeURIComponent(normalizedId)}/${suffix}`,
      {
        method,
        headers: idempotencyHeaders(client),
        ...(body === undefined ? {} : { body }),
      },
    ).then((result) => {
      connection.value = result.data
      return result.data
    }).catch((cause) => {
      error.value = resolveApiErrorMessage(
        cause,
        operationName === 'save'
          ? '运行策略保存失败'
          : operationName === 'rollback'
            ? '连接回滚失败'
            : '连接停用失败',
      )
      throw cause
    }).finally(() => {
      if (pending?.promise === command) pending = null
    })
    pending = {
      operation: operationName,
      connectionId: normalizedId,
      promise: command,
    }
    return command
  }

  return {
    connection,
    runtime: computed(() => connection.value?.runtime ?? null),
    initialized,
    saving: computed(() => pending !== null),
    canSave: computed(() => (
      initialized.value
      && pending === null
      && connection.value !== null
    )),
    error,
    initialize,
    saveRuntimePolicy,
    rollback,
    disable,
  }
}

export function useAttributionQuality(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  const rows = ref<AttributionQualityView[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  const error = ref('')
  let requestRevision = 0

  async function refresh(
    query: AttributionQualityQuery = {},
  ): Promise<AttributionQualityView[]> {
    const revision = ++requestRevision
    loading.value = true
    error.value = ''
    try {
      const result = await client.request<
        AttributionAdminApiResponse<AttributionQualityView[]>
      >(`${ATTRIBUTION_ADMIN_BASE}/quality`, {
        query: { ...query },
      })
      if (revision === requestRevision) {
        rows.value = result.data
        initialized.value = true
      }
      return result.data
    } catch (cause) {
      if (revision === requestRevision) {
        initialized.value = false
        error.value = resolveApiErrorMessage(
          cause,
          '归因质量加载失败',
        )
      }
      throw cause
    } finally {
      if (revision === requestRevision) loading.value = false
    }
  }

  return {
    rows,
    loading,
    initialized,
    error,
    refresh,
  }
}

export function useAttributionOperations(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  return attributionCollection<
    AttributionOperationView,
    AttributionDateRangeQuery
  >(
    `${ATTRIBUTION_ADMIN_BASE}/operations`,
    '归因运营数据加载失败',
    client,
  )
}

export function useAttributionBindings(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  return attributionCollection<
    AttributionConnectionBindingsView,
    Pick<AttributionDateRangeQuery, 'provider' | 'connectionId'>
  >(
    `${ATTRIBUTION_ADMIN_BASE}/bindings`,
    '事件映射加载失败',
    client,
  )
}

export function useAttributionVerifications(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  return attributionCollection<
    AttributionVerificationView,
    AttributionDateRangeQuery
  >(
    `${ATTRIBUTION_ADMIN_BASE}/verifications`,
    '验证记录加载失败',
    client,
  )
}

export function useAttributionIncidents(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  return attributionCollection<
    AttributionIncidentView,
    AttributionIncidentQuery
  >(
    `${ATTRIBUTION_ADMIN_BASE}/incidents`,
    'Incident 加载失败',
    client,
  )
}

export function useAttributionAudit(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  return attributionCollection<
    AttributionAuditView,
    AttributionDateRangeQuery
  >(
    `${ATTRIBUTION_ADMIN_BASE}/audit`,
    '归因审计日志加载失败',
    client,
  )
}

export function useAttributionPrivacyPolicy(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  const policy = ref<AttributionPrivacyPolicyView | null>(null)
  const loading = ref(false)
  const initialized = ref(false)
  const error = ref('')
  let requestRevision = 0
  let pendingSave: Promise<AttributionPrivacyPolicyView> | null = null

  async function refresh(): Promise<AttributionPrivacyPolicyView> {
    const revision = ++requestRevision
    loading.value = true
    error.value = ''
    try {
      const result = await client.request<
        AttributionAdminApiResponse<AttributionPrivacyPolicyView>
      >(`${ATTRIBUTION_ADMIN_BASE}/privacy-policy`)
      if (revision === requestRevision) {
        policy.value = result.data
        initialized.value = true
      }
      return result.data
    } catch (cause) {
      if (revision === requestRevision) {
        initialized.value = false
        error.value = resolveApiErrorMessage(
          cause,
          '地区策略加载失败',
        )
      }
      throw cause
    } finally {
      if (revision === requestRevision) loading.value = false
    }
  }

  function save(
    input: SaveAttributionPrivacyPolicyRequest,
  ): Promise<AttributionPrivacyPolicyView> {
    if (pendingSave) return pendingSave
    if (!initialized.value || loading.value || !policy.value) {
      return Promise.reject(attributionFormNotReady())
    }
    error.value = ''
    const operation = client.request<
      AttributionAdminApiResponse<AttributionPrivacyPolicyView>
    >(`${ATTRIBUTION_ADMIN_BASE}/privacy-policy`, {
      method: 'PATCH',
      headers: idempotencyHeaders(client),
      body: input,
    }).then((result) => {
      policy.value = result.data
      return result.data
    }).catch((cause) => {
      error.value = resolveApiErrorMessage(
        cause,
        '地区策略保存失败',
      )
      throw cause
    }).finally(() => {
      if (pendingSave === operation) pendingSave = null
    })
    pendingSave = operation
    return operation
  }

  return {
    policy,
    loading,
    initialized,
    saving: computed(() => pendingSave !== null),
    canSave: computed(() => (
      initialized.value
      && !loading.value
      && pendingSave === null
      && policy.value !== null
    )),
    error,
    refresh,
    save,
  }
}

export function useAttributionManagedSources(
  client: AttributionAdminClient = attributionAdminClient(),
) {
  const connectionId = ref('')
  const sources = ref<AttributionManagedSourceView[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  const error = ref('')
  let requestRevision = 0
  let pending: {
    operation: 'create' | 'disable'
    connectionId: string
    sourceId?: string
    promise: Promise<unknown>
  } | null = null

  async function load(
    value: string,
  ): Promise<AttributionManagedSourceView[]> {
    const normalizedId = attributionConnectionId(value)
    const revision = ++requestRevision
    loading.value = true
    error.value = ''
    try {
      const result = await client.request<
        AttributionAdminApiResponse<{
          connectionId: string
          sources: AttributionManagedSourceView[]
        }>
      >(
        `${ATTRIBUTION_ADMIN_BASE}/connections/`
        + `${encodeURIComponent(normalizedId)}/sources`,
      )
      if (revision === requestRevision) {
        connectionId.value = normalizedId
        sources.value = result.data.sources
        initialized.value = true
      }
      return result.data.sources
    } catch (cause) {
      if (revision === requestRevision) {
        initialized.value = false
        error.value = resolveApiErrorMessage(
          cause,
          '投放来源加载失败',
        )
      }
      throw cause
    } finally {
      if (revision === requestRevision) loading.value = false
    }
  }

  function create(
    value: string,
    input: CreateAttributionManagedSourceRequest,
  ): Promise<CreateAttributionManagedSourceResult> {
    const normalizedId = attributionConnectionId(value)
    if (
      pending?.operation === 'create'
      && pending.connectionId === normalizedId
    ) {
      return pending.promise as Promise<CreateAttributionManagedSourceResult>
    }
    ensureSourceCommandReady(normalizedId)
    error.value = ''
    const operation = client.request<
      AttributionAdminApiResponse<CreateAttributionManagedSourceResult>
    >(
      `${ATTRIBUTION_ADMIN_BASE}/connections/`
      + `${encodeURIComponent(normalizedId)}/sources`,
      {
        method: 'POST',
        headers: idempotencyHeaders(client),
        body: input,
      },
    ).then((result) => {
      upsertManagedSource(sources.value, result.data.source)
      return result.data
    }).catch((cause) => {
      error.value = resolveApiErrorMessage(
        cause,
        '投放来源创建失败',
      )
      throw cause
    }).finally(() => {
      if (pending?.promise === operation) pending = null
    })
    pending = {
      operation: 'create',
      connectionId: normalizedId,
      promise: operation,
    }
    return operation
  }

  function disableSource(
    value: string,
    sourceId: string,
  ): Promise<DisableAttributionManagedSourceResult> {
    const normalizedId = attributionConnectionId(value)
    const normalizedSourceId = attributionConnectionId(sourceId)
    if (
      pending?.operation === 'disable'
      && pending.connectionId === normalizedId
      && pending.sourceId === normalizedSourceId
    ) {
      return pending.promise as Promise<
        DisableAttributionManagedSourceResult
      >
    }
    ensureSourceCommandReady(normalizedId)
    error.value = ''
    const operation = client.request<
      AttributionAdminApiResponse<DisableAttributionManagedSourceResult>
    >(
      `${ATTRIBUTION_ADMIN_BASE}/connections/`
      + `${encodeURIComponent(normalizedId)}/sources/`
      + `${encodeURIComponent(normalizedSourceId)}/disable`,
      {
        method: 'POST',
        headers: idempotencyHeaders(client),
      },
    ).then((result) => {
      upsertManagedSource(sources.value, result.data.source)
      return result.data
    }).catch((cause) => {
      error.value = resolveApiErrorMessage(
        cause,
        '投放来源停用失败',
      )
      throw cause
    }).finally(() => {
      if (pending?.promise === operation) pending = null
    })
    pending = {
      operation: 'disable',
      connectionId: normalizedId,
      sourceId: normalizedSourceId,
      promise: operation,
    }
    return operation
  }

  function ensureSourceCommandReady(normalizedId: string): void {
    if (
      pending
      || !initialized.value
      || loading.value
      || connectionId.value !== normalizedId
    ) {
      throw attributionFormNotReady()
    }
  }

  return {
    sources,
    loading,
    initialized,
    saving: computed(() => pending !== null),
    canSave: computed(() => (
      initialized.value
      && !loading.value
      && pending === null
      && connectionId.value.length > 0
    )),
    error,
    load,
    create,
    disableSource,
  }
}

function attributionCollection<
  T,
  Query extends object,
>(
  path: string,
  fallbackMessage: string,
  client: AttributionAdminClient,
) {
  const rows = ref<T[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  const error = ref('')
  let requestRevision = 0

  async function refresh(
    query: Query = {} as Query,
  ): Promise<T[]> {
    const revision = ++requestRevision
    loading.value = true
    error.value = ''
    try {
      const result = await client.request<
        AttributionAdminApiResponse<T[]>
      >(path, {
        query: { ...query } as Record<
          string,
          string | number | undefined
        >,
      })
      if (revision === requestRevision) {
        rows.value = result.data
        initialized.value = true
      }
      return result.data
    } catch (cause) {
      if (revision === requestRevision) {
        initialized.value = false
        error.value = resolveApiErrorMessage(
          cause,
          fallbackMessage,
        )
      }
      throw cause
    } finally {
      if (revision === requestRevision) loading.value = false
    }
  }

  return {
    rows,
    loading,
    initialized,
    error,
    refresh,
  }
}

function attributionAdminClient(): AttributionAdminClient {
  const { api } = useApi()
  return {
    request<T>(path: string, options = {}) {
      return api<T>(path, options)
    },
    createIdempotencyKey() {
      return crypto.randomUUID()
    },
  }
}

function idempotencyHeaders(
  client: AttributionAdminClient,
): Record<string, string> {
  const key = client.createIdempotencyKey().trim()
  if (!/^[A-Za-z0-9:_-]{1,240}$/.test(key)) {
    throw new Error('ATTRIBUTION_IDEMPOTENCY_KEY_UNAVAILABLE')
  }
  return { 'Idempotency-Key': key }
}

function attributionConnectionId(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9:_-]{1,240}$/.test(normalized)) {
    throw new Error('ATTRIBUTION_CONNECTION_ID_INVALID')
  }
  return normalized
}

function attributionFormNotReady(): Error {
  return new Error('ATTRIBUTION_FORM_NOT_READY')
}

function upsertConnection(
  connections: AttributionConnectionView[],
  connection: AttributionConnectionView,
): void {
  const index = connections.findIndex(item => item.id === connection.id)
  if (index < 0) {
    connections.push(connection)
    return
  }
  connections.splice(index, 1, connection)
}

function upsertManagedSource(
  sources: AttributionManagedSourceView[],
  source: AttributionManagedSourceView,
): void {
  const index = sources.findIndex(item => item.id === source.id)
  if (index < 0) {
    sources.unshift(source)
    return
  }
  sources.splice(index, 1, source)
}

export function attributionRangeQuery(range: AttributionRangePreset, date: string): Pick<AnalyticsRangeQuery, 'range' | 'from' | 'to'> {
  if (range === 'day') {
    const day = normalizeDateInput(date) || todayDateInputValue()
    return { from: day, to: day }
  }
  return { range: range as AnalyticsRangeQuery['range'] }
}

export function attributionReadModelDateQuery(
  range: AttributionRangePreset,
  date: string,
  now = new Date(),
): Pick<AttributionDateRangeQuery, 'dateFrom' | 'dateTo'> {
  const currentDate = shanghaiDate(now)
  if (range === 'day') {
    const selected = normalizeDateInput(date) || currentDate
    return { dateFrom: selected, dateTo: selected }
  }
  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7
  const end = Date.parse(`${currentDate}T00:00:00.000Z`)
  const start = new Date(
    end - (days - 1) * 24 * 60 * 60 * 1_000,
  ).toISOString().slice(0, 10)
  return { dateFrom: start, dateTo: currentDate }
}

export function attributionRouteQuery(range: AttributionRangePreset, date: string): Record<string, string> {
  if (range === 'day') {
    const day = normalizeDateInput(date) || todayDateInputValue()
    return { range, date: day }
  }
  return { range }
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

function shanghaiDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) return todayDateInputValue()
  return new Date(
    now.getTime() + 8 * 60 * 60 * 1_000,
  ).toISOString().slice(0, 10)
}

function routeProvider(value: unknown): AttributionProvider | '' {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === 'meta' || raw === 'tiktok' || raw === 'google'
    ? raw
    : ''
}

function routeConnectionId(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string'
    && /^[A-Za-z0-9:_-]{1,240}$/.test(raw)
    ? raw
    : ''
}
