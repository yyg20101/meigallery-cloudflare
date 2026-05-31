import { normalizePublicSettingUrl } from './public-setting-url'

export function normalizeHomeAdUrl(value: unknown) {
  return normalizePublicSettingUrl(value, '首页广告链接')
}
