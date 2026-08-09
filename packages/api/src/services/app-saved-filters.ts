import type { AppPersonSearchSort } from '@meigallery/shared'
import type { AppMembershipRuntimeConfig } from './app-membership'
import {
  assertAppFilterSelectionCanApply,
  getAppSearchFilterCapabilities,
  normalizeAppSearchFilterReference,
  resolveAppPersonFilterSelection,
  toAppSearchFilterSelectionResponse,
  type AppResolvedPersonFilterSelection,
} from './app-search-filters'
import {
  AppPersonSearchError,
  assertPositiveSearchAccountId,
  normalizeSearchExpectedVersion,
  type AppPersonSearchPolicy,
} from './app-person-search-policy'
import type { AppTaxonomyRuntimeConfig } from './app-taxonomy'

const SAVED_FILTER_ID_PATTERN = /^sf_[0-9a-f]{64}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const MAX_SAVED_FILTER_ROWS = 100

type SavedFilterSort = Exclude<AppPersonSearchSort, 'relevance'>

type SavedFilterRow = {
  filter_id: string
  name: string
  normalized_name: string
  catalog_id: string
  term_ids_json: string
  default_sort: string
  idempotency_key_hash: string
  request_hash: string
  version: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface CreateAppSavedFilterInput {
  name?: unknown
  filters?: unknown
  defaultSort?: unknown
}

export interface UpdateAppSavedFilterInput {
  expectedVersion?: unknown
  name?: unknown
  filters?: unknown
  defaultSort?: unknown
}

export async function listAppSavedFilters(
  db: D1Database,
  accountId: number,
  policy: AppPersonSearchPolicy,
  taxonomyConfig: AppTaxonomyRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
) {
  assertPositiveSearchAccountId(accountId)
  const [rows, capabilities] = await Promise.all([
    db.prepare(`
      SELECT filter_id, name, normalized_name, catalog_id, term_ids_json,
             default_sort, idempotency_key_hash, request_hash, version,
             created_at, updated_at, deleted_at
      FROM app_saved_person_filters
      WHERE account_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC, filter_id ASC
      LIMIT ?
    `).bind(accountId, MAX_SAVED_FILTER_ROWS).all<SavedFilterRow>(),
    getAppSearchFilterCapabilities(
      db,
      accountId,
      policy,
      taxonomyConfig,
      membershipConfig,
      now,
    ),
  ])
  const items = []
  for (const row of rows.results) {
    items.push(await mapSavedFilter(
      db,
      accountId,
      row,
      policy,
      taxonomyConfig,
      membershipConfig,
      now,
    ))
  }
  return {
    items,
    count: capabilities.savedFilters.count,
    max: capabilities.savedFilters.max,
    canCreate: capabilities.savedFilters.canCreate,
  }
}

export async function getAppSavedFilter(
  db: D1Database,
  accountId: number,
  filterIdValue: unknown,
  policy: AppPersonSearchPolicy,
  taxonomyConfig: AppTaxonomyRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
) {
  assertPositiveSearchAccountId(accountId)
  const filterId = normalizeSavedFilterId(filterIdValue)
  const row = await findSavedFilter(db, accountId, filterId, false)
  if (!row) throw savedFilterNotFound()
  return mapSavedFilter(
    db,
    accountId,
    row,
    policy,
    taxonomyConfig,
    membershipConfig,
    now,
  )
}

export async function createAppSavedFilter(
  db: D1Database,
  accountId: number,
  accountScope: string,
  inputValue: unknown,
  idempotencyKeyValue: string | null,
  policy: AppPersonSearchPolicy,
  taxonomyConfig: AppTaxonomyRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
) {
  assertPositiveSearchAccountId(accountId)
  const input = requireCreateInput(inputValue)
  const name = normalizeSavedFilterName(input.name, policy.maxSavedFilterNameLength)
  const reference = normalizeAppSearchFilterReference(input.filters, policy.maxFilterTerms)
  const defaultSort = normalizeSavedFilterSort(input.defaultSort)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const idempotencyKeyHash = await sha256Hex(idempotencyKey)
  const filterId = `sf_${await sha256Hex(`saved-filter\u0000${accountScope}\u0000${idempotencyKey}`)}`
  const requestHash = await sha256Hex(JSON.stringify({
    name: name.normalized,
    catalogVersionId: reference.catalogVersionId,
    termIds: reference.termIds,
    defaultSort,
  }))
  const existing = await findSavedFilterByIdempotencyHash(db, accountId, idempotencyKeyHash)
  if (existing) {
    assertSavedFilterReplay(existing, requestHash)
    return {
      savedFilter: await mapSavedFilter(
        db,
        accountId,
        existing,
        policy,
        taxonomyConfig,
        membershipConfig,
        now,
      ),
      replayed: true,
    }
  }

  const selection = await resolveAppPersonFilterSelection(
    db,
    accountId,
    input.filters,
    policy,
    taxonomyConfig,
    membershipConfig,
    now,
  )
  assertAppFilterSelectionCanApply(selection)
  const savedFilterMax = selection.access.savedFilterMax
  if (savedFilterMax <= 0) {
    throw new AppPersonSearchError(
      403,
      'SAVED_FILTER_ENTITLEMENT_REQUIRED',
      '当前会员权益不包含保存筛选条件',
    )
  }
  const nowIso = now.toISOString()
  try {
    const result = await db.prepare(`
      INSERT INTO app_saved_person_filters (
        account_id, filter_id, name, normalized_name, catalog_id,
        term_ids_json, default_sort, idempotency_key_hash, request_hash,
        version, created_at, updated_at, deleted_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL
      WHERE (
        SELECT COUNT(*)
        FROM app_saved_person_filters
        WHERE account_id = ? AND deleted_at IS NULL
      ) < ?
    `).bind(
      accountId,
      filterId,
      name.value,
      name.normalized,
      selection.catalogVersionId,
      JSON.stringify(selection.termIds),
      defaultSort,
      idempotencyKeyHash,
      requestHash,
      nowIso,
      nowIso,
      accountId,
      savedFilterMax,
    ).run()
    if ((result.meta.changes ?? 0) !== 1) throw savedFilterLimitReached()
  }
  catch (error) {
    const raced = await findSavedFilterByIdempotencyHash(db, accountId, idempotencyKeyHash)
    if (raced) {
      assertSavedFilterReplay(raced, requestHash)
      return {
        savedFilter: await mapSavedFilter(
          db,
          accountId,
          raced,
          policy,
          taxonomyConfig,
          membershipConfig,
          now,
        ),
        replayed: true,
      }
    }
    if (await findSavedFilterByName(db, accountId, name.normalized)) {
      throw new AppPersonSearchError(409, 'SAVED_FILTER_NAME_CONFLICT', '已存在同名保存条件')
    }
    const count = await countActiveSavedFilters(db, accountId)
    if (count >= savedFilterMax) throw savedFilterLimitReached()
    throw error
  }
  const row = await findSavedFilter(db, accountId, filterId, false)
  if (!row) {
    throw new AppPersonSearchError(503, 'SAVED_FILTER_WRITE_FAILED', '保存条件写入结果异常', true)
  }
  return {
    savedFilter: mapSavedFilterWithSelection(row, selection),
    replayed: false,
  }
}

export async function updateAppSavedFilter(
  db: D1Database,
  accountId: number,
  filterIdValue: unknown,
  inputValue: unknown,
  policy: AppPersonSearchPolicy,
  taxonomyConfig: AppTaxonomyRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now = new Date(),
) {
  assertPositiveSearchAccountId(accountId)
  const filterId = normalizeSavedFilterId(filterIdValue)
  const input = requireUpdateInput(inputValue)
  const expectedVersion = normalizeSearchExpectedVersion(input.expectedVersion)
  if (input.name === undefined && input.filters === undefined && input.defaultSort === undefined) {
    throw new AppPersonSearchError(400, 'SAVED_FILTER_UPDATE_EMPTY', '请至少修改名称、筛选条件或默认排序')
  }
  const current = await findSavedFilter(db, accountId, filterId, false)
  if (!current) throw savedFilterNotFound()
  if (current.version !== expectedVersion) throw savedFilterVersionConflict()
  const name = input.name === undefined
    ? { value: current.name, normalized: current.normalized_name }
    : normalizeSavedFilterName(input.name, policy.maxSavedFilterNameLength)
  const defaultSort = input.defaultSort === undefined
    ? normalizeStoredSort(current.default_sort)
    : normalizeSavedFilterSort(input.defaultSort)
  const selection = input.filters === undefined
    ? null
    : await resolveAppPersonFilterSelection(
        db,
        accountId,
        input.filters,
        policy,
        taxonomyConfig,
        membershipConfig,
        now,
      )
  if (input.filters !== undefined) assertAppFilterSelectionCanApply(selection)
  const storedReference = selection
    ? { catalogVersionId: selection.catalogVersionId, termIds: selection.termIds }
    : readStoredFilterReference(current, policy.maxFilterTerms)
  try {
    const result = await db.prepare(`
      UPDATE app_saved_person_filters
      SET name = ?, normalized_name = ?, catalog_id = ?, term_ids_json = ?,
          default_sort = ?, version = version + 1, updated_at = ?
      WHERE account_id = ? AND filter_id = ? AND deleted_at IS NULL AND version = ?
    `).bind(
      name.value,
      name.normalized,
      storedReference.catalogVersionId,
      JSON.stringify(storedReference.termIds),
      defaultSort,
      now.toISOString(),
      accountId,
      filterId,
      expectedVersion,
    ).run()
    if ((result.meta.changes ?? 0) !== 1) throw savedFilterVersionConflict()
  }
  catch (error) {
    if (error instanceof AppPersonSearchError) throw error
    const byName = await findSavedFilterByName(db, accountId, name.normalized)
    if (byName && byName.filter_id !== filterId) {
      throw new AppPersonSearchError(409, 'SAVED_FILTER_NAME_CONFLICT', '已存在同名保存条件')
    }
    throw error
  }
  const updated = await findSavedFilter(db, accountId, filterId, false)
  if (!updated) throw savedFilterVersionConflict()
  return selection
    ? mapSavedFilterWithSelection(updated, selection)
    : mapSavedFilter(
        db,
        accountId,
        updated,
        policy,
        taxonomyConfig,
        membershipConfig,
        now,
      )
}

export async function deleteAppSavedFilter(
  db: D1Database,
  accountId: number,
  filterIdValue: unknown,
  expectedVersionValue: unknown,
  now = new Date(),
) {
  assertPositiveSearchAccountId(accountId)
  const filterId = normalizeSavedFilterId(filterIdValue)
  const expectedVersion = normalizeSearchExpectedVersion(expectedVersionValue)
  const current = await findSavedFilter(db, accountId, filterId, false)
  if (!current) {
    return { filterId, deleted: false, version: null, updatedAt: null }
  }
  if (current.version !== expectedVersion) throw savedFilterVersionConflict()
  const nowIso = now.toISOString()
  const result = await db.prepare(`
    UPDATE app_saved_person_filters
    SET name = '已删除条件', normalized_name = filter_id,
        term_ids_json = '[]', version = version + 1,
        updated_at = ?, deleted_at = ?
    WHERE account_id = ? AND filter_id = ? AND deleted_at IS NULL AND version = ?
  `).bind(nowIso, nowIso, accountId, filterId, expectedVersion).run()
  if ((result.meta.changes ?? 0) !== 1) throw savedFilterVersionConflict()
  return { filterId, deleted: true, version: expectedVersion + 1, updatedAt: nowIso }
}

async function mapSavedFilter(
  db: D1Database,
  accountId: number,
  row: SavedFilterRow,
  policy: AppPersonSearchPolicy,
  taxonomyConfig: AppTaxonomyRuntimeConfig,
  membershipConfig: AppMembershipRuntimeConfig,
  now: Date,
) {
  const reference = readStoredFilterReference(row, policy.maxFilterTerms)
  const selection = await resolveAppPersonFilterSelection(
    db,
    accountId,
    reference,
    policy,
    taxonomyConfig,
    membershipConfig,
    now,
  )
  if (!selection) {
    throw new AppPersonSearchError(503, 'SAVED_FILTER_DATA_INVALID', '保存条件内容异常')
  }
  return mapSavedFilterWithSelection(row, selection)
}

function mapSavedFilterWithSelection(
  row: SavedFilterRow,
  selection: AppResolvedPersonFilterSelection,
) {
  return {
    filterId: row.filter_id,
    name: row.name,
    defaultSort: normalizeStoredSort(row.default_sort),
    version: requireStoredVersion(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    filters: toAppSearchFilterSelectionResponse(selection),
  }
}

function readStoredFilterReference(row: SavedFilterRow, maxTerms: number) {
  let termIds: unknown
  try {
    termIds = JSON.parse(row.term_ids_json)
  }
  catch {
    throw new AppPersonSearchError(503, 'SAVED_FILTER_DATA_INVALID', '保存条件内容异常')
  }
  try {
    return normalizeAppSearchFilterReference({
      catalogVersionId: row.catalog_id,
      termIds,
    }, maxTerms)
  }
  catch (error) {
    if (error instanceof AppPersonSearchError) {
      throw new AppPersonSearchError(503, 'SAVED_FILTER_DATA_INVALID', '保存条件内容异常')
    }
    throw error
  }
}

function requireCreateInput(value: unknown): CreateAppSavedFilterInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppPersonSearchError(400, 'SAVED_FILTER_REQUEST_INVALID', '保存条件请求必须为 JSON 对象')
  }
  if (Object.keys(value).some(key => !['name', 'filters', 'defaultSort'].includes(key))) {
    throw new AppPersonSearchError(400, 'SAVED_FILTER_REQUEST_INVALID', '保存条件请求包含未支持字段')
  }
  return value as CreateAppSavedFilterInput
}

