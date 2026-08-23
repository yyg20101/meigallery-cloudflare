const CLOUDFLARE_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
const REQUEST_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 1_000_000
const PRECISE_WINDOW_MS = 5 * 60 * 1000
const MAX_CONFIGURED_RESOURCES = 8

export const CLOUDFLARE_OPERATIONS_METRIC_KEYS = [
  'platform.worker_error_rate',
  'platform.d1_latency_p95',
  'platform.r2_error_rate',
] as const

export type CloudflareOperationsMetricKey = typeof CLOUDFLARE_OPERATIONS_METRIC_KEYS[number]

export type CloudflareOperationsAnalyticsConfig = {
  accountId?: string
  apiToken?: string
  workerScripts?: string
  d1DatabaseId?: string
  r2Buckets?: string
}

export type CloudflareOperationsMetricValue = {
  quality: 'known' | 'unknown' | 'invalid' | 'unconfigured'
  valueReal?: number
  sourceWatermark: string | null
  details: Record<string, unknown>
}

export type CloudflareOperationsMetricValues = Record<
  CloudflareOperationsMetricKey,
  CloudflareOperationsMetricValue
>

type ParsedValue<T> =
  | { state: 'configured'; value: T }
  | { state: 'missing' | 'invalid' }

type GraphqlAccount = Record<string, unknown>

type GraphqlReadResult =
  | { ok: true; account: GraphqlAccount }
  | {
      ok: false
      reason:
        | 'timeout'
        | 'network_error'
        | 'http_error'
        | 'response_too_large'
        | 'invalid_payload'
        | 'graphql_error'
        | 'account_scope_unavailable'
    }

/**
 * 读取账号级 Cloudflare Analytics。配置缺失时不发起网络请求；所有输出都可直接写入安全详情。
 */
export async function readCloudflareOperationsAnalytics(
  config: CloudflareOperationsAnalyticsConfig,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<CloudflareOperationsMetricValues> {
  const credentials = parseCredentials(config)
  const workerScripts = parseResourceList(config.workerScripts, isWorkerScriptName)
  const d1DatabaseId = parseSingleResource(config.d1DatabaseId, isD1DatabaseId)
  const r2Buckets = parseResourceList(config.r2Buckets, isR2BucketReference)
  const values: CloudflareOperationsMetricValues = {
    'platform.worker_error_rate': resourceDefault(
      credentials,
      workerScripts,
      'CLOUDFLARE_WORKER_SCRIPTS_NOT_CONFIGURED',
      'CLOUDFLARE_WORKER_SCRIPTS_INVALID',
    ),
    'platform.d1_latency_p95': resourceDefault(
      credentials,
      d1DatabaseId,
      'CLOUDFLARE_D1_DATABASE_NOT_CONFIGURED',
      'CLOUDFLARE_D1_DATABASE_INVALID',
    ),
    'platform.r2_error_rate': resourceDefault(
      credentials,
      r2Buckets,
      'CLOUDFLARE_R2_BUCKETS_NOT_CONFIGURED',
      'CLOUDFLARE_R2_BUCKETS_INVALID',
    ),
  }
  if (credentials.state !== 'configured') return values

  const hasWorkers = workerScripts.state === 'configured'
  const hasD1 = d1DatabaseId.state === 'configured'
  const hasR2 = r2Buckets.state === 'configured'
  if (!hasWorkers && !hasD1 && !hasR2) return values

  const preciseEnd = now.toISOString()
  const preciseStart = new Date(now.getTime() - PRECISE_WINDOW_MS).toISOString()
  const utcDate = preciseEnd.slice(0, 10)
  const query = buildAnalyticsQuery({
    accountId: credentials.value.accountId,
    workerScripts: hasWorkers ? workerScripts.value : [],
    d1DatabaseId: hasD1 ? d1DatabaseId.value : null,
    r2Buckets: hasR2 ? r2Buckets.value : [],
    preciseStart,
    preciseEnd,
    utcDate,
  })
  const response = await executeGraphql(
    query.document,
    query.variables,
    credentials.value.apiToken,
    fetcher,
  )
  if (!response.ok) {
    for (const metricKey of query.queriedMetricKeys) {
      values[metricKey] = unavailableMetric(response.reason)
    }
    return values
  }

  if (hasWorkers) {
    values['platform.worker_error_rate'] = parseWorkerMetric(
      response.account,
      workerScripts.value.length,
      preciseStart,
      preciseEnd,
    )
  }
  if (hasD1) {
    values['platform.d1_latency_p95'] = parseD1Metric(response.account, utcDate, preciseEnd)
  }
  if (hasR2) {
    values['platform.r2_error_rate'] = parseR2Metric(
      response.account,
      r2Buckets.value.length,
      preciseStart,
      preciseEnd,
    )
  }
  return values
}

function parseCredentials(config: CloudflareOperationsAnalyticsConfig): ParsedValue<{
  accountId: string
  apiToken: string
}> {
  if (!config.accountId || !config.apiToken) return { state: 'missing' }
  if (!/^[a-f0-9]{32}$/iu.test(config.accountId)) return { state: 'invalid' }
  if (!/^[\x21-\x7e]{20,512}$/u.test(config.apiToken)) return { state: 'invalid' }
  return {
    state: 'configured',
    value: { accountId: config.accountId, apiToken: config.apiToken },
  }
}

function parseSingleResource(value: string | undefined, predicate: (value: string) => boolean): ParsedValue<string> {
  if (!value) return { state: 'missing' }
  if (value !== value.trim() || !predicate(value)) return { state: 'invalid' }
  return { state: 'configured', value }
}

function parseResourceList(
  value: string | undefined,
  predicate: (value: string) => boolean,
): ParsedValue<string[]> {
  if (!value) return { state: 'missing' }
  const resources = value.split(',').map(item => item.trim())
  if (
    resources.length < 1
    || resources.length > MAX_CONFIGURED_RESOURCES
    || resources.some(item => !predicate(item))
    || new Set(resources).size !== resources.length
  ) return { state: 'invalid' }
  return { state: 'configured', value: resources }
}

function isWorkerScriptName(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
}

function isD1DatabaseId(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)
}

