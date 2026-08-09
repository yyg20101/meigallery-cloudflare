import { generateId } from '../utils/db'
import { AppMembershipError } from './app-membership'

const CATALOG_ID = /^amc_[A-Za-z0-9_-]{1,76}$/u
const PUBLISH_REQUEST_ID = /^amcpr_[A-Za-z0-9_-]{1,89}$/u
const ENTITLEMENT_KEY = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/u
const TIER_ID = /^amt_[A-Za-z0-9_-]{1,75}$/u
const VERSION_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u
const TIER_CODE = /^[a-z][a-z0-9_]{2,47}$/u
const TOKEN_CODE = /^[a-z][a-z0-9_-]{0,31}$/u
const CLIENT_VERSION = /^[0-9]+(?:\.[0-9]+){1,2}(?:-[A-Za-z0-9.-]+)?$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u

const REQUIRED_APP_1_0_ENTITLEMENTS = [
  'direct_message.create',
  'direct_message.send',
  'direct_message.new_threads_per_day',
  'discovery.filter.advanced',
  'discovery.saved_filter.max',
  'history.retention_days',
  'favorite.folder_count',
] as const

const KNOWN_APP_CAPABILITIES = new Set([
  'messaging.text',
  'messaging.new_threads',
  'discovery.advanced_filters',
  'discovery.saved_filters',
  'history.viewer',
  'favorite.folders',
])

const SERVER_DEPENDENCIES: Record<string, string[]> = {
  'direct_message.create': ['平台话题创建权限'],
  'direct_message.send': ['平台话题发送权限'],
  'direct_message.new_threads_per_day': ['平台话题每日新建额度'],
  'discovery.filter.advanced': ['Search-2 高级筛选门禁'],
  'discovery.saved_filter.max': ['Search-2 保存条件额度'],
  'history.retention_days': ['浏览历史保留与读取'],
  'favorite.folder_count': ['收藏夹数量门禁'],
}

export type AdminMembershipCatalogState = 'development' | 'published' | 'retired'
export type AdminMembershipEntitlementValueType = 'boolean' | 'integer' | 'enum'
export type AdminMembershipEntitlementAvailability = 'available' | 'planned'
export type AdminMembershipEntitlementValue = boolean | number | string
export type AdminMembershipCatalogIssueSeverity = 'error' | 'warning' | 'info'

export interface AdminMembershipCatalogValidationIssue {
  code: string
  severity: AdminMembershipCatalogIssueSeverity
  scope: string
  message: string
}

export interface AdminMembershipCatalogValidation {
  issues: AdminMembershipCatalogValidationIssue[]
  errorCount: number
  warningCount: number
  infoCount: number
  canSubmitPublish: boolean
  canMarkProductionReady: boolean
}

export interface AdminMembershipCatalogTier {
  tierId: string
  code: string
  displayName: string
  tagline: string
  rank: number
  accentToken: string
  acquisitionLabel: string
  serviceDisclosure: string
  sortOrder: number
}

export interface AdminMembershipTierEntitlementValue {
  tierId: string
  value: AdminMembershipEntitlementValue
  availability: AdminMembershipEntitlementAvailability
}

export interface AdminMembershipEntitlementDefinition {
  key: string
  schemaVersion: number
  valueType: AdminMembershipEntitlementValueType
  defaultValue: AdminMembershipEntitlementValue
  mergeStrategy: 'highest_rank'
  periodRule: string | null
  clientCapability: string
  displayName: string
  description: string
  unitLabel: string | null
  values: AdminMembershipTierEntitlementValue[]
}

export interface AdminMembershipCatalogSummary {
  catalogVersionId: string
  versionCode: string
  state: AdminMembershipCatalogState
  productionReady: boolean
  effectiveAt: string
  timezone: string
  minimumClientVersion: string
  baseCatalogVersionId: string | null
  lockVersion: number
  changeSummary: string
  productionDecisionStatus: 'unresolved' | 'approved'
  tierCount: number
  entitlementCount: number
  grantCount: number
  applicationCount: number
  dependentCatalogCount: number
  activeRuntimeReference: boolean
  createdBy: number | null
  updatedBy: number | null
  publishedBy: number | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  latestPublishRequest: null | {
    requestId: string
    status: AdminMembershipCatalogPublishStatus
    createdAt: string
  }
}

export interface AdminMembershipCatalogDetail extends AdminMembershipCatalogSummary {
  contentHash: string
  tiers: AdminMembershipCatalogTier[]
  definitions: AdminMembershipEntitlementDefinition[]
  validation: AdminMembershipCatalogValidation
}

export interface AdminMembershipCatalogComparison {
  catalogVersionId: string
  baseCatalogVersionId: string
  tierChanges: Array<{
    tierId: string
    kind: 'added' | 'removed' | 'changed'
    fields: string[]
  }>
  entitlementChanges: Array<{
    key: string
    kind: 'added' | 'removed' | 'changed'
    fields: string[]
    tierValueChangeCount: number
  }>
  summary: {
    addedTiers: number
    removedTiers: number
    changedTiers: number
    addedEntitlements: number
    removedEntitlements: number
    changedEntitlements: number
  }
}

export type AdminMembershipCatalogPublishStatus =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'cancelled'

export interface AdminMembershipCatalogPublishRequest {
  requestId: string
  catalog: AdminMembershipCatalogSummary
  catalogLockVersion: number
  contentHash: string
  requestedProductionReady: boolean
  validation: AdminMembershipCatalogValidation
  submitNote: string
  status: AdminMembershipCatalogPublishStatus
  version: number
  requestedBy: { id: number; label: string }
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  canReview: boolean
}

export interface CreateAdminMembershipCatalogInput {
  baseCatalogVersionId?: unknown
  versionCode?: unknown
  effectiveAt?: unknown
  timezone?: unknown
  minimumClientVersion?: unknown
  changeSummary?: unknown
}

export interface UpdateAdminMembershipCatalogInput {
  expectedVersion?: unknown
  versionCode?: unknown
  effectiveAt?: unknown
  timezone?: unknown
  minimumClientVersion?: unknown
  changeSummary?: unknown
}

export interface ReplaceAdminMembershipCatalogTiersInput {
  expectedVersion?: unknown
  tiers?: unknown
  changeSummary?: unknown
}

export interface UpsertAdminMembershipEntitlementInput {
  expectedVersion?: unknown
  schemaVersion?: unknown
  valueType?: unknown
  defaultValue?: unknown
  periodRule?: unknown
  clientCapability?: unknown
  displayName?: unknown
  description?: unknown
  unitLabel?: unknown
  values?: unknown
  changeSummary?: unknown
}

export interface SubmitAdminMembershipCatalogPublishInput {
  expectedVersion?: unknown
  productionReady?: unknown
  submitNote?: unknown
}

export interface ReviewAdminMembershipCatalogPublishInput {
  expectedVersion?: unknown
  decision?: unknown
  reviewNote?: unknown
}

