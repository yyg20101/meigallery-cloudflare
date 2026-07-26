const READINESS_SETTING_LABELS: Record<string, string> = {
  analytics_enabled: '站内分析',
  enabled: 'Meta 连接',
  browser_enabled: 'Browser Pixel',
  server_enabled: 'Server API',
  destination_configured: 'Dataset ID',
  mode: 'Meta 模式',
}

export interface ReadinessSettingRow {
  key: string
  label: string
  value: string
}

interface ReadinessVerification {
  [key: string]: unknown
  present?: unknown
  verifiedAt?: unknown
  expiresAt?: unknown
}

interface ReadinessVerifications {
  [key: string]: unknown
  metaLive?: ReadinessVerification
  metaResources?: ReadinessVerification
}

export interface ReadinessVerificationRow {
  key: 'meta_live' | 'meta_resources'
  label: string
  present: boolean
  verifiedAt: string
  expiresAt: string
}

export function serializeReadinessSettingRows(settings: Record<string, unknown>): ReadinessSettingRow[] {
  return Object.entries(READINESS_SETTING_LABELS).map(([key, label]) => ({
    key,
    label,
    value: formatReadinessSettingValue(settings[key]),
  }))
}

function formatReadinessSettingValue(value: unknown) {
  if (typeof value === 'boolean') return value ? '已开启' : '关闭'
  if (value === 'disabled') return '关闭'
  if (value === 'test') return '测试'
  if (value === 'production') return '生产'
  return String(value ?? '').trim()
}

export function serializeReadinessVerificationRows(verifications: ReadinessVerifications): ReadinessVerificationRow[] {
  return [
    serializeVerification('meta_live', 'Meta live 验证', verifications.metaLive),
    serializeVerification('meta_resources', 'Meta 资源验证', verifications.metaResources),
  ]
}

function serializeVerification(
  key: ReadinessVerificationRow['key'],
  label: string,
  verification: ReadinessVerification | undefined,
): ReadinessVerificationRow {
  return {
    key,
    label,
    present: verification?.present === true,
    verifiedAt: String(verification?.verifiedAt ?? '').trim(),
    expiresAt: String(verification?.expiresAt ?? '').trim(),
  }
}
