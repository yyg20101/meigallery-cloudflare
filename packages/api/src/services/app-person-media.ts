import type {
  AppPersonMediaAccessGrant,
  AppPersonMediaItem,
  AppPersonVerificationDetail,
} from '@meigallery/shared'
import type { Bindings } from '../index'
import { isExpectedGalleryMediaKey } from '../utils/media-keys'
import {
  PUBLIC_PROFILE_ELIGIBILITY_SQL,
  publicProfileEligibilityParams,
} from './app-discovery'
import {
  getAppMembershipRuntimeConfig,
  getAppMembershipSummary,
} from './app-membership'
import type { AppSessionPrincipal } from './app-account-access'
import { PERSON_VERIFICATION_ITEMS } from './app-person-supply'

export const APP_PERSON_MEDIA_DEFAULT_PAGE_SIZE = 20
export const APP_PERSON_MEDIA_MAX_PAGE_SIZE = 40
export const APP_PERSON_MEDIA_ACCESS_TOKEN_TTL_SECONDS = 300
export const APP_PERSON_MEDIA_ACCESS_HEADER = 'X-Media-Access-Token' as const
export const APP_PERSON_MEDIA_MAX_IMAGE_BYTES = 24 * 1024 * 1024

const PROFILE_ID = /^pp_[A-Za-z0-9_-]{1,77}$/u
const MEDIA_ID = /^[A-Za-z0-9_-]{1,96}$/u
const MEDIA_CURSOR_VERSION = 1
const MEDIA_TOKEN_PREFIX = 'mat_'
const MEDIA_TOKEN_PATTERN = /^mat_([A-Za-z0-9_-]{16,768})\.([A-Za-z0-9_-]{43})$/u
const VERIFICATION_ITEMS = PERSON_VERIFICATION_ITEMS

export interface AppPersonMediaRuntimeConfig {
  enabled: boolean
  protectedEnabled: boolean
  videoEnabled: false
  requireProductionReady: boolean
}

type PublicProfileMediaContext = {
  profile_id: string
  display_name: string
  source_gallery_id: string
  projection_version: number
  profile_version: number | null
  verification_id: string | null
  operation_mode: string
  operation_label: string
}

type PersonMediaRow = {
  id: string
  type: string
  storage: string
  role: string
  r2_key: string | null
  required_rank: number
  gallery_required_rank: number
  sort_order: number
}

type VerificationRow = {
  id: string
  profile_version: number
  status: string
  verification_items_json: string
  policy_version: string
  valid_until: string | null
  reviewed_at: string | null
}

type MediaCursor = {
  v: 1
  profileId: string
  projectionVersion: number
  sortOrder: number
  mediaId: string
}

type MediaAccessTokenPayload = {
  v: 1
  sub: string
  sid: string
  pid: string
  mid: string
  exp: number
}

export type AppPersonMediaListQuery = {
  limit: number
  cursor: MediaCursor | null
}

export type AppPersonMediaAsset = {
  profileId: string
  mediaId: string
  galleryId: string
  r2Key: string
  requiredRank: number
}

export class AppPersonMediaError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'AppPersonMediaError'
  }
}

export function getAppPersonMediaRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_MEDIA_ENABLED'
  | 'APP_PROTECTED_MEDIA_ENABLED'
  | 'APP_MEDIA_PRODUCTION_READY'
>): AppPersonMediaRuntimeConfig {
  const requireProductionReady = env.APP_ENV === 'production'
  const productionReady = !requireProductionReady || env.APP_MEDIA_PRODUCTION_READY === 'true'
  const enabled = env.APP_MEDIA_ENABLED === 'true' && productionReady
  return {
    enabled,
    protectedEnabled: enabled && env.APP_PROTECTED_MEDIA_ENABLED === 'true',
    videoEnabled: false,
    requireProductionReady,
  }
}

export function parseAppPersonMediaListQuery(input: {
  limit?: string
  cursor?: string
}): AppPersonMediaListQuery {
  const rawLimit = Number.parseInt(input.limit || '', 10)
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, APP_PERSON_MEDIA_MAX_PAGE_SIZE)
    : APP_PERSON_MEDIA_DEFAULT_PAGE_SIZE
  return {
    limit,
    cursor: input.cursor ? decodeCursor(input.cursor) : null,
  }
}

