import type {
  AppMembershipCatalog,
  AppMembershipEntitlementDefinition,
  AppMembershipEntitlementValue,
  AppMembershipEntitlementValueType,
  AppMembershipResolvedEntitlement,
  AppMembershipSnapshot,
  AppMembershipTier,
  AppMembershipTierEntitlement,
} from '@meigallery/shared'
import type { Bindings } from '../index'

export const APP_MEMBERSHIP_DRAFT_CATALOG_ID = 'amc_app_1_0_draft_1'
export const APP_MEMBERSHIP_DEFAULT_EXPIRING_SOON_DAYS = 30

export interface AppMembershipRuntimeConfig {
  enabled: boolean
  adminEnabled: boolean
  applicationsEnabled: boolean
  catalogVersionId: string | null
  requireProductionReady: boolean
  expiringSoonWindowDays: number
}

export class AppMembershipError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppMembershipError'
  }
}

interface CatalogRow {
  id: string
  version_code: string
  state: string
  production_ready: number
  effective_at: string
  timezone: string
  minimum_client_version: string
}

interface DefinitionRow {
  entitlement_key: string
  schema_version: number
  value_type: string
  default_value_json: string
  merge_strategy: string
  period_rule: string | null
  client_capability: string
  display_name: string
  description: string
  unit_label: string | null
}

interface TierRow {
  tier_id: string
  code: string
  display_name: string
  tagline: string
  rank: number
  accent_token: string
  acquisition_label: string
  service_disclosure: string
}

interface TierEntitlementRow {
  tier_id: string
  entitlement_key: string
  value_json: string
  availability: string
}

interface ActiveGrantRow {
  grant_id: string
  tier_id: string
  tier_code_snapshot: string
  tier_name_snapshot: string
  rank_snapshot: number
  starts_at: string
  expires_at: string
  source_type: string
  user_visible_note: string
  accent_token: string
}

interface EndedGrantRow extends ActiveGrantRow {
  ended_state: 'expired' | 'revoked'
  ended_at: string
  ended_user_visible_note: string | null
}

export function getAppMembershipRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_MEMBERSHIP_ENABLED'
  | 'APP_MEMBERSHIP_ADMIN_ENABLED'
  | 'APP_MEMBERSHIP_APPLICATIONS_ENABLED'
  | 'APP_MEMBERSHIP_CATALOG_VERSION'
  | 'APP_MEMBERSHIP_PRODUCTION_READY'
  | 'APP_MEMBERSHIP_EXPIRING_SOON_DAYS'
>): AppMembershipRuntimeConfig {
  const catalogVersionId = normalizeCatalogVersionId(env.APP_MEMBERSHIP_CATALOG_VERSION)
  const requireProductionReady = env.APP_ENV === 'production'
  const productionGateSatisfied = !requireProductionReady || env.APP_MEMBERSHIP_PRODUCTION_READY === 'true'

  return {
    enabled: env.APP_MEMBERSHIP_ENABLED === 'true' && Boolean(catalogVersionId) && productionGateSatisfied,
    adminEnabled: env.APP_MEMBERSHIP_ADMIN_ENABLED === 'true' && Boolean(catalogVersionId) && productionGateSatisfied,
    applicationsEnabled: env.APP_MEMBERSHIP_APPLICATIONS_ENABLED === 'true'
      && env.APP_MEMBERSHIP_ENABLED === 'true'
      && Boolean(catalogVersionId)
      && productionGateSatisfied,
    catalogVersionId,
    requireProductionReady,
    expiringSoonWindowDays: normalizeExpiringSoonWindowDays(env.APP_MEMBERSHIP_EXPIRING_SOON_DAYS),
  }
}

export function requireAppMembershipEnabled(config: AppMembershipRuntimeConfig): asserts config is AppMembershipRuntimeConfig & { catalogVersionId: string } {
  if (!config.enabled || !config.catalogVersionId) {
    throw new AppMembershipError(403, 'FEATURE_DISABLED', '会员能力尚未开放')
  }
}

export function requireAppMembershipAdminEnabled(config: AppMembershipRuntimeConfig): asserts config is AppMembershipRuntimeConfig & { catalogVersionId: string } {
  if (!config.adminEnabled || !config.catalogVersionId) {
    throw new AppMembershipError(403, 'FEATURE_DISABLED', 'App 会员管理能力尚未开放')
  }
}

