import type {
  AppFavoriteFolderCollection,
  AppFavoriteFolderDeleteResult,
  AppFavoriteFolderPreview,
  AppFavoriteFolderSummary,
  AppFavoriteFolderType,
  AppFavoriteListItem,
  AppFavoriteMutationResult,
} from '@meigallery/shared'
import { resolvePublicCoverUrl } from '../utils/cover-url'
import {
  getPublicPersonProfilesByIds,
  PUBLIC_PROFILE_ELIGIBILITY_SQL,
  publicProfileEligibilityParams,
  publicProfileEligibilitySql,
} from './app-discovery'
import {
  AppMembershipError,
  type AppMembershipRuntimeConfig,
  resolveAppMembershipSnapshot,
} from './app-membership'
import {
  APP_FAVORITE_DEFAULT_FOLDER_LABEL,
  AppInteractionCollectionError,
  type AppInteractionCollectionPolicy,
  type AppInteractionCollectionRuntimeConfig,
  assertPositiveAccountId,
  normalizeAppProfileId,
  normalizeExpectedVersion,
  normalizeFavoriteFolderId,
  normalizePageLimit,
  normalizeSortOrder,
  requireAppInteractionCollectionPolicy,
  requireAvailableUnblockedProfile,
} from './app-interaction-collections'

const FAVORITE_FOLDER_ENTITLEMENT = 'favorite.folder_count'
const DEFAULT_FOLDER_ID = 'ff_default'
const FAVORITE_CURSOR_VERSION = 2
const MAX_CUSTOM_FOLDER_LIMIT = 100
const REGION_CODE_PATTERN = /^[a-z0-9-]{2,32}$/u
const TAXONOMY_TERM_ID_PATTERN = /^txt_[A-Za-z0-9_-]{4,92}$/u
const SEARCH_TEXT_MAX_LENGTH = 40
const FAVORITE_PROFILE_ELIGIBILITY_SQL = publicProfileEligibilitySql('profile', 'gallery')

type FolderRow = {
  id: string
  folder_type: string
  name: string
  sort_order: number
  version: number
  item_count: number
  created_at: string
  updated_at: string
}

type FavoriteStateRow = {
  folder_id: string
  created_at: string
}

type FavoriteListRow = {
  profile_id: string
  favorited_at: string
}

type FolderPreviewRow = {
  folder_id: string
  profile_id: string
  source_gallery_id: string
  cover_key: string | null
  preview_order: number
}

type FavoriteCursor = {
  v: 2
  accountScope: string
  folderScope: string | null
  searchText: string | null
  regionCode: string | null
  styleTermId: string | null
  favoritedAt: string
  profileId: string
}

export interface AppFavoriteListQuery {
  limit: number
  searchText: string | null
  regionCode: string | null
  styleTermId: string | null
  cursor: FavoriteCursor | null
}

export interface CreateAppFavoriteFolderInput {
  name?: unknown
}

export interface UpdateAppFavoriteFolderInput {
  expectedVersion?: unknown
  name?: unknown
  sortOrder?: unknown
}

export function parseAppFavoriteListQuery(input: {
  limit?: string
  cursor?: string
  query?: string
  region?: string
  styleTerm?: string
  accountScope: string
  folderId?: string | null
}): AppFavoriteListQuery {
  const folderScope = input.folderId ? normalizeFavoriteFolderId(input.folderId) : null
  const searchText = normalizeSearchText(input.query)
  const regionCode = normalizeRegionCode(input.region)
  const styleTermId = normalizeStyleTermId(input.styleTerm)
  return {
    limit: normalizePageLimit(input.limit),
    searchText,
    regionCode,
    styleTermId,
    cursor: input.cursor
      ? decodeFavoriteCursor(
          input.cursor,
          input.accountScope,
          folderScope,
          searchText,
          regionCode,
          styleTermId,
        )
      : null,
  }
}