export async function listPublicPersonMedia(
  db: D1Database,
  profileIdValue: unknown,
  config: AppPersonMediaRuntimeConfig,
  query: AppPersonMediaListQuery,
  now = new Date(),
): Promise<{ data: AppPersonMediaItem[]; nextCursor: string | null; hasMore: boolean }> {
  requireMediaEnabled(config)
  const profileId = requireProfileId(profileIdValue)
  const profile = await requirePublicProfileMediaContext(db, profileId, now)
  if (
    query.cursor
    && (
      query.cursor.profileId !== profileId
      || query.cursor.projectionVersion !== profile.projection_version
    )
  ) throw invalidCursor()

  const cursorWhere = query.cursor
    ? 'AND (ma.sort_order > ? OR (ma.sort_order = ? AND ma.id > ?))'
    : ''
  const cursorValues = query.cursor
    ? [query.cursor.sortOrder, query.cursor.sortOrder, query.cursor.mediaId]
    : []
  const result = await db.prepare(`
    SELECT ma.id, ma.type, ma.storage, ma.role, ma.r2_key,
           ma.required_rank, g.required_level_rank AS gallery_required_rank,
           ma.sort_order
    FROM media_assets ma
    JOIN galleries g ON g.id = ma.gallery_id
    WHERE ma.gallery_id = ?
      AND ma.upload_status = 'completed'
      AND ma.type = 'image'
      AND ma.storage = 'r2'
      AND ma.role IN ('content', 'preview')
      ${cursorWhere}
    ORDER BY ma.sort_order ASC, ma.id ASC
    LIMIT ?
  `).bind(
    profile.source_gallery_id,
    ...cursorValues,
    query.limit + 1,
  ).all<PersonMediaRow>()

  const hasMore = result.results.length > query.limit
  const page = result.results.slice(0, query.limit)
  const data = page.map(row => mapMediaItem(profile, row))
  const last = page.at(-1)
  return {
    data,
    hasMore,
    nextCursor: hasMore && last
      ? encodeCursor({
          v: MEDIA_CURSOR_VERSION,
          profileId,
          projectionVersion: profile.projection_version,
          sortOrder: Number(last.sort_order),
          mediaId: last.id,
        })
      : null,
  }
}

export async function getPublicPersonVerification(
  db: D1Database,
  profileIdValue: unknown,
  now = new Date(),
): Promise<AppPersonVerificationDetail> {
  const profileId = requireProfileId(profileIdValue)
  const profile = await requirePublicProfileMediaContext(db, profileId, now)
  if (!profile.verification_id || !profile.profile_version) throw verificationUnavailable()
  const verification = await db.prepare(`
    SELECT id, profile_version, status, verification_items_json,
           policy_version, valid_until, reviewed_at
    FROM person_verifications
    WHERE id = ? AND profile_id = ? AND profile_version = ? AND status = 'verified'
    LIMIT 1
  `).bind(
    profile.verification_id,
    profile.profile_id,
    profile.profile_version,
  ).first<VerificationRow>()
  if (!verification) throw verificationUnavailable()
  const reviewedAt = safeTimestamp(verification.reviewed_at)
  const validUntil = verification.valid_until === null
    ? null
    : safeTimestamp(verification.valid_until)
  if (validUntil !== null && Date.parse(validUntil) <= now.getTime()) throw verificationUnavailable()
  const items = parseVerificationItems(verification.verification_items_json)
  if (items.length !== VERIFICATION_ITEMS.length) throw verificationUnavailable()
  const operationMode = profile.operation_mode === 'self_managed' ? 'self_managed' : 'platform_managed'
  return {
    profileId,
    status: 'verified',
    label: '真人资料已认证',
    policyVersion: safePolicyVersion(verification.policy_version),
    reviewedAt,
    validUntil,
    profileVersion: verification.profile_version,
    operation: {
      mode: operationMode,
      label: operationMode === 'platform_managed'
        ? '消息由平台运营接收'
        : safeOperationLabel(profile.operation_label),
    },
    scopes: [
      { code: 'identity_existence', label: '资料对应真人主体确实存在' },
      { code: 'authorization_agency', label: '平台已核验展示与代运营授权关系' },
      { code: 'profile_consistency', label: '公开资料与审核版本保持一致' },
      { code: 'media_rights', label: '公开媒体具有已登记的使用权来源' },
    ],
    platformNotice: '认证表示平台已核验资料存在性、授权关系、资料一致性与媒体使用权，不代表本人已经入驻，也不构成平台背书。消息接收主体以资料页实时披露为准。',
    changesRequireReverification: true,
  }
}

