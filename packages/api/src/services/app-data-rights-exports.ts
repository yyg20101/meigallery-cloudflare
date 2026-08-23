import type {
  AppDataRightsDownloadTicketResult,
  AppDataRightsExportArtifactStatus,
} from '@meigallery/shared'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import type { AppSessionPrincipal } from './app-account-access'
import {
  AppDataRightsError,
  type AppDataRightsRequestRow,
} from './app-data-rights'
import {
  isRecommendationEvidenceSigningSecretReady,
  recommendationAccountHash,
} from './app-recommendation-evidence'

export const APP_DATA_RIGHTS_EXPORT_QUEUE_NAME = 'meigallery-app-data-rights-export'
export const APP_DATA_RIGHTS_DOWNLOAD_HEADER = 'X-Data-Rights-Download-Ticket' as const

const EXPORT_MESSAGE_KIND = 'app_data_rights_export'
const DOWNLOAD_TOKEN = /^drdl_[A-Za-z0-9_-]{43}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const REQUEST_ID = /^drr_[A-Za-z0-9_-]{1,92}$/u
const MAX_QUEUE_ATTEMPTS = 5
const LEASE_TTL_MS = 2 * 60_000
const RECOVERY_LIMIT = 100
const MAX_EXPORT_CATEGORY_COUNT = 100

export type AppDataRightsExportQueueMessage = {
  schemaVersion: 1
  kind: typeof EXPORT_MESSAGE_KIND
  artifactId: string
}

type ExportEnvironment = Pick<
  Bindings,
  'DB' | 'R2' | 'SESSION_SECRET' | 'DATA_RIGHTS_EXPORT_QUEUE'
>

type ExportProfileRow = {
  id: string
  policy_id: string
  version_code: string
  state: 'development' | 'published' | 'retired'
  production_ready: number
  schema_version: number
  artifact_ttl_hours: number
  download_ticket_ttl_seconds: number
  page_size: number
  max_part_bytes: number
  max_parts: number
  max_artifact_bytes: number
}

type ExportArtifactRow = {
  id: string
  request_id: string
  request_version: number
  account_id: number
  profile_id: string
  profile_version_snapshot: string
  export_schema_version: number
  status: 'queued' | 'collecting' | 'finalizing' | 'ready' | 'failed' | 'expired' | 'superseded' | 'purging' | 'purged'
  version: number
  generation_token: string
  snapshot_at: string
  part_count: number
  record_count: number
  payload_bytes: number
  aggregate_sha256: string | null
  readme_r2_key: string | null
  readme_r2_etag: string | null
  readme_sha256: string | null
  readme_size: number | null
  manifest_r2_key: string | null
  manifest_r2_etag: string | null
  manifest_sha256: string | null
  manifest_size: number | null
  archive_r2_key: string | null
  archive_r2_etag: string | null
  archive_size: number | null
  generated_at: string | null
  expires_at: string | null
  request_status: string
  current_request_version: number
  request_mutation_token: string
  policy_export_processing_enabled: number
  policy_production_ready: number
  profile_state: string
  profile_production_ready: number
  artifact_ttl_hours: number
  download_ticket_ttl_seconds: number
  page_size: number
  max_part_bytes: number
  max_parts: number
  max_artifact_bytes: number
  category_count: number
}

type ExportJobRow = {
  artifact_id: string
  status: 'pending' | 'processing' | 'finalizing' | 'completed' | 'failed'
  version: number
  category_ordinal: number
  next_part_ordinal: number
  lease_token: string | null
  lease_expires_at: string | null
  attempt_count: number
}

type ExportScopeRow = {
  artifact_id: string
  category_ordinal: number
  category_code: string
  status: 'pending' | 'collecting' | 'completed'
  max_rowid_snapshot: number
  cursor_rowid: number
  record_count: number
  part_count: number
}

type ExportPartRow = {
  id: string
  artifact_id: string
  ordinal: number
  category_code: string
  file_name: string
  r2_key: string
  r2_etag: string
  file_sha256: string
  file_size: number
  record_count: number
  first_rowid: number
  last_rowid: number
}

type ExportRow = {
  export_rowid: number
  export_json: string
}

type DownloadTicketRow = {
  id: string
  request_id: string
  request_version: number
  artifact_id: string
  artifact_version: number
  account_id: number
  manifest_sha256_snapshot: string
  aggregate_sha256_snapshot: string
  archive_r2_etag_snapshot: string
  archive_size_snapshot: number
  expires_at: string
  consumed_at: string | null
  request_status: string
  artifact_status: string
  archive_r2_key: string | null
  artifact_expires_at: string | null
  profile_ticket_ttl_seconds: number
}

type ExportCategoryDefinition = {
  code: string
  label: string
  fromSql: string
  accountPredicate: string
  jsonSql: string
  accountSelector?: 'recommendation_hash'
}

class FatalExportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const EXPORT_CATEGORIES: readonly ExportCategoryDefinition[] = [
  {
    code: 'account',
    label: '账号资料',
    fromSql: 'users source JOIN app_account_security security ON security.account_id = source.id',
    accountPredicate: 'source.id = ?',
    jsonSql: `json_object(
      'accountId', security.account_public_id,
      'email', source.email,
      'username', source.username,
      'nickname', source.nickname,
      'avatarKey', source.avatar_key,
      'status', source.status,
      'securityStatus', security.status,
      'restrictedUntil', security.restricted_until,
      'emailVerified', source.email_verified,
      'notificationEnabled', source.notification_enabled,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'identity_methods',
    label: '身份验证方式摘要',
    fromSql: 'app_account_identities source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'identityId', source.id,
      'provider', source.provider,
      'status', source.status,
      'verifiedAt', source.verified_at,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'consents',
    label: '同意与确认记录',
    fromSql: 'app_account_consents source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'consentId', source.id,
      'documentType', source.document_type,
      'documentVersion', source.document_version,
      'decision', source.decision,
      'source', source.source,
      'acceptedAt', source.accepted_at,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'devices',
    label: '设备摘要',
    fromSql: 'app_devices source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'deviceId', source.id,
      'platform', source.platform,
      'displayName', source.display_name,
      'appVersion', source.app_version,
      'status', source.status,
      'firstSeenAt', source.first_seen_at,
      'lastSeenAt', source.last_seen_at,
      'revokedAt', source.revoked_at
    )`,
  },
  {
    code: 'realtime_connection_tickets',
    label: '实时连接票据摘要',
    fromSql: 'app_realtime_tickets source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'policyVersion', source.policy_id,
      'deviceId', source.device_id,
      'issuedAt', source.issued_at,
      'expiresAt', source.expires_at,
      'consumedAt', source.consumed_at,
      'cancelledAt', source.cancelled_at,
      'cancellationReason', source.cancellation_reason
    )`,
  },
  {
    code: 'account_preferences',
    label: '账号外观设置',
    fromSql: 'app_account_profile_preferences source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'avatarStyle', source.avatar_style,
      'version', source.version,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'notification_preferences',
    label: '站内通知设置',
    fromSql: 'app_notification_preferences source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'messageEnabled', source.message_enabled,
      'interactionEnabled', source.interaction_enabled,
      'marketingEnabled', source.marketing_enabled,
      'version', source.version,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'view_history_preferences',
    label: '浏览记录设置',
    fromSql: 'app_view_history_preferences source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'recordingEnabled', source.recording_enabled,
      'version', source.version,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'search_history_preferences',
    label: '搜索记录设置',
    fromSql: 'app_search_history_preferences source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'recordingEnabled', source.recording_enabled,
      'version', source.version,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'conversation_settings',
    label: '会话设置',
    fromSql: 'app_conversation_viewer_settings source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'conversationId', source.conversation_id,
      'muted', source.muted,
      'version', source.version,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'interactions',
    label: '喜欢与关注',
    fromSql: 'app_viewer_interactions source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'profileId', source.profile_id,
      'interactionType', source.interaction_type,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'favorite_folders',
    label: '收藏夹',
    fromSql: 'app_favorite_folders source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'folderId', source.id,
      'folderType', source.folder_type,
      'name', source.name,
      'sortOrder', source.sort_order,
      'version', source.version,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'favorite_items',
    label: '收藏内容',
    fromSql: 'app_favorite_folder_items source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'folderId', source.folder_id,
      'profileId', source.profile_id,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'view_history',
    label: '人物浏览记录',
    fromSql: 'app_profile_view_history source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'profileId', source.profile_id,
      'firstViewedAt', source.first_viewed_at,
      'lastViewedAt', source.last_viewed_at,
      'viewCount', source.view_count,
      'expiresAt', source.expires_at
    )`,
  },
  {
    code: 'search_history',
    label: '搜索记录',
    fromSql: 'app_person_search_history source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'historyId', source.history_id,
      'queryText', source.query_text,
      'firstSearchedAt', source.first_searched_at,
      'lastSearchedAt', source.last_searched_at,
      'searchCount', source.search_count,
      'expiresAt', source.expires_at
    )`,
  },
  {
    code: 'saved_filters',
    label: '保存的筛选条件',
    fromSql: 'app_saved_person_filters source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'filterId', source.filter_id,
      'name', source.name,
      'catalogId', source.catalog_id,
      'termIds', json(source.term_ids_json),
      'defaultSort', source.default_sort,
      'version', source.version,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at,
      'deletedAt', source.deleted_at
    )`,
  },
  {
    code: 'membership_grants',
    label: '会员权益记录',
    fromSql: 'app_membership_grants source',
    accountPredicate: 'source.user_id = ?',
    jsonSql: `json_object(
      'grantId', source.id,
      'catalogVersionId', source.catalog_version_id,
      'tierId', source.tier_id,
      'tierCode', source.tier_code_snapshot,
      'tierName', source.tier_name_snapshot,
      'rank', source.rank_snapshot,
      'startsAt', source.starts_at,
      'expiresAt', source.expires_at,
      'sourceType', source.source_type,
      'reasonCode', source.reason_code,
      'userVisibleNote', source.user_visible_note,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'membership_revocations',
    label: '会员撤销记录',
    fromSql: 'app_membership_grant_revocations source JOIN app_membership_grants owner ON owner.id = source.grant_id',
    accountPredicate: 'owner.user_id = ?',
    jsonSql: `json_object(
      'grantId', source.grant_id,
      'reasonCode', source.reason_code,
      'userVisibleNote', source.user_visible_note,
      'revokedAt', source.revoked_at
    )`,
  },
  {
    code: 'membership_applications',
    label: '会员申请',
    fromSql: 'app_membership_applications source',
    accountPredicate: 'source.user_id = ?',
    jsonSql: `json_object(
      'applicationId', source.id,
      'catalogVersionId', source.catalog_version_id,
      'tierId', source.tier_id,
      'tierCode', source.tier_code_snapshot,
      'tierName', source.tier_name_snapshot,
      'rank', source.rank_snapshot,
      'preferredContactWindow', source.preferred_contact_window,
      'statement', source.statement,
      'disclosureVersion', source.disclosure_version,
      'disclosureConfirmedAt', source.disclosure_confirmed_at,
      'status', source.status,
      'informationRequestCode', source.information_request_code,
      'informationRequestMessage', source.information_request_message,
      'decisionReasonCode', source.decision_reason_code,
      'decisionMessage', source.decision_message,
      'submittedAt', source.submitted_at,
      'updatedAt', source.updated_at,
      'resolvedAt', source.resolved_at
    )`,
  },
  {
    code: 'wallet',
    label: '金币钱包摘要',
    fromSql: 'app_wallets source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'walletId', source.id,
      'currencyCode', source.currency_code,
      'balance', source.balance,
      'sequence', source.sequence,
      'status', source.status,
      'lastEntryAt', source.last_entry_at,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'wallet_entries',
    label: '金币明细',
    fromSql: 'app_wallet_entries source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'entryId', source.id,
      'sequence', source.sequence,
      'actionType', source.action_type,
      'direction', source.direction,
      'amount', source.amount,
      'reasonCode', source.reason_code,
      'userVisibleNote', source.user_visible_note,
      'publicReference', source.public_reference,
      'originalEntryId', source.original_entry_id,
      'balanceBefore', source.balance_before,
      'balanceAfter', source.balance_after,
      'status', source.status,
      'postedAt', source.posted_at,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'conversations',
    label: '平台会话',
    fromSql: 'app_conversations source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'conversationId', source.id,
      'profileId', source.profile_id,
      'operationMode', source.operation_mode,
      'receiverLabel', source.receiver_label,
      'disclosureVersion', source.disclosure_version,
      'status', source.status,
      'queueStatus', source.queue_status,
      'lastSequence', source.last_sequence,
      'viewerReadSequence', source.viewer_read_sequence,
      'lastMessageAt', source.last_message_at,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at,
      'closedAt', source.closed_at
    )`,
  },
  {
    code: 'conversation_messages',
    label: '本人平台会话消息',
    fromSql: 'app_conversation_messages source JOIN app_conversations owner ON owner.id = source.conversation_id',
    accountPredicate: "owner.account_id = ? AND (source.sender_type = 'viewer' OR source.status IN ('accepted', 'recalled'))",
    jsonSql: `json_object(
      'messageId', source.id,
      'conversationId', source.conversation_id,
      'sequence', source.sequence,
      'senderType', source.sender_type,
      'contentType', source.content_type,
      'bodyText', source.body_text,
      'status', source.status,
      'createdAt', source.created_at,
      'recalledAt', source.recalled_at
    )`,
  },
  {
    code: 'notifications',
    label: '站内通知',
    fromSql: 'app_notifications source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'notificationId', source.id,
      'category', source.category,
      'eventType', source.event_type,
      'title', source.title_text,
      'summary', source.summary_text,
      'body', source.body_text,
      'targetType', source.target_type,
      'targetId', source.target_id,
      'action', source.action,
      'status', source.status,
      'createdAt', source.created_at,
      'expiresAt', source.expires_at,
      'readAt', source.read_at,
      'withdrawnAt', source.withdrawn_at
    )`,
  },
  {
    code: 'safety_reports',
    label: '本人举报',
    fromSql: 'app_safety_reports source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'reportId', source.id,
      'targetType', source.target_type,
      'profileId', source.profile_id,
      'mediaId', source.media_id,
      'conversationId', source.conversation_id,
      'messageId', source.message_id,
      'reasonCode', source.reason_code,
      'description', source.description_text,
      'userVisibleStatus', source.user_visible_status,
      'userVisibleMessage', source.user_visible_message,
      'submittedAt', source.submitted_at,
      'updatedAt', source.updated_at,
      'resolvedAt', source.resolved_at
    )`,
  },
  {
    code: 'safety_report_events',
    label: '举报用户可见时间线',
    fromSql: 'app_safety_report_events source JOIN app_safety_reports owner ON owner.id = source.report_id',
    accountPredicate: 'owner.account_id = ?',
    jsonSql: `json_object(
      'eventId', source.id,
      'reportId', source.report_id,
      'sequence', source.sequence,
      'userVisibleStatus', source.user_visible_status,
      'userVisibleMessage', source.user_visible_message,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'report_appeals',
    label: '举报申诉',
    fromSql: 'app_safety_appeals source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'appealId', source.id,
      'reportId', source.report_id,
      'appealType', source.appeal_type,
      'statement', source.statement_text,
      'reviewState', source.review_state,
      'userVisibleStatus', source.user_visible_status,
      'userVisibleMessage', source.user_visible_message,
      'submittedAt', source.submitted_at,
      'updatedAt', source.updated_at,
      'reviewDueAt', source.review_due_at,
      'supplementDueAt', source.supplement_due_at,
      'resolvedAt', source.resolved_at
    )`,
  },
  {
    code: 'report_appeal_events',
    label: '举报申诉用户可见时间线',
    fromSql: 'app_safety_appeal_events source JOIN app_safety_appeals owner ON owner.id = source.appeal_id',
    accountPredicate: 'owner.account_id = ?',
    jsonSql: `json_object(
      'eventId', source.id,
      'appealId', source.appeal_id,
      'sequence', source.sequence,
      'userVisibleStatus', source.user_visible_status,
      'userVisibleMessage', source.user_visible_message,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'report_appeal_review_events',
    label: '举报申诉补充与升级时间线',
    fromSql: "app_appeal_review_events source JOIN app_safety_appeals owner ON source.appeal_kind = 'report' AND owner.id = source.appeal_id",
    accountPredicate: 'owner.account_id = ?',
    jsonSql: `json_object(
      'eventId', source.id,
      'appealId', source.appeal_id,
      'userVisibleStatus', 'processing',
      'userVisibleMessage', source.user_visible_message,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'report_appeal_supplements',
    label: '举报申诉本人补充',
    fromSql: 'app_safety_appeal_supplements source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'supplementId', source.id,
      'appealId', source.appeal_id,
      'sequence', source.sequence,
      'note', source.note_text,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'service_appeals',
    label: '账号与金币申诉',
    fromSql: 'app_service_appeals source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'appealId', source.id,
      'sourceType', source.source_type,
      'sourceId', source.source_id,
      'sourceVersion', source.source_version,
      'sourceReference', source.source_reference,
      'sourceLabel', source.source_label,
      'statement', source.statement_text,
      'reviewState', source.review_state,
      'userVisibleStatus', source.user_visible_status,
      'userVisibleMessage', source.user_visible_message,
      'submittedAt', source.submitted_at,
      'updatedAt', source.updated_at,
      'reviewDueAt', source.review_due_at,
      'supplementDueAt', source.supplement_due_at,
      'resolvedAt', source.resolved_at
    )`,
  },
  {
    code: 'service_appeal_events',
    label: '账号与金币申诉用户可见时间线',
    fromSql: 'app_service_appeal_events source JOIN app_service_appeals owner ON owner.id = source.appeal_id',
    accountPredicate: 'owner.account_id = ?',
    jsonSql: `json_object(
      'eventId', source.id,
      'appealId', source.appeal_id,
      'sequence', source.sequence,
      'userVisibleStatus', source.user_visible_status,
      'userVisibleMessage', source.user_visible_message,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'service_appeal_supplements',
    label: '账号与金币申诉本人补充',
    fromSql: 'app_service_appeal_supplements source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'supplementId', source.id,
      'appealId', source.appeal_id,
      'sequence', source.sequence,
      'note', source.note_text,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'data_rights_requests',
    label: '数据权利申请',
    fromSql: 'app_data_rights_requests source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'requestId', source.id,
      'requestType', source.request_type,
      'policyVersion', source.policy_version_snapshot,
      'status', source.status,
      'statusMessageCode', source.status_message_code,
      'version', source.version,
      'deadlineAt', source.deadline_at,
      'scheduledFor', source.scheduled_for,
      'processingStartedAt', source.processing_started_at,
      'completedAt', source.completed_at,
      'cancelledAt', source.cancelled_at,
      'failureCode', source.failure_code,
      'requestedAt', source.requested_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'data_rights_events',
    label: '数据权利用户可见时间线',
    fromSql: 'app_data_rights_request_events source JOIN app_data_rights_requests owner ON owner.id = source.request_id',
    accountPredicate: "owner.account_id = ? AND source.visibility = 'user'",
    jsonSql: `json_object(
      'eventId', source.id,
      'requestId', source.request_id,
      'sequence', source.sequence,
      'requestVersion', source.request_version,
      'status', source.status_snapshot,
      'eventType', source.event_type,
      'message', source.user_message,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'recommendation_preferences',
    label: '推荐偏好',
    fromSql: 'app_recommendation_preferences source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'personalizationEnabled', source.personalization_enabled,
      'taxonomyCatalogId', source.taxonomy_catalog_id,
      'preferredTermIds', json(source.preferred_term_ids_json),
      'version', source.version,
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'profile_blocks',
    label: '人物拉黑状态',
    fromSql: 'app_profile_blocks source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'profileId', source.profile_id,
      'state', source.state,
      'version', source.version,
      'blockedAt', source.blocked_at,
      'unblockedAt', source.unblocked_at,
      'updatedAt', source.updated_at
    )`,
  },
  {
    code: 'profile_block_events',
    label: '人物拉黑时间线',
    fromSql: 'app_profile_block_events source',
    accountPredicate: 'source.account_id = ?',
    jsonSql: `json_object(
      'eventId', source.id,
      'profileId', source.profile_id,
      'version', source.version,
      'eventType', source.event_type,
      'occurredAt', source.occurred_at
    )`,
  },
  {
    code: 'legacy_gallery_likes',
    label: '旧版图库点赞',
    fromSql: 'gallery_likes source',
    accountPredicate: 'source.user_id = ?',
    jsonSql: `json_object(
      'likeId', source.id,
      'galleryId', source.gallery_id,
      'createdAt', source.created_at
    )`,
  },
  {
    code: 'recommendation_sessions',
    label: '推荐解释会话',
    fromSql: 'app_recommendation_sessions source',
    accountPredicate: 'source.account_hash = ?',
    accountSelector: 'recommendation_hash',
    jsonSql: `json_object(
      'sessionId', source.session_id,
      'mode', source.mode,
      'ruleVersionId', source.rule_version_id,
      'heatVersionId', source.heat_version_id,
      'createdAt', source.created_at,
      'expiresAt', source.expires_at
    )`,
  },
  {
    code: 'recommendation_session_items',
    label: '推荐解释条目',
    fromSql: 'app_recommendation_session_items source JOIN app_recommendation_sessions owner ON owner.session_id = source.session_id',
    accountPredicate: 'owner.account_hash = ?',
    accountSelector: 'recommendation_hash',
    jsonSql: `json_object(
      'sessionId', source.session_id,
      'rank', source.rank,
      'profileId', source.profile_id,
      'reasonCode', source.reason_code,
      'source', source.source,
      'placementId', source.placement_id
    )`,
  },
] as const

export function getAppDataRightsExportCategoryContract() {
  return EXPORT_CATEGORIES.map(category => ({
    code: category.code,
    accountSelector: category.accountSelector ?? 'account_id',
  }))
}

