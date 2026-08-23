import type {
  AppDiscoveryRegion,
  AppDiscoverySort,
  AppPersonProfile,
  AppPersonRegion,
} from '@meigallery/shared'
import { resolvePublicCoverUrl } from '../utils/cover-url'

export const APP_DISCOVERY_DEFAULT_PAGE_SIZE = 20
export const APP_DISCOVERY_MAX_PAGE_SIZE = 40
export const APP_DISCOVERY_SORTS: AppDiscoverySort[] = ['recommended', 'popular', 'latest']

const DISCOVERY_CURSOR_VERSION = 1
const DISCOVERY_RULE_VERSION = 'discovery_v1'
const REGION_CODE_PATTERN = /^[a-z0-9-]{2,32}$/
const PROFILE_ID_PATTERN = /^pp_[A-Za-z0-9_-]{1,77}$/

const SQL_ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * 所有面向观看者的人物读取与写入目标校验必须复用这一资格表达式。
 * 调用方依次绑定三个相同的 UTC now 参数，且必须继续 JOIN 已发布图库。
 */
export function publicProfileEligibilitySql(
  profileAlias = 'p',
  galleryAlias = 'g',
): string {
  if (!SQL_ALIAS_PATTERN.test(profileAlias) || !SQL_ALIAS_PATTERN.test(galleryAlias)) {
    throw new Error('PUBLIC_PROFILE_ELIGIBILITY_ALIAS_INVALID')
  }
  return `
  ${profileAlias}.verification_status = 'verified'
  AND ${profileAlias}.publication_status = 'published'
  AND ${profileAlias}.authorization_status = 'active'
  AND ${profileAlias}.visibility_status = 'visible'
  AND ${profileAlias}.operation_mode = 'platform_managed'
  AND (
    ${profileAlias}.authorization_valid_from IS NULL
    OR (
      datetime(${profileAlias}.authorization_valid_from) IS NOT NULL
      AND datetime(${profileAlias}.authorization_valid_from) <= datetime(?)
    )
  )
  AND (
    ${profileAlias}.authorization_valid_until IS NULL
    OR (
      datetime(${profileAlias}.authorization_valid_until) IS NOT NULL
      AND datetime(${profileAlias}.authorization_valid_until) > datetime(?)
    )
  )
  AND (
    ${profileAlias}.verification_valid_until IS NULL
    OR (
      datetime(${profileAlias}.verification_valid_until) IS NOT NULL
      AND datetime(${profileAlias}.verification_valid_until) > datetime(?)
    )
  )
  AND datetime(${profileAlias}.published_at) IS NOT NULL
  AND ${galleryAlias}.status = 'published'
`
}

export const PUBLIC_PROFILE_ELIGIBILITY_SQL = publicProfileEligibilitySql()

export function publicProfileEligibilityParams(now: Date): [string, string, string] {
  const value = now.toISOString()
  return [value, value, value]
}

export type PublicProjectionRow = {
  profile_id: string
  person_id: string
  display_name: string
  summary: string | null
  source_gallery_id: string
  cover_key: string | null
  tags_json: string
  operation_mode: string
  operation_label: string
  region_code: string | null
  region_label: string | null
  region_precision: string | null
  recommendation_score: number
  heat_score: number
  recommendation_reason_code: string
  recommendation_rule_version: string
  published_at: string
  taxonomy_json: string
}

type DiscoveryCursor = {
  v: 1
  sort: AppDiscoverySort
  regionCode: string | null
  score: number | null
  publishedAt: string
  profileId: string
  ruleVersion: string
}

export class AppDiscoveryQueryError extends Error {
  constructor(
    readonly code: 'INVALID_DISCOVERY_SORT' | 'INVALID_REGION' | 'INVALID_CURSOR',
    message: string,
  ) {
    super(message)
  }
}

export type AppDiscoveryQuery = {
  sort: AppDiscoverySort
  regionCode: string | null
  limit: number
  cursor: DiscoveryCursor | null
}

