import type { UserInfo } from '~/types'

/**
 * 认证状态 composable
 * 提供当前用户信息和认证操作
 */
export function useAuth() {
  const user = useState<UserInfo | null>('auth:user', () => null)
  const loading = useState<boolean>('auth:loading', () => false)

  /**
   * 获取当前用户信息
   */
  async function fetchUser() {
    try {
      loading.value = true
      const data = await $fetch<UserInfo>('/api/me')
      user.value = data
    }
    catch {
      user.value = null
    }
    finally {
      loading.value = false
    }
  }

  /**
   * 登录
   */
  async function login(email: string, password: string, turnstileToken: string) {
    const data = await $fetch<UserInfo>('/api/auth/login', {
      method: 'POST',
      body: { email, password, turnstileToken },
    })
    user.value = data
    return data
  }

  /**
   * 登出
   */
  async function logout() {
    await $fetch('/api/auth/logout', { method: 'POST' })
    user.value = null
    await navigateTo('/')
  }

  /**
   * 检查用户是否已登录
   */
  const isLoggedIn = computed(() => !!user.value)

  /**
   * 检查用户是否为管理员
   */
  const isAdmin = computed(
    () => !!user.value && ['admin', 'owner'].includes(user.value.role),
  )

  /**
   * 检查用户是否为站长
   */
  const isOwner = computed(
    () => !!user.value && user.value.role === 'owner',
  )

  return {
    user: readonly(user),
    loading: readonly(loading),
    isLoggedIn,
    isAdmin,
    isOwner,
    fetchUser,
    login,
    logout,
  }
}
