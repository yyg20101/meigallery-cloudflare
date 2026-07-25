-- 归因运行时所有权只允许单向 old -> draining -> new。
-- epoch 用于阻断切换瞬间仍持有旧状态的并发请求。
CREATE TABLE attribution_runtime_cutover (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  owner TEXT NOT NULL CHECK (owner IN ('old', 'draining', 'new')),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  changed_by INTEGER,
  changed_at TEXT NOT NULL CHECK (julianday(changed_at) IS NOT NULL)
);

INSERT INTO attribution_runtime_cutover (
  id,
  owner,
  owner_epoch,
  changed_by,
  changed_at
) VALUES (
  'global',
  'old',
  1,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE attribution_runtime_cutover_commands (
  idempotency_key TEXT PRIMARY KEY
    CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  command_type TEXT NOT NULL CHECK (
    command_type IN (
      'attribution_runtime_owner_transition',
      'attribution_runtime_owner_restore'
    )
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

-- 注册业务事件与用户事务原子记录实际 owner，避免切换竞态造成双写。
ALTER TABLE attribution_business_outbox
  ADD COLUMN routing_owner TEXT NOT NULL DEFAULT 'old'
  CHECK (routing_owner IN ('old', 'draining', 'new'));

ALTER TABLE attribution_business_outbox
  ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (owner_epoch >= 1);

CREATE INDEX idx_attribution_business_outbox_runtime_due
  ON attribution_business_outbox(
    routing_owner,
    status,
    next_attempt_at,
    created_at,
    id
  )
  WHERE status IN ('pending', 'dispatching')
    AND routing_owner IN ('draining', 'new');

-- draining 后禁止新增旧活动事实；允许把切换前注册补偿为历史事实。
-- new 后旧事实表完全只读。
CREATE TRIGGER attribution_runtime_fact_insert_guard
BEFORE INSERT ON attribution_conversion_facts
WHEN (
  NEW.fact_origin = 'live'
  AND (
    SELECT owner
    FROM attribution_runtime_cutover
    WHERE id = 'global'
  ) <> 'old'
)
OR (
  NEW.fact_origin = 'historical_backfill'
  AND (
    SELECT owner
    FROM attribution_runtime_cutover
    WHERE id = 'global'
  ) = 'new'
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_FACT_WRITE_FORBIDDEN');
END;

-- 旧连接、映射、凭证和地区策略在 draining/new 下冻结。
CREATE TRIGGER attribution_runtime_connection_insert_guard
BEFORE INSERT ON attribution_platform_connections
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_connection_update_guard
BEFORE UPDATE ON attribution_platform_connections
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_connection_delete_guard
BEFORE DELETE ON attribution_platform_connections
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_binding_insert_guard
BEFORE INSERT ON attribution_event_bindings
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_binding_update_guard
BEFORE UPDATE ON attribution_event_bindings
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_binding_delete_guard
BEFORE DELETE ON attribution_event_bindings
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_credential_insert_guard
BEFORE INSERT ON attribution_credentials
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_credential_update_guard
BEFORE UPDATE ON attribution_credentials
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_credential_delete_guard
BEFORE DELETE ON attribution_credentials
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_privacy_insert_guard
BEFORE INSERT ON attribution_privacy_policy
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_privacy_update_guard
BEFORE UPDATE ON attribution_privacy_policy
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_privacy_delete_guard
BEFORE DELETE ON attribution_privacy_policy
WHEN (
  SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

-- 仅冻结广告投放来源，不影响站内自然来源和分析配置。
CREATE TRIGGER attribution_runtime_ad_source_insert_guard
BEFORE INSERT ON analytics_tracking_sources
WHEN NEW.channel = 'ad'
  AND NEW.ad_provider IN ('meta', 'tiktok', 'google')
  AND (
    SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
  ) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_ad_source_update_guard
BEFORE UPDATE ON analytics_tracking_sources
WHEN (
    (
      OLD.channel = 'ad'
      AND OLD.ad_provider IN ('meta', 'tiktok', 'google')
    )
    OR (
      NEW.channel = 'ad'
      AND NEW.ad_provider IN ('meta', 'tiktok', 'google')
    )
  )
  AND (
    SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
  ) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;

CREATE TRIGGER attribution_runtime_ad_source_delete_guard
BEFORE DELETE ON analytics_tracking_sources
WHEN OLD.channel = 'ad'
  AND OLD.ad_provider IN ('meta', 'tiktok', 'google')
  AND (
    SELECT owner FROM attribution_runtime_cutover WHERE id = 'global'
  ) <> 'old'
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
END;
