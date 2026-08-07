-- Message-3：默认关闭的 App 站内通知中心、偏好和可靠 Outbox。
--
-- 本 migration 只创建 development 策略、事件定义、固定安全模板、私有通知投影与触发器：
-- - 不启用任何环境运行时开关；
-- - generation_enabled 默认关闭，不回填既有业务事件，也不创建用户通知 seed；
-- - 不接入 APNs、FCM、短信、邮件、WebSocket 或任意外部深链；
-- - 不复制平台话题正文、内部备注、安全证据或访问凭证；
-- - OQ-020 未关闭前 retention_days 保持 NULL，purge_enabled=0，不执行自动清理。

CREATE TABLE app_notification_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ntp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      version_code NOT GLOB '*[^A-Za-z0-9._-]*'
      AND length(version_code) BETWEEN 3 AND 80
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  generation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (generation_enabled IN (0, 1)),
  decision_status TEXT NOT NULL CHECK (decision_status IN ('unresolved', 'approved')),
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  purge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (purge_enabled IN (0, 1)),
  minimum_client_version TEXT NOT NULL DEFAULT '1.0'
    CHECK (length(minimum_client_version) BETWEEN 1 AND 32),
  effective_at TEXT
    CHECK (effective_at IS NULL OR julianday(effective_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (
    production_ready = 0
    OR (
      state = 'published'
      AND decision_status = 'approved'
      AND retention_days IS NOT NULL
      AND effective_at IS NOT NULL
    )
  ),
  CHECK (purge_enabled = 0 OR (decision_status = 'approved' AND retention_days IS NOT NULL)),
  CHECK (
    generation_enabled = 0
    OR (state IN ('development', 'published') AND effective_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_app_notification_policy_single_generation
  ON app_notification_policies (generation_enabled)
  WHERE generation_enabled = 1;

INSERT INTO app_notification_policies (
  id,
  version_code,
  state,
  production_ready,
  generation_enabled,
  decision_status,
  retention_days,
  purge_enabled,
  minimum_client_version,
  effective_at,
  created_at
) VALUES (
  'ntp_app_1_0_message_3_dev_1',
  'app-1.0-message-3-dev-1',
  'development',
  0,
  0,
  'unresolved',
  NULL,
  0,
  '1.0',
  NULL,
  '2026-08-08T00:00:00.000Z'
);

CREATE TABLE app_notification_event_definitions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'nde_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  policy_id TEXT NOT NULL REFERENCES app_notification_policies(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL
    CHECK (
      event_type GLOB '[a-z]*.*'
      AND event_type NOT GLOB '*[^a-z0-9._]*'
      AND length(event_type) BETWEEN 3 AND 96
    ),
  category TEXT NOT NULL
    CHECK (category IN ('message', 'interaction', 'membership_coin', 'system_security', 'marketing')),
  necessity TEXT NOT NULL CHECK (necessity IN ('required', 'optional')),
  preference_key TEXT
    CHECK (preference_key IS NULL OR preference_key IN ('message', 'interaction', 'marketing')),
  source_domain TEXT NOT NULL
    CHECK (source_domain IN ('messaging', 'interaction', 'membership', 'wallet', 'safety', 'account', 'data_rights', 'marketing')),
  target_type TEXT NOT NULL
    CHECK (target_type IN (
      'conversation', 'person_profile', 'membership', 'membership_application',
      'wallet_entry', 'safety_report', 'safety_appeal', 'account_security', 'data_task', 'none'
    )),
  action TEXT NOT NULL
    CHECK (action IN (
      'open_conversation', 'open_person_profile', 'open_membership', 'open_membership_application',
      'open_wallet_entry', 'open_safety_report', 'open_safety_appeal', 'open_account_security',
      'open_data_task', 'none'
    )),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  privacy_level TEXT NOT NULL CHECK (privacy_level IN ('standard', 'sensitive')),
  minimum_client_version TEXT NOT NULL DEFAULT '1.0'
    CHECK (length(minimum_client_version) BETWEEN 1 AND 32),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (policy_id, event_type),
  CHECK (
    (necessity = 'required' AND preference_key IS NULL)
    OR (necessity = 'optional' AND preference_key IS NOT NULL)
  ),
  CHECK (
    (target_type = 'none' AND action = 'none')
    OR (target_type <> 'none' AND action <> 'none')
  )
);

INSERT INTO app_notification_event_definitions (
  id, policy_id, event_type, category, necessity, preference_key, source_domain,
  target_type, action, privacy_level, active, created_at
) VALUES
  ('nde_message_platform_reply', 'ntp_app_1_0_message_3_dev_1', 'message.platform_reply', 'message', 'optional', 'message', 'messaging', 'conversation', 'open_conversation', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_membership_application_information', 'ntp_app_1_0_message_3_dev_1', 'membership.application_information_requested', 'membership_coin', 'required', NULL, 'membership', 'membership_application', 'open_membership_application', 'standard', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_membership_application_rejected', 'ntp_app_1_0_message_3_dev_1', 'membership.application_rejected', 'membership_coin', 'required', NULL, 'membership', 'membership_application', 'open_membership_application', 'standard', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_membership_application_expired', 'ntp_app_1_0_message_3_dev_1', 'membership.application_expired', 'membership_coin', 'required', NULL, 'membership', 'membership_application', 'open_membership_application', 'standard', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_membership_application_cancelled', 'ntp_app_1_0_message_3_dev_1', 'membership.application_cancelled', 'membership_coin', 'required', NULL, 'membership', 'membership_application', 'open_membership_application', 'standard', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_membership_granted', 'ntp_app_1_0_message_3_dev_1', 'membership.granted', 'membership_coin', 'required', NULL, 'membership', 'membership', 'open_membership', 'standard', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_membership_revoked', 'ntp_app_1_0_message_3_dev_1', 'membership.revoked', 'membership_coin', 'required', NULL, 'membership', 'membership', 'open_membership', 'standard', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_membership_expired', 'ntp_app_1_0_message_3_dev_1', 'membership.expired', 'membership_coin', 'required', NULL, 'membership', 'membership', 'open_membership', 'standard', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_safety_report_actioned', 'ntp_app_1_0_message_3_dev_1', 'safety.report_actioned', 'system_security', 'required', NULL, 'safety', 'safety_report', 'open_safety_report', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_safety_report_no_violation', 'ntp_app_1_0_message_3_dev_1', 'safety.report_no_violation', 'system_security', 'required', NULL, 'safety', 'safety_report', 'open_safety_report', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_safety_report_closed', 'ntp_app_1_0_message_3_dev_1', 'safety.report_closed', 'system_security', 'required', NULL, 'safety', 'safety_report', 'open_safety_report', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_safety_appeal_upheld', 'ntp_app_1_0_message_3_dev_1', 'safety.appeal_upheld', 'system_security', 'required', NULL, 'safety', 'safety_appeal', 'open_safety_appeal', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_safety_appeal_changed', 'ntp_app_1_0_message_3_dev_1', 'safety.appeal_changed', 'system_security', 'required', NULL, 'safety', 'safety_appeal', 'open_safety_appeal', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_safety_appeal_closed', 'ntp_app_1_0_message_3_dev_1', 'safety.appeal_closed', 'system_security', 'required', NULL, 'safety', 'safety_appeal', 'open_safety_appeal', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_account_session_logged_in', 'ntp_app_1_0_message_3_dev_1', 'account.session_logged_in', 'system_security', 'required', NULL, 'account', 'account_security', 'open_account_security', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_account_device_revoked', 'ntp_app_1_0_message_3_dev_1', 'account.device_revoked', 'system_security', 'required', NULL, 'account', 'account_security', 'open_account_security', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_account_refresh_reuse', 'ntp_app_1_0_message_3_dev_1', 'account.refresh_token_reuse_detected', 'system_security', 'required', NULL, 'account', 'account_security', 'open_account_security', 'sensitive', 1, '2026-08-08T00:00:00.000Z'),
  ('nde_interaction_followed_profile_updated', 'ntp_app_1_0_message_3_dev_1', 'interaction.followed_profile_updated', 'interaction', 'optional', 'interaction', 'interaction', 'person_profile', 'open_person_profile', 'standard', 0, '2026-08-08T00:00:00.000Z'),
  ('nde_wallet_entry_posted', 'ntp_app_1_0_message_3_dev_1', 'wallet.entry_posted', 'membership_coin', 'required', NULL, 'wallet', 'wallet_entry', 'open_wallet_entry', 'sensitive', 0, '2026-08-08T00:00:00.000Z'),
  ('nde_data_export_ready', 'ntp_app_1_0_message_3_dev_1', 'data.export_ready', 'system_security', 'required', NULL, 'data_rights', 'data_task', 'open_data_task', 'sensitive', 0, '2026-08-08T00:00:00.000Z'),
  ('nde_account_deletion_updated', 'ntp_app_1_0_message_3_dev_1', 'account.deletion_updated', 'system_security', 'required', NULL, 'data_rights', 'data_task', 'open_data_task', 'sensitive', 0, '2026-08-08T00:00:00.000Z'),
  ('nde_marketing_campaign', 'ntp_app_1_0_message_3_dev_1', 'marketing.campaign', 'marketing', 'optional', 'marketing', 'marketing', 'none', 'none', 'standard', 0, '2026-08-08T00:00:00.000Z');

CREATE TABLE app_notification_template_versions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ntv_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  event_definition_id TEXT NOT NULL REFERENCES app_notification_event_definitions(id) ON DELETE RESTRICT,
  version_code TEXT NOT NULL
    CHECK (
      version_code NOT GLOB '*[^A-Za-z0-9._-]*'
      AND length(version_code) BETWEEN 1 AND 80
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (locale = 'zh-CN'),
  region_scope TEXT NOT NULL DEFAULT 'all' CHECK (region_scope = 'all'),
  title_text TEXT NOT NULL CHECK (length(trim(title_text)) BETWEEN 1 AND 80),
  summary_text TEXT NOT NULL CHECK (length(trim(summary_text)) BETWEEN 1 AND 160),
  body_text TEXT NOT NULL CHECK (length(trim(body_text)) BETWEEN 1 AND 500),
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  effective_at TEXT CHECK (effective_at IS NULL OR julianday(effective_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (event_definition_id, version_code, locale, region_scope),
  CHECK (state <> 'published' OR (approved_by IS NOT NULL AND effective_at IS NOT NULL))
);

CREATE UNIQUE INDEX idx_app_notification_template_current
  ON app_notification_template_versions (event_definition_id, locale, region_scope)
  WHERE state IN ('development', 'published');

INSERT INTO app_notification_template_versions (
  id, event_definition_id, version_code, state, title_text, summary_text, body_text, created_at
) VALUES
  ('ntv_message_platform_reply_v1', 'nde_message_platform_reply', 'message-platform-reply-v1', 'development', '平台话题有新回复', '平台运营已回复你的话题，内容请进入会话查看。', '为保护沟通隐私，站内通知不会展示完整话题正文。打开后请以会话中的权威记录为准。', '2026-08-08T00:00:00.000Z'),
  ('ntv_membership_application_information_v1', 'nde_membership_application_information', 'membership-application-information-v1', 'development', '会员申请需要补充信息', '平台已更新申请进度，请查看需要补充的内容。', '打开会员申请后可查看用户可见说明并重新提交；申请本身不会直接产生会员权益。', '2026-08-08T00:00:00.000Z'),
  ('ntv_membership_application_rejected_v1', 'nde_membership_application_rejected', 'membership-application-rejected-v1', 'development', '会员申请已处理', '本次会员申请未通过，请查看处理说明。', '打开会员申请查看用户可见结果；如仍有需要，可在当前目录允许时重新提交新申请。', '2026-08-08T00:00:00.000Z'),
  ('ntv_membership_application_expired_v1', 'nde_membership_application_expired', 'membership-application-expired-v1', 'development', '会员申请已结束', '本次会员申请已过期，请查看申请记录。', '申请过期不会改变当前会员权益；如仍有需要，可在当前目录允许时重新申请。', '2026-08-08T00:00:00.000Z'),
  ('ntv_membership_application_cancelled_v1', 'nde_membership_application_cancelled', 'membership-application-cancelled-v1', 'development', '会员申请已取消', '平台已结束本次会员申请，请查看处理说明。', '申请取消不会改变当前会员权益；请以会员页和申请详情中的权威状态为准。', '2026-08-08T00:00:00.000Z'),
  ('ntv_membership_granted_v1', 'nde_membership_granted', 'membership-granted-v1', 'development', '会员权益已更新', '平台已完成会员发放，请查看当前权益和有效期。', '打开会员页后会重新读取权威等级、期限和 entitlement；请勿把通知内容视为永久权益凭证。', '2026-08-08T00:00:00.000Z'),
  ('ntv_membership_revoked_v1', 'nde_membership_revoked', 'membership-revoked-v1', 'development', '会员权益已调整', '一笔会员发放已被撤销，请查看当前有效权益。', '打开会员页后会重新读取当前有效 grant 和 entitlement；历史通知不代表当前仍有相同权益。', '2026-08-08T00:00:00.000Z'),
  ('ntv_membership_expired_v1', 'nde_membership_expired', 'membership-expired-v1', 'development', '会员权益已到期', '当前会员权益已到期，请查看最新账号状态。', '打开会员页后会重新读取权威等级和期限；站内通知不提供在线续费或支付入口。', '2026-08-08T00:00:00.000Z'),
  ('ntv_safety_report_actioned_v1', 'nde_safety_report_actioned', 'safety-report-actioned-v1', 'development', '举报处理状态已更新', '平台已完成一项安全处理，请查看用户可见结果。', '通知不包含敏感证据或内部审核备注；打开举报详情后可查看当前状态和用户可见时间线。', '2026-08-08T00:00:00.000Z'),
  ('ntv_safety_report_no_violation_v1', 'nde_safety_report_no_violation', 'safety-report-no-violation-v1', 'development', '举报处理状态已更新', '平台已完成本次举报审核，请查看用户可见结论。', '如服务端允许独立复核，举报详情会显示对应入口；通知本身不推导申诉资格。', '2026-08-08T00:00:00.000Z'),
  ('ntv_safety_report_closed_v1', 'nde_safety_report_closed', 'safety-report-closed-v1', 'development', '举报记录已关闭', '本次举报处理已结束，请查看最终用户可见状态。', '通知不包含敏感证据或内部审核备注；请以举报详情中的权威时间线为准。', '2026-08-08T00:00:00.000Z'),
  ('ntv_safety_appeal_upheld_v1', 'nde_safety_appeal_upheld', 'safety-appeal-upheld-v1', 'development', '复核申请已有结论', '独立复核已完成，请查看用户可见结果。', '打开复核详情后可查看完整用户可见时间线；通知不会包含内部复核备注。', '2026-08-08T00:00:00.000Z'),
  ('ntv_safety_appeal_changed_v1', 'nde_safety_appeal_changed', 'safety-appeal-changed-v1', 'development', '复核申请已有结论', '独立复核已更新原举报状态，请查看处理进度。', '“重新调查”不代表自动认定违规或已经执行处置，请以举报与复核详情的权威状态为准。', '2026-08-08T00:00:00.000Z'),
  ('ntv_safety_appeal_closed_v1', 'nde_safety_appeal_closed', 'safety-appeal-closed-v1', 'development', '复核申请已关闭', '本次独立复核已结束，请查看用户可见结果。', '通知不包含敏感证据或内部审核备注；请以复核详情中的权威时间线为准。', '2026-08-08T00:00:00.000Z'),
  ('ntv_account_session_logged_in_v1', 'nde_account_session_logged_in', 'account-session-logged-in-v1', 'development', '账号有新的登录记录', '平台记录到一次 App 登录，请检查账号与设备。', '如不是你本人操作，请检查设备列表并退出其他设备；通知不会展示凭证、IP 或精确位置。', '2026-08-08T00:00:00.000Z'),
  ('ntv_account_device_revoked_v1', 'nde_account_device_revoked', 'account-device-revoked-v1', 'development', '设备访问已撤销', '一台设备的 App 会话已被远程退出。', '请在账号与设备页面核对当前设备状态；通知不会包含访问凭证或设备硬件标识。', '2026-08-08T00:00:00.000Z'),
  ('ntv_account_refresh_reuse_v1', 'nde_account_refresh_reuse', 'account-refresh-reuse-v1', 'development', '账号安全状态已更新', '平台检测到异常会话凭证使用并已撤销相关会话。', '请重新登录并检查设备列表；通知不会展示凭证、IP、精确位置或内部风控证据。', '2026-08-08T00:00:00.000Z');

CREATE TABLE app_notification_preferences (
  account_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES app_notification_policies(id) ON DELETE RESTRICT,
  message_enabled INTEGER NOT NULL DEFAULT 1 CHECK (message_enabled IN (0, 1)),
  interaction_enabled INTEGER NOT NULL DEFAULT 1 CHECK (interaction_enabled IN (0, 1)),
  marketing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (marketing_enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE TABLE app_notification_preference_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'npe_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES app_notification_policies(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  message_enabled INTEGER NOT NULL CHECK (message_enabled IN (0, 1)),
  interaction_enabled INTEGER NOT NULL CHECK (interaction_enabled IN (0, 1)),
  marketing_enabled INTEGER NOT NULL CHECK (marketing_enabled IN (0, 1)),
  device_id TEXT REFERENCES app_devices(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 96),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (account_id, version)
);

CREATE TABLE app_notification_outbox (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'nto_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 112
    ),
  policy_id TEXT NOT NULL REFERENCES app_notification_policies(id) ON DELETE RESTRICT,
  event_definition_id TEXT NOT NULL REFERENCES app_notification_event_definitions(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 3 AND 96),
  event_ref TEXT NOT NULL CHECK (length(event_ref) BETWEEN 3 AND 120),
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 3 AND 40),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'suppressed', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at TEXT NOT NULL CHECK (julianday(next_attempt_at) IS NOT NULL),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  notification_id TEXT UNIQUE
    CHECK (notification_id IS NULL OR (notification_id GLOB 'ntf_*' AND length(notification_id) BETWEEN 5 AND 96)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  processed_at TEXT CHECK (processed_at IS NULL OR julianday(processed_at) IS NOT NULL),
  UNIQUE (account_id, event_type, event_ref)
);

CREATE INDEX idx_app_notification_outbox_recovery
  ON app_notification_outbox (status, next_attempt_at ASC, created_at ASC, id ASC);

CREATE INDEX idx_app_notification_outbox_account
  ON app_notification_outbox (account_id, status, created_at DESC, id DESC);

CREATE TABLE app_notifications (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ntf_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  outbox_id TEXT NOT NULL UNIQUE REFERENCES app_notification_outbox(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL
    CHECK (category IN ('message', 'interaction', 'membership_coin', 'system_security', 'marketing')),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 3 AND 96),
  template_version_id TEXT NOT NULL REFERENCES app_notification_template_versions(id) ON DELETE RESTRICT,
  template_version_code TEXT NOT NULL CHECK (length(template_version_code) BETWEEN 1 AND 80),
  title_text TEXT NOT NULL CHECK (length(trim(title_text)) BETWEEN 1 AND 80),
  summary_text TEXT NOT NULL CHECK (length(trim(summary_text)) BETWEEN 1 AND 160),
  body_text TEXT NOT NULL CHECK (length(trim(body_text)) BETWEEN 1 AND 500),
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 3 AND 40),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 100),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 48),
  minimum_client_version TEXT NOT NULL CHECK (length(minimum_client_version) BETWEEN 1 AND 32),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'withdrawn')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR julianday(expires_at) IS NOT NULL),
  read_at TEXT CHECK (read_at IS NULL OR julianday(read_at) IS NOT NULL),
  withdrawn_at TEXT CHECK (withdrawn_at IS NULL OR julianday(withdrawn_at) IS NOT NULL),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
);