export async function listAppFavoriteFolders(
  db: D1Database,
  accountId: number,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  apiUrl: string,
  now = new Date(),
): Promise<AppFavoriteFolderCollection> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'favorites')
  await ensureDefaultFavoriteFolder(db, accountId, now)
  const [result, customFolderLimit, totalRow, previewProfilesByFolder] = await Promise.all([
    db.prepare(`
      SELECT folder.id, folder.folder_type, folder.name, folder.sort_order, folder.version,
             folder.created_at, folder.updated_at, COUNT(item.profile_id) AS item_count
      FROM app_favorite_folders folder
      LEFT JOIN app_favorite_folder_items item
        ON item.account_id = folder.account_id AND item.folder_id = folder.id
      WHERE folder.account_id = ?
      GROUP BY folder.account_id, folder.id
      ORDER BY CASE folder.folder_type WHEN 'default' THEN 0 ELSE 1 END,
               folder.sort_order ASC, folder.created_at ASC, folder.id ASC
    `).bind(accountId).all<FolderRow>(),
    resolveCustomFolderLimit(db, accountId, membershipConfig, now),
    db.prepare(`
      SELECT COUNT(DISTINCT profile_id) AS count
      FROM app_favorite_folder_items
      WHERE account_id = ?
    `).bind(accountId).first<{ count: number }>(),
    listFolderPreviewProfiles(db, accountId, apiUrl, now),
  ])
  const folders = result.results.map(row => mapFolder(row, previewProfilesByFolder.get(row.id) ?? []))
  const customFolderCount = folders.filter(folder => folder.type === 'custom').length
  return {
    folders,
    totalFavoriteCount: requireNonNegativeCount(totalRow?.count),
    customFolderCount,
    customFolderLimit,
    canCreateCustomFolder: customFolderCount < customFolderLimit,
  }
}