interface CatalogRow {
  id: string
  version_code: string
  state: string
  production_ready: number
  effective_at: string
  timezone: string
  minimum_client_version: string
  base_catalog_version_id: string | null
  lock_version: number
  change_summary: string
  production_decision_status: string
  content_hash: string | null
  created_by: number | null
  updated_by: number | null
  published_by: number | null
  created_at: string
  updated_at: string
  published_at: string | null
  tier_count?: number
  entitlement_count?: number
  grant_count?: number
  application_count?: number
  dependent_catalog_count?: number
  publish_request_id?: string | null
  publish_request_status?: string | null
  publish_request_created_at?: string | null
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
  sort_order: number
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

interface ValueRow {
  tier_id: string
  entitlement_key: string
  value_json: string
  availability: string
}

interface CatalogDocument {
  row: CatalogRow
  tiers: AdminMembershipCatalogTier[]
  definitions: AdminMembershipEntitlementDefinition[]
}

interface CommandRow {
  operation: string
  request_hash: string
  catalog_version_id: string
}

interface PublishRequestRow extends CatalogRow {
  request_id: string
  catalog_lock_version: number
  request_content_hash: string
  requested_production_ready: number
  validation_report_json: string
  submit_note: string
  request_status: string
  request_version: number
  request_hash: string
  requested_by: number
  requester_label: string
  reviewed_by: number | null
  reviewer_label: string | null
  review_note: string | null
  request_created_at: string
  request_updated_at: string
  reviewed_at: string | null
}

interface DecisionRow {
  request_id: string
  request_hash: string
  result_status: string
}

interface AdminActor {
  id: number
  role: 'admin' | 'owner'
}

export async function listAdminAppMembershipCatalogs(
  db: D1Database,
  activeCatalogVersionId: string | null,
): Promise<AdminMembershipCatalogSummary[]> {
  const rows = await db.prepare(`
    SELECT ${CATALOG_FIELDS},
      (SELECT COUNT(*) FROM app_membership_tiers tier WHERE tier.catalog_version_id = catalog.id) AS tier_count,
      (SELECT COUNT(*) FROM app_entitlement_definitions definition WHERE definition.catalog_version_id = catalog.id) AS entitlement_count,
      latest.id AS publish_request_id,
      latest.status AS publish_request_status,
      latest.created_at AS publish_request_created_at
    FROM app_membership_catalog_versions catalog
    JOIN app_membership_catalog_metadata metadata ON metadata.catalog_version_id = catalog.id
    LEFT JOIN app_membership_catalog_publish_requests latest ON latest.id = (
      SELECT request.id
      FROM app_membership_catalog_publish_requests request
      WHERE request.catalog_version_id = catalog.id
      ORDER BY request.created_at DESC, request.id DESC
      LIMIT 1
    )
    ORDER BY catalog.created_at DESC, catalog.id DESC
  `).all<CatalogRow>()
  return rows.results.map(row => mapCatalogSummary(row, activeCatalogVersionId))
}

export async function getAdminAppMembershipCatalog(
  db: D1Database,
  catalogVersionId: string,
  activeCatalogVersionId: string | null,
): Promise<AdminMembershipCatalogDetail> {
  const document = await loadCatalogDocument(db, normalizeCatalogId(catalogVersionId))
  const base = document.row.base_catalog_version_id
    ? await loadCatalogDocument(db, document.row.base_catalog_version_id).catch(() => null)
    : null
  return buildCatalogDetail(document, base, activeCatalogVersionId)
}

export async function createAdminAppMembershipCatalog(
  db: D1Database,
  adminId: number,
  idempotencyKey: string | null,
  input: CreateAdminMembershipCatalogInput,
  activeCatalogVersionId: string | null,
): Promise<{ catalog: AdminMembershipCatalogDetail; replayed: boolean }> {
  const actor = await requireActiveAdmin(db, adminId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const baseCatalogVersionId = normalizeCatalogId(input.baseCatalogVersionId)
  const normalized = {
    baseCatalogVersionId,
    versionCode: normalizeVersionCode(input.versionCode),
    effectiveAt: normalizeIsoDate(input.effectiveAt, 'effectiveAt'),
    timezone: normalizeTimezone(input.timezone),
    minimumClientVersion: normalizeClientVersion(input.minimumClientVersion),
    changeSummary: requiredText(input.changeSummary, 'changeSummary', 2, 500),
  }
  const requestHash = await sha256Hex(JSON.stringify(normalized))
  const replay = await findCommand(db, adminId, key)
  if (replay) return resolveCommandReplay(db, replay, 'create_catalog', requestHash, activeCatalogVersionId)

  const baseCatalog = await getAdminAppMembershipCatalog(db, baseCatalogVersionId, activeCatalogVersionId)
  requireCloneableBase(baseCatalog)
  const catalogVersionId = generateId('amc')
  const commandId = generateId('amcc')
  const timestamp = new Date().toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_membership_catalog_versions (
          id, version_code, state, production_ready, effective_at, timezone,
          minimum_client_version, created_at
        )
        SELECT ?, ?, 'development', 0, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM app_membership_catalog_versions base
          JOIN app_membership_catalog_metadata base_metadata
            ON base_metadata.catalog_version_id = base.id
          WHERE base.id = ?
            AND NOT EXISTS (
              SELECT 1 FROM app_membership_catalog_publish_requests request
              WHERE request.catalog_version_id = base.id AND request.status = 'pending_review'
            )
            AND (
              base.state <> 'development'
              OR base.id = ?
              OR EXISTS (
                SELECT 1 FROM app_membership_grants grant_row
                WHERE grant_row.catalog_version_id = base.id
              )
              OR EXISTS (
                SELECT 1 FROM app_membership_applications application
                WHERE application.catalog_version_id = base.id
              )
              OR EXISTS (
                SELECT 1 FROM app_membership_catalog_metadata child
                WHERE child.base_catalog_version_id = base.id
              )
            )
        )
      `).bind(
        catalogVersionId,
        normalized.versionCode,
        normalized.effectiveAt,
        normalized.timezone,
        normalized.minimumClientVersion,
        timestamp,
        baseCatalogVersionId,
        activeCatalogVersionId,
      ),
      db.prepare(`
        INSERT INTO app_membership_catalog_metadata (
          catalog_version_id, base_catalog_version_id, lock_version, change_summary,
          production_decision_status, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, 1, ?, 'unresolved', ?, ?, ?, ?)
      `).bind(
        catalogVersionId,
        baseCatalogVersionId,
        normalized.changeSummary,
        actor.id,
        actor.id,
        timestamp,
        timestamp,
      ),
      db.prepare(`
        INSERT INTO app_membership_tiers (
          catalog_version_id, tier_id, code, display_name, tagline, rank,
          accent_token, acquisition_label, service_disclosure, sort_order
        )
        SELECT ?, tier_id, code, display_name, tagline, rank,
               accent_token, acquisition_label, service_disclosure, sort_order
        FROM app_membership_tiers
        WHERE catalog_version_id = ?
      `).bind(catalogVersionId, baseCatalogVersionId),
      db.prepare(`
        INSERT INTO app_entitlement_definitions (
          catalog_version_id, entitlement_key, schema_version, value_type,
          default_value_json, merge_strategy, period_rule, client_capability,
          display_name, description, unit_label
        )
        SELECT ?, entitlement_key, schema_version, value_type,
               default_value_json, merge_strategy, period_rule, client_capability,
               display_name, description, unit_label
        FROM app_entitlement_definitions
        WHERE catalog_version_id = ?
      `).bind(catalogVersionId, baseCatalogVersionId),
      db.prepare(`
        INSERT INTO app_membership_tier_entitlements (
          catalog_version_id, tier_id, entitlement_key, value_json, availability
        )
        SELECT ?, tier_id, entitlement_key, value_json, availability
        FROM app_membership_tier_entitlements
        WHERE catalog_version_id = ?
      `).bind(catalogVersionId, baseCatalogVersionId),
      db.prepare(`
        INSERT INTO app_membership_catalog_commands (
          id, admin_id, idempotency_key, operation, request_hash,
          catalog_version_id, result_lock_version, created_at
        ) VALUES (?, ?, ?, 'create_catalog', ?, ?, 1, ?)
      `).bind(commandId, actor.id, key, requestHash, catalogVersionId, timestamp),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        ) VALUES (?, ?, 'app.membership.catalog.create', 'app_membership_catalog', ?, ?, ?, ?)
      `).bind(
        generateId('audit'),
        actor.id,
        catalogVersionId,
        JSON.stringify({ baseCatalogVersionId }),
        JSON.stringify({
          versionCode: normalized.versionCode,
          effectiveAt: normalized.effectiveAt,
          productionReady: false,
          lockVersion: 1,
        }),
        timestamp,
      ),
    ])
  }
  catch (error) {
    const raced = await findCommand(db, adminId, key)
    if (raced) return resolveCommandReplay(db, raced, 'create_catalog', requestHash, activeCatalogVersionId)
    const currentBase = await getAdminAppMembershipCatalog(db, baseCatalogVersionId, activeCatalogVersionId)
    requireCloneableBase(currentBase)
    if (await findCatalogByVersionCode(db, normalized.versionCode)) {
      throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_VERSION_EXISTS', '目录版本号已存在')
    }
    throw error
  }
  return {
    catalog: await getAdminAppMembershipCatalog(db, catalogVersionId, activeCatalogVersionId),
    replayed: false,
  }
}

export async function updateAdminAppMembershipCatalog(
  db: D1Database,
  catalogVersionId: string,
  adminId: number,
  idempotencyKey: string | null,
  input: UpdateAdminMembershipCatalogInput,
  activeCatalogVersionId: string | null,
): Promise<{ catalog: AdminMembershipCatalogDetail; replayed: boolean }> {
  const actor = await requireActiveAdmin(db, adminId)
  const id = normalizeCatalogId(catalogVersionId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const current = await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId)
  const normalized = {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
    versionCode: normalizeVersionCode(input.versionCode),
    effectiveAt: normalizeIsoDate(input.effectiveAt, 'effectiveAt'),
    timezone: normalizeTimezone(input.timezone),
    minimumClientVersion: normalizeClientVersion(input.minimumClientVersion),
    changeSummary: requiredText(input.changeSummary, 'changeSummary', 2, 500),
  }
  const requestHash = await sha256Hex(JSON.stringify({ catalogVersionId: id, ...normalized }))
  const replay = await findCommand(db, actor.id, key)
  if (replay) return resolveCommandReplay(db, replay, 'update_catalog', requestHash, activeCatalogVersionId)
  requireEditable(current)
  let replayed = false
  try {
    replayed = await executeDraftMutation(
      db,
      current,
      actor,
      key,
      'update_catalog',
      requestHash,
      normalized.changeSummary,
      [
        db.prepare(`
          UPDATE app_membership_catalog_versions
          SET version_code = ?, effective_at = ?, timezone = ?, minimum_client_version = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM app_membership_catalog_metadata metadata
              WHERE metadata.catalog_version_id = app_membership_catalog_versions.id
                AND metadata.mutation_token = ?
            )
        `).bind(
          normalized.versionCode,
          normalized.effectiveAt,
          normalized.timezone,
          normalized.minimumClientVersion,
          id,
          currentMutationToken(current, key),
        ),
      ],
      {
        versionCode: current.versionCode,
        effectiveAt: current.effectiveAt,
        timezone: current.timezone,
        minimumClientVersion: current.minimumClientVersion,
        lockVersion: current.lockVersion,
      },
      {
        versionCode: normalized.versionCode,
        effectiveAt: normalized.effectiveAt,
        timezone: normalized.timezone,
        minimumClientVersion: normalized.minimumClientVersion,
        lockVersion: current.lockVersion + 1,
      },
      normalized.expectedVersion,
    )
  }
  catch (error) {
    if (normalized.versionCode !== current.versionCode
      && await findCatalogByVersionCode(db, normalized.versionCode)) {
      throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_VERSION_EXISTS', '目录版本号已存在')
    }
    throw error
  }
  return {
    catalog: await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId),
    replayed,
  }
}

export async function replaceAdminAppMembershipCatalogTiers(
  db: D1Database,
  catalogVersionId: string,
  adminId: number,
  idempotencyKey: string | null,
  input: ReplaceAdminMembershipCatalogTiersInput,
  activeCatalogVersionId: string | null,
): Promise<{ catalog: AdminMembershipCatalogDetail; replayed: boolean }> {
  const actor = await requireActiveAdmin(db, adminId)
  const id = normalizeCatalogId(catalogVersionId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const current = await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const changeSummary = requiredText(input.changeSummary, 'changeSummary', 2, 500)
  const tiers = normalizeTierList(input.tiers, current.tiers)
  const requestHash = await sha256Hex(JSON.stringify({ catalogVersionId: id, expectedVersion, tiers, changeSummary }))
  const replay = await findCommand(db, actor.id, key)
  if (replay) return resolveCommandReplay(db, replay, 'replace_tiers', requestHash, activeCatalogVersionId)
  requireEditable(current)

  const mutationToken = currentMutationToken(current, key)
  const guardedStatements = [
    db.prepare(`
      DELETE FROM app_membership_tier_entitlements
      WHERE catalog_version_id = ?
        AND EXISTS (
          SELECT 1 FROM app_membership_catalog_metadata metadata
          WHERE metadata.catalog_version_id = ? AND metadata.mutation_token = ?
        )
    `).bind(id, id, mutationToken),
    db.prepare(`
      DELETE FROM app_membership_tiers
      WHERE catalog_version_id = ?
        AND EXISTS (
          SELECT 1 FROM app_membership_catalog_metadata metadata
          WHERE metadata.catalog_version_id = ? AND metadata.mutation_token = ?
        )
    `).bind(id, id, mutationToken),
    ...tiers.map(tier => db.prepare(`
      INSERT INTO app_membership_tiers (
        catalog_version_id, tier_id, code, display_name, tagline, rank,
        accent_token, acquisition_label, service_disclosure, sort_order
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM app_membership_catalog_metadata metadata
        WHERE metadata.catalog_version_id = ? AND metadata.mutation_token = ?
      )
    `).bind(
      id,
      tier.tierId,
      tier.code,
      tier.displayName,
      tier.tagline,
      tier.rank,
      tier.accentToken,
      tier.acquisitionLabel,
      tier.serviceDisclosure,
      tier.sortOrder,
      id,
      mutationToken,
    )),
    ...current.definitions.flatMap(definition => definition.values.map(value => db.prepare(`
      INSERT INTO app_membership_tier_entitlements (
        catalog_version_id, tier_id, entitlement_key, value_json, availability
      )
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM app_membership_catalog_metadata metadata
        WHERE metadata.catalog_version_id = ? AND metadata.mutation_token = ?
      )
    `).bind(
      id,
      value.tierId,
      definition.key,
      JSON.stringify(value.value),
      value.availability,
      id,
      mutationToken,
    ))),
  ]
  const replayed = await executeDraftMutation(
    db,
    current,
    actor,
    key,
    'replace_tiers',
    requestHash,
    changeSummary,
    guardedStatements,
    { tiers: current.tiers.map(tier => ({ tierId: tier.tierId, rank: tier.rank, displayName: tier.displayName })) },
    { tiers: tiers.map(tier => ({ tierId: tier.tierId, rank: tier.rank, displayName: tier.displayName })) },
    expectedVersion,
  )
  return {
    catalog: await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId),
    replayed,
  }
}

