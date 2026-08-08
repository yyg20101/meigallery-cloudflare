import type {
  AppWalletDirection,
  AppWalletEntryDetail,
  AppWalletEntrySummary,
  AppWalletEntryType,
  AppWalletReasonCode,
  AppWalletSummary,
} from '@meigallery/shared'
import type { Bindings } from '../index'

export const APP_WALLET_POLICY_ID = 'wlp_app_1_0_wallet_1_dev_1'
export const APP_WALLET_MAX_PAGE_SIZE = 40
export const APP_WALLET_DISCLAIMER = '金币仅用于记录平台调整，当前不可购买、消费、转赠、兑换或提现，不具有现金价值。'

const DEFAULT_PAGE_SIZE = 20
const ENTRY_ID = /^wle_[A-Za-z0-9_-]{1,92}$/u

export interface AppWalletRuntimeConfig {
  enabled: boolean
  adminEnabled: boolean
  policyId: string
  requireProductionReady: boolean
}

export interface AppWalletEntryListQuery {
  direction: AppWalletDirection | null
  limit: number
  cursor: null | {
    v: 1
    accountScope: string
    direction: AppWalletDirection | null
    postedAt: string
    entryId: string
  }
}

type WalletPolicyRow = {
  id: string
  state: string
  production_ready: number
  adjustments_enabled: number
  risk_decision_status: string
  retention_decision_status: string
  data_location_decision_status: string
  require_independent_review: number
  allow_negative_balance: number
  max_single_amount: number
}

type WalletRow = {
  balance: number
  sequence: number
  status: string
  last_entry_at: string | null
}

type EntryRow = {
  id: string
  public_reference: string
  action_type: string
  direction: string
  amount: number
  reason_code: string
  user_visible_note: string
  balance_before: number
  balance_after: number
  sequence: number
  status: string
  posted_at: string
  original_entry_id: string | null
  reversal_entry_id: string | null
  related_entry_id?: string | null
  related_public_reference?: string | null
  related_direction?: string | null
  related_amount?: number | null
  related_posted_at?: string | null
}

export class AppWalletError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppWalletError'
  }
}

export function getAppWalletRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_WALLET_ENABLED'
  | 'APP_WALLET_ADMIN_ENABLED'
  | 'APP_WALLET_POLICY_VERSION'
  | 'APP_WALLET_PRODUCTION_READY'
>): AppWalletRuntimeConfig {
  const requireProductionReady = env.APP_ENV === 'production'
  const configuredPolicy = normalizePolicyId(env.APP_WALLET_POLICY_VERSION)
  const policyId = configuredPolicy ?? APP_WALLET_POLICY_ID
  const productionGateSatisfied = !requireProductionReady
    || env.APP_WALLET_PRODUCTION_READY === 'true'
  return {
    enabled: env.APP_WALLET_ENABLED === 'true'
      && Boolean(configuredPolicy)
      && productionGateSatisfied,
    adminEnabled: env.APP_WALLET_ADMIN_ENABLED === 'true'
      && Boolean(configuredPolicy)
      && productionGateSatisfied,
    policyId,
    requireProductionReady,
  }
}

export function requireAppWalletEnabled(config: AppWalletRuntimeConfig): void {
  if (!config.enabled) {
    throw new AppWalletError(403, 'FEATURE_DISABLED', '金币钱包尚未开放')
  }
}

export function requireAppWalletAdminEnabled(config: AppWalletRuntimeConfig): void {
  if (!config.adminEnabled) {
    throw new AppWalletError(403, 'FEATURE_DISABLED', 'App 金币管理能力尚未开放')
  }
}

export async function requireAppWalletPolicy(
  db: D1Database,
  config: AppWalletRuntimeConfig,
  options: { writable?: boolean } = {},
): Promise<WalletPolicyRow> {
  const row = await db.prepare(`
    SELECT id, state, production_ready, adjustments_enabled,
           risk_decision_status, retention_decision_status, data_location_decision_status,
           require_independent_review, allow_negative_balance, max_single_amount
    FROM app_wallet_policies
    WHERE id = ?
    LIMIT 1
  `).bind(config.policyId).first<WalletPolicyRow>()
  const stateReady = row?.state === 'development' || row?.state === 'published'
  const productionReady = !config.requireProductionReady || (
    row?.state === 'published'
    && row.production_ready === 1
    && row.risk_decision_status === 'approved'
    && row.retention_decision_status === 'approved'
    && row.data_location_decision_status === 'approved'
  )
  if (!row || !stateReady || !productionReady) {
    throw new AppWalletError(503, 'WALLET_POLICY_NOT_READY', '金币钱包策略尚未就绪', true)
  }
  if (options.writable && row.adjustments_enabled !== 1) {
    throw new AppWalletError(403, 'WALLET_ADJUSTMENTS_DISABLED', '管理员调币当前保持关闭')
  }
  return row
}

