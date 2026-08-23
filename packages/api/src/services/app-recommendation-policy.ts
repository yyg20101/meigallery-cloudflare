import type { Bindings } from '../index'
import {
  normalizeAppNumericVersion,
  supportsAppMinimumVersion,
} from './app-client-version'
import { recommendationRuleMatchesRegion } from './app-recommendation-region'
import { getAppOperationalControl } from './app-operational-safety'

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
  clientVersionValue: string | undefined,
  now = new Date(),
): Promise<AppRecommendationCapabilities> {
  if (!config.enabled) return closedCapabilities()
  const clientVersion = normalizeAppNumericVersion(clientVersionValue)
  if (!clientVersion) return closedCapabilities()
  try {
    const operationalControl = await getAppOperationalControl(db, 'recommendation_delivery')
    if (operationalControl.state !== 'available') return closedCapabilities()
    const policy = await loadAppRecommendationPolicy(db, config, now)
    if (!policy.feedEnabled) return { ...closedCapabilities(), policy }
    if (!supportsAppMinimumVersion(clientVersion, policy.minimumClientVersion)) {
      return { ...closedCapabilities(), policy }
    }
    const activeRule = await findActiveRecommendationRule(
      db,
      'non_personalized',
      clientVersion,
      undefined,
      undefined,
      config.requireProductionReady,
      now,
    )
    if (!activeRule) return { ...closedCapabilities(), policy }
    const activePersonalizedRule = policy.personalizationEnabled
      && policy.personalizationDecisionStatus === 'approved'
      ? await findActiveRecommendationRule(
          db,
          'personalized',
          clientVersion,
          undefined,
          undefined,
          config.requireProductionReady,
          now,
        )
      : null
    return {
      feed: true,
      preferences: policy.preferenceEnabled,
      personalization: policy.preferenceEnabled
        && policy.personalizationEnabled
        && policy.personalizationDecisionStatus === 'approved'
        && Boolean(activePersonalizedRule),
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
  clientVersionValue?: string,
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
  if (capability !== 'admin') {
    const clientVersion = normalizeAppNumericVersion(clientVersionValue)
    if (!clientVersion) {
      throw new AppRecommendationError(
        400,
        'APP_CLIENT_VERSION_INVALID',
        'X-Client-Version 必须为两段或三段数字版本',
      )
    }
    if (!supportsAppMinimumVersion(clientVersion, policy.minimumClientVersion)) {
      throw new AppRecommendationError(
        403,
        'RECOMMENDATION_CLIENT_VERSION_UNSUPPORTED',
        '当前客户端版本尚不支持此推荐策略，请先更新 App',
      )
    }
  }
  return policy
}

export async function findActiveRecommendationRule(
  db: D1Database,
  mode: AppRecommendationMode,
  clientVersion: string,
  regionCode: string | null | undefined,
  taxonomyCatalogId: string | null | undefined,
  requireProductionReady: boolean,
  now = new Date(),
) {
  const compatible = await listCompatibleRecommendationRules(
    db,
    mode,
    clientVersion,
    regionCode,
    taxonomyCatalogId,
    requireProductionReady,
    now,
  )
  return compatible[0] ?? null
}

export async function listCompatibleRecommendationRules(
  db: D1Database,
  mode: AppRecommendationMode,
  clientVersion: string,
  regionCode: string | null | undefined,
  taxonomyCatalogId: string | null | undefined,
  requireProductionReady: boolean,
  now = new Date(),
) {
  const candidates = await db.prepare(`
    SELECT rule.rule_version_id, rule.entry_point, rule.mode, rule.state,
           rule.taxonomy_catalog_id, rule.minimum_client_version,
           rule.target_region_codes_json, rule.rollback_rule_version_id,
           rule.rollout_percent, rule.guardrail_policy_id,
           policy.state AS guardrail_policy_state,
           policy.production_ready AS guardrail_policy_production_ready,
           policy.source_key AS guardrail_policy_source_key,
           EXISTS (
             SELECT 1
             FROM app_recommendation_guardrail_controls control
             WHERE control.control_id = 'recommendation_guardrails'
               AND control.evaluation_enabled = 1
               AND control.source_decision_status = 'approved'
               AND control.retention_decision_status = 'approved'
               AND control.retention_days IS NOT NULL
               AND control.purge_enabled = 1
               AND control.source_key = policy.source_key
           ) AS guardrail_control_ready,
           COALESCE((
             SELECT control.production_ready
             FROM app_recommendation_guardrail_controls control
             WHERE control.control_id = 'recommendation_guardrails'
             LIMIT 1
           ), 0) AS guardrail_control_production_ready,
           EXISTS (
             SELECT 1
             FROM app_recommendation_guardrail_blocks block
             WHERE block.rule_version_id = rule.rule_version_id
           ) AS guardrail_blocked
    FROM app_recommendation_rule_versions rule
    LEFT JOIN app_recommendation_guardrail_policies policy
      ON policy.policy_id = rule.guardrail_policy_id
    WHERE rule.entry_point = 'discovery_home'
      AND rule.mode = ?
      AND (
        rule.state = 'active'
        OR (rule.state = 'scheduled' AND rule.effective_at IS NOT NULL AND datetime(rule.effective_at) <= datetime(?))
      )
      AND rule.rollout_percent > 0
      AND (rule.effective_at IS NULL OR datetime(rule.effective_at) <= datetime(?))
      AND (rule.expires_at IS NULL OR datetime(rule.expires_at) > datetime(?))
      AND (? = 0 OR rule.production_ready = 1)
    ORDER BY
      CASE rule.state WHEN 'scheduled' THEN 0 ELSE 1 END ASC,
      COALESCE(rule.effective_at, rule.activated_at) DESC,
      rule.activated_at DESC,
      rule.rule_version_id ASC
    LIMIT 2
  `).bind(
    mode,
    now.toISOString(),
    now.toISOString(),
    now.toISOString(),
    requireProductionReady ? 1 : 0,
  ).all<{
    rule_version_id: string
    entry_point: string
    mode: string
    state: string
    taxonomy_catalog_id: string | null
    minimum_client_version: string
    target_region_codes_json: string
    rollback_rule_version_id: string | null
    rollout_percent: number
    guardrail_policy_id: string | null
    guardrail_policy_state: string | null
    guardrail_policy_production_ready: number | null
    guardrail_policy_source_key: string | null
    guardrail_control_ready: number
    guardrail_control_production_ready: number
    guardrail_blocked: number
  }>()

  const compatible: Array<{ rule_version_id: string }> = []
  const selectedIds = new Set<string>()
  for (const candidate of candidates.results) {
    if (
      recommendationRuleMatchesRegion(candidate.target_region_codes_json, regionCode)
      && supportsAppMinimumVersion(clientVersion, candidate.minimum_client_version)
      && recommendationRuleMatchesTaxonomy(mode, candidate.taxonomy_catalog_id, taxonomyCatalogId)
      && recommendationGuardrailAllowsDelivery(candidate, requireProductionReady)
    ) {
      compatible.push({ rule_version_id: candidate.rule_version_id })
      selectedIds.add(candidate.rule_version_id)
    }
  }

  for (const candidate of candidates.results) {
    if (!candidate.rollback_rule_version_id) continue
    const fallback = await db.prepare(`
      SELECT rule.rule_version_id, rule.taxonomy_catalog_id, rule.minimum_client_version,
             rule.target_region_codes_json, rule.rollout_percent, rule.guardrail_policy_id,
             policy.state AS guardrail_policy_state,
             policy.production_ready AS guardrail_policy_production_ready,
             policy.source_key AS guardrail_policy_source_key,
             EXISTS (
               SELECT 1
               FROM app_recommendation_guardrail_controls control
               WHERE control.control_id = 'recommendation_guardrails'
                 AND control.evaluation_enabled = 1
                 AND control.source_decision_status = 'approved'
                 AND control.retention_decision_status = 'approved'
                 AND control.retention_days IS NOT NULL
                 AND control.purge_enabled = 1
                 AND control.source_key = policy.source_key
             ) AS guardrail_control_ready,
             COALESCE((
               SELECT control.production_ready
               FROM app_recommendation_guardrail_controls control
               WHERE control.control_id = 'recommendation_guardrails'
               LIMIT 1
             ), 0) AS guardrail_control_production_ready,
             EXISTS (
               SELECT 1
               FROM app_recommendation_guardrail_blocks block
               WHERE block.rule_version_id = rule.rule_version_id
             ) AS guardrail_blocked
      FROM app_recommendation_rule_versions rule
      LEFT JOIN app_recommendation_guardrail_policies policy
        ON policy.policy_id = rule.guardrail_policy_id
      WHERE rule.rule_version_id = ?
        AND rule.entry_point = ?
        AND rule.mode = ?
        AND rule.rollout_percent = 100
        AND rule.state IN ('active', 'paused', 'retired', 'rolled_back')
        AND rule.activated_at IS NOT NULL
        AND (rule.effective_at IS NULL OR datetime(rule.effective_at) <= datetime(?))
        AND (rule.expires_at IS NULL OR datetime(rule.expires_at) > datetime(?))
        AND (? = 0 OR rule.production_ready = 1)
      LIMIT 1
    `).bind(
      candidate.rollback_rule_version_id,
      candidate.entry_point,
      candidate.mode,
      now.toISOString(),
      now.toISOString(),
      requireProductionReady ? 1 : 0,
    ).first<{
      rule_version_id: string
      taxonomy_catalog_id: string | null
      minimum_client_version: string
      target_region_codes_json: string
      rollout_percent: number
      guardrail_policy_id: string | null
      guardrail_policy_state: string | null
      guardrail_policy_production_ready: number | null
      guardrail_policy_source_key: string | null
      guardrail_control_ready: number
      guardrail_control_production_ready: number
      guardrail_blocked: number
    }>()
    if (
      fallback
      && !selectedIds.has(fallback.rule_version_id)
      && recommendationRuleMatchesRegion(fallback.target_region_codes_json, regionCode)
      && supportsAppMinimumVersion(clientVersion, fallback.minimum_client_version)
      && recommendationRuleMatchesTaxonomy(mode, fallback.taxonomy_catalog_id, taxonomyCatalogId)
      && recommendationGuardrailAllowsDelivery(fallback, requireProductionReady)
    ) {
      compatible.push({ rule_version_id: fallback.rule_version_id })
      selectedIds.add(fallback.rule_version_id)
    }
  }

  return compatible
}

function recommendationGuardrailAllowsDelivery(
  rule: {
    rollout_percent: number
    guardrail_policy_id: string | null
    guardrail_policy_state: string | null
    guardrail_policy_production_ready: number | null
    guardrail_policy_source_key: string | null
    guardrail_control_ready: number
    guardrail_control_production_ready: number
    guardrail_blocked: number
  },
  requireProductionReady: boolean,
) {
  if (rule.guardrail_blocked === 1) return false
  if (rule.rollout_percent >= 100) return true
  return rule.rollout_percent > 0
    && Boolean(rule.guardrail_policy_id)
    && rule.guardrail_policy_state === 'approved'
    && rule.guardrail_policy_source_key === 'recommendation_aggregate_v1'
    && rule.guardrail_control_ready === 1
    && (!requireProductionReady || (
      rule.guardrail_policy_production_ready === 1
      && rule.guardrail_control_production_ready === 1
    ))
}

function recommendationRuleMatchesTaxonomy(
  mode: AppRecommendationMode,
  ruleCatalogId: string | null,
  requestedCatalogId: string | null | undefined,
) {
  return mode !== 'personalized'
    || requestedCatalogId === undefined
    || ruleCatalogId === requestedCatalogId
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
    || normalizeAppNumericVersion(row.minimum_client_version) === null
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
