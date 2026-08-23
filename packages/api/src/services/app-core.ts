import type {
  AppRuntimePolicy,
  AppSupportCenter,
  AppSupportTopic,
} from '@meigallery/shared'
import { generateContactLink } from '@meigallery/shared/constants'
import type { Bindings } from '../index'
import { safeContactLinkUrl } from '../utils/contact-link-url'
import { safePublicSettingUrl } from '../utils/public-setting-url'
import { getAppAuthRuntimeConfig } from './app-account-access'

export const APP_SUPPORT_CONTENT_VERSION = 'app_core_help_2'
export const APP_SUPPORT_CENTER_PATH = '/api/v2/app/support' as const

const DEFAULT_RUNTIME_POLICY_VERSION = 'app_core_default_1'
const CONFIGURATION_UNAVAILABLE_POLICY_VERSION = 'app_core_configuration_unavailable_1'
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/u
const CLIENT_VERSION = /^\d{1,5}\.\d{1,5}(?:\.\d{1,5})?$/u
const COUNTRY_CODE = /^[A-Z]{2}$/u

type RuntimeBindings = Pick<
  Bindings,
  | 'APP_ENV'
  | 'APP_RUNTIME_ENABLED'
  | 'APP_RUNTIME_PRODUCTION_READY'
  | 'APP_RUNTIME_POLICY_VERSION'
  | 'APP_RUNTIME_SERVICE_MODE'
  | 'APP_RUNTIME_MINIMUM_CLIENT_VERSION'
  | 'APP_RUNTIME_LATEST_CLIENT_VERSION'
  | 'APP_RUNTIME_UPGRADE_URL'
  | 'APP_RUNTIME_STATUS_URL'
  | 'APP_RUNTIME_RETRY_AFTER_SECONDS'
  | 'APP_RUNTIME_ALLOWED_COUNTRIES'
  | 'APP_RUNTIME_REGION_UNAVAILABLE_REASON'
>