export function parseAppWalletEntryListQuery(input: {
  direction?: string
  limit?: string
  cursor?: string
  accountScope: string
}): AppWalletEntryListQuery {
  const direction = normalizeDirection(input.direction)
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, APP_WALLET_MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
  const cursor = input.cursor
    ? decodeCursor(input.cursor, input.accountScope, direction)
    : null
  return { direction, limit, cursor }
}

export async function getAppWalletSummary(
  db: D1Database,
  accountId: number,
  config: AppWalletRuntimeConfig,
  now = new Date(),
): Promise<AppWalletSummary> {
  await requireAppWalletPolicy(db, config)
  const row = await db.prepare(`
    SELECT balance, sequence, status, last_entry_at
    FROM app_wallets
    WHERE account_id = ?
    LIMIT 1
  `).bind(accountId).first<WalletRow>()
  return {
    currencyCode: 'mei_coin',
    displayName: '金币',
    balance: requireSafeBalance(row?.balance ?? 0),
    ledgerVersion: requireNonNegativeInteger(row?.sequence ?? 0),
    status: row?.status === 'frozen' ? 'frozen' : 'active',
    lastEntryAt: normalizeStoredTime(row?.last_entry_at ?? null),
    lastSyncedAt: now.toISOString(),
    disclaimer: APP_WALLET_DISCLAIMER,
  }
}

export async function listAppWalletEntries(
  db: D1Database,
  accountId: number,
  accountScope: string,
  config: AppWalletRuntimeConfig,
  query: AppWalletEntryListQuery,
): Promise<{ data: AppWalletEntrySummary[]; nextCursor: string | null; hasMore: boolean }> {
  await requireAppWalletPolicy(db, config)
  const conditions = ['entry.account_id = ?', "entry.status = 'posted'"]
  const bindings: unknown[] = [accountId]
  if (query.direction) {
    conditions.push('entry.direction = ?')
    bindings.push(query.direction)
  }
  if (query.cursor) {
    conditions.push('(entry.posted_at < ? OR (entry.posted_at = ? AND entry.id < ?))')
    bindings.push(query.cursor.postedAt, query.cursor.postedAt, query.cursor.entryId)
  }
  const result = await db.prepare(`
    SELECT entry.id, entry.public_reference, entry.action_type, entry.direction, entry.amount,
           entry.reason_code, entry.user_visible_note, entry.balance_before, entry.balance_after,
           entry.sequence, entry.status, entry.posted_at, entry.original_entry_id,
           reversal.id AS reversal_entry_id
    FROM app_wallet_entries entry
    LEFT JOIN app_wallet_entries reversal ON reversal.original_entry_id = entry.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY entry.posted_at DESC, entry.id DESC
    LIMIT ?
  `).bind(...bindings, query.limit + 1).all<EntryRow>()
  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  return {
    data: rows.map(toEntrySummary),
    hasMore,
    nextCursor: hasMore
      ? encodeCursor({
          v: 1,
          accountScope,
          direction: query.direction,
          postedAt: rows.at(-1)!.posted_at,
          entryId: rows.at(-1)!.id,
        })
      : null,
  }
}

export async function getAppWalletEntry(
  db: D1Database,
  accountId: number,
  entryId: string,
  config: AppWalletRuntimeConfig,
): Promise<AppWalletEntryDetail> {
  validateEntryId(entryId)
  await requireAppWalletPolicy(db, config)
  const row = await db.prepare(`
    SELECT entry.id, entry.public_reference, entry.action_type, entry.direction, entry.amount,
           entry.reason_code, entry.user_visible_note, entry.balance_before, entry.balance_after,
           entry.sequence, entry.status, entry.posted_at, entry.original_entry_id,
           reversal.id AS reversal_entry_id,
           COALESCE(original.id, reversal.id) AS related_entry_id,
           COALESCE(original.public_reference, reversal.public_reference) AS related_public_reference,
           COALESCE(original.direction, reversal.direction) AS related_direction,
           COALESCE(original.amount, reversal.amount) AS related_amount,
           COALESCE(original.posted_at, reversal.posted_at) AS related_posted_at
    FROM app_wallet_entries entry
    LEFT JOIN app_wallet_entries original ON original.id = entry.original_entry_id
    LEFT JOIN app_wallet_entries reversal ON reversal.original_entry_id = entry.id
    WHERE entry.id = ? AND entry.account_id = ? AND entry.status = 'posted'
    LIMIT 1
  `).bind(entryId, accountId).first<EntryRow>()
  if (!row) throw walletEntryNotFound()
  const summary = toEntrySummary(row)
  const relatedDirection = row.related_direction
    ? requireStoredDirection(row.related_direction)
    : null
  return {
    ...summary,
    balanceBefore: requireSafeBalance(row.balance_before),
    relatedEntry: row.related_entry_id
      && row.related_public_reference
      && relatedDirection
      && row.related_amount != null
      && row.related_posted_at
      ? {
          entryId: row.related_entry_id,
          publicReference: row.related_public_reference,
          direction: relatedDirection,
          amount: requirePositiveInteger(row.related_amount),
          postedAt: requireStoredTime(row.related_posted_at),
        }
      : null,
  }
}

