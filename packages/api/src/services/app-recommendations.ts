import type {
  AppPersonProfile,
  AppRecommendationFeedMode,
  AppRecommendationItem,
  AppRecommendationPage,
  AppRecommendationPreference,
} from '@meigallery/shared'
import {
  PUBLIC_PROFILE_ELIGIBILITY_SQL,
  PUBLIC_TAXONOMY_SELECT,
  getPublicPersonProfilesByIds,
  mapPublicProfile,
  publicProfileEligibilityParams,
  type PublicProjectionRow,
} from './app-discovery'
import {
  APP_RECOMMENDATION_MAX_PREFERENCE_TERMS,
  AppRecommendationError,
  listCompatibleRecommendationRules,
  normalizeRecommendationRegionCode,
  requireAppRecommendationPolicy,
  resolveAppRecommendationCapabilities,
  type AppRecommendationCapabilities,
  type AppRecommendationMode,
  type AppRecommendationPolicy,
  type AppRecommendationRuntimeConfig,
} from './app-recommendation-policy'
import {
  normalizeAppNumericVersion,
  supportsAppMinimumVersion,
} from './app-client-version'
import {
  parseRecommendationRuleRegions,
  recommendationRuleMatchesRegion,
} from './app-recommendation-region'
import { requireAppOperationalControlAvailable } from './app-operational-safety'
import { recommendationAccountHash } from './app-recommendation-evidence'
import {
  AppTaxonomyError,
  assertAssignableTaxonomyTerms,
  normalizeRequiredCatalogId,
} from './app-taxonomy'

const CURSOR_VERSION = 1
const CURSOR_MAX_LENGTH = 2400
const CURSOR_TTL_MS = 30 * 60 * 1000
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/u
const RECOMMENDATION_REASON_LABELS: Record<string, string> = {
  PLATFORM_SELECTED: '平台精选',
  REGION_RELEVANT: '与你选择的地区相关',
  RECENTLY_POPULAR: '近期热门',
  RECENTLY_PUBLISHED: '最近发布',
  PREFERENCE_RELEVANT: '与你主动选择的偏好相关',
  DISCOVERY_NEUTRAL: '为你发现',
}

type RecommendationWeights = {
  quality: number
  heat: number
  freshness: number
  region: number
  preferredTaxonomy: number
}

type RecommendationReasonMap = {
  editorial: string
  region: string
  popular: string
  fresh: string
  preferred: string
  default: string
}

export type RecommendationRuleRow = {
  rule_version_id: string
  rule_set_id: string
  version_number: number
  state: string
  entry_point: string
  mode: string
  name: string
  description: string | null
  taxonomy_catalog_id: string | null
  heat_version_id: string | null
  weights_json: string
  reason_map_json: string
  target_region_codes_json: string
  target_channels_json: string
  max_consecutive_same_region: number
  max_consecutive_same_term: number
  repeat_exposure_cap: number
  rollout_percent: number
  minimum_client_version: string
  effective_at: string | null
  expires_at: string | null
  rollback_rule_version_id: string | null
  guardrail_policy_id: string | null
  production_ready: number
  last_dry_run_json: string | null
  last_dry_run_at: string | null
  lock_version: number
  created_by: number
  updated_by: number
  reviewed_by: number | null
  activated_by: number | null
  created_at: string
  updated_at: string
  reviewed_at: string | null
  activated_at: string | null
  paused_at: string | null
}

type Candidate = {
  row: PublicProjectionRow
  profile: AppPersonProfile
  score: number
  reasonCode: string
  primaryTermId: string | null
}

type EditorialRow = {
  placement_id: string
  profile_id: string
  priority: number
  disclosure_code: string
  disclosure_label: string
}

type PreferenceRow = {
  personalization_enabled: number
  taxonomy_catalog_id: string | null
  preferred_term_ids_json: string
  version: number
  created_at: string
  updated_at: string
}

type RecommendationCursor = {
  v: 1
  sessionId: string
  expiresAt: string
  ruleVersionId: string
  mode: AppRecommendationMode
  regionCode: string | null
  preferenceHash: string
  score: number | null
  publishedAt: string | null
  profileId: string | null
  editorialSeen: boolean
}

export interface AppRecommendationRequestInput {
  mode?: unknown
  regionCode?: unknown
  limit?: unknown
  cursor?: unknown
}

export interface UpdateAppRecommendationPreferenceInput {
  expectedVersion?: unknown
  personalizationEnabled?: unknown
  catalogVersionId?: unknown
  preferredTermIds?: unknown
}

export async function resolveExecutableAppRecommendationCapabilities(
  db: D1Database,
  config: AppRecommendationRuntimeConfig,
  clientVersionValue: string | undefined,
  now = new Date(),
): Promise<AppRecommendationCapabilities> {
  const capabilities = await resolveAppRecommendationCapabilities(
    db,
    config,
    clientVersionValue,
    now,
  )
  if (!capabilities.feed || !capabilities.policy) return capabilities
  const clientVersion = normalizeAppNumericVersion(clientVersionValue)
  if (!clientVersion) return closeExecutableCapabilities(capabilities)
  const activeRule = await loadActiveRuleOrNull(
    db,
    'non_personalized',
    clientVersion,
    undefined,
    undefined,
    config.requireProductionReady,
    now,
  )
  if (!activeRule) return closeExecutableCapabilities(capabilities)
  const activePersonalizedRule = capabilities.personalization
    ? await loadActiveRuleOrNull(
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
    ...capabilities,
    personalization: capabilities.personalization && Boolean(activePersonalizedRule),
    activeRuleVersionId: activeRule.rule_version_id,
  }
}

export async function getAppRecommendationPreference(
  db: D1Database,
  accountId: number,
  config: AppRecommendationRuntimeConfig,
  clientVersionValue: string | undefined,
  now = new Date(),
): Promise<AppRecommendationPreference> {
  assertAccountId(accountId)
  const clientVersion = requireRecommendationClientVersion(clientVersionValue)
  const policy = await requireAppRecommendationPolicy(db, config, 'preferences', now, clientVersion)
  const row = await findPreference(db, accountId)
  const activePersonalizedRule = policy.personalizationEnabled
    ? await loadUsablePersonalizedRule(
        db,
        clientVersion,
        undefined,
        row?.taxonomy_catalog_id,
        config.requireProductionReady,
        now,
      )
    : null
  return mapPreference(row, policy, activePersonalizedRule)
}