function requireUpdateInput(value: unknown): UpdateAppSavedFilterInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppPersonSearchError(400, 'SAVED_FILTER_REQUEST_INVALID', '保存条件请求必须为 JSON 对象')
  }
  if (Object.keys(value).some(key => !['expectedVersion', 'name', 'filters', 'defaultSort'].includes(key))) {
    throw new AppPersonSearchError(400, 'SAVED_FILTER_REQUEST_INVALID', '保存条件请求包含未支持字段')
  }
  return value as UpdateAppSavedFilterInput
}

function normalizeSavedFilterName(value: unknown, maxLength: number) {
  if (typeof value !== 'string') {
    throw new AppPersonSearchError(400, 'SAVED_FILTER_NAME_INVALID', '保存条件名称必须为字符串')
  }
  const normalizedValue = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (
    !normalizedValue
    || [...normalizedValue].length > maxLength
    || /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(normalizedValue)
  ) {
    throw new AppPersonSearchError(
      400,
      'SAVED_FILTER_NAME_INVALID',
      `保存条件名称必须为 1 至 ${maxLength} 个有效字符`,
    )
  }
  return { value: normalizedValue, normalized: normalizedValue.toLowerCase() }
}

function normalizeSavedFilterSort(value: unknown): SavedFilterSort {
  const sort = value === undefined ? 'popular' : value
  if (sort !== 'popular' && sort !== 'latest') {
    throw new AppPersonSearchError(400, 'SAVED_FILTER_SORT_INVALID', '保存条件默认排序只支持热门或最新')
  }
  return sort
}

