import type {
  AppViewHistoryClearResult,
  AppViewHistoryDeleteResult,
  AppViewHistoryEntitlementStatus,
  AppViewHistoryItem,
  AppViewHistoryRecordResult,
  AppViewHistorySettings,
} from '@meigallery/shared'
import {
  getPublicPersonProfilesByIds,
  publicProfileEligibilityParams,
  publicProfileEligibilitySql,
} from './app-discovery'
import {
  AppMembershipError,
  type AppMembershipRuntimeConfig,
  resolveAppMembershipSnapshot,
} from './app-membership'
import {
  AppInteractionCollectionError,
  type AppInteractionCollectionRuntimeConfig,
  assertPositiveAccountId,
  normalizeAppProfileId,
  normalizeExpectedVersion,
  normalizePageLimit,
  requireAppInteractionCollectionPolicy,
  requireAvailableUnblockedProfile,
} from './app-interaction-collections'

const HISTORY_RETENTION_ENTITLEMENT = 'history.retention_days'
const HISTORY_CURSOR_VERSION = 1
const VIEW_ID_PATTERN = /^vhv_[A-Za-z0-9_-]{8,92}$/u
const VIEW_HISTORY_PROFILE_ELIGIBILITY_SQL = publicProfileEligibilitySql('profile', 'gallery')

type PreferenceRow = {
  recording_enabled: number
  version: number
  mutation_token: string
  updated_at: string
}

type HistoryRow = {
  profile_id: string
  first_viewed_at: string
  last_viewed_at: string
  view_count: number
  last_view_id_hash: string
  expires_at: string
}

type HistoryEntitlement = {
  status: AppViewHistoryEntitlementStatus
  retentionDays: number | null
  sourceTierId: string | null
}

type HistoryCursor = {
  v: 1
  accountScope: string
  lastViewedAt: string
  profileId: string
}

export interface AppViewHistoryListQuery {
  limit: number
  cursor: HistoryCursor | null
}

export interface UpdateAppViewHistorySettingsInput {
  expectedVersion?: unknown
  recordingEnabled?: unknown
}

export interface RecordAppProfileViewInput {
  viewId?: unknown
  expectedHistoryVersion?: unknown
}

export interface ClearAppViewHistoryInput {
  expectedVersion?: unknown
  disableRecording?: unknown
}

export interface AppViewHistoryPurgeResult {
  skipped: boolean
  reason: 'policy_not_configured' | 'policy_not_found' | 'retention_not_ready' | null
  deletedCount: number
  hasMore: boolean
}

export function parseAppViewHistoryListQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
}): AppViewHistoryListQuery {
  return {
    limit: normalizePageLimit(input.limit),
    cursor: input.cursor
      ? decodeHistoryCursor(input.cursor, input.accountScope)
      : null,
  }
}

export async function getAppViewHistorySettings(
  db: D1Database,
  accountId: number,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
): Promise<AppViewHistorySettings> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'history')
  const [preference, entitlement] = await Promise.all([
    findPreference(db, accountId),
    resolveHistoryEntitlement(db, accountId, membershipConfig, now),
  ])
  return mapSettings(preference, entitlement)
}

export async function updateAppViewHistorySettings(
  db: D1Database,
  accountId: number,
  input: UpdateAppViewHistorySettingsInput,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
): Promise<AppViewHistorySettings> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'history')
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  if (typeof input.recordingEnabled !== 'boolean') {
    throw new AppInteractionCollectionError(400, 'VIEW_HISTORY_SETTING_INVALID', 'recordingEnabled 必须为布尔值')
  }
  const recordingEnabled = input.recordingEnabled
  const entitlement = await resolveHistoryEntitlement(db, accountId, membershipConfig, now)
  if (recordingEnabled) requireHistoryEntitlement(entitlement)
  const current = await findPreference(db, accountId)
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  if (!current) {
    if (expectedVersion !== 1) throw historyVersionConflict()
    const result = await db.prepare(`
      INSERT OR IGNORE INTO app_view_history_preferences (
        account_id, recording_enabled, version, mutation_token, updated_at
      ) VALUES (?, ?, 2, ?, ?)
    `).bind(accountId, recordingEnabled ? 1 : 0, mutationToken, nowIso).run()
    if ((result.meta.changes ?? 0) !== 1) throw historyVersionConflict()
  }
  else {
    if (current.version !== expectedVersion) throw historyVersionConflict()
    const result = await db.prepare(`
      UPDATE app_view_history_preferences
      SET recording_enabled = ?, version = version + 1,
          mutation_token = ?, updated_at = ?
      WHERE account_id = ? AND version = ?
    `).bind(recordingEnabled ? 1 : 0, mutationToken, nowIso, accountId, expectedVersion).run()
    if ((result.meta.changes ?? 0) !== 1) throw historyVersionConflict()
  }
  return mapSettings((await findPreference(db, accountId))!, entitlement)
}

