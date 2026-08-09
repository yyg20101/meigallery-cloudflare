import type { Bindings } from '../index'

export const APP_RECOMMENDATION_POLICY_ID = 'rcp_app_1_0_recommendation_1_dev_1'
export const APP_RECOMMENDATION_DEFAULT_PAGE_SIZE = 20
export const APP_RECOMMENDATION_MAX_PAGE_SIZE = 40
export const APP_RECOMMENDATION_MAX_PREFERENCE_TERMS = 20

const POLICY_ID_PATTERN = /^rcp_[A-Za-z0-9_-]{1,92}$/u
const RULE_VERSION_ID_PATTERN = /^rrv_[A-Za-z0-9_-]{1,92}$/u
const PLACEMENT_ID_PATTERN = /^rep_[A-Za-z0-9_-]{1,92}$/u
const REGION_CODE_PATTERN = /^[a-z0-9-]{2,32}$/u

export type AppRecommendationMode = 'non_personalized' | 'personalized'

export interface AppRecommendationRuntimeConfig {
  enabled: boolean
  adminEnabled: boolean
  policyId: string
  policyConfigured: boolean
  requireProductionReady: boolean
  cursorSigningSecret: string
}

export interface AppRecommendationPolicy {
  policyId: string
  state: 'development' | 'published'
  productionReady: boolean
  feedEnabled: boolean
  adminOperationsEnabled: boolean
  preferenceEnabled: boolean
  personalizationEnabled: boolean
  personalizationDecisionStatus: 'unresolved' | 'approved'
  evidenceRecordingEnabled: boolean
  evidenceRetentionDecisionStatus: 'unresolved' | 'approved'
  evidenceRetentionDays: number | null
  purgeEnabled: boolean
  defaultPageSize: number
  maxPageSize: number
  maxCandidatePool: number
  maxEditorialItems: number
  minimumClientVersion: string
  effectiveAt: string
}

export interface AppRecommendationCapabilities {
  feed: boolean
  preferences: boolean
  personalization: boolean
  editorial: boolean
  policy: AppRecommendationPolicy | null
  activeRuleVersionId: string | null
}

type PolicyRow = {
  policy_id: string
  state: string
  production_ready: number
  feed_enabled: number
  admin_operations_enabled: number
  preference_enabled: number
  personalization_enabled: number
  personalization_decision_status: string
  evidence_recording_enabled: number
  evidence_retention_decision_status: string
  evidence_retention_days: number | null
  purge_enabled: number
  default_page_size: number
  max_page_size: number
  max_candidate_pool: number
  max_editorial_items: number
  minimum_client_version: string
  effective_at: string
}

export class AppRecommendationError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

export function getAppRecommendationRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_RECOMMENDATION_ENABLED'
  | 'APP_RECOMMENDATION_ADMIN_ENABLED'
  | 'APP_RECOMMENDATION_POLICY_VERSION'
  | 'APP_RECOMMENDATION_PRODUCTION_READY'
  | 'SESSION_SECRET'
>): AppRecommendationRuntimeConfig {
  const configuredPolicyId = normalizeOptionalPolicyId(env.APP_RECOMMENDATION_POLICY_VERSION)
  const cursorSigningSecret = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET : ''
  const cursorSigningReady = cursorSigningSecret.length >= 16
  const requireProductionReady = env.APP_ENV === 'production'
  const productionGateSatisfied = !requireProductionReady
    || env.APP_RECOMMENDATION_PRODUCTION_READY === 'true'
  return {
    enabled: env.APP_RECOMMENDATION_ENABLED === 'true'
      && Boolean(configuredPolicyId)
      && cursorSigningReady
      && productionGateSatisfied,
    adminEnabled: env.APP_RECOMMENDATION_ADMIN_ENABLED === 'true'
      && Boolean(configuredPolicyId)
      && productionGateSatisfied,
    policyId: configuredPolicyId ?? APP_RECOMMENDATION_POLICY_ID,
    policyConfigured: Boolean(configuredPolicyId),
    requireProductionReady,
    cursorSigningSecret,
  }
}

