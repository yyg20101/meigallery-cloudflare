import { AttributionDomainError } from '../domain/errors'

interface DrainingVersionRow {
  id: string
  draining_at: string | null
  credential_version_id: string | null
}

const DRAINING_MS = 30 * 60 * 1_000
const CREDENTIAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export async function retireDrainedVersions(
  db: D1Database,
  now = new Date(),
): Promise<{ retired: number }> {
  if (!Number.isFinite(now.getTime())) {
    throw new AttributionDomainError('ATTRIBUTION_VERSION_STATE_INVALID')
  }

  const rows = await db.prepare(`
    SELECT
      version.id,
      version.draining_at,
      credential.version_id AS credential_version_id
    FROM attribution_connection_versions AS version
    LEFT JOIN attribution_version_credentials AS credential
      ON credential.version_id = version.id
    WHERE version.status = 'draining'
    ORDER BY version.draining_at, version.id
  `).all<DrainingVersionRow>()

  const candidates = rows.results.filter(row => {
    const drainingAt = parseDrainingTimestamp(row)
    return drainingAt.getTime() + DRAINING_MS <= now.getTime()
  })
  if (candidates.length === 0) return { retired: 0 }

  const retiredAt = now.toISOString()
  const destroyAfter = new Date(
    now.getTime() + CREDENTIAL_RETENTION_MS,
  ).toISOString()
  const statements: D1PreparedStatement[] = []
  for (const row of candidates) {
    statements.push(
      db.prepare(`
        UPDATE attribution_connection_versions
        SET status = 'retired',
            retired_at = ?
        WHERE id = ?
          AND status = 'draining'
          AND draining_at = ?
      `).bind(retiredAt, row.id, row.draining_at),
      db.prepare(`
        UPDATE attribution_version_credentials
        SET destroy_after = ?
        WHERE version_id = ?
          AND changes() = 1
      `).bind(destroyAfter, row.id),
    )
  }

  let results: D1Result<unknown>[]
  try {
    results = await db.batch(statements)
  } catch {
    throw new AttributionDomainError('ATTRIBUTION_VERSION_STATE_INVALID')
  }
  let retired = 0
  for (let index = 0; index < results.length; index += 2) {
    retired += Number(results[index]?.meta.changes ?? 0)
  }
  return { retired }
}

function parseDrainingTimestamp(row: DrainingVersionRow): Date {
  const value = row.draining_at ? new Date(row.draining_at) : null
  if (
    !value
    || !Number.isFinite(value.getTime())
    || row.credential_version_id !== row.id
  ) {
    throw new AttributionDomainError('ATTRIBUTION_VERSION_STATE_INVALID')
  }
  return value
}
