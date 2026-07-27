import type { InviteCodeFailureReason, InviteCodeStatusResponse } from '@meigallery/shared'
import { generateId } from '../utils/db'
import { sanitizeAnalyticsPath } from '../utils/analytics-url'

type InviteCodeDb = Pick<D1Database, 'prepare'>

export class InviteCodeError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'InviteCodeError'
  }
}

export interface CreateInviteCodeInput {
  name?: string
  channel?: string
  code?: string
  inviterUserId?: number | null
  maxUses?: number | null
  expiresAt?: string | null
  note?: string | null
  createdBy: number
}

export interface UpdateInviteCodeInput {
  name?: string
  channel?: string
  status?: 'active' | 'disabled' | 'expired'
  inviterUserId?: number | null
  maxUses?: number | null
  expiresAt?: string | null
  note?: string | null
}

export interface ConsumeInviteCodeInput {
  code?: string | null
  invitedUserId: number
  visitorId?: string | null
  sessionId?: string | null
  sourceChannel?: string | null
  landingPath?: string | null
  registeredAt?: string | null
}

interface InviteCodeRow {
  id: string
  display_code: string
  name: string
  channel: string
  inviter_user_id: number | null
  status: 'active' | 'disabled' | 'expired'
  max_uses: number | null
  used_count: number
  expires_at: string | null
  created_by: number
  created_at: string
  updated_at: string
  note: string
}

interface InviteCodeStatusRow {
  id: string
  name: string
  channel: string
  status: 'active' | 'disabled' | 'expired'
  max_uses: number | null
  used_count: number
  expires_at: string | null
}

export interface InviteCodeListItem {
  id: string
  displayCode: string
  name: string
  channel: string
  inviterUserId: number | null
  status: 'active' | 'disabled' | 'expired'
  maxUses: number | null
  usedCount: number
  expiresAt: string | null
  createdBy: number
  createdAt: string
  updatedAt: string
  note: string
}