export async function prepareAppDataRightsExportStart(
  env: Pick<Bindings, 'DB' | 'SESSION_SECRET'>,
  request: AppDataRightsRequestRow,
  nextRequestVersion: number,
  nextMutationToken: string,
  timestamp: string,
): Promise<{ artifactId: string; statements: D1PreparedStatement[] }> {
  if (request.request_type !== 'export') {
    throw new AppDataRightsError(409, 'EXPORT_REQUEST_REQUIRED', '只有导出申请可以创建导出制品')
  }
  const db = env.DB
  const profile = await requireReadyExportProfile(db, request.policy_id)
  const recommendationHash = await requireRecommendationAccountHash(
    env.SESSION_SECRET,
    request.account_public_id,
  )
  const artifactId = generateId('drea')
  const generationToken = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_data_rights_export_artifacts (
        id, request_id, request_version, account_id, profile_id, profile_version_snapshot,
        export_schema_version, status, version, generation_token, snapshot_at,
        created_at, updated_at
      )
      SELECT ?, request.id, request.version, request.account_id, ?, ?, ?,
             'queued', 1, ?, ?, ?, ?
      FROM app_data_rights_requests request
      WHERE request.id = ? AND request.request_type = 'export'
        AND request.status = 'collecting' AND request.version = ? AND request.mutation_token = ?
    `).bind(
      artifactId,
      profile.id,
      profile.version_code,
      profile.schema_version,
      generationToken,
      timestamp,
      timestamp,
      timestamp,
      request.id,
      nextRequestVersion,
      nextMutationToken,
    ),
  ]
  EXPORT_CATEGORIES.forEach((category, categoryOrdinal) => {
    statements.push(db.prepare(`
      INSERT INTO app_data_rights_export_scopes (
        artifact_id, category_ordinal, category_code, status,
        max_rowid_snapshot, cursor_rowid, record_count, part_count,
        completed_at, created_at, updated_at
      )
      SELECT ?, ?, ?, 'pending',
             COALESCE((
               SELECT MAX(source.rowid)
               FROM ${category.fromSql}
               WHERE ${category.accountPredicate}
             ), 0),
             0, 0, 0, NULL, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM app_data_rights_export_artifacts artifact
        JOIN app_data_rights_requests request ON request.id = artifact.request_id
        WHERE artifact.id = ? AND artifact.request_version = ?
          AND request.status = 'collecting' AND request.version = ?
          AND request.mutation_token = ?
      )
    `).bind(
      artifactId,
      categoryOrdinal,
      category.code,
      category.accountSelector === 'recommendation_hash'
        ? recommendationHash
        : request.account_id,
      timestamp,
      timestamp,
      artifactId,
      nextRequestVersion,
      nextRequestVersion,
      nextMutationToken,
    ))
  })
  statements.push(db.prepare(`
    INSERT INTO app_data_rights_export_jobs (
      artifact_id, status, version, category_ordinal, next_part_ordinal,
      lease_token, lease_expires_at, attempt_count, last_error_code,
      created_at, updated_at
    )
    SELECT id, 'pending', 1, 0, 1, NULL, NULL, 0, NULL, ?, ?
    FROM app_data_rights_export_artifacts
    WHERE id = ? AND request_version = ? AND status = 'queued'
  `).bind(timestamp, timestamp, artifactId, nextRequestVersion))
  return { artifactId, statements }
}

export async function dispatchAppDataRightsExport(
  env: Pick<Bindings, 'DB' | 'DATA_RIGHTS_EXPORT_QUEUE'>,
  requestIdValue: string,
): Promise<{ artifactId: string }> {
  const requestId = requireRequestId(requestIdValue)
  const artifact = await env.DB.prepare(`
    SELECT artifact.id
    FROM app_data_rights_export_artifacts artifact
    JOIN app_data_rights_export_jobs job ON job.artifact_id = artifact.id
    JOIN app_data_rights_requests request ON request.id = artifact.request_id
    WHERE artifact.request_id = ?
      AND artifact.status IN ('queued', 'collecting', 'finalizing')
      AND job.status IN ('pending', 'processing', 'finalizing')
      AND request.status = 'collecting'
    ORDER BY artifact.request_version DESC, artifact.id DESC
    LIMIT 1
  `).bind(requestId).first<{ id: string }>()
  if (!artifact) {
    throw new AppDataRightsError(409, 'EXPORT_JOB_NOT_FOUND', '导出任务尚未创建或申请状态已变化')
  }
  if (!env.DATA_RIGHTS_EXPORT_QUEUE) {
    throw new AppDataRightsError(503, 'EXPORT_QUEUE_UNAVAILABLE', '导出队列尚未配置，任务已安全保留', true)
  }
  try {
    await env.DATA_RIGHTS_EXPORT_QUEUE.send(queueMessage(artifact.id))
  }
  catch {
    throw new AppDataRightsError(503, 'EXPORT_QUEUE_SEND_FAILED', '导出任务暂未进入队列，请使用原幂等请求重试', true)
  }
  return { artifactId: artifact.id }
}

async function requireReadyExportProfile(
  db: D1Database,
  policyId: string,
): Promise<ExportProfileRow> {
  const row = await db.prepare(`
    SELECT profile.id, profile.policy_id, profile.version_code, profile.state,
           profile.production_ready, profile.schema_version, profile.artifact_ttl_hours,
           profile.download_ticket_ttl_seconds, profile.page_size, profile.max_part_bytes,
           profile.max_parts, profile.max_artifact_bytes
    FROM app_data_rights_export_profiles profile
    JOIN app_data_rights_policies policy ON policy.id = profile.policy_id
    WHERE profile.policy_id = ? AND profile.state = 'published' AND profile.production_ready = 1
      AND policy.state = 'published' AND policy.production_ready = 1
      AND policy.export_requests_enabled = 1 AND policy.export_processing_enabled = 1
    LIMIT 1
  `).bind(policyId).first<ExportProfileRow>()
  if (!row) {
    throw new AppDataRightsError(
      503,
      'EXPORT_PROFILE_NOT_READY',
      '私有导出制品策略尚未通过生产门禁',
      true,
    )
  }
  return row
}

async function requireRecommendationAccountHash(
  signingSecret: string,
  accountPublicId: string,
) {
  if (!isRecommendationEvidenceSigningSecretReady(signingSecret)) {
    throw new AppDataRightsError(
      503,
      'EXPORT_RECOMMENDATION_EVIDENCE_SECRET_NOT_READY',
      '推荐证据账号定位密钥尚未满足导出门禁',
      true,
    )
  }
  try {
    return await recommendationAccountHash(signingSecret, accountPublicId)
  }
  catch {
    throw new AppDataRightsError(
      503,
      'EXPORT_RECOMMENDATION_EVIDENCE_ACCOUNT_INVALID',
      '推荐证据账号定位信息无效',
      false,
    )
  }
}

type QueueMessageLike = {
  body: unknown
  attempts: number
  ack?: () => void
  retry?: (options?: { delaySeconds?: number }) => void
}

export async function handleAppDataRightsExportQueueBatch(
  batch: MessageBatch<AppDataRightsExportQueueMessage>,
  env: ExportEnvironment,
): Promise<void> {
  for (const rawMessage of batch.messages as unknown as QueueMessageLike[]) {
    const message = parseQueueMessage(rawMessage.body)
    if (!message) {
      safeAck(rawMessage)
      continue
    }
    try {
      const outcome = await processNextExportStep(env, message)
      if (outcome === 'retry' && rawMessage.attempts < MAX_QUEUE_ATTEMPTS) {
        safeRetry(rawMessage)
      }
      else {
        safeAck(rawMessage)
      }
    }
    catch (error) {
      if (error instanceof FatalExportError || rawMessage.attempts >= MAX_QUEUE_ATTEMPTS) {
        await failExportJob(
          env,
          message.artifactId,
          error instanceof FatalExportError ? error.code : 'queue_attempts_exhausted',
          new Date(),
        )
        safeAck(rawMessage)
      }
      else {
        safeRetry(rawMessage)
      }
    }
  }
}

async function processNextExportStep(
  env: ExportEnvironment,
  message: AppDataRightsExportQueueMessage,
): Promise<'ack' | 'retry'> {
  const initial = await loadArtifactState(env.DB, message.artifactId)
  if (!initial) return 'ack'
  if (initial.artifact.request_status !== 'collecting') {
    await abandonExportArtifact(env, initial.artifact, new Date())
    return 'ack'
  }
  if (
    initial.artifact.policy_export_processing_enabled !== 1
    || initial.artifact.policy_production_ready !== 1
    || initial.artifact.profile_state !== 'published'
    || initial.artifact.profile_production_ready !== 1
  ) {
    await failExportJob(env, initial.artifact.id, 'export_authorization_changed', new Date())
    return 'ack'
  }
  if (!['queued', 'collecting', 'finalizing'].includes(initial.artifact.status)) return 'ack'
  if (['completed', 'failed'].includes(initial.job.status)) return 'ack'

  const claimed = await claimExportJob(env.DB, initial, new Date())
  if (!claimed) return 'ack'
  try {
    if (claimed.job.category_ordinal >= requireArtifactCategoryCount(claimed.artifact.category_count)) {
      await finalizeExportArtifact(env, claimed, new Date())
      return 'ack'
    }
    await processExportCategoryPage(env, claimed, new Date())
    if (!env.DATA_RIGHTS_EXPORT_QUEUE) return 'retry'
    try {
      await env.DATA_RIGHTS_EXPORT_QUEUE.send(queueMessage(message.artifactId))
      return 'ack'
    }
    catch {
      return 'retry'
    }
  }
  catch (error) {
    await releaseExportLease(
      env.DB,
      claimed.artifact.id,
      claimed.job.lease_token!,
      normalizeInternalErrorCode(error),
      new Date(),
    )
    throw error
  }
}

async function loadArtifactState(
  db: D1Database,
  artifactId: string,
): Promise<{ artifact: ExportArtifactRow; job: ExportJobRow } | null> {
  const [artifact, job] = await Promise.all([
    db.prepare(`
      SELECT artifact.id, artifact.request_id, artifact.request_version, artifact.account_id,
             artifact.profile_id, artifact.profile_version_snapshot, artifact.export_schema_version,
             artifact.status, artifact.version, artifact.generation_token, artifact.snapshot_at,
             artifact.part_count, artifact.record_count, artifact.payload_bytes,
             artifact.aggregate_sha256,
             artifact.readme_r2_key, artifact.readme_r2_etag, artifact.readme_sha256, artifact.readme_size,
             artifact.manifest_r2_key, artifact.manifest_r2_etag,
             artifact.manifest_sha256, artifact.manifest_size,
             artifact.archive_r2_key, artifact.archive_r2_etag, artifact.archive_size,
             artifact.generated_at, artifact.expires_at,
             request.status AS request_status, request.version AS current_request_version,
             request.mutation_token AS request_mutation_token,
             policy.export_processing_enabled AS policy_export_processing_enabled,
             policy.production_ready AS policy_production_ready,
             profile.state AS profile_state,
             profile.production_ready AS profile_production_ready,
             profile.artifact_ttl_hours, profile.download_ticket_ttl_seconds,
             profile.page_size, profile.max_part_bytes, profile.max_parts,
             profile.max_artifact_bytes,
             (
               SELECT COUNT(*)
               FROM app_data_rights_export_scopes scope
               WHERE scope.artifact_id = artifact.id
             ) AS category_count
      FROM app_data_rights_export_artifacts artifact
      JOIN app_data_rights_requests request ON request.id = artifact.request_id
      JOIN app_data_rights_policies policy ON policy.id = request.policy_id
      JOIN app_data_rights_export_profiles profile ON profile.id = artifact.profile_id
      WHERE artifact.id = ?
      LIMIT 1
    `).bind(artifactId).first<ExportArtifactRow>(),
    db.prepare(`
      SELECT artifact_id, status, version, category_ordinal, next_part_ordinal,
             lease_token, lease_expires_at, attempt_count
      FROM app_data_rights_export_jobs
      WHERE artifact_id = ?
      LIMIT 1
    `).bind(artifactId).first<ExportJobRow>(),
  ])
  return artifact && job ? { artifact, job } : null
}

async function claimExportJob(
  db: D1Database,
  current: { artifact: ExportArtifactRow; job: ExportJobRow },
  now: Date,
): Promise<{ artifact: ExportArtifactRow; job: ExportJobRow } | null> {
  const leaseToken = crypto.randomUUID()
  const timestamp = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString()
  const nextJobStatus = current.job.category_ordinal >= requireArtifactCategoryCount(
    current.artifact.category_count,
  )
    ? 'finalizing'
    : 'processing'
  const nextArtifactStatus = nextJobStatus === 'finalizing' ? 'finalizing' : 'collecting'
  const nextJobVersion = current.job.version + 1
  const nextArtifactVersion = current.artifact.version + 1
  const results = await db.batch([
    db.prepare(`
      UPDATE app_data_rights_export_jobs
      SET status = ?, version = ?, lease_token = ?, lease_expires_at = ?,
          attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?
      WHERE artifact_id = ? AND version = ?
        AND status IN ('pending', 'processing', 'finalizing')
        AND (lease_token IS NULL OR datetime(lease_expires_at) <= datetime(?))
        AND EXISTS (
          SELECT 1
          FROM app_data_rights_export_artifacts artifact
          JOIN app_data_rights_requests request ON request.id = artifact.request_id
          JOIN app_data_rights_policies policy ON policy.id = request.policy_id
          JOIN app_data_rights_export_profiles profile ON profile.id = artifact.profile_id
          WHERE artifact.id = app_data_rights_export_jobs.artifact_id
            AND artifact.status IN ('queued', 'collecting', 'finalizing')
            AND request.status = 'collecting'
            AND request.version = artifact.request_version
            AND policy.production_ready = 1 AND policy.export_processing_enabled = 1
            AND profile.state = 'published' AND profile.production_ready = 1
        )
    `).bind(
      nextJobStatus,
      nextJobVersion,
      leaseToken,
      leaseExpiresAt,
      timestamp,
      current.artifact.id,
      current.job.version,
      timestamp,
    ),
    db.prepare(`
      UPDATE app_data_rights_export_artifacts
      SET status = ?, version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('queued', 'collecting', 'finalizing')
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_jobs job
          WHERE job.artifact_id = app_data_rights_export_artifacts.id
            AND job.version = ? AND job.lease_token = ? AND job.status = ?
        )
    `).bind(
      nextArtifactStatus,
      nextArtifactVersion,
      timestamp,
      current.artifact.id,
      current.artifact.version,
      nextJobVersion,
      leaseToken,
      nextJobStatus,
    ),
  ])
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) return null
  return loadArtifactState(db, current.artifact.id)
}

async function processExportCategoryPage(
  env: ExportEnvironment,
  claimed: { artifact: ExportArtifactRow; job: ExportJobRow },
  now: Date,
): Promise<void> {
  const definition = EXPORT_CATEGORIES[claimed.job.category_ordinal]
  if (!definition) throw new FatalExportError('category_definition_missing', '导出分类定义不存在')
  const scope = await env.DB.prepare(`
    SELECT artifact_id, category_ordinal, category_code, status,
           max_rowid_snapshot, cursor_rowid, record_count, part_count
    FROM app_data_rights_export_scopes
    WHERE artifact_id = ? AND category_ordinal = ? AND category_code = ?
    LIMIT 1
  `).bind(
    claimed.artifact.id,
    claimed.job.category_ordinal,
    definition.code,
  ).first<ExportScopeRow>()
  if (!scope) throw new FatalExportError('category_scope_missing', '导出分类快照不存在')
  if (scope.status === 'completed') {
    await advanceCompletedScope(env.DB, claimed, now)
    return
  }
  const accountSelector = await resolveExportCategoryAccountSelector(env, claimed.artifact, definition)
  const rows = await env.DB.prepare(`
    SELECT source.rowid AS export_rowid, ${definition.jsonSql} AS export_json
    FROM ${definition.fromSql}
    WHERE ${definition.accountPredicate}
      AND source.rowid > ? AND source.rowid <= ?
    ORDER BY source.rowid ASC
    LIMIT ?
  `).bind(
    accountSelector,
    scope.cursor_rowid,
    scope.max_rowid_snapshot,
    claimed.artifact.page_size,
  ).all<ExportRow>()
  if (rows.results.length === 0) {
    await completeEmptyScope(env.DB, claimed, scope, now)
    return
  }
  const normalizedRows = rows.results.map((row) => {
    try {
      const parsed = JSON.parse(row.export_json) as unknown
      return { rowid: Number(row.export_rowid), json: JSON.stringify(parsed) }
    }
    catch {
      throw new FatalExportError('category_json_invalid', '导出分类生成了无效 JSON')
    }
  })
  const firstRowId = normalizedRows[0]!.rowid
  const lastRowId = normalizedRows.at(-1)!.rowid
  const bytes = new TextEncoder().encode(`${normalizedRows.map(row => row.json).join('\n')}\n`)
  if (bytes.byteLength <= 0 || bytes.byteLength > claimed.artifact.max_part_bytes) {
    throw new FatalExportError('part_size_limit_exceeded', '导出分页超过单文件大小上限')
  }
  if (
    claimed.job.next_part_ordinal > claimed.artifact.max_parts
    || claimed.artifact.part_count + 1 > claimed.artifact.max_parts
  ) {
    throw new FatalExportError('part_count_limit_exceeded', '导出文件数量超过策略上限')
  }
  if (claimed.artifact.payload_bytes + bytes.byteLength > claimed.artifact.max_artifact_bytes) {
    throw new FatalExportError('artifact_size_limit_exceeded', '导出制品超过策略大小上限')
  }
  const completed = lastRowId >= scope.max_rowid_snapshot
    || rows.results.length < claimed.artifact.page_size
  const partOrdinal = claimed.job.next_part_ordinal
  const fileName = `data/${String(partOrdinal).padStart(4, '0')}-${definition.code}.ndjson`
  const objectKey = `data-rights/exports/${claimed.artifact.request_id}/${claimed.artifact.id}/${fileName}`
  const fileSha256 = await sha256BytesHex(bytes)
  const object = await env.R2.put(objectKey, bytes, {
    httpMetadata: {
      contentType: 'application/x-ndjson; charset=utf-8',
      cacheControl: 'private, no-store, max-age=0',
    },
    customMetadata: {
      requestid: claimed.artifact.request_id,
      artifactid: claimed.artifact.id,
      category: definition.code,
      ordinal: String(partOrdinal),
      filesha256: fileSha256,
    },
    sha256: fileSha256,
  })
  if (
    !object
    || object.size !== bytes.byteLength
    || !object.etag
    || (r2Sha256Hex(object) !== null && r2Sha256Hex(object) !== fileSha256)
    || object.customMetadata?.requestid !== claimed.artifact.request_id
    || object.customMetadata?.artifactid !== claimed.artifact.id
    || object.customMetadata?.filesha256 !== fileSha256
  ) {
    throw new FatalExportError('r2_part_integrity_mismatch', '导出分页写入完整性校验失败')
  }

  const timestamp = now.toISOString()
  const partId = generateId('drep')
  const nextJobVersion = claimed.job.version + 1
  const nextArtifactVersion = claimed.artifact.version + 1
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO app_data_rights_export_parts (
        id, artifact_id, ordinal, category_code, file_name, r2_key, r2_etag,
        file_sha256, file_size, record_count, first_rowid, last_rowid, created_at
      )
      SELECT ?, artifact.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM app_data_rights_export_artifacts artifact
      JOIN app_data_rights_export_jobs job ON job.artifact_id = artifact.id
      WHERE artifact.id = ? AND artifact.version = ? AND artifact.status = 'collecting'
        AND job.version = ? AND job.lease_token = ? AND job.status = 'processing'
    `).bind(
      partId,
      partOrdinal,
      definition.code,
      fileName,
      objectKey,
      object.etag,
      fileSha256,
      bytes.byteLength,
      normalizedRows.length,
      firstRowId,
      lastRowId,
      timestamp,
      claimed.artifact.id,
      claimed.artifact.version,
      claimed.job.version,
      claimed.job.lease_token,
    ),
    env.DB.prepare(`
      UPDATE app_data_rights_export_scopes
      SET status = ?, cursor_rowid = ?, record_count = record_count + ?,
          part_count = part_count + 1, completed_at = ?, updated_at = ?
      WHERE artifact_id = ? AND category_ordinal = ? AND category_code = ?
        AND status IN ('pending', 'collecting') AND cursor_rowid = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_parts part
          WHERE part.id = ? AND part.artifact_id = app_data_rights_export_scopes.artifact_id
        )
    `).bind(
      completed ? 'completed' : 'collecting',
      lastRowId,
      normalizedRows.length,
      completed ? timestamp : null,
      timestamp,
      claimed.artifact.id,
      claimed.job.category_ordinal,
      definition.code,
      scope.cursor_rowid,
      partId,
    ),
    env.DB.prepare(`
      UPDATE app_data_rights_export_artifacts
      SET version = ?, part_count = part_count + 1,
          record_count = record_count + ?, payload_bytes = payload_bytes + ?,
          updated_at = ?
      WHERE id = ? AND version = ? AND status = 'collecting'
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_parts part
          WHERE part.id = ? AND part.artifact_id = app_data_rights_export_artifacts.id
        )
    `).bind(
      nextArtifactVersion,
      normalizedRows.length,
      bytes.byteLength,
      timestamp,
      claimed.artifact.id,
      claimed.artifact.version,
      partId,
    ),
    env.DB.prepare(`
      UPDATE app_data_rights_export_jobs
      SET status = 'pending', version = ?, category_ordinal = ?,
          next_part_ordinal = next_part_ordinal + 1,
          lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE artifact_id = ? AND version = ? AND lease_token = ? AND status = 'processing'
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_artifacts artifact
          WHERE artifact.id = app_data_rights_export_jobs.artifact_id
            AND artifact.version = ? AND artifact.status = 'collecting'
        )
    `).bind(
      nextJobVersion,
      completed ? claimed.job.category_ordinal + 1 : claimed.job.category_ordinal,
      timestamp,
      claimed.artifact.id,
      claimed.job.version,
      claimed.job.lease_token,
      nextArtifactVersion,
    ),
  ])
  if (results.some(result => changes(result) !== 1)) {
    throw new Error('export category state conflict')
  }
}

