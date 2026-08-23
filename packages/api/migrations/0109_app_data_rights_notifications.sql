-- Message-5：把 Privacy-2 的数据导出完成事实与可恢复的注销取消结果接入站内通知。
--
-- 只激活 0076 已冻结的两个事件定义，不回填历史事件、不启用通知策略，也不改变
-- OQ-020 的 retention / purge 门禁。不可逆注销处理中和完成后的账号继续由 0103
-- 抑制通知副作用；此处只在账号访问已经恢复后生成注销取消通知。

UPDATE app_notification_event_definitions
SET active = 1
WHERE policy_id = 'ntp_app_1_0_message_3_dev_1'
  AND event_type IN ('data.export_ready', 'account.deletion_updated');

INSERT INTO app_notification_template_versions (
  id, event_definition_id, version_code, state, locale, region_scope,
  variable_allowlist_json, title_text, summary_text, body_text, created_at
) VALUES
  (
    'ntv_data_export_ready_v1',
    'nde_data_export_ready',
    'data-export-ready-v1',
    'development',
    'zh-CN',
    'all',
    '[]',
    '数据副本已准备完成',
    '你的数据副本已准备完成，请在有效期内下载。',
    '打开数据权利页面后会重新读取权威申请与副本状态；通知不包含下载凭证、对象地址或导出内容。',
    '2026-08-20T00:00:00.000Z'
  ),
  (
    'ntv_account_deletion_cancelled_v1',
    'nde_account_deletion_updated',
    'account-deletion-cancelled-v1',
    'development',
    'zh-CN',
    'all',
    '[]',
    '账号注销申请已取消',
    '账号访问已恢复，请重新登录并核对申请记录。',
    '打开数据权利页面后会重新读取权威申请状态；通知不代表旧会话、旧设备或访问凭证已经恢复。',
    '2026-08-20T00:00:00.000Z'
  );

-- 导出归档、申请状态和用户可见事件在同一 D1 batch 成功后，由事件事实原子写入 Outbox。
CREATE TRIGGER app_notification_from_data_export_ready
AFTER INSERT ON app_data_rights_request_events
WHEN NEW.visibility = 'user'
  AND NEW.actor_type = 'system'
  AND NEW.event_type = 'export_ready'
  AND NEW.status_snapshot = 'ready'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_drx_' || NEW.id,
    policy.id,
    definition.id,
    request.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.request_id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM app_data_rights_requests request
  JOIN app_notification_policies policy
    ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = 'data.export_ready'
   AND definition.active = 1
  WHERE request.id = NEW.request_id
    AND request.request_type = 'export'
    AND request.status = 'ready'
    AND request.version = NEW.request_version
    AND EXISTS (
      SELECT 1
      FROM app_data_rights_export_artifacts artifact
      WHERE artifact.request_id = request.id
        AND artifact.status = 'ready'
        AND artifact.request_version + 1 = NEW.request_version
    );
END;

-- 注销申请创建后账号立即进入 deletion_pending，0103 会抑制全部新通知。只有已验证取消
-- 把账号安全状态从 deletion_pending 恢复后，才为同一版本的取消事件生成一条必要通知。
CREATE TRIGGER app_notification_from_deletion_access_restored
AFTER UPDATE OF status ON app_account_security
WHEN OLD.status = 'deletion_pending'
  AND NEW.status IN ('active', 'restricted')
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_drc_' || event.id,
    policy.id,
    definition.id,
    request.account_id,
    definition.event_type,
    event.id,
    definition.target_type,
    request.id,
    'pending',
    0,
    event.created_at,
    event.created_at
  FROM app_data_rights_requests request
  JOIN users account
    ON account.id = request.account_id
   AND account.status = request.user_status_before
  JOIN app_data_rights_request_events event
    ON event.request_id = request.id
   AND event.request_version = request.version
   AND event.status_snapshot = 'cancelled'
   AND event.event_type = 'cancelled'
   AND event.visibility = 'user'
  JOIN app_notification_policies policy
    ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = 'account.deletion_updated'
   AND definition.active = 1
  WHERE request.account_id = NEW.account_id
    AND request.request_type = 'deletion'
    AND request.status = 'cancelled'
    AND request.updated_at = NEW.updated_at
    AND request.account_security_status_before = NEW.status
    AND NEW.restriction_reason_code IS request.account_restriction_reason_before
    AND NEW.restricted_until IS request.account_restricted_until_before;
END;