export async function createAppFavoriteFolder(
  db: D1Database,
  accountId: number,
  folderIdValue: string,
  input: CreateAppFavoriteFolderInput,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
): Promise<AppFavoriteFolderSummary> {
  assertPositiveAccountId(accountId)
  const policy = await requireAppInteractionCollectionPolicy(db, collectionConfig, 'favorites')
  const folderId = normalizeCustomFolderId(folderIdValue)
  const name = normalizeFolderName(input.name, policy)
  const existing = await findFolder(db, accountId, folderId)
  if (existing) {
    if (existing.folder_type !== 'custom' || normalizeStoredFolderName(existing.name) !== name.normalized) {
      throw new AppInteractionCollectionError(409, 'FAVORITE_FOLDER_ID_CONFLICT', '收藏夹标识已被其他内容使用')
    }
    return mapFolder(existing)
  }

  const customFolderLimit = await resolveCustomFolderLimit(db, accountId, membershipConfig, now)
  if (customFolderLimit <= 0) {
    throw new AppInteractionCollectionError(403, 'FAVORITE_FOLDER_ENTITLEMENT_REQUIRED', '当前会员权益不包含自定义收藏夹')
  }
  const countRow = await db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(MAX(sort_order), 0) AS max_sort_order
    FROM app_favorite_folders
    WHERE account_id = ? AND folder_type = 'custom'
  `).bind(accountId).first<{ count: number; max_sort_order: number }>()
  const currentCount = requireNonNegativeCount(countRow?.count)
  if (currentCount >= customFolderLimit) {
    throw new AppInteractionCollectionError(403, 'FAVORITE_FOLDER_LIMIT_REACHED', '自定义收藏夹数量已达到当前权益上限')
  }

  const nowIso = now.toISOString()
  const maxSortOrder = requireStoredSortOrder(countRow?.max_sort_order)
  const sortOrder = Math.min(maxSortOrder + 100, 1000000)
  try {
    const result = await db.prepare(`
      INSERT INTO app_favorite_folders (
        id, account_id, folder_type, name, normalized_name,
        sort_order, version, created_at, updated_at
      )
      SELECT ?, ?, 'custom', ?, ?, ?, 1, ?, ?
      WHERE (
        SELECT COUNT(*)
        FROM app_favorite_folders
        WHERE account_id = ? AND folder_type = 'custom'
      ) < ?
    `).bind(
      folderId,
      accountId,
      name.value,
      name.normalized,
      sortOrder,
      nowIso,
      nowIso,
      accountId,
      customFolderLimit,
    ).run()
    if ((result.meta.changes ?? 0) !== 1) {
      throw new AppInteractionCollectionError(403, 'FAVORITE_FOLDER_LIMIT_REACHED', '自定义收藏夹数量已达到当前权益上限')
    }
  }
  catch (error) {
    const byId = await findFolder(db, accountId, folderId)
    if (byId && byId.folder_type === 'custom' && normalizeStoredFolderName(byId.name) === name.normalized) {
      return mapFolder(byId)
    }
    const byName = await findFolderByNormalizedName(db, accountId, name.normalized)
    if (byName) {
      throw new AppInteractionCollectionError(409, 'FAVORITE_FOLDER_NAME_CONFLICT', '已存在同名收藏夹')
    }
    throw error
  }
  return mapFolder((await findFolder(db, accountId, folderId))!)
}

export async function updateAppFavoriteFolder(
  db: D1Database,
  accountId: number,
  folderIdValue: string,
  input: UpdateAppFavoriteFolderInput,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  now = new Date(),
): Promise<AppFavoriteFolderSummary> {
  assertPositiveAccountId(accountId)
  const policy = await requireAppInteractionCollectionPolicy(db, collectionConfig, 'favorites')
  const folderId = normalizeCustomFolderId(folderIdValue)
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  const current = await findFolder(db, accountId, folderId)
  if (!current || current.folder_type !== 'custom') throw folderNotFound()
  if (current.version !== expectedVersion) throw folderVersionConflict()
  if (input.name === undefined && input.sortOrder === undefined) {
    throw new AppInteractionCollectionError(400, 'FAVORITE_FOLDER_UPDATE_EMPTY', '请至少修改收藏夹名称或排序')
  }
  const name = input.name === undefined
    ? { value: current.name, normalized: normalizeStoredFolderName(current.name) }
    : normalizeFolderName(input.name, policy)
  const sortOrder = input.sortOrder === undefined
    ? current.sort_order
    : normalizeSortOrder(input.sortOrder)

  try {
    const result = await db.prepare(`
      UPDATE app_favorite_folders
      SET name = ?, normalized_name = ?, sort_order = ?,
          version = version + 1, updated_at = ?
      WHERE account_id = ? AND id = ? AND folder_type = 'custom' AND version = ?
    `).bind(
      name.value,
      name.normalized,
      sortOrder,
      now.toISOString(),
      accountId,
      folderId,
      expectedVersion,
    ).run()
    if ((result.meta.changes ?? 0) !== 1) throw folderVersionConflict()
  }
  catch (error) {
    if (error instanceof AppInteractionCollectionError) throw error
    const byName = await findFolderByNormalizedName(db, accountId, name.normalized)
    if (byName && byName.id !== folderId) {
      throw new AppInteractionCollectionError(409, 'FAVORITE_FOLDER_NAME_CONFLICT', '已存在同名收藏夹')
    }
    throw error
  }
  return mapFolder((await findFolder(db, accountId, folderId))!)
}

export async function deleteAppFavoriteFolder(
  db: D1Database,
  accountId: number,
  folderIdValue: string,
  expectedVersionValue: unknown,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  now = new Date(),
): Promise<AppFavoriteFolderDeleteResult> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'favorites')
  await ensureDefaultFavoriteFolder(db, accountId, now)
  const folderId = normalizeCustomFolderId(folderIdValue)
  const expectedVersion = normalizeExpectedVersion(expectedVersionValue)
  const current = await findFolder(db, accountId, folderId)
  if (!current) {
    return { folderId, deleted: false, removedItemCount: 0, removedGlobalFavoriteCount: 0 }
  }
  if (current.folder_type !== 'custom') throw defaultFolderImmutable()
  if (current.version !== expectedVersion) throw folderVersionConflict()
  const impact = await db.prepare(`
    SELECT COUNT(*) AS item_count
    FROM app_favorite_folder_items item
    WHERE item.account_id = ? AND item.folder_id = ?
  `).bind(accountId, folderId).first<{ item_count: number }>()
  const result = await db.prepare(`
    DELETE FROM app_favorite_folders
    WHERE account_id = ? AND id = ? AND folder_type = 'custom' AND version = ?
  `).bind(accountId, folderId, expectedVersion).run()
  if ((result.meta.changes ?? 0) !== 1) throw folderVersionConflict()
  return {
    folderId,
    deleted: true,
    removedItemCount: requireNonNegativeCount(impact?.item_count),
    // 兼容 1.21 返回结构；删除自定义收藏夹前，数据库触发器会把条目保留到默认收藏。
    removedGlobalFavoriteCount: 0,
  }
}

export async function getAppFavoriteState(
  db: D1Database,
  accountId: number,
  profileIdValue: string,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  now = new Date(),
): Promise<AppFavoriteMutationResult> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'favorites')
  const profileId = await requireAvailableUnblockedProfile(db, accountId, profileIdValue, now)
  return readFavoriteState(db, accountId, profileId)
}

export async function setAppGlobalFavorite(
  db: D1Database,
  accountId: number,
  profileIdValue: string,
  active: boolean,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  now = new Date(),
): Promise<AppFavoriteMutationResult> {
  assertPositiveAccountId(accountId)
  const policy = await requireAppInteractionCollectionPolicy(db, collectionConfig, 'favorites')
  const profileId = active
    ? await requireAvailableUnblockedProfile(db, accountId, profileIdValue, now)
    : normalizeAppProfileId(profileIdValue)
  if (!active) {
    await db.prepare(`
      DELETE FROM app_favorite_folder_items
      WHERE account_id = ? AND profile_id = ?
    `).bind(accountId, profileId).run()
    return readFavoriteState(db, accountId, profileId)
  }
  await ensureDefaultFavoriteFolder(db, accountId, now)
  await insertFavoriteItem(db, accountId, DEFAULT_FOLDER_ID, profileId, policy, now)
  return readFavoriteState(db, accountId, profileId)
}

export async function setAppFavoriteFolderItem(
  db: D1Database,
  accountId: number,
  folderIdValue: string,
  profileIdValue: string,
  active: boolean,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  now = new Date(),
): Promise<AppFavoriteMutationResult> {
  assertPositiveAccountId(accountId)
  const policy = await requireAppInteractionCollectionPolicy(db, collectionConfig, 'favorites')
  const folderId = normalizeFavoriteFolderId(folderIdValue)
  const folder = await findFolder(db, accountId, folderId)
  if (!folder) throw folderNotFound()
  const profileId = active
    ? await requireAvailableUnblockedProfile(db, accountId, profileIdValue, now)
    : normalizeAppProfileId(profileIdValue)
  if (active) {
    await insertFavoriteItem(db, accountId, folderId, profileId, policy, now)
  }
  else {
    await db.prepare(`
      DELETE FROM app_favorite_folder_items
      WHERE account_id = ? AND folder_id = ? AND profile_id = ?
    `).bind(accountId, folderId, profileId).run()
  }
  return readFavoriteState(db, accountId, profileId)
}

export async function listAppFavorites(
  db: D1Database,
  accountId: number,
  accountScope: string,
  folderIdValue: string | null,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  query: AppFavoriteListQuery,
  apiUrl: string,
  now = new Date(),
): Promise<{ data: AppFavoriteListItem[]; nextCursor: string | null; hasMore: boolean }> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'favorites')
  const folderId = folderIdValue ? normalizeFavoriteFolderId(folderIdValue) : null
  if (folderId && !(await findFolder(db, accountId, folderId))) throw folderNotFound()
  const itemConditions = ['item.account_id = ?']
  const bindings: unknown[] = [accountId]
  if (folderId) {
    itemConditions.push('item.folder_id = ?')
    bindings.push(folderId)
  }
  if (query.searchText || query.regionCode || query.styleTermId) {
    const profileConditions: string[] = []
    const profileBindings: unknown[] = [...publicProfileEligibilityParams(now)]
    if (query.regionCode) {
      profileConditions.push('p.region_code = ?')
      profileBindings.push(query.regionCode)
    }
    if (query.styleTermId) {
      profileConditions.push(`EXISTS (
        SELECT 1
        FROM profile_public_taxonomy_terms style_term
        WHERE style_term.profile_id = p.profile_id
          AND style_term.taxonomy_type = 'style'
          AND style_term.term_id = ?
      )`)
      profileBindings.push(query.styleTermId)
    }
    if (query.searchText) {
      const pattern = `%${escapeLikePattern(query.searchText)}%`
      profileConditions.push(`(
        p.display_name LIKE ? ESCAPE '\\'
        OR COALESCE(p.region_label, '') LIKE ? ESCAPE '\\'
        OR p.tags_json LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM profile_public_taxonomy_terms search_term
          JOIN app_taxonomy_catalog_items search_item
            ON search_item.catalog_id = search_term.catalog_id
            AND search_item.term_id = search_term.term_id
          WHERE search_term.profile_id = p.profile_id
            AND (
              search_item.display_name LIKE ? ESCAPE '\\'
              OR search_item.aliases_json LIKE ? ESCAPE '\\'
            )
        )
      )`)
      profileBindings.push(pattern, pattern, pattern, pattern, pattern)
    }
    itemConditions.push(`EXISTS (
      SELECT 1
      FROM profile_public_projections p
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE p.profile_id = item.profile_id
        AND (${PUBLIC_PROFILE_ELIGIBILITY_SQL})
        ${profileConditions.map(condition => `AND ${condition}`).join('\n        ')}
    )`)
    bindings.push(...profileBindings)
  }
  let cursorCondition = ''
  if (query.cursor) {
    cursorCondition = `
      AND (
        favorite.favorited_at < ?
        OR (favorite.favorited_at = ? AND favorite.profile_id > ?)
      )
    `
    bindings.push(query.cursor.favoritedAt, query.cursor.favoritedAt, query.cursor.profileId)
  }
  const result = await db.prepare(`
    SELECT favorite.profile_id, favorite.favorited_at
    FROM (
      SELECT item.profile_id, MAX(item.created_at) AS favorited_at
      FROM app_favorite_folder_items item
      WHERE ${itemConditions.join(' AND ')}
      GROUP BY item.profile_id
    ) favorite
    WHERE 1 = 1 ${cursorCondition}
    ORDER BY favorite.favorited_at DESC, favorite.profile_id ASC
    LIMIT ?
  `).bind(...bindings, query.limit + 1).all<FavoriteListRow>()
  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  const profileIds = rows.map(row => row.profile_id)
  const [profiles, folderIdsByProfile] = await Promise.all([
    getPublicPersonProfilesByIds(db, profileIds, apiUrl, now),
    listFolderIdsForProfiles(db, accountId, profileIds),
  ])
  const last = rows.at(-1)
  const nextCursor = hasMore && last
    ? encodeFavoriteCursor({
        v: FAVORITE_CURSOR_VERSION,
        accountScope,
        folderScope: folderId,
        searchText: query.searchText,
        regionCode: query.regionCode,
        styleTermId: query.styleTermId,
        favoritedAt: last.favorited_at,
        profileId: last.profile_id,
      })
    : null
  return {
    data: rows.map((row) => {
      const profile = profiles.get(row.profile_id) ?? null
      return {
        profileId: row.profile_id,
        favoritedAt: row.favorited_at,
        folderIds: folderIdsByProfile.get(row.profile_id) ?? [],
        profile,
        unavailableReason: profile ? null : 'PROFILE_NOT_AVAILABLE',
      }
    }),
    nextCursor,
    hasMore,
  }
}

async function listFolderPreviewProfiles(
  db: D1Database,
  accountId: number,
  apiUrl: string,
  now: Date,
): Promise<Map<string, AppFavoriteFolderPreview[]>> {
  const result = await db.prepare(`
    WITH ranked_previews AS (
      SELECT item.folder_id, item.profile_id, p.source_gallery_id, g.cover_key,
             ROW_NUMBER() OVER (
               PARTITION BY item.folder_id
               ORDER BY item.created_at DESC, item.profile_id ASC
             ) AS preview_order
      FROM app_favorite_folder_items item
      JOIN profile_public_projections p ON p.profile_id = item.profile_id
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE item.account_id = ?
        AND (${PUBLIC_PROFILE_ELIGIBILITY_SQL})
    )
    SELECT folder_id, profile_id, source_gallery_id, cover_key, preview_order
    FROM ranked_previews
    WHERE preview_order <= 4
    ORDER BY folder_id ASC, preview_order ASC
  `).bind(accountId, ...publicProfileEligibilityParams(now)).all<FolderPreviewRow>()

  const previewsByFolder = new Map<string, AppFavoriteFolderPreview[]>()
  for (const row of result.results) {
    const resolved = resolvePublicCoverUrl(row.source_gallery_id, row.cover_key)
    const coverUrl = resolved?.startsWith('/') ? new URL(resolved, apiUrl).toString() : resolved ?? null
    const previews = previewsByFolder.get(row.folder_id) ?? []
    previews.push({ profileId: row.profile_id, coverUrl })
    previewsByFolder.set(row.folder_id, previews)
  }
  return previewsByFolder
}

async function ensureDefaultFavoriteFolder(
  db: D1Database,
  accountId: number,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString()
  await db.prepare(`
    INSERT OR IGNORE INTO app_favorite_folders (
      id, account_id, folder_type, name, normalized_name,
      sort_order, version, created_at, updated_at
    ) VALUES (?, ?, 'default', ?, '__default__', 0, 1, ?, ?)
  `).bind(DEFAULT_FOLDER_ID, accountId, APP_FAVORITE_DEFAULT_FOLDER_LABEL, nowIso, nowIso).run()
}

async function insertFavoriteItem(
  db: D1Database,
  accountId: number,
  folderId: string,
  profileId: string,
  policy: AppInteractionCollectionPolicy,
  now: Date,
): Promise<void> {
  const existing = await db.prepare(`
    SELECT profile_id
    FROM app_favorite_folder_items
    WHERE account_id = ? AND folder_id = ? AND profile_id = ?
  `).bind(accountId, folderId, profileId).first<{ profile_id: string }>()
  if (existing) return
  const result = await db.prepare(`
    INSERT INTO app_favorite_folder_items (account_id, folder_id, profile_id, created_at)
    SELECT ?, folder.id, profile.profile_id, ?
    FROM app_favorite_folders folder
    JOIN profile_public_projections profile ON profile.profile_id = ?
    JOIN galleries gallery ON gallery.id = profile.source_gallery_id
    WHERE folder.account_id = ? AND folder.id = ?
      AND (${FAVORITE_PROFILE_ELIGIBILITY_SQL})
      AND NOT EXISTS (
        SELECT 1
        FROM app_profile_blocks block
        WHERE block.account_id = ?
          AND block.profile_id = ?
          AND block.state = 'blocked'
      )
      AND (
        SELECT COUNT(*)
        FROM app_favorite_folder_items item
        WHERE item.account_id = folder.account_id AND item.folder_id = folder.id
      ) < ?
    ON CONFLICT (account_id, folder_id, profile_id) DO NOTHING
  `).bind(
    accountId,
    now.toISOString(),
    profileId,
    accountId,
    folderId,
    ...publicProfileEligibilityParams(now),
    accountId,
    profileId,
    policy.maxItemsPerFolder,
  ).run()
  if ((result.meta.changes ?? 0) === 1) return
  if (!(await findFolder(db, accountId, folderId))) throw folderNotFound()
  const replay = await db.prepare(`
    SELECT profile_id
    FROM app_favorite_folder_items
    WHERE account_id = ? AND folder_id = ? AND profile_id = ?
  `).bind(accountId, folderId, profileId).first<{ profile_id: string }>()
  if (replay) return
  await requireAvailableUnblockedProfile(db, accountId, profileId, now)
  throw new AppInteractionCollectionError(403, 'FAVORITE_FOLDER_ITEM_LIMIT_REACHED', '该收藏夹已达到技术容量上限')
}

async function readFavoriteState(
  db: D1Database,
  accountId: number,
  profileId: string,
): Promise<AppFavoriteMutationResult> {
  const result = await db.prepare(`
    SELECT folder_id, created_at
    FROM app_favorite_folder_items
    WHERE account_id = ? AND profile_id = ?
    ORDER BY folder_id ASC
  `).bind(accountId, profileId).all<FavoriteStateRow>()
  const favoritedAt = result.results.reduce<string | null>((latest, row) => {
    return !latest || row.created_at > latest ? row.created_at : latest
  }, null)
  return {
    profileId,
    favorited: result.results.length > 0,
    favoritedAt,
    folderIds: result.results.map(row => row.folder_id),
  }
}

async function listFolderIdsForProfiles(
  db: D1Database,
  accountId: number,
  profileIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (profileIds.length === 0) return map
  const placeholders = profileIds.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT profile_id, folder_id
    FROM app_favorite_folder_items
    WHERE account_id = ? AND profile_id IN (${placeholders})
    ORDER BY profile_id ASC, folder_id ASC
  `).bind(accountId, ...profileIds).all<{ profile_id: string; folder_id: string }>()
  for (const row of result.results) {
    const folderIds = map.get(row.profile_id) ?? []
    folderIds.push(row.folder_id)
    map.set(row.profile_id, folderIds)
  }
  return map
}