export async function upsertAdminAppMembershipEntitlement(
  db: D1Database,
  catalogVersionId: string,
  entitlementKey: string,
  adminId: number,
  idempotencyKey: string | null,
  input: UpsertAdminMembershipEntitlementInput,
  activeCatalogVersionId: string | null,
): Promise<{ catalog: AdminMembershipCatalogDetail; replayed: boolean }> {
  const actor = await requireActiveAdmin(db, adminId)
  const id = normalizeCatalogId(catalogVersionId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const stableKey = normalizeEntitlementKey(entitlementKey)
  const current = await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId)
  const definition = normalizeEntitlementInput(input, stableKey, current)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const changeSummary = requiredText(input.changeSummary, 'changeSummary', 2, 500)
  const normalized = { expectedVersion, ...definition, changeSummary }
  const requestHash = await sha256Hex(JSON.stringify({ catalogVersionId: id, ...normalized }))
  const replay = await findCommand(db, actor.id, key)
  if (replay) return resolveCommandReplay(db, replay, 'upsert_entitlement', requestHash, activeCatalogVersionId)
  requireEditable(current)

  const mutationToken = currentMutationToken(current, key)
  const statements = [
    db.prepare(`
      INSERT INTO app_entitlement_definitions (
        catalog_version_id, entitlement_key, schema_version, value_type,
        default_value_json, merge_strategy, period_rule, client_capability,
        display_name, description, unit_label
      )
      SELECT ?, ?, ?, ?, ?, 'highest_rank', ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM app_membership_catalog_metadata metadata
        WHERE metadata.catalog_version_id = ? AND metadata.mutation_token = ?
      )
      ON CONFLICT(catalog_version_id, entitlement_key) DO UPDATE SET
        schema_version = excluded.schema_version,
        value_type = excluded.value_type,
        default_value_json = excluded.default_value_json,
        merge_strategy = excluded.merge_strategy,
        period_rule = excluded.period_rule,
        client_capability = excluded.client_capability,
        display_name = excluded.display_name,
        description = excluded.description,
        unit_label = excluded.unit_label
    `).bind(
      id,
      stableKey,
      definition.schemaVersion,
      definition.valueType,
      JSON.stringify(definition.defaultValue),
      definition.periodRule,
      definition.clientCapability,
      definition.displayName,
      definition.description,
      definition.unitLabel,
      id,
      mutationToken,
    ),
    db.prepare(`
      DELETE FROM app_membership_tier_entitlements
      WHERE catalog_version_id = ? AND entitlement_key = ?
        AND EXISTS (
          SELECT 1 FROM app_membership_catalog_metadata metadata
          WHERE metadata.catalog_version_id = ? AND metadata.mutation_token = ?
        )
    `).bind(id, stableKey, id, mutationToken),
    ...definition.values.map(value => db.prepare(`
      INSERT INTO app_membership_tier_entitlements (
        catalog_version_id, tier_id, entitlement_key, value_json, availability
      )
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM app_membership_catalog_metadata metadata
        WHERE metadata.catalog_version_id = ? AND metadata.mutation_token = ?
      )
    `).bind(
      id,
      value.tierId,
      stableKey,
      JSON.stringify(value.value),
      value.availability,
      id,
      mutationToken,
    )),
  ]
  const before = current.definitions.find(item => item.key === stableKey) ?? null
  const replayed = await executeDraftMutation(
    db,
    current,
    actor,
    key,
    'upsert_entitlement',
    requestHash,
    changeSummary,
    statements,
    before ? summarizeDefinition(before) : null,
    summarizeDefinition(definition),
    expectedVersion,
    'app.membership.entitlement.upsert',
    `app_membership_entitlement:${stableKey}`,
  )
  return {
    catalog: await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId),
    replayed,
  }
}

export async function compareAdminAppMembershipCatalogs(
  db: D1Database,
  catalogVersionId: string,
  baseCatalogVersionId?: unknown,
): Promise<AdminMembershipCatalogComparison> {
  const current = await loadCatalogDocument(db, normalizeCatalogId(catalogVersionId))
  const baseId = baseCatalogVersionId
    ? normalizeCatalogId(baseCatalogVersionId)
    : current.row.base_catalog_version_id
  if (!baseId) {
    throw new AppMembershipError(400, 'MEMBERSHIP_CATALOG_BASE_REQUIRED', '该目录没有基线版本，请选择比较目录')
  }
  const base = await loadCatalogDocument(db, baseId)
  return compareDocuments(current, base)
}

