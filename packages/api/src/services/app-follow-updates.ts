import type { AppFollowUpdateItem } from '@meigallery/shared'
import type { Bindings } from '../index'
import { getPublicPersonProfilesByIds } from './app-discovery'

export const APP_FOLLOW_UPDATE_POLICY_ID = 'fupol_app_1_0_interaction_3_dev_1'
export const APP_FOLLOW_UPDATE_DEFAULT_PAGE_SIZE = 20
export const APP_FOLLOW_UPDATE_MAX_PAGE_SIZE = 40
export const APP_FOLLOW_UPDATE_EVENT_TYPE = 'interaction.followed_profile_updated'

const FOLLOW_UPDATE_CURSOR_VERSION = 1
const POLICY_ID_PATTERN = /^fupol_[A-Za-z0-9_-]{1,90}$/u
const PUBLICATION_ID_PATTERN = /^ppub_[A-Za-z0-9_-]{1,75}$/u

export interface AppFollowUpdateRuntimeConfig {
  enabled: boolean
  policyId: string
  requireProductionReady: boolean
}

export interface AppFollowUpdatePolicy {
  id: string
  state: 'development' | 'published'
  productionReady: boolean
  feedEnabled: boolean
  notificationProjectionEnabled: boolean
  effectiveAt: string
}

export interface AppFollowUpdateListQuery {
  limit: number
  cursor: null | {
    v: 1
    accountScope: string
    publishedAt: string
    publicationId: string
  }
}

type FollowUpdatePolicyRow = {
  id: string
  state: string
  production_ready: number
  feed_enabled: number
  notification_projection_enabled: number
  effective_at: string
}

type FollowUpdateRow = {
  publication_id: string
  profile_id: string
  profile_version: number
  projection_version: number
  published_at: string
}

export class AppFollowUpdateError extends Error {
  constructor(
    public readonly status: 400 | 403 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppFollowUpdateError'
  }
}

export function getAppFollowUpdateRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_FOLLOW_UPDATES_ENABLED'
  | 'APP_FOLLOW_UPDATES_POLICY_VERSION'
  | 'APP_FOLLOW_UPDATES_PRODUCTION_READY'
>): AppFollowUpdateRuntimeConfig {
  const configuredPolicyId = normalizePolicyId(env.APP_FOLLOW_UPDATES_POLICY_VERSION)
  const requireProductionReady = env.APP_ENV === 'production'
  const productionGateSatisfied = !requireProductionReady
    || env.APP_FOLLOW_UPDATES_PRODUCTION_READY === 'true'
  return {
    enabled: env.APP_FOLLOW_UPDATES_ENABLED === 'true'
      && Boolean(configuredPolicyId)
      && productionGateSatisfied,
    policyId: configuredPolicyId ?? APP_FOLLOW_UPDATE_POLICY_ID,
    requireProductionReady,
  }
}

export function parseAppFollowUpdateListQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
}): AppFollowUpdateListQuery {
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, APP_FOLLOW_UPDATE_MAX_PAGE_SIZE)
    : APP_FOLLOW_UPDATE_DEFAULT_PAGE_SIZE
  const cursor = input.cursor
    ? decodeFollowUpdateCursor(input.cursor, input.accountScope)
    : null
  return { limit, cursor }
}

export async function resolveAppFollowUpdateCapability(
  db: D1Database,
  config: AppFollowUpdateRuntimeConfig,
): Promise<boolean> {
  if (!config.enabled) return false
  try {
    return (await loadAppFollowUpdatePolicy(db, config)).feedEnabled
  }
  catch {
    return false
  }
}