CREATE INDEX idx_app_notifications_account_category_time
  ON app_notifications (account_id, category, created_at DESC, id DESC);

CREATE INDEX idx_app_notifications_account_time
  ON app_notifications (account_id, created_at DESC, id DESC);

CREATE INDEX idx_app_notifications_account_unread
  ON app_notifications (account_id, category, created_at DESC, id DESC)
  WHERE status = 'available' AND read_at IS NULL;

CREATE TABLE app_notification_read_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'nre_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('single', 'category_all')),
  notification_id TEXT REFERENCES app_notifications(id) ON DELETE SET NULL,
  category TEXT
    CHECK (category IS NULL OR category IN ('message', 'interaction', 'membership_coin', 'system_security', 'marketing')),
  device_id TEXT REFERENCES app_devices(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 96),
  marked_count INTEGER NOT NULL CHECK (marked_count >= 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (
    (operation = 'single' AND notification_id IS NOT NULL AND category IS NULL)
    OR (operation = 'category_all' AND notification_id IS NULL AND category IS NOT NULL)
  )
);

CREATE INDEX idx_app_notification_read_events_account_time
  ON app_notification_read_events (account_id, created_at DESC, id DESC);

-- 业务触发器只在数据库策略显式开启时写入 Outbox。运行时环境开关仍是独立的第二道门禁。
CREATE TRIGGER app_notification_from_platform_reply
AFTER INSERT ON app_conversation_messages
WHEN NEW.sender_type = 'platform_operator' AND NEW.status = 'accepted'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_' || NEW.id,
    policy.id,
    definition.id,
    conversation.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.conversation_id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM app_conversations conversation
  JOIN app_notification_policies policy ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = 'message.platform_reply'
   AND definition.active = 1
  WHERE conversation.id = NEW.conversation_id;
