import type { Bindings } from '../index'
import {
  getAppMembershipRuntimeConfig,
  type AppMembershipRuntimeConfig,
} from './app-membership'
import {
  getAppPersonSearchRuntimeConfig,
  type AppPersonSearchRuntimeConfig,
} from './app-person-search-policy'
import {
  APP_ADVANCED_FILTER_ENTITLEMENT,
  APP_SAVED_FILTER_MAX_ENTITLEMENT,
} from './app-search-filters'
import {
  getAppTaxonomyRuntimeConfig,
  type AppTaxonomyRuntimeConfig,
} from './app-taxonomy'

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
  structured_filters_enabled: number
  filter_preview_enabled: number
  saved_filters_enabled: number
  max_filter_terms: number
  max_saved_filter_name_length: number
  effective_at: string
  created_at: string
}

type TaxonomyCatalogRow = {
  catalog_id: string
  version_code: string
  state: string
  production_ready: number
  effective_at: string
  minimum_client_version: string
  item_count: number
  closure_count: number
}

type MembershipCatalogRow = {
  id: string
  version_code: string
  state: string
  production_ready: number
  effective_at: string
  minimum_client_version: string
  tier_count: number
}

type MembershipEntitlementDefinitionRow = {
  entitlement_key: string
  value_type: string
}

type MembershipTierSearchEntitlementRow = {
  tier_id: string
  code: string
  display_name: string
  rank: number
  advanced_value_json: string | null
  advanced_availability: string | null
  saved_max_value_json: string | null
  saved_max_availability: string | null
}

type HistoryPreferenceSummaryRow = {
  preference_count: number
  recording_enabled_count: number
}

type SearchHistorySummaryRow = {
  account_count: number
  active_item_count: number
  expired_item_count: number
  expiring_soon_count: number
}

type SavedFilterSummaryRow = {
  account_count: number
  active_filter_count: number
  deleted_filter_count: number
  current_catalog_count: number
  other_catalog_count: number
  latest_updated_at: string | null
}

type SavedFilterReferenceSummaryRow = {
  active_reference_count: number
  needs_review_filter_count: number
  missing_reference_count: number
  redirected_filter_count: number
  deprecated_filter_count: number
  restricted_filter_count: number
}

type SavedFilterCatalogUsageRow = {
  catalog_id: string
  catalog_version_code: string | null
  catalog_state: string | null
  active_filter_count: number
  account_count: number
  latest_updated_at: string | null
}

export class AdminAppSearchError extends Error {
  constructor(
    readonly status: 503,
    readonly code: string,
    message: string,
    readonly retryable = true,
  ) {
    super(message)
  }
}

