-- WordPress 旧站迁移来源快照、审核证据、状态约束与运行查询索引。
-- 本 migration 只定义数据结构；实际执行统一留到全部开发结束后的 migration 阶段。

ALTER TABLE legacy_import_items ADD COLUMN source_snapshot_json TEXT
  CHECK (
    source_snapshot_json IS NULL
    OR (
      json_valid(source_snapshot_json)
      AND length(CAST(source_snapshot_json AS BLOB)) <= 524288
    )
  );
ALTER TABLE legacy_import_items ADD COLUMN review_note TEXT
  CHECK (review_note IS NULL OR length(review_note) <= 500);
ALTER TABLE legacy_import_items ADD COLUMN reviewed_by INTEGER REFERENCES users(id);
ALTER TABLE legacy_import_items ADD COLUMN reviewed_at TEXT;
ALTER TABLE legacy_import_items ADD COLUMN error_code TEXT
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100);
ALTER TABLE legacy_import_items ADD COLUMN error_message TEXT
  CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 500);
ALTER TABLE import_jobs ADD COLUMN legacy_processing_token TEXT
  CHECK (legacy_processing_token IS NULL OR length(legacy_processing_token) = 36);
ALTER TABLE import_jobs ADD COLUMN legacy_processing_expires_at TEXT
  CHECK (
    legacy_processing_expires_at IS NULL
    OR julianday(legacy_processing_expires_at) IS NOT NULL
  );

-- 只从既有追加式审核日志补齐历史终态证据；找不到证据的行保持 NULL，供后续人工前向修复。
UPDATE legacy_import_items
SET reviewed_by = (
      SELECT audit.admin_id
      FROM admin_audit_logs audit
      WHERE audit.action = 'review_legacy_import_item'
        AND audit.target_type = 'legacy_import_item'
        AND audit.target_id = legacy_import_items.id
      ORDER BY audit.created_at DESC, audit.id DESC
      LIMIT 1
    ),
    reviewed_at = (
      SELECT audit.created_at
      FROM admin_audit_logs audit
      WHERE audit.action = 'review_legacy_import_item'
        AND audit.target_type = 'legacy_import_item'
        AND audit.target_id = legacy_import_items.id
      ORDER BY audit.created_at DESC, audit.id DESC
      LIMIT 1
    ),
    review_note = substr((
      SELECT CASE
        WHEN json_valid(audit.after_value)
        THEN json_extract(audit.after_value, '$.note')
        ELSE NULL
      END
      FROM admin_audit_logs audit
      WHERE audit.action = 'review_legacy_import_item'
        AND audit.target_type = 'legacy_import_item'
        AND audit.target_id = legacy_import_items.id
      ORDER BY audit.created_at DESC, audit.id DESC
      LIMIT 1
    ), 1, 500)
WHERE review_status IN ('approved', 'rejected')
  AND EXISTS (
    SELECT 1
    FROM admin_audit_logs audit
    WHERE audit.action = 'review_legacy_import_item'
      AND audit.target_type = 'legacy_import_item'
      AND audit.target_id = legacy_import_items.id
  );

