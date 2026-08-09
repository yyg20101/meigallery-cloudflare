import type {
  AppPersonSearchItem,
  AppPersonSearchMatchField,
  AppPersonSearchSort,
} from '@meigallery/shared'
import {
  PUBLIC_TAXONOMY_SELECT,
  mapPublicProfile,
  type PublicProjectionRow,
} from './app-discovery'
import type { AppResolvedPersonFilterSelection } from './app-search-filters'
import {
  APP_PERSON_SEARCH_DEFAULT_PAGE_SIZE,
  APP_PERSON_SEARCH_MAX_PAGE_SIZE,
  AppPersonSearchError,
  assertPositiveSearchAccountId,
  normalizeAppPersonSearchText,
  type AppPersonSearchPolicy,
} from './app-person-search-policy'

export const APP_PERSON_SEARCH_SORTS: AppPersonSearchSort[] = ['relevance', 'popular', 'latest']

const SEARCH_CURSOR_VERSION = 2
const PROFILE_ID_PATTERN = /^pp_[A-Za-z0-9_-]{1,77}$/u
const HASH_PATTERN = /^[0-9a-f]{64}$/u

type PersonSearchCursor = {
  v: 2
  accountScope: string
  queryHash: string
  filterHash: string
  sort: AppPersonSearchSort
  score: number | null
  heatScore: number | null
  publishedAt: string
  profileId: string
}

type PersonSearchRow = PublicProjectionRow & {
  relevance_score: number
  match_field: string
}

type SearchWhere = {
  sql: string
  bindings: unknown[]
}

export interface AppPersonSearchInput {
  query?: unknown
  filters?: unknown
  sort?: unknown
  limit?: unknown
  cursor?: unknown
}

export interface AppPersonSearchQuery {
  text: string | null
  foldedText: string | null
  queryHash: string
  filterHash: string
  filters: AppResolvedPersonFilterSelection | null
  sort: AppPersonSearchSort
  limit: number
  cursor: PersonSearchCursor | null
}

export async function parseAppPersonSearchInput(
  value: unknown,
  accountScope: string,
  policy: AppPersonSearchPolicy,
  filters: AppResolvedPersonFilterSelection | null = null,
  options: { preview?: boolean } = {},
): Promise<AppPersonSearchQuery> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppPersonSearchError(400, 'PERSON_SEARCH_REQUEST_INVALID', '搜索请求必须为 JSON 对象')
  }
  const allowedFields = options.preview
    ? ['query', 'filters', 'sort']
    : ['query', 'filters', 'sort', 'limit', 'cursor']
  if (Object.keys(value).some(key => !allowedFields.includes(key))) {
    throw new AppPersonSearchError(400, 'PERSON_SEARCH_REQUEST_INVALID', '搜索请求包含未支持字段')
  }
  const input = value as AppPersonSearchInput
  const text = input.query === undefined
    ? null
    : normalizeAppPersonSearchText(input.query, policy.maxQueryLength)
  if (!text && !filters) {
    throw new AppPersonSearchError(
      400,
      'PERSON_SEARCH_CRITERIA_REQUIRED',
      '请提供搜索词或结构化筛选条件',
    )
  }
  const foldedText = text?.toLowerCase() ?? null
  const queryHash = await sha256Hex(`${accountScope}\u0000${foldedText ?? ''}`)
  const filterHash = filters?.filterHash ?? await sha256Hex('none')
  const defaultSort: AppPersonSearchSort = text ? 'relevance' : 'popular'
  const sortValue = input.sort === undefined ? defaultSort : input.sort
  if (typeof sortValue !== 'string' || !APP_PERSON_SEARCH_SORTS.includes(sortValue as AppPersonSearchSort)) {
    throw new AppPersonSearchError(400, 'PERSON_SEARCH_SORT_INVALID', '不支持的人物搜索排序方式')
  }
  if (!text && sortValue === 'relevance') {
    throw new AppPersonSearchError(
      400,
      'PERSON_SEARCH_SORT_INVALID',
      '仅使用筛选条件时不能按相关度排序',
    )
  }
  const limit = options.preview
    ? APP_PERSON_SEARCH_DEFAULT_PAGE_SIZE
    : normalizeSearchLimit(input.limit)
  const sort = sortValue as AppPersonSearchSort
  const cursor = options.preview || input.cursor === undefined || input.cursor === null || input.cursor === ''
    ? null
    : decodeSearchCursor(input.cursor, accountScope, queryHash, filterHash, sort)
  return { text, foldedText, queryHash, filterHash, filters, sort, limit, cursor }
}