function normalizeStoredSort(value: string): SavedFilterSort {
  if (value !== 'popular' && value !== 'latest') {
    throw new AppPersonSearchError(503, 'SAVED_FILTER_DATA_INVALID', '保存条件默认排序异常')
  }
  return value
}

function normalizeSavedFilterId(value: unknown) {
  if (typeof value !== 'string' || !SAVED_FILTER_ID_PATTERN.test(value)) {
    throw new AppPersonSearchError(400, 'SAVED_FILTER_ID_INVALID', '保存条件 ID 格式无效')
  }
  return value
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppPersonSearchError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符',
    )
  }
  return normalized
}

function requireStoredVersion(value: unknown) {
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new AppPersonSearchError(503, 'SAVED_FILTER_DATA_INVALID', '保存条件版本异常')
  }
  return version
}

async function findSavedFilter(
  db: D1Database,
  accountId: number,
  filterId: string,
  includeDeleted: boolean,
) {
  return db.prepare(`
    SELECT filter_id, name, normalized_name, catalog_id, term_ids_json,
           default_sort, idempotency_key_hash, request_hash, version,
           created_at, updated_at, deleted_at
    FROM app_saved_person_filters
    WHERE account_id = ? AND filter_id = ?
      ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    LIMIT 1
  `).bind(accountId, filterId).first<SavedFilterRow>()
}