const SUPPORT_TOPICS: AppSupportTopic[] = [
  {
    topicId: 'help_account_devices',
    category: 'platform',
    categoryLabel: '账号与设备',
    title: '登录、验证与远程退出',
    summary: '账号安全状态和远程退出均以服务端实时结果为准。',
    sections: [
      {
        heading: '登录与验证',
        body: '验证码、密码和当前设备状态由服务端校验；不要向任何人提供验证码或密码。',
      },
      {
        heading: '设备管理',
        body: '可查看已登录设备，并让其他设备退出。高风险操作可能要求重新验证。',
      },
      {
        heading: '异常处理',
        body: '发现陌生设备时先远程退出并修改密码；无法处理时通过帮助中心联系平台。',
      },
    ],
    keywords: ['账号', '登录', '验证码', '密码', '设备', '远程退出'],
    action: null,
  },
  {
    topicId: 'help_membership',
    category: 'membership',
    categoryLabel: '会员与话题',
    title: '人工申请与平台接收',
    summary: '会员由管理员审核发放，人物话题由平台管理员统一接收。',
    sections: [
      {
        heading: '如何获得会员',
        body: 'App 1.0 不提供在线支付。用户可提交站内会员申请或联系平台，最终由管理员按审核结果手动发放等级和有效期。',
      },
      {
        heading: '权限如何生效',
        body: '功能按稳定 entitlement 判断，不按页面显示名称硬编码。会员过期、撤销或目录变化后，相关权限会在服务端重新校验并立即失效。',
      },
      {
        heading: '为什么页面显示但不能使用',
        body: '客户端可以预留未来入口，但只有服务端明确返回可执行能力时才会开放操作；仅展示中的规划权益不代表已经上线。',
      },
    ],
    keywords: ['会员', '等级', '有效期', '权限', '人工申请', '话题', '私信'],
    action: null,
  },
  {
    topicId: 'help_wallet',
    category: 'wallet',
    categoryLabel: '金币与账本',
    title: '管理员调整与申诉',
    summary: '金币只记录管理员加币、扣币、冲正及可追溯申诉。',
    sections: [
      {
        heading: '金币来源',
        body: 'App 1.0 不开放充值、消费、转赠、兑换、提现或支付。金币只能由管理员按已复核业务记录增加、扣减或冲正。',
      },
      {
        heading: '如何核对',
        body: '余额和明细以服务端追加式账本为准。每条调整应显示方向、数量、原因分类、业务编号和必要说明。',
      },
      {
        heading: '发现疑问',
        body: '对账本分录有疑问时，可从对应分录发起申诉；请使用公开业务编号，切勿提交密码或验证码。',
      },
    ],
    keywords: ['金币', '加币', '扣币', '余额', '明细', '冲正'],
    action: null,
  },
  {
    topicId: 'help_safety',
    category: 'safety',
    categoryLabel: '举报与申诉',
    title: '案件进度与独立复核',
    summary: '举报、屏蔽、账号限制与申诉均以服务端案件状态为准。',
    sections: [
      {
        heading: '举报与屏蔽',
        body: '可对支持的对象提交固定原因举报或屏蔽人物。举报结果与可复核范围会在安全中心展示，屏蔽会影响后续推荐和互动。',
      },
      {
        heading: '账号受限',
        body: '受限页面只展示原因分类、影响范围和可执行入口，不公开内部风控规则。未提供站内账号限制申诉时，请通过平台帮助渠道联系。',
      },
      {
        heading: '紧急情况',
        body: '如果涉及现实人身危险或违法行为，请优先联系所在地有权机构；平台帮助渠道不能替代紧急服务。',
      },
    ],
    keywords: ['举报', '屏蔽', '限制', '安全中心', '申诉', '风控'],
    action: null,
  },
  {
    topicId: 'help_data_export',
    category: 'privacy',
    categoryLabel: '数据导出',
    title: '范围、验证与安全下载',
    summary: '导出申请需要二次验证，并按服务端任务状态安全交付。',
    sections: [
      {
        heading: '为什么需要二次验证',
        body: '数据导出涉及本人数据，提交前需要重新验证密码，防止已登录设备被他人滥用。',
      },
      {
        heading: '任务状态',
        body: '申请提交后以服务端状态和截止时间为准。处理能力未开放时，客户端不会声称已经生成导出包。',
      },
      {
        heading: '安全下载',
        body: '导出包只通过短期安全凭证下载；链接到期后需要重新申请，客户端不会长期保存明文下载地址。',
      },
    ],
    keywords: ['隐私', '数据导出', '安全下载', '导出包', '二次验证'],
    action: 'open_data_export',
  },
  {
    topicId: 'help_account_deletion',
    category: 'privacy',
    categoryLabel: '注销账号',
    title: '影响、取消阶段与进度',
    summary: '注销会影响访问权限，提交和取消均以服务端状态为准。',
    sections: [
      {
        heading: '提交前确认',
        body: '注销会影响账号、会话和相关服务记录；提交前需要重新验证密码并确认服务端列出的影响。',
      },
      {
        heading: '处理与取消',
        body: '注销进入待处理后普通会话会失效；仍在允许取消窗口时，可使用申请级安全凭证查询或取消本人任务。',
      },
      {
        heading: '完成结果',
        body: '完成时间、保留例外和失败原因以服务端政策及任务状态为准；客户端不会用本地状态宣称已完成删除。',
      },
    ],
    keywords: ['隐私', '账号注销', '删除', '取消注销', '进度', '二次验证'],
    action: 'open_account_deletion',
  },
]

