-- ADM-PER-04：ZIP 导入原包、逐项状态与可恢复执行。
-- 本 migration 只定义数据结构；实际执行统一留到全部开发结束后的 migration 阶段。

ALTER TABLE import_jobs ADD COLUMN source_name TEXT;
ALTER TABLE import_jobs ADD COLUMN package_size INTEGER;
ALTER TABLE import_jobs ADD COLUMN package_etag TEXT;
ALTER TABLE import_jobs ADD COLUMN multipart_upload_id TEXT;
ALTER TABLE import_jobs ADD COLUMN upload_session_id TEXT;
ALTER TABLE import_jobs ADD COLUMN upload_part_size INTEGER;
ALTER TABLE import_jobs ADD COLUMN upload_part_count INTEGER;
ALTER TABLE import_jobs ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'gallery_zip_v1';
ALTER TABLE import_jobs ADD COLUMN mapping_version TEXT NOT NULL DEFAULT 'gallery_mapping_v1';
ALTER TABLE import_jobs ADD COLUMN uploaded_at TEXT;
ALTER TABLE import_jobs ADD COLUMN started_at TEXT;
ALTER TABLE import_jobs ADD COLUMN updated_at TEXT;
ALTER TABLE import_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN processing_requested_by INTEGER REFERENCES users(id);
ALTER TABLE import_jobs ADD COLUMN last_error_code TEXT;
ALTER TABLE import_jobs ADD COLUMN last_error_message TEXT;

UPDATE import_jobs
SET updated_at = COALESCE(completed_at, created_at)
WHERE updated_at IS NULL;

CREATE TABLE import_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  folder TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  stage TEXT NOT NULL DEFAULT 'preflight'
    CHECK (stage IN ('preflight', 'content', 'media', 'commit', 'completed')),
  gallery_id TEXT REFERENCES galleries(id),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, folder)
);

CREATE TABLE import_job_upload_parts (
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  upload_session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  part_size INTEGER NOT NULL CHECK (part_size > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, upload_session_id, part_number)
);

CREATE INDEX idx_import_jobs_status_updated
  ON import_jobs(status, updated_at DESC);

CREATE INDEX idx_import_job_items_job_status
  ON import_job_items(job_id, status, folder);

CREATE INDEX idx_import_job_items_gallery
  ON import_job_items(gallery_id)
  WHERE gallery_id IS NOT NULL;
