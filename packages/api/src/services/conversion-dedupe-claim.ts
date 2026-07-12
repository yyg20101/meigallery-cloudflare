const CLAIM_LEASE_MODIFIER = '+60 seconds'
const CLAIM_ACQUIRE_ATTEMPTS = 3
const ISO_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type ConversionDedupeClaim = {
  dedupe_digest: string
  owner_action_id: string
  claim_token: string
  claimed_at: string
  expires_at: string
}

export type AcquireConversionDedupeClaimResult =
  | { state: 'acquired'; claim: ConversionDedupeClaim }
  | { state: 'duplicate'; existingId: string }
  | { state: 'unavailable' }

export async function digestConversionDedupeKey(dedupeKey: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dedupeKey))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function generateConversionClaimToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function d1Changed(result: D1Result<unknown>) {
  if (!isRecord(result) || !isRecord(result.meta)) return false
  if (Object.prototype.hasOwnProperty.call(result.meta, 'changes')) {
    return validWriteCount(result.meta.changes) > 0
  }
  return validWriteCount(result.meta.rows_written) > 0
}

export async function acquireConversionDedupeClaim(
  db: D1Database,
  dedupeDigest: string,
  ownerActionId: string,
  findCommittedId: () => Promise<string | null>,
): Promise<AcquireConversionDedupeClaimResult> {
  for (let attempt = 0; attempt < CLAIM_ACQUIRE_ATTEMPTS; attempt += 1) {
    const inserted = await insertConversionDedupeClaim(db, dedupeDigest, ownerActionId)
    if (inserted) return { state: 'acquired', claim: inserted }

    const existingId = await findCommittedId()
    if (existingId) return { state: 'duplicate', existingId }

    const current = await readConversionDedupeClaim(db, dedupeDigest)
    if (current) {
      const takenOver = await takeoverConversionDedupeClaim(db, current, ownerActionId)
      if (takenOver) return { state: 'acquired', claim: takenOver }
    }
    await Promise.resolve()
  }

  const existingId = await findCommittedId()
  return existingId ? { state: 'duplicate', existingId } : { state: 'unavailable' }
}

export async function insertConversionDedupeClaim(
  db: D1Database,
  dedupeDigest: string,
  ownerActionId: string,
) {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO analytics_conversion_dedupe_claims (
      dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
    ) VALUES (
      ?, ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
    )
    RETURNING dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
  `).bind(
    dedupeDigest,
    ownerActionId,
    generateConversionClaimToken(),
    CLAIM_LEASE_MODIFIER,
  ).run<ConversionDedupeClaim>()
  return returnedClaim(result)
}

export function readConversionDedupeClaim(db: D1Database, dedupeDigest: string) {
  return db.prepare(`
    SELECT dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
    FROM analytics_conversion_dedupe_claims
    WHERE dedupe_digest = ?
    LIMIT 1
  `).bind(dedupeDigest).first<ConversionDedupeClaim>()
}

export async function takeoverConversionDedupeClaim(
  db: D1Database,
  current: ConversionDedupeClaim,
  ownerActionId: string,
) {
  const result = await db.prepare(`
    UPDATE analytics_conversion_dedupe_claims
    SET
      owner_action_id = ?,
      claim_token = ?,
      claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
    WHERE dedupe_digest = ?
      AND owner_action_id = ?
      AND claim_token = ?
      AND claimed_at = ?
      AND expires_at = ?
      AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    RETURNING dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
  `).bind(
    ownerActionId,
    generateConversionClaimToken(),
    CLAIM_LEASE_MODIFIER,
    ...conversionDedupeClaimSnapshotParams(current),
  ).run<ConversionDedupeClaim>()
  return returnedClaim(result)
}

export async function renewConversionDedupeClaim(
  db: D1Database,
  claim: ConversionDedupeClaim,
) {
  const result = await db.prepare(`
    UPDATE analytics_conversion_dedupe_claims
    SET
      claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
    WHERE dedupe_digest = ?
      AND owner_action_id = ?
      AND claim_token = ?
      AND claimed_at = ?
      AND expires_at = ?
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    RETURNING dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
  `).bind(
    CLAIM_LEASE_MODIFIER,
    ...conversionDedupeClaimSnapshotParams(claim),
  ).run<ConversionDedupeClaim>()
  return returnedClaim(result)
}

export function releaseConversionDedupeClaimStatement(
  db: D1Database,
  claim: ConversionDedupeClaim,
) {
  return db.prepare(`
    DELETE FROM analytics_conversion_dedupe_claims
    WHERE dedupe_digest = ?
      AND owner_action_id = ?
      AND claim_token = ?
      AND claimed_at = ?
      AND expires_at = ?
  `).bind(...conversionDedupeClaimSnapshotParams(claim))
}

export async function releaseConversionDedupeClaim(
  db: D1Database,
  claim: ConversionDedupeClaim,
) {
  try {
    await releaseConversionDedupeClaimStatement(db, claim).run()
  }
  catch {
    // 释放失败时短租约会自然过期，且旧快照无法删除新 owner。
  }
}

export function conversionDedupeClaimSnapshotParams(claim: ConversionDedupeClaim) {
  return [
    claim.dedupe_digest,
    claim.owner_action_id,
    claim.claim_token,
    claim.claimed_at,
    claim.expires_at,
  ] as const
}

function returnedClaim(result: D1Result<ConversionDedupeClaim>) {
  if (!d1Changed(result) || !Array.isArray(result.results) || result.results.length !== 1) return null
  return validClaim(result.results[0]) ? result.results[0] : null
}

function validClaim(value: unknown): value is ConversionDedupeClaim {
  if (!isRecord(value)) return false
  return /^[0-9a-f]{64}$/.test(String(value.dedupe_digest ?? ''))
    && /^.{1,128}$/.test(String(value.owner_action_id ?? ''))
    && /^[0-9a-f]{32}$/.test(String(value.claim_token ?? ''))
    && ISO_MILLISECONDS_PATTERN.test(String(value.claimed_at ?? ''))
    && ISO_MILLISECONDS_PATTERN.test(String(value.expires_at ?? ''))
    && String(value.expires_at) > String(value.claimed_at)
}

function validWriteCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
