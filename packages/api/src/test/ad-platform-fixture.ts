import type { AdAttributionProvider } from '@meigallery/shared'
import { getAdPlatformDefinition } from '../services/ad-platform/registry'

type FixtureInput = {
  provider: AdAttributionProvider
  publicConfig: Record<string, string>
  mode?: 'disabled' | 'test' | 'production'
  enabled?: boolean
  browserEnabled?: boolean
  serverEnabled?: boolean
  rolloutTargetPercentage?: number
  rolloutEffectivePercentage?: number
  connectionRevision?: string
  credentialRevision?: string
}

export function attributionConnectionSnapshotRows(input: FixtureInput) {
  const definition = getAdPlatformDefinition(input.provider)
  if (!definition) throw new Error('测试平台配置无效')
  const connectionId = `conn_${input.provider}`
  const connectionRevision = input.connectionRevision ?? '1'.repeat(32)
  const credentialRevision = input.credentialRevision ?? '2'.repeat(32)
  return (['Contact', 'CompleteRegistration'] as const).map((canonicalEvent) => {
    const descriptor = definition.describeEvent({ canonicalEvent })
    if (!descriptor) throw new Error('测试事件配置无效')
    return {
      connection_id: connectionId,
      provider: input.provider,
      enabled: input.enabled === false ? 0 : 1,
      mode: input.mode ?? 'production',
      browser_enabled: input.browserEnabled === false ? 0 : 1,
      server_enabled: input.serverEnabled === false ? 0 : 1,
      public_config_json: JSON.stringify(input.publicConfig),
      rollout_target_percentage: input.rolloutTargetPercentage ?? 100,
      rollout_effective_percentage: input.rolloutEffectivePercentage ?? 100,
      connection_revision: connectionRevision,
      credential_revision: credentialRevision,
      binding_id: `binding_${input.provider}_${canonicalEvent.toLowerCase()}`,
      canonical_event: canonicalEvent,
      binding_provider: input.provider,
      binding_enabled: 1,
      browser_destination: descriptor.browserDestination,
      server_destination: descriptor.serverDestination,
      mapping_revision: connectionRevision,
      credential_id: `credential_${input.provider}`,
      credential_provider: input.provider,
      credential_type: definition.credentialSchema.type,
      schema_version: definition.credentialSchema.version,
      credential_row_revision: credentialRevision,
      key_id: 'a'.repeat(16),
    }
  })
}

export async function seedAttributionConnection(db: D1Database, input: FixtureInput) {
  const rows = attributionConnectionSnapshotRows(input)
  const first = rows[0]!
  await db.batch([
    db.prepare('DELETE FROM attribution_event_bindings WHERE connection_id = ?').bind(first.connection_id),
    db.prepare('DELETE FROM attribution_credentials WHERE connection_id = ?').bind(first.connection_id),
    db.prepare('DELETE FROM attribution_platform_connections WHERE provider = ?').bind(first.provider),
    db.prepare(`
      INSERT INTO attribution_platform_connections (
        id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
        rollout_target_percentage, rollout_effective_percentage, connection_revision, credential_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      first.connection_id,
      first.provider,
      first.enabled,
      first.mode,
      first.browser_enabled,
      first.server_enabled,
      first.public_config_json,
      first.rollout_target_percentage,
      first.rollout_effective_percentage,
      first.connection_revision,
      first.credential_revision,
    ),
    ...rows.map(row => db.prepare(`
      INSERT INTO attribution_event_bindings (
        id, connection_id, provider, canonical_event, enabled,
        browser_destination, server_destination, mapping_revision, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
    `).bind(
      row.binding_id,
      row.connection_id,
      row.binding_provider,
      row.canonical_event,
      row.binding_enabled,
      row.browser_destination,
      row.server_destination,
      row.mapping_revision,
    )),
    db.prepare(`
      INSERT INTO attribution_credentials (
        id, connection_id, provider, credential_type, schema_version, key_id,
        iv, ciphertext, tag, fingerprint, credential_revision
      ) VALUES (?, ?, ?, ?, ?, ?, 'test-iv', 'test-ciphertext', 'test-tag', 'test-fingerprint', ?)
    `).bind(
      first.credential_id,
      first.connection_id,
      first.credential_provider,
      first.credential_type,
      first.schema_version,
      first.key_id,
      first.credential_row_revision,
    ),
  ])
}
