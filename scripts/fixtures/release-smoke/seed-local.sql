INSERT OR IGNORE INTO membership_levels (id, code, name, rank, description, created_at)
VALUES
  ('ml_free', 'free', '免费', 0, '本地验证默认等级', datetime('now')),
  ('ml_vip', 'vip', 'VIP', 10, '本地验证默认等级', datetime('now')),
  ('ml_svip', 'svip', 'SVIP', 20, '本地验证默认等级', datetime('now'));

INSERT OR REPLACE INTO users (
  id, email, username, nickname, password_hash, avatar_key,
  role, status, email_verified, notification_enabled, created_at, updated_at
)
VALUES (
  1,
  'release-owner@example.test',
  'release_owner',
  'Release Owner',
  '$pbkdf2$100000$c2VlZC1sb2NhbC1ydW50aW1l$YjAwZmQ=',
  NULL,
  'owner',
  'active',
  1,
  1,
  datetime('now'),
  datetime('now')
);

INSERT OR REPLACE INTO contact_methods (
  id, platform, label, value, link_url, qr_code_key,
  sort_order, enabled, created_at, updated_at
)
VALUES
  (
    'contact_local_telegram',
    'telegram',
    '本地 Telegram',
    '@release_local',
    'https://t.me/release_local',
    NULL,
    0,
    1,
    datetime('now'),
    datetime('now')
  ),
  (
    'contact_local_email',
    'email',
    '本地邮箱',
    'release-local@example.test',
    'mailto:release-local@example.test',
    NULL,
    1,
    1,
    datetime('now'),
    datetime('now')
  );

INSERT INTO analytics_tracking_sources (
  id, name, channel, slug, target_path, utm_source, utm_medium, utm_campaign, utm_content,
  status, note, created_by, created_at, updated_at
)
VALUES (
  'ats_release_local_fb',
  'Release Local FB',
  'ad',
  'release-local-fb',
  '/gallery/release-local',
  'facebook',
  'paid_social',
  'release-local-runtime',
  'release-local-chat',
  'active',
  '用于 local-runtime smoke',
  1,
  datetime('now'),
  datetime('now')
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  channel = excluded.channel,
  slug = excluded.slug,
  target_path = excluded.target_path,
  utm_source = excluded.utm_source,
  utm_medium = excluded.utm_medium,
  utm_campaign = excluded.utm_campaign,
  utm_content = excluded.utm_content,
  status = excluded.status,
  note = excluded.note,
  created_by = excluded.created_by,
  updated_at = datetime('now');

INSERT OR REPLACE INTO site_settings (key, value, updated_at)
VALUES
  ('analytics_enabled', 'true', datetime('now')),
  ('analytics_sample_rate', '1', datetime('now')),
  ('analytics_consent_mode', '"limited"', datetime('now')),
  ('facebook_pixel_enabled', 'true', datetime('now')),
  ('facebook_pixel_id', '"1234567890"', datetime('now')),
  ('facebook_pixel_debug_enabled', 'false', datetime('now')),
  ('meta_capi_enabled', 'false', datetime('now')),
  ('meta_capi_test_event_enabled', 'false', datetime('now')),
  ('meta_tracking_mode', '"pixel_only"', datetime('now'));

INSERT OR REPLACE INTO analytics_daily_sources (
  date, source_channel, source_name, invite_code_id,
  visitor_count, session_count, page_view_count, gallery_detail_count,
  contact_click_count, register_count, invite_register_count, membership_grant_count,
  active_seconds_total, created_at, updated_at
)
VALUES (
  date('now'),
  'ad',
  'release-local-fb',
  '',
  1,
  1,
  3,
  1,
  1,
  1,
  0,
  0,
  180,
  datetime('now'),
  datetime('now')
);

INSERT OR REPLACE INTO analytics_ingest_health_daily (
  date, accepted_count, rejected_count, duplicate_count, sensitive_blocked_count,
  sampled_count, dropped_count, estimated_rows_read, estimated_rows_written,
  max_duration_ms, last_ingested_at, created_at, updated_at
)
VALUES (
  date('now'),
  3,
  0,
  0,
  0,
  0,
  0,
  24,
  12,
  15,
  datetime('now'),
  datetime('now'),
  datetime('now')
);
