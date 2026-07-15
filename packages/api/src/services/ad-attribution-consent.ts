const CONTEXT_ID_PATTERN = /^ctx_[0-9a-f]{32}$/

export async function revokeAdAttributionContext(db: D1Database, contextId: string) {
  if (!CONTEXT_ID_PATTERN.test(contextId)) return { cancelledDeliveryCount: 0 }
  const results = await db.batch([
    db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'cancelled', updated_at = datetime('now')
      WHERE status IN ('planned', 'queued', 'retrying')
        AND fact_id IN (
          SELECT id
          FROM attribution_conversion_facts
          WHERE attribution_context_id = ?
        )
    `).bind(contextId),
    db.prepare(`
      DELETE FROM attribution_outbox
      WHERE delivery_id IN (
        SELECT d.id
        FROM attribution_deliveries d
        JOIN attribution_conversion_facts f ON f.id = d.fact_id
        WHERE f.attribution_context_id = ?
          AND d.status = 'cancelled'
      )
    `).bind(contextId),
  ])
  return { cancelledDeliveryCount: changes(results[0]) }
}

function changes(result: D1Result<unknown> | undefined) {
  return result?.meta?.changes ?? result?.meta?.rows_written ?? 0
}
