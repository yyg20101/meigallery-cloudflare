import type {
  AppSearchHistoryClearResult,
  AppSearchHistoryDeleteResult,
  AppSearchHistoryItem,
  AppSearchHistoryRecordResult,
  AppSearchHistorySettings,
} from '@meigallery/shared'
import {
  AppPersonSearchError,
  assertPositiveSearchAccountId,
  normalizeAppPersonSearchText,
  normalizeSearchExpectedVersion,
  normalizeSearchHistoryId,
  normalizeSearchHistoryPageLimit,
  requireAppPersonSearchPolicy,
  type AppPersonSearchRuntimeConfig,
} from './app-person-search-policy'

const SEARCH_HISTORY_CURSOR_VERSION = 1
const SEARCH_ID_PATTERN = /^srch_[A-Za-z0-9_-]{8,91}$/u

type SearchHistoryPreferenceRow = {
  recording_enabled: number
  version: number
  mutation_token: string
  updated_at: string
}

type SearchHistoryRow = {
  history_id: string
  query_text: string
  query_hash: string
  first_searched_at: string
  last_searched_at: string
  search_count: number
  last_search_id_hash: string
  expires_at: string
}

type SearchHistoryCursor = {
  v: 1
  accountScope: string
  lastSearchedAt: string
  historyId: string
}

export interface AppSearchHistoryListQuery {
  limit: number
  cursor: SearchHistoryCursor | null
}

export interface UpdateAppSearchHistorySettingsInput {
  expectedVersion?: unknown
  recordingEnabled?: unknown
}

export interface RecordAppSearchHistoryInput {
  searchId?: unknown
  query?: unknown
  expectedHistoryVersion?: unknown
}

export interface ClearAppSearchHistoryInput {
  expectedVersion?: unknown
  disableRecording?: unknown
}

export interface AppSearchHistoryPurgeResult {
  skipped: boolean
  deletedCount: number
}

export function parseAppSearchHistoryListQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
}): AppSearchHistoryListQuery {
  return {
    limit: normalizeSearchHistoryPageLimit(input.limit),
    cursor: input.cursor
      ? decodeSearchHistoryCursor(input.cursor, input.accountScope)
      : null,
  }
}

export async function getAppSearchHistorySettings(
  db: D1Database,
  accountId: number,
  config: AppPersonSearchRuntimeConfig,
  now = new Date(),
): Promise<AppSearchHistorySettings> {
  assertPositiveSearchAccountId(accountId)
  const policy = await requireAppPersonSearchPolicy(db, config, 'history', now)
  return mapSettings(await findPreference(db, accountId), policy)
}

export async function updateAppSearchHistorySettings(
  db: D1Database,
  accountId: number,
  input: UpdateAppSearchHistorySettingsInput,
  config: AppPersonSearchRuntimeConfig,
  now = new Date(),
): Promise<AppSearchHistorySettings> {
  assertPositiveSearchAccountId(accountId)
  const policy = await requireAppPersonSearchPolicy(db, config, 'history', now)
  requireInputObject(
    input,
    ['expectedVersion', 'recordingEnabled'],
    'SEARCH_HISTORY_SETTING_INVALID',
  )
  const expectedVersion = normalizeSearchExpectedVersion(input.expectedVersion)
  if (typeof input.recordingEnabled !== 'boolean') {
    throw new AppPersonSearchError(400, 'SEARCH_HISTORY_SETTING_INVALID', 'recordingEnabled 必须为布尔值')
  }
  const current = await findPreference(db, accountId)
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  if (!current) {
    if (expectedVersion !== 1) throw searchHistoryVersionConflict()
    const result = await db.prepare(`
      INSERT OR IGNORE INTO app_search_history_preferences (
        account_id, recording_enabled, version, mutation_token, updated_at
      ) VALUES (?, ?, 2, ?, ?)
    `).bind(accountId, input.recordingEnabled ? 1 : 0, mutationToken, nowIso).run()
    if (Number(result.meta.changes ?? 0) !== 1) throw searchHistoryVersionConflict()
  }
  else {
    if (current.version !== expectedVersion) throw searchHistoryVersionConflict()
    const result = await db.prepare(`
      UPDATE app_search_history_preferences
      SET recording_enabled = ?, version = version + 1,
          mutation_token = ?, updated_at = ?
      WHERE account_id = ? AND version = ?
    `).bind(
      input.recordingEnabled ? 1 : 0,
      mutationToken,
      nowIso,
      accountId,
      expectedVersion,
    ).run()
    if (Number(result.meta.changes ?? 0) !== 1) throw searchHistoryVersionConflict()
  }
  return mapSettings((await findPreference(db, accountId))!, policy)
}

