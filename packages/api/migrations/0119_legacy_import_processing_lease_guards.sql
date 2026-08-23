-- WordPress 旧站迁移处理租约约束。
-- 发布顺序：先执行 0116 扩展列，再发布已写入租约的兼容代码，最后单独执行本 migration。

CREATE TRIGGER IF NOT EXISTS import_jobs_legacy_processing_lease_insert_guard
BEFORE INSERT ON import_jobs
WHEN (
    NEW.type = 'legacy'
    AND (
      (
        NEW.status = 'processing'
        AND (
          NEW.legacy_processing_token IS NULL
          OR NEW.legacy_processing_expires_at IS NULL
        )
      )
      OR (
        NEW.status <> 'processing'
        AND (
          NEW.legacy_processing_token IS NOT NULL
          OR NEW.legacy_processing_expires_at IS NOT NULL
        )
      )
    )
  )
  OR (
    NEW.type <> 'legacy'
    AND (
      NEW.legacy_processing_token IS NOT NULL
      OR NEW.legacy_processing_expires_at IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy import processing lease invalid');
END;

CREATE TRIGGER IF NOT EXISTS import_jobs_legacy_processing_lease_update_guard
BEFORE UPDATE OF type, status, legacy_processing_token, legacy_processing_expires_at
ON import_jobs
WHEN (
    NEW.type = 'legacy'
    AND (
      (
        NEW.status = 'processing'
        AND (
          NEW.legacy_processing_token IS NULL
          OR NEW.legacy_processing_expires_at IS NULL
        )
      )
      OR (
        NEW.status <> 'processing'
        AND (
          NEW.legacy_processing_token IS NOT NULL
          OR NEW.legacy_processing_expires_at IS NOT NULL
        )
      )
    )
  )
  OR (
    NEW.type <> 'legacy'
    AND (
      NEW.legacy_processing_token IS NOT NULL
      OR NEW.legacy_processing_expires_at IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy import processing lease invalid');
END;