async function resolveCustomFolderLimit(
  db: D1Database,
  accountId: number,
  config: AppMembershipRuntimeConfig,
  now: Date,
): Promise<number> {
  if (!config.enabled || !config.catalogVersionId) return 0
  try {
    const snapshot = await resolveAppMembershipSnapshot(
      db,
      accountId,
      config.catalogVersionId,
      now,
      { requireProductionReady: config.requireProductionReady },
    )
    if (!snapshot.grant || !snapshot.tier) return 0
    const entitlement = snapshot.entitlements.find(item => item.key === FAVORITE_FOLDER_ENTITLEMENT)
    if (!entitlement) {
      throw new AppInteractionCollectionError(503, 'FAVORITE_FOLDER_ENTITLEMENT_INVALID', '收藏夹权益定义缺失')
    }
    if (!entitlement.executable) return 0
    if (
      entitlement.valueType !== 'integer'
      || typeof entitlement.value !== 'number'
      || !Number.isSafeInteger(entitlement.value)
      || entitlement.value < 0
      || entitlement.value > MAX_CUSTOM_FOLDER_LIMIT
    ) {
      throw new AppInteractionCollectionError(503, 'FAVORITE_FOLDER_ENTITLEMENT_INVALID', '收藏夹权益配置异常')
    }
    return entitlement.value
  }
  catch (error) {
    if (error instanceof AppInteractionCollectionError) throw error
    if (error instanceof AppMembershipError) {
      throw new AppInteractionCollectionError(503, 'FAVORITE_FOLDER_ENTITLEMENT_NOT_READY', '收藏夹权益尚未就绪', true)
    }
    throw error
  }
}