export async function getAdminAppSearchOverview(
  db: D1Database,
  env: Bindings,
  now = new Date(),
) {
  const searchConfig = getAppPersonSearchRuntimeConfig(env)
  const taxonomyConfig = getAppTaxonomyRuntimeConfig(env)
  const membershipConfig = getAppMembershipRuntimeConfig(env)
  const nowIso = now.toISOString()
  const expiringSoonIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

  try {
    const [
      policyRows,
      taxonomyCatalog,
      membershipCatalog,
      membershipDefinitions,
      membershipTiers,
      historyPreferences,
      searchHistory,
      savedFilters,
      savedFilterReferences,
      savedFilterCatalogUsage,
    ] = await Promise.all([
      db.prepare(`
        SELECT id, state, production_ready, person_search_enabled, history_enabled,
               history_production_ready, default_history_recording_enabled,
               history_retention_decision_status, purge_enabled, max_query_length,
               max_history_items, history_retention_days, structured_filters_enabled,
               filter_preview_enabled, saved_filters_enabled, max_filter_terms,
               max_saved_filter_name_length, effective_at, created_at
        FROM app_person_search_policies
        ORDER BY created_at DESC, id ASC
        LIMIT 100
      `).all<SearchPolicyRow>(),
      db.prepare(`
        SELECT c.catalog_id, c.version_code, c.state, c.production_ready,
               c.effective_at, c.minimum_client_version, c.item_count,
               (SELECT COUNT(*) FROM app_taxonomy_catalog_closure closure
                WHERE closure.catalog_id = c.catalog_id) AS closure_count
        FROM app_taxonomy_catalogs c
        WHERE c.catalog_id = ?
        LIMIT 1
      `).bind(taxonomyConfig.catalogId).first<TaxonomyCatalogRow>(),
      db.prepare(`
        SELECT c.id, c.version_code, c.state, c.production_ready, c.effective_at,
               c.minimum_client_version,
               (SELECT COUNT(*) FROM app_membership_tiers tier
                WHERE tier.catalog_version_id = c.id) AS tier_count
        FROM app_membership_catalog_versions c
        WHERE c.id = ?
        LIMIT 1
      `).bind(membershipConfig.catalogVersionId).first<MembershipCatalogRow>(),
      db.prepare(`
        SELECT entitlement_key, value_type
        FROM app_entitlement_definitions
        WHERE catalog_version_id = ?
          AND entitlement_key IN (?, ?)
        ORDER BY entitlement_key ASC
      `).bind(
        membershipConfig.catalogVersionId,
        APP_ADVANCED_FILTER_ENTITLEMENT,
        APP_SAVED_FILTER_MAX_ENTITLEMENT,
      ).all<MembershipEntitlementDefinitionRow>(),
      db.prepare(`
        SELECT tier.tier_id, tier.code, tier.display_name, tier.rank,
               advanced.value_json AS advanced_value_json,
               advanced.availability AS advanced_availability,
               saved.value_json AS saved_max_value_json,
               saved.availability AS saved_max_availability
        FROM app_membership_tiers tier
        LEFT JOIN app_membership_tier_entitlements advanced
          ON advanced.catalog_version_id = tier.catalog_version_id
         AND advanced.tier_id = tier.tier_id
         AND advanced.entitlement_key = ?
        LEFT JOIN app_membership_tier_entitlements saved
          ON saved.catalog_version_id = tier.catalog_version_id
         AND saved.tier_id = tier.tier_id
         AND saved.entitlement_key = ?
        WHERE tier.catalog_version_id = ?
        ORDER BY tier.rank ASC, tier.tier_id ASC
      `).bind(
        APP_ADVANCED_FILTER_ENTITLEMENT,
        APP_SAVED_FILTER_MAX_ENTITLEMENT,
        membershipConfig.catalogVersionId,
      ).all<MembershipTierSearchEntitlementRow>(),
      db.prepare(`
        SELECT COUNT(*) AS preference_count,
               COALESCE(SUM(CASE WHEN recording_enabled = 1 THEN 1 ELSE 0 END), 0)
                 AS recording_enabled_count
        FROM app_search_history_preferences
      `).first<HistoryPreferenceSummaryRow>(),
      db.prepare(`
        SELECT COUNT(DISTINCT account_id) AS account_count,
               COALESCE(SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END), 0)
                 AS active_item_count,
               COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0)
                 AS expired_item_count,
               COALESCE(SUM(CASE WHEN expires_at > ? AND expires_at <= ? THEN 1 ELSE 0 END), 0)
                 AS expiring_soon_count
        FROM app_person_search_history
      `).bind(nowIso, nowIso, nowIso, expiringSoonIso).first<SearchHistorySummaryRow>(),
      db.prepare(`
        SELECT COUNT(DISTINCT CASE WHEN deleted_at IS NULL THEN account_id END) AS account_count,
               COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0)
                 AS active_filter_count,
               COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0)
                 AS deleted_filter_count,
               COALESCE(SUM(CASE WHEN deleted_at IS NULL AND catalog_id = ? THEN 1 ELSE 0 END), 0)
                 AS current_catalog_count,
               COALESCE(SUM(CASE WHEN deleted_at IS NULL AND catalog_id <> ? THEN 1 ELSE 0 END), 0)
                 AS other_catalog_count,
               MAX(CASE WHEN deleted_at IS NULL THEN updated_at END) AS latest_updated_at
        FROM app_saved_person_filters
      `).bind(taxonomyConfig.catalogId, taxonomyConfig.catalogId).first<SavedFilterSummaryRow>(),
      db.prepare(`
        WITH refs AS (
          SELECT CAST(filter.account_id AS TEXT) || ':' || filter.filter_id AS filter_key,
                 filter.catalog_id AS source_catalog_id,
                 item.term_id,
                 item.public_state,
                 item.visibility,
                 item.sensitivity
          FROM app_saved_person_filters filter
          JOIN json_each(filter.term_ids_json) selected
          LEFT JOIN app_taxonomy_catalog_items item
            ON item.catalog_id = filter.catalog_id
           AND item.term_id = selected.value
          WHERE filter.deleted_at IS NULL
        )
        SELECT COUNT(*) AS active_reference_count,
               COUNT(DISTINCT CASE
                 WHEN source_catalog_id <> ? OR term_id IS NULL OR public_state <> 'active'
                   OR visibility <> 'public' OR sensitivity <> 'standard'
                 THEN filter_key END) AS needs_review_filter_count,
               COALESCE(SUM(CASE WHEN term_id IS NULL THEN 1 ELSE 0 END), 0)
                 AS missing_reference_count,
               COUNT(DISTINCT CASE WHEN public_state = 'redirect' THEN filter_key END)
                 AS redirected_filter_count,
               COUNT(DISTINCT CASE WHEN public_state = 'deprecated' THEN filter_key END)
                 AS deprecated_filter_count,
               COUNT(DISTINCT CASE
                 WHEN term_id IS NOT NULL AND (visibility <> 'public' OR sensitivity <> 'standard')
                 THEN filter_key END) AS restricted_filter_count
        FROM refs
      `).bind(taxonomyConfig.catalogId).first<SavedFilterReferenceSummaryRow>(),
      db.prepare(`
        SELECT filter.catalog_id, catalog.version_code AS catalog_version_code,
               catalog.state AS catalog_state, COUNT(*) AS active_filter_count,
               COUNT(DISTINCT filter.account_id) AS account_count,
               MAX(filter.updated_at) AS latest_updated_at
        FROM app_saved_person_filters filter
        LEFT JOIN app_taxonomy_catalogs catalog ON catalog.catalog_id = filter.catalog_id
        WHERE filter.deleted_at IS NULL
        GROUP BY filter.catalog_id, catalog.version_code, catalog.state
        ORDER BY active_filter_count DESC, filter.catalog_id ASC
        LIMIT 50
      `).all<SavedFilterCatalogUsageRow>(),
    ])

    const policies = policyRows.results.map(row => mapPolicy(
      row,
      row.id === searchConfig.policyId,
      searchConfig.requireProductionReady,
      now,
    ))
    const selectedPolicy = policies.find(policy => policy.selected) ?? null
    const taxonomy = mapTaxonomyDependency(taxonomyConfig, taxonomyCatalog, now)
    const membership = mapMembershipDependency(
      membershipConfig,
      membershipCatalog,
      membershipDefinitions.results,
      membershipTiers.results,
      now,
    )

    return {
      generatedAt: nowIso,
      runtime: {
        environment: env.APP_ENV,
        authEnabled: env.APP_AUTH_ENABLED === 'true',
        search: {
          featureFlagEnabled: env.APP_PERSON_SEARCH_ENABLED === 'true',
          productionGateEnabled: !searchConfig.requireProductionReady
            || env.APP_PERSON_SEARCH_PRODUCTION_READY === 'true',
          policyConfigured: searchConfig.policyConfigured,
          selectedPolicyId: searchConfig.policyId,
          runtimeEnabled: searchConfig.enabled,
          requireProductionReady: searchConfig.requireProductionReady,
        },
      },
      readiness: buildReadiness({
        authEnabled: env.APP_AUTH_ENABLED === 'true',
        searchConfig,
        selectedPolicy,
        taxonomy,
        membership,
      }),
      policies,
      taxonomy,
      membership,
      privacy: {
        historyPreferenceCount: safeCount(historyPreferences?.preference_count),
        historyRecordingEnabledCount: safeCount(historyPreferences?.recording_enabled_count),
        historyAccountCount: safeCount(searchHistory?.account_count),
        activeHistoryItemCount: safeCount(searchHistory?.active_item_count),
        expiredHistoryItemCount: safeCount(searchHistory?.expired_item_count),
        expiringSoonHistoryItemCount: safeCount(searchHistory?.expiring_soon_count),
        savedFilterAccountCount: safeCount(savedFilters?.account_count),
        activeSavedFilterCount: safeCount(savedFilters?.active_filter_count),
        deletedSavedFilterCount: safeCount(savedFilters?.deleted_filter_count),
        currentCatalogSavedFilterCount: safeCount(savedFilters?.current_catalog_count),
        otherCatalogSavedFilterCount: safeCount(savedFilters?.other_catalog_count),
        latestSavedFilterUpdatedAt: savedFilters?.latest_updated_at ?? null,
        activeSavedFilterReferenceCount: safeCount(savedFilterReferences?.active_reference_count),
        needsReviewSavedFilterCount: safeCount(savedFilterReferences?.needs_review_filter_count),
        missingSavedFilterReferenceCount: safeCount(savedFilterReferences?.missing_reference_count),
        redirectedSavedFilterCount: safeCount(savedFilterReferences?.redirected_filter_count),
        deprecatedSavedFilterCount: safeCount(savedFilterReferences?.deprecated_filter_count),
        restrictedSavedFilterCount: safeCount(savedFilterReferences?.restricted_filter_count),
      },
      savedFilterCatalogUsage: savedFilterCatalogUsage.results.map(row => ({
        catalogVersionId: row.catalog_id,
        versionCode: row.catalog_version_code,
        state: row.catalog_state,
        activeFilterCount: safeCount(row.active_filter_count),
        accountCount: safeCount(row.account_count),
        latestUpdatedAt: row.latest_updated_at,
      })),
    }
  }
  catch (error) {
    if (isMissingSearchSchema(error)) {
      throw new AdminAppSearchError(
        503,
        'APP_SEARCH_ADMIN_SCHEMA_NOT_READY',
        '搜索运营数据结构尚未就绪，请在统一配置阶段执行 0080–0082 migration 后重试',
      )
    }
    throw error
  }
}