async function findSavedFilterByIdempotencyHash(
  db: D1Database,
  accountId: number,
  idempotencyKeyHash: string,
) {
  return db.prepare(`
    SELECT filter_id, name, normalized_name, catalog_id, term_ids_json,
           default_sort, idempotency_key_hash, request_hash, version,
           created_at, updated_at, deleted_at
    FROM app_saved_person_filters
    WHERE account_id = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(accountId, idempotencyKeyHash).first<SavedFilterRow>()
}

async function findSavedFilterByName(
  db: D1Database,
  accountId: number,
  normalizedName: string,
) {
  return db.prepare(`
    SELECT filter_id, name, normalized_name, catalog_id, term_ids_json,
           default_sort, idempotency_key_hash, request_hash, version,
           created_at, updated_at, deleted_at
    FROM app_saved_person_filters
    WHERE account_id = ? AND normalized_name = ? AND deleted_at IS NULL
    LIMIT 1
  `).bind(accountId, normalizedName).first<SavedFilterRow>()
}

async function countActiveSavedFilters(db: D1Database, accountId: number) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_saved_person_filters
    WHERE account_id = ? AND deleted_at IS NULL
  `).bind(accountId).first<{ count: number }>()
  const count = Number(row?.count ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AppPersonSearchError(503, 'SAVED_FILTER_DATA_INVALID', '保存条件计数异常')
  }
  return count
}

function assertSavedFilterReplay(row: SavedFilterRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppPersonSearchError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同保存条件请求')
  }
  if (row.deleted_at !== null) {
    throw new AppPersonSearchError(409, 'IDEMPOTENCY_KEY_RETIRED', '该幂等键对应的保存条件已删除，不能再次使用')
  }
}

function savedFilterNotFound() {
  return new AppPersonSearchError(404, 'SAVED_FILTER_NOT_FOUND', '保存条件不存在')
}

function savedFilterVersionConflict() {
  return new AppPersonSearchError(409, 'SAVED_FILTER_VERSION_CONFLICT', '保存条件版本已变化，请刷新后重试')
}

function savedFilterLimitReached() {
  return new AppPersonSearchError(403, 'SAVED_FILTER_LIMIT_REACHED', '保存条件数量已达到当前会员权益上限')
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
