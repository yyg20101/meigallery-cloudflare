PRAGMA foreign_keys = ON;

CREATE TABLE analytics_conversion_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  date TEXT NOT NULL,
  visitor_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  source_name TEXT NOT NULL DEFAULT '',
  tracking_source_slug TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  method_type TEXT NOT NULL DEFAULT '',
  action_target TEXT NOT NULL DEFAULT '',
  route_name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  duplicate_of TEXT NOT NULL DEFAULT '',
  attribution_provider TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE analytics_conversion_deliveries (
  id TEXT PRIMARY KEY,
  conversion_action_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  transport TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_lease_token TEXT NOT NULL DEFAULT '',
  delivery_lease_expires_at TEXT
);

CREATE TABLE analytics_conversion_daily (
  date TEXT NOT NULL,
  action_type TEXT NOT NULL,
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  source_name TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  action_count INTEGER NOT NULL DEFAULT 0,
  unique_session_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, action_type, source_channel, source_name, utm_campaign, utm_content)
);

CREATE TABLE ad_platform_connections (
  provider TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'disabled',
  browser_enabled INTEGER NOT NULL DEFAULT 0,
  server_enabled INTEGER NOT NULL DEFAULT 0,
  rollout_percentage INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE meta_capi_secure_outbox (
  delivery_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL
);

CREATE TABLE ad_platform_secure_outbox (
  delivery_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);

CREATE TABLE meta_connection_verifications (
  environment TEXT PRIMARY KEY,
  revision TEXT NOT NULL
);

CREATE TABLE tiktok_connection_verifications (
  environment TEXT PRIMARY KEY,
  revision TEXT NOT NULL
);

CREATE TABLE meta_capi_incidents (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  trigger_code TEXT NOT NULL
);

INSERT INTO analytics_conversion_actions (
  id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id, user_id,
  source_channel, source_name, tracking_source_slug, utm_source, utm_medium,
  utm_campaign, utm_content, method_type, action_target, route_name, path,
  metadata, attribution_provider
) VALUES
  (
    'legacy_contact_meta', 'contact', 'contact:meta:001', '2026-07-12T01:00:00.000Z', '2026-07-12',
    'visitor-meta', 'session-meta', 7, 'ad', 'facebook', 'facebook-summer', 'facebook', 'paid_social',
    'summer-meta', 'creative-a', 'telegram', 'https://t.me/example', 'gallery-detail', '/gallery/summer',
    '{"surface":"floating-contact"}', 'meta'
  ),
  (
    'legacy_registration_tiktok', 'complete_registration', 'registration:tiktok:001', '2026-07-12T02:00:00.000Z', '2026-07-12',
    'visitor-tiktok', 'session-tiktok', 8, 'ad', 'tiktok', 'tiktok-launch', 'tiktok', 'paid_social',
    'launch-tiktok', 'creative-b', '', '', 'register', '/register', '{"flow":"member"}', 'tiktok'
  ),
  (
    'legacy_contact_unattributed', 'contact', 'contact:organic:001', '2026-07-12T03:00:00.000Z', '2026-07-12',
    'visitor-organic', 'session-organic', NULL, 'organic', 'direct', '', '', '', '', '',
    'email', 'mailto:hello@example.com', 'home', '/', 'not-valid-json', ''
  ),
  (
    'legacy_lead_meta', 'lead', 'lead:meta:001', '2026-07-12T04:00:00.000Z', '2026-07-12',
    'visitor-lead', 'session-lead', NULL, 'ad', 'facebook', '', 'facebook', 'paid_social',
    'lead-meta', '', '', '', 'home', '/', '{}', 'meta'
  ),
  (
    'legacy_start_trial', 'start_trial', 'trial:001', '2026-07-12T05:00:00.000Z', '2026-07-12',
    'visitor-trial', 'session-trial', NULL, 'organic', 'direct', '', '', '', '', '', '', '', 'home', '/', '{}', ''
  );

INSERT INTO analytics_conversion_deliveries (
  id, conversion_action_id, provider, transport, status
) VALUES
  ('legacy_delivery_meta', 'legacy_contact_meta', 'meta', 'server', 'sent'),
  ('legacy_delivery_tiktok', 'legacy_registration_tiktok', 'tiktok', 'server', 'sent');

INSERT INTO analytics_conversion_daily (
  date, action_type, source_channel, source_name, utm_campaign, utm_content,
  action_count, unique_session_count
) VALUES ('2026-07-12', 'contact', 'ad', 'facebook', 'summer-meta', 'creative-a', 1, 1);

INSERT INTO ad_platform_connections (
  provider, enabled, mode, browser_enabled, server_enabled, rollout_percentage
) VALUES
  ('meta', 1, 'production', 1, 0, 0),
  ('tiktok', 1, 'production', 1, 0, 0);

INSERT INTO meta_capi_secure_outbox (delivery_id, ciphertext)
VALUES ('legacy_delivery_meta', 'legacy-meta-ciphertext');

INSERT INTO ad_platform_secure_outbox (delivery_id, provider, ciphertext)
VALUES ('legacy_delivery_tiktok', 'tiktok', 'legacy-tiktok-ciphertext');

INSERT INTO meta_connection_verifications (environment, revision)
VALUES ('production', 'legacy-meta-revision');

INSERT INTO tiktok_connection_verifications (environment, revision)
VALUES ('production', 'legacy-tiktok-revision');

INSERT INTO meta_capi_incidents (id, status, trigger_code)
VALUES ('legacy_incident', 'closed', 'historical_warning');