export async function hashInviteCode(code: string): Promise<string> {
  const normalized = normalizeInviteCode(code)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createInviteCode(db: InviteCodeDb, input: CreateInviteCodeInput) {
  const name = normalizeRequiredText(input.name, '邀请码名称', 80)
  const channel = normalizeChannel(input.channel)
  const code = input.code ? normalizeInviteCode(input.code) : createInviteCodeValue()
  const codeHash = await hashInviteCode(code)
  const existing = await db.prepare('SELECT id FROM invite_codes WHERE code_hash = ?').bind(codeHash).first<{ id: string }>()
  if (existing) throw new InviteCodeError(409, '邀请码已存在')

  const maxUses = normalizeMaxUses(input.maxUses)
  const expiresAt = normalizeOptionalDate(input.expiresAt, '过期时间')
  const note = normalizeOptionalText(input.note, 500)
  const id = generateId('inv')
  const displayCode = displayInviteCode(code)
  await db.prepare(`
    INSERT INTO invite_codes (
      id, code_hash, display_code, name, channel, inviter_user_id,
      max_uses, expires_at, created_by, note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, codeHash, displayCode, name, channel, input.inviterUserId ?? null, maxUses, expiresAt, input.createdBy, note).run()

  return {
    id,
    code,
    displayCode,
    name,
    channel,
    inviterUserId: input.inviterUserId ?? null,
    status: 'active' as const,
    maxUses,
    usedCount: 0,
    expiresAt,
    note,
  }
}

export async function listInviteCodes(db: InviteCodeDb): Promise<InviteCodeListItem[]> {
  const rows = await db.prepare(`
    SELECT id, display_code, name, channel, inviter_user_id, status, max_uses,
           used_count, expires_at, created_by, created_at, updated_at, note
    FROM invite_codes
    ORDER BY created_at DESC
  `).all<InviteCodeRow>()
  return rows.results.map(serializeInviteCodeRow)
}

export async function updateInviteCode(db: InviteCodeDb, id: string, input: UpdateInviteCodeInput) {
  const before = await getInviteCodeById(db, id)
  const next = {
    name: input.name === undefined ? before.name : normalizeRequiredText(input.name, '邀请码名称', 80),
    channel: input.channel === undefined ? before.channel : normalizeChannel(input.channel),
    status: input.status ?? before.status,
    inviterUserId: input.inviterUserId === undefined ? before.inviterUserId : input.inviterUserId,
    maxUses: input.maxUses === undefined ? before.maxUses : normalizeMaxUses(input.maxUses),
    expiresAt: input.expiresAt === undefined ? before.expiresAt : normalizeOptionalDate(input.expiresAt, '过期时间'),
    note: input.note === undefined ? before.note : normalizeOptionalText(input.note, 500),
  }
  if (!['active', 'disabled', 'expired'].includes(next.status)) {
    throw new InviteCodeError(400, '邀请码状态无效')
  }

  await db.prepare(`
    UPDATE invite_codes
    SET name = ?, channel = ?, inviter_user_id = ?, status = ?, max_uses = ?,
        expires_at = ?, note = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(next.name, next.channel, next.inviterUserId ?? null, next.status, next.maxUses, next.expiresAt, next.note, id).run()

  return { before, after: { ...before, ...next } }
}

export async function disableInviteCode(db: InviteCodeDb, id: string) {
  return updateInviteCode(db, id, { status: 'disabled' })
}

export async function verifyInviteCodeStatus(db: InviteCodeDb, code: string, now = new Date()): Promise<InviteCodeStatusResponse> {
  const row = await db.prepare(`
    SELECT id, name, channel, status, max_uses, used_count, expires_at
    FROM invite_codes
    WHERE code_hash = ?
  `).bind(await hashInviteCode(code)).first<InviteCodeStatusRow>()

  const reason = inviteCodeFailureReason(row, now)
  if (!row || reason) return { valid: false, reason: reason ?? 'NOT_FOUND' }
  return {
    valid: true,
    inviteCodeId: row.id,
    name: row.name,
    channel: row.channel,
    expiresAt: row.expires_at,
  }
}

export async function consumeInviteCodeForRegistration(db: InviteCodeDb, input: ConsumeInviteCodeInput, now = new Date()) {
  if (!input.code) return { valid: false as const, reason: 'NOT_FOUND' as InviteCodeFailureReason }
  const codeHash = await hashInviteCode(input.code)
  const row = await db.prepare(`
    SELECT id, name, channel, status, max_uses, used_count, expires_at
    FROM invite_codes
    WHERE code_hash = ?
  `).bind(codeHash).first<InviteCodeStatusRow>()
  const reason = inviteCodeFailureReason(row, now)
  if (!row || reason) return { valid: false as const, reason: reason ?? 'NOT_FOUND' as InviteCodeFailureReason }

  const registeredAt = normalizeOptionalDate(input.registeredAt, '注册时间') || now.toISOString()
  const visitorId = normalizeAnalyticsId(input.visitorId, 'visitor') || generateId('av')
  const sessionId = normalizeAnalyticsId(input.sessionId, 'session') || generateId('as')
  const landingPath = sanitizeAnalyticsPath(input.landingPath || '/') || '/'
  const sourceChannel = normalizeSourceChannel(input.sourceChannel)

  await ensureAnalyticsVisitorAndSession(db, {
    visitorId,
    sessionId,
    invitedUserId: input.invitedUserId,
    registeredAt,
    inviteCodeId: row.id,
    channel: row.channel,
    landingPath,
    sourceChannel,
  })

  const registrationResult = await db.prepare(`
    INSERT OR IGNORE INTO invite_registrations (
      id, invite_code_id, visitor_id, session_id, invited_user_id,
      source_channel, landing_path, registered_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(generateId('ivr'), row.id, visitorId, sessionId, input.invitedUserId, sourceChannel, landingPath, registeredAt).run()

  const registered = (registrationResult.meta?.changes ?? 0) > 0
  if (registered) {
    await db.prepare('UPDATE invite_codes SET used_count = used_count + 1, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(row.id)
      .run()
  }

  return {
    valid: true as const,
    inviteCodeId: row.id,
    visitorId,
    sessionId,
    registeredAt,
    registered,
  }
}

export async function recordFirstMembershipGrantConversion(
  db: InviteCodeDb,
  input: { invitedUserId: number; rank: number; grantedAt?: string | null },
) {
  if (input.rank <= 0) return { updated: false }
  const grantedAt = normalizeOptionalDate(input.grantedAt, '会员发放时间') || new Date().toISOString()
  const result = await db.prepare(`
    UPDATE invite_registrations
    SET first_membership_granted_at = ?, first_membership_rank = ?, updated_at = datetime('now')
    WHERE invited_user_id = ? AND first_membership_granted_at IS NULL
  `).bind(grantedAt, input.rank, input.invitedUserId).run()
  return { updated: (result.meta?.changes ?? 0) > 0 }
}

export function safeInviteCodeAuditValue(value: unknown) {
  if (!value || typeof value !== 'object') return value
  const { code_hash: _codeHash, codeHash: _codeHashCamel, code: _code, ...safe } = value as Record<string, unknown>
  return safe
}

async function getInviteCodeById(db: InviteCodeDb, id: string): Promise<InviteCodeListItem> {
  const row = await db.prepare(`
    SELECT id, display_code, name, channel, inviter_user_id, status, max_uses,
           used_count, expires_at, created_by, created_at, updated_at, note
    FROM invite_codes
    WHERE id = ?
  `).bind(id).first<InviteCodeRow>()
  if (!row) throw new InviteCodeError(404, '邀请码不存在')
  return serializeInviteCodeRow(row)
}

function inviteCodeFailureReason(row: InviteCodeStatusRow | null, now: Date): InviteCodeFailureReason | null {
  if (!row) return 'NOT_FOUND'
  if (row.status === 'disabled') return 'DISABLED'
  if (row.status === 'expired' || isExpired(row.expires_at, now)) return 'EXPIRED'
  if (row.max_uses !== null && row.used_count >= row.max_uses) return 'USAGE_LIMIT_REACHED'
  return null
}

function serializeInviteCodeRow(row: InviteCodeRow): InviteCodeListItem {
  return {
    id: row.id,
    displayCode: row.display_code,
    name: row.name,
    channel: row.channel,
    inviterUserId: row.inviter_user_id,
    status: row.status,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    note: row.note,
  }
}

async function ensureAnalyticsVisitorAndSession(
  db: InviteCodeDb,
  input: {
    visitorId: string
    sessionId: string
    invitedUserId: number
    registeredAt: string
    inviteCodeId: string
    channel: string
    landingPath: string
    sourceChannel: string
  },
) {
  await db.prepare(`
    INSERT INTO analytics_visitors (
      id, first_seen_at, last_seen_at, first_source_channel, first_source_name,
      first_landing_path, first_invite_code_id, user_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      user_id = COALESCE(excluded.user_id, analytics_visitors.user_id),
      updated_at = datetime('now')
  `).bind(
    input.visitorId,
    input.registeredAt,
    input.registeredAt,
    input.sourceChannel,
    input.channel,
    input.landingPath,
    input.inviteCodeId,
    input.invitedUserId,
  ).run()

  await db.prepare(`
    INSERT INTO analytics_sessions (
      id, visitor_id, user_id, started_at, entry_path, source_channel,
      source_name, invite_code_id, device_type, country, event_count, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', '', 0, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, analytics_sessions.user_id),
      invite_code_id = COALESCE(excluded.invite_code_id, analytics_sessions.invite_code_id),
      updated_at = datetime('now')
  `).bind(
    input.sessionId,
    input.visitorId,
    input.invitedUserId,
    input.registeredAt,
    input.landingPath,
    input.sourceChannel,
    input.channel,
    input.inviteCodeId,
  ).run()
}

function normalizeInviteCode(code: string) {
  const normalized = code.trim().toUpperCase()
  if (!/^[A-Z0-9_-]{6,64}$/.test(normalized)) {
    throw new InviteCodeError(400, '邀请码格式无效')
  }
  return normalized
}

function createInviteCodeValue() {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  const body = Array.from(bytes, byte => byte.toString(36).toUpperCase().padStart(2, '0')).join('').replace(/[^A-Z0-9]/g, '').slice(0, 12)
  return `MGI-${body}`
}

function displayInviteCode(code: string) {
  return `${code.slice(0, 4)}...${code.slice(-4)}`
}

function normalizeRequiredText(value: string | undefined, label: string, maxLength: number) {
  const normalized = normalizeOptionalText(value, maxLength)
  if (!normalized) throw new InviteCodeError(400, `${label}为必填`)
  return normalized
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ')
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized
}

function normalizeChannel(value: string | undefined) {
  const channel = normalizeOptionalText(value || 'manual', 40).toLowerCase()
  if (!/^[a-z0-9_-]{2,40}$/.test(channel)) throw new InviteCodeError(400, '邀请码渠道格式无效')
  return channel
}

function normalizeMaxUses(value: number | null | undefined) {
  if (value === null || value === undefined || value === 0) return null
  if (!Number.isInteger(value) || value < 0) throw new InviteCodeError(400, '可用次数必须为正整数')
  return value
}

function normalizeOptionalDate(value: string | null | undefined, label: string) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new InviteCodeError(400, `${label}格式无效`)
  return parsed.toISOString()
}

function normalizeAnalyticsId(value: string | null | undefined, prefix: 'visitor' | 'session') {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(normalized)) return null
  return normalized.startsWith(prefix) ? normalized : normalized
}

function normalizeSourceChannel(value: string | null | undefined) {
  const channel = String(value ?? 'invite').trim().toLowerCase()
  return ['direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown'].includes(channel) ? channel : 'invite'
}

function isExpired(expiresAt: string | null, now: Date) {
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= now.getTime())
}