export async function updateAppRecommendationPreference(
  db: D1Database,
  accountId: number,
  inputValue: unknown,
  config: AppRecommendationRuntimeConfig,
  clientVersionValue: string | undefined,
  now = new Date(),
): Promise<AppRecommendationPreference> {
  assertAccountId(accountId)
  const clientVersion = requireRecommendationClientVersion(clientVersionValue)
  const policy = await requireAppRecommendationPolicy(db, config, 'preferences', now, clientVersion)
  const input = requirePreferenceInput(inputValue)
  const current = await findPreference(db, accountId)
  const expectedVersion = normalizePreferenceExpectedVersion(input.expectedVersion)
  if ((current?.version ?? 0) !== expectedVersion) {
    throw new AppRecommendationError(
      409,
      'RECOMMENDATION_PREFERENCE_VERSION_CONFLICT',
      '推荐偏好版本已变化，请刷新后重试',
    )
  }
  if (typeof input.personalizationEnabled !== 'boolean') {
    throw new AppRecommendationError(
      400,
      'RECOMMENDATION_PREFERENCE_INVALID',
      'personalizationEnabled 必须为布尔值',
    )
  }
  const enabled = input.personalizationEnabled
  if (enabled && (
    !policy.personalizationEnabled
    || policy.personalizationDecisionStatus !== 'approved'
  )) {
    throw new AppRecommendationError(
      403,
      'RECOMMENDATION_PERSONALIZATION_NOT_READY',
      '个性化推荐尚未完成政策批准，当前只能使用非个性化推荐',
    )
  }
  const selection = enabled
    ? await normalizePreferenceTerms(db, input.catalogVersionId, input.preferredTermIds, config, now)
    : { catalogVersionId: null, termIds: [] as string[] }
  const nowIso = now.toISOString()
  if (!current) {
    const result = await db.prepare(`
      INSERT INTO app_recommendation_preferences (
        account_id, personalization_enabled, taxonomy_catalog_id,
        preferred_term_ids_json, version, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, 1, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM app_recommendation_preferences WHERE account_id = ?
      )
    `).bind(
      accountId,
      enabled ? 1 : 0,
      selection.catalogVersionId,
      JSON.stringify(selection.termIds),
      nowIso,
      nowIso,
      accountId,
    ).run()
    if ((result.meta.changes ?? 0) !== 1) throw preferenceVersionConflict()
  }
  else {
    const result = await db.prepare(`
      UPDATE app_recommendation_preferences
      SET personalization_enabled = ?, taxonomy_catalog_id = ?,
          preferred_term_ids_json = ?, version = version + 1, updated_at = ?
      WHERE account_id = ? AND version = ?
    `).bind(
      enabled ? 1 : 0,
      selection.catalogVersionId,
      JSON.stringify(selection.termIds),
      nowIso,
      accountId,
      expectedVersion,
    ).run()
    if ((result.meta.changes ?? 0) !== 1) throw preferenceVersionConflict()
  }
  const updated = await findPreference(db, accountId)
  if (!updated) {
    throw new AppRecommendationError(503, 'RECOMMENDATION_PREFERENCE_WRITE_FAILED', '推荐偏好写入结果异常', true)
  }
  const activePersonalizedRule = policy.personalizationEnabled
    ? await loadUsablePersonalizedRule(
        db,
        clientVersion,
        undefined,
        updated.taxonomy_catalog_id,
        config.requireProductionReady,
        now,
      )
    : null
  return mapPreference(updated, policy, activePersonalizedRule)
}

export async function getAppRecommendationPage(
  db: D1Database,
  inputValue: unknown,
  config: AppRecommendationRuntimeConfig,
  apiUrl: string,
  viewer: null | { accountInternalId: number; accountPublicId: string },
  clientVersionValue: string | undefined,
  now = new Date(),
): Promise<AppRecommendationPage> {
  await requireAppOperationalControlAvailable(
    db,
    'recommendation_delivery',
    (code, message, detail) => new AppRecommendationError(503, code, message, true, detail),
  )
  const clientVersion = requireRecommendationClientVersion(clientVersionValue)
  const policy = await requireAppRecommendationPolicy(db, config, 'feed', now, clientVersion)
  const input = normalizeRecommendationRequest(inputValue, policy)
  const preference = viewer
    ? await findPreference(db, viewer.accountInternalId)
    : null
  let modeResolution = await resolveRequestedMode(
    db,
    input.mode,
    preference,
    policy,
    config,
    clientVersion,
    input.regionCode,
    now,
  )
  const cursorSigningSecret = requireCursorSigningSecret(config.cursorSigningSecret)
  const decodedCursor = input.cursor
    ? await decodeSignedRecommendationCursor(input.cursor, cursorSigningSecret, now)
    : null
  const sessionId = decodedCursor?.sessionId ?? await createSessionId()
  const cursorExpiresAt = decodedCursor?.expiresAt
    ?? new Date(now.getTime() + CURSOR_TTL_MS).toISOString()
  let execution: Awaited<ReturnType<typeof resolveRecommendationExecution>>
  try {
    execution = await resolveRecommendationExecution(
      db,
      modeResolution.mode,
      modeResolution.activeRule,
      sessionId,
      clientVersion,
      input.regionCode,
      preference?.taxonomy_catalog_id ?? null,
      config.requireProductionReady,
      now,
    )
  }
  catch (error) {
    if (
      input.mode !== 'auto'
      || modeResolution.mode !== 'personalized'
      || !(error instanceof AppRecommendationError)
    ) throw error
    modeResolution = {
      mode: 'non_personalized' as const,
      fallbackReason: 'PERSONALIZATION_NOT_READY' as const,
      activeRule: null,
    }
    execution = await resolveRecommendationExecution(
      db,
      modeResolution.mode,
      modeResolution.activeRule,
      sessionId,
      clientVersion,
      input.regionCode,
      null,
      config.requireProductionReady,
      now,
    )
  }
  const { rule, model: ruleModel } = execution
  const preferredTermIds = modeResolution.mode === 'personalized'
    ? readPreferenceTermIds(preference)
    : []
  const preferenceHash = await sha256Hex(JSON.stringify({
    account: modeResolution.mode === 'personalized' ? viewer?.accountPublicId : null,
    catalog: modeResolution.mode === 'personalized' ? preference?.taxonomy_catalog_id : null,
    termIds: preferredTermIds,
  }))
  const cursor = decodedCursor
    ? assertRecommendationCursorContext(
        decodedCursor,
        rule.rule_version_id,
        modeResolution.mode,
        input.regionCode,
        preferenceHash,
      )
    : null
  const editorialRows = cursor?.editorialSeen
    ? []
    : await loadActiveEditorialPlacements(
        db,
        input.regionCode,
        Math.min(policy.maxEditorialItems, input.limit),
        now,
      )
  const editorialProfiles = await getPublicPersonProfilesByIds(
    db,
    editorialRows.map(item => item.profile_id),
    apiUrl,
    now,
    viewer?.accountInternalId ?? null,
  )
  const editorialItems = editorialRows.flatMap((placement): AppRecommendationItem[] => {
    const profile = editorialProfiles.get(placement.profile_id)
    if (!profile) return []
    return [{
      profile: withRecommendation(profile, placement.disclosure_code, rule.rule_version_id),
      reason: {
        code: placement.disclosure_code,
        label: placement.disclosure_label,
        source: 'editorial',
        disclosure: placement.disclosure_label,
        placementId: placement.placement_id,
      },
      score: null,
    }]
  })
  const excludedProfileIds = await loadAllActiveEditorialProfileIds(db, input.regionCode, now)
  const candidates = await loadAndRankCandidates(
    db,
    rule,
    ruleModel.weights,
    ruleModel.reasons,
    input.regionCode,
    preferredTermIds,
    excludedProfileIds,
    policy,
    apiUrl,
    viewer?.accountInternalId ?? null,
    now,
  )
  const afterCursor = applyCursor(candidates, cursor)
  const regularCapacity = Math.max(0, input.limit - editorialItems.length)
  const pageCandidates = afterCursor.slice(0, regularCapacity)
  const items: AppRecommendationItem[] = [
    ...editorialItems,
    ...pageCandidates.map(candidate => ({
      profile: withRecommendation(candidate.profile, candidate.reasonCode, rule.rule_version_id),
      reason: {
        code: candidate.reasonCode,
        label: reasonLabel(candidate.reasonCode),
        source: 'rule' as const,
        disclosure: null,
        placementId: null,
      },
      score: candidate.score,
    })),
  ]
  const hasMore = afterCursor.length > pageCandidates.length
  const last = pageCandidates.at(-1)
  const nextCursor = hasMore
    ? await encodeSignedRecommendationCursor({
        v: CURSOR_VERSION,
        sessionId,
        expiresAt: cursorExpiresAt,
        ruleVersionId: rule.rule_version_id,
        mode: modeResolution.mode,
        regionCode: input.regionCode,
        preferenceHash,
        score: last?.score ?? null,
        publishedAt: last?.row.published_at ?? null,
        profileId: last?.row.profile_id ?? null,
        editorialSeen: true,
      }, cursorSigningSecret)
    : null
  const evidenceRecorded = await maybeRecordRecommendationEvidence(
    db,
    policy,
    sessionId,
    viewer?.accountPublicId ?? null,
    modeResolution.mode,
    rule,
    {
      regionCode: input.regionCode,
      preferenceHash,
      clientVersion,
    },
    items,
    cursorSigningSecret,
    now,
  )
  await requireAppOperationalControlAvailable(
    db,
    'recommendation_delivery',
    (code, message, detail) => new AppRecommendationError(503, code, message, true, detail),
  )
  return {
    sessionId,
    mode: modeResolution.mode,
    personalizedApplied: modeResolution.mode === 'personalized',
    fallbackReason: modeResolution.fallbackReason,
    ruleVersionId: rule.rule_version_id,
    heatVersionId: rule.heat_version_id,
    evidenceRecorded,
    items,
    nextCursor,
    hasMore,
  }
}

