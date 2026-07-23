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
  id, name, channel, slug, link_proof, target_path, utm_source, utm_medium, utm_campaign, utm_content,
  ad_provider, status, note, created_by, created_at, updated_at
)
VALUES (
  'ats_release_local_fb',
  'Release Local FB',
  'ad',
  'release-local-fb',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '/gallery/release-local',
  'facebook',
  'paid_social',
  'release-local-runtime',
  'release-local-chat',
  'meta',
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
  link_proof = excluded.link_proof,
  target_path = excluded.target_path,
  utm_source = excluded.utm_source,
  utm_medium = excluded.utm_medium,
  utm_campaign = excluded.utm_campaign,
  utm_content = excluded.utm_content,
  ad_provider = excluded.ad_provider,
  status = excluded.status,
  note = excluded.note,
  created_by = excluded.created_by,
  updated_at = datetime('now');

INSERT OR REPLACE INTO site_settings (key, value, updated_at)
VALUES
  ('analytics_enabled', 'true', datetime('now')),
  ('analytics_sample_rate', '1', datetime('now')),
  ('analytics_consent_mode', '"limited"', datetime('now'));

INSERT OR REPLACE INTO attribution_platform_connections (
  id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
  rollout_target_percentage, rollout_effective_percentage, connection_revision, credential_revision
)
VALUES
  ('conn_release_local_meta', 'meta', 1, 'test', 0, 0, '{"pixelId":"1234567890"}', 0, 0,
   '11111111111111111111111111111111', '44444444444444444444444444444444'),
  ('conn_release_local_tiktok', 'tiktok', 1, 'test', 0, 0, '{"pixelCode":"C123456789ABCDEF"}', 0, 0,
   '22222222222222222222222222222222', '55555555555555555555555555555555'),
  ('conn_release_local_google', 'google', 1, 'test', 0, 0,
   '{"tagId":"AW-123456789","customerId":"1234567890","cloudProjectId":"meigallery-local"}', 0, 0,
   '33333333333333333333333333333333', '66666666666666666666666666666666');

INSERT OR REPLACE INTO attribution_event_bindings (
  id, connection_id, provider, canonical_event, enabled,
  browser_destination, server_destination, mapping_revision, config_json
)
VALUES
  ('binding_release_local_meta_contact', 'conn_release_local_meta', 'meta', 'Contact', 1,
   'meta_pixel', 'meta_capi', '11111111111111111111111111111111', '{}'),
  ('binding_release_local_meta_registration', 'conn_release_local_meta', 'meta', 'CompleteRegistration', 1,
   'meta_pixel', 'meta_capi', '11111111111111111111111111111111', '{}'),
  ('binding_release_local_tiktok_contact', 'conn_release_local_tiktok', 'tiktok', 'Contact', 1,
   'tiktok_pixel', 'tiktok_events_api', '22222222222222222222222222222222', '{}'),
  ('binding_release_local_tiktok_registration', 'conn_release_local_tiktok', 'tiktok', 'CompleteRegistration', 1,
   'tiktok_pixel', 'tiktok_events_api', '22222222222222222222222222222222', '{}'),
  ('binding_release_local_google_contact', 'conn_release_local_google', 'google', 'Contact', 1,
   'AW-123456789/contact-label', '111222333', '33333333333333333333333333333333', '{}'),
  ('binding_release_local_google_registration', 'conn_release_local_google', 'google', 'CompleteRegistration', 1,
   'AW-123456789/registration-label', '444555666', '33333333333333333333333333333333', '{}');

INSERT OR REPLACE INTO attribution_credentials (
  id, connection_id, provider, credential_type, schema_version, key_id,
  iv, ciphertext, tag, fingerprint, credential_revision
)
VALUES
  ('credential_release_local_meta', 'conn_release_local_meta', 'meta', 'access_token', 1,
   'aaaaaaaaaaaaaaaa', 'fixture-iv', 'fixture-ciphertext', 'fixture-tag', 'fixture-fingerprint',
   '44444444444444444444444444444444'),
  ('credential_release_local_tiktok', 'conn_release_local_tiktok', 'tiktok', 'access_token', 1,
   'bbbbbbbbbbbbbbbb', 'fixture-iv', 'fixture-ciphertext', 'fixture-tag', 'fixture-fingerprint',
   '55555555555555555555555555555555'),
  ('credential_release_local_google', 'conn_release_local_google', 'google', 'service_account_json', 1,
   'cccccccccccccccc', 'fixture-iv', 'fixture-ciphertext', 'fixture-tag', 'fixture-fingerprint',
   '66666666666666666666666666666666');