export async function listAppFollowUpdates(
  db: D1Database,
  accountId: number,
  accountScope: string,
  apiUrl: string,
  config: AppFollowUpdateRuntimeConfig,
  query: AppFollowUpdateListQuery,
  now = new Date(),
): Promise<{ data: AppFollowUpdateItem[]; nextCursor: string | null; hasMore: boolean }> {
  requireAccountId(accountId)
  const policy = await loadAppFollowUpdatePolicy(db, config)
  if (!policy.feedEnabled) {
    throw new AppFollowUpdateError(403, 'FOLLOW_UPDATES_DISABLED', '关注更新当前保持关闭')
  }

  const conditions = [
    'relation.account_id = ?',
    "relation.interaction_type = 'follow'",
    "publication.status = 'published'",
    'publication.reviewed_at IS NOT NULL',
    'publication.projection_version IS NOT NULL',
    'publication.reviewed_at > relation.created_at',
    'publication.reviewed_at >= ?',
  ]
  const bindings: unknown[] = [accountId, policy.effectiveAt]
  if (query.cursor) {
    conditions.push('(publication.reviewed_at < ? OR (publication.reviewed_at = ? AND publication.id < ?))')
    bindings.push(
      query.cursor.publishedAt,
      query.cursor.publishedAt,
      query.cursor.publicationId,
    )
  }
  const nowIso = now.toISOString()
  const result = await db.prepare(`
    SELECT publication.id AS publication_id,
           publication.profile_id,
           publication.profile_version,
           publication.projection_version,
           publication.reviewed_at AS published_at
    FROM app_viewer_interactions relation
    JOIN person_publication_reviews publication
      ON publication.profile_id = relation.profile_id
    JOIN profile_public_projections projection
      ON projection.profile_id = publication.profile_id
    JOIN galleries gallery
      ON gallery.id = projection.source_gallery_id
    WHERE ${conditions.join(' AND ')}
      AND projection.verification_status = 'verified'
      AND projection.publication_status = 'published'
      AND projection.authorization_status = 'active'
      AND projection.visibility_status = 'visible'
      AND (
        projection.authorization_valid_from IS NULL
        OR (
          datetime(projection.authorization_valid_from) IS NOT NULL
          AND datetime(projection.authorization_valid_from) <= datetime(?)
        )
      )
      AND (
        projection.authorization_valid_until IS NULL
        OR (
          datetime(projection.authorization_valid_until) IS NOT NULL
          AND datetime(projection.authorization_valid_until) > datetime(?)
        )
      )
      AND (
        projection.verification_valid_until IS NULL
        OR (
          datetime(projection.verification_valid_until) IS NOT NULL
          AND datetime(projection.verification_valid_until) > datetime(?)
        )
      )
      AND datetime(projection.published_at) IS NOT NULL
      AND gallery.status = 'published'
      AND NOT EXISTS (
        SELECT 1
        FROM app_profile_blocks block
        WHERE block.account_id = relation.account_id
          AND block.profile_id = relation.profile_id
          AND block.state = 'blocked'
      )
    ORDER BY publication.reviewed_at DESC, publication.id DESC
    LIMIT ?
  `).bind(...bindings, nowIso, nowIso, nowIso, query.limit + 1).all<FollowUpdateRow>()

  const hasMore = result.results.length > query.limit
  const pageRows = result.results.slice(0, query.limit)
  const profiles = await getPublicPersonProfilesByIds(
    db,
    pageRows.map(row => row.profile_id),
    apiUrl,
    now,
  )
  const data = pageRows.flatMap<AppFollowUpdateItem>((row) => {
    const profile = profiles.get(row.profile_id)
    if (!profile) return []
    return [{
      updateId: followUpdateId(row.publication_id),
      updateType: 'profile_published',
      profileId: row.profile_id,
      profileVersion: Number(row.profile_version),
      projectionVersion: Number(row.projection_version),
      publishedAt: row.published_at,
      profile,
    }]
  })
  const lastRow = pageRows.at(-1)
  return {
    data,
    hasMore,
    nextCursor: hasMore && lastRow
      ? encodeFollowUpdateCursor({
          v: FOLLOW_UPDATE_CURSOR_VERSION,
          accountScope,
          publishedAt: lastRow.published_at,
          publicationId: lastRow.publication_id,
        })
      : null,
  }
}