export async function getAppMembershipCatalog(
  db: D1Database,
  catalogVersionId: string,
  options: { requireProductionReady?: boolean; applicationEnabled?: boolean } = {},
): Promise<AppMembershipCatalog> {
  const catalog = await db.prepare(`
    SELECT id, version_code, state, production_ready, effective_at, timezone, minimum_client_version
    FROM app_membership_catalog_versions
    WHERE id = ? AND state IN ('development', 'published')
    LIMIT 1
  `).bind(catalogVersionId).first<CatalogRow>()

  if (!catalog) {
    throw new AppMembershipError(503, 'MEMBERSHIP_CATALOG_UNAVAILABLE', '会员目录暂不可用', true)
  }
  if (options.requireProductionReady && (catalog.state !== 'published' || catalog.production_ready !== 1)) {
    throw new AppMembershipError(503, 'MEMBERSHIP_CATALOG_NOT_READY', '会员目录尚未通过生产发布门禁')
  }
  if (catalog.state !== 'development' && catalog.state !== 'published') {
    throw invalidCatalog()
  }

  const [definitionResult, tierResult, entitlementResult] = await Promise.all([
    db.prepare(`
      SELECT entitlement_key, schema_version, value_type, default_value_json, merge_strategy,
             period_rule, client_capability, display_name, description, unit_label
      FROM app_entitlement_definitions
      WHERE catalog_version_id = ?
      ORDER BY entitlement_key ASC
    `).bind(catalogVersionId).all<DefinitionRow>(),
    db.prepare(`
      SELECT tier_id, code, display_name, tagline, rank, accent_token,
             acquisition_label, service_disclosure
      FROM app_membership_tiers
      WHERE catalog_version_id = ?
      ORDER BY sort_order ASC, tier_id ASC
    `).bind(catalogVersionId).all<TierRow>(),
    db.prepare(`
      SELECT tier_id, entitlement_key, value_json, availability
      FROM app_membership_tier_entitlements
      WHERE catalog_version_id = ?
      ORDER BY tier_id ASC, entitlement_key ASC
    `).bind(catalogVersionId).all<TierEntitlementRow>(),
  ])

  const definitions = definitionResult.results.map(toDefinition)
  const definitionMap = new Map(definitions.map(definition => [definition.key, definition]))
  const entitlementsByTier = new Map<string, AppMembershipTierEntitlement[]>()
  for (const row of entitlementResult.results) {
    const definition = definitionMap.get(row.entitlement_key)
    if (!definition || (row.availability !== 'available' && row.availability !== 'planned')) {
      throw invalidCatalog()
    }
    const entitlement: AppMembershipTierEntitlement = {
      key: row.entitlement_key,
      value: parseEntitlementValue(definition.valueType, row.value_json),
      availability: row.availability,
    }
    const tierEntitlements = entitlementsByTier.get(row.tier_id) ?? []
    tierEntitlements.push(entitlement)
    entitlementsByTier.set(row.tier_id, tierEntitlements)
  }

  const tiers: AppMembershipTier[] = tierResult.results.map((row) => {
    const entitlements = entitlementsByTier.get(row.tier_id) ?? []
    if (entitlements.length !== definitions.length) throw invalidCatalog()
    return {
      tierId: row.tier_id,
      code: row.code,
      displayName: row.display_name,
      tagline: row.tagline,
      rank: Number(row.rank),
      accentToken: row.accent_token,
      acquisitionLabel: row.acquisition_label,
      serviceDisclosure: row.service_disclosure,
      entitlements,
    }
  })
  if (
    tiers.length !== 5
    || definitions.length === 0
    || tiers.some((tier, index) => index > 0 && tier.rank <= tiers[index - 1]!.rank)
  ) throw invalidCatalog()

  return {
    catalogVersionId: catalog.id,
    versionCode: catalog.version_code,
    state: catalog.state,
    productionReady: catalog.production_ready === 1,
    effectiveAt: catalog.effective_at,
    timezone: catalog.timezone,
    minimumClientVersion: catalog.minimum_client_version,
    acquisition: {
      mode: 'contact_platform',
      applicationEnabled: options.applicationEnabled === true,
      paymentEnabled: false,
      label: tiers[0]!.acquisitionLabel,
    },
    definitions,
    tiers,
  }
}