async function resolveExportCategoryAccountSelector(
  env: ExportEnvironment,
  artifact: ExportArtifactRow,
  definition: ExportCategoryDefinition,
) {
  if (definition.accountSelector !== 'recommendation_hash') return artifact.account_id
  if (!isRecommendationEvidenceSigningSecretReady(env.SESSION_SECRET)) {
    throw new FatalExportError(
      'recommendation_evidence_signing_secret_missing',
      '推荐证据账号定位密钥不可用',
    )
  }
  const account = await env.DB.prepare(`
    SELECT account_public_id
    FROM app_account_security
    WHERE account_id = ?
    LIMIT 1
  `).bind(artifact.account_id).first<{ account_public_id: string }>()
  if (!account) {
    throw new FatalExportError(
      'recommendation_evidence_account_link_missing',
      '推荐证据账号定位关系不存在',
    )
  }
  try {
    return await recommendationAccountHash(env.SESSION_SECRET, account.account_public_id)
  }
  catch {
    throw new FatalExportError(
      'recommendation_evidence_account_link_invalid',
      '推荐证据账号定位关系无效',
    )
  }
}

function requireArtifactCategoryCount(value: number) {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_EXPORT_CATEGORY_COUNT) {
    throw new FatalExportError('artifact_category_count_invalid', '导出制品分类数量无效')
  }
  return count
}

async function completeEmptyScope(
  db: D1Database,
  claimed: { artifact: ExportArtifactRow; job: ExportJobRow },
  scope: ExportScopeRow,
  now: Date,
) {
  const timestamp = now.toISOString()
  const nextJobVersion = claimed.job.version + 1
  const results = await db.batch([
    db.prepare(`
      UPDATE app_data_rights_export_scopes
      SET status = 'completed', cursor_rowid = max_rowid_snapshot,
          completed_at = ?, updated_at = ?
      WHERE artifact_id = ? AND category_ordinal = ? AND status IN ('pending', 'collecting')
        AND cursor_rowid = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_jobs job
          WHERE job.artifact_id = app_data_rights_export_scopes.artifact_id
            AND job.version = ? AND job.lease_token = ? AND job.status = 'processing'
        )
    `).bind(
      timestamp,
      timestamp,
      claimed.artifact.id,
      claimed.job.category_ordinal,
      scope.cursor_rowid,
      claimed.job.version,
      claimed.job.lease_token,
    ),
    db.prepare(`
      UPDATE app_data_rights_export_jobs
      SET status = 'pending', version = ?, category_ordinal = category_ordinal + 1,
          lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE artifact_id = ? AND version = ? AND lease_token = ? AND status = 'processing'
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_scopes scope
          WHERE scope.artifact_id = app_data_rights_export_jobs.artifact_id
            AND scope.category_ordinal = app_data_rights_export_jobs.category_ordinal
            AND scope.status = 'completed'
        )
    `).bind(
      nextJobVersion,
      timestamp,
      claimed.artifact.id,
      claimed.job.version,
      claimed.job.lease_token,
    ),
  ])
  if (results.some(result => changes(result) !== 1)) {
    throw new Error('empty export category state conflict')
  }
}

async function advanceCompletedScope(
  db: D1Database,
  claimed: { artifact: ExportArtifactRow; job: ExportJobRow },
  now: Date,
) {
  const result = await db.prepare(`
    UPDATE app_data_rights_export_jobs
    SET status = 'pending', version = version + 1, category_ordinal = category_ordinal + 1,
        lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE artifact_id = ? AND version = ? AND lease_token = ? AND status = 'processing'
  `).bind(
    now.toISOString(),
    claimed.artifact.id,
    claimed.job.version,
    claimed.job.lease_token,
  ).run()
  if (changes(result) !== 1) throw new Error('completed export category advance conflict')
}

