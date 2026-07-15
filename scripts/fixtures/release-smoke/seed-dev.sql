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
  ('analytics_consent_mode', '"limited"', datetime('now'));

-- dev 只验证业务事实和来源隔离；三个真实广告平台通道均保持关闭。
INSERT OR REPLACE INTO attribution_platform_connections (
  id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
  rollout_target_percentage, rollout_effective_percentage, connection_revision, credential_revision
)
VALUES
  ('conn_release_dev_meta', 'meta', 1, 'test', 0, 0, '{"pixelId":"1234567890"}', 0, 0,
   '11111111111111111111111111111111', '44444444444444444444444444444444'),
  ('conn_release_dev_tiktok', 'tiktok', 1, 'test', 0, 0, '{"pixelCode":"C123456789ABCDEF"}', 0, 0,
   '22222222222222222222222222222222', '55555555555555555555555555555555'),
  ('conn_release_dev_google', 'google', 1, 'test', 0, 0,
   '{"tagId":"AW-123456789","customerId":"1234567890","cloudProjectId":"meigallery-dev"}', 0, 0,
   '33333333333333333333333333333333', '66666666666666666666666666666666');

INSERT OR REPLACE INTO attribution_event_bindings (
  id, connection_id, provider, canonical_event, enabled,
  browser_destination, server_destination, mapping_revision, config_json
)
VALUES
  ('binding_release_dev_meta_contact', 'conn_release_dev_meta', 'meta', 'Contact', 1,
   'meta_pixel', 'meta_capi', '11111111111111111111111111111111', '{}'),
  ('binding_release_dev_meta_registration', 'conn_release_dev_meta', 'meta', 'CompleteRegistration', 1,
   'meta_pixel', 'meta_capi', '11111111111111111111111111111111', '{}'),
  ('binding_release_dev_tiktok_contact', 'conn_release_dev_tiktok', 'tiktok', 'Contact', 1,
   'tiktok_pixel', 'tiktok_events_api', '22222222222222222222222222222222', '{}'),
  ('binding_release_dev_tiktok_registration', 'conn_release_dev_tiktok', 'tiktok', 'CompleteRegistration', 1,
   'tiktok_pixel', 'tiktok_events_api', '22222222222222222222222222222222', '{}'),
  ('binding_release_dev_google_contact', 'conn_release_dev_google', 'google', 'Contact', 1,
   'AW-123456789/contact-label', '111222333', '33333333333333333333333333333333', '{}'),
  ('binding_release_dev_google_registration', 'conn_release_dev_google', 'google', 'CompleteRegistration', 1,
   'AW-123456789/registration-label', '444555666', '33333333333333333333333333333333', '{}');

INSERT OR REPLACE INTO attribution_credentials (
  id, connection_id, provider, credential_type, schema_version, key_id,
  iv, ciphertext, tag, fingerprint, credential_revision
)
VALUES
  ('credential_release_dev_meta', 'conn_release_dev_meta', 'meta', 'access_token', 1,
   'aaaaaaaaaaaaaaaa', 'fixture-iv', 'fixture-ciphertext', 'fixture-tag', 'fixture-fingerprint',
   '44444444444444444444444444444444'),
  ('credential_release_dev_tiktok', 'conn_release_dev_tiktok', 'tiktok', 'access_token', 1,
   'bbbbbbbbbbbbbbbb', 'fixture-iv', 'fixture-ciphertext', 'fixture-tag', 'fixture-fingerprint',
   '55555555555555555555555555555555'),
  ('credential_release_dev_google', 'conn_release_dev_google', 'google', 'service_account_json', 1,
   'cccccccccccccccc', 'fixture-iv', 'fixture-ciphertext', 'fixture-tag', 'fixture-fingerprint',
   '66666666666666666666666666666666');