function mapPolicy(
  row: SearchPolicyRow,
  selected: boolean,
  requireProductionReady: boolean,
  now: Date,
) {
  const blockers: string[] = []
  const effectiveAt = Date.parse(row.effective_at)
  if (!['development', 'published'].includes(row.state)) blockers.push('策略已退役')
  if (!Number.isFinite(effectiveAt) || effectiveAt > now.getTime()) blockers.push('策略尚未到生效时间')
  if (row.default_history_recording_enabled !== 0) blockers.push('搜索历史默认值必须保持关闭')
  if (row.filter_preview_enabled === 1 && row.structured_filters_enabled !== 1) {
    blockers.push('结果预估不能脱离结构化筛选启用')
  }
  if (row.saved_filters_enabled === 1 && row.structured_filters_enabled !== 1) {
    blockers.push('保存条件不能脱离结构化筛选启用')
  }
  if (row.history_production_ready === 1 && (
    row.history_enabled !== 1
    || row.history_retention_decision_status !== 'approved'
    || row.purge_enabled !== 1
  )) {
    blockers.push('搜索历史生产门禁缺少保留决策或清理能力')
  }
  if (requireProductionReady && (
    row.state !== 'published'
    || row.production_ready !== 1
  )) {
    blockers.push('生产环境要求已发布且 production-ready')
  }
  return {
    policyId: row.id,
    state: row.state,
    productionReady: row.production_ready === 1,
    selected,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
    capabilities: {
      profiles: row.person_search_enabled === 1,
      history: row.history_enabled === 1,
      historyProductionReady: row.history_production_ready === 1,
      structuredFilters: row.structured_filters_enabled === 1,
      filterPreview: row.filter_preview_enabled === 1,
      savedFilters: row.saved_filters_enabled === 1,
    },
    privacy: {
      historyRecordingDefault: false,
      historyRetentionDecisionStatus: row.history_retention_decision_status,
      purgeEnabled: row.purge_enabled === 1,
      historyRetentionDays: row.history_retention_days,
    },
    limits: {
      maxQueryLength: row.max_query_length,
      maxHistoryItems: row.max_history_items,
      maxFilterTerms: row.max_filter_terms,
      maxSavedFilterNameLength: row.max_saved_filter_name_length,
    },
    readyForCurrentEnvironment: blockers.length === 0,
    blockers,
  }
}