export async function resolveAppRecommendationCapabilities(
  db: D1Database,
  config: AppRecommendationRuntimeConfig,
  now = new Date(),
): Promise<AppRecommendationCapabilities> {
  if (!config.enabled) return closedCapabilities()
  try {
    const policy = await loadAppRecommendationPolicy(db, config, now)
    if (!policy.feedEnabled) return { ...closedCapabilities(), policy }
    const activeRule = await findActiveRecommendationRule(
      db,
      'non_personalized',
      config.requireProductionReady,
      now,
    )
    if (!activeRule) return { ...closedCapabilities(), policy }
    return {
      feed: true,
      preferences: policy.preferenceEnabled,
      personalization: policy.preferenceEnabled
        && policy.personalizationEnabled
        && policy.personalizationDecisionStatus === 'approved',
      editorial: true,
      policy,
      activeRuleVersionId: activeRule.rule_version_id,
    }
  }
  catch {
    return closedCapabilities()
  }
}

export async function requireAppRecommendationPolicy(
  db: D1Database,
  config: AppRecommendationRuntimeConfig,
  capability: 'feed' | 'preferences' | 'admin',
  now = new Date(),
): Promise<AppRecommendationPolicy> {
  if (capability === 'admin' && !config.adminEnabled) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_ADMIN_DISABLED', '推荐运营后台当前保持关闭')
  }
  if (capability !== 'admin' && !config.enabled) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_DISABLED', '推荐能力当前保持关闭')
  }
  const policy = await loadAppRecommendationPolicy(db, config, now)
  if (capability === 'feed' && !policy.feedEnabled) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_FEED_DISABLED', '版本化推荐流当前保持关闭')
  }
  if (capability === 'preferences' && !policy.preferenceEnabled) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_PREFERENCE_DISABLED', '推荐偏好当前保持关闭')
  }
  if (capability === 'admin' && !policy.adminOperationsEnabled) {
    throw new AppRecommendationError(403, 'RECOMMENDATION_ADMIN_DISABLED', '推荐运营后台当前保持关闭')
  }
  return policy
}

export async function findActiveRecommendationRule(
  db: D1Database,
  mode: AppRecommendationMode,
  requireProductionReady: boolean,
  now = new Date(),
) {
  return db.prepare(`
    SELECT rule_version_id
    FROM app_recommendation_rule_versions
    WHERE entry_point = 'discovery_home'
      AND mode = ?
      AND (
        state = 'active'
        OR (state = 'scheduled' AND effective_at IS NOT NULL AND datetime(effective_at) <= datetime(?))
      )
      AND rollout_percent > 0
      AND (effective_at IS NULL OR datetime(effective_at) <= datetime(?))
      AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
      AND (? = 0 OR production_ready = 1)
    ORDER BY
      CASE state WHEN 'scheduled' THEN 0 ELSE 1 END ASC,
      COALESCE(effective_at, activated_at) DESC,
      activated_at DESC,
      rule_version_id ASC
    LIMIT 1
  `).bind(
    mode,
    now.toISOString(),
    now.toISOString(),
    now.toISOString(),
    requireProductionReady ? 1 : 0,
  ).first<{ rule_version_id: string }>()
}

export function normalizeRecommendationExpectedVersion(value: unknown) {
  const parsed = typeof value === 'string' && /^[1-9]\d{0,9}$/u.test(value)
    ? Number(value)
    : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
    throw new AppRecommendationError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  return Number(parsed)
}