export function getAppRuntimePolicy(
  env: RuntimeBindings,
  requestCountry: string | undefined,
): AppRuntimePolicy {
  if (env.APP_RUNTIME_ENABLED !== 'true') {
    return normalRuntimePolicy(DEFAULT_RUNTIME_POLICY_VERSION, requestCountry)
  }

  const policyVersion = env.APP_RUNTIME_POLICY_VERSION?.trim() ?? ''
  const serviceMode = env.APP_RUNTIME_SERVICE_MODE?.trim() ?? ''
  const minimumVersion = env.APP_RUNTIME_MINIMUM_CLIENT_VERSION?.trim() ?? ''
  const latestVersion = env.APP_RUNTIME_LATEST_CLIENT_VERSION?.trim() ?? ''
  const retryAfterSeconds = parseRetryAfterSeconds(env.APP_RUNTIME_RETRY_AFTER_SECONDS)
  const allowedCountries = parseAllowedCountries(env.APP_RUNTIME_ALLOWED_COUNTRIES)
  const regionUnavailableReason = env.APP_RUNTIME_REGION_UNAVAILABLE_REASON?.trim()
    || 'region_not_supported'
  const productionReady = env.APP_ENV !== 'production'
    || env.APP_RUNTIME_PRODUCTION_READY === 'true'
  const configurationValid = POLICY_VERSION.test(policyVersion)
    && serviceMode in SERVICE_COPY
    && CLIENT_VERSION.test(minimumVersion)
    && CLIENT_VERSION.test(latestVersion)
    && compareClientVersions(latestVersion, minimumVersion) >= 0
    && retryAfterSeconds !== null
    && allowedCountries !== null
    && regionUnavailableReason in REGION_UNAVAILABLE_COPY
    && productionReady

  if (!configurationValid) {
    return unavailableRuntimePolicy(requestCountry)
  }

  const upgradeUrl = safePublicSettingUrl(env.APP_RUNTIME_UPGRADE_URL, 'App 更新地址') || null
  const statusUrl = safePublicSettingUrl(env.APP_RUNTIME_STATUS_URL, 'App 服务状态地址') || null
  const countryCode = normalizeRequestCountry(requestCountry)
  const regionAvailable = allowedCountries!.size === 0
    || (countryCode !== null && allowedCountries!.has(countryCode))
  const copy = SERVICE_COPY[serviceMode as keyof typeof SERVICE_COPY]
  const regionCopy = REGION_UNAVAILABLE_COPY[
    regionUnavailableReason as keyof typeof REGION_UNAVAILABLE_COPY
  ]

  return {
    policyVersion,
    service: {
      mode: serviceMode as AppRuntimePolicy['service']['mode'],
      title: copy.title,
      message: copy.message,
      retryAfterSeconds: retryAfterSeconds!,
      statusUrl,
    },
    client: {
      minimumVersion,
      latestVersion,
      upgradeUrl,
      storeAvailable: upgradeUrl !== null,
    },
    region: regionAvailable
      ? availableRegion(countryCode)
      : {
          available: false,
          countryCode,
          unavailableReason: regionUnavailableReason as AppRuntimePolicy['region']['unavailableReason'],
          title: regionCopy.title,
          message: regionCopy.message,
        },
  }
}

export async function getAppSupportCenter(env: Bindings): Promise<AppSupportCenter> {
  const auth = getAppAuthRuntimeConfig(env)
  const documents = auth.documentVersions && auth.documentUrls
    ? [
        legalDocument('terms', '用户条款', auth.documentVersions.terms, auth.documentUrls.terms),
        legalDocument('privacy', '隐私政策', auth.documentVersions.privacy, auth.documentUrls.privacy),
        legalDocument(
          'platform_operation',
          '平台代运营说明',
          auth.documentVersions.platformOperation,
          auth.documentUrls.platformOperation,
        ),
        legalDocument(
          'eligibility',
          '必要资格说明',
          auth.documentVersions.eligibility,
          auth.documentUrls.eligibility,
        ),
      ]
    : [
        legalDocument('terms', '用户条款', null, null),
        legalDocument('privacy', '隐私政策', null, null),
        legalDocument('platform_operation', '平台代运营说明', null, null),
        legalDocument('eligibility', '必要资格说明', null, null),
      ]

  return {
    contentVersion: APP_SUPPORT_CONTENT_VERSION,
    serviceBoundary: 'MeiGallery 仅展示经平台审核且仍具备公开资格的人物内容；人物消息由平台管理员接收，人物本人不一定入驻或回复。',
    topics: SUPPORT_TOPICS.map(topic => ({
      ...topic,
      sections: topic.sections.map(section => ({ ...section })),
      keywords: [...topic.keywords],
    })),
    contacts: await listSupportContacts(env.DB),
    legalDocuments: documents,
  }
}