export async function resolveAppMembershipSnapshot(
  db: D1Database,
  userId: number,
  catalogVersionId: string,
  now = new Date(),
  options: { requireProductionReady?: boolean; expiringSoonWindowDays?: number } = {},
): Promise<AppMembershipSnapshot> {
  const catalog = await getAppMembershipCatalog(db, catalogVersionId, options)
  const nowIso = now.toISOString()
  const expiringSoonWindowDays = normalizeExpiringSoonWindowDays(options.expiringSoonWindowDays)
  const grant = await db.prepare(`
    SELECT g.id AS grant_id, g.tier_id, g.tier_code_snapshot, g.tier_name_snapshot,
           g.rank_snapshot, g.starts_at, g.expires_at, g.source_type,
           g.user_visible_note, t.accent_token
    FROM app_membership_grants g
    JOIN app_membership_tiers t
      ON t.catalog_version_id = g.catalog_version_id AND t.tier_id = g.tier_id
    LEFT JOIN app_membership_grant_revocations r ON r.grant_id = g.id
    WHERE g.user_id = ?
      AND g.catalog_version_id = ?
      AND r.grant_id IS NULL
      AND g.starts_at <= ?
      AND g.expires_at > ?
    ORDER BY g.rank_snapshot DESC, g.expires_at DESC, g.id ASC
    LIMIT 1
  `).bind(userId, catalogVersionId, nowIso, nowIso).first<ActiveGrantRow>()

  const endedGrant = grant
    ? null
    : await db.prepare(`
      SELECT g.id AS grant_id, g.tier_id, g.tier_code_snapshot, g.tier_name_snapshot,
             g.rank_snapshot, g.starts_at, g.expires_at, g.source_type,
             g.user_visible_note, t.accent_token,
             CASE
               WHEN r.revoked_at IS NOT NULL AND r.revoked_at <= g.expires_at THEN 'revoked'
               ELSE 'expired'
             END AS ended_state,
             CASE
               WHEN r.revoked_at IS NOT NULL AND r.revoked_at <= g.expires_at THEN r.revoked_at
               ELSE g.expires_at
             END AS ended_at,
             CASE
               WHEN r.revoked_at IS NOT NULL AND r.revoked_at <= g.expires_at THEN r.user_visible_note
               ELSE NULL
             END AS ended_user_visible_note
      FROM app_membership_grants g
      JOIN app_membership_tiers t
        ON t.catalog_version_id = g.catalog_version_id AND t.tier_id = g.tier_id
      LEFT JOIN app_membership_grant_revocations r ON r.grant_id = g.id
      WHERE g.user_id = ?
        AND g.catalog_version_id = ?
        AND g.starts_at <= ?
        AND (
          g.expires_at <= ?
          OR (r.revoked_at IS NOT NULL AND r.revoked_at <= ? AND r.revoked_at <= g.expires_at)
        )
      ORDER BY ended_at DESC, g.rank_snapshot DESC, g.id ASC
      LIMIT 1
    `).bind(userId, catalogVersionId, nowIso, nowIso, nowIso).first<EndedGrantRow>()

  const tier = grant
    ? catalog.tiers.find(item => item.tierId === grant.tier_id)
    : null
  if (grant && !tier) throw invalidCatalog()
  const endedTier = endedGrant
    ? catalog.tiers.find(item => item.tierId === endedGrant.tier_id)
    : null
  if (endedGrant && !endedTier) throw invalidCatalog()
  const tierValues = new Map((tier?.entitlements ?? []).map(item => [item.key, item]))
  const entitlements: AppMembershipResolvedEntitlement[] = catalog.definitions.map((definition) => {
    const resolved = tierValues.get(definition.key)
    const availability = resolved?.availability ?? 'planned'
    return {
      ...definition,
      value: resolved?.value ?? definition.defaultValue,
      availability,
      executable: availability === 'available',
      sourceTierId: tier?.tierId ?? null,
      usage: null,
    }
  })

  const remainingMilliseconds = grant
    ? new Date(grant.expires_at).getTime() - now.getTime()
    : null
  const remainingDays = remainingMilliseconds === null
    ? null
    : Math.max(0, Math.ceil(remainingMilliseconds / 86_400_000))
  const lifecycleState = grant
    ? remainingMilliseconds! <= expiringSoonWindowDays * 86_400_000
      ? 'expiring_soon' as const
      : 'active' as const
    : endedGrant?.ended_state ?? 'free'

  return {
    catalogVersionId: catalog.catalogVersionId,
    versionCode: catalog.versionCode,
    generatedAt: nowIso,
    status: grant ? 'active' : 'free',
    tier: grant && tier
      ? {
          tierId: grant.tier_id,
          code: grant.tier_code_snapshot,
          displayName: grant.tier_name_snapshot,
          rank: Number(grant.rank_snapshot),
          accentToken: tier.accentToken,
        }
      : null,
    grant: grant
      ? {
          grantId: grant.grant_id,
          sourceType: 'manual_admin',
          startsAt: grant.starts_at,
          expiresAt: grant.expires_at,
          userVisibleNote: grant.user_visible_note,
        }
      : null,
    lifecycle: {
      state: lifecycleState,
      expiringSoonWindowDays,
      remainingDays,
      endedGrant: endedGrant && endedTier
        ? {
            tier: {
              tierId: endedGrant.tier_id,
              code: endedGrant.tier_code_snapshot,
              displayName: endedGrant.tier_name_snapshot,
              rank: Number(endedGrant.rank_snapshot),
              accentToken: endedTier.accentToken,
            },
            grant: {
              grantId: endedGrant.grant_id,
              sourceType: 'manual_admin',
              startsAt: endedGrant.starts_at,
              expiresAt: endedGrant.expires_at,
              userVisibleNote: endedGrant.user_visible_note,
            },
            endedAt: endedGrant.ended_at,
            userVisibleNote: endedGrant.ended_user_visible_note,
          }
        : null,
    },
    entitlements,
  }
}