export async function dryRunAppRecommendationRule(
  db: D1Database,
  rule: RecommendationRuleRow,
  policy: AppRecommendationPolicy,
  apiUrl: string,
  regionCodeValue: unknown,
  now = new Date(),
) {
  if (rule.mode !== 'non_personalized' && rule.mode !== 'personalized') {
    throw invalidRule('推荐模式无效')
  }
  const regionCode = normalizeRecommendationRegionCode(regionCodeValue)
  const model = validateExecutableRule(rule, rule.mode, regionCode)
  const syntheticPreferences = rule.mode === 'personalized'
    ? await loadSyntheticPreferenceTerms(db, rule.taxonomy_catalog_id)
    : []
  const candidates = await loadAndRankCandidates(
    db,
    rule,
    model.weights,
    model.reasons,
    regionCode,
    syntheticPreferences,
    [],
    policy,
    apiUrl,
    null,
    now,
  )
  const top = candidates.slice(0, Math.min(20, policy.maxPageSize))
  const reasonCounts = new Map<string, number>()
  for (const item of candidates) {
    reasonCounts.set(item.reasonCode, (reasonCounts.get(item.reasonCode) ?? 0) + 1)
  }
  const repeatedProfiles = candidates.length - new Set(candidates.map(item => item.row.profile_id)).size
  const representedRegions = new Set(candidates.flatMap(item => item.row.region_code ? [item.row.region_code] : [])).size
  return {
    scenario: {
      type: 'synthetic' as const,
      regionCode,
      personalizedSignals: rule.mode === 'personalized' ? syntheticPreferences.length : 0,
    },
    ruleVersionId: rule.rule_version_id,
    mode: rule.mode,
    candidateCount: candidates.length,
    emptyResultRisk: candidates.length === 0,
    reasonCoverage: candidates.length
      ? Number(((candidates.length - (reasonCounts.get(model.reasons.default) ?? 0)) / candidates.length).toFixed(4))
      : 0,
    repeatedProfileCount: repeatedProfiles,
    representedRegionCount: representedRegions,
    reasons: [...reasonCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
    topItems: top.map(item => ({
      profileId: item.row.profile_id,
      displayName: item.profile.displayName,
      regionLabel: item.profile.region?.label ?? null,
      score: item.score,
      reasonCode: item.reasonCode,
    })),
    safetyEligibilityFixed: true,
    producesExposure: false,
    generatedAt: now.toISOString(),
  }
}

export function normalizeRecommendationRequest(
  value: unknown,
  policy: AppRecommendationPolicy,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_REQUEST_INVALID', '推荐请求必须为 JSON 对象')
  }
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => !['mode', 'regionCode', 'limit', 'cursor'].includes(key))) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_REQUEST_INVALID', '推荐请求包含未支持字段')
  }
  const mode = object.mode ?? 'auto'
  if (!['auto', 'non_personalized', 'personalized'].includes(String(mode))) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_MODE_INVALID', '推荐模式无效')
  }
  const limit = normalizeLimit(object.limit, policy)
  const cursor = normalizeOptionalCursor(object.cursor)
  return {
    mode: mode as AppRecommendationFeedMode,
    regionCode: normalizeRecommendationRegionCode(object.regionCode),
    limit,
    cursor,
  }
}

