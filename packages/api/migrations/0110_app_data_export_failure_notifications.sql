-- Message-7：把 Privacy-2A 的权威导出失败事实接入 Message-3 必要站内通知。
--
-- 只处理系统生成、用户可见且已与失败制品原子收敛的 processing_failed 事件；
-- 不回填历史、不启用通知策略、不暴露 failure_code/R2 key，也不改变注销通知边界。

INSERT INTO app_notification_event_definitions (
  id, policy_id, event_type, category, necessity, preference_key, source_domain,
  target_type, action, schema_version, privacy_level, minimum_client_version,
  template_variable_catalog_json, active, created_at
) VALUES (
  'nde_data_export_failed',
  'ntp_app_1_0_message_3_dev_1',
  'data.export_failed',
  'system_security',
  'required',
  NULL,
  'data_rights',
  'data_task',
  'open_data_task',
  1,
  'sensitive',
  '1.0',
  '[]',
  1,
  '2026-08-20T00:00:00.000Z'
);

INSERT INTO app_notification_template_versions (
  id, event_definition_id, version_code, state, locale, region_scope,
  variable_allowlist_json, title_text, summary_text, body_text, created_at
) VALUES (
  'ntv_data_export_failed_v1',
  'nde_data_export_failed',
  'data-export-failed-v1',
  'development',
  'zh-CN',
  'all',
  '[]',
  '数据副本暂未生成',
  '本次数据副本生成未完成，请查看申请状态和可用下一步。',
  '打开数据权利页面后会重新读取权威申请状态；通知不包含内部错误、对象地址、查询细节或其他账号信息。',
  '2026-08-20T00:00:00.000Z'
);

CREATE TRIGGER app_notification_from_data_export_failed
AFTER INSERT ON app_data_rights_request_events
WHEN NEW.visibility = 'user'
  AND NEW.actor_type = 'system'
  AND NEW.event_type = 'processing_failed'
  AND NEW.status_snapshot = 'failed'
  AND NEW.reason_code = 'private_export_generation_failed'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_drf_' || NEW.id,
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
   AND definition.event_type = 'data.export_failed'
   AND definition.active = 1
  WHERE request.id = NEW.request_id
    AND request.request_type = 'export'
    AND request.status = 'failed'
    AND request.version = NEW.request_version
    AND request.failure_code IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM app_data_rights_export_artifacts artifact
      WHERE artifact.request_id = request.id
        AND artifact.account_id = request.account_id
        AND artifact.status = 'failed'
        AND artifact.failure_code = request.failure_code
        AND artifact.request_version + 1 = NEW.request_version
    );
END;
