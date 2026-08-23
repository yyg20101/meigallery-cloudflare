import type { AppTaxonomyTerm, AppTaxonomyType } from '@meigallery/shared'
import {
  AppMembershipError,
  resolveAppMembershipSnapshot,
  type AppMembershipRuntimeConfig,
} from './app-membership'
import {
  AppPersonSearchError,
  assertPositiveSearchAccountId,
  type AppPersonSearchPolicy,
} from './app-person-search-policy'
import {
  AppTaxonomyError,
  getPublicAppTaxonomyCatalog,
  normalizeRequiredCatalogId,
  normalizeTaxonomyTermId,
  type AppTaxonomyRuntimeConfig,
} from './app-taxonomy'

export const APP_ADVANCED_FILTER_ENTITLEMENT = 'discovery.filter.advanced'
export const APP_SAVED_FILTER_MAX_ENTITLEMENT = 'discovery.saved_filter.max'
export const APP_SEARCH_FILTER_MAX_SAVED_LIMIT = 100

export const APP_BASIC_FILTER_TYPES = [
  'region_scope',
  'region_group',
  'city_country',
  'content_type',
] as const satisfies readonly AppTaxonomyType[]

export const APP_BASIC_ADVANCED_FILTER_TYPES = [
  'style',
  'occupation',
  'scene',
] as const satisfies readonly AppTaxonomyType[]

export const APP_FULL_ADVANCED_FILTER_TYPES = [
  'identity',
  'personality',
  'hair',
  'clothing',
] as const satisfies readonly AppTaxonomyType[]

export type AppSearchFilterTier = 'none' | 'basic' | 'full'
export type AppSearchFilterGroup = 'region' | Exclude<AppTaxonomyType,
  'region_scope' | 'region_group' | 'city_country'>

export interface AppSearchFilterAccess {
  advancedTier: AppSearchFilterTier
  savedFilterMax: number
  sourceTierId: string | null
  membershipCatalogVersionId: string | null
  membershipReady: boolean
}

export interface AppResolvedFilterTerm {
  sourceTermId: string
  termId: string | null
  type: AppTaxonomyType | null
  displayName: string | null
  status: 'active' | 'redirected' | 'invalid'
  requiredTier: AppSearchFilterTier | null
  accessible: boolean
}

export interface AppResolvedPersonFilterSelection {
  sourceCatalogVersionId: string
  catalogVersionId: string
  termIds: string[]
  groups: Array<{
    group: AppSearchFilterGroup
    termIds: string[]
  }>
  resolutions: AppResolvedFilterTerm[]
  invalidTermIds: string[]
  restrictedTermIds: string[]
  redundantTermIds: string[]
  filterHash: string
  access: AppSearchFilterAccess
  canApply: boolean
}

export interface AppSearchFilterReference {
  catalogVersionId: string
  termIds: string[]
}

type SourceCatalogItemRow = {
  term_id: string
  type: string
  display_name: string
  public_state: string
  redirect_target_term_id: string | null
  visibility: string
  sensitivity: string
}

export function readAppSearchFilterInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>).filters
}