export function parseAppDiscoveryQuery(input: {
  sort?: string
  region?: string
  limit?: string
  cursor?: string
}): AppDiscoveryQuery {
  const sort = input.sort?.trim() || 'recommended'
  if (!APP_DISCOVERY_SORTS.some(value => value === sort)) {
    throw new AppDiscoveryQueryError('INVALID_DISCOVERY_SORT', '不支持的发现页排序方式')
  }

  const rawRegion = input.region?.trim().toLowerCase() || null
  if (rawRegion && !REGION_CODE_PATTERN.test(rawRegion)) {
    throw new AppDiscoveryQueryError('INVALID_REGION', '地区参数格式不正确')
  }

  const parsedLimit = Number.parseInt(input.limit || '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, APP_DISCOVERY_MAX_PAGE_SIZE)
    : APP_DISCOVERY_DEFAULT_PAGE_SIZE

  const typedSort = sort as AppDiscoverySort
  const cursor = input.cursor ? decodeDiscoveryCursor(input.cursor, typedSort, rawRegion) : null
  return { sort: typedSort, regionCode: rawRegion, limit, cursor }
}

export async function listPublicPersonProfiles(
  db: D1Database,
  query: AppDiscoveryQuery,
  apiUrl: string,
  now = new Date(),
  viewerAccountInternalId: number | null = null,
): Promise<{ data: AppPersonProfile[]; nextCursor: string | null; hasMore: boolean }> {
  const conditions = [`(${PUBLIC_PROFILE_ELIGIBILITY_SQL})`]
  const params: unknown[] = publicProfileEligibilityParams(now)

  if (viewerAccountInternalId !== null) {
    conditions.push(`NOT EXISTS (
      SELECT 1
      FROM app_profile_blocks block
      WHERE block.account_id = ?
        AND block.profile_id = p.profile_id
        AND block.state = 'blocked'
    )`)
    params.push(viewerAccountInternalId)
  }

  if (query.regionCode) {
    conditions.push('p.region_code = ?')
    params.push(query.regionCode)
  }

  const scoreColumn = scoreColumnFor(query.sort)
  if (query.cursor) {
    if (scoreColumn) {
      conditions.push(`(
        p.${scoreColumn} < ?
        OR (
          p.${scoreColumn} = ?
          AND (
            p.published_at < ?
            OR (p.published_at = ? AND p.profile_id > ?)
          )
        )
      )`)
      params.push(
        query.cursor.score,
        query.cursor.score,
        query.cursor.publishedAt,
        query.cursor.publishedAt,
        query.cursor.profileId,
      )
    } else {
      conditions.push('(p.published_at < ? OR (p.published_at = ? AND p.profile_id > ?))')
      params.push(query.cursor.publishedAt, query.cursor.publishedAt, query.cursor.profileId)
    }
  }

  const orderBy = scoreColumn
    ? `p.${scoreColumn} DESC, p.published_at DESC, p.profile_id ASC`
    : 'p.published_at DESC, p.profile_id ASC'

  const result = await db
    .prepare(`
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
        ${PUBLIC_TAXONOMY_SELECT} AS taxonomy_json
      FROM profile_public_projections p
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY ${orderBy}
      LIMIT ?
    `)
    .bind(...params, query.limit + 1)
    .all<PublicProjectionRow>()

  const hasMore = result.results.length > query.limit
  const pageRows = result.results.slice(0, query.limit)
  const lastRow = pageRows.at(-1)
  const nextCursor = hasMore && lastRow
    ? encodeDiscoveryCursor({
        v: DISCOVERY_CURSOR_VERSION,
        sort: query.sort,
        regionCode: query.regionCode,
        score: scoreColumn ? Number(lastRow[scoreColumn]) : null,
        publishedAt: lastRow.published_at,
        profileId: lastRow.profile_id,
        ruleVersion: DISCOVERY_RULE_VERSION,
      })
    : null

  return {
    data: pageRows.map(row => mapPublicProfile(row, apiUrl)),
    nextCursor,
    hasMore,
  }
}

export async function listPublicDiscoveryRegions(
  db: D1Database,
  now = new Date(),
): Promise<AppDiscoveryRegion[]> {
  const result = await db
    .prepare(`
      SELECT p.region_code, p.region_label, COUNT(*) AS profile_count
      FROM profile_public_projections p
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE ${PUBLIC_PROFILE_ELIGIBILITY_SQL}
        AND p.region_code IS NOT NULL
        AND p.region_label IS NOT NULL
      GROUP BY p.region_code, p.region_label
      ORDER BY profile_count DESC, p.region_code ASC
      LIMIT 100
    `)
    .bind(...publicProfileEligibilityParams(now))
    .all<{ region_code: string; region_label: string; profile_count: number }>()

  return result.results.map(row => ({
    code: row.region_code,
    label: row.region_label,
    profileCount: Number(row.profile_count),
  }))
}

export async function getPublicPersonProfile(
  db: D1Database,
  profileId: string,
  apiUrl: string,
  now = new Date(),
): Promise<AppPersonProfile | null> {
  if (!PROFILE_ID_PATTERN.test(profileId)) return null

  const row = await db
    .prepare(`
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
        ${PUBLIC_TAXONOMY_SELECT} AS taxonomy_json
      FROM profile_public_projections p
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE p.profile_id = ?
        AND ${PUBLIC_PROFILE_ELIGIBILITY_SQL}
      LIMIT 1
    `)
    .bind(profileId, ...publicProfileEligibilityParams(now))
    .first<PublicProjectionRow>()

  return row ? mapPublicProfile(row, apiUrl) : null
}

export async function getPublicPersonProfilesByIds(
  db: D1Database,
  profileIds: string[],
  apiUrl: string,
  now = new Date(),
  viewerAccountInternalId: number | null = null,
): Promise<Map<string, AppPersonProfile>> {
  const ids = [...new Set(profileIds.filter(profileId => PROFILE_ID_PATTERN.test(profileId)))].slice(0, 40)
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(', ')
  const conditions = [
    `p.profile_id IN (${placeholders})`,
    `(${PUBLIC_PROFILE_ELIGIBILITY_SQL})`,
  ]
  const params: unknown[] = [...ids, ...publicProfileEligibilityParams(now)]
  if (viewerAccountInternalId !== null) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM app_profile_blocks block
      WHERE block.account_id = ?
        AND block.profile_id = p.profile_id
        AND block.state = 'blocked'
    )`)
    params.push(viewerAccountInternalId)
  }
  const result = await db.prepare(`
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
      ${PUBLIC_TAXONOMY_SELECT} AS taxonomy_json
    FROM profile_public_projections p
    JOIN galleries g ON g.id = p.source_gallery_id
    WHERE ${conditions.join('\n      AND ')}
  `).bind(...params)
    .all<PublicProjectionRow>()

  return new Map(result.results.map(row => [row.profile_id, mapPublicProfile(row, apiUrl)]))
}

function scoreColumnFor(sort: AppDiscoverySort): 'recommendation_score' | 'heat_score' | null {
  if (sort === 'recommended') return 'recommendation_score'
  if (sort === 'popular') return 'heat_score'
  return null
}

export function mapPublicProfile(row: PublicProjectionRow, apiUrl: string): AppPersonProfile {
  const region = mapRegion(row)
  const operationMode = row.operation_mode === 'self_managed' ? 'self_managed' : 'platform_managed'
  const operationLabel = operationMode === 'platform_managed'
    ? '消息由平台运营接收'
    : safeLabel(row.operation_label, '资料由本人运营')
  const coverUrl = resolveAbsoluteCoverUrl(row, apiUrl)

  return {
    profileId: row.profile_id,
    personId: row.person_id,
    displayName: row.display_name,
    summary: row.summary,
    coverUrl,
    verification: {
      status: 'verified',
      label: '真人资料已认证',
    },
    operation: {
      mode: operationMode,
      label: operationLabel,
    },
    region,
    tags: parsePublicTags(row.tags_json),
    taxonomyTerms: parsePublicTaxonomyTerms(row.taxonomy_json),
    recommendation: {
      mode: 'rule_based',
      reasonCode: safeLabel(row.recommendation_reason_code, 'EDITORIAL_QUALITY'),
      ruleVersion: safeLabel(row.recommendation_rule_version, DISCOVERY_RULE_VERSION),
    },
    publishedAt: row.published_at,
  }
}

function mapRegion(row: PublicProjectionRow): AppPersonRegion | null {
  if (!row.region_code || !row.region_label) return null
  if (!REGION_CODE_PATTERN.test(row.region_code)) return null
  if (!['city', 'province', 'country', 'broad'].includes(row.region_precision || '')) return null
  return {
    code: row.region_code,
    label: row.region_label,
    precision: row.region_precision as AppPersonRegion['precision'],
  }
}

function resolveAbsoluteCoverUrl(row: PublicProjectionRow, apiUrl: string) {
  const coverUrl = resolvePublicCoverUrl(row.source_gallery_id, row.cover_key)
  if (!coverUrl) return null
  if (!coverUrl.startsWith('/')) return coverUrl
  return new URL(coverUrl, apiUrl).toString()
}

function safeLabel(value: string, fallback: string) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, 80) : fallback
}

function parsePublicTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(
      parsed
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.trim())
        .filter(value => value.length > 0 && value.length <= 40),
    )].slice(0, 8)
  } catch {
    return []
  }
}

function parsePublicTaxonomyTerms(raw: string): AppPersonProfile['taxonomyTerms'] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const item = value as Record<string, unknown>
      if (
        typeof item.termId !== 'string'
        || typeof item.type !== 'string'
        || typeof item.displayName !== 'string'
        || typeof item.catalogVersionId !== 'string'
        || !Number.isSafeInteger(item.termVersion)
      ) return []
      return [{
        termId: item.termId,
        type: item.type as AppPersonProfile['taxonomyTerms'][number]['type'],
        displayName: item.displayName,
        catalogVersionId: item.catalogVersionId,
        termVersion: Number(item.termVersion),
      }]
    }).slice(0, 30)
  }
  catch {
    return []
  }
}

export const PUBLIC_TAXONOMY_SELECT = `
  COALESCE((
    SELECT json_group_array(json_object(
      'termId', taxonomy_items.term_id,
      'type', taxonomy_items.taxonomy_type,
      'displayName', taxonomy_items.display_name,
      'catalogVersionId', taxonomy_items.catalog_id,
      'termVersion', taxonomy_items.catalog_term_version
    ))
    FROM (
      SELECT pt.term_id, pt.taxonomy_type, i.display_name,
             pt.catalog_id, pt.catalog_term_version
      FROM profile_public_taxonomy_terms pt
      JOIN app_taxonomy_catalog_items i
        ON i.catalog_id = pt.catalog_id AND i.term_id = pt.term_id
      WHERE pt.profile_id = p.profile_id
      ORDER BY pt.taxonomy_type ASC, i.sort_order ASC,
               i.display_name COLLATE NOCASE ASC, pt.term_id ASC
    ) taxonomy_items
  ), '[]')
`

function encodeDiscoveryCursor(cursor: DiscoveryCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeDiscoveryCursor(
  value: string,
  expectedSort: AppDiscoverySort,
  expectedRegionCode: string | null,
): DiscoveryCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error('cursor format')
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DiscoveryCursor>
    const validScore = parsed.score === null
      || (typeof parsed.score === 'number' && Number.isSafeInteger(parsed.score) && parsed.score >= 0)
    const validPublishedAt = typeof parsed.publishedAt === 'string'
      && parsed.publishedAt.length <= 40
      && Number.isFinite(Date.parse(parsed.publishedAt))

    if (
      parsed.v !== DISCOVERY_CURSOR_VERSION
      || parsed.sort !== expectedSort
      || parsed.regionCode !== expectedRegionCode
      || parsed.ruleVersion !== DISCOVERY_RULE_VERSION
      || !validScore
      || !validPublishedAt
      || typeof parsed.profileId !== 'string'
      || !PROFILE_ID_PATTERN.test(parsed.profileId)
      || (expectedSort === 'latest' ? parsed.score !== null : typeof parsed.score !== 'number')
    ) {
      throw new Error('cursor payload')
    }
    return parsed as DiscoveryCursor
  } catch {
    throw new AppDiscoveryQueryError('INVALID_CURSOR', '分页游标无效或已不适用于当前筛选条件')
  }
}
