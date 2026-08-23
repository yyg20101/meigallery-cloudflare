import type { AppConversationViewerSettings } from '@meigallery/shared'
import { AppMessagingError } from './app-messaging'

const CONVERSATION_ID_PATTERN = /^cv_[A-Za-z0-9_-]{1,77}$/u

export interface UpdateAppConversationSettingsInput {
  expectedVersion?: unknown
  muted?: unknown
}

type ConversationSettingsRow = {
  conversation_id: string
  status: string
  closed_at: string | null
  muted: number | null
  version: number | null
  updated_at: string | null
}

export async function getAppConversationSettings(
  db: D1Database,
  accountId: number,
  conversationIdValue: string,
): Promise<AppConversationViewerSettings> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const row = await readSettings(db, accountId, conversationId)
  if (!row) {
    throw new AppMessagingError(404, 'CONVERSATION_NOT_FOUND', '平台话题不存在或不可访问')
  }
  return toSettings(row)
}

export async function updateAppConversationSettings(
  db: D1Database,
  accountId: number,
  conversationIdValue: string,
  input: UpdateAppConversationSettingsInput,
  now = new Date(),
): Promise<AppConversationViewerSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppMessagingError(400, 'CONVERSATION_SETTINGS_INVALID', '会话设置格式无效')
  }
  const conversationId = normalizeConversationId(conversationIdValue)
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  if (typeof input.muted !== 'boolean') {
    throw new AppMessagingError(400, 'CONVERSATION_SETTINGS_INVALID', '免打扰状态无效')
  }
  const current = await readSettings(db, accountId, conversationId)
  if (!current) {
    throw new AppMessagingError(404, 'CONVERSATION_NOT_FOUND', '平台话题不存在或不可访问')
  }
  if (current.status === 'closed') {
    throw new AppMessagingError(409, 'CONVERSATION_SETTINGS_LOCKED', '话题已关闭，免打扰状态不可修改')
  }
  const currentVersion = Number(current.version ?? 0)
  if (currentVersion !== expectedVersion) {
    throw new AppMessagingError(409, 'CONVERSATION_SETTINGS_VERSION_CONFLICT', '会话设置已更新，请刷新后重试')
  }
  const muted = input.muted
  if ((current.muted === 1) === muted && current.version !== null) return toSettings(current)

  const nowIso = now.toISOString()
  if (currentVersion === 0) {
    try {
      await db.prepare(`
        INSERT INTO app_conversation_viewer_settings (
          conversation_id, account_id, muted, version, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
      `).bind(conversationId, accountId, muted ? 1 : 0, nowIso, nowIso).run()
    }
    catch {
      throw new AppMessagingError(409, 'CONVERSATION_SETTINGS_VERSION_CONFLICT', '会话设置已更新，请刷新后重试')
    }
  }
  else {
    const result = await db.prepare(`
      UPDATE app_conversation_viewer_settings
      SET muted = ?, version = version + 1, updated_at = ?
      WHERE conversation_id = ? AND account_id = ? AND version = ?
    `).bind(muted ? 1 : 0, nowIso, conversationId, accountId, expectedVersion).run()
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new AppMessagingError(409, 'CONVERSATION_SETTINGS_VERSION_CONFLICT', '会话设置已更新，请刷新后重试')
    }
  }

  const updated = await readSettings(db, accountId, conversationId)
  if (!updated || Number(updated.version ?? 0) !== currentVersion + 1) {
    throw new AppMessagingError(503, 'CONVERSATION_SETTINGS_UNAVAILABLE', '会话设置暂时无法确认', true)
  }
  return toSettings(updated)
}

export async function isAppConversationMuted(
  db: D1Database,
  accountId: number,
  conversationId: string,
): Promise<boolean> {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return false
  const row = await db.prepare(`
    SELECT muted
    FROM app_conversation_viewer_settings
    WHERE conversation_id = ? AND account_id = ?
    LIMIT 1
  `).bind(conversationId, accountId).first<{ muted: number }>()
  return row?.muted === 1
}

function readSettings(db: D1Database, accountId: number, conversationId: string) {
  return db.prepare(`
    SELECT conversation.id AS conversation_id, conversation.status, conversation.closed_at,
           settings.muted, settings.version, settings.updated_at
    FROM app_conversations conversation
    LEFT JOIN app_conversation_viewer_settings settings
      ON settings.conversation_id = conversation.id
     AND settings.account_id = conversation.account_id
    WHERE conversation.id = ? AND conversation.account_id = ?
    LIMIT 1
  `).bind(conversationId, accountId).first<ConversationSettingsRow>()
}

function toSettings(row: ConversationSettingsRow): AppConversationViewerSettings {
  const closed = row.status === 'closed'
  return {
    conversationId: row.conversation_id,
    muted: row.muted === 1,
    editable: !closed,
    lockedReason: closed ? 'CONVERSATION_CLOSED' : null,
    closedAt: row.closed_at,
    version: Number(row.version ?? 0),
    updatedAt: row.updated_at,
  }
}

function normalizeConversationId(value: string): string {
  if (!CONVERSATION_ID_PATTERN.test(value)) {
    throw new AppMessagingError(400, 'CONVERSATION_SETTINGS_INVALID', '平台话题标识无效')
  }
  return value
}

function normalizeExpectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new AppMessagingError(400, 'EXPECTED_VERSION_INVALID', '会话设置版本无效')
  }
  return Number(value)
}