export async function enqueueAppFollowUpdateNotifications(
  db: D1Database,
  accountId: number,
  followConfig: AppFollowUpdateRuntimeConfig,
  notification: {
    policyId: string
    effectiveAt: string
    requireProductionReady: boolean
  },
  now = new Date(),
): Promise<number> {
  if (!followConfig.enabled) return 0
  const policy = await loadAppFollowUpdatePolicy(db, followConfig)
  if (!policy.notificationProjectionEnabled) return 0
  const nowIso = now.toISOString()
  const result = await db.prepare(`
    INSERT OR IGNORE INTO app_notification_outbox (
      id, policy_id, event_definition_id, account_id, event_type, event_ref,
      target_type, target_id, status, attempts, next_attempt_at, created_at
    )
    SELECT
      'nto_fup_' || relation.account_id || '_' || substr(publication.id, 6),
      definition.policy_id,
      definition.id,
      relation.account_id,
      definition.event_type,
      publication.id,
      definition.target_type,
      publication.profile_id,
      'pending',
      0,
      ?,
      publication.reviewed_at
    FROM app_viewer_interactions relation
    JOIN person_publication_reviews publication
      ON publication.profile_id = relation.profile_id
    JOIN profile_public_projections projection
      ON projection.profile_id = publication.profile_id
    JOIN galleries gallery
      ON gallery.id = projection.source_gallery_id
    JOIN app_notification_event_definitions definition
      ON definition.policy_id = ?
     AND definition.event_type = ?
     AND definition.active = 1
    JOIN app_notification_template_versions template
      ON template.event_definition_id = definition.id
     AND template.locale = 'zh-CN'
     AND template.region_scope = 'all'
     AND template.state IN ('development', 'published')
     AND (? = 0 OR template.state = 'published')
    WHERE relation.account_id = ?
      AND relation.interaction_type = 'follow'
      AND publication.status = 'published'
      AND publication.reviewed_at IS NOT NULL
      AND publication.projection_version IS NOT NULL
      AND publication.reviewed_at > relation.created_at
      AND publication.reviewed_at >= ?
      AND publication.reviewed_at >= ?
      AND projection.verification_status = 'verified'
      AND projection.publication_status = 'published'
      AND projection.authorization_status = 'active'
      AND projection.visibility_status = 'visible'
      AND (
        projection.authorization_valid_from IS NULL
        OR datetime(projection.authorization_valid_from) <= datetime(?)
      )
      AND (
        projection.authorization_valid_until IS NULL
        OR datetime(projection.authorization_valid_until) > datetime(?)
      )
      AND (
        projection.verification_valid_until IS NULL
        OR datetime(projection.verification_valid_until) > datetime(?)
      )
      AND gallery.status = 'published'
      AND NOT EXISTS (
        SELECT 1
        FROM app_profile_blocks block
        WHERE block.account_id = relation.account_id
          AND block.profile_id = relation.profile_id
          AND block.state = 'blocked'
      )
    ORDER BY publication.reviewed_at DESC, publication.id DESC
    LIMIT ?
  `).bind(
    nowIso,
    notification.policyId,
    APP_FOLLOW_UPDATE_EVENT_TYPE,
    notification.requireProductionReady ? 1 : 0,
    accountId,
    policy.effectiveAt,
    notification.effectiveAt,
    nowIso,
    nowIso,
    nowIso,
    APP_FOLLOW_UPDATE_MAX_PAGE_SIZE,
  ).run()
  return Number(result.meta?.changes ?? 0)
}

