export type AttributionRuntimeMode = 'shadow' | 'bridge' | 'active'

export interface AttributionRuntimeState {
  mode: AttributionRuntimeMode
  activatedAt: string | null
  updatedAt: string
}

interface RuntimeStateRow {
  mode: string
  activated_at: string | null
  updated_at: string
}

const NEXT_MODE: Readonly<
  Record<AttributionRuntimeMode, AttributionRuntimeMode | null>
> = Object.freeze({
  shadow: 'bridge',
  bridge: 'active',
  active: null,
})

export async function readAttributionRuntimeState(
  db: D1Database,
): Promise<AttributionRuntimeState> {
  const row = await db.prepare(`
    SELECT mode, activated_at, updated_at
    FROM attribution_runtime_state
    WHERE id = 'global'
    LIMIT 1
  `).first<RuntimeStateRow>()

  if (
    !row
    || !isRuntimeMode(row.mode)
    || !isCanonicalTimestamp(row.updated_at)
    || (
      row.mode === 'active'
        ? !isCanonicalTimestamp(row.activated_at)
        : row.activated_at !== null
    )
  ) {
    throw new Error('ATTRIBUTION_RUNTIME_STATE_INVALID')
  }

  return {
    mode: row.mode,
    activatedAt: row.activated_at,
    updatedAt: row.updated_at,
  }
}

export async function transitionAttributionRuntimeMode(
  db: D1Database,
  targetMode: AttributionRuntimeMode,
  now: () => Date = () => new Date(),
): Promise<AttributionRuntimeState> {
  const current = await readAttributionRuntimeState(db)
  if (current.mode === targetMode) return current
  if (NEXT_MODE[current.mode] !== targetMode) {
    throw new Error('ATTRIBUTION_RUNTIME_TRANSITION_INVALID')
  }

  const timestamp = canonicalTimestamp(now())
  const result = await db.prepare(`
    UPDATE attribution_runtime_state
    SET mode = ?,
        activated_at = CASE
          WHEN ? = 'active' THEN ?
          ELSE NULL
        END,
        updated_at = ?
    WHERE id = 'global'
      AND mode = ?
  `).bind(
    targetMode,
    targetMode,
    timestamp,
    timestamp,
    current.mode,
  ).run()

  if (Number(result.meta.changes ?? 0) !== 1) {
    const concurrent = await readAttributionRuntimeState(db)
    if (concurrent.mode === targetMode) return concurrent
    throw new Error('ATTRIBUTION_RUNTIME_TRANSITION_CONFLICT')
  }

  return readAttributionRuntimeState(db)
}

function isRuntimeMode(value: string): value is AttributionRuntimeMode {
  return value === 'shadow' || value === 'bridge' || value === 'active'
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('ATTRIBUTION_RUNTIME_TIMESTAMP_INVALID')
  }
  return value.toISOString()
}