function mapTaxonomyDependency(
  config: AppTaxonomyRuntimeConfig,
  row: TaxonomyCatalogRow | null,
  now: Date,
) {
  const blockers: string[] = []
  if (!config.catalogConfigured) blockers.push('未配置 taxonomy 目录 ID')
  if (!config.enabled) blockers.push('taxonomy 运行开关未启用或生产门禁未通过')
  if (!row) blockers.push('所选 taxonomy 目录不存在')
  if (row) {
    const effectiveAt = Date.parse(row.effective_at)
    if (!['development', 'published'].includes(row.state)) blockers.push('所选 taxonomy 目录已退役')
    if (!Number.isFinite(effectiveAt) || effectiveAt > now.getTime()) blockers.push('taxonomy 目录尚未到生效时间')
    if (row.item_count <= 0) blockers.push('taxonomy 目录为空')
    if (row.closure_count < row.item_count) blockers.push('taxonomy 闭包不完整')
    if (config.requireProductionReady && (
      row.state !== 'published'
      || row.production_ready !== 1
    )) blockers.push('生产 taxonomy 目录未通过发布门禁')
  }
  return {
    featureEnabled: config.enabled,
    catalogConfigured: config.catalogConfigured,
    configuredCatalogVersionId: config.catalogId,
    ready: blockers.length === 0,
    blockers,
    catalog: row
      ? {
          catalogVersionId: row.catalog_id,
          versionCode: row.version_code,
          state: row.state,
          productionReady: row.production_ready === 1,
          effectiveAt: row.effective_at,
          minimumClientVersion: row.minimum_client_version,
          itemCount: safeCount(row.item_count),
          closureCount: safeCount(row.closure_count),
        }
      : null,
  }
}

