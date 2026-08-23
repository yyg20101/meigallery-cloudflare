import type {
  AppViewerInteractionListItem,
  AppViewerInteractionState,
  AppViewerInteractionType,
} from '@meigallery/shared'
import { containsAsciiControlCharacter } from '../utils/text-safety'
import {
  getPublicPersonProfile,
  getPublicPersonProfilesByIds,
  PUBLIC_PROFILE_ELIGIBILITY_SQL,
  publicProfileEligibilityParams,
} from './app-discovery'
import { isAppProfileBlocked } from './app-safety'

export const APP_INTERACTION_DEFAULT_PAGE_SIZE = 20
export const APP_INTERACTION_MAX_PAGE_SIZE = 40

const INTERACTION_CURSOR_VERSION = 2
const PROFILE_ID_PATTERN = /^pp_[A-Za-z0-9_-]{1,77}$/
const REGION_CODE_PATTERN = /^[a-z0-9-]{2,32}$/
const TAXONOMY_TERM_ID_PATTERN = /^txt_[A-Za-z0-9_-]{4,92}$/
const SEARCH_TEXT_MAX_LENGTH = 40

type InteractionRow = {
  profile_id: string
  interaction_type: AppViewerInteractionType
  created_at: string
}

type InteractionCursor = {
  v: 2
  accountScope: string
  interactionType: AppViewerInteractionType
  searchText: string | null
  regionCode: string | null
  styleTermId: string | null
  createdAt: string
  profileId: string
}

export class AppViewerInteractionError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code:
      | 'INVALID_REQUEST'
      | 'INVALID_CURSOR'
      | 'PROFILE_NOT_AVAILABLE'
      | 'INTERACTION_FORBIDDEN',
    message: string,
  ) {
    super(message)
  }
}

export type AppViewerInteractionQuery = {
  limit: number
  searchText: string | null
  regionCode: string | null
  styleTermId: string | null
  cursor: InteractionCursor | null
}

