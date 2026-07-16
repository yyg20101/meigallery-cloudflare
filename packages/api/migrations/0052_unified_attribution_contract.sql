PRAGMA defer_foreign_keys = true;

-- Contract 只允许在业务事实完整回填、旧 Server 投递静止且旧 Outbox 已清空后执行。
CREATE TABLE attribution_contract_guard (
  passed INTEGER NOT NULL CHECK (passed = 1)
);

INSERT INTO attribution_contract_guard (passed)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1
    FROM analytics_conversion_actions AS action
    LEFT JOIN attribution_conversion_facts AS fact
      ON fact.dedupe_key = action.dedupe_key
    WHERE action.action_type IN ('contact', 'complete_registration')
      AND (
        fact.id IS NULL
        OR fact.canonical_event <> CASE action.action_type
          WHEN 'contact' THEN 'Contact'
          WHEN 'complete_registration' THEN 'CompleteRegistration'
        END
        OR COALESCE(fact.attribution_provider, '') <> CASE
          WHEN action.attribution_provider IN ('meta', 'tiktok', 'google')
            THEN action.attribution_provider
          ELSE ''
        END
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM analytics_conversion_deliveries
    WHERE transport = 'server'
      AND (
        status IN ('pending', 'attempted', 'failed')
        OR delivery_lease_token <> ''
      )
  )
  AND NOT EXISTS (SELECT 1 FROM meta_capi_secure_outbox)
  AND NOT EXISTS (SELECT 1 FROM ad_platform_secure_outbox)
  AND NOT EXISTS (
    SELECT 1
    FROM meta_dataset_quality_snapshots
    WHERE NOT EXISTS (
      SELECT 1 FROM attribution_platform_connections WHERE provider = 'meta'
    )
  )
THEN 1 ELSE 0 END;

DROP TABLE attribution_contract_guard;

-- Dataset Quality 是有长期分析价值的历史，迁入通用质量表后再删除旧技术表。
INSERT OR IGNORE INTO attribution_quality_snapshots (
  id,
  connection_id,
  provider,
  canonical_event,
  metric_key,
  metric_value,
  collection_status,
  error_category,
  collected_at,
  created_at
)
SELECT
  snapshot.id,
  connection.id,
  'meta',
  snapshot.event_name,
  snapshot.metric_key,
  CASE
    WHEN snapshot.metric_value IS NULL THEN NULL
    ELSE CAST(snapshot.metric_value AS TEXT)
  END,
  snapshot.collection_status,
  snapshot.error_category,
  snapshot.collected_at,
  snapshot.created_at
FROM meta_dataset_quality_snapshots AS snapshot
JOIN attribution_platform_connections AS connection ON connection.provider = 'meta'
WHERE snapshot.event_name IN ('Contact', 'CompleteRegistration');

DROP TRIGGER IF EXISTS trg_0049_bridge_meta_outbox_legacy_insert;
DROP TRIGGER IF EXISTS trg_0049_bridge_meta_outbox_legacy_update;
DROP TRIGGER IF EXISTS trg_0049_bridge_meta_outbox_legacy_delete;
DROP TRIGGER IF EXISTS trg_0049_bridge_meta_outbox_current_insert;
DROP TRIGGER IF EXISTS trg_0049_bridge_meta_outbox_current_update;
DROP TRIGGER IF EXISTS trg_0049_bridge_meta_outbox_current_delete;
DROP TRIGGER IF EXISTS trg_0049_bridge_user_identity_insert;
DROP TRIGGER IF EXISTS trg_0049_bridge_user_identity_update;

DROP TABLE meta_capi_secure_outbox;
DROP TABLE ad_platform_secure_outbox;
DROP TABLE analytics_conversion_deliveries;
DROP TABLE analytics_conversion_dedupe_claims;
DROP TABLE analytics_conversion_delivery_daily;
DROP TABLE analytics_conversion_daily;
DROP TABLE analytics_conversion_actions;
DROP TABLE analytics_release_verifications;

DROP TABLE meta_capi_incidents;
DROP TABLE meta_connection_verifications;
DROP TABLE meta_dataset_quality_snapshots;
DROP TABLE meta_live_challenges;
DROP TABLE meta_resource_attestation_tickets;
DROP TABLE tiktok_connection_verifications;
DROP TABLE ad_platform_connections;

DROP INDEX IF EXISTS idx_users_meta_external_id;
ALTER TABLE users DROP COLUMN meta_external_id;

PRAGMA defer_foreign_keys = false;
