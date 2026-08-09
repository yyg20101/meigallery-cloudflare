import type { Bindings } from '../index'

export const APP_PERSON_SEARCH_POLICY_ID = 'sqp_app_1_0_search_1_dev_1'
export const APP_PERSON_SEARCH_DEFAULT_PAGE_SIZE = 20
export const APP_PERSON_SEARCH_MAX_PAGE_SIZE = 40
export const APP_PERSON_SEARCH_MAX_QUERY_LENGTH = 50
export const APP_PERSON_SEARCH_MAX_HISTORY_ITEMS = 50

const POLICY_ID_PATTERN = /^sqp_[A-Za-z0-9_-]{1,92}$/u
const HISTORY_ID_PATTERN = /^sh_[0-9a-f]{64}$/u

export interface AppPersonSearchRuntimeConfig {
  enabled: boolean
  policyId: string
  policyConfigured: boolean
  requireProductionReady: boolean
}

export interface AppPersonSearchPolicy {
  id: string
  state: 'development' | 'published'
  productionReady: boolean
  personSearchEnabled: boolean
  historyEnabled: boolean
  historyProductionReady: boolean
  defaultHistoryRecordingEnabled: false
  historyRetentionDecisionStatus: 'unresolved' | 'approved'
  purgeEnabled: boolean
  maxQueryLength: number
  maxHistoryItems: number
  historyRetentionDays: number
  effectiveAt: string
}

export interface AppPersonSearchCapabilities {
  profiles: boolean
  history: boolean
  policy: AppPersonSearchPolicy | null
}

type SearchPolicyRow = {
  id: string
  state: string
  production_ready: number
  person_search_enabled: number
  history_enabled: number
  history_production_ready: number
  default_history_recording_enabled: number
  history_retention_decision_status: string
  purge_enabled: number
  max_query_length: number
  max_history_items: number
  history_retention_days: number
  effective_at: string
}

export class AppPersonSearchError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

export function getAppPersonSearchRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_PERSON_SEARCH_ENABLED'
  | 'APP_PERSON_SEARCH_POLICY_VERSION'
  | 'APP_PERSON_SEARCH_PRODUCTION_READY'
>): AppPersonSearchRuntimeConfig {
  const configuredPolicyId = normalizePolicyId(env.APP_PERSON_SEARCH_POLICY_VERSION)
  const requireProductionReady = env.APP_ENV === 'production'
  const productionGateSatisfied = !requireProductionReady
    || env.APP_PERSON_SEARCH_PRODUCTION_READY === 'true'
  return {
    enabled: env.APP_PERSON_SEARCH_ENABLED === 'true'
      && Boolean(configuredPolicyId)
      && productionGateSatisfied,
    policyId: configuredPolicyId ?? APP_PERSON_SEARCH_POLICY_ID,
    policyConfigured: Boolean(configuredPolicyId),
    requireProductionReady,
  }
}

export async function resolveAppPersonSearchCapabilities(
  db: D1Database,
  config: AppPersonSearchRuntimeConfig,
  now = new Date(),
): Promise<AppPersonSearchCapabilities> {
  if (!config.enabled) return { profiles: false, history: false, policy: null }
  try {
    const policy = await loadAppPersonSearchPolicy(db, config, now)
    return {
      profiles: policy.personSearchEnabled,
      history: policy.historyEnabled && isHistoryReady(policy, config),
      policy,
    }
  }
  catch {
    return { profiles: false, history: false, policy: null }
  }
}

export async function requireAppPersonSearchPolicy(
  db: D1Database,
  config: AppPersonSearchRuntimeConfig,
  capability: 'profiles' | 'history',
  now = new Date(),
): Promise<AppPersonSearchPolicy> {
  const policy = await loadAppPersonSearchPolicy(db, config, now)
  if (capability === 'profiles' && !policy.personSearchEnabled) {
    throw new AppPersonSearchError(403, 'PERSON_SEARCH_DISABLED', '人物搜索当前保持关闭')
  }
  if (capability === 'history' && (!policy.historyEnabled || !isHistoryReady(policy, config))) {
    throw new AppPersonSearchError(403, 'SEARCH_HISTORY_DISABLED', '搜索历史当前保持关闭')
  }
  return policy
}

export function assertPositiveSearchAccountId(accountId: number): void {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new AppPersonSearchError(403, 'APP_ACCOUNT_REQUIRED', '需要有效 App 账号')
  }
}

export function normalizeAppPersonSearchText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new AppPersonSearchError(400, 'PERSON_SEARCH_QUERY_INVALID', 'query 必须为字符串')
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (
    !normalized
    || [...normalized].length > maxLength
    || /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(normalized)
  ) {
    throw new AppPersonSearchError(
      400,
      'PERSON_SEARCH_QUERY_INVALID',
      `搜索词必须为 1 至 ${maxLength} 个有效字符`,
    )
  }
  return normalized
}