export async function getAdminAppMembershipEntitlementImpact(
  db: D1Database,
  catalogVersionId: string,
  entitlementKey: string,
  activeCatalogVersionId: string | null,
  now = new Date(),
) {
  const id = normalizeCatalogId(catalogVersionId)
  const key = normalizeEntitlementKey(entitlementKey)
  const document = await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId)
  const definition = document.definitions.find(item => item.key === key)
  if (!definition) {
    throw new AppMembershipError(404, 'MEMBERSHIP_ENTITLEMENT_NOT_FOUND', 'Entitlement 定义不存在')
  }
  const grantCounts = await db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE
        WHEN grant.starts_at <= ? AND grant.expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM app_membership_grant_revocations revocation
            WHERE revocation.grant_id = grant.id
          )
        THEN 1 ELSE 0 END
      ) AS active
    FROM app_membership_grants grant
    WHERE grant.catalog_version_id = ?
  `).bind(now.toISOString(), now.toISOString(), id).first<{ total: number; active: number }>()
  const baseDefinition = document.baseCatalogVersionId
    ? (await getAdminAppMembershipCatalog(db, document.baseCatalogVersionId, activeCatalogVersionId))
        .definitions.find(item => item.key === key) ?? null
    : null
  return {
    catalogVersionId: id,
    entitlement: definition,
    dependencies: SERVER_DEPENDENCIES[key] ?? ['尚无服务端执行依赖登记'],
    knownClientCapability: KNOWN_APP_CAPABILITIES.has(definition.clientCapability),
    affectedTierCount: definition.values.length,
    availableTierCount: definition.values.filter(item => item.availability === 'available').length,
    grants: {
      total: Number(grantCounts?.total ?? 0),
      active: Number(grantCounts?.active ?? 0),
    },
    activeRuntimeReference: id === activeCatalogVersionId,
    baseDifference: baseDefinition
      ? compareDefinition(definition, baseDefinition)
      : null,
  }
}

export async function submitAdminAppMembershipCatalogPublish(
  db: D1Database,
  catalogVersionId: string,
  adminId: number,
  idempotencyKey: string | null,
  input: SubmitAdminMembershipCatalogPublishInput,
  activeCatalogVersionId: string | null,
): Promise<{ request: AdminMembershipCatalogPublishRequest; replayed: boolean }> {
  const actor = await requireActiveAdmin(db, adminId)
  const id = normalizeCatalogId(catalogVersionId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const normalized = {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
    productionReady: optionalBoolean(input.productionReady, false),
    submitNote: requiredText(input.submitNote, 'submitNote', 2, 500),
  }
  const requestHash = await sha256Hex(JSON.stringify({ catalogVersionId: id, ...normalized }))
  const replay = await findPublishRequestByRequesterKey(db, actor.id, key)
  if (replay) {
    if (replay.request_hash !== requestHash || replay.catalog_version_id !== id) throw idempotencyConflict()
    return {
      request: await getAdminAppMembershipCatalogPublishRequest(db, replay.id, actor.id, activeCatalogVersionId),
      replayed: true,
    }
  }
  if (await findCommand(db, actor.id, key)) throw idempotencyConflict()
  const catalog = await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId)
  requireEditable(catalog)
  if (catalog.lockVersion !== normalized.expectedVersion) throw versionConflict()
  if (!catalog.validation.canSubmitPublish) {
    throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_VALIDATION_FAILED', '目录仍有阻断问题，不能提交发布复核')
  }
  if (normalized.productionReady && !catalog.validation.canMarkProductionReady) {
    throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_PRODUCTION_NOT_READY', '生产决策或兼容性门禁尚未关闭')
  }
  const activeRequest = await findActivePublishRequest(db, id)
  if (activeRequest) {
    throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_REVIEW_PENDING', '该目录已有待复核发布申请')
  }
  const requestId = generateId('amcpr')
  const timestamp = new Date().toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_membership_catalog_publish_requests (
          id, catalog_version_id, catalog_lock_version, content_hash,
          requested_production_ready, validation_report_json, submit_note,
          status, version, request_idempotency_key, request_hash,
          requested_by, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 'pending_review', 1, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM app_membership_catalog_metadata metadata
          JOIN app_membership_catalog_versions catalog
            ON catalog.id = metadata.catalog_version_id
          WHERE metadata.catalog_version_id = ?
            AND metadata.lock_version = ?
            AND catalog.state = 'development'
            AND NOT EXISTS (
              SELECT 1 FROM app_membership_grants grant_row
              WHERE grant_row.catalog_version_id = catalog.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM app_membership_applications application
              WHERE application.catalog_version_id = catalog.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM app_membership_catalog_metadata child
              WHERE child.base_catalog_version_id = catalog.id
            )
        )
      `).bind(
        requestId,
        id,
        catalog.lockVersion,
        catalog.contentHash,
        normalized.productionReady ? 1 : 0,
        JSON.stringify(catalog.validation),
        normalized.submitNote,
        key,
        requestHash,
        actor.id,
        timestamp,
        timestamp,
        id,
        catalog.lockVersion,
      ),
      db.prepare(`
        INSERT INTO app_membership_catalog_publish_events (
          id, request_id, sequence, event_type, actor_id, result_code, created_at
        ) VALUES (?, ?, 1, 'submitted', ?, 'pending_review', ?)
      `).bind(generateId('amcpe'), requestId, actor.id, timestamp),
      db.prepare(`
        INSERT INTO app_membership_catalog_commands (
          id, admin_id, idempotency_key, operation, request_hash,
          catalog_version_id, result_lock_version, created_at
        ) VALUES (?, ?, ?, 'submit_publish', ?, ?, ?, ?)
      `).bind(generateId('amcc'), actor.id, key, requestHash, id, catalog.lockVersion, timestamp),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        ) VALUES (?, ?, 'app.membership.catalog.publish.request', 'app_membership_catalog_publish_request', ?, ?, ?, ?)
      `).bind(
        generateId('audit'),
        actor.id,
        requestId,
        JSON.stringify({ state: catalog.state, lockVersion: catalog.lockVersion }),
        JSON.stringify({
          catalogVersionId: id,
          contentHash: catalog.contentHash,
          requestedProductionReady: normalized.productionReady,
          submitNoteLength: Array.from(normalized.submitNote).length,
          status: 'pending_review',
        }),
        timestamp,
      ),
    ])
  }
  catch (error) {
    const raced = await findPublishRequestByRequesterKey(db, actor.id, key)
    if (raced) {
      if (raced.request_hash !== requestHash || raced.catalog_version_id !== id) throw idempotencyConflict()
      return {
        request: await getAdminAppMembershipCatalogPublishRequest(db, raced.id, actor.id, activeCatalogVersionId),
        replayed: true,
      }
    }
    const latestCatalog = await getAdminAppMembershipCatalog(db, id, activeCatalogVersionId)
    requireEditable(latestCatalog)
    if (latestCatalog.lockVersion !== normalized.expectedVersion) throw versionConflict()
    throw error
  }
  return {
    request: await getAdminAppMembershipCatalogPublishRequest(db, requestId, actor.id, activeCatalogVersionId),
    replayed: false,
  }
}

export async function listAdminAppMembershipCatalogPublishRequests(
  db: D1Database,
  reviewerId: number,
  status: unknown,
  activeCatalogVersionId: string | null,
): Promise<AdminMembershipCatalogPublishRequest[]> {
  const actor = await requireActiveAdmin(db, reviewerId)
  const normalizedStatus = optionalPublishStatus(status)
  const where = normalizedStatus ? 'WHERE request.status = ?' : ''
  const result = await db.prepare(`
    ${publishRequestSelect()}
    ${where}
    ORDER BY CASE request.status WHEN 'pending_review' THEN 0 ELSE 1 END,
             request.created_at ASC, request.id ASC
    LIMIT 100
  `).bind(...(normalizedStatus ? [normalizedStatus] : [])).all<PublishRequestRow>()
  return result.results.map(row => mapPublishRequest(row, actor, activeCatalogVersionId, false))
}

export async function getAdminAppMembershipCatalogPublishRequest(
  db: D1Database,
  requestId: string,
  reviewerId: number,
  activeCatalogVersionId: string | null,
): Promise<AdminMembershipCatalogPublishRequest> {
  const actor = await requireActiveAdmin(db, reviewerId)
  const id = normalizePublishRequestId(requestId)
  const row = await findPublishRequestRow(db, id)
  if (!row) throw new AppMembershipError(404, 'MEMBERSHIP_CATALOG_REVIEW_NOT_FOUND', '目录发布复核申请不存在')
  return mapPublishRequest(row, actor, activeCatalogVersionId, true)
}

export async function reviewAdminAppMembershipCatalogPublish(
  db: D1Database,
  requestId: string,
  reviewerId: number,
  idempotencyKey: string | null,
  input: ReviewAdminMembershipCatalogPublishInput,
  activeCatalogVersionId: string | null,
): Promise<{ request: AdminMembershipCatalogPublishRequest; replayed: boolean }> {
  const actor = await requireActiveOwner(db, reviewerId)
  const id = normalizePublishRequestId(requestId)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const normalized = {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
    decision: normalizeDecision(input.decision),
    reviewNote: requiredText(input.reviewNote, 'reviewNote', 2, 500),
  }
  const requestHash = await sha256Hex(JSON.stringify({ requestId: id, ...normalized }))
  const replay = await findPublishDecision(db, actor.id, key)
  if (replay) {
    if (replay.request_id !== id || replay.request_hash !== requestHash) throw idempotencyConflict()
    if (replay.result_status === 'stale') throw catalogStaleConflict()
    return {
      request: await getAdminAppMembershipCatalogPublishRequest(db, id, actor.id, activeCatalogVersionId),
      replayed: true,
    }
  }
  if (await findCommand(db, actor.id, key)) throw idempotencyConflict()
  const row = await findPublishRequestRow(db, id)
  if (!row) throw new AppMembershipError(404, 'MEMBERSHIP_CATALOG_REVIEW_NOT_FOUND', '目录发布复核申请不存在')
  if (row.requested_by === actor.id || row.created_by === actor.id) {
    throw new AppMembershipError(403, 'MEMBERSHIP_CATALOG_SELF_REVIEW_FORBIDDEN', '目录创建人或发布申请人不能复核自己的目录')
  }
  if (row.request_status !== 'pending_review') {
    throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_ALREADY_REVIEWED', '目录发布申请已被处理')
  }
  if (Number(row.request_version) !== normalized.expectedVersion) throw versionConflict()
  const reviewNoteSha256 = await sha256Hex(normalized.reviewNote)
  try {
    if (normalized.decision === 'reject') {
      await rejectCatalogPublish(db, row, actor, key, requestHash, normalized.reviewNote, reviewNoteSha256)
    }
    else {
      const catalog = await getAdminAppMembershipCatalog(db, row.id, activeCatalogVersionId)
      const stale = catalog.state !== 'development'
        || catalog.lockVersion !== Number(row.catalog_lock_version)
        || catalog.contentHash !== row.request_content_hash
        || catalog.activeRuntimeReference
        || catalog.grantCount > 0
        || catalog.applicationCount > 0
        || catalog.dependentCatalogCount > 0
        || !catalog.validation.canSubmitPublish
        || (row.requested_production_ready === 1 && !catalog.validation.canMarkProductionReady)
      if (stale) {
        await staleCatalogPublish(db, row, actor, key, requestHash, normalized.reviewNote, reviewNoteSha256)
      }
      else {
        await approveCatalogPublish(db, row, catalog, actor, key, requestHash, normalized.reviewNote, reviewNoteSha256)
      }
    }
  }
  catch (error) {
    const raced = await findPublishDecision(db, actor.id, key)
    if (!raced) throw error
    if (raced.request_id !== id || raced.request_hash !== requestHash) throw idempotencyConflict()
    if (raced.result_status === 'stale') throw catalogStaleConflict()
    return {
      request: await getAdminAppMembershipCatalogPublishRequest(db, id, actor.id, activeCatalogVersionId),
      replayed: true,
    }
  }
  const decision = await findPublishDecision(db, actor.id, key)
  if (!decision || decision.request_id !== id || decision.request_hash !== requestHash) {
    throw versionConflict()
  }
  if (decision.result_status === 'stale') throw catalogStaleConflict()
  return {
    request: await getAdminAppMembershipCatalogPublishRequest(db, id, actor.id, activeCatalogVersionId),
    replayed: false,
  }
}

async function executeDraftMutation(
  db: D1Database,
  current: AdminMembershipCatalogDetail,
  actor: AdminActor,
  idempotencyKey: string,
  operation: 'update_catalog' | 'replace_tiers' | 'upsert_entitlement',
  requestHash: string,
  changeSummary: string,
  guardedStatements: D1PreparedStatement[],
  beforeValue: unknown,
  afterValue: unknown,
  expectedVersion = current.lockVersion,
  auditAction = `app.membership.catalog.${operation}`,
  auditTargetId = current.catalogVersionId,
): Promise<boolean> {
  if (expectedVersion !== current.lockVersion) throw versionConflict()
  const mutationToken = currentMutationToken(current, idempotencyKey)
  const timestamp = new Date().toISOString()
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_membership_catalog_metadata AS metadata
        SET lock_version = lock_version + 1,
            change_summary = ?, mutation_token = ?, updated_by = ?, updated_at = ?
        WHERE metadata.catalog_version_id = ? AND metadata.lock_version = ?
          AND EXISTS (
            SELECT 1 FROM app_membership_catalog_versions catalog
            WHERE catalog.id = metadata.catalog_version_id AND catalog.state = 'development'
          )
          AND NOT EXISTS (
            SELECT 1 FROM app_membership_catalog_publish_requests request
            WHERE request.catalog_version_id = metadata.catalog_version_id
              AND request.status = 'pending_review'
          )
      `).bind(
        changeSummary,
        mutationToken,
        actor.id,
        timestamp,
        current.catalogVersionId,
        expectedVersion,
      ),
      ...guardedStatements,
      db.prepare(`
        INSERT INTO app_membership_catalog_commands (
          id, admin_id, idempotency_key, operation, request_hash,
          catalog_version_id, result_lock_version, created_at
        )
        SELECT ?, ?, ?, ?, ?, catalog_version_id, lock_version, ?
        FROM app_membership_catalog_metadata
        WHERE catalog_version_id = ? AND mutation_token = ?
      `).bind(
        generateId('amcc'),
        actor.id,
        idempotencyKey,
        operation,
        requestHash,
        timestamp,
        current.catalogVersionId,
        mutationToken,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, ?, 'app_membership_catalog', ?, ?, ?, ?
        FROM app_membership_catalog_metadata
        WHERE catalog_version_id = ? AND mutation_token = ?
      `).bind(
        generateId('audit'),
        actor.id,
        auditAction,
        auditTargetId,
        JSON.stringify(beforeValue),
        JSON.stringify(afterValue),
        timestamp,
        current.catalogVersionId,
        mutationToken,
      ),
    ])
  }
  catch (error) {
    const raced = await findCommand(db, actor.id, idempotencyKey)
    if (raced) {
      if (raced.operation !== operation || raced.request_hash !== requestHash) throw idempotencyConflict()
      return true
    }
    throw error
  }
  const command = await findCommand(db, actor.id, idempotencyKey)
  if (!command) {
    const pending = await findActivePublishRequest(db, current.catalogVersionId)
    if (pending) {
      throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_REVIEW_PENDING', '目录已提交发布复核，当前草稿已锁定')
    }
    throw versionConflict()
  }
  return false
}

async function approveCatalogPublish(
  db: D1Database,
  row: PublishRequestRow,
  catalog: AdminMembershipCatalogDetail,
  actor: AdminActor,
  idempotencyKey: string,
  requestHash: string,
  reviewNote: string,
  reviewNoteSha256: string,
) {
  const timestamp = new Date().toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_membership_catalog_versions AS catalog
      SET state = 'published', production_ready = ?
      WHERE catalog.id = ? AND catalog.state = 'development'
        AND EXISTS (
          SELECT 1 FROM app_membership_catalog_metadata metadata
          WHERE metadata.catalog_version_id = catalog.id
            AND metadata.lock_version = ?
            AND (metadata.created_by IS NULL OR metadata.created_by <> ?)
        )
        AND EXISTS (
          SELECT 1 FROM app_membership_catalog_publish_requests request
          WHERE request.id = ? AND request.status = 'pending_review'
            AND request.version = ? AND request.requested_by <> ?
            AND request.content_hash = ?
        )
        AND EXISTS (
          SELECT 1 FROM users reviewer
          WHERE reviewer.id = ? AND reviewer.status = 'active' AND reviewer.role = 'owner'
        )
        AND NOT EXISTS (
          SELECT 1 FROM app_membership_grants grant_row
          WHERE grant_row.catalog_version_id = catalog.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app_membership_applications application
          WHERE application.catalog_version_id = catalog.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app_membership_catalog_metadata child
          WHERE child.base_catalog_version_id = catalog.id
        )
    `).bind(
      row.requested_production_ready,
      row.id,
      row.catalog_lock_version,
      actor.id,
      row.request_id,
      row.request_version,
      actor.id,
      row.request_content_hash,
      actor.id,
    ),
    db.prepare(`
      UPDATE app_membership_catalog_metadata AS metadata
      SET lock_version = lock_version + 1, content_hash = ?, published_by = ?,
          published_at = ?, updated_by = ?, updated_at = ?
      WHERE metadata.catalog_version_id = ? AND metadata.lock_version = ?
        AND EXISTS (
          SELECT 1 FROM app_membership_catalog_versions catalog
          WHERE catalog.id = metadata.catalog_version_id AND catalog.state = 'published'
            AND catalog.production_ready = ?
        )
    `).bind(
      catalog.contentHash,
      actor.id,
      timestamp,
      actor.id,
      timestamp,
      row.id,
      row.catalog_lock_version,
      row.requested_production_ready,
    ),
    db.prepare(`
      UPDATE app_membership_catalog_publish_requests AS request
      SET status = 'approved', version = version + 1, reviewed_by = ?,
          review_note = ?, review_note_sha256 = ?, reviewed_at = ?, updated_at = ?
      WHERE request.id = ? AND request.status = 'pending_review' AND request.version = ?
        AND EXISTS (
          SELECT 1 FROM app_membership_catalog_metadata metadata
          WHERE metadata.catalog_version_id = request.catalog_version_id
            AND metadata.published_by = ? AND metadata.content_hash = request.content_hash
        )
    `).bind(
      actor.id,
      reviewNote,
      reviewNoteSha256,
      timestamp,
      timestamp,
      row.request_id,
      row.request_version,
      actor.id,
    ),
    db.prepare(`
      INSERT INTO app_membership_catalog_publish_events (
        id, request_id, sequence, event_type, actor_id, result_code, created_at
      )
      SELECT ?, id, version, 'approved', ?, 'approved', ?
      FROM app_membership_catalog_publish_requests
      WHERE id = ? AND status = 'approved' AND reviewed_by = ?
    `).bind(generateId('amcpe'), actor.id, timestamp, row.request_id, actor.id),
    db.prepare(`
      INSERT INTO app_membership_catalog_publish_decisions (
        id, request_id, reviewer_id, decision, idempotency_key,
        request_hash, result_status, created_at
      )
      SELECT ?, id, ?, 'approve', ?, ?, 'approved', ?
      FROM app_membership_catalog_publish_requests
      WHERE id = ? AND status = 'approved' AND reviewed_by = ?
    `).bind(
      generateId('amcpd'),
      actor.id,
      idempotencyKey,
      requestHash,
      timestamp,
      row.request_id,
      actor.id,
    ),
    db.prepare(`
      INSERT INTO app_membership_catalog_commands (
        id, admin_id, idempotency_key, operation, request_hash,
        catalog_version_id, result_lock_version, created_at
      )
      SELECT ?, ?, ?, 'decide_publish', ?, catalog_version_id, ?, ?
      FROM app_membership_catalog_publish_requests
      WHERE id = ? AND status = 'approved' AND reviewed_by = ?
    `).bind(
      generateId('amcc'),
      actor.id,
      idempotencyKey,
      requestHash,
      Number(row.catalog_lock_version) + 1,
      timestamp,
      row.request_id,
      actor.id,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.membership.catalog.publish.approve',
             'app_membership_catalog_publish_request', id, ?, ?, ?
      FROM app_membership_catalog_publish_requests
      WHERE id = ? AND status = 'approved' AND reviewed_by = ?
    `).bind(
      generateId('audit'),
      actor.id,
      JSON.stringify({ status: 'pending_review', version: row.request_version }),
      JSON.stringify({
        status: 'approved',
        catalogVersionId: row.id,
        contentHash: row.request_content_hash,
        productionReady: row.requested_production_ready === 1,
        reviewNoteSha256,
        reviewNoteLength: Array.from(reviewNote).length,
      }),
      timestamp,
      row.request_id,
      actor.id,
    ),
  ])
}

async function rejectCatalogPublish(
  db: D1Database,
  row: PublishRequestRow,
  actor: AdminActor,
  idempotencyKey: string,
  requestHash: string,
  reviewNote: string,
  reviewNoteSha256: string,
) {
  await completePublishWithoutCatalogMutation(
    db,
    row,
    actor,
    idempotencyKey,
    requestHash,
    reviewNote,
    reviewNoteSha256,
    'rejected',
    'rejected',
    'reject',
  )
}

async function staleCatalogPublish(
  db: D1Database,
  row: PublishRequestRow,
  actor: AdminActor,
  idempotencyKey: string,
  requestHash: string,
  reviewNote: string,
  reviewNoteSha256: string,
) {
  await completePublishWithoutCatalogMutation(
    db,
    row,
    actor,
    idempotencyKey,
    requestHash,
    reviewNote,
    reviewNoteSha256,
    'stale',
    'content_stale',
    'approve',
  )
}

async function completePublishWithoutCatalogMutation(
  db: D1Database,
  row: PublishRequestRow,
  actor: AdminActor,
  idempotencyKey: string,
  requestHash: string,
  reviewNote: string,
  reviewNoteSha256: string,
  status: 'rejected' | 'stale',
  eventType: 'rejected' | 'content_stale',
  decision: 'approve' | 'reject',
) {
  const timestamp = new Date().toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_membership_catalog_publish_requests
      SET status = ?, version = version + 1, reviewed_by = ?, review_note = ?,
          review_note_sha256 = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_review' AND version = ?
        AND requested_by <> ?
        AND EXISTS (
          SELECT 1 FROM users reviewer
          WHERE reviewer.id = ? AND reviewer.status = 'active' AND reviewer.role = 'owner'
        )
        AND EXISTS (
          SELECT 1 FROM app_membership_catalog_metadata metadata
          WHERE metadata.catalog_version_id = app_membership_catalog_publish_requests.catalog_version_id
            AND (metadata.created_by IS NULL OR metadata.created_by <> ?)
        )
    `).bind(
      status,
      actor.id,
      reviewNote,
      reviewNoteSha256,
      timestamp,
      timestamp,
      row.request_id,
      row.request_version,
      actor.id,
      actor.id,
      actor.id,
    ),
    db.prepare(`
      INSERT INTO app_membership_catalog_publish_events (
        id, request_id, sequence, event_type, actor_id, result_code, created_at
      )
      SELECT ?, id, version, ?, ?, ?, ?
      FROM app_membership_catalog_publish_requests
      WHERE id = ? AND status = ? AND reviewed_by = ?
    `).bind(
      generateId('amcpe'),
      eventType,
      actor.id,
      eventType,
      timestamp,
      row.request_id,
      status,
      actor.id,
    ),
    db.prepare(`
      INSERT INTO app_membership_catalog_publish_decisions (
        id, request_id, reviewer_id, decision, idempotency_key,
        request_hash, result_status, created_at
      )
      SELECT ?, id, ?, ?, ?, ?, ?, ?
      FROM app_membership_catalog_publish_requests
      WHERE id = ? AND status = ? AND reviewed_by = ?
    `).bind(
      generateId('amcpd'),
      actor.id,
      decision,
      idempotencyKey,
      requestHash,
      status,
      timestamp,
      row.request_id,
      status,
      actor.id,
    ),
    db.prepare(`
      INSERT INTO app_membership_catalog_commands (
        id, admin_id, idempotency_key, operation, request_hash,
        catalog_version_id, result_lock_version, created_at
      )
      SELECT ?, ?, ?, 'decide_publish', ?, catalog_version_id, catalog_lock_version, ?
      FROM app_membership_catalog_publish_requests
      WHERE id = ? AND status = ? AND reviewed_by = ?
    `).bind(
      generateId('amcc'),
      actor.id,
      idempotencyKey,
      requestHash,
      timestamp,
      row.request_id,
      status,
      actor.id,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, ?, 'app_membership_catalog_publish_request', id, ?, ?, ?
      FROM app_membership_catalog_publish_requests
      WHERE id = ? AND status = ? AND reviewed_by = ?
    `).bind(
      generateId('audit'),
      actor.id,
      status === 'rejected'
        ? 'app.membership.catalog.publish.reject'
        : 'app.membership.catalog.publish.stale',
      JSON.stringify({ status: 'pending_review', version: row.request_version }),
      JSON.stringify({
        status,
        contentHash: row.request_content_hash,
        reviewNoteSha256,
        reviewNoteLength: Array.from(reviewNote).length,
      }),
      timestamp,
      row.request_id,
      status,
      actor.id,
    ),
  ])
}

async function loadCatalogDocument(db: D1Database, catalogVersionId: string): Promise<CatalogDocument> {
  const row = await db.prepare(`
    SELECT ${CATALOG_FIELDS}
    FROM app_membership_catalog_versions catalog
    JOIN app_membership_catalog_metadata metadata ON metadata.catalog_version_id = catalog.id
    WHERE catalog.id = ?
    LIMIT 1
  `).bind(catalogVersionId).first<CatalogRow>()
  if (!row) throw new AppMembershipError(404, 'MEMBERSHIP_CATALOG_NOT_FOUND', '会员目录版本不存在')
  const [tierResult, definitionResult, valueResult] = await Promise.all([
    db.prepare(`
      SELECT tier_id, code, display_name, tagline, rank, accent_token,
             acquisition_label, service_disclosure, sort_order
      FROM app_membership_tiers
      WHERE catalog_version_id = ?
      ORDER BY sort_order ASC, tier_id ASC
    `).bind(catalogVersionId).all<TierRow>(),
    db.prepare(`
      SELECT entitlement_key, schema_version, value_type, default_value_json,
             merge_strategy, period_rule, client_capability, display_name,
             description, unit_label
      FROM app_entitlement_definitions
      WHERE catalog_version_id = ?
      ORDER BY entitlement_key ASC
    `).bind(catalogVersionId).all<DefinitionRow>(),
    db.prepare(`
      SELECT tier_id, entitlement_key, value_json, availability
      FROM app_membership_tier_entitlements
      WHERE catalog_version_id = ?
      ORDER BY entitlement_key ASC, tier_id ASC
    `).bind(catalogVersionId).all<ValueRow>(),
  ])
  const values = new Map<string, AdminMembershipTierEntitlementValue[]>()
  for (const item of valueResult.results) {
    const list = values.get(item.entitlement_key) ?? []
    list.push({
      tierId: item.tier_id,
      value: parseStoredValue(item.value_json),
      availability: item.availability === 'available' ? 'available' : 'planned',
    })
    values.set(item.entitlement_key, list)
  }
  return {
    row,
    tiers: tierResult.results.map(item => ({
      tierId: item.tier_id,
      code: item.code,
      displayName: item.display_name,
      tagline: item.tagline,
      rank: Number(item.rank),
      accentToken: item.accent_token,
      acquisitionLabel: item.acquisition_label,
      serviceDisclosure: item.service_disclosure,
      sortOrder: Number(item.sort_order),
    })),
    definitions: definitionResult.results.map(item => ({
      key: item.entitlement_key,
      schemaVersion: Number(item.schema_version),
      valueType: normalizeStoredValueType(item.value_type),
      defaultValue: parseStoredValue(item.default_value_json),
      mergeStrategy: 'highest_rank',
      periodRule: item.period_rule,
      clientCapability: item.client_capability,
      displayName: item.display_name,
      description: item.description,
      unitLabel: item.unit_label,
      values: (values.get(item.entitlement_key) ?? []).sort((a, b) => a.tierId.localeCompare(b.tierId)),
    })),
  }
}

async function buildCatalogDetail(
  document: CatalogDocument,
  base: CatalogDocument | null,
  activeCatalogVersionId: string | null,
): Promise<AdminMembershipCatalogDetail> {
  const contentHash = await hashDocument(document)
  const validation = validateDocument(document, base, contentHash)
  return {
    ...mapCatalogSummary(document.row, activeCatalogVersionId),
    tierCount: document.tiers.length,
    entitlementCount: document.definitions.length,
    contentHash,
    tiers: document.tiers,
    definitions: document.definitions,
    validation,
  }
}

function validateDocument(
  document: CatalogDocument,
  base: CatalogDocument | null,
  computedContentHash: string,
): AdminMembershipCatalogValidation {
  const issues: AdminMembershipCatalogValidationIssue[] = []
  const add = (code: string, severity: AdminMembershipCatalogIssueSeverity, scope: string, message: string) => {
    issues.push({ code, severity, scope, message })
  }
  if (document.row.state !== 'development' && document.row.content_hash !== computedContentHash) {
    add('PUBLISHED_CONTENT_HASH_MISMATCH', 'error', 'catalog', '不可变目录内容与发布哈希不一致，必须停止使用并人工核查。')
  }
  if (document.tiers.length !== 5) {
    add('TIER_COUNT_INVALID', 'error', 'tiers', 'App 1.0 目录必须恰好包含五个可发放等级。')
  }
  const ranks = document.tiers.map(item => item.rank)
  if (new Set(ranks).size !== ranks.length || ranks.some((rank, index) => index > 0 && rank <= ranks[index - 1]!)) {
    add('TIER_RANK_ORDER_INVALID', 'error', 'tiers', '等级 rank 必须唯一，并按展示顺序严格递增。')
  }
  if (ranks.length === 5 && ranks.some((rank, index) => rank !== [10, 20, 30, 40, 50][index])) {
    add('APP_1_0_RANK_BASELINE_CHANGED', 'warning', 'tiers', 'rank 与 App 1.0 的 10/20/30/40/50 基线不同，需要产品与兼容性确认。')
  }
  if (document.definitions.length === 0) {
    add('ENTITLEMENT_EMPTY', 'error', 'entitlements', '目录至少需要一个 Entitlement 定义。')
  }
  const tierIds = new Set(document.tiers.map(item => item.tierId))
  const definitions = new Map(document.definitions.map(item => [item.key, item]))
  for (const requiredKey of REQUIRED_APP_1_0_ENTITLEMENTS) {
    if (!definitions.has(requiredKey)) {
      add('REQUIRED_ENTITLEMENT_MISSING', 'error', requiredKey, `缺少 App 1.0 稳定能力键 ${requiredKey}。`)
    }
  }
  for (const definition of document.definitions) {
    if (definition.mergeStrategy !== 'highest_rank') {
      add('MERGE_STRATEGY_UNSUPPORTED', 'error', definition.key, '当前服务端只支持 highest_rank 合并策略。')
    }
    if (!isTypedValue(definition.valueType, definition.defaultValue)) {
      add('DEFAULT_VALUE_TYPE_INVALID', 'error', definition.key, '安全默认值与声明类型不一致。')
    }
    if (definition.valueType === 'boolean' && definition.defaultValue !== false) {
      add('BOOLEAN_DEFAULT_NOT_SAFE', 'error', definition.key, '布尔权限的默认值必须为 false，未知客户端才能安全拒绝。')
    }
    if (definition.valueType === 'integer' && definition.defaultValue !== 0) {
      add('INTEGER_DEFAULT_NOT_SAFE', 'error', definition.key, '整数额度的默认值必须为 0。')
    }
    if (definition.valueType === 'enum' && document.row.production_decision_status !== 'approved') {
      add('ENUM_DEFAULT_REVIEW', 'warning', definition.key, '枚举默认值需要产品确认其代表无权限或最低能力。')
    }
    const valueTierIds = new Set(definition.values.map(item => item.tierId))
    if (definition.values.length !== tierIds.size || [...tierIds].some(tierId => !valueTierIds.has(tierId))) {
      add('TIER_VALUE_INCOMPLETE', 'error', definition.key, '每个等级都必须显式配置该 Entitlement 的值和 availability。')
    }
    for (const value of definition.values) {
      if (!tierIds.has(value.tierId)) {
        add('TIER_VALUE_UNKNOWN_TIER', 'error', definition.key, `存在未知等级 ${value.tierId} 的配置。`)
      }
      if (!isTypedValue(definition.valueType, value.value)) {
        add('TIER_VALUE_TYPE_INVALID', 'error', `${definition.key}:${value.tierId}`, '等级值与 Entitlement 类型不一致。')
      }
    }
    const capabilityKnown = KNOWN_APP_CAPABILITIES.has(definition.clientCapability)
    const available = definition.values.some(item => item.availability === 'available')
    if (!capabilityKnown && available) {
      add('UNKNOWN_CLIENT_CAPABILITY_AVAILABLE', 'error', definition.key, '未知客户端 capability 不能标记为 available。')
    }
    else if (!capabilityKnown) {
      add('UNKNOWN_CLIENT_CAPABILITY_PLANNED', 'info', definition.key, '该 capability 尚未进入已部署客户端契约，保持 planned 不会扩大权限。')
    }
    if (REQUIRED_APP_1_0_ENTITLEMENTS.includes(definition.key as typeof REQUIRED_APP_1_0_ENTITLEMENTS[number])
      && definition.values.some(item => item.availability !== 'available')) {
      add('REQUIRED_ENTITLEMENT_PLANNED', 'warning', definition.key, '至少一个等级仍为 planned，不能作为完整生产权益承诺。')
    }
  }
  if (base) {
    const comparison = compareDocuments(document, base)
    for (const removed of comparison.entitlementChanges.filter(item => item.kind === 'removed')) {
      add('ENTITLEMENT_REMOVED', 'warning', removed.key, '基线能力键被移除，需要确认旧客户端的安全默认行为。')
    }
    for (const changed of comparison.entitlementChanges.filter(item => item.kind === 'changed')) {
      const currentDefinition = definitions.get(changed.key)
      const baseDefinition = base.definitions.find(item => item.key === changed.key)
      if (currentDefinition && baseDefinition
        && currentDefinition.valueType !== baseDefinition.valueType
        && currentDefinition.schemaVersion <= baseDefinition.schemaVersion) {
        add('SCHEMA_VERSION_NOT_INCREMENTED', 'error', changed.key, '值类型变化时 schemaVersion 必须递增。')
      }
      if (currentDefinition && baseDefinition && currentDefinition.schemaVersion < baseDefinition.schemaVersion) {
        add('SCHEMA_VERSION_DECREASED', 'error', changed.key, 'schemaVersion 不得低于基线版本。')
      }
    }
  }
  if (document.row.production_decision_status !== 'approved') {
    add('PRODUCTION_DECISION_UNRESOLVED', 'warning', 'catalog', '真实权益值和生产发布决策尚未批准。')
  }
  const order: Record<AdminMembershipCatalogIssueSeverity, number> = { error: 0, warning: 1, info: 2 }
  issues.sort((a, b) => order[a.severity] - order[b.severity]
    || a.scope.localeCompare(b.scope)
    || a.code.localeCompare(b.code))
  const errorCount = issues.filter(item => item.severity === 'error').length
  const warningCount = issues.filter(item => item.severity === 'warning').length
  const infoCount = issues.filter(item => item.severity === 'info').length
  return {
    issues,
    errorCount,
    warningCount,
    infoCount,
    canSubmitPublish: errorCount === 0,
    canMarkProductionReady: errorCount === 0
      && warningCount === 0
      && document.row.production_decision_status === 'approved',
  }
}

function compareDocuments(current: CatalogDocument, base: CatalogDocument): AdminMembershipCatalogComparison {
  const tierChanges: AdminMembershipCatalogComparison['tierChanges'] = []
  const currentTiers = new Map(current.tiers.map(item => [item.tierId, item]))
  const baseTiers = new Map(base.tiers.map(item => [item.tierId, item]))
  for (const tierId of [...new Set([...currentTiers.keys(), ...baseTiers.keys()])].sort()) {
    const next = currentTiers.get(tierId)
    const previous = baseTiers.get(tierId)
    if (!previous) tierChanges.push({ tierId, kind: 'added', fields: ['tier'] })
    else if (!next) tierChanges.push({ tierId, kind: 'removed', fields: ['tier'] })
    else {
      const fields = changedFields(next, previous, [
        'code', 'displayName', 'tagline', 'rank', 'accentToken',
        'acquisitionLabel', 'serviceDisclosure', 'sortOrder',
      ])
      if (fields.length) tierChanges.push({ tierId, kind: 'changed', fields })
    }
  }
  const entitlementChanges: AdminMembershipCatalogComparison['entitlementChanges'] = []
  const currentDefinitions = new Map(current.definitions.map(item => [item.key, item]))
  const baseDefinitions = new Map(base.definitions.map(item => [item.key, item]))
  for (const key of [...new Set([...currentDefinitions.keys(), ...baseDefinitions.keys()])].sort()) {
    const next = currentDefinitions.get(key)
    const previous = baseDefinitions.get(key)
    if (!previous) entitlementChanges.push({ key, kind: 'added', fields: ['definition'], tierValueChangeCount: next?.values.length ?? 0 })
    else if (!next) entitlementChanges.push({ key, kind: 'removed', fields: ['definition'], tierValueChangeCount: previous.values.length })
    else {
      const comparison = compareDefinition(next, previous)
      if (comparison.fields.length || comparison.tierValueChangeCount > 0) {
        entitlementChanges.push({ key, kind: 'changed', ...comparison })
      }
    }
  }
  return {
    catalogVersionId: current.row.id,
    baseCatalogVersionId: base.row.id,
    tierChanges,
    entitlementChanges,
    summary: {
      addedTiers: tierChanges.filter(item => item.kind === 'added').length,
      removedTiers: tierChanges.filter(item => item.kind === 'removed').length,
      changedTiers: tierChanges.filter(item => item.kind === 'changed').length,
      addedEntitlements: entitlementChanges.filter(item => item.kind === 'added').length,
      removedEntitlements: entitlementChanges.filter(item => item.kind === 'removed').length,
      changedEntitlements: entitlementChanges.filter(item => item.kind === 'changed').length,
    },
  }
}

function compareDefinition(
  current: AdminMembershipEntitlementDefinition,
  base: AdminMembershipEntitlementDefinition,
) {
  const fields = changedFields(current, base, [
    'schemaVersion', 'valueType', 'defaultValue', 'mergeStrategy', 'periodRule',
    'clientCapability', 'displayName', 'description', 'unitLabel',
  ])
  const baseValues = new Map(base.values.map(item => [item.tierId, item]))
  const currentValues = new Map(current.values.map(item => [item.tierId, item]))
  let tierValueChangeCount = 0
  for (const tierId of new Set([...baseValues.keys(), ...currentValues.keys()])) {
    if (JSON.stringify(baseValues.get(tierId)) !== JSON.stringify(currentValues.get(tierId))) {
      tierValueChangeCount += 1
    }
  }
  return { fields, tierValueChangeCount }
}

function changedFields<T extends object>(current: T, base: T, fields: string[]) {
  return fields.filter(field => JSON.stringify((current as Record<string, unknown>)[field])
    !== JSON.stringify((base as Record<string, unknown>)[field]))
}

async function hashDocument(document: CatalogDocument) {
  return sha256Hex(JSON.stringify({
    versionCode: document.row.version_code,
    effectiveAt: document.row.effective_at,
    timezone: document.row.timezone,
    minimumClientVersion: document.row.minimum_client_version,
    tiers: document.tiers,
    definitions: document.definitions,
  }))
}

function mapCatalogSummary(row: CatalogRow, activeCatalogVersionId: string | null): AdminMembershipCatalogSummary {
  return {
    catalogVersionId: row.id,
    versionCode: row.version_code,
    state: normalizeCatalogState(row.state),
    productionReady: row.production_ready === 1,
    effectiveAt: row.effective_at,
    timezone: row.timezone,
    minimumClientVersion: row.minimum_client_version,
    baseCatalogVersionId: row.base_catalog_version_id,
    lockVersion: Number(row.lock_version),
    changeSummary: row.change_summary,
    productionDecisionStatus: row.production_decision_status === 'approved' ? 'approved' : 'unresolved',
    tierCount: Number(row.tier_count ?? 0),
    entitlementCount: Number(row.entitlement_count ?? 0),
    grantCount: Number(row.grant_count ?? 0),
    applicationCount: Number(row.application_count ?? 0),
    dependentCatalogCount: Number(row.dependent_catalog_count ?? 0),
    activeRuntimeReference: row.id === activeCatalogVersionId,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    updatedBy: row.updated_by === null ? null : Number(row.updated_by),
    publishedBy: row.published_by === null ? null : Number(row.published_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    latestPublishRequest: row.publish_request_id && row.publish_request_status && row.publish_request_created_at
      ? {
          requestId: row.publish_request_id,
          status: normalizePublishStatus(row.publish_request_status),
          createdAt: row.publish_request_created_at,
        }
      : null,
  }
}

function mapPublishRequest(
  row: PublishRequestRow,
  actor: AdminActor,
  activeCatalogVersionId: string | null,
  revealReviewNote: boolean,
): AdminMembershipCatalogPublishRequest {
  return {
    requestId: row.request_id,
    catalog: mapCatalogSummary(row, activeCatalogVersionId),
    catalogLockVersion: Number(row.catalog_lock_version),
    contentHash: row.request_content_hash,
    requestedProductionReady: row.requested_production_ready === 1,
    validation: parseValidation(row.validation_report_json),
    submitNote: row.submit_note,
    status: normalizePublishStatus(row.request_status),
    version: Number(row.request_version),
    requestedBy: { id: Number(row.requested_by), label: row.requester_label },
    reviewedBy: row.reviewed_by === null
      ? null
      : { id: Number(row.reviewed_by), label: row.reviewer_label ?? `管理员 #${row.reviewed_by}` },
    reviewNote: revealReviewNote ? row.review_note : null,
    createdAt: row.request_created_at,
    updatedAt: row.request_updated_at,
    reviewedAt: row.reviewed_at,
    canReview: row.request_status === 'pending_review'
      && actor.role === 'owner'
      && Number(row.requested_by) !== actor.id
      && (row.created_by === null || Number(row.created_by) !== actor.id),
  }
}