export async function recordAppProfileView(
  db: D1Database,
  accountId: number,
  profileIdValue: string,
  input: RecordAppProfileViewInput,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
): Promise<AppViewHistoryRecordResult> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'history')
  const profileId = await requireAvailableUnblockedProfile(db, accountId, profileIdValue, now)
  const viewId = normalizeViewId(input.viewId)
  const expectedHistoryVersion = normalizeExpectedVersion(input.expectedHistoryVersion)
  const preference = await findPreference(db, accountId)
  if (!preference || preference.version !== expectedHistoryVersion) throw historyVersionConflict()
  if (preference.recording_enabled !== 1) {
    throw new AppInteractionCollectionError(403, 'VIEW_HISTORY_RECORDING_DISABLED', '浏览历史记录当前已关闭')
  }
  const entitlement = await resolveHistoryEntitlement(db, accountId, membershipConfig, now)
  const retentionDays = requireHistoryEntitlement(entitlement)
  const nowIso = now.toISOString()
  const expiresAt = new Date(now.getTime() + retentionDays * 86_400_000).toISOString()
  const viewIdHash = await sha256Hex(viewId)
  const result = await db.prepare(`
    INSERT INTO app_profile_view_history (
      account_id, profile_id, first_viewed_at, last_viewed_at,
      view_count, last_view_id_hash, expires_at
    )
    SELECT ?, profile.profile_id, ?, ?, 1, ?, ?
    FROM app_view_history_preferences preference
    JOIN profile_public_projections profile ON profile.profile_id = ?
    JOIN galleries gallery ON gallery.id = profile.source_gallery_id
    WHERE preference.account_id = ?
      AND preference.recording_enabled = 1
      AND preference.version = ?
      AND (${VIEW_HISTORY_PROFILE_ELIGIBILITY_SQL})
      AND NOT EXISTS (
        SELECT 1
        FROM app_profile_blocks block
        WHERE block.account_id = ?
          AND block.profile_id = profile.profile_id
          AND block.state = 'blocked'
      )
    ON CONFLICT (account_id, profile_id) DO UPDATE SET
      first_viewed_at = CASE
        WHEN app_profile_view_history.expires_at <= excluded.last_viewed_at
          THEN excluded.first_viewed_at
        ELSE app_profile_view_history.first_viewed_at
      END,
      last_viewed_at = excluded.last_viewed_at,
      view_count = CASE
        WHEN app_profile_view_history.expires_at <= excluded.last_viewed_at THEN 1
        ELSE MIN(app_profile_view_history.view_count + 1, 1000000000)
      END,
      last_view_id_hash = excluded.last_view_id_hash,
      expires_at = excluded.expires_at
    WHERE app_profile_view_history.last_view_id_hash <> excluded.last_view_id_hash
  `).bind(
    accountId,
    nowIso,
    nowIso,
    viewIdHash,
    expiresAt,
    profileId,
    accountId,
    expectedHistoryVersion,
    ...publicProfileEligibilityParams(now),
    accountId,
  ).run()

  const row = await findHistoryRow(db, accountId, profileId)
  if ((result.meta.changes ?? 0) === 1) {
    return {
      profileId,
      recorded: true,
      duplicate: false,
      settingsVersion: expectedHistoryVersion,
      lastViewedAt: row?.last_viewed_at ?? nowIso,
      expiresAt: row?.expires_at ?? expiresAt,
    }
  }
  if (row?.last_view_id_hash === viewIdHash) {
    return {
      profileId,
      recorded: true,
      duplicate: true,
      settingsVersion: expectedHistoryVersion,
      lastViewedAt: row.last_viewed_at,
      expiresAt: row.expires_at,
    }
  }
  const latestPreference = await findPreference(db, accountId)
  if (!latestPreference || latestPreference.version !== expectedHistoryVersion) {
    throw historyVersionConflict()
  }
  if (latestPreference.recording_enabled !== 1) {
    throw new AppInteractionCollectionError(403, 'VIEW_HISTORY_RECORDING_DISABLED', '浏览历史记录当前已关闭')
  }
  await requireAvailableUnblockedProfile(db, accountId, profileId, now)
  throw new AppInteractionCollectionError(409, 'VIEW_HISTORY_WRITE_CONFLICT', '浏览记录状态已变化，请刷新后重试', true)
}