export function walletReasonLabel(reason: AppWalletReasonCode): string {
  if (reason === 'manual_adjustment') return '管理员调整'
  if (reason === 'service_compensation') return '平台服务补偿'
  if (reason === 'correction') return '账务纠正'
  return '原分录冲正'
}

function toEntrySummary(row: EntryRow): AppWalletEntrySummary {
  const type = requireStoredEntryType(row.action_type)
  const direction = requireStoredDirection(row.direction)
  const reasonCode = requireStoredReasonCode(row.reason_code)
  if (row.status !== 'posted') {
    throw new AppWalletError(503, 'WALLET_DATA_INVALID', '金币分录数据暂不可用')
  }
  return {
    entryId: row.id,
    publicReference: row.public_reference,
    type,
    direction,
    amount: requirePositiveInteger(row.amount),
    reason: { code: reasonCode, label: walletReasonLabel(reasonCode) },
    userVisibleNote: row.user_visible_note,
    balanceAfter: requireSafeBalance(row.balance_after),
    sequence: requireNonNegativeInteger(row.sequence),
    status: 'posted',
    postedAt: requireStoredTime(row.posted_at),
    originalEntryId: row.original_entry_id,
    reversalEntryId: row.reversal_entry_id,
  }
}

function normalizePolicyId(value: string | undefined) {
  const normalized = value?.trim()
  return normalized && /^wlp_[A-Za-z0-9_-]{1,76}$/u.test(normalized) ? normalized : null
}

function normalizeDirection(value: string | undefined): AppWalletDirection | null {
  if (value === undefined || value.trim() === '' || value === 'all') return null
  if (value === 'credit' || value === 'debit') return value
  throw new AppWalletError(400, 'INVALID_WALLET_DIRECTION', '金币明细方向无效')
}

function requireStoredDirection(value: string): AppWalletDirection {
  if (value === 'credit' || value === 'debit') return value
  throw new AppWalletError(503, 'WALLET_DATA_INVALID', '金币分录数据暂不可用')
}

function requireStoredEntryType(value: string): AppWalletEntryType {
  if (
    value === 'admin_credit'
    || value === 'admin_debit'
    || value === 'compensation'
    || value === 'reversal'
  ) return value
  throw new AppWalletError(503, 'WALLET_DATA_INVALID', '金币分录数据暂不可用')
}

function requireStoredReasonCode(value: string): AppWalletReasonCode {
  if (
    value === 'manual_adjustment'
    || value === 'service_compensation'
    || value === 'correction'
    || value === 'reversal'
  ) return value
  throw new AppWalletError(503, 'WALLET_DATA_INVALID', '金币分录数据暂不可用')
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppWalletError(503, 'WALLET_DATA_INVALID', '金币分录数据暂不可用')
  }
  return value
}

function requireNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppWalletError(503, 'WALLET_DATA_INVALID', '金币账本版本暂不可用')
  }
  return value
}

function requireSafeBalance(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000) {
    throw new AppWalletError(503, 'WALLET_DATA_INVALID', '金币余额数据暂不可用')
  }
  return value
}

function requireStoredTime(value: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new AppWalletError(503, 'WALLET_DATA_INVALID', '金币分录时间暂不可用')
  }
  return value
}

function normalizeStoredTime(value: string | null): string | null {
  return value == null ? null : requireStoredTime(value)
}

function validateEntryId(value: string) {
  if (!ENTRY_ID.test(value)) throw walletEntryNotFound()
}

function walletEntryNotFound() {
  return new AppWalletError(404, 'WALLET_ENTRY_NOT_FOUND', '金币分录不存在或不属于当前账号')
}

function encodeCursor(value: NonNullable<AppWalletEntryListQuery['cursor']>) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeCursor(
  value: string,
  accountScope: string,
  direction: AppWalletDirection | null,
): NonNullable<AppWalletEntryListQuery['cursor']> {
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    if (
      parsed.v !== 1
      || parsed.accountScope !== accountScope
      || parsed.direction !== direction
      || typeof parsed.postedAt !== 'string'
      || Number.isNaN(Date.parse(parsed.postedAt))
      || typeof parsed.entryId !== 'string'
      || !ENTRY_ID.test(parsed.entryId)
    ) throw new Error('invalid cursor')
    return parsed as unknown as NonNullable<AppWalletEntryListQuery['cursor']>
  }
  catch {
    throw new AppWalletError(400, 'INVALID_CURSOR', '分页游标无效')
  }
}