export function parseAppViewerInteractionQuery(input: {
  limit?: string
  cursor?: string
  query?: string
  region?: string
  styleTerm?: string
  accountScope: string
  interactionType: AppViewerInteractionType
}): AppViewerInteractionQuery {
  const parsedLimit = Number.parseInt(input.limit || '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, APP_INTERACTION_MAX_PAGE_SIZE)
    : APP_INTERACTION_DEFAULT_PAGE_SIZE
  const searchText = normalizeSearchText(input.query)
  const regionCode = normalizeRegionCode(input.region)
  const styleTermId = normalizeStyleTermId(input.styleTerm)
  const cursor = input.cursor
    ? decodeInteractionCursor(
        input.cursor,
        input.accountScope,
        input.interactionType,
        searchText,
        regionCode,
        styleTermId,
      )
    : null
  return { limit, searchText, regionCode, styleTermId, cursor }
}

export async function getViewerInteractionState(
  db: D1Database,
  accountId: number,
  profileId: string,
  apiUrl: string,
  now = new Date(),
): Promise<AppViewerInteractionState> {
  requireProfileId(profileId)
  const profile = await getPublicPersonProfile(db, profileId, apiUrl, now)
  if (!profile) throw profileNotAvailable()
  return readViewerInteractionState(db, accountId, profileId)
}

export async function setViewerInteraction(
  db: D1Database,
  accountId: number,
  profileId: string,
  interactionType: AppViewerInteractionType,
  active: boolean,
  now = new Date(),
): Promise<AppViewerInteractionState> {
  requireProfileId(profileId)
  requireAccountId(accountId)
  const createdAt = now.toISOString()

  if (active) {
    if (await isAppProfileBlocked(db, accountId, profileId)) {
      throw interactionForbidden()
    }
    const result = await db.prepare(`
      INSERT INTO app_viewer_interactions (
        account_id, profile_id, interaction_type, created_at
      )
      SELECT ?, p.profile_id, ?, ?
      FROM profile_public_projections p
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE p.profile_id = ?
        AND (${PUBLIC_PROFILE_ELIGIBILITY_SQL})
        AND NOT EXISTS (
          SELECT 1 FROM app_profile_blocks block
          WHERE block.account_id = ?
            AND block.profile_id = p.profile_id
            AND block.state = 'blocked'
        )
      ON CONFLICT (account_id, profile_id, interaction_type) DO NOTHING
    `).bind(
      accountId,
      interactionType,
      createdAt,
      profileId,
      ...publicProfileEligibilityParams(now),
      accountId,
    ).run()

    if ((result.meta.changes ?? 0) === 0) {
      const existing = await db.prepare(`
        SELECT profile_id
        FROM app_viewer_interactions
        WHERE account_id = ? AND profile_id = ? AND interaction_type = ?
      `).bind(accountId, profileId, interactionType).first<{ profile_id: string }>()
      if (await isAppProfileBlocked(db, accountId, profileId)) throw interactionForbidden()
      if (!existing) throw profileNotAvailable()
    }
  }
  else {
    await db.prepare(`
      DELETE FROM app_viewer_interactions
      WHERE account_id = ? AND profile_id = ? AND interaction_type = ?
    `).bind(accountId, profileId, interactionType).run()
  }

  return readViewerInteractionState(db, accountId, profileId)
}

export async function listViewerInteractions(
  db: D1Database,
  accountId: number,
  accountScope: string,
  interactionType: AppViewerInteractionType,
  query: AppViewerInteractionQuery,
  apiUrl: string,
  now = new Date(),
): Promise<{ data: AppViewerInteractionListItem[]; nextCursor: string | null; hasMore: boolean }> {
  requireAccountId(accountId)
  const conditions = ['i.account_id = ?', 'i.interaction_type = ?']
  const params: unknown[] = [accountId, interactionType]

  if (query.searchText || query.regionCode || query.styleTermId) {
    const profileConditions: string[] = []
    const profileParams: unknown[] = [...publicProfileEligibilityParams(now)]
    if (query.regionCode) {
      profileConditions.push('p.region_code = ?')
      profileParams.push(query.regionCode)
    }
    if (query.styleTermId) {
      profileConditions.push(`EXISTS (
        SELECT 1
        FROM profile_public_taxonomy_terms style_term
        WHERE style_term.profile_id = p.profile_id
          AND style_term.taxonomy_type = 'style'
          AND style_term.term_id = ?
      )`)
      profileParams.push(query.styleTermId)
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
      profileParams.push(pattern, pattern, pattern, pattern, pattern)
    }
    conditions.push(`EXISTS (
      SELECT 1
      FROM profile_public_projections p
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE p.profile_id = i.profile_id
        AND (${PUBLIC_PROFILE_ELIGIBILITY_SQL})
        ${profileConditions.map(condition => `AND ${condition}`).join('\n        ')}
    )`)
    params.push(...profileParams)
  }

  if (query.cursor) {
    conditions.push('(i.created_at < ? OR (i.created_at = ? AND i.profile_id > ?))')
    params.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.profileId)
  }

  const result = await db.prepare(`
    SELECT i.profile_id, i.interaction_type, i.created_at
    FROM app_viewer_interactions i
    WHERE ${conditions.join(' AND ')}
    ORDER BY i.created_at DESC, i.profile_id ASC
    LIMIT ?
  `).bind(...params, query.limit + 1).all<InteractionRow>()

  const hasMore = result.results.length > query.limit
  const pageRows = result.results.slice(0, query.limit)
  const profiles = await getPublicPersonProfilesByIds(
    db,
    pageRows.map(row => row.profile_id),
    apiUrl,
    now,
  )
  const lastRow = pageRows.at(-1)
  const nextCursor = hasMore && lastRow
    ? encodeInteractionCursor({
        v: INTERACTION_CURSOR_VERSION,
        accountScope,
        interactionType,
        searchText: query.searchText,
        regionCode: query.regionCode,
        styleTermId: query.styleTermId,
        createdAt: lastRow.created_at,
        profileId: lastRow.profile_id,
      })
    : null

  return {
    data: pageRows.map((row) => {
      const profile = profiles.get(row.profile_id) ?? null
      return {
        profileId: row.profile_id,
        interactionType,
        createdAt: row.created_at,
        profile,
        unavailableReason: profile ? null : 'PROFILE_NOT_AVAILABLE',
      }
    }),
    nextCursor,
    hasMore,
  }
}