function isR2BucketReference(value: string) {
  return /^(?:[a-z0-9-]{2,16}_)?[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value)
}

function resourceDefault<T>(
  credentials: ParsedValue<unknown>,
  resource: ParsedValue<T>,
  missingCode: string,
  invalidCode: string,
): CloudflareOperationsMetricValue {
  if (credentials.state !== 'configured') {
    return unconfiguredMetric(
      credentials.state === 'missing'
        ? 'CLOUDFLARE_ANALYTICS_CREDENTIALS_NOT_CONFIGURED'
        : 'CLOUDFLARE_ANALYTICS_CREDENTIALS_INVALID',
    )
  }
  if (resource.state === 'missing') return unconfiguredMetric(missingCode)
  if (resource.state === 'invalid') return unconfiguredMetric(invalidCode)
  return unavailableMetric('source_not_read')
}

function unconfiguredMetric(code: string): CloudflareOperationsMetricValue {
  return { quality: 'unconfigured', sourceWatermark: null, details: { code } }
}

function unavailableMetric(reason: string): CloudflareOperationsMetricValue {
  return {
    quality: 'unknown',
    sourceWatermark: null,
    details: { code: 'CLOUDFLARE_ANALYTICS_UNAVAILABLE', reason },
  }
}

function invalidMetric(dataset: 'workers' | 'd1' | 'r2'): CloudflareOperationsMetricValue {
  return {
    quality: 'invalid',
    sourceWatermark: null,
    details: { code: 'CLOUDFLARE_ANALYTICS_RESULT_INVALID', dataset },
  }
}

