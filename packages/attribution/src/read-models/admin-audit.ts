import type {
  AttributionProvider,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import { AttributionDomainError } from '../domain/errors'

export interface AdminAttributionAuditQuery {
  dateFrom?: string
  dateTo?: string
  provider?: AttributionProvider
  connectionId?: string
  limit?: number
}

export interface AdminAttributionAuditView {
  provider: AttributionProvider | null
  connectionId: string
  connectionName: string
  actorId: number
  commandType: string
  outcome: string
  summary: string
  createdAt: string
}

interface AuditRow {
  provider: string | null
  connection_id: string
  connection_name: string | null
  actor_id: number
  command_type: string
  outcome: string
  created_at: string
}

const COMMAND_SUMMARIES: Readonly<Record<string, string>> = {
  create_connection: '创建连接',
  create_candidate: '创建身份候选',
  begin_candidate_validation: '启动候选验证',
  mark_candidate_ready: '候选验证通过',
  activate_candidate: '启用候选版本',
  rollback_previous_version: '回滚上一生产版本',
  rollback_active_version: '回滚指定生产版本',
  disable_connection: '停用连接',
  set_runtime_policy: '更新运行策略',
  open_server_circuit: '自动暂停 Server',
  close_server_circuit: '恢复 Server',
  create_managed_source: '创建投放来源',
  disable_managed_source: '停用投放来源',
  save_privacy_policy: '更新地区策略',
}

export async function listAdminAttributionAudit(
  db: D1Database,
  input: AdminAttributionAuditQuery,
): Promise<AdminAttributionAuditView[]> {
  const query = normalizeQuery(input)
  const rows = await db.prepare(`
    SELECT
      connection.provider,
      audit.connection_id,
      connection.name AS connection_name,
      audit.actor_id,
      audit.command_type,
      audit.outcome,
      audit.created_at
    FROM attribution_audit_logs AS audit
    LEFT JOIN attribution_connections AS connection
      ON connection.id = audit.connection_id
    WHERE (? IS NULL OR date(
      datetime(audit.created_at, '+8 hours')
    ) >= ?)
      AND (? IS NULL OR date(
        datetime(audit.created_at, '+8 hours')
      ) <= ?)
      AND (? IS NULL OR connection.provider = ?)
      AND (? IS NULL OR audit.connection_id = ?)
    ORDER BY audit.created_at DESC, audit.id DESC
    LIMIT ?
  `).bind(
    query.dateFrom ?? null,
    query.dateFrom ?? null,
    query.dateTo ?? null,
    query.dateTo ?? null,
    query.provider ?? null,
    query.provider ?? null,
    query.connectionId ?? null,
    query.connectionId ?? null,
    query.limit,
  ).all<AuditRow>()

  return rows.results.map(row => ({
    provider: row.provider === null
      ? null
      : getProviderAdapter(row.provider).provider,
    connectionId: identifier(row.connection_id, true),
    connectionName: row.connection_name
      ?? (row.connection_id === 'global' ? '全局地区策略' : '系统'),
    actorId: actorId(row.actor_id),
    commandType: commandType(row.command_type),
    outcome: text(row.outcome),
    summary: COMMAND_SUMMARIES[row.command_type] ?? '执行系统命令',
    createdAt: timestamp(row.created_at),
  }))
}

function normalizeQuery(
  input: AdminAttributionAuditQuery,
): Required<Pick<AdminAttributionAuditQuery, 'limit'>>
  & Omit<AdminAttributionAuditQuery, 'limit'> {
  if (!input || typeof input !== 'object') throw invalid()
  const dateFrom = optionalDate(input.dateFrom)
  const dateTo = optionalDate(input.dateTo)
  if (dateFrom && dateTo && dateFrom > dateTo) throw invalid()
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw invalid()
  }
  return {
    dateFrom,
    dateTo,
    provider: input.provider === undefined
      ? undefined
      : getProviderAdapter(input.provider).provider,
    connectionId: input.connectionId === undefined
      ? undefined
      : identifier(input.connectionId, true),
    limit,
  }
}

function optionalDate(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid()
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    throw invalid()
  }
  return value
}

function identifier(value: unknown, allowGlobal = false): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9:_-]{1,240}$/.test(value)
    || (!allowGlobal && value === 'global')
  ) {
    throw invalid()
  }
  return value
}

function commandType(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[a-z0-9_]{1,120}$/.test(value)
  ) {
    throw invalid()
  }
  return value
}

function text(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 160
  ) {
    throw invalid()
  }
  return value
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > 64
    || !Number.isFinite(Date.parse(value))
  ) {
    throw invalid()
  }
  return value
}

function actorId(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalid()
  return parsed
}

function invalid(): AttributionDomainError {
  return new AttributionDomainError(
    'ATTRIBUTION_CONNECTION_SNAPSHOT_INVALID',
  )
}
