CREATE TABLE IF NOT EXISTS attribution_privacy_policy (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  default_mode TEXT NOT NULL CHECK (default_mode IN ('notice_opt_out', 'prior_consent', 'disabled')),
  prior_consent_country_codes_json TEXT NOT NULL CHECK (json_valid(prior_consent_country_codes_json)),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO attribution_privacy_policy (
  id,
  default_mode,
  prior_consent_country_codes_json,
  policy_version
) VALUES (
  'global',
  'notice_opt_out',
  '["AT","AX","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GB","GF","GP","GR","HR","HU","IE","IS","IT","LI","LT","LU","LV","MF","MQ","MT","NL","NO","PL","PT","RE","RO","SE","SI","SK","YT"]',
  1
);