const SERVICE_COPY = {
  normal: {
    title: '服务正常',
    message: '当前 App 服务可以正常使用。',
  },
  maintenance: {
    title: '服务维护中',
    message: '平台正在进行必要维护，业务入口暂时关闭。请稍后重新确认服务状态。',
  },
  partial: {
    title: '服务正在恢复',
    message: '平台正在分阶段恢复服务。为避免展示过期状态，业务入口暂时保持关闭。',
  },
} as const

const REGION_UNAVAILABLE_COPY = {
  region_not_supported: {
    title: '当前地区暂不可用',
    message: '依据当前服务政策，此地区暂不提供 App 业务入口。你仍可查看帮助与法律文档。',
  },
  policy_changed: {
    title: '地区服务政策已调整',
    message: '当前地区的服务政策已经变化，App 业务入口暂时关闭。你仍可查看帮助与法律文档。',
  },
} as const

function normalRuntimePolicy(
  policyVersion: string,
  requestCountry: string | undefined,
): AppRuntimePolicy {
  return {
    policyVersion,
    service: {
      mode: 'normal',
      title: SERVICE_COPY.normal.title,
      message: SERVICE_COPY.normal.message,
      retryAfterSeconds: 300,
      statusUrl: null,
    },
    client: {
      minimumVersion: '1.0',
      latestVersion: '1.0',
      upgradeUrl: null,
      storeAvailable: false,
    },
    region: availableRegion(normalizeRequestCountry(requestCountry)),
  }
}

function unavailableRuntimePolicy(requestCountry: string | undefined): AppRuntimePolicy {
  return {
    ...normalRuntimePolicy(CONFIGURATION_UNAVAILABLE_POLICY_VERSION, requestCountry),
    service: {
      mode: 'maintenance',
      title: '服务状态暂不可确认',
      message: '服务端运行策略尚未完成安全配置，业务入口暂时关闭。请稍后重试或查看帮助。',
      retryAfterSeconds: 300,
      statusUrl: null,
    },
  }
}

function availableRegion(countryCode: string | null): AppRuntimePolicy['region'] {
  return {
    available: true,
    countryCode,
    unavailableReason: null,
    title: null,
    message: null,
  }
}

function parseAllowedCountries(value: string | undefined): Set<string> | null {
  const raw = value?.trim() ?? ''
  if (!raw) return new Set()
  const countries = raw.split(',').map(item => item.trim().toUpperCase())
  if (countries.length > 250 || countries.some(country => !COUNTRY_CODE.test(country))) return null
  return new Set(countries)
}

function normalizeRequestCountry(value: string | undefined): string | null {
  const country = value?.trim().toUpperCase() ?? ''
  return COUNTRY_CODE.test(country) ? country : null
}

function parseRetryAfterSeconds(value: string | undefined): number | null {
  const raw = value?.trim() || '300'
  if (!/^\d{1,5}$/u.test(raw)) return null
  const parsed = Number(raw)
  return parsed >= 30 && parsed <= 86_400 ? parsed : null
}

function compareClientVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function legalDocument(
  type: AppSupportCenter['legalDocuments'][number]['type'],
  title: string,
  version: string | null,
  url: string | null,
): AppSupportCenter['legalDocuments'][number] {
  return { type, title, version, url, available: Boolean(version && url) }
}

async function listSupportContacts(db: D1Database): Promise<AppSupportCenter['contacts']> {
  try {
    const result = await db.prepare(`
      SELECT id, platform, label, value, link_url
      FROM contact_methods
      WHERE enabled = 1
      ORDER BY sort_order ASC, created_at ASC
      LIMIT 20
    `).all<{
      id: string
      platform: string
      label: string
      value: string
      link_url: string | null
    }>()

    return result.results
      .filter(row => row.id && row.platform && row.label && row.value)
      .map(row => ({
        contactId: row.id.slice(0, 96),
        platform: row.platform.slice(0, 40),
        label: row.label.slice(0, 80),
        value: row.value.slice(0, 200),
        linkUrl: safeContactLinkUrl(row.link_url)
          || generateContactLink(row.platform, row.value),
      }))
  }
  catch {
    // 帮助主题和法律文档必须在联系方式表暂不可读时继续可用。
    return []
  }
}
