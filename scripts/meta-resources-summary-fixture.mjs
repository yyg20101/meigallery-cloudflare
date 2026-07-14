export const PRODUCTION_POST_DEPLOY_META_RESOURCES_FIELDS = [
  'schemaVersion', 'verificationPhase', 'bootstrapReady', 'liveAttestation',
  'migrationsReady', 'd1Ready', 'r2Ready', 'queuesReady', 'secretsReady',
  'migrationsCurrent', 'migrationsApplied', 'connectionVerified', 'capiEnabled',
  'initialMetaRollout', 'noOpenCriticalIncident', 'initialRolloutZero',
  'secureOutboxReady', 'previousKeyReferencesExplainable', 'rolloutZero',
  'environmentIsolation',
]

export const META_RESOURCES_ISOLATION_FIELDS = [
  'd1', 'r2', 'queue', 'dlq', 'pixel', 'token', 'dataKey',
]

export function createProductionPostDeployMetaResourcesSummary(overrides = {}) {
  return {
    schemaVersion: 3,
    verificationPhase: 'post-deploy',
    bootstrapReady: false,
    liveAttestation: true,
    migrationsReady: true,
    d1Ready: true,
    r2Ready: true,
    queuesReady: true,
    secretsReady: true,
    migrationsCurrent: true,
    migrationsApplied: true,
    connectionVerified: false,
    capiEnabled: false,
    initialMetaRollout: false,
    noOpenCriticalIncident: true,
    initialRolloutZero: true,
    secureOutboxReady: true,
    previousKeyReferencesExplainable: true,
    rolloutZero: true,
    environmentIsolation: Object.fromEntries(META_RESOURCES_ISOLATION_FIELDS.map(field => [field, true])),
    ...overrides,
  }
}
