import type {
  AppViewerInteractionListItem,
  AppViewerInteractionState,
  AppViewerInteractionType,
} from '@meigallery/shared'
import { getPublicPersonProfile, getPublicPersonProfilesByIds } from './app-discovery'

export const APP_INTERACTION_DEFAULT_PAGE_SIZE = 20
export const APP_INTERACTION_MAX_PAGE_SIZE = 40

const INTERACTION_CURSOR_VERSION = 1
const PROFILE_ID_PATTERN = /^pp_[A-Za-z0-9_-]{1,77}$/

type InteractionRow = {
  profile_id: string
  interaction_type: AppViewerInteractionType
  created_at: string
}

type InteractionCursor = {
  v: 1
  accountScope: string
  interactionType: AppViewerInteractionType
  createdAt: string
  profileId: string
}

export class AppViewerInteractionError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'INVALID_CURSOR' | 'PROFILE_NOT_AVAILABLE',
    message: string,
  ) {
    super(message)
  }
}

export type AppViewerInteractionQuery = {
  limit: number
  cursor: InteractionCursor | null
}

export function parseAppViewerInteractionQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
  interactionType: AppViewerInteractionType
}): AppViewerInteractionQuery {
  const parsedLimit = Number.parseInt(input.limit || '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, APP_INTERACTION_MAX_PAGE_SIZE)
    : APP_INTERACTION_DEFAULT_PAGE_SIZE
  const cursor = input.cursor
    ? decodeInteractionCursor(input.cursor, input.accountScope, input.interactionType)
    : null
  return { limit, cursor }
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
    const result = await db.prepare(`
      INSERT INTO app_viewer_interactions (
        account_id, profile_id, interaction_type, created_at
      )
      SELECT ?, p.profile_id, ?, ?
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
      ON CONFLICT (account_id, profile_id, interaction_type) DO NOTHING
    `).bind(
      accountId,
      interactionType,
      createdAt,
      profileId,
      createdAt,
      createdAt,
      createdAt,
    ).run()

    if ((result.meta.changes ?? 0) === 0) {
      const existing = await db.prepare(`
        SELECT profile_id
        FROM app_viewer_interactions
        WHERE account_id = ? AND profile_id = ? AND interaction_type = ?
      `).bind(accountId, profileId, interactionType).first<{ profile_id: string }>()
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
  const conditions = ['account_id = ?', 'interaction_type = ?']
  const params: unknown[] = [accountId, interactionType]
  if (query.cursor) {
    conditions.push('(created_at < ? OR (created_at = ? AND profile_id > ?))')
    params.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.profileId)
  }

  const result = await db.prepare(`
    SELECT profile_id, interaction_type, created_at
    FROM app_viewer_interactions
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, profile_id ASC
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
