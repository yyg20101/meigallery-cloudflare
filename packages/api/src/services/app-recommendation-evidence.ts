import type { AppRecommendationRuntimeConfig } from './app-recommendation-policy'

const ACCOUNT_PUBLIC_ID_PATTERN = /^acc_[A-Za-z0-9_-]{1,76}$/u
const MINIMUM_HMAC_SECRET_LENGTH = 16
const DEFAULT_PURGE_LIMIT = 1000
const MAX_PURGE_LIMIT = 5000

type RecommendationEvidencePolicyRow = {
  evidence_retention_decision_status: string
  evidence_retention_days: number | null
  purge_enabled: number
}

type RecommendationEvidenceCount = {
  session_count: number
  item_count: number
}

export type AppRecommendationEvidencePurgeResult = {
  skipped: boolean
  reason: 'policy_not_configured' | 'policy_not_found' | 'retention_not_ready' | null
  deletedSessionCount: number
  hasMore: boolean
}

export async function purgeExpiredAppRecommendationEvidence(
  db: D1Database,
  config: AppRecommendationRuntimeConfig,
  now = new Date(),
  limit = DEFAULT_PURGE_LIMIT,
): Promise<AppRecommendationEvidencePurgeResult> {
  if (!config.policyConfigured) return skippedPurge('policy_not_configured')
  const policy = await db.prepare(`
    SELECT evidence_retention_decision_status, evidence_retention_days, purge_enabled
    FROM app_recommendation_policies
    WHERE policy_id = ?
    LIMIT 1
  `).bind(config.policyId).first<RecommendationEvidencePolicyRow>()
  if (!policy) return skippedPurge('policy_not_found')
  if (
    policy.evidence_retention_decision_status !== 'approved'
    || !Number.isSafeInteger(policy.evidence_retention_days)
    || Number(policy.evidence_retention_days) < 1
    || policy.purge_enabled !== 1
  ) return skippedPurge('retention_not_ready')

  const safeLimit = normalizePurgeLimit(limit)
  const timestamp = requireTimestamp(now)
  const deleted = await db.prepare(`
    DELETE FROM app_recommendation_sessions
    WHERE session_id IN (
      SELECT session_id
      FROM app_recommendation_sessions
      WHERE expires_at <= ?
      ORDER BY expires_at ASC, session_id ASC
      LIMIT ?
    )
    RETURNING session_id
  `).bind(timestamp, safeLimit).all<{ session_id: string }>()
  const remaining = await db.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM app_recommendation_sessions
      WHERE expires_at <= ?
      LIMIT 1
    ) AS has_more
  `).bind(timestamp).first<{ has_more: number }>()
  return {
    skipped: false,
    reason: null,
    deletedSessionCount: deleted.results.length,
    hasMore: remaining?.has_more === 1,
  }
}

export async function countAppRecommendationEvidenceForAccount(
  db: D1Database,
  signingSecret: string,
  accountPublicId: string,
) {
  const accountHash = await recommendationAccountHash(signingSecret, accountPublicId)
  const count = await loadAccountEvidenceCount(db, accountHash)
  return count.session_count + count.item_count
}

export async function purgeAppRecommendationEvidenceForAccount(
  db: D1Database,
  signingSecret: string,
  accountPublicId: string,
) {
  const accountHash = await recommendationAccountHash(signingSecret, accountPublicId)
  const before = await loadAccountEvidenceCount(db, accountHash)
  await db.prepare(`
    DELETE FROM app_recommendation_sessions
    WHERE account_hash = ?
  `).bind(accountHash).run()
  return {
    deletedSessionCount: before.session_count,
    deletedItemCount: before.item_count,
  }
}

export async function recommendationAccountHash(
  signingSecret: string,
  accountPublicId: string,
) {
  if (!isRecommendationEvidenceSigningSecretReady(signingSecret)) {
    throw new Error('RECOMMENDATION_EVIDENCE_SIGNING_SECRET_INVALID')
  }
  if (!ACCOUNT_PUBLIC_ID_PATTERN.test(accountPublicId)) {
    throw new Error('RECOMMENDATION_EVIDENCE_ACCOUNT_ID_INVALID')
  }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`recommendation-account-v1\u0000${accountPublicId}`),
  )
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function isRecommendationEvidenceSigningSecretReady(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MINIMUM_HMAC_SECRET_LENGTH
}

async function loadAccountEvidenceCount(db: D1Database, accountHash: string) {
  const count = await db.prepare(`
    SELECT
      COUNT(DISTINCT session.session_id) AS session_count,
      COUNT(item.rank) AS item_count
    FROM app_recommendation_sessions session
    LEFT JOIN app_recommendation_session_items item
      ON item.session_id = session.session_id
    WHERE session.account_hash = ?
  `).bind(accountHash).first<RecommendationEvidenceCount>()
  const sessionCount = Number(count?.session_count ?? 0)
  const itemCount = Number(count?.item_count ?? 0)
  if (
    !Number.isSafeInteger(sessionCount)
    || sessionCount < 0
    || !Number.isSafeInteger(itemCount)
    || itemCount < 0
  ) throw new Error('RECOMMENDATION_EVIDENCE_COUNT_INVALID')
  return { session_count: sessionCount, item_count: itemCount }
}

function skippedPurge(reason: NonNullable<AppRecommendationEvidencePurgeResult['reason']>) {
  return {
    skipped: true,
    reason,
    deletedSessionCount: 0,
    hasMore: false,
  } as const
}

function normalizePurgeLimit(value: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PURGE_LIMIT
    ? value
    : DEFAULT_PURGE_LIMIT
}

function requireTimestamp(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('RECOMMENDATION_EVIDENCE_PURGE_TIME_INVALID')
  }
  return value.toISOString()
}