export async function resolveAppPersonFilterSelection(
  db: D1Database,
  accountId: number,
  value: unknown,
  policy: AppPersonSearchPolicy,
  taxonomyConfig: AppTaxonomyRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
): Promise<AppResolvedPersonFilterSelection | null> {
  assertPositiveSearchAccountId(accountId)
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppPersonSearchError(400, 'SEARCH_FILTERS_INVALID', 'filters 必须为 JSON 对象')
  }
  const reference = normalizeAppSearchFilterReference(value, policy.maxFilterTerms)
  const sourceCatalogVersionId = reference.catalogVersionId
  const sourceTermIds = reference.termIds
  const [currentCatalog, sourceItems, access] = await Promise.all([
    loadCurrentCatalog(db, taxonomyConfig, now),
    loadSourceCatalogItems(db, sourceCatalogVersionId, sourceTermIds),
    resolveAppSearchFilterAccess(db, accountId, membershipConfig, now),
  ])
  const currentItems = new Map(currentCatalog.terms.map(term => [term.termId, term]))
  const sourceItemMap = new Map(sourceItems.map(item => [item.term_id, item]))
  const resolutions: AppResolvedFilterTerm[] = []

  for (const sourceTermId of sourceTermIds) {
    const sourceItem = sourceItemMap.get(sourceTermId)
    if (!sourceItem || sourceItem.visibility !== 'public' || sourceItem.sensitivity !== 'standard') {
      resolutions.push(invalidResolution(sourceTermId))
      continue
    }
    const initialTermId = sourceItem.public_state === 'redirect'
      ? sourceItem.redirect_target_term_id
      : sourceTermId
    const resolved = initialTermId
      ? followCurrentRedirects(initialTermId, currentItems)
      : null
    if (!resolved || resolved.publicState !== 'active') {
      resolutions.push(invalidResolution(sourceTermId))
      continue
    }
    const requiredTier = requiredFilterTier(resolved.type)
    const accessible = hasFilterTier(access.advancedTier, requiredTier)
    resolutions.push({
      sourceTermId,
      termId: resolved.termId,
      type: resolved.type,
      displayName: resolved.displayName,
      status: sourceTermId === resolved.termId ? 'active' : 'redirected',
      requiredTier,
      accessible,
    })
  }

  const validTermIds = [...new Set(resolutions.flatMap(item => item.termId ? [item.termId] : []))]
  const redundantTermIds = await findRedundantFilterTerms(
    db,
    currentCatalog.catalogVersionId,
    validTermIds,
    currentItems,
  )
  const canonicalTermIds = validTermIds
    .filter(termId => !redundantTermIds.includes(termId))
    .sort()
  const groups = buildFilterGroups(canonicalTermIds, currentItems)
  const invalidTermIds = resolutions.filter(item => item.status === 'invalid').map(item => item.sourceTermId)
  const restrictedTermIds = resolutions
    .filter(item => item.termId && !item.accessible)
    .map(item => item.termId!)
  const filterHash = await sha256Hex(JSON.stringify({
    catalogVersionId: currentCatalog.catalogVersionId,
    termIds: canonicalTermIds,
  }))

  return {
    sourceCatalogVersionId,
    catalogVersionId: currentCatalog.catalogVersionId,
    termIds: canonicalTermIds,
    groups,
    resolutions,
    invalidTermIds,
    restrictedTermIds,
    redundantTermIds,
    filterHash,
    access,
    canApply: invalidTermIds.length === 0
      && restrictedTermIds.length === 0
      && canonicalTermIds.length > 0,
  }
}

export function normalizeAppSearchFilterReference(
  value: unknown,
  maxTerms: number,
): AppSearchFilterReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppPersonSearchError(400, 'SEARCH_FILTERS_INVALID', 'filters 必须为 JSON 对象')
  }
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => !['catalogVersionId', 'termIds'].includes(key))) {
    throw new AppPersonSearchError(400, 'SEARCH_FILTERS_INVALID', 'filters 包含未支持字段')
  }
  return {
    catalogVersionId: normalizeCatalogIdForSearch(object.catalogVersionId),
    termIds: normalizeFilterTermIds(object.termIds, maxTerms).sort(),
  }
}

export function assertAppFilterSelectionCanApply(
  selection: AppResolvedPersonFilterSelection | null,
): asserts selection is AppResolvedPersonFilterSelection {
  if (!selection || selection.termIds.length === 0) {
    throw new AppPersonSearchError(400, 'SEARCH_FILTERS_EMPTY', '请至少选择一个有效筛选条件')
  }
  if (selection.invalidTermIds.length) {
    throw new AppPersonSearchError(
      409,
      'SEARCH_FILTER_CATALOG_CHANGED',
      '部分筛选条件已下线或无法解析，请刷新目录后调整',
    )
  }
  if (selection.restrictedTermIds.length) {
    throw new AppPersonSearchError(
      403,
      'SEARCH_FILTER_ENTITLEMENT_REQUIRED',
      '当前会员权益不包含所选高级筛选条件',
    )
  }
  if (!selection.canApply) {
    throw new AppPersonSearchError(422, 'SEARCH_FILTERS_CONFLICT', '筛选条件当前无法应用')
  }
}

export function toAppSearchFilterSelectionResponse(
  selection: AppResolvedPersonFilterSelection,
) {
  return {
    sourceCatalogVersionId: selection.sourceCatalogVersionId,
    catalogVersionId: selection.catalogVersionId,
    termIds: selection.termIds,
    groups: selection.groups,
    resolutions: selection.resolutions,
    invalidTermIds: selection.invalidTermIds,
    restrictedTermIds: selection.restrictedTermIds,
    redundantTermIds: selection.redundantTermIds,
    canApply: selection.canApply,
    entitlement: {
      advancedKey: APP_ADVANCED_FILTER_ENTITLEMENT,
      advancedTier: selection.access.advancedTier,
      sourceTierId: selection.access.sourceTierId,
      membershipCatalogVersionId: selection.access.membershipCatalogVersionId,
      membershipReady: selection.access.membershipReady,
    },
  }
}

