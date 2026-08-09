import type {
  AppTaxonomyCatalog,
  AppTaxonomyCatalogState,
  AppTaxonomyPublicState,
  AppTaxonomyType,
} from '@meigallery/shared'
import type { Bindings } from '../index'

export const APP_TAXONOMY_CATALOG_ID = 'txc_app_1_0_taxonomy_1_dev_1'

export const APP_TAXONOMY_TYPES = [
  'region_scope',
  'region_group',
  'city_country',
  'identity',
  'personality',
  'style',
  'occupation',
  'hair',
  'clothing',
  'scene',
  'content_type',
] as const satisfies readonly AppTaxonomyType[]

const CATALOG_ID_PATTERN = /^txc_[A-Za-z0-9_-]{4,92}$/u

export interface AppTaxonomyRuntimeConfig {
  enabled: boolean
  adminEnabled: boolean
  catalogId: string
  catalogConfigured: boolean
  requireProductionReady: boolean
}

type CatalogRow = {
  catalog_id: string
  version_code: string
  state: string
  production_ready: number
  effective_at: string
  minimum_client_version: string
  item_count: number
  lock_version: number
  created_by: number | null
  published_by: number | null
  created_at: string
  published_at: string | null
}

type CatalogItemRow = {
  term_id: string
  term_version: number
  type: string
  parent_term_id: string | null
  display_name: string
  slug: string
  aliases_json: string
  public_state: string
  redirect_target_term_id: string | null
  allowed_for_profile: number
  sort_order: number
}

export class AppTaxonomyError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
    readonly retryable = false,
  ) {
    super(message)
  }
}

export function getAppTaxonomyRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_TAXONOMY_ENABLED'
  | 'APP_TAXONOMY_ADMIN_ENABLED'
  | 'APP_TAXONOMY_CATALOG_VERSION'
  | 'APP_TAXONOMY_PRODUCTION_READY'
>): AppTaxonomyRuntimeConfig {
  const configuredCatalogId = normalizeCatalogId(env.APP_TAXONOMY_CATALOG_VERSION)
  const requireProductionReady = env.APP_ENV === 'production'
  const productionGateSatisfied = !requireProductionReady
    || env.APP_TAXONOMY_PRODUCTION_READY === 'true'
  return {
    enabled: env.APP_TAXONOMY_ENABLED === 'true'
      && Boolean(configuredCatalogId)
      && productionGateSatisfied,
    adminEnabled: env.APP_TAXONOMY_ADMIN_ENABLED === 'true'
      && productionGateSatisfied,
    catalogId: configuredCatalogId ?? APP_TAXONOMY_CATALOG_ID,
    catalogConfigured: Boolean(configuredCatalogId),
    requireProductionReady,
  }
}

export function requireAppTaxonomyAdminEnabled(config: AppTaxonomyRuntimeConfig): void {
  if (!config.adminEnabled) {
    throw new AppTaxonomyError(403, 'TAXONOMY_ADMIN_DISABLED', '分类管理当前保持关闭')
  }
}

export async function resolveAppTaxonomyCatalogCapability(
  db: D1Database,
  config: AppTaxonomyRuntimeConfig,
  now = new Date(),
): Promise<boolean> {
  if (!config.enabled) return false
  try {
    await loadCatalogRow(db, config.catalogId, config.requireProductionReady, now)
    return true
  }
  catch {
    return false
  }
}

export async function getPublicAppTaxonomyCatalog(
  db: D1Database,
  config: AppTaxonomyRuntimeConfig,
  now = new Date(),
): Promise<AppTaxonomyCatalog> {
  if (!config.enabled) {
    throw new AppTaxonomyError(403, 'TAXONOMY_CATALOG_DISABLED', '分类目录当前保持关闭')
  }
  const catalog = await loadCatalogRow(db, config.catalogId, config.requireProductionReady, now)
  const items = await db.prepare(`
    SELECT term_id, term_version, type, parent_term_id, display_name, slug,
           aliases_json, public_state, redirect_target_term_id,
           allowed_for_profile, sort_order
    FROM app_taxonomy_catalog_items
    WHERE catalog_id = ?
      AND visibility = 'public'
      AND sensitivity = 'standard'
    ORDER BY
      CASE type
        WHEN 'region_scope' THEN 10
        WHEN 'region_group' THEN 20
        WHEN 'city_country' THEN 30
        WHEN 'identity' THEN 40
        WHEN 'personality' THEN 50
        WHEN 'style' THEN 60
        WHEN 'occupation' THEN 70
        WHEN 'hair' THEN 80
        WHEN 'clothing' THEN 90
        WHEN 'scene' THEN 100
        WHEN 'content_type' THEN 110
        ELSE 999
      END ASC,
      sort_order ASC,
      display_name COLLATE NOCASE ASC,
      term_id ASC
  `).bind(catalog.catalog_id).all<CatalogItemRow>()

  return {
    catalogVersionId: catalog.catalog_id,
    versionCode: catalog.version_code,
    state: catalog.state as AppTaxonomyCatalogState,
    productionReady: catalog.production_ready === 1,
    effectiveAt: catalog.effective_at,
    minimumClientVersion: catalog.minimum_client_version,
    terms: items.results.map(mapPublicCatalogItem),
  }
}

