CREATE TABLE attribution_runtime_state (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  mode TEXT NOT NULL CHECK (
    mode IN ('shadow', 'bridge', 'active')
  ),
  activated_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (mode = 'active' AND activated_at IS NOT NULL)
    OR (mode <> 'active' AND activated_at IS NULL)
  )
);

INSERT INTO attribution_runtime_state (
  id,
  mode,
  activated_at,
  updated_at
) VALUES (
  'global',
  'shadow',
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