export function normalizeSearchExpectedVersion(value: unknown): number {
  const parsed = typeof value === 'string' && /^[1-9]\d{0,9}$/u.test(value)
    ? Number(value)
    : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
    throw new AppPersonSearchError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  return Number(parsed)
}

export function normalizeSearchHistoryId(value: unknown): string {
  if (typeof value !== 'string' || !HISTORY_ID_PATTERN.test(value)) {
    throw new AppPersonSearchError(400, 'SEARCH_HISTORY_ID_INVALID', '搜索历史 ID 格式无效')
  }
  return value
}

export function normalizeSearchHistoryPageLimit(value: string | undefined): number {
  if (value === undefined || value === '') return APP_PERSON_SEARCH_DEFAULT_PAGE_SIZE
  if (!/^[1-9]\d{0,2}$/u.test(value)) {
    throw new AppPersonSearchError(400, 'SEARCH_HISTORY_LIMIT_INVALID', 'limit 必须为正整数')
  }
  const parsed = Number(value)
  if (parsed > APP_PERSON_SEARCH_MAX_PAGE_SIZE) {
    throw new AppPersonSearchError(
      400,
      'SEARCH_HISTORY_LIMIT_INVALID',
      `limit 不能超过 ${APP_PERSON_SEARCH_MAX_PAGE_SIZE}`,
    )
  }
  return parsed
}

async function loadAppPersonSearchPolicy(
  db: D1Database,
  config: AppPersonSearchRuntimeConfig,
  now: Date,
): Promise<AppPersonSearchPolicy> {
  requireRuntimeEnabled(config)
  const row = await db.prepare(`
    SELECT id, state, production_ready, person_search_enabled, history_enabled,
           history_production_ready, default_history_recording_enabled,
           history_retention_decision_status, purge_enabled, max_query_length,
           max_history_items, history_retention_days, effective_at
    FROM app_person_search_policies
    WHERE id = ?
    LIMIT 1
  `).bind(config.policyId).first<SearchPolicyRow>()

  const effectiveAtValid = typeof row?.effective_at === 'string'
    && Number.isFinite(Date.parse(row.effective_at))
    && Date.parse(row.effective_at) <= now.getTime()
  const baseReady = row
    && (row.state === 'development' || row.state === 'published')
    && effectiveAtValid
    && (!config.requireProductionReady || (
      row.state === 'published'
      && row.production_ready === 1
    ))
  if (!baseReady) {
    throw new AppPersonSearchError(
      503,
      'PERSON_SEARCH_POLICY_NOT_READY',
      '人物搜索策略尚未就绪',
      true,
    )
  }
  if (
    row.default_history_recording_enabled !== 0
    || !Number.isSafeInteger(row.max_query_length)
    || row.max_query_length < 1
    || row.max_query_length > APP_PERSON_SEARCH_MAX_QUERY_LENGTH
    || !Number.isSafeInteger(row.max_history_items)
    || row.max_history_items < 1
    || row.max_history_items > APP_PERSON_SEARCH_MAX_HISTORY_ITEMS
    || !Number.isSafeInteger(row.history_retention_days)
    || row.history_retention_days < 1
    || row.history_retention_days > 3650
    || !['unresolved', 'approved'].includes(row.history_retention_decision_status)
  ) {
    throw new AppPersonSearchError(
      503,
      'PERSON_SEARCH_POLICY_INVALID',
      '人物搜索策略不符合当前隐私与技术基线',
    )
  }
  return {
    id: row.id,
    state: row.state as 'development' | 'published',
    productionReady: row.production_ready === 1,
    personSearchEnabled: row.person_search_enabled === 1,
    historyEnabled: row.history_enabled === 1,
    historyProductionReady: row.history_production_ready === 1,
    defaultHistoryRecordingEnabled: false,
    historyRetentionDecisionStatus: row.history_retention_decision_status as 'unresolved' | 'approved',
    purgeEnabled: row.purge_enabled === 1,
    maxQueryLength: row.max_query_length,
    maxHistoryItems: row.max_history_items,
    historyRetentionDays: row.history_retention_days,
    effectiveAt: row.effective_at,
  }
}

function isHistoryReady(
  policy: AppPersonSearchPolicy,
  config: AppPersonSearchRuntimeConfig,
): boolean {
  if (!config.requireProductionReady) return true
  return policy.historyProductionReady
    && policy.historyRetentionDecisionStatus === 'approved'
    && policy.purgeEnabled
}

function requireRuntimeEnabled(config: AppPersonSearchRuntimeConfig): void {
  if (!config.enabled) {
    throw new AppPersonSearchError(403, 'FEATURE_DISABLED', '人物搜索功能尚未开放')
  }
}

function normalizePolicyId(value: string | undefined): string | null {
  const normalized = value?.trim() || ''
  return POLICY_ID_PATTERN.test(normalized) ? normalized : null
}