export async function listAppViewHistory(
  db: D1Database,
  accountId: number,
  accountScope: string,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  query: AppViewHistoryListQuery,
  apiUrl: string,
  now = new Date(),
): Promise<{ data: AppViewHistoryItem[]; nextCursor: string | null; hasMore: boolean }> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'history')
  const entitlement = await resolveHistoryEntitlement(db, accountId, membershipConfig, now)
  const retentionDays = requireHistoryEntitlement(entitlement)
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString()
  const conditions = [
    'account_id = ?',
    'expires_at > ?',
    'last_viewed_at >= ?',
  ]
  const bindings: unknown[] = [accountId, now.toISOString(), cutoff]
  if (query.cursor) {
    conditions.push('(last_viewed_at < ? OR (last_viewed_at = ? AND profile_id > ?))')
    bindings.push(query.cursor.lastViewedAt, query.cursor.lastViewedAt, query.cursor.profileId)
  }
  const result = await db.prepare(`
    SELECT profile_id, first_viewed_at, last_viewed_at,
           view_count, last_view_id_hash, expires_at
    FROM app_profile_view_history
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_viewed_at DESC, profile_id ASC
    LIMIT ?
  `).bind(...bindings, query.limit + 1).all<HistoryRow>()
  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  const profiles = await getPublicPersonProfilesByIds(
    db,
    rows.map(row => row.profile_id),
    apiUrl,
    now,
  )
  const last = rows.at(-1)
  const nextCursor = hasMore && last
    ? encodeHistoryCursor({
        v: HISTORY_CURSOR_VERSION,
        accountScope,
        lastViewedAt: last.last_viewed_at,
        profileId: last.profile_id,
      })
    : null
  return {
    data: rows.map((row) => {
      const profile = profiles.get(row.profile_id) ?? null
      return {
        profileId: row.profile_id,
        firstViewedAt: requireStoredTime(row.first_viewed_at),
        lastViewedAt: requireStoredTime(row.last_viewed_at),
        viewCount: requirePositiveCount(row.view_count),
        expiresAt: requireStoredTime(row.expires_at),
        profile,
        unavailableReason: profile ? null : 'PROFILE_NOT_AVAILABLE',
      }
    }),
    nextCursor,
    hasMore,
  }
}

export async function deleteAppViewHistoryItem(
  db: D1Database,
  accountId: number,
  profileIdValue: string,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  now = new Date(),
): Promise<AppViewHistoryDeleteResult> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'history')
  const profileId = normalizeAppProfileId(profileIdValue)
  const current = await findPreference(db, accountId)
  const expectedVersion = current?.version ?? 1
  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const preferenceStatement = current
    ? db.prepare(`
        UPDATE app_view_history_preferences
        SET version = ?, mutation_token = ?, updated_at = ?
        WHERE account_id = ? AND version = ?
      `).bind(nextVersion, mutationToken, nowIso, accountId, expectedVersion)
    : db.prepare(`
        INSERT OR IGNORE INTO app_view_history_preferences (
          account_id, recording_enabled, version, mutation_token, updated_at
        ) VALUES (?, 0, ?, ?, ?)
      `).bind(accountId, nextVersion, mutationToken, nowIso)
  const results = await db.batch([
    preferenceStatement,
    db.prepare(`
      DELETE FROM app_profile_view_history
      WHERE account_id = ? AND profile_id = ?
        AND EXISTS (
          SELECT 1
          FROM app_view_history_preferences preference
          WHERE preference.account_id = ?
            AND preference.version = ?
            AND preference.mutation_token = ?
        )
    `).bind(accountId, profileId, accountId, nextVersion, mutationToken),
  ])
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw historyVersionConflict()
  return {
    profileId,
    deleted: Number(results[1]?.meta?.changes ?? 0) > 0,
    settingsVersion: nextVersion,
    updatedAt: nowIso,
  }
}

