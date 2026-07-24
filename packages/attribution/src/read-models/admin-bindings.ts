import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import { AttributionDomainError } from '../domain/errors'

export interface AdminAttributionBindingsQuery {
  provider?: AttributionProvider
  connectionId?: string
}

export interface AdminAttributionBindingView {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface AdminAttributionConnectionBindingsView {
  provider: AttributionProvider
  connectionId: string
  connectionName: string
  active: {
    state: 'active' | 'not_configured'
    bindings: AdminAttributionBindingView[]
  }
  candidate: null | {
    state: 'candidate' | 'validating' | 'ready' | 'failed'
    bindings: AdminAttributionBindingView[]
  }
}

interface BindingRow {
  provider: string
  connection_id: string
  connection_name: string
  snapshot: string
  snapshot_state: string | null
  canonical_event: string | null
  enabled: number | null
  browser_destination: string | null
  server_destination: string | null
}

export async function listAdminAttributionBindings(
  db: D1Database,
  input: AdminAttributionBindingsQuery,
): Promise<AdminAttributionConnectionBindingsView[]> {
  const query = normalizeBindingsQuery(input)
  const rows = await db.prepare(`
    WITH selected_connections AS (
      SELECT
        connection.id,
        connection.provider,
        connection.name,
        connection.active_version_id,
        COALESCE(
          (
            SELECT version.id
            FROM attribution_connection_versions AS version
            WHERE version.connection_id = connection.id
              AND version.provider = connection.provider
              AND version.status IN ('candidate','validating','ready')
            ORDER BY version.created_at DESC, version.id DESC
            LIMIT 1
          ),
          (
            SELECT version.id
            FROM attribution_connection_versions AS version
            WHERE version.connection_id = connection.id
              AND version.provider = connection.provider
              AND version.status = 'failed'
            ORDER BY version.created_at DESC, version.id DESC
            LIMIT 1
          )
        ) AS candidate_version_id
      FROM attribution_connections AS connection
      WHERE (? IS NULL OR connection.provider = ?)
        AND (? IS NULL OR connection.id = ?)
    ),
    snapshots AS (
      SELECT
        id AS connection_id,
        provider,
        name AS connection_name,
        'active' AS snapshot,
        active_version_id AS version_id
      FROM selected_connections
      UNION ALL
      SELECT
        id,
        provider,
        name,
        'candidate',
        candidate_version_id
      FROM selected_connections
      WHERE candidate_version_id IS NOT NULL
    )
    SELECT
      snapshot.provider,
      snapshot.connection_id,
      snapshot.connection_name,
      snapshot.snapshot,
      version.status AS snapshot_state,
      binding.canonical_event,
      binding.enabled,
      binding.browser_destination,
      binding.server_destination
    FROM snapshots AS snapshot
    LEFT JOIN attribution_connection_versions AS version
      ON version.id = snapshot.version_id
     AND version.connection_id = snapshot.connection_id
     AND version.provider = snapshot.provider
    LEFT JOIN attribution_version_bindings AS binding
      ON binding.version_id = version.id
    ORDER BY
      snapshot.provider,
      snapshot.connection_name,
      snapshot.connection_id,
      CASE WHEN snapshot.snapshot = 'active' THEN 0 ELSE 1 END,
      binding.canonical_event
  `).bind(
    query.provider ?? null,
    query.provider ?? null,
    query.connectionId ?? null,
    query.connectionId ?? null,
  ).all<BindingRow>()

  const views = new Map<string, AdminAttributionConnectionBindingsView>()
  for (const row of rows.results) {
    const provider = getProviderAdapter(row.provider).provider
    let view = views.get(row.connection_id)
    if (!view) {
      view = {
        provider,
        connectionId: identifier(row.connection_id),
        connectionName: text(row.connection_name),
        active: {
          state: 'not_configured',
          bindings: [],
        },
        candidate: null,
      }
      views.set(row.connection_id, view)
    }

    const binding = row.canonical_event === null
      ? null
      : bindingView(row)
    if (row.snapshot === 'active') {
      view.active.state = row.snapshot_state === 'active'
        ? 'active'
        : 'not_configured'
      if (binding) view.active.bindings.push(binding)
      continue
    }
    if (row.snapshot !== 'candidate' || row.snapshot_state === null) {
      throw invalid()
    }
    if (!view.candidate) {
      view.candidate = {
        state: candidateState(row.snapshot_state),
        bindings: [],
      }
    }
    if (binding) view.candidate.bindings.push(binding)
  }
  return [...views.values()]
}

function normalizeBindingsQuery(
  input: AdminAttributionBindingsQuery,
): AdminAttributionBindingsQuery {
  if (!input || typeof input !== 'object') throw invalid()
  return {
    provider: input.provider === undefined
      ? undefined
      : getProviderAdapter(input.provider).provider,
    connectionId: input.connectionId === undefined
      ? undefined
      : identifier(input.connectionId),
  }
}

function bindingView(row: BindingRow): AdminAttributionBindingView {
  return {
    canonicalEvent: canonicalEvent(row.canonical_event),
    enabled: booleanValue(row.enabled),
    browserDestination: text(row.browser_destination ?? '', true),
    serverDestination: text(row.server_destination ?? '', true),
  }
}

function canonicalEvent(value: string | null): CanonicalConversionEvent {
  if (value === 'Contact' || value === 'CompleteRegistration') {
    return value
  }
  throw invalid()
}

function candidateState(
  value: string,
): 'candidate' | 'validating' | 'ready' | 'failed' {
  if (
    value === 'candidate'
    || value === 'validating'
    || value === 'ready'
    || value === 'failed'
  ) {
    return value
  }
  throw invalid()
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9:_-]{1,240}$/.test(value)
  ) {
    throw invalid()
  }
  return value
}

function text(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== 'string'
    || value.length > 1024
    || (!allowEmpty && value.trim().length === 0)
  ) {
    throw invalid()
  }
  return value
}

function booleanValue(value: number | null): boolean {
  if (value !== 0 && value !== 1) throw invalid()
  return value === 1
}

function invalid(): AttributionDomainError {
  return new AttributionDomainError(
    'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID',
  )
}