CREATE INDEX IF NOT EXISTS idx_import_jobs_legacy_source_status
  ON import_jobs(type, source_key, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_jobs_legacy_processing_lease
  ON import_jobs(type, status, legacy_processing_expires_at, id)
  WHERE type = 'legacy' AND status = 'processing';

CREATE INDEX IF NOT EXISTS idx_legacy_items_job_created
  ON legacy_import_items(job_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_legacy_items_source_post_status
  ON legacy_import_items(source_id, legacy_post_id, status);

CREATE INDEX IF NOT EXISTS idx_legacy_items_gallery_status_job
  ON legacy_import_items(gallery_id, status, job_id)
  WHERE gallery_id IS NOT NULL;

CREATE TRIGGER legacy_import_items_status_insert_guard
BEFORE INSERT ON legacy_import_items
WHEN NEW.status NOT IN ('pending', 'imported', 'failed')
  OR NEW.review_status NOT IN ('pending', 'approved', 'rejected')
  OR (NEW.status <> 'imported' AND NEW.review_status <> 'pending')
  OR (
    NEW.status IN ('imported', 'failed')
    AND NEW.source_snapshot_json IS NULL
  )
  OR (
    NEW.status = 'imported'
    AND (
      NEW.gallery_id IS NULL
      OR NEW.error_code IS NOT NULL
      OR NEW.error_message IS NOT NULL
    )
  )
  OR (
    NEW.status = 'failed'
    AND (
      NEW.gallery_id IS NOT NULL
      OR NEW.error_code IS NULL
      OR NEW.error_message IS NULL
    )
  )
  OR (
    NEW.review_status IN ('approved', 'rejected')
    AND (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy import item status invalid');
END;

-- 历史行维持兼容；任何新状态推进或失败证据补录都必须收敛成完整终态事实。
CREATE TRIGGER legacy_import_items_terminal_fact_update_guard
BEFORE UPDATE OF status, gallery_id, source_snapshot_json, error_code, error_message
ON legacy_import_items
WHEN (
    NEW.status IN ('imported', 'failed')
    AND NEW.source_snapshot_json IS NULL
  )
  OR (
    NEW.status = 'imported'
    AND (
      NEW.gallery_id IS NULL
      OR NEW.error_code IS NOT NULL
      OR NEW.error_message IS NOT NULL
    )
  )
  OR (
    NEW.status = 'failed'
    AND (
      NEW.gallery_id IS NOT NULL
      OR NEW.error_code IS NULL
      OR NEW.error_message IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy import terminal fact incomplete');
END;

CREATE TRIGGER legacy_import_items_terminal_status_immutable
BEFORE UPDATE OF status ON legacy_import_items
WHEN OLD.status IN ('imported', 'failed')
  AND NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'legacy import item status is immutable');
END;

CREATE TRIGGER legacy_import_items_status_update_guard
BEFORE UPDATE OF status, review_status ON legacy_import_items
WHEN NEW.status NOT IN ('pending', 'imported', 'failed')
  OR NEW.review_status NOT IN ('pending', 'approved', 'rejected')
  OR (NEW.status <> 'imported' AND NEW.review_status <> 'pending')
BEGIN
  SELECT RAISE(ABORT, 'legacy import item status invalid');
END;

CREATE TRIGGER legacy_import_items_review_completion_guard
BEFORE UPDATE OF review_status ON legacy_import_items
WHEN NEW.review_status IN ('approved', 'rejected')
  AND (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'legacy import review evidence required');
END;

CREATE TRIGGER legacy_import_items_review_status_immutable
BEFORE UPDATE OF review_status ON legacy_import_items
WHEN OLD.review_status IN ('approved', 'rejected')
  AND NEW.review_status IS NOT OLD.review_status
BEGIN
  SELECT RAISE(ABORT, 'legacy import review is immutable');
END;

-- 历史终态可能没有结构化审核证据，允许仅把 NULL 前向补齐一次；已有值不可改写。
CREATE TRIGGER legacy_import_items_review_evidence_immutable
BEFORE UPDATE OF review_note, reviewed_by, reviewed_at ON legacy_import_items
WHEN OLD.review_status IN ('approved', 'rejected')
  AND (
    (OLD.review_note IS NOT NULL AND NEW.review_note IS NOT OLD.review_note)
    OR (OLD.reviewed_by IS NOT NULL AND NEW.reviewed_by IS NOT OLD.reviewed_by)
    OR (OLD.reviewed_at IS NOT NULL AND NEW.reviewed_at IS NOT OLD.reviewed_at)
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy import review evidence is immutable');
END;

CREATE TRIGGER legacy_import_items_source_snapshot_immutable
BEFORE UPDATE OF source_snapshot_json ON legacy_import_items
WHEN OLD.source_snapshot_json IS NOT NULL
  AND NEW.source_snapshot_json IS NOT OLD.source_snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'legacy import source snapshot is immutable');
END;

CREATE TRIGGER legacy_import_items_failure_evidence_immutable
BEFORE UPDATE OF error_code, error_message ON legacy_import_items
WHEN OLD.status = 'failed'
  AND (
    (OLD.error_code IS NOT NULL AND NEW.error_code IS NOT OLD.error_code)
    OR (OLD.error_message IS NOT NULL AND NEW.error_message IS NOT OLD.error_message)
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy import failure evidence is immutable');
END;