async function findFolder(
  db: D1Database,
  accountId: number,
  folderId: string,
): Promise<FolderRow | null> {
  return db.prepare(`
    SELECT folder.id, folder.folder_type, folder.name, folder.sort_order, folder.version,
           folder.created_at, folder.updated_at, COUNT(item.profile_id) AS item_count
    FROM app_favorite_folders folder
    LEFT JOIN app_favorite_folder_items item
      ON item.account_id = folder.account_id AND item.folder_id = folder.id
    WHERE folder.account_id = ? AND folder.id = ?
    GROUP BY folder.account_id, folder.id
    LIMIT 1
  `).bind(accountId, folderId).first<FolderRow>()
}

async function findFolderByNormalizedName(
  db: D1Database,
  accountId: number,
  normalizedName: string,
): Promise<FolderRow | null> {
  return db.prepare(`
    SELECT folder.id, folder.folder_type, folder.name, folder.sort_order, folder.version,
           folder.created_at, folder.updated_at, COUNT(item.profile_id) AS item_count
    FROM app_favorite_folders folder
    LEFT JOIN app_favorite_folder_items item
      ON item.account_id = folder.account_id AND item.folder_id = folder.id
    WHERE folder.account_id = ? AND folder.normalized_name = ?
    GROUP BY folder.account_id, folder.id
    LIMIT 1
  `).bind(accountId, normalizedName).first<FolderRow>()
}