export async function issueProtectedPersonMediaAccess(
  env: Bindings,
  principal: AppSessionPrincipal,
  profileIdValue: unknown,
  mediaIdValue: unknown,
  config: AppPersonMediaRuntimeConfig,
  now = new Date(),
): Promise<AppPersonMediaAccessGrant> {
  if (!config.enabled || !config.protectedEnabled) {
    throw new AppPersonMediaError(403, 'PROTECTED_MEDIA_DISABLED', '受保护媒体能力尚未开放')
  }
  if (principal.accountStatus !== 'active') {
    throw new AppPersonMediaError(403, 'ACCOUNT_RESTRICTED', '当前账号状态不能访问受保护媒体')
  }
  const asset = await requirePublicPersonMediaAsset(env.DB, profileIdValue, mediaIdValue, now)
  if (asset.requiredRank <= 0) {
    throw new AppPersonMediaError(409, 'MEDIA_ACCESS_NOT_REQUIRED', '该图片不需要会员访问凭证')
  }
  await requireMembershipRank(env, principal.accountInternalId, asset.requiredRank, now)
  const expiresAt = new Date(now.getTime() + APP_PERSON_MEDIA_ACCESS_TOKEN_TTL_SECONDS * 1000)
  const token = await signMediaAccessToken(env.SESSION_SECRET, {
    v: 1,
    sub: principal.accountId,
    sid: principal.sessionId,
    pid: asset.profileId,
    mid: asset.mediaId,
    exp: Math.floor(expiresAt.getTime() / 1000),
  })
  return {
    mediaId: asset.mediaId,
    type: 'image',
    accessToken: token,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: APP_PERSON_MEDIA_ACCESS_TOKEN_TTL_SECONDS,
    contentPath: contentPath(asset.profileId, asset.mediaId),
    tokenHeader: APP_PERSON_MEDIA_ACCESS_HEADER,
    cachePolicy: 'memory_only',
  }
}

export async function authorizePersonMediaContent(
  env: Bindings,
  profileIdValue: unknown,
  mediaIdValue: unknown,
  mediaTokenValue: unknown,
  config: AppPersonMediaRuntimeConfig,
  now = new Date(),
): Promise<AppPersonMediaAsset> {
  requireMediaEnabled(config)
  const asset = await requirePublicPersonMediaAsset(env.DB, profileIdValue, mediaIdValue, now)
  if (asset.requiredRank <= 0) return asset
  if (!config.protectedEnabled) {
    throw new AppPersonMediaError(403, 'PROTECTED_MEDIA_DISABLED', '受保护媒体能力尚未开放')
  }
  const payload = await verifyMediaAccessToken(env.SESSION_SECRET, mediaTokenValue, now)
  if (payload.pid !== asset.profileId || payload.mid !== asset.mediaId) throw invalidMediaAccess()
  const session = await env.DB.prepare(`
    SELECT security.account_id
    FROM app_sessions session
    JOIN app_account_security security ON security.account_id = session.account_id
    JOIN app_devices device ON device.id = session.device_id AND device.account_id = session.account_id
    JOIN users ON users.id = session.account_id
    WHERE session.id = ?
      AND security.account_public_id = ?
      AND session.status = 'active'
      AND device.status = 'active'
      AND security.status = 'active'
      AND users.status = 'active'
      AND session.account_session_version = security.session_version
      AND session.device_session_version = device.session_version
      AND datetime(session.access_expires_at) > datetime(?)
    LIMIT 1
  `).bind(payload.sid, payload.sub, now.toISOString()).first<{ account_id: number }>()
  if (!session) throw invalidMediaAccess()
  await requireMembershipRank(env, session.account_id, asset.requiredRank, now)
  return asset
}

async function requireMembershipRank(
  env: Bindings,
  accountId: number,
  requiredRank: number,
  now: Date,
) {
  const membership = getAppMembershipRuntimeConfig(env)
  if (!membership.enabled || !membership.catalogVersionId) {
    throw new AppPersonMediaError(503, 'MEDIA_MEMBERSHIP_UNAVAILABLE', '会员目录尚未开放，暂时无法核验媒体权限', true)
  }
  const summary = await getAppMembershipSummary(
    env.DB,
    accountId,
    membership.catalogVersionId,
    now,
    { requireProductionReady: membership.requireProductionReady },
  )
  if (summary.rank < requiredRank) {
    throw new AppPersonMediaError(
      403,
      'MEDIA_MEMBERSHIP_REQUIRED',
      '当前会员等级不足，无法查看这张图片',
      false,
      { requiredRank, currentRank: summary.rank },
    )
  }
}