function buildAnalyticsQuery(input: {
  accountId: string
  workerScripts: string[]
  d1DatabaseId: string | null
  r2Buckets: string[]
  preciseStart: string
  preciseEnd: string
  utcDate: string
}) {
  const variableDefinitions = [
    '$accountTag: string!',
  ]
  const variables: Record<string, string> = {
    accountTag: input.accountId,
  }
  const selections: string[] = []
  const queriedMetricKeys: CloudflareOperationsMetricKey[] = []

  if (input.workerScripts.length > 0) {
    variableDefinitions.push('$workerStart: string!', '$workerEnd: string!')
    variables.workerStart = input.preciseStart
    variables.workerEnd = input.preciseEnd
  }
  input.workerScripts.forEach((scriptName, index) => {
    variableDefinitions.push(`$workerScript${index}: string!`)
    variables[`workerScript${index}`] = scriptName
    selections.push(`
      worker${index}: workersInvocationsAdaptive(
        limit: 10000
        filter: {
          scriptName: $workerScript${index}
          datetime_geq: $workerStart
          datetime_leq: $workerEnd
        }
      ) {
        sum { requests errors }
      }
    `)
  })
  if (input.workerScripts.length > 0) queriedMetricKeys.push('platform.worker_error_rate')

  if (input.d1DatabaseId) {
    variableDefinitions.push('$utcDate: Date!', '$d1DatabaseId: string!')
    variables.utcDate = input.utcDate
    variables.d1DatabaseId = input.d1DatabaseId
    selections.push(`
      d1: d1AnalyticsAdaptiveGroups(
        limit: 2
        filter: {
          date_geq: $utcDate
          date_leq: $utcDate
          databaseId: $d1DatabaseId
        }
      ) {
        quantiles { queryBatchTimeMsP95 }
        dimensions { date }
      }
    `)
    queriedMetricKeys.push('platform.d1_latency_p95')
  }

  if (input.r2Buckets.length > 0) {
    variableDefinitions.push('$r2Start: Time!', '$r2End: Time!')
    variables.r2Start = input.preciseStart
    variables.r2End = input.preciseEnd
  }
  input.r2Buckets.forEach((bucketName, index) => {
    variableDefinitions.push(`$r2Bucket${index}: string!`)
    variables[`r2Bucket${index}`] = bucketName
    selections.push(`
      r2Bucket${index}: r2OperationsAdaptiveGroups(
        limit: 10
        filter: {
          datetime_geq: $r2Start
          datetime_leq: $r2End
          bucketName: $r2Bucket${index}
        }
      ) {
        sum { requests }
        dimensions { actionStatus }
      }
    `)
  })
  if (input.r2Buckets.length > 0) queriedMetricKeys.push('platform.r2_error_rate')

  return {
    document: `
      query MeiGalleryOperationsAnalytics(${variableDefinitions.join(', ')}) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            ${selections.join('\n')}
          }
        }
      }
    `,
    variables,
    queriedMetricKeys,
  }
}

async function executeGraphql(
  document: string,
  variables: Record<string, string>,
  apiToken: string,
  fetcher: typeof fetch,
): Promise<GraphqlReadResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let responseText: string
  try {
    const response = await fetcher(CLOUDFLARE_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: document, variables }),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: 'http_error' }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return { ok: false, reason: 'response_too_large' }
    }
    const boundedText = await readBoundedResponseText(response, MAX_RESPONSE_BYTES)
    if (boundedText === null) return { ok: false, reason: 'response_too_large' }
    responseText = boundedText
  }
  catch {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network_error' }
  }
  finally {
    clearTimeout(timeout)
  }
  if (new TextEncoder().encode(responseText).byteLength > MAX_RESPONSE_BYTES) {
    return { ok: false, reason: 'response_too_large' }
  }

  let payload: unknown
  try {
    payload = JSON.parse(responseText)
  }
  catch {
    return { ok: false, reason: 'invalid_payload' }
  }
  if (!isRecord(payload)) return { ok: false, reason: 'invalid_payload' }
  if (
    payload.errors !== undefined
    && payload.errors !== null
    && (!Array.isArray(payload.errors) || payload.errors.length > 0)
  ) return { ok: false, reason: 'graphql_error' }
  if (!isRecord(payload.data) || !isRecord(payload.data.viewer)) {
    return { ok: false, reason: 'invalid_payload' }
  }
  const accounts = payload.data.viewer.accounts
  if (!Array.isArray(accounts)) return { ok: false, reason: 'invalid_payload' }
  if (accounts.length !== 1 || !isRecord(accounts[0])) {
    return { ok: false, reason: 'account_scope_unavailable' }
  }
  return { ok: true, account: accounts[0] }
}