export function parseRecommendationWeights(raw: string): RecommendationWeights {
  let value: unknown
  try {
    value = JSON.parse(raw)
  }
  catch {
    throw invalidRule('推荐权重不是有效 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRule('推荐权重必须为对象')
  }
  const object = value as Record<string, unknown>
  const keys = ['quality', 'heat', 'freshness', 'region', 'preferredTaxonomy'] as const
  if (Object.keys(object).some(key => !keys.includes(key as typeof keys[number]))) {
    throw invalidRule('推荐权重包含未登记信号')
  }
  const result = Object.fromEntries(keys.map(key => {
    const number = Number(object[key] ?? 0)
    if (!Number.isSafeInteger(number) || number < 0 || number > 100) {
      throw invalidRule(`推荐权重 ${key} 必须为 0 至 100 的整数`)
    }
    return [key, number]
  })) as unknown as RecommendationWeights
  const total = Object.values(result).reduce((sum, value) => sum + value, 0)
  if (total !== 100) throw invalidRule('推荐权重总和必须为 100')
  return result
}

export function parseRecommendationReasonMap(raw: string): RecommendationReasonMap {
  let value: unknown
  try {
    value = JSON.parse(raw)
  }
  catch {
    throw invalidRule('推荐理由映射不是有效 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRule('推荐理由映射必须为对象')
  }
  const object = value as Record<string, unknown>
  const defaults: RecommendationReasonMap = {
    editorial: 'PLATFORM_SELECTED',
    region: 'REGION_RELEVANT',
    popular: 'RECENTLY_POPULAR',
    fresh: 'RECENTLY_PUBLISHED',
    preferred: 'PREFERENCE_RELEVANT',
    default: 'DISCOVERY_NEUTRAL',
  }
  const keys = Object.keys(defaults) as Array<keyof RecommendationReasonMap>
  if (Object.keys(object).some(key => !keys.includes(key as keyof RecommendationReasonMap))) {
    throw invalidRule('推荐理由映射包含未登记字段')
  }
  for (const key of keys) {
    const candidate = object[key] ?? defaults[key]
    if (
      typeof candidate !== 'string'
      || !REASON_CODE_PATTERN.test(candidate)
      || !Object.prototype.hasOwnProperty.call(RECOMMENDATION_REASON_LABELS, candidate)
    ) {
      throw invalidRule(`推荐理由 ${key} 格式无效`)
    }
    defaults[key] = candidate
  }
  return defaults
}

async function resolveRequestedMode(
  db: D1Database,
  requestMode: AppRecommendationFeedMode,
  preference: PreferenceRow | null,
  policy: AppRecommendationPolicy,
  config: AppRecommendationRuntimeConfig,
  clientVersion: string,
  regionCode: string | null,
  now: Date,
) {
  const preferredTermIds = readPreferenceTermIds(preference)
  const activeRule = policy.personalizationEnabled
    && policy.personalizationDecisionStatus === 'approved'
    && preference?.personalization_enabled === 1
    && preferredTermIds.length > 0
    ? await loadUsablePersonalizedRule(
        db,
        clientVersion,
        regionCode,
        preference?.taxonomy_catalog_id ?? null,
        config.requireProductionReady,
        now,
      )
    : null
  const personalizationReady = policy.personalizationEnabled
    && policy.personalizationDecisionStatus === 'approved'
    && preference?.personalization_enabled === 1
    && preferredTermIds.length > 0
    && Boolean(activeRule)
    && activeRule?.taxonomy_catalog_id === preference.taxonomy_catalog_id
  if (requestMode === 'personalized' && !personalizationReady) {
    throw new AppRecommendationError(
      403,
      'RECOMMENDATION_PERSONALIZATION_UNAVAILABLE',
      '个性化推荐当前不可用，请使用非个性化推荐',
    )
  }
  if (requestMode === 'personalized' || (requestMode === 'auto' && personalizationReady)) {
    return {
      mode: 'personalized' as const,
      fallbackReason: null,
      activeRule: activeRule!,
    }
  }
  return {
    mode: 'non_personalized' as const,
    fallbackReason: requestMode === 'auto' && preference?.personalization_enabled === 1
      ? 'PERSONALIZATION_NOT_READY' as const
      : null,
    activeRule: null,
  }
}

async function loadUsablePersonalizedRule(
  db: D1Database,
  clientVersion: string,
  regionCode: string | null | undefined,
  taxonomyCatalogId: string | null | undefined,
  requireProductionReady: boolean,
  now: Date,
) {
  return loadActiveRuleOrNull(
    db,
    'personalized',
    clientVersion,
    regionCode,
    taxonomyCatalogId,
    requireProductionReady,
    now,
  )
}

async function loadActiveRule(
  db: D1Database,
  mode: AppRecommendationMode,
  clientVersion: string,
  regionCode: string | null,
  requireProductionReady: boolean,
  now: Date,
) {
  const row = await loadActiveRuleOrNull(
    db,
    mode,
    clientVersion,
    regionCode,
    undefined,
    requireProductionReady,
    now,
  )
  if (!row) {
    throw new AppRecommendationError(
      503,
      'RECOMMENDATION_RULE_NOT_READY',
      '推荐规则尚未就绪',
      true,
    )
  }
  return row
}

async function loadActiveRuleOrNull(
  db: D1Database,
  mode: AppRecommendationMode,
  clientVersion: string,
  regionCode: string | null | undefined,
  taxonomyCatalogId: string | null | undefined,
  requireProductionReady: boolean,
  now: Date,
) {
  const selections = await listCompatibleRecommendationRules(
    db,
    mode,
    clientVersion,
    regionCode,
    taxonomyCatalogId,
    requireProductionReady,
    now,
  )
  for (const selection of selections) {
    const rule = await db.prepare(`
      SELECT ${RULE_FIELDS}
      FROM app_recommendation_rule_versions
      WHERE rule_version_id = ?
      LIMIT 1
    `).bind(selection.rule_version_id).first<RecommendationRuleRow>()
    if (!rule) continue
    try {
      validateExecutableRule(rule, mode, regionCode)
      await assertRecommendationRuleRuntimeDependencies(db, rule, requireProductionReady, now)
      return rule
    }
    catch (error) {
      if (!(error instanceof AppRecommendationError)) throw error
    }
  }
  return null
}

async function selectRolloutRule(
  db: D1Database,
  activeRule: RecommendationRuleRow,
  sessionId: string,
  clientVersion: string,
  regionCode: string | null,
  requireProductionReady: boolean,
  now: Date,
) {
  if (!supportsAppMinimumVersion(clientVersion, activeRule.minimum_client_version)) {
    throw new AppRecommendationError(
      403,
      'RECOMMENDATION_CLIENT_VERSION_UNSUPPORTED',
      '当前客户端版本尚不支持此推荐规则，请先更新 App',
    )
  }
  if (!recommendationRuleMatchesRegion(activeRule.target_region_codes_json, regionCode)) {
    throw new AppRecommendationError(
      503,
      'RECOMMENDATION_REGION_NOT_READY',
      '当前地区暂无可用推荐规则',
      true,
    )
  }
  if (activeRule.rollout_percent >= 100) return activeRule
  if (activeRule.rollout_percent <= 0 || !activeRule.rollback_rule_version_id) {
    throw invalidRule('灰度规则缺少可执行的回退版本')
  }
  const digest = await sha256Hex(`${activeRule.rule_version_id}\u0000${sessionId}`)
  const bucket = Math.floor((Number.parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000) * 100)
  if (bucket < activeRule.rollout_percent) return activeRule

  const fallback = await db.prepare(`
    SELECT ${RULE_FIELDS}
    FROM app_recommendation_rule_versions
    WHERE rule_version_id = ?
      AND entry_point = ?
      AND mode = ?
      AND rollout_percent = 100
      AND state IN ('active', 'paused', 'retired', 'rolled_back')
      AND activated_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app_recommendation_guardrail_blocks block
        WHERE block.rule_version_id = app_recommendation_rule_versions.rule_version_id
      )
      AND (effective_at IS NULL OR datetime(effective_at) <= datetime(?))
      AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
      AND (? = 0 OR production_ready = 1)
    LIMIT 1
  `).bind(
    activeRule.rollback_rule_version_id,
    activeRule.entry_point,
    activeRule.mode,
    now.toISOString(),
    now.toISOString(),
    requireProductionReady ? 1 : 0,
  ).first<RecommendationRuleRow>()
  if (!fallback) throw invalidRule('灰度回退版本不存在、已过期或未通过当前环境门禁')
  if (!supportsAppMinimumVersion(clientVersion, fallback.minimum_client_version)) {
    throw invalidRule('灰度回退版本不支持当前客户端版本')
  }
  if (!recommendationRuleMatchesRegion(fallback.target_region_codes_json, regionCode)) {
    throw invalidRule('灰度回退版本不覆盖当前地区')
  }
  if (
    activeRule.mode === 'personalized'
    && fallback.taxonomy_catalog_id !== activeRule.taxonomy_catalog_id
  ) {
    throw invalidRule('个性化灰度回退版本必须使用相同 taxonomy 目录')
  }
  return fallback
}

async function resolveRecommendationExecution(
  db: D1Database,
  mode: AppRecommendationMode,
  preferredActiveRule: RecommendationRuleRow | null,
  sessionId: string,
  clientVersion: string,
  regionCode: string | null,
  preferenceCatalogId: string | null,
  requireProductionReady: boolean,
  now: Date,
) {
  const activeRule = preferredActiveRule
    ?? await loadActiveRule(
      db,
      mode,
      clientVersion,
      regionCode,
      requireProductionReady,
      now,
    )
  const rule = await selectRolloutRule(
    db,
    activeRule,
    sessionId,
    clientVersion,
    regionCode,
    requireProductionReady,
    now,
  )
  await assertRecommendationRuleRuntimeDependencies(
    db,
    rule,
    requireProductionReady,
    now,
  )
  if (mode === 'personalized' && preferenceCatalogId !== rule.taxonomy_catalog_id) {
    throw invalidRule('个性化偏好目录与实际执行规则目录不一致')
  }
  return {
    rule,
    model: validateExecutableRule(rule, mode, regionCode),
  }
}

function validateExecutableRule(
  rule: RecommendationRuleRow,
  mode: AppRecommendationMode,
  regionCode: string | null | undefined,
) {
  if (!normalizeAppNumericVersion(rule.minimum_client_version)) {
    throw invalidRule('推荐规则最低客户端版本格式无效')
  }
  const weights = parseRecommendationWeights(rule.weights_json)
  const reasons = parseRecommendationReasonMap(rule.reason_map_json)
  const targetChannels = parseStringArray(rule.target_channels_json, '推荐渠道')
  const targetRegions = parseRecommendationRuleRegions(rule.target_region_codes_json)
  if (targetChannels.length !== 1 || targetChannels[0] !== 'app') {
    throw invalidRule('当前规则渠道必须且只能为 App')
  }
  if (!targetRegions) throw invalidRule('推荐规则包含无效地区代码')
  if (!recommendationRuleMatchesRegion(rule.target_region_codes_json, regionCode)) {
    throw new AppRecommendationError(503, 'RECOMMENDATION_REGION_NOT_READY', '当前地区暂无可用推荐规则', true)
  }
  if (mode === 'non_personalized' && weights.preferredTaxonomy !== 0) {
    throw invalidRule('非个性化规则不得读取账号偏好信号')
  }
  if (mode === 'personalized' && weights.preferredTaxonomy <= 0) {
    throw invalidRule('个性化规则必须显式配置主动偏好权重')
  }
  if (mode === 'personalized' && !rule.taxonomy_catalog_id) {
    throw invalidRule('个性化规则必须绑定稳定 taxonomy 目录')
  }
  if (weights.heat > 0 && !rule.heat_version_id) {
    throw invalidRule('使用热度信号时必须绑定 heatVersion')
  }
  return { weights, reasons }
}

export async function assertRecommendationRuleRuntimeDependencies(
  db: D1Database,
  rule: RecommendationRuleRow,
  requireProductionReady: boolean,
  now = new Date(),
  errorStatus: 422 | 503 = 503,
) {
  if (!normalizeAppNumericVersion(rule.minimum_client_version)) {
    throw new AppRecommendationError(
      errorStatus,
      'RECOMMENDATION_CLIENT_VERSION_INVALID',
      '推荐规则最低客户端版本格式无效',
      true,
    )
  }
  const weights = parseRecommendationWeights(rule.weights_json)
  if (rule.mode === 'personalized') {
    if (!rule.taxonomy_catalog_id) {
      throw new AppRecommendationError(errorStatus, 'RECOMMENDATION_TAXONOMY_NOT_READY', '个性化规则缺少稳定 taxonomy 目录', true)
    }
    const catalog = await db.prepare(`
      SELECT state, production_ready, effective_at
      FROM app_taxonomy_catalogs
      WHERE catalog_id = ?
      LIMIT 1
    `).bind(rule.taxonomy_catalog_id).first<{
      state: string
      production_ready: number
      effective_at: string
    }>()
    const effective = typeof catalog?.effective_at === 'string'
      && Number.isFinite(Date.parse(catalog.effective_at))
      && Date.parse(catalog.effective_at) <= now.getTime()
    const eligible = catalog
      && (catalog.state === 'development' || catalog.state === 'published')
      && effective
      && (!requireProductionReady || (
        catalog.state === 'published'
        && catalog.production_ready === 1
      ))
    if (!eligible) {
      throw new AppRecommendationError(errorStatus, 'RECOMMENDATION_TAXONOMY_NOT_READY', '个性化规则引用的 taxonomy 目录尚未就绪', true)
    }
  }
  if (weights.heat > 0) {
    if (!rule.heat_version_id) {
      throw new AppRecommendationError(errorStatus, 'RECOMMENDATION_HEAT_NOT_READY', '热度权重大于 0 时必须绑定已批准热度版本', true)
    }
    const heat = await db.prepare(`
      SELECT state, production_ready
      FROM app_recommendation_heat_versions
      WHERE heat_version_id = ?
      LIMIT 1
    `).bind(rule.heat_version_id).first<{ state: string; production_ready: number }>()
    const eligible = heat
      && (heat.state === 'approved' || heat.state === 'active')
      && (!requireProductionReady || heat.production_ready === 1)
    if (!eligible) {
      throw new AppRecommendationError(errorStatus, 'RECOMMENDATION_HEAT_NOT_READY', '规则引用的热度版本尚未批准或未通过当前环境门禁', true)
    }
  }
}

async function loadAndRankCandidates(
  db: D1Database,
  rule: RecommendationRuleRow,
  weights: RecommendationWeights,
  reasons: RecommendationReasonMap,
  regionCode: string | null,
  preferredTermIds: string[],
  excludedProfileIds: string[],
  policy: AppRecommendationPolicy,
  apiUrl: string,
  viewerAccountId: number | null,
  now: Date,
) {
  const conditions = [`(${PUBLIC_PROFILE_ELIGIBILITY_SQL})`]
  const params: unknown[] = [...publicProfileEligibilityParams(now)]
  if (viewerAccountId !== null) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM app_profile_blocks block
      WHERE block.account_id = ? AND block.profile_id = p.profile_id AND block.state = 'blocked'
    )`)
    params.push(viewerAccountId)
  }
  if (regionCode) {
    conditions.push('p.region_code = ?')
    params.push(regionCode)
  }
  if (excludedProfileIds.length) {
    conditions.push(`p.profile_id NOT IN (${excludedProfileIds.map(() => '?').join(', ')})`)
    params.push(...excludedProfileIds)
  }
  const result = await db.prepare(`
    SELECT
      p.profile_id, p.person_id, p.display_name, p.summary, p.source_gallery_id,
      g.cover_key, p.tags_json, p.operation_mode, p.operation_label,
      p.region_code, p.region_label, p.region_precision,
      p.recommendation_score,
      COALESCE(h.score, 0) AS heat_score,
      p.recommendation_reason_code, p.recommendation_rule_version,
      p.published_at,
      ${PUBLIC_TAXONOMY_SELECT} AS taxonomy_json
    FROM profile_public_projections p
    JOIN galleries g ON g.id = p.source_gallery_id
    LEFT JOIN app_recommendation_heat_scores h
      ON h.profile_id = p.profile_id AND h.heat_version_id = ?
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY p.recommendation_score DESC, p.published_at DESC, p.profile_id ASC
    LIMIT ?
  `).bind(rule.heat_version_id ?? '', ...params, policy.maxCandidatePool)
    .all<PublicProjectionRow>()
  const preferred = new Set(preferredTermIds)
  const candidates = result.results.map((row): Candidate => {
    const profile = mapPublicProfile(row, apiUrl)
    const matchedTerms = profile.taxonomyTerms.filter(term => preferred.has(term.termId))
    const freshness = freshnessScore(row.published_at, now)
    const region = regionCode && row.region_code === regionCode ? 1_000_000 : 0
    const preference = preferred.size
      ? Math.round((matchedTerms.length / preferred.size) * 1_000_000)
      : 0
    const score = Math.round((
      clampScore(row.recommendation_score) * weights.quality
      + clampScore(row.heat_score) * weights.heat
      + freshness * weights.freshness
      + region * weights.region
      + preference * weights.preferredTaxonomy
    ) / 100)
    const reasonCode = preference > 0
      ? reasons.preferred
      : region > 0 && weights.region > 0
        ? reasons.region
        : row.heat_score > 0 && weights.heat > 0
          ? reasons.popular
          : freshness > 500_000 && weights.freshness > 0
            ? reasons.fresh
            : reasons.default
    return {
      row,
      profile,
      score,
      reasonCode,
      primaryTermId: profile.taxonomyTerms[0]?.termId ?? null,
    }
  })
  candidates.sort(compareCandidate)
  return applyDiversity(
    candidates,
    regionCode ? Number.MAX_SAFE_INTEGER : rule.max_consecutive_same_region,
    rule.max_consecutive_same_term,
  )
}

function applyDiversity(candidates: Candidate[], maxRegion: number, maxTerm: number) {
  const output: Candidate[] = []
  const remaining = [...candidates]
  while (remaining.length) {
    const regionRun = trailingRun(output, item => item.row.region_code)
    const termRun = trailingRun(output, item => item.primaryTermId)
    const nextIndex = remaining.findIndex(candidate => !(
      (
        regionRun.value
        && candidate.row.region_code === regionRun.value
        && regionRun.count >= maxRegion
      )
      || (
        termRun.value
        && candidate.primaryTermId === termRun.value
        && termRun.count >= maxTerm
      )
    ))
    if (nextIndex < 0) break
    output.push(remaining.splice(nextIndex, 1)[0]!)
  }
  return output
}

function applyCursor(candidates: Candidate[], cursor: RecommendationCursor | null) {
  if (!cursor || cursor.score === null || !cursor.publishedAt || !cursor.profileId) return candidates
  return candidates.filter(candidate => (
    candidate.score < cursor.score!
    || (
      candidate.score === cursor.score
      && (
        candidate.row.published_at < cursor.publishedAt!
        || (
          candidate.row.published_at === cursor.publishedAt
          && candidate.row.profile_id > cursor.profileId!
        )
      )
    )
  ))
}

async function loadActiveEditorialPlacements(
  db: D1Database,
  regionCode: string | null,
  limit: number,
  now: Date,
) {
  if (limit <= 0) return []
  return (await db.prepare(`
    SELECT placement_id, profile_id, priority, disclosure_code, disclosure_label
    FROM (
      SELECT placement_id, profile_id, priority, disclosure_code, disclosure_label,
             starts_at,
             ROW_NUMBER() OVER (
               PARTITION BY profile_id
               ORDER BY priority ASC, starts_at ASC, placement_id ASC
             ) AS profile_rank
      FROM app_recommendation_editorial_placements
      WHERE entry_point = 'discovery_home'
        AND channel = 'app'
        AND state IN ('scheduled', 'active')
        AND datetime(starts_at) <= datetime(?)
        AND datetime(ends_at) > datetime(?)
        AND (region_code IS NULL OR region_code = ?)
    ) ranked
    WHERE profile_rank = 1
    ORDER BY priority ASC, starts_at ASC, placement_id ASC
    LIMIT ?
  `).bind(now.toISOString(), now.toISOString(), regionCode, limit).all<EditorialRow>()).results
}

async function loadAllActiveEditorialProfileIds(
  db: D1Database,
  regionCode: string | null,
  now: Date,
) {
  const rows = await db.prepare(`
    SELECT DISTINCT profile_id
    FROM app_recommendation_editorial_placements
    WHERE entry_point = 'discovery_home'
      AND channel = 'app'
      AND state IN ('scheduled', 'active')
      AND datetime(starts_at) <= datetime(?)
      AND datetime(ends_at) > datetime(?)
      AND (region_code IS NULL OR region_code = ?)
    LIMIT 100
  `).bind(now.toISOString(), now.toISOString(), regionCode).all<{ profile_id: string }>()
  return rows.results.map(row => row.profile_id)
}

async function normalizePreferenceTerms(
  db: D1Database,
  catalogValue: unknown,
  termIdsValue: unknown,
  config: AppRecommendationRuntimeConfig,
  now: Date,
) {
  let catalogVersionId: string
  try {
    catalogVersionId = normalizeRequiredCatalogId(catalogValue)
  }
  catch (error) {
    if (error instanceof AppTaxonomyError) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_PREFERENCE_CATALOG_INVALID', error.message)
    }
    throw error
  }
  if (!Array.isArray(termIdsValue) || termIdsValue.length > APP_RECOMMENDATION_MAX_PREFERENCE_TERMS) {
    throw new AppRecommendationError(
      400,
      'RECOMMENDATION_PREFERENCE_TERMS_INVALID',
      `主动偏好必须包含 1 至 ${APP_RECOMMENDATION_MAX_PREFERENCE_TERMS} 个稳定词条`,
    )
  }
  try {
    const terms = await assertAssignableTaxonomyTerms(db, catalogVersionId, termIdsValue, {
      requireProductionReady: config.requireProductionReady,
      now,
    })
    if (!terms.length) {
      throw new AppRecommendationError(400, 'RECOMMENDATION_PREFERENCE_TERMS_INVALID', '请至少选择一个主动偏好')
    }
    return { catalogVersionId, termIds: terms.map(term => term.termId).sort() }
  }
  catch (error) {
    if (error instanceof AppRecommendationError) throw error
    if (error instanceof AppTaxonomyError) {
      throw new AppRecommendationError(422, 'RECOMMENDATION_PREFERENCE_TERMS_INVALID', error.message)
    }
    throw error
  }
}

async function findPreference(db: D1Database, accountId: number) {
  return db.prepare(`
    SELECT personalization_enabled, taxonomy_catalog_id, preferred_term_ids_json,
           version, created_at, updated_at
    FROM app_recommendation_preferences
    WHERE account_id = ?
    LIMIT 1
  `).bind(accountId).first<PreferenceRow>()
}

function mapPreference(
  row: PreferenceRow | null,
  policy: AppRecommendationPolicy,
  activePersonalizedRule: RecommendationRuleRow | null,
): AppRecommendationPreference {
  const requested = row?.personalization_enabled === 1
  const terms = readPreferenceTermIds(row)
  const effective = requested
    && terms.length > 0
    && policy.personalizationEnabled
    && policy.personalizationDecisionStatus === 'approved'
    && activePersonalizedRule?.taxonomy_catalog_id === row?.taxonomy_catalog_id
  return {
    requestedPersonalizationEnabled: requested,
    effectivePersonalizationEnabled: effective,
    catalogVersionId: row?.taxonomy_catalog_id ?? null,
    preferredTermIds: terms,
    version: row?.version ?? 0,
    policyVersion: policy.policyId,
    policyDecisionStatus: policy.personalizationDecisionStatus,
    updatedAt: row?.updated_at ?? null,
  }
}

function closeExecutableCapabilities(
  capabilities: AppRecommendationCapabilities,
): AppRecommendationCapabilities {
  return {
    ...capabilities,
    feed: false,
    preferences: false,
    personalization: false,
    editorial: false,
    activeRuleVersionId: null,
  }
}

function readPreferenceTermIds(row: PreferenceRow | null) {
  if (!row) return []
  try {
    const value: unknown = JSON.parse(row.preferred_term_ids_json)
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((item): item is string => (
      typeof item === 'string' && /^txt_[A-Za-z0-9_-]{4,92}$/u.test(item)
    )))].slice(0, APP_RECOMMENDATION_MAX_PREFERENCE_TERMS).sort()
  }
  catch {
    return []
  }
}

async function loadSyntheticPreferenceTerms(db: D1Database, catalogId: string | null) {
  if (!catalogId) return []
  const rows = await db.prepare(`
    SELECT term_id
    FROM app_taxonomy_catalog_items
    WHERE catalog_id = ?
      AND public_state = 'active'
      AND visibility = 'public'
      AND sensitivity = 'standard'
      AND allowed_for_profile = 1
      AND type NOT IN ('region_scope', 'region_group', 'city_country')
    ORDER BY sort_order ASC, term_id ASC
    LIMIT 3
  `).bind(catalogId).all<{ term_id: string }>()
  return rows.results.map(row => row.term_id)
}

function requirePreferenceInput(value: unknown): UpdateAppRecommendationPreferenceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_PREFERENCE_INVALID', '推荐偏好请求必须为 JSON 对象')
  }
  if (Object.keys(value).some(key => ![
    'expectedVersion',
    'personalizationEnabled',
    'catalogVersionId',
    'preferredTermIds',
  ].includes(key))) {
    throw new AppRecommendationError(400, 'RECOMMENDATION_PREFERENCE_INVALID', '推荐偏好请求包含未支持字段')
  }
  return value as UpdateAppRecommendationPreferenceInput
}

function normalizePreferenceExpectedVersion(value: unknown) {
  const parsed = typeof value === 'string' && /^\d{1,10}$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) {
    throw new AppRecommendationError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为非负整数')
  }
  return Number(parsed)
}

function normalizeLimit(value: unknown, policy: AppRecommendationPolicy) {
  if (value === undefined || value === null || value === '') return policy.defaultPageSize
  const parsed = typeof value === 'string' && /^[1-9]\d{0,2}$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1 || Number(parsed) > policy.maxPageSize) {
    throw new AppRecommendationError(
      400,
      'RECOMMENDATION_LIMIT_INVALID',
      `limit 必须为 1 至 ${policy.maxPageSize} 的整数`,
    )
  }
  return Number(parsed)
}

function normalizeOptionalCursor(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > CURSOR_MAX_LENGTH) {
    throw invalidCursor()
  }
  return value
}

async function encodeSignedRecommendationCursor(
  cursor: RecommendationCursor,
  secret: string,
) {
  const payload = base64UrlEncode(JSON.stringify(cursor))
  const signature = await hmacHex(secret, `recommendation-cursor-v1\u0000${payload}`)
  return `${payload}.${signature}`
}

async function decodeSignedRecommendationCursor(raw: string, secret: string, now: Date) {
  try {
    if (raw.length > CURSOR_MAX_LENGTH) throw invalidCursor()
    const parts = raw.split('.')
    if (parts.length !== 2 || !parts[0] || !/^[0-9a-f]{64}$/u.test(parts[1]!)) {
      throw invalidCursor()
    }
    const expected = await hmacHex(secret, `recommendation-cursor-v1\u0000${parts[0]}`)
    if (!constantTimeEqual(expected, parts[1]!)) throw invalidCursor()
    const value: unknown = JSON.parse(base64UrlDecode(parts[0]))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor()
    const cursor = value as Partial<RecommendationCursor>
    if (
      cursor.v !== CURSOR_VERSION
      || typeof cursor.sessionId !== 'string'
      || !/^rcs_[0-9a-f]{64}$/u.test(cursor.sessionId)
      || typeof cursor.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(cursor.expiresAt))
      || Date.parse(cursor.expiresAt) <= now.getTime()
      || typeof cursor.ruleVersionId !== 'string'
      || !/^rrv_[A-Za-z0-9_-]{1,92}$/u.test(cursor.ruleVersionId)
      || (cursor.mode !== 'non_personalized' && cursor.mode !== 'personalized')
      || (cursor.regionCode !== null && (
        typeof cursor.regionCode !== 'string' || !/^[a-z0-9-]{2,32}$/u.test(cursor.regionCode)
      ))
      || typeof cursor.preferenceHash !== 'string'
      || !/^[0-9a-f]{64}$/u.test(cursor.preferenceHash)
      || typeof cursor.editorialSeen !== 'boolean'
      || (cursor.score !== null && (!Number.isSafeInteger(cursor.score) || Number(cursor.score) < 0))
      || (cursor.publishedAt !== null && (
        typeof cursor.publishedAt !== 'string' || !Number.isFinite(Date.parse(cursor.publishedAt))
      ))
      || (cursor.profileId !== null && (
        typeof cursor.profileId !== 'string' || !/^pp_[A-Za-z0-9_-]{1,77}$/u.test(cursor.profileId)
      ))
    ) throw invalidCursor()
    return cursor as RecommendationCursor
  }
  catch (error) {
    if (error instanceof AppRecommendationError) throw error
    throw invalidCursor()
  }
}

function assertRecommendationCursorContext(
  cursor: RecommendationCursor,
  ruleVersionId: string,
  mode: AppRecommendationMode,
  regionCode: string | null,
  preferenceHash: string,
) {
  if (
    cursor.ruleVersionId !== ruleVersionId
    || cursor.mode !== mode
    || cursor.regionCode !== regionCode
    || cursor.preferenceHash !== preferenceHash
  ) throw invalidCursor()
  return cursor
}

async function maybeRecordRecommendationEvidence(
  db: D1Database,
  policy: AppRecommendationPolicy,
  sessionId: string,
  accountPublicId: string | null,
  mode: AppRecommendationMode,
  rule: RecommendationRuleRow,
  context: unknown,
  items: AppRecommendationItem[],
  signingSecret: string,
  now: Date,
) {
  if (
    !policy.evidenceRecordingEnabled
    || policy.evidenceRetentionDecisionStatus !== 'approved'
    || !policy.evidenceRetentionDays
    || !policy.purgeEnabled
  ) return false
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + policy.evidenceRetentionDays * 86_400_000).toISOString()
  const accountHash = accountPublicId
    ? await recommendationAccountHash(signingSecret, accountPublicId)
    : null
  const contextHash = await sha256Hex(JSON.stringify(context))
  const statements = [
    db.prepare(`
      INSERT OR IGNORE INTO app_recommendation_sessions (
        session_id, account_hash, mode, rule_version_id, heat_version_id,
        context_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId,
      accountHash,
      mode,
      rule.rule_version_id,
      rule.heat_version_id,
      contextHash,
      createdAt,
      expiresAt,
    ),
    ...items.map(item => db.prepare(`
      INSERT OR IGNORE INTO app_recommendation_session_items (
        session_id, rank, profile_id, reason_code, source, placement_id
      )
      SELECT ?, COALESCE((
        SELECT MAX(existing.rank)
        FROM app_recommendation_session_items existing
        WHERE existing.session_id = ?
      ), 0) + 1, ?, ?, ?, ?
    `).bind(
      sessionId,
      sessionId,
      item.profile.profileId,
      item.reason.code,
      item.reason.source,
      item.reason.placementId,
    )),
  ]
  await db.batch(statements)
  return true
}

