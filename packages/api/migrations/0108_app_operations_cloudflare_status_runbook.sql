-- Operations-3：Cloudflare 官方平台状态检测 Runbook。
--
-- 状态读取使用无需鉴权的官方 Status API，不增加 secret、binding 或环境配置。
-- Runbook 只指导人工处置；公共平台状态不得替代项目账户级错误率、延迟和 R2 失败率遥测。

INSERT INTO app_operational_runbook_versions (
  id, runbook_key, version, title, safe_summary, document_reference,
  domains_json, control_keys_json, minimum_severity, created_origin, created_at
) VALUES (
  'oprb_cloudflare_platform_health_v1',
  'cloudflare_platform_health',
  1,
  'Cloudflare 平台状态异常处置',
  '核对官方状态、受影响服务和项目自身症状；公共状态只作为外部信号，不替代账户级可观测数据，也不自动暂停业务。',
  'docs/app/OPERATIONS_3_CLOUDFLARE_STATUS_INTEGRATION.md#runbook-cloudflare-platform-health',
  '["platform"]',
  '[]',
  'p2',
  'system',
  '2026-08-20T00:00:00.000Z'
);
