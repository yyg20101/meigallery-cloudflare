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
): Promise<{ data: AppPersonProfile[]; nextCursor: string | null; hasMore: boolean }> {
  const conditions = [
    "p.verification_status = 'verified'",
    "p.publication_status = 'published'",
    "p.authorization_status = 'active'",
    "p.visibility_status = 'visible'",
    `(
      p.authorization_valid_from IS NULL
      OR (
        datetime(p.authorization_valid_from) IS NOT NULL
        AND datetime(p.authorization_valid_from) <= datetime(?)
      )
    )`,
    `(
      p.authorization_valid_until IS NULL
      OR (
        datetime(p.authorization_valid_until) IS NOT NULL
        AND datetime(p.authorization_valid_until) > datetime(?)
      )
    )`,
    `(
      p.verification_valid_until IS NULL
      OR (
        datetime(p.verification_valid_until) IS NOT NULL
        AND datetime(p.verification_valid_until) > datetime(?)
      )
    )`,
    'datetime(p.published_at) IS NOT NULL',
    "g.status = 'published'",
  ]
  const params: unknown[] = [now.toISOString(), now.toISOString(), now.toISOString()]

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
        p.published_at
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
      WHERE p.verification_status = 'verified'
        AND p.publication_status = 'published'
        AND p.authorization_status = 'active'
        AND p.visibility_status = 'visible'
        AND (
          p.authorization_valid_from IS NULL
          OR (
            datetime(p.authorization_valid_from) IS NOT NULL
            AND datetime(p.authorization_valid_from) <= datetime(?)
          )
        )
        AND (
          p.authorization_valid_until IS NULL
          OR (
            datetime(p.authorization_valid_until) IS NOT NULL
            AND datetime(p.authorization_valid_until) > datetime(?)
          )
        )
        AND (
          p.verification_valid_until IS NULL
          OR (
            datetime(p.verification_valid_until) IS NOT NULL
            AND datetime(p.verification_valid_until) > datetime(?)
          )
        )
        AND datetime(p.published_at) IS NOT NULL
        AND g.status = 'published'
        AND p.region_code IS NOT NULL
        AND p.region_label IS NOT NULL
      GROUP BY p.region_code, p.region_label
      ORDER BY profile_count DESC, p.region_code ASC
      LIMIT 100
    `)
    .bind(now.toISOString(), now.toISOString(), now.toISOString())
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
        p.published_at
      FROM profile_public_projections p
      JOIN galleries g ON g.id = p.source_gallery_id
      WHERE p.profile_id = ?
        AND p.verification_status = 'verified'
        AND p.publication_status = 'published'
        AND p.authorization_status = 'active'
        AND p.visibility_status = 'visible'
        AND (
          p.authorization_valid_from IS NULL
          OR (
            datetime(p.authorization_valid_from) IS NOT NULL
            AND datetime(p.authorization_valid_from) <= datetime(?)
          )
        )
        AND (
          p.authorization_valid_until IS NULL
          OR (
            datetime(p.authorization_valid_until) IS NOT NULL
            AND datetime(p.authorization_valid_until) > datetime(?)
          )
        )
        AND (
          p.verification_valid_until IS NULL
          OR (
            datetime(p.verification_valid_until) IS NOT NULL
            AND datetime(p.verification_valid_until) > datetime(?)
          )
        )
        AND datetime(p.published_at) IS NOT NULL
        AND g.status = 'published'
      LIMIT 1
    `)
    .bind(profileId, now.toISOString(), now.toISOString(), now.toISOString())
    .first<PublicProjectionRow>()

  return row ? mapPublicProfile(row, apiUrl) : null
}

export async function getPublicPersonProfilesByIds(
  db: D1Database,
  profileIds: string[],
  apiUrl: string,
  now = new Date(),
): Promise<Map<string, AppPersonProfile>> {
  const ids = [...new Set(profileIds.filter(profileId => PROFILE_ID_PATTERN.test(profileId)))].slice(0, 40)
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(', ')
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
      p.published_at
    FROM profile_public_projections p
    JOIN galleries g ON g.id = p.source_gallery_id
    WHERE p.profile_id IN (${placeholders})
      AND p.verification_status = 'verified'
      AND p.publication_status = 'published'
      AND p.authorization_status = 'active'
      AND p.visibility_status = 'visible'
      AND (
        p.authorization_valid_from IS NULL
        OR (
          datetime(p.authorization_valid_from) IS NOT NULL
          AND datetime(p.authorization_valid_from) <= datetime(?)
        )
      )
      AND (
        p.authorization_valid_until IS NULL
        OR (
          datetime(p.authorization_valid_until) IS NOT NULL
          AND datetime(p.authorization_valid_until) > datetime(?)
        )
      )
      AND (
        p.verification_valid_until IS NULL
        OR (
          datetime(p.verification_valid_until) IS NOT NULL
          AND datetime(p.verification_valid_until) > datetime(?)
        )
      )
      AND datetime(p.published_at) IS NOT NULL
      AND g.status = 'published'
  `).bind(...ids, now.toISOString(), now.toISOString(), now.toISOString())
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
