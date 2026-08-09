import type { Bindings } from '../index'

export const APP_INTERACTION_COLLECTION_POLICY_ID = 'icp_app_1_0_interaction_2_dev_1'
export const APP_FAVORITE_DEFAULT_FOLDER_LABEL = '默认收藏' as const
export const APP_FAVORITE_MAX_FOLDER_NAME_LENGTH = 30
export const APP_FAVORITE_MAX_ITEMS_PER_FOLDER = 500
export const APP_INTERACTION_COLLECTION_MAX_PAGE_SIZE = 40

const POLICY_ID_PATTERN = /^icp_[A-Za-z0-9_-]{1,92}$/u
const PROFILE_ID_PATTERN = /^pp_[A-Za-z0-9_-]{1,77}$/u
const FOLDER_ID_PATTERN = /^ff_[A-Za-z0-9_-]{1,93}$/u

export interface AppInteractionCollectionRuntimeConfig {
  enabled: boolean
  policyId: string
  requireProductionReady: boolean
}

export interface AppInteractionCollectionPolicy {
  id: string
  state: 'development' | 'published'
  productionReady: boolean
  favoritesEnabled: boolean
  historyEnabled: boolean
  defaultHistoryRecordingEnabled: false
  historyRetentionDecisionStatus: 'unresolved' | 'approved'
  personalizationDecisionStatus: 'unresolved' | 'approved'
  purgeEnabled: boolean
  maxFolderNameLength: number
  maxItemsPerFolder: number
}

type PolicyRow = {
  id: string
  state: string
  production_ready: number
  favorites_enabled: number
  history_enabled: number
  default_history_recording_enabled: number
  history_retention_decision_status: string
  personalization_decision_status: string
  purge_enabled: number
  max_folder_name_length: number
  max_items_per_folder: number
}

export class AppInteractionCollectionError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppInteractionCollectionError'
  }
}

export function getAppInteractionCollectionRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_INTERACTION_COLLECTIONS_ENABLED'
  | 'APP_INTERACTION_COLLECTIONS_POLICY_VERSION'
  | 'APP_INTERACTION_COLLECTIONS_PRODUCTION_READY'
>): AppInteractionCollectionRuntimeConfig {
  const configuredPolicyId = normalizePolicyId(env.APP_INTERACTION_COLLECTIONS_POLICY_VERSION)
  const requireProductionReady = env.APP_ENV === 'production'
  const productionGateSatisfied = !requireProductionReady
    || env.APP_INTERACTION_COLLECTIONS_PRODUCTION_READY === 'true'
  return {
    enabled: env.APP_INTERACTION_COLLECTIONS_ENABLED === 'true'
      && Boolean(configuredPolicyId)
      && productionGateSatisfied,
    policyId: configuredPolicyId ?? APP_INTERACTION_COLLECTION_POLICY_ID,
    requireProductionReady,
  }
}

export function requireAppInteractionCollectionsEnabled(
  config: AppInteractionCollectionRuntimeConfig,
): void {
  if (!config.enabled) {
    throw new AppInteractionCollectionError(403, 'FEATURE_DISABLED', '收藏夹与浏览历史尚未开放')
  }
}

export async function requireAppInteractionCollectionPolicy(
  db: D1Database,
  config: AppInteractionCollectionRuntimeConfig,
  capability: 'favorites' | 'history',
): Promise<AppInteractionCollectionPolicy> {
  const policy = await loadAppInteractionCollectionPolicy(db, config)
  if (capability === 'favorites' && !policy.favoritesEnabled) {
    throw new AppInteractionCollectionError(403, 'FAVORITES_DISABLED', '收藏夹当前保持关闭')
  }
  if (capability === 'history' && !policy.historyEnabled) {
    throw new AppInteractionCollectionError(403, 'VIEW_HISTORY_DISABLED', '浏览历史当前保持关闭')
  }
  return policy
}

export async function resolveAppInteractionCollectionCapabilities(
  db: D1Database,
  config: AppInteractionCollectionRuntimeConfig,
): Promise<{ favorite: boolean; history: boolean }> {
  if (!config.enabled) return { favorite: false, history: false }
  try {
    const policy = await loadAppInteractionCollectionPolicy(db, config)
    return {
      favorite: policy.favoritesEnabled,
      history: policy.historyEnabled,
    }
  }
  catch {
    return { favorite: false, history: false }
  }
}

