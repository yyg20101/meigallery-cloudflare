export interface D1Usage {
  rowsRead: number
  rowsWritten: number
  durationMs: number
}

export interface D1Budget {
  rowsRead?: number
  rowsWritten?: number
  durationMs?: number
}

export interface D1BudgetCheck {
  ok: boolean
  violations: string[]
}

export function readD1UsageMeta(result: unknown): D1Usage {
  const meta = readMeta(result)
  return {
    rowsRead: readNumber(meta, ['rows_read', 'rowsRead', 'rowsReadCount']),
    rowsWritten: readNumber(meta, ['rows_written', 'rowsWritten', 'rowsWrittenCount', 'changes']),
    durationMs: readNumber(meta, ['duration', 'duration_ms', 'durationMs']),
  }
}

export function mergeD1Usage(...items: D1Usage[]): D1Usage {
  return items.reduce<D1Usage>((total, item) => ({
    rowsRead: total.rowsRead + item.rowsRead,
    rowsWritten: total.rowsWritten + item.rowsWritten,
    durationMs: Math.max(total.durationMs, item.durationMs),
  }), { rowsRead: 0, rowsWritten: 0, durationMs: 0 })
}

export function assertD1Budget(usage: D1Usage, budget: D1Budget): D1BudgetCheck {
  const violations: string[] = []
  if (budget.rowsRead !== undefined && usage.rowsRead > budget.rowsRead) {
    violations.push(`D1 rows read 超预算: ${usage.rowsRead}/${budget.rowsRead}`)
  }
  if (budget.rowsWritten !== undefined && usage.rowsWritten > budget.rowsWritten) {
    violations.push(`D1 rows written 超预算: ${usage.rowsWritten}/${budget.rowsWritten}`)
  }
  if (budget.durationMs !== undefined && usage.durationMs > budget.durationMs) {
    violations.push(`D1 查询耗时超预算: ${usage.durationMs}/${budget.durationMs}ms`)
  }
  return { ok: violations.length === 0, violations }
}

function readMeta(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {}
  const meta = (result as { meta?: unknown }).meta
  if (meta && typeof meta === 'object') return meta as Record<string, unknown>
  return {}
}

function readNumber(meta: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = meta[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}