function normalizeTierList(value: unknown, current: AdminMembershipCatalogTier[]) {
  if (!Array.isArray(value) || value.length !== current.length || value.length !== 5) {
    throw invalidInput('tiers', '必须一次提交完整五级目录')
  }
  const currentIds = new Set(current.map(item => item.tierId))
  const tiers = value.map((raw, index) => {
    const item = asObject(raw, `tiers[${index}]`)
    const tierId = normalizeTierId(item.tierId)
    if (!currentIds.has(tierId)) throw invalidInput(`tiers[${index}].tierId`, '不能在编辑中更换稳定 tierId')
    const code = requiredText(item.code, `tiers[${index}].code`, 3, 48)
    if (!TIER_CODE.test(code)) throw invalidInput(`tiers[${index}].code`, '必须使用小写稳定代码')
    const accentToken = requiredText(item.accentToken, `tiers[${index}].accentToken`, 1, 32)
    if (!TOKEN_CODE.test(accentToken)) throw invalidInput(`tiers[${index}].accentToken`, '颜色 token 格式无效')
    return {
      tierId,
      code,
      displayName: requiredText(item.displayName, `tiers[${index}].displayName`, 1, 32),
      tagline: requiredText(item.tagline, `tiers[${index}].tagline`, 1, 120),
      rank: boundedInteger(item.rank, `tiers[${index}].rank`, 1, 1000),
      accentToken,
      acquisitionLabel: requiredText(item.acquisitionLabel, `tiers[${index}].acquisitionLabel`, 1, 120),
      serviceDisclosure: requiredText(item.serviceDisclosure, `tiers[${index}].serviceDisclosure`, 1, 240),
      sortOrder: boundedInteger(item.sortOrder, `tiers[${index}].sortOrder`, 1, 1000),
    }
  })
  if (new Set(tiers.map(item => item.tierId)).size !== tiers.length) throw invalidInput('tiers', 'tierId 不能重复')
  if (new Set(tiers.map(item => item.code)).size !== tiers.length) throw invalidInput('tiers', '等级 code 不能重复')
  if (new Set(tiers.map(item => item.rank)).size !== tiers.length) throw invalidInput('tiers', '等级 rank 不能重复')
  if (new Set(tiers.map(item => item.sortOrder)).size !== tiers.length) throw invalidInput('tiers', '展示顺序不能重复')
  tiers.sort((a, b) => a.sortOrder - b.sortOrder || a.tierId.localeCompare(b.tierId))
  return tiers
}