export async function recordAppSearchHistory(
  db: D1Database,
  accountId: number,
  input: RecordAppSearchHistoryInput,
  config: AppPersonSearchRuntimeConfig,
  now = new Date(),
): Promise<AppSearchHistoryRecordResult> {
  assertPositiveSearchAccountId(accountId)
  const policy = await requireAppPersonSearchPolicy(db, config, 'history', now)
  requireInputObject(
    input,
    ['searchId', 'query', 'expectedHistoryVersion'],
    'SEARCH_HISTORY_RECORD_INVALID',
  )
  const searchId = normalizeSearchId(input.searchId)
  const queryText = normalizeAppPersonSearchText(input.query, policy.maxQueryLength)
  const expectedVersion = normalizeSearchExpectedVersion(input.expectedHistoryVersion)
  const preference = await findPreference(db, accountId)
  if (!preference || preference.version !== expectedVersion) throw searchHistoryVersionConflict()
  if (preference.recording_enabled !== 1) {
    throw new AppPersonSearchError(403, 'SEARCH_HISTORY_RECORDING_DISABLED', '搜索历史记录当前已关闭')
  }

  const queryHash = await sha256Hex(`${accountId}\u0000${queryText.toLowerCase()}`)
  const historyId = `sh_${queryHash}`
  const searchIdHash = await sha256Hex(`${accountId}\u0000${searchId}`)
  const nowIso = now.toISOString()
  const expiresAt = new Date(
    now.getTime() + policy.historyRetentionDays * 86_400_000,
  ).toISOString()
  const results = await db.batch([
    db.prepare(`
      INSERT INTO app_person_search_history (
        account_id, history_id, query_text, query_hash,
        first_searched_at, last_searched_at, search_count,
        last_search_id_hash, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
      FROM app_search_history_preferences preference
      WHERE preference.account_id = ?
        AND preference.recording_enabled = 1
        AND preference.version = ?
      ON CONFLICT (account_id, query_hash) DO UPDATE SET
        query_text = excluded.query_text,
        first_searched_at = CASE
          WHEN app_person_search_history.expires_at <= excluded.last_searched_at
            THEN excluded.first_searched_at
          ELSE app_person_search_history.first_searched_at
        END,
        last_searched_at = excluded.last_searched_at,
        search_count = CASE
          WHEN app_person_search_history.expires_at <= excluded.last_searched_at THEN 1
          ELSE MIN(app_person_search_history.search_count + 1, 1000000000)
        END,
        last_search_id_hash = excluded.last_search_id_hash,
        expires_at = excluded.expires_at
      WHERE app_person_search_history.last_search_id_hash <> excluded.last_search_id_hash
    `).bind(
      accountId,
      historyId,
      queryText,
      queryHash,
      nowIso,
      nowIso,
      searchIdHash,
      expiresAt,
      accountId,
      expectedVersion,
    ),
    db.prepare(`
      DELETE FROM app_person_search_history
      WHERE account_id = ?
        AND history_id IN (
          SELECT history_id
          FROM app_person_search_history
          WHERE account_id = ?
          ORDER BY last_searched_at DESC,
                   CASE WHEN history_id = ? THEN 0 ELSE 1 END,
                   history_id ASC
          LIMIT -1 OFFSET ?
        )
        AND EXISTS (
          SELECT 1
          FROM app_search_history_preferences preference
          WHERE preference.account_id = ?
            AND preference.recording_enabled = 1
            AND preference.version = ?
        )
    `).bind(
      accountId,
      accountId,
      historyId,
      policy.maxHistoryItems,
      accountId,
      expectedVersion,
    ),
  ])

  const latestPreference = await findPreference(db, accountId)
  if (!latestPreference || latestPreference.version !== expectedVersion) {
    throw searchHistoryVersionConflict()
  }
  if (latestPreference.recording_enabled !== 1) {
    throw new AppPersonSearchError(403, 'SEARCH_HISTORY_RECORDING_DISABLED', '搜索历史记录当前已关闭')
  }
  const row = await findHistoryRow(db, accountId, historyId)
  if (Number(results[0]?.meta?.changes ?? 0) === 1 && row) {
    return {
      historyId,
      recorded: true,
      duplicate: false,
      settingsVersion: expectedVersion,
      lastSearchedAt: requireStoredTime(row.last_searched_at),
      expiresAt: requireStoredTime(row.expires_at),
    }
  }
  if (row?.last_search_id_hash === searchIdHash) {
    return {
      historyId,
      recorded: true,
      duplicate: true,
      settingsVersion: expectedVersion,
      lastSearchedAt: requireStoredTime(row.last_searched_at),
      expiresAt: requireStoredTime(row.expires_at),
    }
  }
  throw new AppPersonSearchError(
    409,
    'SEARCH_HISTORY_WRITE_CONFLICT',
    '搜索历史状态已变化，请刷新后重试',
    true,
  )
}