export async function isAppFollowUpdateDeliveryEligible(
  db: D1Database,
  input: {
    accountId: number
    eventRef: string
    profileId: string
  },
  config: AppFollowUpdateRuntimeConfig | undefined,
  now = new Date(),
): Promise<boolean> {
  if (!config?.enabled || !PUBLICATION_ID_PATTERN.test(input.eventRef)) return false
  let policy: AppFollowUpdatePolicy
  try {
    policy = await loadAppFollowUpdatePolicy(db, config)
  }
  catch {
    return false
  }
  if (!policy.notificationProjectionEnabled) return false
  const nowIso = now.toISOString()
  const row = await db.prepare(`
    SELECT 1 AS eligible
    FROM app_viewer_interactions relation
    JOIN person_publication_reviews publication
      ON publication.id = ?
     AND publication.profile_id = relation.profile_id
    JOIN profile_public_projections projection
      ON projection.profile_id = publication.profile_id
    JOIN galleries gallery
      ON gallery.id = projection.source_gallery_id
    WHERE relation.account_id = ?
      AND relation.profile_id = ?
      AND relation.interaction_type = 'follow'
      AND publication.status = 'published'
      AND publication.reviewed_at IS NOT NULL
      AND publication.projection_version IS NOT NULL
      AND publication.reviewed_at > relation.created_at
      AND publication.reviewed_at >= ?
      AND projection.verification_status = 'verified'
      AND projection.publication_status = 'published'
      AND projection.authorization_status = 'active'
      AND projection.visibility_status = 'visible'
      AND (
        projection.authorization_valid_from IS NULL
        OR datetime(projection.authorization_valid_from) <= datetime(?)
      )
      AND (
        projection.authorization_valid_until IS NULL
        OR datetime(projection.authorization_valid_until) > datetime(?)
      )
      AND (
        projection.verification_valid_until IS NULL
        OR datetime(projection.verification_valid_until) > datetime(?)
      )
      AND gallery.status = 'published'
      AND NOT EXISTS (
        SELECT 1
        FROM app_profile_blocks block
        WHERE block.account_id = relation.account_id
          AND block.profile_id = relation.profile_id
          AND block.state = 'blocked'
      )
    LIMIT 1
  `).bind(
    input.eventRef,
    input.accountId,
    input.profileId,
    policy.effectiveAt,
    nowIso,
    nowIso,
    nowIso,
  ).first<{ eligible: number }>()
  return Boolean(row)
}

async function loadAppFollowUpdatePolicy(
  db: D1Database,
  config: AppFollowUpdateRuntimeConfig,
): Promise<AppFollowUpdatePolicy> {
  if (!config.enabled) {
    throw new AppFollowUpdateError(403, 'FEATURE_DISABLED', '关注更新尚未开放')
  }
  const row = await db.prepare(`
    SELECT id, state, production_ready, feed_enabled,
           notification_projection_enabled, effective_at
    FROM app_follow_update_policies
    WHERE id = ?
    LIMIT 1
  `).bind(config.policyId).first<FollowUpdatePolicyRow>()
  const stateReady = row?.state === 'development' || row?.state === 'published'
  const productionReady = !config.requireProductionReady
    || (row?.state === 'published' && row.production_ready === 1)
  if (
    !row
    || !stateReady
    || !productionReady
    || !Number.isFinite(Date.parse(row.effective_at))
  ) {
    throw new AppFollowUpdateError(
      503,
      'FOLLOW_UPDATE_POLICY_NOT_READY',
      '关注更新策略尚未就绪',
      true,
    )
  }
  return {
    id: row.id,
    state: row.state as 'development' | 'published',
    productionReady: row.production_ready === 1,
    feedEnabled: row.feed_enabled === 1,
    notificationProjectionEnabled: row.notification_projection_enabled === 1,
    effectiveAt: row.effective_at,
  }
}

function followUpdateId(publicationId: string) {
  if (!PUBLICATION_ID_PATTERN.test(publicationId)) {
    throw new AppFollowUpdateError(503, 'FOLLOW_UPDATE_DATA_INVALID', '关注更新数据暂不可用')
  }
  return `fup_${publicationId.slice(5)}`
}

function normalizePolicyId(value: string | undefined) {
  const normalized = value?.trim()
  return normalized && POLICY_ID_PATTERN.test(normalized) ? normalized : null
}

function requireAccountId(accountId: number) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error('APP_FOLLOW_UPDATE_ACCOUNT_INVALID')
  }
}

function encodeFollowUpdateCursor(cursor: NonNullable<AppFollowUpdateListQuery['cursor']>) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeFollowUpdateCursor(
  value: string,
  accountScope: string,
): NonNullable<AppFollowUpdateListQuery['cursor']> {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error('cursor format')
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<NonNullable<AppFollowUpdateListQuery['cursor']>>
    if (
      parsed.v !== FOLLOW_UPDATE_CURSOR_VERSION
      || parsed.accountScope !== accountScope
      || typeof parsed.publishedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.publishedAt))
      || typeof parsed.publicationId !== 'string'
      || !PUBLICATION_ID_PATTERN.test(parsed.publicationId)
    ) {
      throw new Error('cursor scope')
    }
    return parsed as NonNullable<AppFollowUpdateListQuery['cursor']>
  }
  catch {
    throw new AppFollowUpdateError(400, 'INVALID_CURSOR', '分页游标无效或已不适用于当前账号')
  }
}