function withRecommendation(profile: AppPersonProfile, reasonCode: string, ruleVersion: string) {
  return {
    ...profile,
    recommendation: { mode: 'rule_based' as const, reasonCode, ruleVersion },
  }
}

function freshnessScore(publishedAt: string, now: Date) {
  const timestamp = Date.parse(publishedAt)
  if (!Number.isFinite(timestamp)) return 0
  const days = Math.max(0, (now.getTime() - timestamp) / 86_400_000)
  return Math.max(0, Math.round(1_000_000 * (1 - days / 30)))
}

function clampScore(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1_000_000, Math.round(number)))
}

function compareCandidate(left: Candidate, right: Candidate) {
  if (left.score !== right.score) return right.score - left.score
  if (left.row.published_at !== right.row.published_at) {
    return right.row.published_at.localeCompare(left.row.published_at)
  }
  return left.row.profile_id.localeCompare(right.row.profile_id)
}

function trailingRun<T>(items: T[], selector: (item: T) => string | null) {
  const value = items.length ? selector(items[items.length - 1]!) : null
  if (!value) return { value: null, count: 0 }
  let count = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (selector(items[index]!) !== value) break
    count += 1
  }
  return { value, count }
}

function parseStringArray(raw: string, label: string) {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      throw new Error('invalid')
    }
    return [...new Set(value)]
  }
  catch {
    throw invalidRule(`${label}配置无效`)
  }
}