export async function searchPublicPersonProfiles(
  db: D1Database,
  accountId: number,
  accountScope: string,
  query: AppPersonSearchQuery,
  apiUrl: string,
  now = new Date(),
): Promise<{ data: AppPersonSearchItem[]; nextCursor: string | null; hasMore: boolean }> {
  assertPositiveSearchAccountId(accountId)
  const where = buildSearchWhere(query, accountId, now.toISOString())
  const score = buildRelevanceSelect(query)
  const bindings: unknown[] = [...score.bindings, ...where.bindings]
  const scoreColumn = query.sort === 'relevance'
    ? 'relevance_score'
    : query.sort === 'popular'
      ? 'heat_score'
      : null
  const cursorCondition = query.cursor
    ? query.sort === 'relevance'
      ? `WHERE (
          relevance_score < ?
          OR (
            relevance_score = ?
            AND (
              heat_score < ?
              OR (
                heat_score = ?
                AND (
                  published_at < ?
                  OR (published_at = ? AND profile_id > ?)
                )
              )
            )
          )
        )`
      : query.sort === 'popular'
        ? `WHERE (
            heat_score < ?
            OR (
              heat_score = ?
              AND (
                published_at < ?
                OR (published_at = ? AND profile_id > ?)
              )
            )
          )`
        : `WHERE (
          published_at < ?
          OR (published_at = ? AND profile_id > ?)
        )`
    : ''
  if (query.cursor) {
    if (query.sort === 'relevance') {
      bindings.push(
        query.cursor.score,
        query.cursor.score,
        query.cursor.heatScore,
        query.cursor.heatScore,
        query.cursor.publishedAt,
        query.cursor.publishedAt,
        query.cursor.profileId,
      )
    }
    else if (query.sort === 'popular') {
      bindings.push(
        query.cursor.score,
        query.cursor.score,
        query.cursor.publishedAt,
        query.cursor.publishedAt,
        query.cursor.profileId,
      )
    }
    else {
      bindings.push(
        query.cursor.publishedAt,
        query.cursor.publishedAt,
        query.cursor.profileId,
      )
    }
  }
  const orderBy = query.sort === 'relevance'
    ? 'relevance_score DESC, heat_score DESC, published_at DESC, profile_id ASC'
    : query.sort === 'popular'
      ? 'heat_score DESC, published_at DESC, profile_id ASC'
      : 'published_at DESC, profile_id ASC'

  const result = await db.prepare(`
    WITH candidates AS (
      SELECT
        p.profile_id,
        p.person_id,
        p.display_name,
        p.summary,
        p.source_gallery_id,
        g.cover_key,
        p.tags_json,
        p.operation_mode,
        p.operation_label,
        p.region_code,
        p.region_label,
        p.region_precision,
        p.recommendation_score,
        p.heat_score,
        p.recommendation_reason_code,
        p.recommendation_rule_version,
        p.published_at,
        ${PUBLIC_TAXONOMY_SELECT} AS taxonomy_json,
        ${score.sql}
      FROM profile_public_projections p
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE ${where.sql}
    )
    SELECT *
    FROM candidates
    ${cursorCondition}
    ORDER BY ${orderBy}
    LIMIT ?
  `).bind(...bindings, query.limit + 1).all<PersonSearchRow>()

  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  const last = rows.at(-1)
  const nextCursor = hasMore && last
    ? encodeSearchCursor({
        v: SEARCH_CURSOR_VERSION,
        accountScope,
        queryHash: query.queryHash,
        filterHash: query.filterHash,
        sort: query.sort,
        score: scoreColumn ? requireScore(last[scoreColumn]) : null,
        heatScore: query.sort === 'relevance' ? requireScore(last.heat_score) : null,
        publishedAt: last.published_at,
        profileId: last.profile_id,
      })
    : null
  return {
    data: rows.map((row) => {
      const profile = mapPublicProfile(row, apiUrl)
      const field = normalizeMatchField(row.match_field)
      return {
        profile,
        match: {
          field,
          label: matchLabel(field, profile, query.foldedText),
        },
      }
    }),
    nextCursor,
    hasMore,
  }
}