async function requirePublicPersonMediaAsset(
  db: D1Database,
  profileIdValue: unknown,
  mediaIdValue: unknown,
  now: Date,
): Promise<AppPersonMediaAsset> {
  const profileId = requireProfileId(profileIdValue)
  const mediaId = requireMediaId(mediaIdValue)
  const profile = await requirePublicProfileMediaContext(db, profileId, now)
  const row = await db.prepare(`
    SELECT ma.id, ma.type, ma.storage, ma.role, ma.r2_key,
           ma.required_rank, g.required_level_rank AS gallery_required_rank,
           ma.sort_order
    FROM media_assets ma
    JOIN galleries g ON g.id = ma.gallery_id
    WHERE ma.id = ? AND ma.gallery_id = ?
      AND ma.upload_status = 'completed'
      AND ma.type = 'image'
      AND ma.storage = 'r2'
      AND ma.role IN ('content', 'preview')
    LIMIT 1
  `).bind(mediaId, profile.source_gallery_id).first<PersonMediaRow>()
  if (!row || !row.r2_key || !isExpectedGalleryMediaKey(row.r2_key, profile.source_gallery_id, row.id)) {
    throw new AppPersonMediaError(404, 'MEDIA_NOT_FOUND', '图片不存在或已停止公开')
  }
  return {
    profileId,
    mediaId,
    galleryId: profile.source_gallery_id,
    r2Key: row.r2_key,
    requiredRank: effectiveRank(row),
  }
}

async function requirePublicProfileMediaContext(
  db: D1Database,
  profileId: string,
  now: Date,
): Promise<PublicProfileMediaContext> {
  const row = await db.prepare(`
    SELECT p.profile_id, p.display_name, p.source_gallery_id, p.projection_version,
           p.profile_version, p.verification_id, p.operation_mode, p.operation_label
    FROM profile_public_projections p
    JOIN galleries g ON g.id = p.source_gallery_id
    WHERE p.profile_id = ? AND ${PUBLIC_PROFILE_ELIGIBILITY_SQL}
    LIMIT 1
  `).bind(profileId, ...publicProfileEligibilityParams(now)).first<PublicProfileMediaContext>()
  if (!row) throw new AppPersonMediaError(404, 'PROFILE_NOT_FOUND', '人物资料不存在或已停止公开')
  return row
}

function mapMediaItem(
  profile: PublicProfileMediaContext,
  row: PersonMediaRow,
): AppPersonMediaItem {
  if (
    !row.r2_key
    || !isExpectedGalleryMediaKey(row.r2_key, profile.source_gallery_id, row.id)
    || !Number.isSafeInteger(Number(row.sort_order))
  ) {
    throw new AppPersonMediaError(503, 'MEDIA_CONFIGURATION_INVALID', '人物媒体配置异常', true)
  }
  const requiredRank = effectiveRank(row)
  return {
    mediaId: row.id,
    type: 'image',
    role: row.role === 'preview' ? 'preview' : 'content',
    sortOrder: Number(row.sort_order),
    requiredRank,
    altText: `${profile.display_name}的已授权图片`,
    access: requiredRank === 0
      ? {
          mode: 'public',
          contentPath: contentPath(profile.profile_id, row.id),
          accessPath: null,
        }
      : {
          mode: 'membership',
          contentPath: null,
          accessPath: accessPath(profile.profile_id, row.id),
        },
  }
}

function effectiveRank(row: Pick<PersonMediaRow, 'required_rank' | 'gallery_required_rank'>) {
  const assetRank = Number(row.required_rank)
  const galleryRank = Number(row.gallery_required_rank)
  if (
    !Number.isSafeInteger(assetRank)
    || !Number.isSafeInteger(galleryRank)
    || assetRank < 0
    || galleryRank < 0
  ) throw new AppPersonMediaError(503, 'MEDIA_CONFIGURATION_INVALID', '人物媒体等级配置异常', true)
  return Math.max(assetRank, galleryRank)
}

function requireMediaEnabled(config: AppPersonMediaRuntimeConfig) {
  if (!config.enabled) throw new AppPersonMediaError(403, 'MEDIA_FEATURE_DISABLED', '人物媒体能力尚未开放')
}

function requireProfileId(value: unknown) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!PROFILE_ID.test(id)) throw new AppPersonMediaError(400, 'PROFILE_ID_INVALID', '人物资料 ID 格式不正确')
  return id
}

function requireMediaId(value: unknown) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!MEDIA_ID.test(id)) throw new AppPersonMediaError(400, 'MEDIA_ID_INVALID', '媒体 ID 格式不正确')
  return id
}

function safePolicyVersion(value: string) {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._:-]{1,80}$/u.test(normalized)) throw verificationUnavailable()
  return normalized
}

function safeTimestamp(value: string | null) {
  if (!value) throw verificationUnavailable()
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw verificationUnavailable()
  return new Date(timestamp).toISOString()
}

