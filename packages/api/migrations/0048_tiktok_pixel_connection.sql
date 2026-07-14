INSERT INTO ad_platform_connections (
  provider, enabled, mode, browser_enabled, server_enabled, destination_id,
  debug_enabled, rollout_percentage, credential_secret_name, revision
)
VALUES ('tiktok', 0, 'disabled', 0, 0, '', 0, 0, '', NULL)
ON CONFLICT(provider) DO NOTHING;