export async function listAppSearchHistory(
  db: D1Database,
  accountId: number,
  accountScope: string,
  config: AppPersonSearchRuntimeConfig,
  query: AppSearchHistoryListQuery,
  now = new Date(),
): Promise<{ data: AppSearchHistoryItem[]; nextCursor: string | null; hasMore: boolean }> {
  assertPositiveSearchAccountId(accountId)
  await requireAppPersonSearchPolicy(db, config, 'history', now)
  const conditions = ['account_id = ?', 'expires_at > ?']
  const bindings: unknown[] = [accountId, now.toISOString()]
  if (query.cursor) {
    conditions.push('(last_searched_at < ? OR (last_searched_at = ? AND history_id > ?))')
    bindings.push(
      query.cursor.lastSearchedAt,
      query.cursor.lastSearchedAt,
      query.cursor.historyId,
    )
  }
  const result = await db.prepare(`
    SELECT history_id, query_text, query_hash, first_searched_at,
           last_searched_at, search_count, last_search_id_hash, expires_at
    FROM app_person_search_history
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_searched_at DESC, history_id ASC
    LIMIT ?
  `).bind(...bindings, query.limit + 1).all<SearchHistoryRow>()
  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  const last = rows.at(-1)
  return {
    data: rows.map(mapHistoryItem),
    nextCursor: hasMore && last
      ? encodeSearchHistoryCursor({
          v: SEARCH_HISTORY_CURSOR_VERSION,
          accountScope,
          lastSearchedAt: last.last_searched_at,
          historyId: last.history_id,
        })
      : null,
    hasMore,
  }
}

export async function deleteAppSearchHistoryItem(
  db: D1Database,
  accountId: number,
  historyIdValue: unknown,
  config: AppPersonSearchRuntimeConfig,
  now = new Date(),
): Promise<AppSearchHistoryDeleteResult> {
  assertPositiveSearchAccountId(accountId)
  await requireAppPersonSearchPolicy(db, config, 'history', now)
  const historyId = normalizeSearchHistoryId(historyIdValue)
  const current = await findPreference(db, accountId)
  const currentVersion = current?.version ?? 1
  const nextVersion = currentVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const preferenceStatement = current
    ? db.prepare(`
        UPDATE app_search_history_preferences
        SET version = ?, mutation_token = ?, updated_at = ?
        WHERE account_id = ? AND version = ?
      `).bind(nextVersion, mutationToken, nowIso, accountId, currentVersion)
    : db.prepare(`
        INSERT OR IGNORE INTO app_search_history_preferences (
          account_id, recording_enabled, version, mutation_token, updated_at
        ) VALUES (?, 0, ?, ?, ?)
      `).bind(accountId, nextVersion, mutationToken, nowIso)
  const results = await db.batch([
    preferenceStatement,
    db.prepare(`
      DELETE FROM app_person_search_history
      WHERE account_id = ? AND history_id = ?
        AND EXISTS (
          SELECT 1
          FROM app_search_history_preferences preference
          WHERE preference.account_id = ?
            AND preference.version = ?
            AND preference.mutation_token = ?
        )
    `).bind(accountId, historyId, accountId, nextVersion, mutationToken),
  ])
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw searchHistoryVersionConflict()
  return {
    historyId,
    deleted: Number(results[1]?.meta?.changes ?? 0) > 0,
    settingsVersion: nextVersion,
    updatedAt: nowIso,
  }
}