function normalizeEntitlementInput(
  input: UpsertAdminMembershipEntitlementInput,
  key: string,
  current: AdminMembershipCatalogDetail,
): AdminMembershipEntitlementDefinition {
  const valueType = normalizeValueType(input.valueType)
  const schemaVersion = positiveInteger(input.schemaVersion, 'schemaVersion')
  const existing = current.definitions.find(item => item.key === key)
  if (existing && existing.valueType !== valueType && schemaVersion <= existing.schemaVersion) {
    throw invalidInput('schemaVersion', '值类型变化时 schemaVersion 必须递增')
  }
  const defaultValue = normalizeTypedValue(input.defaultValue, valueType, 'defaultValue')
  const valuesRaw = input.values
  if (!Array.isArray(valuesRaw) || valuesRaw.length !== current.tiers.length) {
    throw invalidInput('values', '必须为全部五个等级提供显式值')
  }
  const tierIds = new Set(current.tiers.map(item => item.tierId))
  const values = valuesRaw.map((raw, index) => {
    const item = asObject(raw, `values[${index}]`)
    const tierId = normalizeTierId(item.tierId)
    if (!tierIds.has(tierId)) throw invalidInput(`values[${index}].tierId`, '等级不属于当前目录')
    return {
      tierId,
      value: normalizeTypedValue(item.value, valueType, `values[${index}].value`),
      availability: normalizeAvailability(item.availability),
    }
  })
  if (new Set(values.map(item => item.tierId)).size !== values.length) throw invalidInput('values', '等级值不能重复')
  values.sort((a, b) => a.tierId.localeCompare(b.tierId))
  return {
    key,
    schemaVersion,
    valueType,
    defaultValue,
    mergeStrategy: 'highest_rank',
    periodRule: optionalText(input.periodRule, 'periodRule', 120),
    clientCapability: requiredText(input.clientCapability, 'clientCapability', 1, 80),
    displayName: requiredText(input.displayName, 'displayName', 1, 48),
    description: requiredText(input.description, 'description', 1, 240),
    unitLabel: optionalText(input.unitLabel, 'unitLabel', 24),
    values,
  }
}