export async function clearAppViewHistory(
  db: D1Database,
  accountId: number,
  input: ClearAppViewHistoryInput,
  collectionConfig: AppInteractionCollectionRuntimeConfig,
  now = new Date(),
): Promise<AppViewHistoryClearResult> {
  assertPositiveAccountId(accountId)
  await requireAppInteractionCollectionPolicy(db, collectionConfig, 'history')
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  if (typeof input.disableRecording !== 'boolean') {
    throw new AppInteractionCollectionError(400, 'VIEW_HISTORY_CLEAR_INVALID', 'disableRecording 必须为布尔值')
  }
  const current = await findPreference(db, accountId)
  if (current && current.version !== expectedVersion) throw historyVersionConflict()
  if (!current && expectedVersion !== 1) throw historyVersionConflict()
  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const statements: D1PreparedStatement[] = []
  if (current) {
    statements.push(db.prepare(`
      UPDATE app_view_history_preferences
      SET recording_enabled = CASE WHEN ? = 1 THEN 0 ELSE recording_enabled END,
          version = ?, mutation_token = ?, updated_at = ?
      WHERE account_id = ? AND version = ?
    `).bind(
      input.disableRecording ? 1 : 0,
      nextVersion,
      mutationToken,
      nowIso,
      accountId,
      expectedVersion,
    ))
  }
  else {
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO app_view_history_preferences (
        account_id, recording_enabled, version, mutation_token, updated_at
      ) VALUES (?, 0, ?, ?, ?)
    `).bind(accountId, nextVersion, mutationToken, nowIso))
  }
  statements.push(db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_profile_view_history
    WHERE account_id = ?
  `).bind(accountId))
  statements.push(db.prepare(`
    DELETE FROM app_profile_view_history
    WHERE account_id = ?
      AND EXISTS (
        SELECT 1
        FROM app_view_history_preferences preference
        WHERE preference.account_id = ?
          AND preference.version = ?
          AND preference.mutation_token = ?
      )
  `).bind(accountId, accountId, nextVersion, mutationToken))
  const results = await db.batch(statements)
  const updated = await findPreference(db, accountId)
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 1
    || !updated
    || updated.version !== nextVersion
    || updated.mutation_token !== mutationToken
  ) throw historyVersionConflict()
  const countResult = results.at(-2)
  const count = countResult?.results?.[0] as { count?: number } | undefined
  return {
    clearedCount: requireNonNegativeCount(count?.count),
    recordingEnabled: updated.recording_enabled === 1,
    settingsVersion: updated.version,
    updatedAt: updated.updated_at,
  }
}