async function finalizeExportArtifact(
  env: ExportEnvironment,
  claimed: { artifact: ExportArtifactRow; job: ExportJobRow },
  now: Date,
) {
  const incomplete = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM app_data_rights_export_scopes
    WHERE artifact_id = ? AND status <> 'completed'
  `).bind(claimed.artifact.id).first<{ count: number }>()
  if (Number(incomplete?.count ?? 0) !== 0) {
    throw new FatalExportError('scope_incomplete', '导出分类尚未全部完成')
  }
  const partsResult = await env.DB.prepare(`
    SELECT id, artifact_id, ordinal, category_code, file_name, r2_key, r2_etag,
           file_sha256, file_size, record_count, first_rowid, last_rowid
    FROM app_data_rights_export_parts
    WHERE artifact_id = ?
    ORDER BY ordinal ASC
  `).bind(claimed.artifact.id).all<ExportPartRow>()
  const parts = partsResult.results
  if (
    parts.length !== claimed.artifact.part_count
    || parts.length > claimed.artifact.max_parts
    || parts.reduce((sum, part) => sum + Number(part.file_size), 0) !== claimed.artifact.payload_bytes
  ) {
    throw new FatalExportError('part_manifest_mismatch', '导出分页清单与制品计数不一致')
  }
  const aggregateInput = parts.map(part => ({
    ordinal: Number(part.ordinal),
    category: part.category_code,
    fileName: part.file_name,
    sha256: part.file_sha256,
    sizeBytes: Number(part.file_size),
    recordCount: Number(part.record_count),
  }))
  const aggregateSha256 = await sha256Hex(JSON.stringify(aggregateInput))
  const generatedAt = now.toISOString()
  const expiresAt = new Date(
    now.getTime() + claimed.artifact.artifact_ttl_hours * 60 * 60_000,
  ).toISOString()
  const categoryIndex = await loadCategoryIndex(env.DB, claimed.artifact.id)
  const readme = buildExportReadme(claimed.artifact, categoryIndex, aggregateSha256, generatedAt, expiresAt)
  const readmeBytes = new TextEncoder().encode(readme)
  const manifest = {
    schemaVersion: claimed.artifact.export_schema_version,
    requestId: claimed.artifact.request_id,
    artifactId: claimed.artifact.id,
    generatedAt,
    expiresAt,
    format: 'tar',
    encoding: 'utf-8',
    dataFormat: 'ndjson',
    aggregateSha256,
    recordCount: claimed.artifact.record_count,
    categories: categoryIndex,
    files: aggregateInput,
    exclusions: [
      '密码、访问令牌、验证码和会话凭证',
      '第三方身份主体哈希、设备安装哈希和内部风控规则',
      '真人私有资料、管理员身份、内部备注和审核证据',
      '公开对象地址与任何可复用下载地址',
    ],
  }
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
  const readmeSha256 = await sha256BytesHex(readmeBytes)
  const manifestSha256 = await sha256BytesHex(manifestBytes)
  const prefix = `data-rights/exports/${claimed.artifact.request_id}/${claimed.artifact.id}`
  const readmeKey = `${prefix}/README.txt`
  const manifestKey = `${prefix}/manifest.json`
  const archiveKey = `${prefix}/meigallery-data-export.tar`
  const commonMetadata = {
    requestid: claimed.artifact.request_id,
    artifactid: claimed.artifact.id,
    aggregatedigest: aggregateSha256,
  }
  const readmeObject = await putVerifiedBytes(env.R2, readmeKey, readmeBytes, {
    contentType: 'text/plain; charset=utf-8',
    customMetadata: { ...commonMetadata, filesha256: readmeSha256 },
    sha256: readmeSha256,
  })
  const manifestObject = await putVerifiedBytes(env.R2, manifestKey, manifestBytes, {
    contentType: 'application/json; charset=utf-8',
    customMetadata: {
      ...commonMetadata,
      filesha256: manifestSha256,
      manifestsha256: manifestSha256,
    },
    sha256: manifestSha256,
  })
  const tarFiles: TarFile[] = [
    { name: 'README.txt', size: readmeBytes.byteLength, bytes: readmeBytes },
    { name: 'manifest.json', size: manifestBytes.byteLength, bytes: manifestBytes },
    ...parts.map(part => ({ name: part.file_name, size: Number(part.file_size), part })),
  ]
  const expectedArchiveSize = tarArchiveSize(tarFiles)
  if (expectedArchiveSize > claimed.artifact.max_artifact_bytes) {
    throw new FatalExportError('archive_size_limit_exceeded', '归档封装后超过制品大小上限')
  }
  const archiveObject = await env.R2.put(
    archiveKey,
    tarReadableStream(env.R2, claimed.artifact, tarFiles),
    {
      httpMetadata: {
        contentType: 'application/x-tar',
        contentDisposition: 'attachment; filename=\"meigallery-data-export.tar\"',
        cacheControl: 'private, no-store, max-age=0',
      },
      customMetadata: {
        ...commonMetadata,
        manifestsha256: manifestSha256,
      },
    },
  )
  if (
    !archiveObject
    || archiveObject.size !== expectedArchiveSize
    || !archiveObject.etag
    || archiveObject.customMetadata?.requestid !== claimed.artifact.request_id
    || archiveObject.customMetadata?.artifactid !== claimed.artifact.id
    || archiveObject.customMetadata?.manifestsha256 !== manifestSha256
    || archiveObject.customMetadata?.aggregatedigest !== aggregateSha256
  ) {
    throw new FatalExportError('r2_archive_integrity_mismatch', '私有导出归档完整性校验失败')
  }

  const nextRequestVersion = claimed.artifact.request_version + 1
  const requestMutationToken = crypto.randomUUID()
  const nextArtifactVersion = claimed.artifact.version + 1
  const nextJobVersion = claimed.job.version + 1
  const eventId = generateId('dre')
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE app_data_rights_requests
      SET status = 'ready', status_message_code = 'export_ready',
          version = ?, mutation_token = ?, failure_code = NULL, updated_at = ?
      WHERE id = ? AND request_type = 'export' AND status = 'collecting'
        AND version = ? AND mutation_token = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_jobs job
          WHERE job.artifact_id = ? AND job.version = ?
            AND job.lease_token = ? AND job.status = 'finalizing'
        )
    `).bind(
      nextRequestVersion,
      requestMutationToken,
      generatedAt,
      claimed.artifact.request_id,
      claimed.artifact.request_version,
      claimed.artifact.request_mutation_token,
      claimed.artifact.id,
      claimed.job.version,
      claimed.job.lease_token,
    ),
    env.DB.prepare(`
      UPDATE app_data_rights_export_artifacts
      SET status = 'ready', version = ?, aggregate_sha256 = ?,
          readme_r2_key = ?, readme_r2_etag = ?, readme_sha256 = ?, readme_size = ?,
          manifest_r2_key = ?, manifest_r2_etag = ?, manifest_sha256 = ?, manifest_size = ?,
          archive_r2_key = ?, archive_r2_etag = ?, archive_size = ?,
          generated_at = ?, expires_at = ?, failure_code = NULL, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'finalizing'
        AND EXISTS (
          SELECT 1 FROM app_data_rights_requests request
          WHERE request.id = app_data_rights_export_artifacts.request_id
            AND request.status = 'ready' AND request.version = ?
            AND request.mutation_token = ?
        )
    `).bind(
      nextArtifactVersion,
      aggregateSha256,
      readmeKey,
      readmeObject.etag,
      readmeSha256,
      readmeBytes.byteLength,
      manifestKey,
      manifestObject.etag,
      manifestSha256,
      manifestBytes.byteLength,
      archiveKey,
      archiveObject.etag,
      expectedArchiveSize,
      generatedAt,
      expiresAt,
      generatedAt,
      claimed.artifact.id,
      claimed.artifact.version,
      nextRequestVersion,
      requestMutationToken,
    ),
    env.DB.prepare(`
      UPDATE app_data_rights_export_jobs
      SET status = 'completed', version = ?, lease_token = NULL, lease_expires_at = NULL,
          last_error_code = NULL, updated_at = ?
      WHERE artifact_id = ? AND version = ? AND lease_token = ? AND status = 'finalizing'
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_artifacts artifact
          WHERE artifact.id = app_data_rights_export_jobs.artifact_id
            AND artifact.status = 'ready' AND artifact.version = ?
        )
    `).bind(
      nextJobVersion,
      generatedAt,
      claimed.artifact.id,
      claimed.job.version,
      claimed.job.lease_token,
      nextArtifactVersion,
    ),
    env.DB.prepare(`
      INSERT INTO app_data_rights_request_events (
        id, request_id, sequence, request_version, status_snapshot,
        event_type, visibility, actor_type, actor_id, reason_code,
        user_message, internal_note, safe_summary_json, created_at
      )
      SELECT ?, request.id,
             COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = request.id), 0) + 1,
             request.version, 'ready', 'export_ready', 'user', 'system', NULL,
             'private_export_ready',
             '数据副本已准备完成，请重新验证身份并在有效期内安全下载。',
             NULL, ?, ?
      FROM app_data_rights_requests request
      WHERE request.id = ? AND request.status = 'ready' AND request.version = ?
        AND request.mutation_token = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_artifacts artifact
          WHERE artifact.id = ? AND artifact.status = 'ready' AND artifact.version = ?
        )
    `).bind(
      eventId,
      JSON.stringify({
        artifactId: claimed.artifact.id,
        recordCount: claimed.artifact.record_count,
        partCount: claimed.artifact.part_count,
        manifestSha256,
        expiresAt,
      }),
      generatedAt,
      claimed.artifact.request_id,
      nextRequestVersion,
      requestMutationToken,
      claimed.artifact.id,
      nextArtifactVersion,
    ),
  ])
  if (results.some(result => changes(result) !== 1)) {
    throw new Error('export finalization state conflict')
  }
}

export async function getAdminAppDataRightsExportState(
  db: D1Database,
  requestIdValue: string,
) {
  const requestId = requireRequestId(requestIdValue)
  const artifact = await db.prepare(`
    SELECT artifact.id, artifact.status, artifact.version, artifact.request_version,
           artifact.profile_version_snapshot, artifact.export_schema_version,
           artifact.snapshot_at, artifact.part_count, artifact.record_count,
           artifact.payload_bytes, artifact.manifest_sha256, artifact.archive_size,
           artifact.generated_at, artifact.expires_at, artifact.failure_code,
           job.status AS job_status, job.category_ordinal, job.attempt_count,
           job.last_error_code,
           (SELECT COUNT(*) FROM app_data_rights_export_scopes scope
             WHERE scope.artifact_id = artifact.id) AS category_count,
           (SELECT COUNT(*) FROM app_data_rights_export_scopes scope
             WHERE scope.artifact_id = artifact.id AND scope.status = 'completed') AS completed_category_count
    FROM app_data_rights_export_artifacts artifact
    JOIN app_data_rights_export_jobs job ON job.artifact_id = artifact.id
    WHERE artifact.request_id = ?
    ORDER BY artifact.request_version DESC, artifact.id DESC
    LIMIT 1
  `).bind(requestId).first<{
    id: string
    status: ExportArtifactRow['status']
    version: number
    request_version: number
    profile_version_snapshot: string
    export_schema_version: number
    snapshot_at: string
    part_count: number
    record_count: number
    payload_bytes: number
    manifest_sha256: string | null
    archive_size: number | null
    generated_at: string | null
    expires_at: string | null
    failure_code: string | null
    job_status: ExportJobRow['status']
    category_ordinal: number
    attempt_count: number
    last_error_code: string | null
    category_count: number
    completed_category_count: number
  }>()
  if (!artifact) return null
  return {
    artifactId: artifact.id,
    status: publicArtifactStatus(artifact.status),
    version: Number(artifact.version),
    requestVersion: Number(artifact.request_version),
    profileVersion: artifact.profile_version_snapshot,
    schemaVersion: Number(artifact.export_schema_version),
    snapshotAt: artifact.snapshot_at,
    progress: {
      completedCategories: Number(artifact.completed_category_count),
      totalCategories: Number(artifact.category_count),
      currentCategory: EXPORT_CATEGORIES[Number(artifact.category_ordinal)]?.code ?? null,
      parts: Number(artifact.part_count),
      records: Number(artifact.record_count),
      payloadBytes: Number(artifact.payload_bytes),
    },
    job: {
      status: artifact.job_status,
      attempts: Number(artifact.attempt_count),
      lastErrorCode: artifact.last_error_code,
    },
    manifestSha256: artifact.manifest_sha256,
    archiveSize: artifact.archive_size === null ? null : Number(artifact.archive_size),
    generatedAt: artifact.generated_at,
    expiresAt: artifact.expires_at,
    failureCode: artifact.failure_code,
  }
}

export async function resolveAppDataRightsExportExecutorReadiness(
  env: Pick<Bindings, 'DB' | 'SESSION_SECRET'>,
  policyId: string,
) {
  const row = await env.DB.prepare(`
    SELECT profile.version_code, profile.state, profile.production_ready,
           policy.state AS policy_state, policy.production_ready AS policy_production_ready,
           policy.export_requests_enabled, policy.export_processing_enabled,
           policy.retention_decision_status, policy.owner_sla_decision_status,
           policy.region_decision_status
    FROM app_data_rights_policies policy
    LEFT JOIN app_data_rights_export_profiles profile ON profile.policy_id = policy.id
    WHERE policy.id = ?
    LIMIT 1
  `).bind(policyId).first<{
    version_code: string | null
    state: string | null
    production_ready: number | null
    policy_state: string
    policy_production_ready: number
    export_requests_enabled: number
    export_processing_enabled: number
    retention_decision_status: string
    owner_sla_decision_status: string
    region_decision_status: string
  }>()
  if (!row) {
    return { ready: false, profileVersion: null, reasonCode: 'policy_unavailable' }
  }
  if (!row.version_code) {
    return { ready: false, profileVersion: null, reasonCode: 'export_profile_unavailable' }
  }
  const governanceReady = row.state === 'published'
    && row.production_ready === 1
    && row.policy_state === 'published'
    && row.policy_production_ready === 1
    && row.export_requests_enabled === 1
    && row.export_processing_enabled === 1
    && row.retention_decision_status === 'approved'
    && row.owner_sla_decision_status === 'approved'
    && row.region_decision_status === 'approved'
  const signingSecretReady = isRecommendationEvidenceSigningSecretReady(env.SESSION_SECRET)
  const ready = governanceReady && signingSecretReady
  return {
    ready,
    profileVersion: row.version_code,
    reasonCode: ready
      ? null
      : governanceReady
        ? 'recommendation_evidence_signing_secret_missing'
        : 'export_governance_gate_closed',
  }
}