function mapMembershipDependency(
  config: AppMembershipRuntimeConfig,
  catalog: MembershipCatalogRow | null,
  definitions: MembershipEntitlementDefinitionRow[],
  tierRows: MembershipTierSearchEntitlementRow[],
  now: Date,
) {
  const tiers = tierRows.map(row => {
    const advancedTier = parseJsonScalar(row.advanced_value_json)
    const savedFilterMax = parseJsonScalar(row.saved_max_value_json)
    const valid = row.advanced_availability === 'available'
      && row.saved_max_availability === 'available'
      && ['none', 'basic', 'full'].includes(String(advancedTier))
      && Number.isSafeInteger(savedFilterMax)
      && Number(savedFilterMax) >= 0
      && Number(savedFilterMax) <= 100
    return {
      tierId: row.tier_id,
      code: row.code,
      displayName: row.display_name,
      rank: row.rank,
      advancedTier,
      savedFilterMax,
      available: row.advanced_availability === 'available'
        && row.saved_max_availability === 'available',
      valid,
    }
  })
  const definitionMap = new Map(definitions.map(item => [item.entitlement_key, item.value_type]))
  const blockers: string[] = []
  if (!config.catalogVersionId) blockers.push('未配置会员目录 ID')
  if (!config.enabled) blockers.push('会员运行开关未启用或生产门禁未通过')
  if (!catalog) blockers.push('所选会员目录不存在')
  if (catalog) {
    const effectiveAt = Date.parse(catalog.effective_at)
    if (!['development', 'published'].includes(catalog.state)) blockers.push('所选会员目录已退役')
    if (!Number.isFinite(effectiveAt) || effectiveAt > now.getTime()) blockers.push('会员目录尚未到生效时间')
    if (catalog.tier_count <= 0) blockers.push('会员目录没有等级')
    if (config.requireProductionReady && (
      catalog.state !== 'published'
      || catalog.production_ready !== 1
    )) blockers.push('生产会员目录未通过发布门禁')
  }
  if (definitionMap.get(APP_ADVANCED_FILTER_ENTITLEMENT) !== 'enum') {
    blockers.push('缺少 enum 类型的高级筛选 entitlement')
  }
  if (definitionMap.get(APP_SAVED_FILTER_MAX_ENTITLEMENT) !== 'integer') {
    blockers.push('缺少 integer 类型的保存条件额度 entitlement')
  }
  if (!tiers.length || tiers.some(tier => !tier.valid)) {
    blockers.push('至少一个会员等级缺少有效的 Search-2 entitlement 执行值')
  }
  return {
    featureEnabled: config.enabled,
    catalogConfigured: Boolean(config.catalogVersionId),
    configuredCatalogVersionId: config.catalogVersionId,
    ready: blockers.length === 0,
    blockers,
    catalog: catalog
      ? {
          catalogVersionId: catalog.id,
          versionCode: catalog.version_code,
          state: catalog.state,
          productionReady: catalog.production_ready === 1,
          effectiveAt: catalog.effective_at,
          minimumClientVersion: catalog.minimum_client_version,
          tierCount: safeCount(catalog.tier_count),
        }
      : null,
    entitlementKeys: {
      advanced: APP_ADVANCED_FILTER_ENTITLEMENT,
      savedFilterMax: APP_SAVED_FILTER_MAX_ENTITLEMENT,
    },
    tiers,
  }
}

