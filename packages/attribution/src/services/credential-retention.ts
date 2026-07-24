import { AttributionDomainError } from '../domain/errors'

interface RetiredCredentialRow {
  version_id: string
  status: 'failed' | 'superseded' | 'retired'
  retired_at: string | null
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export async function enforceCredentialRetention(
  db: D1Database,
  now = new Date(),
): Promise<{ deleted: number; scheduled: number }> {
  if (!Number.isFinite(now.getTime())) {
    throw new AttributionDomainError(
      'ATTRIBUTION_CREDENTIAL_RETENTION_STATE_INVALID',
    )
  }

  const result = await db.prepare(`
    SELECT
      version.id AS version_id,
      version.status,
      version.retired_at
    FROM attribution_connection_versions AS version
    INNER JOIN attribution_version_credentials AS credential
      ON credential.version_id = version.id
    WHERE version.status IN ('failed','superseded','retired')
    ORDER BY
      CASE version.status WHEN 'retired' THEN 0 ELSE 1 END ASC,
      version.retired_at DESC,
      version.created_at DESC,
      version.id DESC
  `).all<RetiredCredentialRow>()

  const statements: D1PreparedStatement[] = []
  let deleted = 0
  let scheduled = 0

  for (const row of result.results) {
    if (row.status === 'failed' || row.status === 'superseded') {
      statements.push(deleteCredential(db, row.version_id))
      deleted += 1
      continue
    }

    const retiredAt = parseTimestamp(row.retired_at)

    const destroyAfter = new Date(retiredAt.getTime() + RETENTION_MS)
    if (destroyAfter.getTime() <= now.getTime()) {
      statements.push(deleteCredential(db, row.version_id))
      deleted += 1
      continue
    }

    statements.push(db.prepare(`
      UPDATE attribution_version_credentials
      SET destroy_after = ?
      WHERE version_id = ?
    `).bind(destroyAfter.toISOString(), row.version_id))
    scheduled += 1
  }

  if (statements.length > 0) {
    await db.batch(statements)
  }

  return { deleted, scheduled }
}

function deleteCredential(
  db: D1Database,
  versionId: string,
): D1PreparedStatement {
  return db.prepare(`
    DELETE FROM attribution_version_credentials
    WHERE version_id = ?
  `).bind(versionId)
}

function parseTimestamp(value: string | null): Date {
  const timestamp = value ? new Date(value) : new Date(Number.NaN)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new AttributionDomainError(
      'ATTRIBUTION_CREDENTIAL_RETENTION_STATE_INVALID',
    )
  }
  return timestamp
}