export async function issueAppDataRightsExportDownloadTicket(
  env: Pick<Bindings, 'DB' | 'R2' | 'SESSION_SECRET'>,
  principal: AppSessionPrincipal,
  requestIdValue: unknown,
  stepUpTokenValue: unknown,
  idempotencyKeyValue: string | null,
  requestTraceId: string,
  now = new Date(),
): Promise<AppDataRightsDownloadTicketResult> {
  const requestId = requireRequestId(requestIdValue)
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const idempotencyHash = await sha256Hex(idempotencyKey)
  const requestHash = await sha256Hex(JSON.stringify({ requestId }))
  const command = await env.DB.prepare(`
    SELECT request_hash, result_ticket_id
    FROM app_data_rights_export_download_commands
    WHERE account_id = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(
    principal.accountInternalId,
    idempotencyHash,
  ).first<{ request_hash: string; result_ticket_id: string }>()
  if (command) {
    if (!constantTimeEqual(command.request_hash, requestHash)) {
      throw new AppDataRightsError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键已用于其他下载申请')
    }
    const replayTicket = await requireDownloadTicketById(env.DB, command.result_ticket_id)
    ensureTicketCanBeReturned(replayTicket, principal, now)
    return {
      ticket: await materializeDownloadTicket(env.SESSION_SECRET, replayTicket),
      expiresAt: replayTicket.expires_at,
      fileName: 'meigallery-data-export.tar',
      manifestSha256: replayTicket.manifest_sha256_snapshot,
      replayed: true,
    }
  }
  const stepUpToken = typeof stepUpTokenValue === 'string' ? stepUpTokenValue.trim() : ''
  if (!/^drup_[A-Za-z0-9_-]{43}$/u.test(stepUpToken)) {
    throw new AppDataRightsError(401, 'STEP_UP_REQUIRED', '请先重新验证身份')
  }
  const ready = await requireReadyArtifactForAccount(
    env.DB,
    requestId,
    principal.accountInternalId,
    now,
  )
  const head = await env.R2.head(ready.archive_r2_key!)
  if (!head || !archiveObjectMatches(head, ready)) {
    throw new AppDataRightsError(409, 'EXPORT_OBJECT_INVALID', '导出制品完整性校验失败，已禁止下载')
  }

  const ticketId = generateId('drdt')
  const ticketExpiresAt = new Date(Math.min(
    now.getTime() + ready.download_ticket_ttl_seconds * 1000,
    Date.parse(ready.expires_at!),
  )).toISOString()
  const ticketClaims: DownloadTicketClaims = {
    ticketId,
    requestId,
    artifactId: ready.id,
    accountId: principal.accountInternalId,
    expiresAt: ticketExpiresAt,
  }
  const ticketToken = await buildDownloadToken(env.SESSION_SECRET, ticketClaims)
  const ticketTokenHash = await sha256Hex(ticketToken)
  const stepUpTokenHash = await sha256Hex(stepUpToken)
  const operationId = `${ticketId}:issue`
  const timestamp = now.toISOString()
  const commandId = generateId('drdc')
  const eventId = generateId('dre')
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE app_data_rights_step_up_tokens
      SET consumed_at = ?, consumed_operation_id = ?
      WHERE token_hash = ? AND account_id = ? AND session_id = ?
        AND request_id = ? AND purpose = 'export_download'
        AND consumed_at IS NULL AND datetime(expires_at) > datetime(?)
        AND EXISTS (
          SELECT 1
          FROM app_data_rights_requests request
          JOIN app_data_rights_export_artifacts artifact ON artifact.request_id = request.id
          WHERE request.id = ? AND request.account_id = ?
            AND request.request_type = 'export' AND request.status = 'ready'
            AND request.version = ?
            AND artifact.id = ? AND artifact.status = 'ready' AND artifact.version = ?
            AND artifact.manifest_sha256 = ? AND artifact.archive_r2_etag = ?
            AND datetime(artifact.expires_at) > datetime(?)
        )
    `).bind(
      timestamp,
      operationId,
      stepUpTokenHash,
      principal.accountInternalId,
      principal.sessionId,
      requestId,
      timestamp,
      requestId,
      principal.accountInternalId,
      ready.current_request_version,
      ready.id,
      ready.version,
      ready.manifest_sha256,
      ready.archive_r2_etag,
      timestamp,
    ),
    env.DB.prepare(`
      INSERT INTO app_data_rights_export_download_tickets (
        id, token_hash, request_id, request_version, artifact_id, artifact_version,
        account_id, manifest_sha256_snapshot, aggregate_sha256_snapshot,
        archive_r2_etag_snapshot, archive_size_snapshot, expires_at,
        consumed_at, consumed_request_id, created_at
      )
      SELECT ?, ?, request.id, request.version, artifact.id, artifact.version,
             request.account_id, artifact.manifest_sha256, artifact.aggregate_sha256,
             artifact.archive_r2_etag, artifact.archive_size, ?, NULL, NULL, ?
      FROM app_data_rights_requests request
      JOIN app_data_rights_export_artifacts artifact ON artifact.request_id = request.id
      WHERE request.id = ? AND request.account_id = ?
        AND request.request_type = 'export' AND request.status = 'ready'
        AND request.version = ?
        AND artifact.id = ? AND artifact.status = 'ready' AND artifact.version = ?
        AND artifact.manifest_sha256 = ? AND artifact.aggregate_sha256 = ?
        AND artifact.archive_r2_etag = ? AND artifact.archive_size = ?
        AND datetime(artifact.expires_at) > datetime(?)
        AND EXISTS (
          SELECT 1 FROM app_data_rights_step_up_tokens step_up
          WHERE step_up.token_hash = ? AND step_up.consumed_operation_id = ?
            AND step_up.consumed_at = ?
        )
    `).bind(
      ticketId,
      ticketTokenHash,
      ticketExpiresAt,
      timestamp,
      requestId,
      principal.accountInternalId,
      ready.current_request_version,
      ready.id,
      ready.version,
      ready.manifest_sha256,
      ready.aggregate_sha256,
      ready.archive_r2_etag,
      ready.archive_size,
      timestamp,
      stepUpTokenHash,
      operationId,
      timestamp,
    ),
    env.DB.prepare(`
      INSERT INTO app_data_rights_export_download_commands (
        id, account_id, request_id, idempotency_key_hash, request_hash,
        result_ticket_id, created_at
      )
      SELECT ?, account_id, request_id, ?, ?, id, ?
      FROM app_data_rights_export_download_tickets
      WHERE id = ? AND account_id = ?
    `).bind(
      commandId,
      idempotencyHash,
      requestHash,
      timestamp,
      ticketId,
      principal.accountInternalId,
    ),
    dataRightsEventStatement(env.DB, {
      id: eventId,
      requestId,
      requestVersion: ready.current_request_version,
      status: 'ready',
      eventType: 'export_download_ticket_issued',
      actorType: 'account',
      actorId: principal.accountInternalId,
      reasonCode: 'one_time_download_ticket_issued',
      userMessage: '已创建短期一次性下载凭证。',
      safeSummary: {
        artifactId: ready.id,
        ticketId,
        expiresAt: ticketExpiresAt,
        manifestSha256: ready.manifest_sha256,
        requestTraceId: normalizeTraceId(requestTraceId),
      },
      timestamp,
      requiredTicketId: ticketId,
    }),
  ])
  if (results.some(result => changes(result) !== 1)) {
    throw new AppDataRightsError(409, 'DOWNLOAD_TICKET_CONFLICT', '验证凭证已失效或导出状态已变化')
  }
  const stored = await requireDownloadTicketById(env.DB, ticketId)
  return {
    ticket: ticketToken,
    expiresAt: stored.expires_at,
    fileName: 'meigallery-data-export.tar',
    manifestSha256: stored.manifest_sha256_snapshot,
    replayed: false,
  }
}

export async function downloadAppDataRightsExport(
  env: Pick<Bindings, 'DB' | 'R2'>,
  principal: AppSessionPrincipal,
  requestIdValue: unknown,
  ticketTokenValue: unknown,
  requestTraceId: string,
  now = new Date(),
): Promise<Response> {
  const requestId = requireRequestId(requestIdValue)
  const ticketToken = requireDownloadToken(ticketTokenValue)
  const ticket = await env.DB.prepare(`
    ${downloadTicketSelect()}
    WHERE ticket.token_hash = ? AND ticket.request_id = ?
    LIMIT 1
  `).bind(
    await sha256Hex(ticketToken),
    requestId,
  ).first<DownloadTicketRow>()
  if (!ticket || ticket.account_id !== principal.accountInternalId) {
    throw new AppDataRightsError(404, 'DOWNLOAD_TICKET_NOT_FOUND', '下载凭证不存在或不属于当前账号')
  }
  ensureTicketCanBeReturned(ticket, principal, now)
  if (!ticket.archive_r2_key) {
    throw new AppDataRightsError(409, 'EXPORT_OBJECT_INVALID', '导出制品状态不完整')
  }
  const object = await env.R2.get(ticket.archive_r2_key)
  if (!object || !ticketArchiveObjectMatches(object, ticket)) {
    if (object) await object.body.cancel().catch(() => undefined)
    throw new AppDataRightsError(409, 'EXPORT_OBJECT_INVALID', '导出制品完整性校验失败，已禁止下载')
  }
  const timestamp = now.toISOString()
  const consumedRequestId = normalizeTraceId(requestTraceId)
  const eventId = generateId('dre')
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE app_data_rights_export_download_tickets
      SET consumed_at = ?, consumed_request_id = ?
      WHERE id = ? AND account_id = ? AND consumed_at IS NULL
        AND datetime(expires_at) > datetime(?)
        AND request_id = ? AND request_version = ?
        AND artifact_id = ? AND artifact_version = ?
        AND manifest_sha256_snapshot = ? AND aggregate_sha256_snapshot = ?
        AND archive_r2_etag_snapshot = ? AND archive_size_snapshot = ?
        AND EXISTS (
          SELECT 1 FROM app_sessions session
          WHERE session.id = ? AND session.account_id = ?
            AND session.status = 'active' AND datetime(session.access_expires_at) > datetime(?)
        )
        AND EXISTS (
          SELECT 1
          FROM app_data_rights_requests request
          JOIN app_data_rights_export_artifacts artifact ON artifact.request_id = request.id
          WHERE request.id = app_data_rights_export_download_tickets.request_id
            AND request.account_id = app_data_rights_export_download_tickets.account_id
            AND request.status = 'ready' AND request.version = app_data_rights_export_download_tickets.request_version
            AND artifact.id = app_data_rights_export_download_tickets.artifact_id
            AND artifact.status = 'ready' AND artifact.version = app_data_rights_export_download_tickets.artifact_version
            AND artifact.manifest_sha256 = app_data_rights_export_download_tickets.manifest_sha256_snapshot
            AND artifact.aggregate_sha256 = app_data_rights_export_download_tickets.aggregate_sha256_snapshot
            AND artifact.archive_r2_etag = app_data_rights_export_download_tickets.archive_r2_etag_snapshot
            AND artifact.archive_size = app_data_rights_export_download_tickets.archive_size_snapshot
            AND datetime(artifact.expires_at) > datetime(?)
        )
    `).bind(
      timestamp,
      consumedRequestId,
      ticket.id,
      principal.accountInternalId,
      timestamp,
      ticket.request_id,
      ticket.request_version,
      ticket.artifact_id,
      ticket.artifact_version,
      ticket.manifest_sha256_snapshot,
      ticket.aggregate_sha256_snapshot,
      ticket.archive_r2_etag_snapshot,
      ticket.archive_size_snapshot,
      principal.sessionId,
      principal.accountInternalId,
      timestamp,
      timestamp,
    ),
    dataRightsEventStatement(env.DB, {
      id: eventId,
      requestId: ticket.request_id,
      requestVersion: ticket.request_version,
      status: 'ready',
      eventType: 'export_download_started',
      actorType: 'account',
      actorId: principal.accountInternalId,
      reasonCode: 'one_time_download_ticket_consumed',
      userMessage: '安全下载已开始。',
      safeSummary: {
        artifactId: ticket.artifact_id,
        ticketId: ticket.id,
        manifestSha256: ticket.manifest_sha256_snapshot,
        requestTraceId: consumedRequestId,
      },
      timestamp,
      consumedTicketId: ticket.id,
      consumedRequestId,
    }),
  ])
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) {
    await object.body.cancel().catch(() => undefined)
    throw new AppDataRightsError(409, 'DOWNLOAD_TICKET_CONSUMED', '下载凭证已使用、已过期或导出状态已变化')
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'application/x-tar',
      'Content-Length': String(ticket.archive_size_snapshot),
      'Content-Disposition': 'attachment; filename=\"meigallery-data-export.tar\"',
      'X-Content-Type-Options': 'nosniff',
      'X-Data-Rights-Manifest-SHA256': ticket.manifest_sha256_snapshot,
    },
  })
}

export async function recoverAppDataRightsExports(
  env: Pick<Bindings, 'DB' | 'DATA_RIGHTS_EXPORT_QUEUE'>,
  now = new Date(),
  limit = RECOVERY_LIMIT,
) {
  if (!env.DATA_RIGHTS_EXPORT_QUEUE) {
    return { skipped: true, dispatched: 0 }
  }
  const normalizedLimit = Math.max(1, Math.min(limit, RECOVERY_LIMIT))
  const rows = await env.DB.prepare(`
    SELECT job.artifact_id
    FROM app_data_rights_export_jobs job
    JOIN app_data_rights_export_artifacts artifact ON artifact.id = job.artifact_id
    JOIN app_data_rights_requests request ON request.id = artifact.request_id
    WHERE job.status IN ('pending', 'processing', 'finalizing')
      AND (job.lease_token IS NULL OR datetime(job.lease_expires_at) <= datetime(?))
      AND artifact.status IN ('queued', 'collecting', 'finalizing')
      AND request.status = 'collecting'
    ORDER BY job.updated_at ASC, job.artifact_id ASC
    LIMIT ?
  `).bind(now.toISOString(), normalizedLimit).all<{ artifact_id: string }>()
  let dispatched = 0
  for (const row of rows.results) {
    try {
      await env.DATA_RIGHTS_EXPORT_QUEUE.send(queueMessage(row.artifact_id))
      dispatched += 1
    }
    catch {
      break
    }
  }
  return { skipped: false, dispatched }
}

export async function purgeExpiredAppDataRightsExports(
  env: Pick<Bindings, 'DB' | 'R2'>,
  now = new Date(),
  limit = 25,
) {
  const rows = await env.DB.prepare(`
    SELECT artifact.id
    FROM app_data_rights_export_artifacts artifact
    JOIN app_data_rights_requests request ON request.id = artifact.request_id
    WHERE artifact.status IN ('ready', 'expired', 'purging')
      AND artifact.expires_at IS NOT NULL
      AND datetime(artifact.expires_at) <= datetime(?)
      AND request.request_type = 'export'
    ORDER BY artifact.expires_at ASC, artifact.id ASC
    LIMIT ?
  `).bind(
    now.toISOString(),
    Math.max(1, Math.min(limit, 100)),
  ).all<{ id: string }>()
  let purged = 0
  for (const row of rows.results) {
    let state = await loadArtifactState(env.DB, row.id)
    if (!state) continue
    const timestamp = now.toISOString()
    const requestWillExpire = state.artifact.request_status === 'ready'
      && state.artifact.current_request_version === state.artifact.request_version + 1
    if (state.artifact.status !== 'purging') {
      const nextRequestVersion = state.artifact.current_request_version + (requestWillExpire ? 1 : 0)
      const requestMutationToken = crypto.randomUUID()
      const nextArtifactVersion = state.artifact.version + 1
      const eventId = generateId('dre')
      const statements: D1PreparedStatement[] = []
      if (requestWillExpire) {
        statements.push(
          env.DB.prepare(`
            UPDATE app_data_rights_requests
            SET status = 'expired', status_message_code = 'export_expired',
                version = ?, mutation_token = ?, updated_at = ?
            WHERE id = ? AND request_type = 'export' AND status = 'ready'
              AND version = ? AND mutation_token = ?
          `).bind(
            nextRequestVersion,
            requestMutationToken,
            timestamp,
            state.artifact.request_id,
            state.artifact.current_request_version,
            state.artifact.request_mutation_token,
          ),
          env.DB.prepare(`
            INSERT INTO app_data_rights_request_events (
              id, request_id, sequence, request_version, status_snapshot,
              event_type, visibility, actor_type, actor_id, reason_code,
              user_message, internal_note, safe_summary_json, created_at
            )
            SELECT ?, id,
                   COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = app_data_rights_requests.id), 0) + 1,
                   version, 'expired', 'export_expired', 'user', 'system', NULL,
                   'private_export_expired', '数据副本已过期并进入私有存储清理，可重新提交导出申请。',
                   NULL, ?, ?
            FROM app_data_rights_requests
            WHERE id = ? AND status = 'expired' AND version = ? AND mutation_token = ?
          `).bind(
            eventId,
            JSON.stringify({ artifactId: state.artifact.id }),
            timestamp,
            state.artifact.request_id,
            nextRequestVersion,
            requestMutationToken,
          ),
        )
      }
      statements.push(env.DB.prepare(`
        UPDATE app_data_rights_export_artifacts
        SET status = 'purging', version = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('ready', 'expired')
          AND datetime(expires_at) <= datetime(?)
          AND EXISTS (
            SELECT 1 FROM app_data_rights_requests request
            WHERE request.id = app_data_rights_export_artifacts.request_id
              AND request.status = 'expired'
          )
      `).bind(
        nextArtifactVersion,
        timestamp,
        state.artifact.id,
        state.artifact.version,
        timestamp,
      ))
      const phaseOne = await env.DB.batch(statements)
      if (changes(phaseOne.at(-1)!) !== 1) continue
      const reloaded = await loadArtifactState(env.DB, row.id)
      if (!reloaded || reloaded.artifact.status !== 'purging') continue
      state = reloaded
    }
    await purgeArtifactObjects(env.R2, env.DB, state.artifact)
    const completed = await env.DB.prepare(`
      UPDATE app_data_rights_export_artifacts
      SET status = 'purged', version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'purging'
        AND EXISTS (
          SELECT 1 FROM app_data_rights_requests request
          WHERE request.id = app_data_rights_export_artifacts.request_id
            AND request.status = 'expired'
        )
    `).bind(
      timestamp,
      state.artifact.id,
      state.artifact.version,
    ).run()
    if (changes(completed) === 1) purged += 1
  }
  return { purged }
}

async function failExportJob(
  env: Pick<Bindings, 'DB' | 'R2'>,
  artifactId: string,
  failureCodeValue: string,
  now: Date,
) {
  const state = await loadArtifactState(env.DB, artifactId)
  if (!state || !['queued', 'collecting', 'finalizing'].includes(state.artifact.status)) return
  await purgeArtifactObjects(env.R2, env.DB, state.artifact)
  const failureCode = normalizeFailureCode(failureCodeValue)
  const timestamp = now.toISOString()
  const requestCanFail = state.artifact.request_status === 'collecting'
  const nextRequestVersion = state.artifact.current_request_version + 1
  const requestMutationToken = crypto.randomUUID()
  const nextArtifactVersion = state.artifact.version + 1
  const nextJobVersion = state.job.version + 1
  const eventId = generateId('dre')
  const statements: D1PreparedStatement[] = []
  if (requestCanFail) {
    statements.push(
      env.DB.prepare(`
        UPDATE app_data_rights_requests
        SET status = 'failed', status_message_code = 'processing_failed',
            version = ?, mutation_token = ?, failure_code = ?, updated_at = ?
        WHERE id = ? AND request_type = 'export' AND status = 'collecting'
          AND version = ? AND mutation_token = ?
      `).bind(
        nextRequestVersion,
        requestMutationToken,
        failureCode,
        timestamp,
        state.artifact.request_id,
        state.artifact.current_request_version,
        state.artifact.request_mutation_token,
      ),
    )
  }
  statements.push(
    env.DB.prepare(`
      UPDATE app_data_rights_export_artifacts
      SET status = ?, version = ?, failure_code = ?, updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('queued', 'collecting', 'finalizing')
    `).bind(
      requestCanFail ? 'failed' : 'superseded',
      nextArtifactVersion,
      failureCode,
      timestamp,
      artifactId,
      state.artifact.version,
    ),
    env.DB.prepare(`
      UPDATE app_data_rights_export_jobs
      SET status = 'failed', version = ?, lease_token = NULL, lease_expires_at = NULL,
          last_error_code = ?, updated_at = ?
      WHERE artifact_id = ? AND version = ? AND status IN ('pending', 'processing', 'finalizing')
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_artifacts artifact
          WHERE artifact.id = app_data_rights_export_jobs.artifact_id
            AND artifact.version = ? AND artifact.status IN ('failed', 'superseded')
        )
    `).bind(
      nextJobVersion,
      failureCode,
      timestamp,
      artifactId,
      state.job.version,
      nextArtifactVersion,
    ),
  )
  if (requestCanFail) {
    statements.push(env.DB.prepare(`
      INSERT INTO app_data_rights_request_events (
        id, request_id, sequence, request_version, status_snapshot,
        event_type, visibility, actor_type, actor_id, reason_code,
        user_message, internal_note, safe_summary_json, created_at
      )
      SELECT ?, request.id,
             COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = request.id), 0) + 1,
             request.version, 'failed', 'processing_failed', 'user', 'system', NULL,
             'private_export_generation_failed',
             '数据副本暂未生成，平台会保留申请状态以便安全重试。',
             NULL, ?, ?
      FROM app_data_rights_requests request
      WHERE request.id = ? AND request.status = 'failed' AND request.version = ?
        AND request.mutation_token = ?
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_artifacts artifact
          WHERE artifact.id = ? AND artifact.request_id = request.id
            AND artifact.status = 'failed' AND artifact.version = ?
            AND artifact.failure_code = ?
        )
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_jobs job
          WHERE job.artifact_id = ? AND job.status = 'failed' AND job.version = ?
            AND job.last_error_code = ?
        )
    `).bind(
      eventId,
      JSON.stringify({ artifactId, failureCode }),
      timestamp,
      state.artifact.request_id,
      nextRequestVersion,
      requestMutationToken,
      artifactId,
      nextArtifactVersion,
      failureCode,
      artifactId,
      nextJobVersion,
      failureCode,
    ))
  }
  await env.DB.batch(statements)
}

async function abandonExportArtifact(
  env: Pick<Bindings, 'DB' | 'R2'>,
  artifact: ExportArtifactRow,
  now: Date,
) {
  await purgeArtifactObjects(env.R2, env.DB, artifact)
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE app_data_rights_export_artifacts
      SET status = 'superseded', version = version + 1,
          failure_code = 'request_state_changed', updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('queued', 'collecting', 'finalizing')
    `).bind(now.toISOString(), artifact.id, artifact.version),
    env.DB.prepare(`
      UPDATE app_data_rights_export_jobs
      SET status = 'failed', version = version + 1, lease_token = NULL, lease_expires_at = NULL,
          last_error_code = 'request_state_changed', updated_at = ?
      WHERE artifact_id = ? AND status IN ('pending', 'processing', 'finalizing')
        AND EXISTS (
          SELECT 1 FROM app_data_rights_export_artifacts artifact
          WHERE artifact.id = app_data_rights_export_jobs.artifact_id
            AND artifact.status = 'superseded'
        )
    `).bind(now.toISOString(), artifact.id),
  ])
}