export async function clearAppSearchHistory(
  db: D1Database,
  accountId: number,
  input: ClearAppSearchHistoryInput,
  config: AppPersonSearchRuntimeConfig,
  now = new Date(),
): Promise<AppSearchHistoryClearResult> {
  assertPositiveSearchAccountId(accountId)
  await requireAppPersonSearchPolicy(db, config, 'history', now)
  requireInputObject(
    input,
    ['expectedVersion', 'disableRecording'],
    'SEARCH_HISTORY_CLEAR_INVALID',
  )
  const expectedVersion = normalizeSearchExpectedVersion(input.expectedVersion)
  if (typeof input.disableRecording !== 'boolean') {
    throw new AppPersonSearchError(400, 'SEARCH_HISTORY_CLEAR_INVALID', 'disableRecording 必须为布尔值')
  }
  const current = await findPreference(db, accountId)
  if (current && current.version !== expectedVersion) throw searchHistoryVersionConflict()
  if (!current && expectedVersion !== 1) throw searchHistoryVersionConflict()
  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const preferenceStatement = current
    ? db.prepare(`
        UPDATE app_search_history_preferences
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
      )
    : db.prepare(`
        INSERT OR IGNORE INTO app_search_history_preferences (
          account_id, recording_enabled, version, mutation_token, updated_at
        ) VALUES (?, 0, ?, ?, ?)
      `).bind(accountId, nextVersion, mutationToken, nowIso)
  const results = await db.batch([
    preferenceStatement,
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_person_search_history
      WHERE account_id = ?
    `).bind(accountId),
    db.prepare(`
      DELETE FROM app_person_search_history
      WHERE account_id = ?
        AND EXISTS (
          SELECT 1
          FROM app_search_history_preferences preference
          WHERE preference.account_id = ?
            AND preference.version = ?
            AND preference.mutation_token = ?
        )
    `).bind(accountId, accountId, nextVersion, mutationToken),
  ])
  const updated = await findPreference(db, accountId)
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 1
    || !updated
    || updated.version !== nextVersion
    || updated.mutation_token !== mutationToken
  ) throw searchHistoryVersionConflict()
  const count = results[1]?.results?.[0] as { count?: number } | undefined
  return {
    clearedCount: requireNonNegativeCount(count?.count),
    recordingEnabled: updated.recording_enabled === 1,
    settingsVersion: updated.version,
    updatedAt: requireStoredTime(updated.updated_at),
  }
}

export async function purgeExpiredAppSearchHistory(
  db: D1Database,
  config: AppPersonSearchRuntimeConfig,
  now = new Date(),
  limit = 1000,
): Promise<AppSearchHistoryPurgeResult> {
  if (!config.policyConfigured) return { skipped: true, deletedCount: 0 }
  const safeLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 5000
    ? limit
    : 1000
  const policy = await db.prepare(`
    SELECT purge_enabled
    FROM app_person_search_policies
    WHERE id = ?
    LIMIT 1
  `).bind(config.policyId).first<{ purge_enabled: number }>()
  if (policy?.purge_enabled !== 1) return { skipped: true, deletedCount: 0 }
  const result = await db.prepare(`
    DELETE FROM app_person_search_history
    WHERE rowid IN (
      SELECT rowid
      FROM app_person_search_history
      WHERE expires_at <= ?
      ORDER BY expires_at ASC, account_id ASC, history_id ASC
      LIMIT ?
    )
  `).bind(now.toISOString(), safeLimit).run()
  return {
    skipped: false,
    deletedCount: Number(result.meta.changes ?? 0),
  }
}

