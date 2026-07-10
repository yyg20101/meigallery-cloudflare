INSERT OR IGNORE INTO membership_levels (id, code, name, rank, description, created_at)
VALUES
  ('ml_free', 'free', '免费', 0, '开发环境发布预演默认等级', datetime('now')),
  ('ml_vip', 'vip', 'VIP', 10, '开发环境发布预演默认等级', datetime('now')),
  ('ml_svip', 'svip', 'SVIP', 20, '开发环境发布预演默认等级', datetime('now'));

-- 该 owner 仅供 dev-rehearsal 使用随机 session 访问后台 smoke。
-- verify-dev-rehearsal.mjs 结束时会删除固定 smoke session 并禁用该账号，避免 dev 远端长期保留 active owner。
INSERT OR REPLACE INTO users (
  id, email, username, nickname, password_hash, avatar_key,
  role, status, email_verified, notification_enabled, created_at, updated_at
)
VALUES (
  1,
  'release-dev-owner@example.test',
  'release_dev_owner',
  'Release Dev Owner',
  '$pbkdf2$100000$c2VlZC1kZXYtcmVoZWFyc2Fs$YjAwZmQ=',
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
    'contact_release_dev_telegram',
    'telegram',
    '开发预演 Telegram',
    '@release_dev_contact',
    'https://t.me/release_dev_contact',
    NULL,
    0,
    1,
    datetime('now'),
    datetime('now')
  ),
  (
    'contact_release_dev_email',
    'email',
    '开发预演邮箱',
    'release-dev@example.test',
    'mailto:release-dev@example.test',
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
  'ats_release_dev_fb',
  'Release Dev FB',
  'ad',
  'release-dev-fb',
  '/gallery/release-dev-gallery',
  'release-dev-fb',
  'paid_social',
  'release-dev-rehearsal',
  'release-dev-chat',
  'active',
  '用于 dev-rehearsal smoke',
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
  ('meta_capi_enabled', 'true', datetime('now')),
  ('meta_capi_test_event_enabled', 'true', datetime('now')),
  ('meta_tracking_mode', '"test"', datetime('now'));
