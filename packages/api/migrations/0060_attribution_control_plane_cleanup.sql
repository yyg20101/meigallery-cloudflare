-- 独立 Attribution Worker 已取消，API Worker 是唯一归因运行时。
-- 仅删除废弃控制面对象；事实、投递、加密 Outbox、回执和质量数据全部保留。

DROP TRIGGER IF EXISTS attribution_runtime_fact_insert_guard;
DROP TRIGGER IF EXISTS attribution_runtime_connection_insert_guard;
DROP TRIGGER IF EXISTS attribution_runtime_connection_update_guard;
DROP TRIGGER IF EXISTS attribution_runtime_connection_delete_guard;
DROP TRIGGER IF EXISTS attribution_runtime_binding_insert_guard;
DROP TRIGGER IF EXISTS attribution_runtime_binding_update_guard;
DROP TRIGGER IF EXISTS attribution_runtime_binding_delete_guard;
DROP TRIGGER IF EXISTS attribution_runtime_credential_insert_guard;
DROP TRIGGER IF EXISTS attribution_runtime_credential_update_guard;
DROP TRIGGER IF EXISTS attribution_runtime_credential_delete_guard;
DROP TRIGGER IF EXISTS attribution_runtime_privacy_insert_guard;
DROP TRIGGER IF EXISTS attribution_runtime_privacy_update_guard;
DROP TRIGGER IF EXISTS attribution_runtime_privacy_delete_guard;
DROP TRIGGER IF EXISTS attribution_runtime_ad_source_insert_guard;
DROP TRIGGER IF EXISTS attribution_runtime_ad_source_update_guard;
DROP TRIGGER IF EXISTS attribution_runtime_ad_source_delete_guard;

DROP INDEX IF EXISTS idx_attribution_business_outbox_runtime_due;
DROP INDEX IF EXISTS idx_attribution_business_outbox_due;
DROP INDEX IF EXISTS idx_attribution_business_outbox_completed;
DROP TABLE IF EXISTS attribution_business_outbox;
DROP TABLE IF EXISTS attribution_runtime_cutover_commands;
DROP TABLE IF EXISTS attribution_runtime_cutover;

DROP INDEX IF EXISTS idx_attribution_verifications_connection;
DROP TABLE IF EXISTS attribution_verifications;

-- 旧 mode/rollout 列暂留在存储层以避免重建被多张事实表引用的父表，
-- 运行时代码不再读取这些列；统一归零可防止旧数据误导人工排查。
UPDATE attribution_platform_connections
SET
  mode = CASE WHEN enabled = 1 THEN 'production' ELSE 'disabled' END,
  rollout_target_percentage = 0,
  rollout_effective_percentage = 0;