function buildReadiness(input: {
  authEnabled: boolean
  searchConfig: AppPersonSearchRuntimeConfig
  selectedPolicy: ReturnType<typeof mapPolicy> | null
  taxonomy: ReturnType<typeof mapTaxonomyDependency>
  membership: ReturnType<typeof mapMembershipDependency>
}) {
  const common = searchCommonBlockers(input)
  const profiles = [...common]
  if (input.selectedPolicy && !input.selectedPolicy.capabilities.profiles) {
    profiles.push('策略未启用人物搜索')
  }
  const history = [...common]
  if (input.selectedPolicy && !input.selectedPolicy.capabilities.history) {
    history.push('策略未启用搜索历史')
  }
  if (input.searchConfig.requireProductionReady && input.selectedPolicy && (
    !input.selectedPolicy.capabilities.historyProductionReady
    || input.selectedPolicy.privacy.historyRetentionDecisionStatus !== 'approved'
    || !input.selectedPolicy.privacy.purgeEnabled
  )) history.push('搜索历史保留决策或到期清理尚未通过生产门禁')

  const filters = [...common]
  if (input.selectedPolicy && (
    !input.selectedPolicy.capabilities.structuredFilters
    || !input.selectedPolicy.capabilities.filterPreview
  )) filters.push('策略未同时启用结构化筛选与结果预估')
  filters.push(...input.taxonomy.blockers)

  const savedFilters = [...filters]
  if (input.selectedPolicy && !input.selectedPolicy.capabilities.savedFilters) {
    savedFilters.push('策略未启用保存条件')
  }
  savedFilters.push(...input.membership.blockers)

  return {
    profiles: readinessItem(profiles),
    history: readinessItem(history),
    filters: readinessItem(filters),
    savedFilters: readinessItem(savedFilters),
  }
}

function searchCommonBlockers(input: {
  authEnabled: boolean
  searchConfig: AppPersonSearchRuntimeConfig
  selectedPolicy: ReturnType<typeof mapPolicy> | null
}) {
  const blockers: string[] = []
  if (!input.authEnabled) blockers.push('App 认证能力未启用')
  if (!input.searchConfig.policyConfigured) blockers.push('未配置搜索策略 ID')
  if (!input.searchConfig.enabled) blockers.push('搜索运行开关未启用或生产门禁未通过')
  if (!input.selectedPolicy) blockers.push('所选搜索策略不存在')
  else blockers.push(...input.selectedPolicy.blockers)
  return blockers
}

function readinessItem(blockers: string[]) {
  const uniqueBlockers = [...new Set(blockers)]
  return { ready: uniqueBlockers.length === 0, blockers: uniqueBlockers }
}

function safeCount(value: unknown) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0
}

function parseJsonScalar(value: string | null): string | number | boolean | null {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean'
      ? parsed
      : null
  }
  catch {
    return null
  }
}

function isMissingSearchSchema(error: unknown) {
  if (!(error instanceof Error)) return false
  return /no such (?:table|column):\s*(?:app_|structured_filters_enabled|filter_preview_enabled|saved_filters_enabled|max_filter_terms|max_saved_filter_name_length)/iu
    .test(error.message)
}
