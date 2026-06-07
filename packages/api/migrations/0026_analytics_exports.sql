-- 数据分析导出任务表。导出文件写入 R2，默认 7 天过期。

CREATE TABLE IF NOT EXISTS analytics_export_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  kind TEXT NOT NULL,
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  r2_key TEXT,
  expires_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'expired')),
  CHECK (kind IN ('overview', 'sources', 'pages', 'paths', 'clicks', 'durations', 'invites', 'sessions'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_export_jobs_status_expires
  ON analytics_export_jobs(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_analytics_export_jobs_created_by
  ON analytics_export_jobs(created_by, created_at);