async function releaseExportLease(
  db: D1Database,
  artifactId: string,
  leaseToken: string,
  errorCode: string,
  now: Date,
) {
  await db.prepare(`
    UPDATE app_data_rights_export_jobs
    SET status = 'pending', version = version + 1,
        lease_token = NULL, lease_expires_at = NULL,
        last_error_code = ?, updated_at = ?
    WHERE artifact_id = ? AND lease_token = ? AND status IN ('processing', 'finalizing')
  `).bind(
    normalizeFailureCode(errorCode),
    now.toISOString(),
    artifactId,
    leaseToken,
  ).run()
}

async function requireReadyArtifactForAccount(
  db: D1Database,
  requestId: string,
  accountId: number,
  now: Date,
): Promise<ExportArtifactRow> {
  const row = await db.prepare(`
    SELECT artifact.id
    FROM app_data_rights_export_artifacts artifact
    JOIN app_data_rights_requests request ON request.id = artifact.request_id
    WHERE artifact.request_id = ? AND request.account_id = ?
      AND request.request_type = 'export' AND request.status = 'ready'
      AND artifact.status = 'ready'
      AND artifact.aggregate_sha256 IS NOT NULL
      AND artifact.manifest_sha256 IS NOT NULL
      AND artifact.archive_r2_key IS NOT NULL
      AND artifact.archive_r2_etag IS NOT NULL
      AND artifact.archive_size IS NOT NULL
      AND datetime(artifact.expires_at) > datetime(?)
    ORDER BY artifact.request_version DESC, artifact.id DESC
    LIMIT 1
  `).bind(requestId, accountId, now.toISOString()).first<{ id: string }>()
  if (!row) {
    throw new AppDataRightsError(409, 'EXPORT_NOT_READY', '导出文件尚未就绪或已经过期')
  }
  const state = await loadArtifactState(db, row.id)
  if (
    !state
    || state.artifact.account_id !== accountId
    || state.artifact.request_status !== 'ready'
    || state.artifact.status !== 'ready'
    || !state.artifact.expires_at
    || Date.parse(state.artifact.expires_at) <= now.getTime()
  ) {
    throw new AppDataRightsError(409, 'EXPORT_NOT_READY', '导出文件尚未就绪或已经过期')
  }
  return state.artifact
}

async function requireDownloadTicketById(
  db: D1Database,
  ticketId: string,
): Promise<DownloadTicketRow> {
  const row = await db.prepare(`
    ${downloadTicketSelect()}
    WHERE ticket.id = ?
    LIMIT 1
  `).bind(ticketId).first<DownloadTicketRow>()
  if (!row) throw new AppDataRightsError(404, 'DOWNLOAD_TICKET_NOT_FOUND', '下载凭证不存在')
  return row
}

function downloadTicketSelect() {
  return `
    SELECT ticket.id, ticket.request_id, ticket.request_version,
           ticket.artifact_id, ticket.artifact_version, ticket.account_id,
           ticket.manifest_sha256_snapshot, ticket.aggregate_sha256_snapshot,
           ticket.archive_r2_etag_snapshot, ticket.archive_size_snapshot,
           ticket.expires_at, ticket.consumed_at,
           request.status AS request_status,
           artifact.status AS artifact_status,
           artifact.archive_r2_key, artifact.expires_at AS artifact_expires_at,
           profile.download_ticket_ttl_seconds AS profile_ticket_ttl_seconds
    FROM app_data_rights_export_download_tickets ticket
    JOIN app_data_rights_requests request ON request.id = ticket.request_id
    JOIN app_data_rights_export_artifacts artifact ON artifact.id = ticket.artifact_id
    JOIN app_data_rights_export_profiles profile ON profile.id = artifact.profile_id
  `
}

function ensureTicketCanBeReturned(
  ticket: DownloadTicketRow,
  principal: AppSessionPrincipal,
  now: Date,
) {
  if (ticket.account_id !== principal.accountInternalId) {
    throw new AppDataRightsError(404, 'DOWNLOAD_TICKET_NOT_FOUND', '下载凭证不存在或不属于当前账号')
  }
  if (ticket.consumed_at) {
    throw new AppDataRightsError(409, 'DOWNLOAD_TICKET_CONSUMED', '下载凭证已经使用')
  }
  if (
    Date.parse(ticket.expires_at) <= now.getTime()
    || !ticket.artifact_expires_at
    || Date.parse(ticket.artifact_expires_at) <= now.getTime()
    || ticket.request_status !== 'ready'
    || ticket.artifact_status !== 'ready'
  ) {
    throw new AppDataRightsError(409, 'DOWNLOAD_TICKET_EXPIRED', '下载凭证或导出文件已经过期')
  }
}

type DownloadTicketClaims = {
  ticketId: string
  requestId: string
  artifactId: string
  accountId: number
  expiresAt: string
}

async function materializeDownloadTicket(
  secret: string,
  ticket: DownloadTicketRow,
): Promise<string> {
  return buildDownloadToken(secret, {
    ticketId: ticket.id,
    requestId: ticket.request_id,
    artifactId: ticket.artifact_id,
    accountId: ticket.account_id,
    expiresAt: ticket.expires_at,
  })
}

async function buildDownloadToken(secret: string, claims: DownloadTicketClaims) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const payload = [
    'data-rights-download',
    'v1',
    claims.ticketId,
    claims.requestId,
    claims.artifactId,
    String(claims.accountId),
    claims.expiresAt,
  ].join(':')
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )
  return `drdl_${base64Url(new Uint8Array(signature))}`
}