async function readViewerInteractionState(
  db: D1Database,
  accountId: number,
  profileId: string,
): Promise<AppViewerInteractionState> {
  const result = await db.prepare(`
    SELECT interaction_type, created_at
    FROM app_viewer_interactions
    WHERE account_id = ? AND profile_id = ?
      AND interaction_type IN ('like', 'follow')
  `).bind(accountId, profileId).all<Pick<InteractionRow, 'interaction_type' | 'created_at'>>()
  const likedAt = result.results.find(row => row.interaction_type === 'like')?.created_at ?? null
  const followedAt = result.results.find(row => row.interaction_type === 'follow')?.created_at ?? null
  return {
    profileId,
    liked: likedAt !== null,
    followed: followedAt !== null,
    likedAt,
    followedAt,
  }
}

function requireAccountId(accountId: number) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error('APP_INTERACTION_ACCOUNT_INVALID')
  }
}

function requireProfileId(profileId: string) {
  if (!PROFILE_ID_PATTERN.test(profileId)) throw profileNotAvailable()
}

function profileNotAvailable() {
  return new AppViewerInteractionError(404, 'PROFILE_NOT_AVAILABLE', '人物资料不存在或当前不可见')
}

function interactionForbidden() {
  return new AppViewerInteractionError(
    403,
    'INTERACTION_FORBIDDEN',
    '你已拉黑该人物资料，无法添加喜欢或关注',
  )
}

function encodeInteractionCursor(cursor: InteractionCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeInteractionCursor(
  value: string,
  accountScope: string,
  interactionType: AppViewerInteractionType,
  searchText: string | null,
  regionCode: string | null,
  styleTermId: string | null,
): InteractionCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error('cursor format')
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<InteractionCursor>
    if (
      parsed.v !== INTERACTION_CURSOR_VERSION
      || parsed.accountScope !== accountScope
      || parsed.interactionType !== interactionType
      || parsed.searchText !== searchText
      || parsed.regionCode !== regionCode
      || parsed.styleTermId !== styleTermId
      || typeof parsed.createdAt !== 'string'
      || parsed.createdAt.length > 40
      || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.profileId !== 'string'
      || !PROFILE_ID_PATTERN.test(parsed.profileId)
    ) {
      throw new Error('cursor payload')
    }
    return parsed as InteractionCursor
  }
  catch {
    throw new AppViewerInteractionError(400, 'INVALID_CURSOR', '分页游标无效或已不适用于当前列表')
  }
}

function normalizeSearchText(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/gu, ' ') || null
  if (
    normalized
    && (
      normalized.length > SEARCH_TEXT_MAX_LENGTH
      || containsAsciiControlCharacter(normalized)
    )
  ) {
    throw invalidRequest('搜索文字格式不正确或超过 40 个字符')
  }
  return normalized
}

function normalizeRegionCode(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() || null
  if (normalized && !REGION_CODE_PATTERN.test(normalized)) {
    throw invalidRequest('地区参数格式不正确')
  }
  return normalized
}

function normalizeStyleTermId(value: string | undefined): string | null {
  const normalized = value?.trim() || null
  if (normalized && !TAXONOMY_TERM_ID_PATTERN.test(normalized)) {
    throw invalidRequest('风格词条参数格式不正确')
  }
  return normalized
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, match => `\\${match}`)
}

function invalidRequest(message: string): AppViewerInteractionError {
  return new AppViewerInteractionError(400, 'INVALID_REQUEST', message)
}