function summarizeDefinition(definition: AdminMembershipEntitlementDefinition) {
  return {
    key: definition.key,
    schemaVersion: definition.schemaVersion,
    valueType: definition.valueType,
    defaultValue: definition.defaultValue,
    clientCapability: definition.clientCapability,
    availableTierCount: definition.values.filter(item => item.availability === 'available').length,
    valuesHashInput: definition.values,
  }
}

async function findCommand(db: D1Database, adminId: number, key: string) {
  return db.prepare(`
    SELECT operation, request_hash, catalog_version_id
    FROM app_membership_catalog_commands
    WHERE admin_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(adminId, key).first<CommandRow>()
}

async function resolveCommandReplay(
  db: D1Database,
  row: CommandRow,
  operation: string,
  requestHash: string,
  activeCatalogVersionId: string | null,
): Promise<{ catalog: AdminMembershipCatalogDetail; replayed: boolean }> {
  if (row.operation !== operation || row.request_hash !== requestHash) throw idempotencyConflict()
  return {
    catalog: await getAdminAppMembershipCatalog(db, row.catalog_version_id, activeCatalogVersionId),
    replayed: true,
  }
}

async function findCatalogByVersionCode(db: D1Database, versionCode: string) {
  return db.prepare('SELECT id FROM app_membership_catalog_versions WHERE version_code = ? LIMIT 1')
    .bind(versionCode).first<{ id: string }>()
}

async function findActivePublishRequest(db: D1Database, catalogVersionId: string) {
  return db.prepare(`
    SELECT id FROM app_membership_catalog_publish_requests
    WHERE catalog_version_id = ? AND status = 'pending_review'
    LIMIT 1
  `).bind(catalogVersionId).first<{ id: string }>()
}

async function findPublishRequestByRequesterKey(db: D1Database, requesterId: number, key: string) {
  return db.prepare(`
    SELECT id, catalog_version_id, request_hash
    FROM app_membership_catalog_publish_requests
    WHERE requested_by = ? AND request_idempotency_key = ?
    LIMIT 1
  `).bind(requesterId, key).first<{ id: string; catalog_version_id: string; request_hash: string }>()
}

async function findPublishDecision(db: D1Database, reviewerId: number, key: string) {
  return db.prepare(`
    SELECT request_id, request_hash, result_status
    FROM app_membership_catalog_publish_decisions
    WHERE reviewer_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(reviewerId, key).first<DecisionRow>()
}

async function findPublishRequestRow(db: D1Database, requestId: string) {
  return db.prepare(`${publishRequestSelect()} WHERE request.id = ? LIMIT 1`)
    .bind(requestId).first<PublishRequestRow>()
}

function publishRequestSelect() {
  return `
    SELECT ${CATALOG_FIELDS},
      (SELECT COUNT(*) FROM app_membership_tiers tier WHERE tier.catalog_version_id = catalog.id) AS tier_count,
      (SELECT COUNT(*) FROM app_entitlement_definitions definition WHERE definition.catalog_version_id = catalog.id) AS entitlement_count,
      request.id AS request_id,
      request.id AS publish_request_id,
      request.status AS publish_request_status,
      request.created_at AS publish_request_created_at,
      request.catalog_lock_version,
      request.content_hash AS request_content_hash,
      request.requested_production_ready,
      request.validation_report_json,
      request.submit_note,
      request.status AS request_status,
      request.version AS request_version,
      request.request_hash,
      request.requested_by,
      COALESCE(NULLIF(TRIM(requester.nickname), ''), NULLIF(TRIM(requester.username), ''), '管理员 #' || requester.id) AS requester_label,
      request.reviewed_by,
      CASE WHEN reviewer.id IS NULL THEN NULL
           ELSE COALESCE(NULLIF(TRIM(reviewer.nickname), ''), NULLIF(TRIM(reviewer.username), ''), '管理员 #' || reviewer.id)
      END AS reviewer_label,
      request.review_note,
      request.created_at AS request_created_at,
      request.updated_at AS request_updated_at,
      request.reviewed_at
    FROM app_membership_catalog_publish_requests request
    JOIN app_membership_catalog_versions catalog ON catalog.id = request.catalog_version_id
    JOIN app_membership_catalog_metadata metadata ON metadata.catalog_version_id = catalog.id
    JOIN users requester ON requester.id = request.requested_by
    LEFT JOIN users reviewer ON reviewer.id = request.reviewed_by
  `
}

async function requireActiveAdmin(db: D1Database, adminId: number): Promise<AdminActor> {
  const row = await db.prepare(`
    SELECT id, role FROM users
    WHERE id = ? AND status = 'active' AND role IN ('admin', 'owner')
    LIMIT 1
  `).bind(adminId).first<{ id: number; role: string }>()
  if (!row) throw new AppMembershipError(403, 'ADMIN_REQUIRED', '需要有效管理员权限')
  return { id: Number(row.id), role: row.role === 'owner' ? 'owner' : 'admin' }
}

async function requireActiveOwner(db: D1Database, adminId: number): Promise<AdminActor> {
  const actor = await requireActiveAdmin(db, adminId)
  if (actor.role !== 'owner') {
    throw new AppMembershipError(403, 'OWNER_REQUIRED', '目录发布决定需要有效 Owner 权限')
  }
  return actor
}

function requireEditable(catalog: AdminMembershipCatalogSummary) {
  if (catalog.state !== 'development') {
    throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_IMMUTABLE', '已发布或退役目录不可原地修改，请新建版本')
  }
  if (catalog.latestPublishRequest?.status === 'pending_review') {
    throw new AppMembershipError(409, 'MEMBERSHIP_CATALOG_REVIEW_PENDING', '目录已提交发布复核，当前草稿已锁定')
  }
  if (catalog.activeRuntimeReference) {
    throw new AppMembershipError(
      409,
      'MEMBERSHIP_CATALOG_RUNTIME_REFERENCED',
      '当前环境引用的目录不可原地修改；请从该版本新建草稿，并在独立发布后另行切换配置',
    )
  }
  if (catalog.grantCount > 0 || catalog.applicationCount > 0 || catalog.dependentCatalogCount > 0) {
    throw new AppMembershipError(
      409,
      'MEMBERSHIP_CATALOG_REFERENCED',
      '目录已被会员事实、申请或后继目录引用，不可原地修改；请从该版本新建草稿',
    )
  }
}

function requireCloneableBase(catalog: AdminMembershipCatalogSummary) {
  if (catalog.latestPublishRequest?.status === 'pending_review') {
    throw new AppMembershipError(
      409,
      'MEMBERSHIP_CATALOG_BASE_REVIEW_PENDING',
      '待复核目录不能作为新基线，请先完成发布决定',
    )
  }
  const stable = catalog.state !== 'development'
    || catalog.activeRuntimeReference
    || catalog.grantCount > 0
    || catalog.applicationCount > 0
    || catalog.dependentCatalogCount > 0
  if (!stable) {
    throw new AppMembershipError(
      409,
      'MEMBERSHIP_CATALOG_BASE_NOT_STABLE',
      '可编辑草稿不能作为新基线；请继续编辑并完成发布，或选择已有稳定引用的版本',
    )
  }
}

function currentMutationToken(catalog: AdminMembershipCatalogSummary, idempotencyKey: string) {
  return `amcm_${catalog.catalogVersionId}_${catalog.lockVersion}_${idempotencyKey}`
}

function normalizeCatalogId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!CATALOG_ID.test(normalized)) throw invalidInput('catalogVersionId', '目录版本 ID 格式无效')
  return normalized
}