export async function getAppMembershipSummary(
  db: D1Database,
  userId: number,
  catalogVersionId: string | null,
  now = new Date(),
  options: { requireProductionReady?: boolean } = {},
): Promise<{ code: string; name: string; rank: number; expiresAt: string | null }> {
  if (!catalogVersionId) {
    return { code: 'free', name: '普通用户', rank: 0, expiresAt: null }
  }
  await getAppMembershipCatalog(db, catalogVersionId, options)
  const nowIso = now.toISOString()
  const grant = await db.prepare(`
    SELECT tier_code_snapshot, tier_name_snapshot, rank_snapshot, expires_at
    FROM app_membership_grants g
    WHERE g.user_id = ?
      AND g.catalog_version_id = ?
      AND g.starts_at <= ?
      AND g.expires_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM app_membership_grant_revocations r WHERE r.grant_id = g.id
      )
    ORDER BY g.rank_snapshot DESC, g.expires_at DESC, g.id ASC
    LIMIT 1
  `).bind(userId, catalogVersionId, nowIso, nowIso).first<{
    tier_code_snapshot: string
    tier_name_snapshot: string
    rank_snapshot: number
    expires_at: string
  }>()
  return grant
    ? {
        code: grant.tier_code_snapshot,
        name: grant.tier_name_snapshot,
        rank: Number(grant.rank_snapshot),
        expiresAt: grant.expires_at,
      }
    : { code: 'free', name: '普通用户', rank: 0, expiresAt: null }
}

function normalizeCatalogVersionId(value: string | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized || !/^amc_[A-Za-z0-9_-]{1,76}$/u.test(normalized)) return null
  return normalized
}

function normalizeExpiringSoonWindowDays(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365
    ? parsed
    : APP_MEMBERSHIP_DEFAULT_EXPIRING_SOON_DAYS
}

function toDefinition(row: DefinitionRow): AppMembershipEntitlementDefinition {
  if (
    !isValueType(row.value_type)
    || row.merge_strategy !== 'highest_rank'
    || !Number.isInteger(Number(row.schema_version))
  ) {
    throw invalidCatalog()
  }
  return {
    key: row.entitlement_key,
    schemaVersion: Number(row.schema_version),
    valueType: row.value_type,
    defaultValue: parseEntitlementValue(row.value_type, row.default_value_json),
    mergeStrategy: 'highest_rank',
    periodRule: row.period_rule,
    clientCapability: row.client_capability,
    displayName: row.display_name,
    description: row.description,
    unitLabel: row.unit_label,
  }
}

function parseEntitlementValue(
  valueType: AppMembershipEntitlementValueType,
  rawValue: string,
): AppMembershipEntitlementValue {
  let value: unknown
  try {
    value = JSON.parse(rawValue)
  }
  catch {
    throw invalidCatalog()
  }
  if (valueType === 'boolean' && typeof value === 'boolean') return value
  if (valueType === 'integer' && typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (valueType === 'enum' && typeof value === 'string' && value.length > 0 && value.length <= 64) return value
  throw invalidCatalog()
}

function isValueType(value: string): value is AppMembershipEntitlementValueType {
  return value === 'boolean' || value === 'integer' || value === 'enum'
}

function invalidCatalog() {
  return new AppMembershipError(503, 'MEMBERSHIP_CATALOG_INVALID', '会员目录配置异常', false)
}
