/**
 * 认证 composable
 * 管理用户状态、登录、注册、登出
 */
export function useAuth() {
  const { api } = useApi()

  interface UserInfo {
    id: string
    email: string
    nickname: string | null
    role: string
    status: string
    membershipRank: number
    membershipExpiry: string | null
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

  async function login(email: string, password: string, turnstileToken?: string) {
    const result = await api<UserInfo>('/api/auth/login', {
      method: 'POST',
      body: { email, password, turnstileToken },
    })
    user.value = result
    return result
  }

  async function register(email: string, password: string, nickname?: string, turnstileToken?: string) {
    const result = await api<UserInfo>('/api/auth/register', {
      method: 'POST',
      body: { email, password, nickname, turnstileToken },
    })
    user.value = result
    return result
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } finally {
      user.value = null
      navigateTo('/')
    }
  }

  return { user, isLoggedIn, isAdmin, isOwner, membershipRank, membershipLevel, membershipExpiry, fetchUser, login, register, logout }
}