function mapFolder(
  row: FolderRow,
  previewProfiles: AppFavoriteFolderPreview[] = [],
): AppFavoriteFolderSummary {
  if (row.folder_type !== 'default' && row.folder_type !== 'custom') {
    throw new AppInteractionCollectionError(503, 'FAVORITE_FOLDER_DATA_INVALID', '收藏夹数据异常')
  }
  return {
    folderId: row.id,
    type: row.folder_type as AppFavoriteFolderType,
    name: row.name,
    sortOrder: Number(row.sort_order),
    version: Number(row.version),
    itemCount: requireNonNegativeCount(row.item_count),
    previewProfiles: previewProfiles.slice(0, 4),
    createdAt: requireStoredTime(row.created_at),
    updatedAt: requireStoredTime(row.updated_at),
  }
}

function normalizeCustomFolderId(value: unknown): string {
  const folderId = normalizeFavoriteFolderId(value)
  if (folderId === DEFAULT_FOLDER_ID) throw defaultFolderImmutable()
  return folderId
}

function normalizeFolderName(
  value: unknown,
  policy: AppInteractionCollectionPolicy,
): { value: string; normalized: string } {
  if (typeof value !== 'string') {
    throw new AppInteractionCollectionError(400, 'FAVORITE_FOLDER_NAME_INVALID', '收藏夹名称必须为文本')
  }
  const normalizedValue = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  const normalizedName = normalizeStoredFolderName(normalizedValue)
  if (
    normalizedValue.length === 0
    || normalizedValue.length > policy.maxFolderNameLength
    || containsControlCharacter(normalizedValue)
    || normalizedValue === APP_FAVORITE_DEFAULT_FOLDER_LABEL
    || normalizedName === '__default__'
  ) {
    throw new AppInteractionCollectionError(
      422,
      'FAVORITE_FOLDER_NAME_INVALID',
      `收藏夹名称应为 1～${policy.maxFolderNameLength} 个字符，且不能使用系统保留名称`,
    )
  }
  return {
    value: normalizedValue,
    normalized: normalizedName,
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1F || codePoint === 0x7F)
  })
}

