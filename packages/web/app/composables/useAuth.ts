/**
 * 认证 composable
 * 管理用户状态、登录、注册、登出、验证码、密码重置
 */
import type { AnalyticsConsentState, MetaPixelInstruction } from '@meigallery/shared'

type RegistrationAttributionContext = {
  visitorId?: string
  sessionId?: string
  occurredAt?: string
  routeName?: string
  path?: string
  sourceChannel?: string
  sourceName?: string
  trackingSourceSlug?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  consentState?: AnalyticsConsentState
  browserIdentifiers?: unknown
}

export function useAuth() {
  const { api } = useApi()

  interface UserInfo {
    id: number
    email: string
    username: string | null
    nickname: string | null
    avatarKey: string | null
    role: string
    status: string
    notificationEnabled: boolean
    createdAt: string
    membershipRank: number
    membershipExpiry: string | null
    membershipName: string | null
  }

  const user = useState<UserInfo | null>('auth-user', () => null)

  const isLoggedIn = computed(() => !!user.value)
  const isAdmin = computed(() => user.value?.role === 'admin' || user.value?.role === 'owner')
  const isOwner = computed(() => user.value?.role === 'owner')
  const membershipRank = computed(() => user.value?.membershipRank ?? 0)
  const membershipLevel = computed(() => {
    const rank = membershipRank.value
    if (rank >= 20) return 'svip'
    if (rank >= 10) return 'vip'
    return 'free'
  })
  const membershipExpiry = computed(() => user.value?.membershipExpiry ?? null)

  async function fetchUser() {
    try {
      user.value = await api<UserInfo>('/api/me')
    } catch {
      user.value = null
    }
  }

  /**
   * 登录（支持用户名或邮箱）
   * @param identifier 用户名或邮箱
   */
  async function login(identifier: string, password: string, turnstileToken?: string) {
    const result = await api<UserInfo>('/api/auth/login', {
      method: 'POST',
      body: { identifier, password, turnstileToken },
    })
    user.value = result
    return result
  }

  /** 检查用户名可用性 */
  async function checkUsername(username: string) {
    return await api<{ available: boolean; error?: string }>(`/api/auth/check-username/${encodeURIComponent(username)}`)
  }

  /** 发送验证码 */
  async function sendCode(email: string, purpose: 'register' | 'password_reset', turnstileToken?: string) {
    return await api<{ message: string; cooldown: number }>('/api/auth/send-code', {
      method: 'POST',
      body: { email, purpose, turnstileToken },
    })
  }

  /** 注册（含用户名，验证码可选——取决于后端开关） */
  async function register(params: {
    email: string
    password: string
    username: string
    nickname?: string
    code?: string
    inviteCode?: string
    analyticsVisitorId?: string
    analyticsSessionId?: string
    sourceChannel?: string
    landingPath?: string
    turnstileToken?: string
    attribution?: RegistrationAttributionContext
  }) {
    const result = await api<UserInfo & { pixelEvents: MetaPixelInstruction[] }>('/api/auth/register', {
      method: 'POST',
      body: params,
    })
    user.value = result
    return result
  }

  /** 密码重置 */
  async function resetPassword(email: string, code: string, newPassword: string) {
    return await api<{ message: string }>('/api/auth/reset-password', {
      method: 'POST',
      body: { email, code, newPassword },
    })
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } finally {
      user.value = null
      navigateTo('/')
    }
  }

  return {
    user, isLoggedIn, isAdmin, isOwner,
    membershipRank, membershipLevel, membershipExpiry,
    fetchUser, login, checkUsername, sendCode, register, resetPassword, logout,
  }
}