function reasonLabel(reasonCode: string) {
  return RECOMMENDATION_REASON_LABELS[reasonCode] ?? '为你发现'
}

function invalidRule(message: string) {
  return new AppRecommendationError(503, 'RECOMMENDATION_RULE_INVALID', message, true)
}

function invalidCursor() {
  return new AppRecommendationError(
    409,
    'RECOMMENDATION_CURSOR_EXPIRED',
    '推荐规则或偏好已变化，请重新开始推荐会话',
  )
}

function preferenceVersionConflict() {
  return new AppRecommendationError(
    409,
    'RECOMMENDATION_PREFERENCE_VERSION_CONFLICT',
    '推荐偏好版本已变化，请刷新后重试',
  )
}

function assertAccountId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppRecommendationError(403, 'APP_ACCOUNT_REQUIRED', '需要有效 App 账号')
  }
}

function requireRecommendationClientVersion(value: string | undefined) {
  const version = normalizeAppNumericVersion(value)
  if (!version) {
    throw new AppRecommendationError(
      400,
      'APP_CLIENT_VERSION_INVALID',
      'X-Client-Version 必须为两段或三段数字版本',
    )
  }
  return version
}

function requireCursorSigningSecret(value: string) {
  if (typeof value !== 'string' || value.length < 16) {
    throw new AppRecommendationError(
      503,
      'RECOMMENDATION_CURSOR_SIGNING_NOT_READY',
      '推荐游标签名能力尚未就绪',
      true,
    )
  }
  return value
}

async function createSessionId() {
  return `rcs_${await sha256Hex(`recommendation-session\u0000${crypto.randomUUID()}`)}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

function base64UrlEncode(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

export const RECOMMENDATION_RULE_FIELDS = `
  rule_version_id, rule_set_id, version_number, state, entry_point, mode,
  name, description, taxonomy_catalog_id, heat_version_id, weights_json,
  reason_map_json, target_region_codes_json, target_channels_json,
  max_consecutive_same_region, max_consecutive_same_term, repeat_exposure_cap,
  rollout_percent, minimum_client_version, effective_at, expires_at,
  rollback_rule_version_id, guardrail_policy_id, production_ready,
  last_dry_run_json, last_dry_run_at,
  lock_version, created_by, updated_by, reviewed_by, activated_by,
  created_at, updated_at, reviewed_at, activated_at, paused_at
`

const RULE_FIELDS = RECOMMENDATION_RULE_FIELDS
