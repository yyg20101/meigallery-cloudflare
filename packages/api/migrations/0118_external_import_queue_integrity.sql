-- External Import-2：Telegram 导入队列租约、可恢复执行与处理中目标定位。
-- 本 migration 仅扩展兼容列；必须先应用，再发布读取这些列的新运行时。

ALTER TABLE external_import_records ADD COLUMN processing_token TEXT;
ALTER TABLE external_import_records ADD COLUMN processing_started_at TEXT;
ALTER TABLE external_import_records ADD COLUMN processing_heartbeat_at TEXT;
ALTER TABLE external_import_records ADD COLUMN processing_lease_expires_at TEXT;
ALTER TABLE external_import_records ADD COLUMN processing_target_id TEXT;

CREATE INDEX IF NOT EXISTS idx_external_import_records_processing_lease
  ON external_import_records(status, processing_lease_expires_at, created_at);