export async function getAppTaxonomyCatalogRecord(
  db: D1Database,
  catalogId: string,
  options: { requireProductionReady?: boolean; now?: Date } = {},
) {
  const row = await loadCatalogRow(
    db,
    normalizeRequiredCatalogId(catalogId),
    options.requireProductionReady ?? false,
    options.now ?? new Date(),
  )
  return mapAdminCatalog(row)
}

export async function assertAssignableTaxonomyTerms(
  db: D1Database,
  catalogId: string,
  rawTermIds: unknown,
  options: { requireProductionReady?: boolean; now?: Date } = {},
) {
  const normalizedCatalogId = normalizeRequiredCatalogId(catalogId)
  await loadCatalogRow(
    db,
    normalizedCatalogId,
    options.requireProductionReady ?? false,
    options.now ?? new Date(),
  )
  const termIds = normalizeTermIds(rawTermIds)
  if (!termIds.length) return []

  const placeholders = termIds.map(() => '?').join(', ')
  const rows = await db.prepare(`
    SELECT term_id, term_version, type, parent_term_id, display_name, slug,
           aliases_json, public_state, redirect_target_term_id,
           allowed_for_profile, sort_order
    FROM app_taxonomy_catalog_items
    WHERE catalog_id = ?
      AND term_id IN (${placeholders})
      AND public_state = 'active'
      AND visibility = 'public'
      AND sensitivity = 'standard'
      AND allowed_for_profile = 1
  `).bind(normalizedCatalogId, ...termIds).all<CatalogItemRow>()
  const byId = new Map(rows.results.map(row => [row.term_id, row]))
  const invalidTermIds = termIds.filter(termId => !byId.has(termId))
  if (invalidTermIds.length) {
    throw new AppTaxonomyError(
      422,
      'TAXONOMY_TERMS_NOT_ASSIGNABLE',
      '部分分类词条不存在、已失效或不可用于人物资料',
      { invalidTermIds },
    )
  }
  return termIds.map(termId => {
    const row = byId.get(termId)!
    return {
      termId: row.term_id,
      termVersion: row.term_version,
      type: row.type as AppTaxonomyType,
      displayName: row.display_name,
    }
  })
}

export function normalizeRequiredCatalogId(value: unknown): string {
  if (typeof value !== 'string' || !CATALOG_ID_PATTERN.test(value)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_CATALOG_ID_INVALID', '分类目录 ID 格式无效')
  }
  return value
}

export function normalizeTaxonomyTermId(value: unknown): string {
  if (typeof value !== 'string' || !/^txt_[A-Za-z0-9_-]{4,92}$/u.test(value)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_TERM_ID_INVALID', '分类词条 ID 格式无效')
  }
  return value
}

export function isAppTaxonomyType(value: unknown): value is AppTaxonomyType {
  return typeof value === 'string' && APP_TAXONOMY_TYPES.includes(value as AppTaxonomyType)
}

function normalizeCatalogId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return CATALOG_ID_PATTERN.test(normalized) ? normalized : null
}

function normalizeTermIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppTaxonomyError(400, 'TAXONOMY_TERM_IDS_INVALID', 'termIds 必须为数组')
  }
  const termIds = [...new Set(value.map(normalizeTaxonomyTermId))]
  if (termIds.length > 30) {
    throw new AppTaxonomyError(400, 'TAXONOMY_TERM_IDS_INVALID', '人物分类词条最多 30 个')
  }
  return termIds
}

async function loadCatalogRow(
  db: D1Database,
  catalogId: string,
  requireProductionReady: boolean,
  now: Date,
) {
  const row = await db.prepare(`
    SELECT catalog_id, version_code, state, production_ready, effective_at,
           minimum_client_version, item_count, lock_version, created_by,
           published_by, created_at, published_at
    FROM app_taxonomy_catalogs
    WHERE catalog_id = ?
    LIMIT 1
  `).bind(catalogId).first<CatalogRow>()
  const effective = typeof row?.effective_at === 'string'
    && Number.isFinite(Date.parse(row.effective_at))
    && Date.parse(row.effective_at) <= now.getTime()
  const eligible = row
    && (row.state === 'development' || row.state === 'published')
    && effective
    && (!requireProductionReady || (row.state === 'published' && row.production_ready === 1))
  if (!eligible) {
    throw new AppTaxonomyError(
      503,
      'TAXONOMY_CATALOG_NOT_READY',
      '分类目录尚未就绪',
      undefined,
      true,
    )
  }
  return row
}

function mapPublicCatalogItem(row: CatalogItemRow) {
  return {
    termId: row.term_id,
    type: row.type as AppTaxonomyType,
    parentTermId: row.parent_term_id,
    displayName: row.display_name,
    slug: row.slug,
    aliases: parseAliases(row.aliases_json),
    publicState: row.public_state as AppTaxonomyPublicState,
    redirectTargetTermId: row.redirect_target_term_id,
    allowedForProfile: row.allowed_for_profile === 1,
    sortOrder: row.sort_order,
    termVersion: row.term_version,
  }
}

function mapAdminCatalog(row: CatalogRow) {
  return {
    catalogVersionId: row.catalog_id,
    versionCode: row.version_code,
    state: row.state,
    productionReady: row.production_ready === 1,
    effectiveAt: row.effective_at,
    minimumClientVersion: row.minimum_client_version,
    itemCount: row.item_count,
    lockVersion: row.lock_version,
    createdBy: row.created_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }
}

function parseAliases(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : []
  }
  catch {
    return []
  }
}