export function normalizeRecommendationRuleVersionId(value: unknown) {
  if (typeof value !== 'string' || !RULE_VERSION_ID_PATTERN.test(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_RULE_ID_INVALID', '推荐规则版本 ID 格式无效')
  }
  return value
}

export function normalizeRecommendationPlacementId(value: unknown) {
  if (typeof value !== 'string' || !PLACEMENT_ID_PATTERN.test(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_PLACEMENT_ID_INVALID', '运营精选 ID 格式无效')
  }
  return value
}

export function normalizeRecommendationRegionCode(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new AppRecommendationError(400, 'RECOMMENDATION_REGION_INVALID', '地区代码格式无效')
  }
  const normalized = value.trim().toLowerCase()
  if (!REGION_CODE_PATTERN.test(normalized)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_REGION_INVALID', '地区代码格式无效')
  }
  return normalized
}

async function loadAppRecommendationPolicy(
  db: D1Database,
  config: AppRecommendationRuntimeConfig,
  now: Date,
): Promise<AppRecommendationPolicy> {
  const row = await db.prepare(`
    SELECT policy_id, state, production_ready, feed_enabled,
           admin_operations_enabled, preference_enabled, personalization_enabled,
           personalization_decision_status, evidence_recording_enabled,
           evidence_retention_decision_status, evidence_retention_days, purge_enabled,
           default_page_size, max_page_size, max_candidate_pool, max_editorial_items,
           minimum_client_version, effective_at
    FROM app_recommendation_policies
    WHERE policy_id = ?
    LIMIT 1
  `).bind(config.policyId).first<PolicyRow>()
  const effective = typeof row?.effective_at === 'string'
    && Number.isFinite(Date.parse(row.effective_at))
    && Date.parse(row.effective_at) <= now.getTime()
  const ready = row
    && (row.state === 'development' || row.state === 'published')
    && effective
    && (!config.requireProductionReady || (
      row.state === 'published'
      && row.production_ready === 1
    ))
  if (!ready) {
    throw new AppRecommendationError(
      503,
      'RECOMMENDATION_POLICY_NOT_READY',
      '推荐策略尚未就绪',
      true,
    )
  }
  validatePolicyRow(row)
  return {
    policyId: row.policy_id,
    state: row.state as AppRecommendationPolicy['state'],
    productionReady: row.production_ready === 1,
    feedEnabled: row.feed_enabled === 1,
    adminOperationsEnabled: row.admin_operations_enabled === 1,
    preferenceEnabled: row.preference_enabled === 1,
    personalizationEnabled: row.personalization_enabled === 1,
    personalizationDecisionStatus: row.personalization_decision_status as AppRecommendationPolicy['personalizationDecisionStatus'],
    evidenceRecordingEnabled: row.evidence_recording_enabled === 1,
    evidenceRetentionDecisionStatus: row.evidence_retention_decision_status as AppRecommendationPolicy['evidenceRetentionDecisionStatus'],
    evidenceRetentionDays: row.evidence_retention_days,
    purgeEnabled: row.purge_enabled === 1,
    defaultPageSize: row.default_page_size,
    maxPageSize: row.max_page_size,
    maxCandidatePool: row.max_candidate_pool,
    maxEditorialItems: row.max_editorial_items,
    minimumClientVersion: row.minimum_client_version,
    effectiveAt: row.effective_at,
  }
}

function validatePolicyRow(row: PolicyRow) {
  const booleans = [
    row.production_ready,
    row.feed_enabled,
    row.admin_operations_enabled,
    row.preference_enabled,
    row.personalization_enabled,
    row.evidence_recording_enabled,
    row.purge_enabled,
  ]
  const invalid = booleans.some(value => value !== 0 && value !== 1)
    || !Number.isSafeInteger(row.default_page_size)
    || row.default_page_size < 1
    || !Number.isSafeInteger(row.max_page_size)
    || row.max_page_size < row.default_page_size
    || row.max_page_size > APP_RECOMMENDATION_MAX_PAGE_SIZE
    || !Number.isSafeInteger(row.max_candidate_pool)
    || row.max_candidate_pool < row.max_page_size
    || row.max_candidate_pool > 500
    || !Number.isSafeInteger(row.max_editorial_items)
    || row.max_editorial_items < 0
    || row.max_editorial_items > 10
    || !['unresolved', 'approved'].includes(row.personalization_decision_status)
    || !['unresolved', 'approved'].includes(row.evidence_retention_decision_status)
    || (row.personalization_enabled === 1 && row.personalization_decision_status !== 'approved')
    || (row.evidence_recording_enabled === 1 && (
      row.evidence_retention_decision_status !== 'approved'
      || row.evidence_retention_days === null
      || row.purge_enabled !== 1
    ))
  if (invalid) {
    throw new AppRecommendationError(
      503,
      'RECOMMENDATION_POLICY_INVALID',
      '推荐策略内容不完整或不安全',
      true,
    )
  }
}

function normalizeOptionalPolicyId(value: unknown) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return POLICY_ID_PATTERN.test(normalized) ? normalized : null
}

function closedCapabilities(): AppRecommendationCapabilities {
  return {
    feed: false,
    preferences: false,
    personalization: false,
    editorial: false,
    policy: null,
    activeRuleVersionId: null,
  }
}
