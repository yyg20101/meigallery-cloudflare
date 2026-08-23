-- Message-9：站内通知内容到期生命周期约束。
--
-- 只增加新投递的时间完整性、到期/legacy 清理索引和保留边界不可变约束：
-- - 不回填既有通知 expires_at，不删除任何业务数据；
-- - 不修改通知策略、模板、Outbox、偏好或运行时 capability；
-- - OQ-020 未关闭且 purge_enabled=0 时，运行时清理器继续安全跳过。

CREATE INDEX idx_app_notifications_expiry
  ON app_notifications (expires_at, id)
  WHERE expires_at IS NOT NULL;

CREATE INDEX idx_app_notifications_legacy_retention
  ON app_notifications (created_at, id)
  WHERE expires_at IS NULL;

CREATE TRIGGER app_notifications_expiry_insert_guard
BEFORE INSERT ON app_notifications
WHEN NEW.expires_at IS NOT NULL AND (
  NEW.expires_at NOT GLOB '????-??-??T??:??:??.???Z'
  OR julianday(NEW.expires_at) IS NULL
  OR julianday(NEW.expires_at) <= julianday(NEW.created_at)
)
BEGIN
  SELECT RAISE(ABORT, 'app notification expiry invalid');
END;

CREATE TRIGGER app_notifications_retention_boundary_immutable
BEFORE UPDATE OF created_at, expires_at ON app_notifications
WHEN NEW.created_at <> OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'app notification retention boundary is immutable');
END;