async function loadAppInteractionCollectionPolicy(
  db: D1Database,
  config: AppInteractionCollectionRuntimeConfig,
): Promise<AppInteractionCollectionPolicy> {
  requireAppInteractionCollectionsEnabled(config)
  const row = await db.prepare(`
    SELECT id, state, production_ready, favorites_enabled, history_enabled,
           default_history_recording_enabled, history_retention_decision_status,
           personalization_decision_status, purge_enabled,
           max_folder_name_length, max_items_per_folder
    FROM app_interaction_collection_policies
    WHERE id = ?
    LIMIT 1
  `).bind(config.policyId).first<PolicyRow>()

  const stateReady = row?.state === 'development' || row?.state === 'published'
  const productionReady = !config.requireProductionReady || (
    row?.state === 'published'
    && row.production_ready === 1
    && row.history_retention_decision_status === 'approved'
    && row.personalization_decision_status === 'approved'
    && row.purge_enabled === 1
  )
  if (!row || !stateReady || !productionReady) {
    throw new AppInteractionCollectionError(
      503,
      'INTERACTION_COLLECTION_POLICY_NOT_READY',
      '收藏夹与浏览历史策略尚未就绪',
      true,
    )
  }
  if (row.default_history_recording_enabled !== 0) {
    throw new AppInteractionCollectionError(
      503,
      'INTERACTION_COLLECTION_POLICY_INVALID',
      '浏览历史默认设置不符合当前隐私基线',
    )
  }
  if (
    !Number.isSafeInteger(row.max_folder_name_length)
    || row.max_folder_name_length < 1
    || row.max_folder_name_length > APP_FAVORITE_MAX_FOLDER_NAME_LENGTH
    || !Number.isSafeInteger(row.max_items_per_folder)
    || row.max_items_per_folder < 1
    || row.max_items_per_folder > APP_FAVORITE_MAX_ITEMS_PER_FOLDER
  ) {
    throw new AppInteractionCollectionError(
      503,
      'INTERACTION_COLLECTION_POLICY_INVALID',
      '收藏夹技术限制配置异常',
    )
  }
  return {
    id: row.id,
    state: row.state as 'development' | 'published',
    productionReady: row.production_ready === 1,
    favoritesEnabled: row.favorites_enabled === 1,
    historyEnabled: row.history_enabled === 1,
    defaultHistoryRecordingEnabled: false,
    historyRetentionDecisionStatus: row.history_retention_decision_status as 'unresolved' | 'approved',
    personalizationDecisionStatus: row.personalization_decision_status as 'unresolved' | 'approved',
    purgeEnabled: row.purge_enabled === 1,
    maxFolderNameLength: row.max_folder_name_length,
    maxItemsPerFolder: row.max_items_per_folder,
  }
}

export function normalizeAppProfileId(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value)) {
    throw profileNotAvailable()
  }
  return value
}

export function normalizeFavoriteFolderId(value: unknown): string {
  if (typeof value !== 'string' || !FOLDER_ID_PATTERN.test(value)) {
    throw new AppInteractionCollectionError(404, 'FAVORITE_FOLDER_NOT_FOUND', '收藏夹不存在')
  }
  return value
}

export function normalizeExpectedVersion(value: unknown): number {
  const parsed = typeof value === 'string' && /^[1-9]\d{0,9}$/u.test(value)
    ? Number(value)
    : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
    throw new AppInteractionCollectionError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  return Number(parsed)
}

export function normalizeSortOrder(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000000) {
    throw new AppInteractionCollectionError(400, 'SORT_ORDER_INVALID', '收藏夹排序值无效')
  }
  return Number(value)
}

export function normalizePageLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, APP_INTERACTION_COLLECTION_MAX_PAGE_SIZE)
    : 20
}

export async function requireAvailableUnblockedProfile(
  db: D1Database,
  accountId: number,
  profileIdValue: unknown,
  now = new Date(),
): Promise<string> {
  const profileId = normalizeAppProfileId(profileIdValue)
  const nowIso = now.toISOString()
  const row = await db.prepare(`
    SELECT p.profile_id
    FROM profile_public_projections p
    JOIN galleries g ON g.id = p.source_gallery_id
    WHERE p.profile_id = ?
      AND p.verification_status = 'verified'
      AND p.publication_status = 'published'
      AND p.authorization_status = 'active'
      AND p.visibility_status = 'visible'
      AND (p.authorization_valid_from IS NULL OR datetime(p.authorization_valid_from) <= datetime(?))
      AND (p.authorization_valid_until IS NULL OR datetime(p.authorization_valid_until) > datetime(?))
      AND (p.verification_valid_until IS NULL OR datetime(p.verification_valid_until) > datetime(?))
      AND datetime(p.published_at) IS NOT NULL
      AND g.status = 'published'
      AND NOT EXISTS (
        SELECT 1
        FROM app_profile_blocks block
        WHERE block.account_id = ?
          AND block.profile_id = p.profile_id
          AND block.state = 'blocked'
      )
    LIMIT 1
  `).bind(profileId, nowIso, nowIso, nowIso, accountId).first<{ profile_id: string }>()
  if (!row) throw profileNotAvailable()
  return row.profile_id
}

export function profileNotAvailable(): AppInteractionCollectionError {
  return new AppInteractionCollectionError(404, 'PROFILE_NOT_AVAILABLE', '人物资料不存在或当前不可见')
}

export function assertPositiveAccountId(accountId: number): void {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error('APP_INTERACTION_COLLECTION_ACCOUNT_INVALID')
  }
}

function normalizePolicyId(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized && POLICY_ID_PATTERN.test(normalized) ? normalized : null
}