function safeOperationLabel(value: string) {
  const normalized = value.trim()
  return normalized.length >= 1 && normalized.length <= 80 ? normalized : '资料由本人运营'
}

function parseVerificationItems(raw: string) {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) return []
    const items = [...new Set(parsed)]
    if (
      items.length !== VERIFICATION_ITEMS.length
      || items.some(item => !VERIFICATION_ITEMS.includes(item as typeof VERIFICATION_ITEMS[number]))
    ) return []
    return VERIFICATION_ITEMS.filter(item => items.includes(item))
  }
  catch {
    return []
  }
}

function verificationUnavailable() {
  return new AppPersonMediaError(503, 'VERIFICATION_DETAIL_UNAVAILABLE', '认证说明暂不可用，请稍后重试', true)
}

function contentPath(profileId: string, mediaId: string) {
  return `/api/v2/person-profiles/${profileId}/media/${mediaId}/content`
}

function accessPath(profileId: string, mediaId: string) {
  return `/api/v2/person-profiles/${profileId}/media/${mediaId}/access`
}

async function signMediaAccessToken(secret: string, payload: MediaAccessTokenPayload) {
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await mediaHmacKey(secret)
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(encodedPayload),
  ))
  return `${MEDIA_TOKEN_PREFIX}${encodedPayload}.${base64UrlEncode(signature)}`
}

async function verifyMediaAccessToken(
  secret: string,
  value: unknown,
  now: Date,
): Promise<MediaAccessTokenPayload> {
  const token = typeof value === 'string' ? value.trim() : ''
  const match = MEDIA_TOKEN_PATTERN.exec(token)
  if (!match) throw invalidMediaAccess()
  try {
    const encodedPayload = match[1]!
    const signature = base64UrlDecode(match[2]!)
    const key = await mediaHmacKey(secret)
    const verified = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(encodedPayload),
    )
    if (!verified) throw new Error('signature')
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as Partial<MediaAccessTokenPayload>
    if (
      parsed.v !== 1
      || typeof parsed.sub !== 'string'
      || !/^acc_[A-Za-z0-9_-]{1,75}$/u.test(parsed.sub)
      || typeof parsed.sid !== 'string'
      || !/^aps_[A-Za-z0-9_-]{1,76}$/u.test(parsed.sid)
      || typeof parsed.pid !== 'string'
      || !PROFILE_ID.test(parsed.pid)
      || typeof parsed.mid !== 'string'
      || !MEDIA_ID.test(parsed.mid)
      || typeof parsed.exp !== 'number'
      || !Number.isSafeInteger(parsed.exp)
      || parsed.exp <= Math.floor(now.getTime() / 1000)
      || parsed.exp > Math.floor(now.getTime() / 1000) + APP_PERSON_MEDIA_ACCESS_TOKEN_TTL_SECONDS
    ) throw new Error('payload')
    return parsed as MediaAccessTokenPayload
  }
  catch (error) {
    if (error instanceof AppPersonMediaError) throw error
    throw invalidMediaAccess()
  }
}

async function mediaHmacKey(secret: string) {
  const normalized = secret.trim()
  if (normalized.length < 32) {
    throw new AppPersonMediaError(503, 'MEDIA_SIGNING_UNAVAILABLE', '媒体访问签名服务暂不可用', true)
  }
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`meigallery:app-media:v1:${normalized}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('base64url')
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
}

function encodeCursor(value: MediaCursor) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

function decodeCursor(value: string): MediaCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error('cursor')
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as Partial<MediaCursor>
    if (
      parsed.v !== MEDIA_CURSOR_VERSION
      || typeof parsed.profileId !== 'string'
      || !PROFILE_ID.test(parsed.profileId)
      || typeof parsed.projectionVersion !== 'number'
      || !Number.isSafeInteger(parsed.projectionVersion)
      || parsed.projectionVersion < 1
      || typeof parsed.sortOrder !== 'number'
      || !Number.isSafeInteger(parsed.sortOrder)
      || typeof parsed.mediaId !== 'string'
      || !MEDIA_ID.test(parsed.mediaId)
    ) throw new Error('payload')
    return parsed as MediaCursor
  }
  catch {
    throw invalidCursor()
  }
}

function invalidCursor() {
  return new AppPersonMediaError(400, 'MEDIA_CURSOR_INVALID', '媒体分页游标无效或资料版本已变化')
}

function invalidMediaAccess() {
  return new AppPersonMediaError(401, 'MEDIA_ACCESS_INVALID', '媒体访问凭证无效或已过期')
}
