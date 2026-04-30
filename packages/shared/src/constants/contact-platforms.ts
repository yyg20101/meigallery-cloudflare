/** 联系平台配置 */
export interface ContactPlatformConfig {
  name: string
  color: string
  supportsQr: boolean
  supportsLink: boolean
  linkTemplate: string | null
  placeholder: string
}

/** 支持的联系平台配置 */
export const CONTACT_PLATFORMS: Record<string, ContactPlatformConfig> = {
  wechat: {
    name: '微信',
    color: '#07C160',
    supportsQr: true,
    supportsLink: false,
    linkTemplate: null,
    placeholder: '微信号',
  },
  qq: {
    name: 'QQ',
    color: '#12B7F5',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://wpa.qq.com/msgrd?v=3&uin={value}&site=qq',
    placeholder: 'QQ 号',
  },
  telegram: {
    name: 'Telegram',
    color: '#26A5E4',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://t.me/{value}',
    placeholder: '用户名（不含 @）',
  },
  whatsapp: {
    name: 'WhatsApp',
    color: '#25D366',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://wa.me/{value}',
    placeholder: '手机号（含国际区号，如 8613800138000）',
  },
  line: {
    name: 'Line',
    color: '#06C755',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://line.me/ti/p/~{value}',
    placeholder: 'Line ID',
  },
  email: {
    name: '邮箱',
    color: '#EA4335',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'mailto:{value}',
    placeholder: '邮箱地址',
  },
  facebook: {
    name: 'Facebook',
    color: '#1877F2',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://m.me/{value}',
    placeholder: '用户名或主页 ID',
  },
  twitter: {
    name: 'Twitter / X',
    color: '#000000',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://x.com/{value}',
    placeholder: '用户名（不含 @）',
  },
  instagram: {
    name: 'Instagram',
    color: '#E4405F',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://instagram.com/{value}',
    placeholder: '用户名',
  },
  discord: {
    name: 'Discord',
    color: '#5865F2',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://discord.gg/{value}',
    placeholder: '邀请码（如 abc123）',
  },
  xiaohongshu: {
    name: '小红书',
    color: '#FE2C55',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://www.xiaohongshu.com/user/profile/{value}',
    placeholder: '小红书号或主页 ID',
  },
  custom: {
    name: '自定义',
    color: '#6B7280',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: null,
    placeholder: '自定义联系值',
  },
}

/** 所有支持的平台 key 列表 */
export const CONTACT_PLATFORM_KEYS = Object.keys(CONTACT_PLATFORMS)

/** 根据平台和值生成跳转链接 */
export function generateContactLink(platform: string, value: string): string | null {
  const config = CONTACT_PLATFORMS[platform]
  if (!config || !config.linkTemplate) return null
  return config.linkTemplate.replace('{value}', encodeURIComponent(value))
}
