-- Message-4：App 1.0 账号级实时刷新通道控制面与一次性短票据。
--
-- 本 migration 只创建默认关闭的治理记录和空票据表：
-- - 不创建 Durable Object binding，不开放 WebSocket 路由；
-- - 不发送消息或通知正文，只为后续最小刷新信号保留受控入口；
-- - OQ-028 未关闭，策略保持 unresolved / disabled / 非 production-ready；
-- - 不回填历史账号、会话、消息或通知。

CREATE TABLE app_realtime_policies (
  id TEXT PRIMARY KEY,
  version_code TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'development'
    CHECK (state IN ('development', 'published', 'retired')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  capacity_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (capacity_decision_status IN ('unresolved', 'approved')),
  governance_reference TEXT,
  ticket_ttl_seconds INTEGER NOT NULL CHECK (ticket_ttl_seconds BETWEEN 30 AND 120),
  max_pending_tickets_per_account INTEGER NOT NULL
    CHECK (max_pending_tickets_per_account BETWEEN 1 AND 16),
  max_connections_per_account INTEGER NOT NULL
    CHECK (max_connections_per_account BETWEEN 1 AND 8),
  replay_event_limit INTEGER NOT NULL CHECK (replay_event_limit BETWEEN 16 AND 256),
  retained_event_limit INTEGER NOT NULL CHECK (retained_event_limit BETWEEN 32 AND 512),
  reconnect_min_delay_ms INTEGER NOT NULL CHECK (reconnect_min_delay_ms BETWEEN 500 AND 5000),
  reconnect_max_delay_ms INTEGER NOT NULL CHECK (reconnect_max_delay_ms BETWEEN 5000 AND 60000),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (reconnect_max_delay_ms >= reconnect_min_delay_ms),
  CHECK (
    enabled = 0
    OR (
      state = 'published'
      AND capacity_decision_status = 'approved'
      AND governance_reference IS NOT NULL
      AND length(trim(governance_reference)) BETWEEN 1 AND 240
    )
  ),
  CHECK (production_ready = 0 OR (enabled = 1 AND state = 'published'))
);

INSERT INTO app_realtime_policies (
  id,
  version_code,
  state,
  enabled,
  production_ready,
  capacity_decision_status,
  governance_reference,
  ticket_ttl_seconds,
  max_pending_tickets_per_account,
  max_connections_per_account,
  replay_event_limit,
  retained_event_limit,
  reconnect_min_delay_ms,
  reconnect_max_delay_ms,
  created_at,
  updated_at
) VALUES (
  'rtp_app_1_0_message_4_dev_1',
  'rtp_app_1_0_message_4_dev_1',
  'development',
  0,
  0,
  'unresolved',
  NULL,
  60,
  4,
  4,
  128,
  256,
  1000,
  30000,
  datetime('now'),
  datetime('now')
);

CREATE TABLE app_realtime_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(token_hash) = 64
      AND token_hash = lower(token_hash)
      AND token_hash NOT GLOB '*[^0-9a-f]*'
    ),
  policy_id TEXT NOT NULL REFERENCES app_realtime_policies(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES app_devices(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 128),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  consumed_at TEXT CHECK (consumed_at IS NULL OR julianday(consumed_at) IS NOT NULL),
  connection_id TEXT,
  cancelled_at TEXT CHECK (cancelled_at IS NULL OR julianday(cancelled_at) IS NOT NULL),
  cancellation_reason TEXT,
  CHECK (datetime(expires_at) > datetime(issued_at)),
  CHECK ((consumed_at IS NULL) = (connection_id IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancellation_reason IS NULL)),
  CHECK (NOT (consumed_at IS NOT NULL AND cancelled_at IS NOT NULL)),
  CHECK (connection_id IS NULL OR length(connection_id) BETWEEN 12 AND 96),
  CHECK (cancellation_reason IS NULL OR length(trim(cancellation_reason)) BETWEEN 1 AND 80)
);

CREATE INDEX idx_app_realtime_tickets_account_pending
  ON app_realtime_tickets(account_id, expires_at, issued_at)
  WHERE consumed_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX idx_app_realtime_tickets_session
  ON app_realtime_tickets(session_id, issued_at DESC);

CREATE INDEX idx_app_realtime_tickets_device
  ON app_realtime_tickets(device_id, issued_at DESC);

CREATE TRIGGER trg_app_realtime_ticket_active_principal_insert
BEFORE INSERT ON app_realtime_tickets
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM app_sessions session
  JOIN app_devices device
    ON device.id = session.device_id
   AND device.account_id = session.account_id
  JOIN app_account_security security
    ON security.account_id = session.account_id
  JOIN users account
    ON account.id = session.account_id
  JOIN app_realtime_policies policy
    ON policy.id = NEW.policy_id
  WHERE session.id = NEW.session_id
    AND session.account_id = NEW.account_id
    AND session.device_id = NEW.device_id
    AND session.status = 'active'
    AND datetime(session.refresh_expires_at) > datetime(NEW.issued_at)
    AND session.account_session_version = security.session_version
    AND session.device_session_version = device.session_version
    AND device.status = 'active'
    AND security.status = 'active'
    AND account.status = 'active'
    AND policy.enabled = 1
    AND policy.state = 'published'
    AND policy.capacity_decision_status = 'approved'
)
BEGIN
  SELECT RAISE(ABORT, 'app_realtime_ticket_principal_unavailable');
END;

CREATE TRIGGER trg_app_realtime_ticket_identity_immutable
BEFORE UPDATE ON app_realtime_tickets
FOR EACH ROW
WHEN NEW.id <> OLD.id
  OR NEW.token_hash <> OLD.token_hash
  OR NEW.policy_id <> OLD.policy_id
  OR NEW.account_id <> OLD.account_id
  OR NEW.session_id <> OLD.session_id
  OR NEW.device_id <> OLD.device_id
  OR NEW.request_id <> OLD.request_id
  OR NEW.issued_at <> OLD.issued_at
  OR NEW.expires_at <> OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'app_realtime_ticket_identity_immutable');
END;

CREATE TRIGGER trg_app_realtime_ticket_terminal_immutable
BEFORE UPDATE ON app_realtime_tickets
FOR EACH ROW
WHEN (OLD.consumed_at IS NOT NULL AND (
       NEW.consumed_at IS NULL
       OR NEW.consumed_at <> OLD.consumed_at
       OR NEW.connection_id <> OLD.connection_id
     ))
  OR (OLD.cancelled_at IS NOT NULL AND (
       NEW.cancelled_at IS NULL
       OR NEW.cancelled_at <> OLD.cancelled_at
       OR NEW.cancellation_reason <> OLD.cancellation_reason
     ))
  OR (OLD.consumed_at IS NOT NULL AND NEW.cancelled_at IS NOT NULL)
  OR (OLD.cancelled_at IS NOT NULL AND NEW.consumed_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'app_realtime_ticket_terminal_immutable');
END;

CREATE TRIGGER trg_app_realtime_policy_no_delete
BEFORE DELETE ON app_realtime_policies
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'app_realtime_policy_delete_forbidden');
END;
