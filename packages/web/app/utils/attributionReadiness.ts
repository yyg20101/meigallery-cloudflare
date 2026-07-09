const READINESS_SETTING_LABELS: Record<string, string> = {
  analytics_enabled: '站内分析',
  facebook_pixel_enabled: 'Pixel 开关',
  facebook_pixel_id: 'Pixel ID',
  meta_capi_enabled: 'CAPI 开关',
  meta_tracking_mode: 'Meta 模式',
}

export interface ReadinessSettingRow {
  key: string
  label: string
  value: string
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
  return String(value ?? '').trim()
}
