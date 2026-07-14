/** 联系平台配置 */
export interface ContactPlatformConfig {
  name: string
  color: string
  supportsQr: boolean
  supportsLink: boolean
  linkTemplate: string | null
  placeholder: string
  linkHint: string
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
    linkHint: '微信个人号未发现官方公开网页跳转方案，前台点击默认复制微信号。',
  },
  qq: {
    name: 'QQ',
    color: '#12B7F5',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://wpa.qq.com/msgrd?v=3&uin={value}&site=qq',
    placeholder: 'QQ 号',
    linkHint: 'QQ 可尝试打开网页临时会话；若客户端不支持，用户仍可复制 QQ 号。',
  },
  telegram: {
    name: 'Telegram',
    color: '#26A5E4',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://telegram.me/{value}',
    placeholder: '用户名（不含 @）',
    linkHint: 'Telegram 用户名自动生成 telegram.me 链接；手动填写的完整链接保持原样。',
  },
  whatsapp: {
    name: 'WhatsApp',
    color: '#25D366',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://wa.me/{value}',
    placeholder: '手机号（含国际区号，如 8613800138000）',
    linkHint: 'WhatsApp 官方支持 wa.me 点击聊天链接，需填写含国家码的手机号。',
  },
  line: {
    name: 'Line',
    color: '#06C755',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://line.me/R/ti/p/{value}',
    placeholder: 'Line ID（官方账号通常含 @）',
    linkHint: 'LINE 官方账号支持 line.me/R/ti/p/ 链接；普通个人号建议同时上传二维码。',
  },
  email: {
    name: '邮箱',
    color: '#EA4335',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'mailto:{value}',
    placeholder: '邮箱地址',
    linkHint: '邮箱使用标准 mailto 链接打开本机邮件客户端。',
  },
  facebook: {
    name: 'Facebook',
    color: '#1877F2',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://m.me/{value}',
    placeholder: '用户名或主页 ID',
    linkHint: 'Facebook 主页可使用 m.me 打开 Messenger 会话。',
  },
  twitter: {
    name: 'Twitter / X',
    color: '#000000',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://x.com/{value}',
    placeholder: '用户名（不含 @）',
    linkHint: 'X 用户名可打开公开主页；私信能力取决于账号设置。',
  },
  instagram: {
    name: 'Instagram',
    color: '#E4405F',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://instagram.com/{value}',
    placeholder: '用户名',
    linkHint: 'Instagram 用户名可打开公开主页；私信能力取决于账号设置。',
  },
  discord: {
    name: 'Discord',
    color: '#5865F2',
    supportsQr: false,
    supportsLink: true,
    linkTemplate: 'https://discord.gg/{value}',
    placeholder: '邀请链接（如 https://discord.gg/abc123）',
    linkHint: 'Discord 仅邀请链接可跳转；普通用户名无法生成官方添加好友链接。',
  },
  xiaohongshu: {
    name: '小红书',
    color: '#FE2C55',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: 'https://www.xiaohongshu.com/user/profile/{value}',
    placeholder: '小红书号或主页 ID',
    linkHint: '小红书可打开用户主页；若不是主页 ID，建议上传二维码并让用户复制。',
  },
  custom: {
    name: '自定义',
    color: '#6B7280',
    supportsQr: true,
    supportsLink: true,
    linkTemplate: null,
    placeholder: '自定义联系值',
    linkHint: '自定义平台不会自动生成链接；需要跳转时请手动填写完整 URL。',
  },
}

/** 所有支持的平台 key 列表 */
export const CONTACT_PLATFORM_KEYS = Object.keys(CONTACT_PLATFORMS)

function stripUrlPrefix(value: string, patterns: RegExp[]): string {
  return patterns.reduce((next, pattern) => next.replace(pattern, ''), value.trim())
}

function stripLeadingAt(value: string): string {
  return value.trim().replace(/^@+/, '')
}

function normalizeContactLinkValue(platform: string, value: string): string | null {
  const rawValue = value.trim()
  if (!rawValue) return null

  switch (platform) {
    case 'telegram': {
      const username = stripLeadingAt(stripUrlPrefix(rawValue, [
        /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i,
        /^(?:www\.)?(?:t\.me|telegram\.me)\//i,
      ]))
      return username ? encodeURIComponent(username) : null
    }
    case 'whatsapp': {
      const phone = rawValue.replace(/[^\d]/g, '')
      return phone ? phone : null
    }
    case 'line': {
      const lineId = stripUrlPrefix(rawValue, [/^https?:\/\/line\.me\/R\/ti\/p\//i, /^https?:\/\/line\.me\/ti\/p\/~?/i, /^line\.me\/R\/ti\/p\//i, /^line\.me\/ti\/p\/~?/i])
      return lineId ? encodeURIComponent(lineId) : null
    }
    case 'email': {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawValue) ? rawValue : null
    }
    case 'facebook': {
      const pageId = stripUrlPrefix(rawValue, [/^https?:\/\/(?:www\.)?facebook\.com\//i, /^https?:\/\/m\.me\//i, /^m\.me\//i])
      return pageId ? encodeURIComponent(pageId.replace(/^\/+|\/+$/g, '')) : null
    }
    case 'twitter':
    case 'instagram': {
      const username = stripLeadingAt(stripUrlPrefix(rawValue, [
        /^https?:\/\/(?:www\.)?x\.com\//i,
        /^https?:\/\/(?:www\.)?twitter\.com\//i,
        /^https?:\/\/(?:www\.)?instagram\.com\//i,
      ])).replace(/^\/+|\/+$/g, '')
      return username ? encodeURIComponent(username) : null
    }
    case 'discord': {
      if (!/^(https?:\/\/)?(discord\.gg|(?:www\.)?discord\.com\/invite)\//i.test(rawValue)) return null
      const inviteCode = stripUrlPrefix(rawValue, [/^https?:\/\/discord\.gg\//i, /^https?:\/\/(?:www\.)?discord\.com\/invite\//i, /^discord\.gg\//i, /^(?:www\.)?discord\.com\/invite\//i])
      return inviteCode ? encodeURIComponent(inviteCode.replace(/^\/+|\/+$/g, '')) : null
    }
    case 'qq': {
      const qqNumber = rawValue.replace(/[^\d]/g, '')
      return qqNumber ? qqNumber : null
    }
    case 'xiaohongshu': {
      const profileId = stripUrlPrefix(rawValue, [/^https?:\/\/(?:www\.)?xiaohongshu\.com\/user\/profile\//i])
      return profileId ? encodeURIComponent(profileId.replace(/^\/+|\/+$/g, '')) : null
    }
    default:
      return encodeURIComponent(rawValue)
  }
}

/** 根据平台和值生成跳转链接 */
export function generateContactLink(platform: string, value: string): string | null {
  const config = CONTACT_PLATFORMS[platform]
  if (!config || !config.linkTemplate) return null
  if (platform === 'telegram') {
    const explicitLink = value.trim()
    if (/^https:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i.test(explicitLink)) return explicitLink
  }
  const normalizedValue = normalizeContactLinkValue(platform, value)
  if (!normalizedValue) return null
  return config.linkTemplate.replace('{value}', normalizedValue)
}

/** 判断平台和值是否可以自动生成跳转链接 */
export function canGenerateContactLink(platform: string, value: string): boolean {
  return generateContactLink(platform, value) !== null
}