END;

CREATE TRIGGER app_notification_from_membership_application_event
AFTER INSERT ON app_membership_application_events
WHEN NEW.event_type IN ('information_requested', 'rejected', 'expired', 'cancelled')
  AND (NEW.event_type <> 'cancelled' OR NEW.actor_type <> 'viewer')
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_' || NEW.id,
    policy.id,
    definition.id,
    application.user_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.application_id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM app_membership_applications application
  JOIN app_notification_policies policy ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = CASE NEW.event_type
     WHEN 'information_requested' THEN 'membership.application_information_requested'
     WHEN 'rejected' THEN 'membership.application_rejected'
     WHEN 'expired' THEN 'membership.application_expired'
     ELSE 'membership.application_cancelled'
   END
   AND definition.active = 1
  WHERE application.id = NEW.application_id;
END;

CREATE TRIGGER app_notification_from_membership_grant
AFTER INSERT ON app_membership_grants
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_' || NEW.id,
    policy.id,
    definition.id,
    NEW.user_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM app_notification_policies policy
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = 'membership.granted'
   AND definition.active = 1
  WHERE policy.generation_enabled = 1;
END;

CREATE TRIGGER app_notification_from_membership_revocation
AFTER INSERT ON app_membership_grant_revocations
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_rev_' || NEW.grant_id,
    policy.id,
    definition.id,
    grant_row.user_id,
    definition.event_type,
    NEW.grant_id || '.revoked',
    definition.target_type,
    NEW.grant_id,
    'pending',
    0,
    NEW.revoked_at,
    NEW.revoked_at
  FROM app_membership_grants grant_row
  JOIN app_notification_policies policy ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = 'membership.revoked'
   AND definition.active = 1
  WHERE grant_row.id = NEW.grant_id;