function dataRightsEventStatement(
  db: D1Database,
  input: {
    id: string
    requestId: string
    requestVersion: number
    status: string
    eventType: string
    actorType: 'account' | 'system'
    actorId: number | null
    reasonCode: string
    userMessage: string
    safeSummary: Record<string, unknown>
    timestamp: string
    requiredTicketId?: string
    consumedTicketId?: string
    consumedRequestId?: string
  },
) {
  const guards: string[] = []
  const guardValues: unknown[] = []
  if (input.requiredTicketId) {
    guards.push(`EXISTS (
      SELECT 1 FROM app_data_rights_export_download_tickets ticket
      WHERE ticket.id = ? AND ticket.request_id = request.id
    )`)
    guardValues.push(input.requiredTicketId)
  }
  if (input.consumedTicketId && input.consumedRequestId) {
    guards.push(`EXISTS (
      SELECT 1 FROM app_data_rights_export_download_tickets ticket
      WHERE ticket.id = ? AND ticket.request_id = request.id
        AND ticket.consumed_at = ? AND ticket.consumed_request_id = ?
    )`)
    guardValues.push(input.consumedTicketId, input.timestamp, input.consumedRequestId)
  }
  return db.prepare(`
    INSERT INTO app_data_rights_request_events (
      id, request_id, sequence, request_version, status_snapshot,
      event_type, visibility, actor_type, actor_id, reason_code,
      user_message, internal_note, safe_summary_json, created_at
    )
    SELECT ?, request.id,
           COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = request.id), 0) + 1,
           request.version, ?, ?, 'user', ?, ?, ?, ?, NULL, ?, ?
    FROM app_data_rights_requests request
    WHERE request.id = ? AND request.version = ? AND request.status = ?
      ${guards.map(guard => `AND ${guard}`).join('\n      ')}
  `).bind(
    input.id,
    input.status,
    input.eventType,
    input.actorType,
    input.actorId,
    input.reasonCode,
    input.userMessage,
    JSON.stringify(input.safeSummary),
    input.timestamp,
    input.requestId,
    input.requestVersion,
    input.status,
    ...guardValues,
  )
}

async function loadCategoryIndex(db: D1Database, artifactId: string) {
  const scopes = await db.prepare(`
    SELECT category_ordinal, category_code, record_count, part_count
    FROM app_data_rights_export_scopes
    WHERE artifact_id = ? AND status = 'completed'
    ORDER BY category_ordinal ASC
  `).bind(artifactId).all<{
    category_ordinal: number
    category_code: string
    record_count: number
    part_count: number
  }>()
  return scopes.results.map(scope => ({
    ordinal: Number(scope.category_ordinal),
    code: scope.category_code,
    label: EXPORT_CATEGORIES[Number(scope.category_ordinal)]?.label ?? scope.category_code,
    recordCount: Number(scope.record_count),
    partCount: Number(scope.part_count),
  }))
}

function buildExportReadme(
  artifact: ExportArtifactRow,
  categories: Array<{
    ordinal: number
    code: string
    label: string
    recordCount: number
    partCount: number
  }>,
  aggregateSha256: string,
  generatedAt: string,
  expiresAt: string,
) {
  const lines = [
    'MeiGallery 账号数据副本',
    '',
    `申请编号：${artifact.request_id}`,
    `制品编号：${artifact.id}`,
    `生成时间：${generatedAt}`,
    `逻辑有效期至：${expiresAt}`,
    `记录总数：${artifact.record_count}`,
    `数据文件数：${artifact.part_count}`,
    `清单聚合 SHA-256：${aggregateSha256}`,
    '',
    '目录说明',
    '- manifest.json：机器可读清单，含每个 NDJSON 文件的 SHA-256。',
    '- data/*.ndjson：每行一个 JSON 对象，按账号本人数据分类拆分。',
    '',
    '分类索引',
    ...categories.map(category =>
      `- ${category.label}（${category.code}）：${category.recordCount} 条，${category.partCount} 个文件`),
    '',
    '安全与范围',
    '- 本副本不包含密码、令牌、验证码、会话凭证或可复用下载地址。',
    '- 本副本不包含第三方身份主体哈希、设备安装哈希、管理员身份、内部备注或风控规则。',
    '- 人物资料仅出现你曾互动对象的公开引用，不包含真人私有认证材料。',
    '- 下载票据已在下载开始前一次性消费；如下载中断，需要重新验证身份并创建新票据。',
    '',
    '完整性检查',
    '- 使用 manifest.json 中的 sha256 字段逐个校验 data/ 下文件。',
    '- manifest.json 本身的 SHA-256 会通过下载响应头 X-Data-Rights-Manifest-SHA256 返回。',
    '',
  ]
  return lines.join('\n')
}

async function putVerifiedBytes(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  input: {
    contentType: string
    customMetadata: Record<string, string>
    sha256: string
  },
) {
  const object = await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: input.contentType,
      cacheControl: 'private, no-store, max-age=0',
    },
    customMetadata: input.customMetadata,
    sha256: input.sha256,
  })
  if (
    !object
    || object.size !== bytes.byteLength
    || !object.etag
    || (r2Sha256Hex(object) !== null && r2Sha256Hex(object) !== input.sha256)
    || Object.entries(input.customMetadata).some(
      ([metadataKey, value]) => object.customMetadata?.[metadataKey] !== value,
    )
  ) {
    throw new FatalExportError('r2_object_integrity_mismatch', '私有导出对象完整性校验失败')
  }
  return object
}

function archiveObjectMatches(object: R2Object, artifact: ExportArtifactRow) {
  return Boolean(
    artifact.archive_r2_etag
    && artifact.archive_size
    && artifact.manifest_sha256
    && artifact.aggregate_sha256
    && object.etag === artifact.archive_r2_etag
    && object.size === Number(artifact.archive_size)
    && object.customMetadata?.requestid === artifact.request_id
    && object.customMetadata?.artifactid === artifact.id
    && object.customMetadata?.manifestsha256 === artifact.manifest_sha256
    && object.customMetadata?.aggregatedigest === artifact.aggregate_sha256
  )
}

function ticketArchiveObjectMatches(object: R2ObjectBody, ticket: DownloadTicketRow) {
  return object.etag === ticket.archive_r2_etag_snapshot
    && object.size === Number(ticket.archive_size_snapshot)
    && object.customMetadata?.requestid === ticket.request_id
    && object.customMetadata?.artifactid === ticket.artifact_id
    && object.customMetadata?.manifestsha256 === ticket.manifest_sha256_snapshot
    && object.customMetadata?.aggregatedigest === ticket.aggregate_sha256_snapshot
}

function partObjectMatches(
  object: R2ObjectBody,
  artifact: ExportArtifactRow,
  part: ExportPartRow,
) {
  const checksum = r2Sha256Hex(object)
  return object.etag === part.r2_etag
    && object.size === Number(part.file_size)
    && (checksum === null || checksum === part.file_sha256)
    && object.customMetadata?.requestid === artifact.request_id
    && object.customMetadata?.artifactid === artifact.id
    && object.customMetadata?.category === part.category_code
    && object.customMetadata?.ordinal === String(part.ordinal)
    && object.customMetadata?.filesha256 === part.file_sha256
}

async function purgeArtifactObjects(
  bucket: R2Bucket,
  db: D1Database,
  artifact: ExportArtifactRow,
) {
  const parts = await db.prepare(`
    SELECT r2_key
    FROM app_data_rights_export_parts
    WHERE artifact_id = ?
    ORDER BY ordinal ASC
  `).bind(artifact.id).all<{ r2_key: string }>()
  const keys = [
    ...parts.results.map(part => part.r2_key),
    artifact.readme_r2_key,
    artifact.manifest_r2_key,
    artifact.archive_r2_key,
  ].filter((key): key is string => Boolean(key))
  for (let offset = 0; offset < keys.length; offset += 1000) {
    await bucket.delete(keys.slice(offset, offset + 1000))
  }
}

type TarFile = {
  name: string
  size: number
  bytes?: Uint8Array
  part?: ExportPartRow
}

function tarArchiveSize(files: TarFile[]) {
  return files.reduce(
    (sum, file) => sum + 512 + Math.ceil(file.size / 512) * 512,
    1024,
  )
}

function tarReadableStream(
  bucket: R2Bucket,
  artifact: ExportArtifactRow,
  files: TarFile[],
): ReadableStream<Uint8Array> {
  const iterator = tarChunks(bucket, artifact, files)[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      }
      catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.(undefined)
    },
  })
}

async function* tarChunks(
  bucket: R2Bucket,
  artifact: ExportArtifactRow,
  files: TarFile[],
): AsyncGenerator<Uint8Array> {
  const modifiedAt = Math.max(
    0,
    Math.floor(Date.parse(artifact.snapshot_at) / 1000),
  )
  for (const file of files) {
    yield buildTarHeader(file.name, file.size, modifiedAt)
    let written = 0
    if (file.bytes) {
      yield file.bytes
      written = file.bytes.byteLength
    }
    else if (file.part) {
      const object = await bucket.get(file.part.r2_key)
      if (!object || !partObjectMatches(object, artifact, file.part)) {
        if (object) await object.body.cancel().catch(() => undefined)
        throw new FatalExportError('r2_part_integrity_mismatch', '归档前分页完整性校验失败')
      }
      const reader = object.body.getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          written += chunk.value.byteLength
          yield chunk.value
        }
      }
      finally {
        reader.releaseLock()
      }
    }
    if (written !== file.size) {
      throw new FatalExportError('r2_part_size_mismatch', '归档分页实际大小与清单不一致')
    }
    const padding = (512 - (written % 512)) % 512
    if (padding > 0) yield new Uint8Array(padding)
  }
  yield new Uint8Array(1024)
}

function buildTarHeader(name: string, size: number, modifiedAt: number) {
  const header = new Uint8Array(512)
  const nameBytes = new TextEncoder().encode(name)
  if (nameBytes.byteLength === 0 || nameBytes.byteLength > 100) {
    throw new FatalExportError('tar_file_name_invalid', '归档文件名不符合 TAR 限制')
  }
  header.set(nameBytes, 0)
  writeTarOctal(header, 100, 8, 0o600)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, size)
  writeTarOctal(header, 136, 12, modifiedAt)
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeTarAscii(header, 257, 'ustar\0')
  writeTarAscii(header, 263, '00')
  writeTarAscii(header, 265, 'meigallery')
  writeTarAscii(header, 297, 'meigallery')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const checksumText = checksum.toString(8).padStart(6, '0')
  writeTarAscii(header, 148, checksumText)
  header[154] = 0
  header[155] = 0x20
  return header
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FatalExportError('tar_numeric_field_invalid', '归档数字字段无效')
  }
  const text = value.toString(8).padStart(length - 1, '0')
  if (text.length > length - 1) {
    throw new FatalExportError('tar_numeric_field_overflow', '归档数字字段超过 TAR 限制')
  }
  writeTarAscii(target, offset, text)
  target[offset + length - 1] = 0
}

function writeTarAscii(target: Uint8Array, offset: number, value: string) {
  const bytes = new TextEncoder().encode(value)
  target.set(bytes, offset)
}

function r2Sha256Hex(object: Pick<R2Object, 'checksums'>) {
  const checksum = object.checksums.sha256
  if (!checksum) return null
  return Array.from(
    new Uint8Array(checksum),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
}

function publicArtifactStatus(
  status: ExportArtifactRow['status'],
): AppDataRightsExportArtifactStatus {
  if (status === 'queued') return 'queued'
  if (status === 'collecting') return 'collecting'
  if (status === 'finalizing') return 'finalizing'
  if (status === 'ready') return 'ready'
  if (status === 'failed' || status === 'superseded') return 'failed'
  return 'expired'
}

function queueMessage(artifactId: string): AppDataRightsExportQueueMessage {
  return {
    schemaVersion: 1,
    kind: EXPORT_MESSAGE_KIND,
    artifactId,
  }
}

function parseQueueMessage(value: unknown): AppDataRightsExportQueueMessage | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AppDataRightsExportQueueMessage>
  if (
    candidate.schemaVersion !== 1
    || candidate.kind !== EXPORT_MESSAGE_KIND
    || typeof candidate.artifactId !== 'string'
    || !/^drea_[A-Za-z0-9_-]{1,91}$/u.test(candidate.artifactId)
  ) return null
  return candidate as AppDataRightsExportQueueMessage
}

function safeAck(message: QueueMessageLike) {
  try {
    message.ack?.()
  }
  catch {
    // ack 失败由 Cloudflare Queues 自身重投；业务步骤通过租约和版本幂等。
  }
}

function safeRetry(message: QueueMessageLike) {
  try {
    message.retry?.({ delaySeconds: 15 })
  }
  catch {
    // retry 调用失败时不 ack，让 Queue 使用默认重投语义。
  }
}

function changes(result: D1Result<unknown> | undefined) {
  return Number(result?.meta.changes ?? 0)
}

function requireRequestId(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!REQUEST_ID.test(normalized)) {
    throw new AppDataRightsError(400, 'REQUEST_ID_INVALID', '数据权利申请编号格式错误')
  }
  return normalized
}

function requireIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AppDataRightsError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供有效的 Idempotency-Key')
  }
  return normalized
}

function requireDownloadToken(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!DOWNLOAD_TOKEN.test(normalized)) {
    throw new AppDataRightsError(401, 'DOWNLOAD_TICKET_REQUIRED', '请提供有效的短期下载凭证')
  }
  return normalized
}

function normalizeFailureCode(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 120)
  return normalized.length >= 3 ? normalized : 'export_failed'
}

function normalizeInternalErrorCode(error: unknown) {
  return error instanceof FatalExportError
    ? error.code
    : 'export_step_failed'
}

function normalizeTraceId(value: string) {
  const normalized = value.trim()
  return /^[A-Za-z0-9._:-]{8,96}$/u.test(normalized)
    ? normalized
    : crypto.randomUUID()
}

async function sha256Hex(value: string) {
  return sha256BytesHex(new TextEncoder().encode(value))
}

async function sha256BytesHex(value: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return mismatch === 0
}