function normalizePublishRequestId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!PUBLISH_REQUEST_ID.test(normalized)) throw invalidInput('requestId', '发布复核申请 ID 格式无效')
  return normalized
}

function normalizeEntitlementKey(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!ENTITLEMENT_KEY.test(normalized) || normalized.length > 80) {
    throw invalidInput('entitlementKey', '能力键必须是稳定的小写点号/下划线标识')
  }
  return normalized
}

function normalizeTierId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!TIER_ID.test(normalized)) throw invalidInput('tierId', 'tierId 格式无效')
  return normalized
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AppMembershipError(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要 16–128 位有效 Idempotency-Key')
  }
  return normalized
}

function normalizeVersionCode(value: unknown) {
  const normalized = requiredText(value, 'versionCode', 3, 64)
  if (!VERSION_CODE.test(normalized)) throw invalidInput('versionCode', '版本号格式无效')
  return normalized
}

function normalizeTimezone(value: unknown) {
  const normalized = requiredText(value, 'timezone', 1, 64)
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: normalized }).format(new Date())
  }
  catch {
    throw invalidInput('timezone', '需要有效的 IANA 时区')
  }
  return normalized
}

function normalizeClientVersion(value: unknown) {
  const normalized = requiredText(value, 'minimumClientVersion', 3, 32)
  if (!CLIENT_VERSION.test(normalized)) throw invalidInput('minimumClientVersion', '最低客户端版本格式无效')
  return normalized
}

function normalizeIsoDate(value: unknown, field: string) {
  const normalized = requiredText(value, field, 10, 64)
  const date = new Date(normalized)
  if (!Number.isFinite(date.getTime())) throw invalidInput(field, '需要有效时间')
  return date.toISOString()
}

function normalizeValueType(value: unknown): AdminMembershipEntitlementValueType {
  if (value === 'boolean' || value === 'integer' || value === 'enum') return value
  throw invalidInput('valueType', '只支持 boolean、integer 或 enum')
}

function normalizeStoredValueType(value: string): AdminMembershipEntitlementValueType {
  if (value === 'boolean' || value === 'integer' || value === 'enum') return value
  return 'enum'
}

function normalizeAvailability(value: unknown): AdminMembershipEntitlementAvailability {
  if (value === 'available' || value === 'planned') return value
  throw invalidInput('availability', 'availability 只能是 available 或 planned')
}

function normalizeTypedValue(value: unknown, valueType: AdminMembershipEntitlementValueType, field: string) {
  if (!isTypedValue(valueType, value)) throw invalidInput(field, `值必须符合 ${valueType} 类型和安全范围`)
  return value
}

function isTypedValue(
  valueType: AdminMembershipEntitlementValueType,
  value: unknown,
): value is AdminMembershipEntitlementValue {
  if (valueType === 'boolean') return typeof value === 'boolean'
  if (valueType === 'integer') return typeof value === 'number'
    && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
  return typeof value === 'string' && Array.from(value).length >= 1 && Array.from(value).length <= 64
}

function normalizeDecision(value: unknown): 'approve' | 'reject' {
  if (value === 'approve' || value === 'reject') return value
  throw invalidInput('decision', 'decision 只能是 approve 或 reject')
}

function normalizeCatalogState(value: string): AdminMembershipCatalogState {
  if (value === 'published' || value === 'retired') return value
  return 'development'
}

function normalizePublishStatus(value: string): AdminMembershipCatalogPublishStatus {
  if (value === 'approved' || value === 'rejected' || value === 'stale' || value === 'cancelled') return value
  return 'pending_review'
}

function optionalPublishStatus(value: unknown): AdminMembershipCatalogPublishStatus | null {
  if (value === undefined || value === null || value === '') return null
  if (value === 'pending_review' || value === 'approved' || value === 'rejected' || value === 'stale' || value === 'cancelled') return value
  throw invalidInput('status', '发布复核状态无效')
}

function parseStoredValue(value: string): AdminMembershipEntitlementValue {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'boolean' || typeof parsed === 'string'
      || (typeof parsed === 'number' && Number.isSafeInteger(parsed))) return parsed
  }
  catch {
    // 数据异常在 validation 中收敛，不向调用方返回未解析 JSON。
  }
  return ''
}

function parseValidation(value: string): AdminMembershipCatalogValidation {
  try {
    const parsed = JSON.parse(value) as AdminMembershipCatalogValidation
    if (Array.isArray(parsed.issues)) return parsed
  }
  catch {
    // fall through
  }
  return {
    issues: [{ code: 'VALIDATION_REPORT_INVALID', severity: 'error', scope: 'catalog', message: '固化校验报告无法解析。' }],
    errorCount: 1,
    warningCount: 0,
    infoCount: 0,
    canSubmitPublish: false,
    canMarkProductionReady: false,
  }
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidInput(field, '需要对象')
  return value as Record<string, unknown>
}

function requiredText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw invalidInput(field, '需要文本')
  const normalized = value.trim().replace(/[\u0000-\u001F\u007F]/gu, '')
  const length = Array.from(normalized).length
  if (length < min || length > max) throw invalidInput(field, `长度需要在 ${min}–${max} 个字符之间`)
  return normalized
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, field, 1, max)
}

function positiveInteger(value: unknown, field: string) {
  return boundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER)
}

function boundedInteger(value: unknown, field: string, min: number, max: number) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
    throw invalidInput(field, `需要 ${min}–${max} 范围内的整数`)
  }
  return numeric
}

function optionalBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw invalidInput('productionReady', '需要布尔值')
  return value
}

function invalidInput(field: string, message: string) {
  return new AppMembershipError(400, 'MEMBERSHIP_CATALOG_INPUT_INVALID', `${field}：${message}`)
}

function versionConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_CATALOG_VERSION_CONFLICT', '目录版本已变化，请刷新后重试')
}

function idempotencyConflict() {
  return new AppMembershipError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已被不同请求使用')
}

function catalogStaleConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_CATALOG_CONTENT_CHANGED', '目录内容或发布门禁已变化，请重新校验并提交')
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

const CATALOG_FIELDS = `
  catalog.id,
  catalog.version_code,
  catalog.state,
  catalog.production_ready,
  catalog.effective_at,
  catalog.timezone,
  catalog.minimum_client_version,
  metadata.base_catalog_version_id,
  metadata.lock_version,
  metadata.change_summary,
  metadata.production_decision_status,
  metadata.content_hash,
  metadata.created_by,
  metadata.updated_by,
  metadata.published_by,
  metadata.created_at,
  metadata.updated_at,
  metadata.published_at,
  (SELECT COUNT(*) FROM app_membership_grants grant_row WHERE grant_row.catalog_version_id = catalog.id) AS grant_count,
  (SELECT COUNT(*) FROM app_membership_applications application WHERE application.catalog_version_id = catalog.id) AS application_count,
  (SELECT COUNT(*) FROM app_membership_catalog_metadata child WHERE child.base_catalog_version_id = catalog.id) AS dependent_catalog_count
`
