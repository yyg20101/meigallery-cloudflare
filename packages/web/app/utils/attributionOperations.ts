import type {
  AttributionOperationMetrics,
  AttributionOperationView,
} from '~/types/attribution-admin'

export function emptyAttributionOperationMetrics():
AttributionOperationMetrics {
  return {
    contactCount: 0,
    completeRegistrationCount: 0,
    factCount: 0,
    attributedFactCount: 0,
    unattributedFactCount: 0,
    browserAttempted: 0,
    serverPlanned: 0,
    serverQueued: 0,
    serverProcessed: 0,
    serverRejected: 0,
    serverDeadLetter: 0,
  }
}

export function aggregateAttributionOperations(
  rows: readonly AttributionOperationView[],
): AttributionOperationMetrics {
  return rows.reduce((total, row) => {
    total.contactCount += row.contactCount
    total.completeRegistrationCount += row.completeRegistrationCount
    total.factCount += row.factCount
    total.attributedFactCount += row.attributedFactCount
    total.unattributedFactCount += row.unattributedFactCount
    total.browserAttempted += row.browserAttempted
    total.serverPlanned += row.serverPlanned
    total.serverQueued += row.serverQueued
    total.serverProcessed += row.serverProcessed
    total.serverRejected += row.serverRejected
    total.serverDeadLetter += row.serverDeadLetter
    return total
  }, emptyAttributionOperationMetrics())
}

export function attributionOperationTrendRows(
  rows: readonly AttributionOperationView[],
) {
  const dates = new Map<string, AttributionOperationMetrics>()
  for (const row of rows) {
    const current = dates.get(row.date)
      ?? emptyAttributionOperationMetrics()
    current.contactCount += row.contactCount
    current.completeRegistrationCount += row.completeRegistrationCount
    current.factCount += row.factCount
    current.attributedFactCount += row.attributedFactCount
    current.unattributedFactCount += row.unattributedFactCount
    current.browserAttempted += row.browserAttempted
    current.serverPlanned += row.serverPlanned
    current.serverQueued += row.serverQueued
    current.serverProcessed += row.serverProcessed
    current.serverRejected += row.serverRejected
    current.serverDeadLetter += row.serverDeadLetter
    dates.set(row.date, current)
  }
  return [...dates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, metrics]) => ({
      date,
      business: {
        contactCount: metrics.contactCount,
        completeRegistrationCount:
          metrics.completeRegistrationCount,
        factCount: metrics.factCount,
        attributedFactCount: metrics.attributedFactCount,
        unattributedFactCount: metrics.unattributedFactCount,
      },
      delivery: {
        browserAttempted: metrics.browserAttempted,
        serverPlanned: metrics.serverPlanned,
        serverQueued: metrics.serverQueued,
        serverProcessed: metrics.serverProcessed,
        serverRejected: metrics.serverRejected,
        serverDeadLetter: metrics.serverDeadLetter,
      },
    }))
}