export async function getAppSearchFilterCapabilities(
  db: D1Database,
  accountId: number,
  policy: AppPersonSearchPolicy,
  taxonomyConfig: AppTaxonomyRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
) {
  assertPositiveSearchAccountId(accountId)
  const [catalog, access, savedCountRow] = await Promise.all([
    loadCurrentCatalog(db, taxonomyConfig, now),
    resolveAppSearchFilterAccess(db, accountId, membershipConfig, now),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_saved_person_filters
      WHERE account_id = ? AND deleted_at IS NULL
    `).bind(accountId).first<{ count: number }>(),
  ])
  const savedFilterCount = safeCount(savedCountRow?.count)
  return {
    policyVersion: policy.id,
    catalogVersionId: catalog.catalogVersionId,
    maxFilterTerms: policy.maxFilterTerms,
    typeAccess: {
      basic: [...APP_BASIC_FILTER_TYPES],
      advancedBasic: [...APP_BASIC_ADVANCED_FILTER_TYPES],
      advancedFull: [...APP_FULL_ADVANCED_FILTER_TYPES],
    },
    entitlement: {
      advancedKey: APP_ADVANCED_FILTER_ENTITLEMENT,
      advancedTier: access.advancedTier,
      savedFilterMaxKey: APP_SAVED_FILTER_MAX_ENTITLEMENT,
      savedFilterMax: access.savedFilterMax,
      sourceTierId: access.sourceTierId,
      membershipCatalogVersionId: access.membershipCatalogVersionId,
      membershipReady: access.membershipReady,
    },
    savedFilters: {
      count: savedFilterCount,
      max: access.savedFilterMax,
      canCreate: savedFilterCount < access.savedFilterMax,
    },
  }
}

export async function resolveAppSearchFilterAccess(
  db: D1Database,
  accountId: number,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
): Promise<AppSearchFilterAccess> {
  assertPositiveSearchAccountId(accountId)
  if (!membershipConfig.enabled || !membershipConfig.catalogVersionId) {
    return closedFilterAccess()
  }
  try {
    const snapshot = await resolveAppMembershipSnapshot(
      db,
      accountId,
      membershipConfig.catalogVersionId,
      now,
      { requireProductionReady: membershipConfig.requireProductionReady },
    )
    const advanced = snapshot.entitlements.find(item => item.key === APP_ADVANCED_FILTER_ENTITLEMENT)
    const saved = snapshot.entitlements.find(item => item.key === APP_SAVED_FILTER_MAX_ENTITLEMENT)
    const advancedTier = advanced?.executable && isFilterTier(advanced.value)
      ? advanced.value
      : 'none'
    const savedFilterMax = saved?.executable
      && typeof saved.value === 'number'
      && Number.isSafeInteger(saved.value)
      && saved.value >= 0
      && saved.value <= APP_SEARCH_FILTER_MAX_SAVED_LIMIT
      ? saved.value
      : 0
    return {
      advancedTier,
      savedFilterMax,
      sourceTierId: snapshot.tier?.tierId ?? null,
      membershipCatalogVersionId: snapshot.catalogVersionId,
      membershipReady: Boolean(advanced?.executable && saved?.executable),
    }
  }
  catch (error) {
    if (error instanceof AppMembershipError) return closedFilterAccess()
    throw error
  }
}

export function requiredFilterTier(type: AppTaxonomyType): AppSearchFilterTier {
  if (APP_BASIC_FILTER_TYPES.includes(type as typeof APP_BASIC_FILTER_TYPES[number])) return 'none'
  if (
    APP_BASIC_ADVANCED_FILTER_TYPES.includes(
      type as typeof APP_BASIC_ADVANCED_FILTER_TYPES[number],
    )
  ) return 'basic'
  return 'full'
}

export function hasFilterTier(actual: AppSearchFilterTier, required: AppSearchFilterTier) {
  return filterTierRank(actual) >= filterTierRank(required)
}

function filterTierRank(value: AppSearchFilterTier) {
  if (value === 'full') return 2
  if (value === 'basic') return 1
  return 0
}

function filterGroupForType(type: AppTaxonomyType): AppSearchFilterGroup {
  if (type === 'region_scope' || type === 'region_group' || type === 'city_country') return 'region'
  return type
}

function buildFilterGroups(
  termIds: string[],
  currentItems: Map<string, AppTaxonomyTerm>,
) {
  const grouped = new Map<AppSearchFilterGroup, string[]>()
  for (const termId of termIds) {
    const term = currentItems.get(termId)
    if (!term) continue
    const group = filterGroupForType(term.type)
    const values = grouped.get(group) ?? []
    values.push(termId)
    grouped.set(group, values)
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, values]) => ({ group, termIds: values.sort() }))
}

async function findRedundantFilterTerms(
  db: D1Database,
  catalogVersionId: string,
  termIds: string[],
  currentItems: Map<string, AppTaxonomyTerm>,
) {
  if (termIds.length < 2) return []
  const placeholders = termIds.map(() => '?').join(', ')
  const pairs = await db.prepare(`
    SELECT ancestor_term_id, descendant_term_id
    FROM app_taxonomy_catalog_closure
    WHERE catalog_id = ?
      AND ancestor_term_id IN (${placeholders})
      AND descendant_term_id IN (${placeholders})
      AND ancestor_term_id <> descendant_term_id
  `).bind(catalogVersionId, ...termIds, ...termIds).all<{
    ancestor_term_id: string
    descendant_term_id: string
  }>()
  return [...new Set(pairs.results.flatMap((pair) => {
    const ancestor = currentItems.get(pair.ancestor_term_id)
    const descendant = currentItems.get(pair.descendant_term_id)
    if (!ancestor || !descendant) return []
    return filterGroupForType(ancestor.type) === filterGroupForType(descendant.type)
      ? [pair.descendant_term_id]
      : []
  }))].sort()
}

async function loadCurrentCatalog(
  db: D1Database,
  config: AppTaxonomyRuntimeConfig,
  now: Date,
) {
  try {
    return await getPublicAppTaxonomyCatalog(db, config, now)
  }
  catch (error) {
    if (error instanceof AppTaxonomyError) {
      throw new AppPersonSearchError(
        error.status === 403 ? 403 : 503,
        error.code === 'TAXONOMY_CATALOG_DISABLED'
          ? 'SEARCH_FILTER_CATALOG_DISABLED'
          : 'SEARCH_FILTER_CATALOG_NOT_READY',
        error.message,
        error.retryable,
      )
    }
    throw error
  }
}

async function loadSourceCatalogItems(
  db: D1Database,
  catalogVersionId: string,
  termIds: string[],
) {
  const catalog = await db.prepare(`
    SELECT catalog_id
    FROM app_taxonomy_catalogs
    WHERE catalog_id = ?
    LIMIT 1
  `).bind(catalogVersionId).first<{ catalog_id: string }>()
  if (!catalog) {
    throw new AppPersonSearchError(409, 'SEARCH_FILTER_SOURCE_CATALOG_MISSING', '筛选条件来源目录不存在')
  }
  const placeholders = termIds.map(() => '?').join(', ')
  return (await db.prepare(`
    SELECT term_id, type, display_name, public_state, redirect_target_term_id,
           visibility, sensitivity
    FROM app_taxonomy_catalog_items
    WHERE catalog_id = ? AND term_id IN (${placeholders})
  `).bind(catalogVersionId, ...termIds).all<SourceCatalogItemRow>()).results
}

function followCurrentRedirects(
  initialTermId: string,
  currentItems: Map<string, AppTaxonomyTerm>,
) {
  let currentId = initialTermId
  const visited = new Set<string>()
  for (let depth = 0; depth < 8; depth += 1) {
    if (visited.has(currentId)) return null
    visited.add(currentId)
    const item = currentItems.get(currentId)
    if (!item) return null
    if (item.publicState !== 'redirect') return item
    if (!item.redirectTargetTermId) return null
    currentId = item.redirectTargetTermId
  }
  return null
}

function normalizeCatalogIdForSearch(value: unknown) {
  try {
    return normalizeRequiredCatalogId(value)
  }
  catch (error) {
    if (error instanceof AppTaxonomyError) {
      throw new AppPersonSearchError(400, 'SEARCH_FILTER_CATALOG_ID_INVALID', error.message)
    }
    throw error
  }
}

function normalizeFilterTermIds(value: unknown, maxTerms: number) {
  if (!Array.isArray(value)) {
    throw new AppPersonSearchError(400, 'SEARCH_FILTER_TERM_IDS_INVALID', 'filters.termIds 必须为数组')
  }
  let termIds: string[]
  try {
    termIds = [...new Set(value.map(normalizeTaxonomyTermId))]
  }
  catch (error) {
    if (error instanceof AppTaxonomyError) {
      throw new AppPersonSearchError(400, 'SEARCH_FILTER_TERM_IDS_INVALID', error.message)
    }
    throw error
  }
  if (!termIds.length || termIds.length > maxTerms) {
    throw new AppPersonSearchError(
      400,
      'SEARCH_FILTER_TERM_IDS_INVALID',
      `filters.termIds 必须包含 1 至 ${maxTerms} 个稳定词条 ID`,
    )
  }
  return termIds
}

function invalidResolution(sourceTermId: string): AppResolvedFilterTerm {
  return {
    sourceTermId,
    termId: null,
    type: null,
    displayName: null,
    status: 'invalid',
    requiredTier: null,
    accessible: false,
  }
}

function isFilterTier(value: unknown): value is AppSearchFilterTier {
  return value === 'none' || value === 'basic' || value === 'full'
}

function closedFilterAccess(): AppSearchFilterAccess {
  return {
    advancedTier: 'none',
    savedFilterMax: 0,
    sourceTierId: null,
    membershipCatalogVersionId: null,
    membershipReady: false,
  }
}

function safeCount(value: unknown) {
  const count = Number(value ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AppPersonSearchError(503, 'SAVED_FILTER_DATA_INVALID', '保存条件计数异常')
  }
  return count
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