function parseWorkerMetric(
  account: GraphqlAccount,
  scriptCount: number,
  windowStart: string,
  windowEnd: string,
): CloudflareOperationsMetricValue {
  let requests = 0
  let errors = 0
  let observationCount = 0
  for (let index = 0; index < scriptCount; index += 1) {
    const rows = account[`worker${index}`]
    if (!Array.isArray(rows)) return invalidMetric('workers')
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.sum)) return invalidMetric('workers')
      const rowRequests = finiteNonNegative(row.sum.requests)
      const rowErrors = finiteNonNegative(row.sum.errors)
      if (rowRequests === null || rowErrors === null || rowErrors > rowRequests) {
        return invalidMetric('workers')
      }
      requests += rowRequests
      errors += rowErrors
      observationCount += 1
    }
  }
  if (
    !Number.isFinite(requests)
    || !Number.isFinite(errors)
    || requests > Number.MAX_SAFE_INTEGER
    || errors > Number.MAX_SAFE_INTEGER
  ) return invalidMetric('workers')
  const details = {
    sampled: true,
    windowStart,
    windowEnd,
    windowSeconds: PRECISE_WINDOW_MS / 1000,
    configuredScriptCount: scriptCount,
    observationCount,
    requestEstimate: requests,
    errorEstimate: errors,
  }
  if (requests === 0) {
    return {
      quality: 'unknown',
      sourceWatermark: windowEnd,
      details: { ...details, code: 'NO_REQUESTS_IN_WINDOW' },
    }
  }
  return {
    quality: 'known',
    valueReal: errors / requests,
    sourceWatermark: windowEnd,
    details,
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let byteLength = 0
  let text = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    byteLength += chunk.value.byteLength
    if (byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}

function parseD1Metric(
  account: GraphqlAccount,
  utcDate: string,
  observedAt: string,
): CloudflareOperationsMetricValue {
  const rows = account.d1
  if (!Array.isArray(rows)) return invalidMetric('d1')
  const p95Values: number[] = []
  for (const row of rows) {
    if (!isRecord(row) || !isRecord(row.quantiles) || !isRecord(row.dimensions)) {
      return invalidMetric('d1')
    }
    if (row.dimensions.date !== utcDate) return invalidMetric('d1')
    const p95 = finiteNonNegative(row.quantiles.queryBatchTimeMsP95)
    if (p95 === null) return invalidMetric('d1')
    p95Values.push(p95)
  }
  const details = {
    sampled: true,
    aggregationGranularity: 'utc_date',
    periodStart: utcDate,
    periodEnd: utcDate,
    observationCount: p95Values.length,
  }
  if (p95Values.length === 0) {
    return {
      quality: 'unknown',
      sourceWatermark: observedAt,
      details: { ...details, code: 'NO_D1_OBSERVATION_IN_PERIOD' },
    }
  }
  return {
    quality: 'known',
    valueReal: Math.max(...p95Values),
    sourceWatermark: observedAt,
    details,
  }
}

function parseR2Metric(
  account: GraphqlAccount,
  bucketCount: number,
  windowStart: string,
  windowEnd: string,
): CloudflareOperationsMetricValue {
  let requests = 0
  let internalErrors = 0
  let observationCount = 0
  for (let index = 0; index < bucketCount; index += 1) {
    const rows = account[`r2Bucket${index}`]
    if (!Array.isArray(rows)) return invalidMetric('r2')
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.sum) || !isRecord(row.dimensions)) {
        return invalidMetric('r2')
      }
      const status = row.dimensions.actionStatus
      if (status !== 'success' && status !== 'userError' && status !== 'internalError') {
        return invalidMetric('r2')
      }
      const rowRequests = finiteNonNegative(row.sum.requests)
      if (rowRequests === null) return invalidMetric('r2')
      requests += rowRequests
      if (status === 'internalError') internalErrors += rowRequests
      observationCount += 1
    }
  }
  if (
    !Number.isFinite(requests)
    || !Number.isFinite(internalErrors)
    || requests > Number.MAX_SAFE_INTEGER
    || internalErrors > Number.MAX_SAFE_INTEGER
  ) return invalidMetric('r2')
  const details = {
    sampled: true,
    windowStart,
    windowEnd,
    windowSeconds: PRECISE_WINDOW_MS / 1000,
    configuredBucketCount: bucketCount,
    observationCount,
    requestEstimate: requests,
    internalErrorEstimate: internalErrors,
    userErrorsCountedAsPlatformFailure: false,
  }
  if (requests === 0) {
    return {
      quality: 'unknown',
      sourceWatermark: windowEnd,
      details: { ...details, code: 'NO_REQUESTS_IN_WINDOW' },
    }
  }
  return {
    quality: 'known',
    valueReal: internalErrors / requests,
    sourceWatermark: windowEnd,
    details,
  }
}

function finiteNonNegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