END;

CREATE TRIGGER app_notification_from_safety_report_event
AFTER INSERT ON app_safety_report_events
WHEN NEW.event_type IN ('actioned', 'no_violation', 'closed')
  AND NEW.actor_type <> 'viewer'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_' || NEW.id,
    policy.id,
    definition.id,
    report.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.report_id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM app_safety_reports report
  JOIN app_notification_policies policy ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = CASE NEW.event_type
     WHEN 'actioned' THEN 'safety.report_actioned'
     WHEN 'no_violation' THEN 'safety.report_no_violation'
     ELSE 'safety.report_closed'
   END
   AND definition.active = 1
  WHERE report.id = NEW.report_id;
END;

CREATE TRIGGER app_notification_from_safety_appeal_event
AFTER INSERT ON app_safety_appeal_events
WHEN NEW.event_type IN ('upheld', 'changed', 'closed')
  AND NEW.actor_type <> 'viewer'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_' || NEW.id,
    policy.id,
    definition.id,
    appeal.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.appeal_id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM app_safety_appeals appeal
  JOIN app_notification_policies policy ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = CASE NEW.event_type
     WHEN 'upheld' THEN 'safety.appeal_upheld'
     WHEN 'changed' THEN 'safety.appeal_changed'
     ELSE 'safety.appeal_closed'
   END
   AND definition.active = 1
  WHERE appeal.id = NEW.appeal_id;
END;

CREATE TRIGGER app_notification_from_account_security_event
AFTER INSERT ON app_account_security_events
WHEN NEW.account_id IS NOT NULL
  AND NEW.event_type IN ('session_logged_in', 'device_revoked', 'refresh_token_reuse_detected')
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_' || NEW.id,
    policy.id,
    definition.id,
    NEW.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM app_notification_policies policy
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = CASE NEW.event_type
     WHEN 'session_logged_in' THEN 'account.session_logged_in'
     WHEN 'device_revoked' THEN 'account.device_revoked'
     ELSE 'account.refresh_token_reuse_detected'
   END
   AND definition.active = 1
  WHERE policy.generation_enabled = 1;
END;