function normalizeStoredFolderName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
}

function requireStoredTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AppInteractionCollectionError(503, 'FAVORITE_FOLDER_DATA_INVALID', '收藏夹时间数据异常')
  }
  return value
}

function requireNonNegativeCount(value: number | undefined): number {
  const count = Number(value ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AppInteractionCollectionError(503, 'FAVORITE_FOLDER_DATA_INVALID', '收藏夹数量数据异常')
  }
  return count
}

function requireStoredSortOrder(value: number | undefined): number {
  const sortOrder = Number(value ?? 0)
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) {
    throw new AppInteractionCollectionError(503, 'FAVORITE_FOLDER_DATA_INVALID', '收藏夹排序数据异常')
  }
  return sortOrder
}

function folderNotFound(): AppInteractionCollectionError {
  return new AppInteractionCollectionError(404, 'FAVORITE_FOLDER_NOT_FOUND', '收藏夹不存在')
}

function folderVersionConflict(): AppInteractionCollectionError {
  return new AppInteractionCollectionError(409, 'FAVORITE_FOLDER_VERSION_CONFLICT', '收藏夹已在其他设备更新，请刷新后重试', true)
}

function defaultFolderImmutable(): AppInteractionCollectionError {
  return new AppInteractionCollectionError(403, 'DEFAULT_FAVORITE_FOLDER_IMMUTABLE', '默认收藏夹不能重命名或删除')
}