function mapSettings(
  preference: SearchHistoryPreferenceRow | null,
  policy: {
    historyRetentionDays: number
    maxHistoryItems: number
  },
): AppSearchHistorySettings {
  return {
    recordingEnabled: preference?.recording_enabled === 1,
    version: preference?.version ?? 1,
    retentionDays: policy.historyRetentionDays,
    maxItems: policy.maxHistoryItems,
    updatedAt: preference?.updated_at ?? null,
  }
}

function mapHistoryItem(row: SearchHistoryRow): AppSearchHistoryItem {
  const searchCount = Number(row.search_count)
  if (!Number.isSafeInteger(searchCount) || searchCount < 1) {
    throw new AppPersonSearchError(503, 'SEARCH_HISTORY_DATA_INVALID', '搜索历史次数数据异常')
  }
  return {
    historyId: normalizeSearchHistoryId(row.history_id),
    query: row.query_text,
    firstSearchedAt: requireStoredTime(row.first_searched_at),
    lastSearchedAt: requireStoredTime(row.last_searched_at),
    searchCount,
    expiresAt: requireStoredTime(row.expires_at),
  }
}

async function findPreference(
  db: D1Database,
  accountId: number,
): Promise<SearchHistoryPreferenceRow | null> {
  return db.prepare(`
    SELECT recording_enabled, version, mutation_token, updated_at
    FROM app_search_history_preferences
    WHERE account_id = ?
    LIMIT 1
  `).bind(accountId).first<SearchHistoryPreferenceRow>()
}

async function findHistoryRow(
  db: D1Database,
  accountId: number,
  historyId: string,
): Promise<SearchHistoryRow | null> {
  return db.prepare(`
    SELECT history_id, query_text, query_hash, first_searched_at,
           last_searched_at, search_count, last_search_id_hash, expires_at
    FROM app_person_search_history
    WHERE account_id = ? AND history_id = ?
    LIMIT 1
  `).bind(accountId, historyId).first<SearchHistoryRow>()
}

function normalizeSearchId(value: unknown): string {
  if (typeof value !== 'string' || !SEARCH_ID_PATTERN.test(value)) {
    throw new AppPersonSearchError(400, 'SEARCH_ID_INVALID', 'searchId 格式无效')
  }
  return value
}

function requireInputObject(
  value: unknown,
  allowedKeys: string[],
  code: string,
): asserts value is Record<string, unknown> {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).some(key => !allowedKeys.includes(key))
  ) {
    throw new AppPersonSearchError(400, code, '请求体格式无效或包含未支持字段')
  }
}

function requireStoredTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AppPersonSearchError(503, 'SEARCH_HISTORY_DATA_INVALID', '搜索历史时间数据异常')
  }
  return value
}

function requireNonNegativeCount(value: number | undefined): number {
  const count = Number(value ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AppPersonSearchError(503, 'SEARCH_HISTORY_DATA_INVALID', '搜索历史数量数据异常')
  }
  return count
}

function searchHistoryVersionConflict(): AppPersonSearchError {
  return new AppPersonSearchError(
    409,
    'SEARCH_HISTORY_VERSION_CONFLICT',
    '搜索历史设置已在其他设备更新，请刷新后重试',
    true,
  )
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function encodeSearchHistoryCursor(cursor: SearchHistoryCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeSearchHistoryCursor(value: string, accountScope: string): SearchHistoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error('cursor format')
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SearchHistoryCursor>
    if (
      parsed.v !== SEARCH_HISTORY_CURSOR_VERSION
      || parsed.accountScope !== accountScope
      || typeof parsed.lastSearchedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.lastSearchedAt))
      || typeof parsed.historyId !== 'string'
      || normalizeSearchHistoryId(parsed.historyId) !== parsed.historyId
    ) {
      throw new Error('cursor payload')
    }
    return parsed as SearchHistoryCursor
  }
  catch {
    throw new AppPersonSearchError(
      400,
      'SEARCH_HISTORY_CURSOR_INVALID',
      '搜索历史游标无效或已不适用于当前账号',
    )
  }
}
