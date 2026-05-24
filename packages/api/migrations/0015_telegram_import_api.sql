-- Telegram file_id 异步导入 API
CREATE TABLE IF NOT EXISTS import_api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL,
  allowed_source_bot_keys TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_import_api_tokens_status
  ON import_api_tokens(status, expires_at);

CREATE TABLE IF NOT EXISTS external_import_records (
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
  CHECK (target_type IN ('gallery', 'testimonial_case')),
  CHECK (status IN ('pending_media_fetch', 'fetching_media', 'draft_created', 'partial_failed', 'failed')),
  UNIQUE (token_id, source, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_external_import_records_token
  ON external_import_records(token_id, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_status
  ON external_import_records(status, created_at);
CREATE INDEX IF NOT EXISTS idx_external_import_records_target
  ON external_import_records(target_type, target_id);

CREATE TABLE IF NOT EXISTS external_import_files (
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

CREATE INDEX IF NOT EXISTS idx_external_import_files_import
  ON external_import_files(import_id, sort_order);