function encodeFavoriteCursor(cursor: FavoriteCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeFavoriteCursor(
  value: string,
  accountScope: string,
  folderScope: string | null,
  searchText: string | null,
  regionCode: string | null,
  styleTermId: string | null,
): FavoriteCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error('cursor format')
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<FavoriteCursor>
    if (
      parsed.v !== FAVORITE_CURSOR_VERSION
      || parsed.accountScope !== accountScope
      || parsed.folderScope !== folderScope
      || parsed.searchText !== searchText
      || parsed.regionCode !== regionCode
      || parsed.styleTermId !== styleTermId
      || typeof parsed.favoritedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.favoritedAt))
      || typeof parsed.profileId !== 'string'
      || normalizeAppProfileId(parsed.profileId) !== parsed.profileId
    ) {
      throw new Error('cursor payload')
    }
    return parsed as FavoriteCursor
  }
  catch {
    throw new AppInteractionCollectionError(400, 'INVALID_CURSOR', '收藏列表游标无效或已不适用于当前范围')
  }
}

function normalizeSearchText(value: string | undefined): string | null {
  const normalized = value?.normalize('NFKC').trim().replace(/\s+/gu, ' ') || null
  if (
    normalized
    && (normalized.length > SEARCH_TEXT_MAX_LENGTH || containsControlCharacter(normalized))
  ) {
    throw new AppInteractionCollectionError(400, 'INVALID_REQUEST', '搜索文字格式不正确或超过 40 个字符')
  }
  return normalized
}

function normalizeRegionCode(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() || null
  if (normalized && !REGION_CODE_PATTERN.test(normalized)) {
    throw new AppInteractionCollectionError(400, 'INVALID_REQUEST', '地区参数格式不正确')
  }
  return normalized
}

function normalizeStyleTermId(value: string | undefined): string | null {
  const normalized = value?.trim() || null
  if (normalized && !TAXONOMY_TERM_ID_PATTERN.test(normalized)) {
    throw new AppInteractionCollectionError(400, 'INVALID_REQUEST', '风格词条参数格式不正确')
  }
  return normalized
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, match => `\\${match}`)
}