export async function countPublicPersonSearchResults(
  db: D1Database,
  accountId: number,
  query: AppPersonSearchQuery,
  now = new Date(),
): Promise<number> {
  assertPositiveSearchAccountId(accountId)
  const where = buildSearchWhere(query, accountId, now.toISOString())
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM profile_public_projections p
    JOIN galleries g ON g.id = p.source_gallery_id
    WHERE ${where.sql}
  `).bind(...where.bindings).first<{ count: number }>()
  const count = Number(row?.count ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AppPersonSearchError(503, 'PERSON_SEARCH_DATA_INVALID', '人物搜索结果计数异常')
  }
  return count
}

function buildSearchWhere(
  query: AppPersonSearchQuery,
  accountId: number,
  nowIso: string,
): SearchWhere {
  const conditions = [
    "p.verification_status = 'verified'",
    "p.publication_status = 'published'",
    "p.authorization_status = 'active'",
    "p.visibility_status = 'visible'",
    '(p.authorization_valid_from IS NULL OR datetime(p.authorization_valid_from) <= datetime(?))',
    '(p.authorization_valid_until IS NULL OR datetime(p.authorization_valid_until) > datetime(?))',
    '(p.verification_valid_until IS NULL OR datetime(p.verification_valid_until) > datetime(?))',
    'datetime(p.published_at) IS NOT NULL',
    "g.status = 'published'",
    `NOT EXISTS (
      SELECT 1
      FROM app_profile_blocks block
      WHERE block.account_id = ?
        AND block.profile_id = p.profile_id
        AND block.state = 'blocked'
    )`,
  ]
  const bindings: unknown[] = [nowIso, nowIso, nowIso, accountId]
  if (query.foldedText) {
    const contains = `%${escapeLike(query.foldedText)}%`
    conditions.push(`(
      p.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR p.region_label LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR p.region_code COLLATE NOCASE = ?
      OR EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(p.tags_json) THEN p.tags_json ELSE '[]' END) tag
        WHERE tag.type = 'text'
          AND CAST(tag.key AS INTEGER) BETWEEN 0 AND 7
          AND length(CAST(tag.value AS TEXT)) BETWEEN 1 AND 40
          AND CAST(tag.value AS TEXT) LIKE ? ESCAPE '\\' COLLATE NOCASE
      )
    )`)
    bindings.push(contains, contains, query.foldedText, contains)
  }
  for (const group of query.filters?.groups ?? []) {
    const placeholders = group.termIds.map(() => '?').join(', ')
    conditions.push(`EXISTS (
      SELECT 1
      FROM profile_public_taxonomy_terms selected_taxonomy
      JOIN app_taxonomy_catalog_closure taxonomy_closure
        ON taxonomy_closure.catalog_id = ?
       AND taxonomy_closure.descendant_term_id = selected_taxonomy.term_id
      WHERE selected_taxonomy.profile_id = p.profile_id
        AND taxonomy_closure.ancestor_term_id IN (${placeholders})
    )`)
    bindings.push(query.filters!.catalogVersionId, ...group.termIds)
  }
  return { sql: conditions.join('\n      AND '), bindings }
}

function buildRelevanceSelect(query: AppPersonSearchQuery): SearchWhere {
  if (!query.foldedText) {
    return { sql: "0 AS relevance_score, 'filter' AS match_field", bindings: [] }
  }
  const escaped = escapeLike(query.foldedText)
  const contains = `%${escaped}%`
  const prefix = `${escaped}%`
  return {
    sql: `CASE
      WHEN p.display_name COLLATE NOCASE = ? THEN 500
      WHEN p.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 450
      WHEN p.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 400
      WHEN p.region_label COLLATE NOCASE = ? OR p.region_code COLLATE NOCASE = ? THEN 350
      WHEN EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(p.tags_json) THEN p.tags_json ELSE '[]' END) tag
        WHERE tag.type = 'text'
          AND CAST(tag.key AS INTEGER) BETWEEN 0 AND 7
          AND length(CAST(tag.value AS TEXT)) BETWEEN 1 AND 40
          AND CAST(tag.value AS TEXT) COLLATE NOCASE = ?
      ) THEN 300
      WHEN p.region_label LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 250
      ELSE 200
    END AS relevance_score,
    CASE
      WHEN p.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 'display_name'
      WHEN p.region_label LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR p.region_code COLLATE NOCASE = ? THEN 'region'
      ELSE 'tag'
    END AS match_field`,
    bindings: [
      query.foldedText,
      prefix,
      contains,
      query.foldedText,
      query.foldedText,
      query.foldedText,
      contains,
      contains,
      contains,
      query.foldedText,
    ],
  }
}

function normalizeSearchLimit(value: unknown): number {
  if (value === undefined || value === null) return APP_PERSON_SEARCH_DEFAULT_PAGE_SIZE
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > APP_PERSON_SEARCH_MAX_PAGE_SIZE) {
    throw new AppPersonSearchError(
      400,
      'PERSON_SEARCH_LIMIT_INVALID',
      `limit 必须为 1 至 ${APP_PERSON_SEARCH_MAX_PAGE_SIZE} 的整数`,
    )
  }
  return Number(value)
}

function normalizeMatchField(value: string): AppPersonSearchMatchField {
  if (value === 'display_name' || value === 'region' || value === 'filter') return value
  return 'tag'
}

function matchLabel(
  field: AppPersonSearchMatchField,
  profile: AppPersonSearchItem['profile'],
  foldedText: string | null,
): string {
  if (field === 'display_name') return profile.displayName
  if (field === 'region') return profile.region?.label ?? '公开地区'
  if (field === 'filter') return '符合筛选条件'
  return foldedText
    ? profile.tags.find(tag => tag.toLowerCase().includes(foldedText)) ?? '公开标签'
    : '公开标签'
}

function requireScore(value: number): number {
  const score = Number(value)
  if (!Number.isSafeInteger(score) || score < 0) {
    throw new AppPersonSearchError(503, 'PERSON_SEARCH_DATA_INVALID', '人物搜索排序数据异常')
  }
  return score
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, character => `\\${character}`)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function encodeSearchCursor(cursor: PersonSearchCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeSearchCursor(
  value: unknown,
  accountScope: string,
  queryHash: string,
  filterHash: string,
  sort: AppPersonSearchSort,
): PersonSearchCursor {
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) {
      throw new Error('cursor format')
    }
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PersonSearchCursor>
    const validScore = parsed.score === null
      || (typeof parsed.score === 'number' && Number.isSafeInteger(parsed.score) && parsed.score >= 0)
    const validHeatScore = parsed.heatScore === null
      || (typeof parsed.heatScore === 'number'
        && Number.isSafeInteger(parsed.heatScore)
        && parsed.heatScore >= 0)
    if (
      parsed.v !== SEARCH_CURSOR_VERSION
      || parsed.accountScope !== accountScope
      || parsed.queryHash !== queryHash
      || parsed.filterHash !== filterHash
      || !HASH_PATTERN.test(parsed.queryHash ?? '')
      || !HASH_PATTERN.test(parsed.filterHash ?? '')
      || parsed.sort !== sort
      || !validScore
      || !validHeatScore
      || typeof parsed.publishedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.publishedAt))
      || typeof parsed.profileId !== 'string'
      || !PROFILE_ID_PATTERN.test(parsed.profileId)
      || (sort === 'latest' ? parsed.score !== null : typeof parsed.score !== 'number')
      || (sort === 'relevance'
        ? typeof parsed.heatScore !== 'number'
        : parsed.heatScore !== null)
    ) {
      throw new Error('cursor payload')
    }
    return parsed as PersonSearchCursor
  }
  catch {
    throw new AppPersonSearchError(
      400,
      'PERSON_SEARCH_CURSOR_INVALID',
      '搜索分页游标无效，或已不适用于当前账号、搜索词、筛选条件和排序方式',
    )
  }
}
