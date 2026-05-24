-- 真实案例表从 testimonial_* 命名切换为 cases 命名
PRAGMA foreign_keys = OFF;

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body_md TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  featured INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('draft', 'published'))
);

CREATE TABLE case_images (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  alt_text TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO cases (
  id,
  title,
  slug,
  summary,
  body_md,
  status,
  featured,
  sort_order,
  seo_title,
  seo_description,
  created_by,
  updated_by,
  published_at,
  created_at,
  updated_at
)
SELECT
  id,
  title,
  slug,
  summary,
  body_md,
  status,
  featured,
  sort_order,
  seo_title,
  seo_description,
  created_by,
  updated_by,
  published_at,
  created_at,
  updated_at
FROM testimonial_cases;

INSERT INTO case_images (
  id,
  case_id,
  r2_key,
  alt_text,
  mime_type,
  file_size,
  width,
  height,
  sort_order,
  created_at
)
SELECT
  id,
  case_id,
  CASE
    WHEN substr(r2_key, 1, length('testimonials/')) = 'testimonials/'
    THEN 'cases/' || substr(r2_key, length('testimonials/') + 1)
    ELSE r2_key
  END,
  alt_text,
  mime_type,
  file_size,
  width,
  height,
  sort_order,
  created_at
FROM testimonial_case_images;

CREATE INDEX idx_cases_public
  ON cases(status, featured, sort_order, published_at);
CREATE INDEX idx_case_images_case
  ON case_images(case_id, sort_order);

CREATE TABLE external_import_records_new (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES import_api_tokens(id),
  source_bot_key TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  media_group_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_media_fetch',
  metadata_json TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_retry_at TEXT,
  error_json TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (source IN ('telegram')),
  CHECK (target_type IN ('gallery', 'case')),
  CHECK (status IN ('pending_media_fetch', 'fetching_media', 'draft_created', 'partial_failed', 'failed')),
  UNIQUE (token_id, source, external_message_id)
);

CREATE TABLE external_import_files_backup (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  filename TEXT,
  declared_mime_type TEXT,
  actual_mime_type TEXT,
  file_size INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  target_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending', 'fetching', 'completed', 'failed'))
);

INSERT INTO external_import_records_new (
  id,
  source,
  external_message_id,
  token_id,
  source_bot_key,
  source_chat_id,
  source_message_id,
  media_group_id,
  target_type,
  target_id,
  status,
  metadata_json,
  file_count,
  fetched_count,
  failed_count,
  retry_count,
  last_retry_at,
  error_json,
  request_ip,
  user_agent,
  created_at,
  completed_at
)
SELECT
  id,
  source,
  external_message_id,
  token_id,
  source_bot_key,
  source_chat_id,
  source_message_id,
  media_group_id,
  CASE target_type
    WHEN 'testimonial_case' THEN 'case'
    ELSE target_type
  END,
  target_id,
  status,
  replace(metadata_json, '"type":"testimonial_case"', '"type":"case"'),
  file_count,
  fetched_count,
  failed_count,
  retry_count,
  last_retry_at,
  error_json,
  request_ip,
  user_agent,
  created_at,
  completed_at
FROM external_import_records;

INSERT INTO external_import_files_backup (
  id,
  import_id,
  telegram_file_id,
  telegram_file_unique_id,
  filename,
  declared_mime_type,
  actual_mime_type,
  file_size,
  sort_order,
  is_cover,
  r2_key,
  target_file_id,
  status,
  error_message,
  created_at,
  updated_at
)
SELECT
  id,
  import_id,
  telegram_file_id,
  telegram_file_unique_id,
  filename,
  declared_mime_type,
  actual_mime_type,
  file_size,
  sort_order,
  is_cover,
  CASE
    WHEN substr(r2_key, 1, length('testimonials/')) = 'testimonials/'
    THEN 'cases/' || substr(r2_key, length('testimonials/') + 1)
    ELSE r2_key
  END,
  target_file_id,
  status,
  error_message,
  created_at,
  updated_at
FROM external_import_files;

DROP TABLE external_import_files;
DROP TABLE external_import_records;
ALTER TABLE external_import_records_new RENAME TO external_import_records;

CREATE TABLE external_import_files (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES external_import_records(id) ON DELETE CASCADE,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  filename TEXT,
  declared_mime_type TEXT,
  actual_mime_type TEXT,
  file_size INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  target_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending', 'fetching', 'completed', 'failed'))
);

INSERT INTO external_import_files (
  id,
  import_id,
  telegram_file_id,
  telegram_file_unique_id,
  filename,
  declared_mime_type,
  actual_mime_type,
  file_size,
  sort_order,
  is_cover,
  r2_key,
  target_file_id,
  status,
  error_message,
  created_at,
  updated_at
)
SELECT
  id,
  import_id,
  telegram_file_id,
  telegram_file_unique_id,
  filename,
  declared_mime_type,
  actual_mime_type,
  file_size,
  sort_order,
  is_cover,
  r2_key,
  target_file_id,
  status,
  error_message,
  created_at,
  updated_at
FROM external_import_files_backup;

DROP TABLE external_import_files_backup;

CREATE INDEX idx_external_import_records_token
  ON external_import_records(token_id, created_at);
CREATE INDEX idx_external_import_records_status
  ON external_import_records(status, created_at);
CREATE INDEX idx_external_import_records_target
  ON external_import_records(target_type, target_id);
CREATE INDEX idx_external_import_files_import
  ON external_import_files(import_id, sort_order);

UPDATE admin_audit_logs
SET
  action = replace(replace(action, 'testimonial_case', 'case'), 'testimonial', 'case'),
  target_type = replace(replace(target_type, 'testimonial_case', 'case'), 'testimonial', 'case')
WHERE action LIKE '%testimonial%'
  OR target_type LIKE '%testimonial%';

UPDATE import_api_tokens
SET permissions = replace(permissions, 'testimonial:create', 'case:create')
WHERE permissions LIKE '%testimonial:create%';

DROP TABLE testimonial_case_images;
DROP TABLE testimonial_cases;

PRAGMA foreign_keys = ON;