export async function purgeExpiredAppViewHistory(
  db: D1Database,
  config: AppInteractionCollectionRuntimeConfig,
  now = new Date(),
  limit = 1000,
): Promise<AppViewHistoryPurgeResult> {
  if (!config.policyConfigured) return skippedViewHistoryPurge('policy_not_configured')
  const policy = await db.prepare(`
    SELECT history_retention_decision_status, purge_enabled
    FROM app_interaction_collection_policies
    WHERE id = ?
    LIMIT 1
  `).bind(config.policyId).first<{
    history_retention_decision_status: string
    purge_enabled: number
  }>()
  if (!policy) return skippedViewHistoryPurge('policy_not_found')
  if (
    policy.history_retention_decision_status !== 'approved'
    || policy.purge_enabled !== 1
  ) return skippedViewHistoryPurge('retention_not_ready')

  const timestamp = requirePurgeTimestamp(now)
  const safeLimit = normalizeViewHistoryPurgeLimit(limit)
  const result = await db.prepare(`
    DELETE FROM app_profile_view_history
    WHERE rowid IN (
      SELECT rowid
      FROM app_profile_view_history
      WHERE expires_at <= ?
      ORDER BY expires_at ASC, account_id ASC, profile_id ASC
      LIMIT ?
    )
  `).bind(timestamp, safeLimit).run()
  const remaining = await db.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM app_profile_view_history
      WHERE expires_at <= ?
      LIMIT 1
    ) AS has_more
  `).bind(timestamp).first<{ has_more: number }>()
  return {
    skipped: false,
    reason: null,
    deletedCount: Number(result.meta.changes ?? 0),
    hasMore: remaining?.has_more === 1,
  }
}

async function resolveHistoryEntitlement(
  db: D1Database,
  accountId: number,
  config: AppMembershipRuntimeConfig,
  now: Date,
): Promise<HistoryEntitlement> {
  if (!config.enabled || !config.catalogVersionId) {
    return { status: 'not_ready', retentionDays: null, sourceTierId: null }
  }
  try {
    const snapshot = await resolveAppMembershipSnapshot(
      db,
      accountId,
      config.catalogVersionId,
      now,
      { requireProductionReady: config.requireProductionReady },
    )
    if (!snapshot.grant || !snapshot.tier) {
      return { status: 'required', retentionDays: null, sourceTierId: null }
    }
    const entitlement = snapshot.entitlements.find(item => item.key === HISTORY_RETENTION_ENTITLEMENT)
    if (
      !entitlement
      || !entitlement.executable
      || entitlement.valueType !== 'integer'
      || typeof entitlement.value !== 'number'
      || !Number.isSafeInteger(entitlement.value)
      || entitlement.value < 1
      || entitlement.value > 3650
    ) {
      return { status: 'not_ready', retentionDays: null, sourceTierId: snapshot.tier.tierId }
    }
    return {
      status: 'available',
      retentionDays: entitlement.value,
      sourceTierId: snapshot.tier.tierId,
    }
  }
  catch (error) {
    if (error instanceof AppMembershipError) {
      return { status: 'not_ready', retentionDays: null, sourceTierId: null }
    }
    throw error
  }
}

function requireHistoryEntitlement(entitlement: HistoryEntitlement): number {
  if (entitlement.status === 'required') {
    throw new AppInteractionCollectionError(403, 'VIEW_HISTORY_ENTITLEMENT_REQUIRED', '有效会员才可使用浏览历史')
  }
  if (entitlement.status !== 'available' || entitlement.retentionDays === null) {
    throw new AppInteractionCollectionError(503, 'VIEW_HISTORY_ENTITLEMENT_NOT_READY', '浏览历史权益尚未就绪', true)
  }
  return entitlement.retentionDays
}

function mapSettings(
  preference: PreferenceRow | null,
  entitlement: HistoryEntitlement,
): AppViewHistorySettings {
  return {
    recordingEnabled: preference?.recording_enabled === 1,
    version: preference?.version ?? 1,
    retentionDays: entitlement.retentionDays,
    entitlementStatus: entitlement.status,
    sourceTierId: entitlement.sourceTierId,
    updatedAt: preference?.updated_at ?? null,
  }
}

async function findPreference(db: D1Database, accountId: number): Promise<PreferenceRow | null> {
  return db.prepare(`
    SELECT recording_enabled, version, mutation_token, updated_at
    FROM app_view_history_preferences
    WHERE account_id = ?
    LIMIT 1
  `).bind(accountId).first<PreferenceRow>()
}

async function findHistoryRow(
  db: D1Database,
  accountId: number,
  profileId: string,
): Promise<HistoryRow | null> {
  return db.prepare(`
    SELECT profile_id, first_viewed_at, last_viewed_at,
           view_count, last_view_id_hash, expires_at
    FROM app_profile_view_history
    WHERE account_id = ? AND profile_id = ?
    LIMIT 1
  `).bind(accountId, profileId).first<HistoryRow>()
}

function normalizeViewId(value: unknown): string {
  if (typeof value !== 'string' || !VIEW_ID_PATTERN.test(value)) {
    throw new AppInteractionCollectionError(400, 'VIEW_ID_INVALID', 'viewId 格式无效')
  }
  return value
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function historyVersionConflict(): AppInteractionCollectionError {
  return new AppInteractionCollectionError(409, 'VIEW_HISTORY_VERSION_CONFLICT', '浏览历史设置已在其他设备更新，请刷新后重试', true)
}

function requireStoredTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AppInteractionCollectionError(503, 'VIEW_HISTORY_DATA_INVALID', '浏览历史时间数据异常')
  }
  return value
}

function requirePositiveCount(value: number): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new AppInteractionCollectionError(503, 'VIEW_HISTORY_DATA_INVALID', '浏览历史次数数据异常')
  }
  return count
}

function requireNonNegativeCount(value: number | undefined): number {
  const count = Number(value ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AppInteractionCollectionError(503, 'VIEW_HISTORY_DATA_INVALID', '浏览历史数量数据异常')
  }
  return count
}

function skippedViewHistoryPurge(
  reason: NonNullable<AppViewHistoryPurgeResult['reason']>,
): AppViewHistoryPurgeResult {
  return { skipped: true, reason, deletedCount: 0, hasMore: false }
}

function normalizeViewHistoryPurgeLimit(value: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 5000 ? value : 1000
}

function requirePurgeTimestamp(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('VIEW_HISTORY_PURGE_TIME_INVALID')
  }
  return value.toISOString()
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeHistoryCursor(value: string, accountScope: string): HistoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error('cursor format')
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<HistoryCursor>
    if (
      parsed.v !== HISTORY_CURSOR_VERSION
      || parsed.accountScope !== accountScope
      || typeof parsed.lastViewedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.lastViewedAt))
      || typeof parsed.profileId !== 'string'
      || normalizeAppProfileId(parsed.profileId) !== parsed.profileId
    ) {
      throw new Error('cursor payload')
    }
    return parsed as HistoryCursor
  }
  catch {
    throw new AppInteractionCollectionError(400, 'INVALID_CURSOR', '浏览历史游标无效或已不适用于当前账号')
  }
}
