import type { UserInfo } from '@meigallery/shared'

/**
 * 认证状态 composable
 * 通过 API Worker 获取用户信息和执行认证操作
 */
export function useAuth() {
  const config = useRuntimeConfig()
  const apiBase = config.public.apiBaseUrl

  const user = useState<UserInfo | null>('auth:user', () => null)
  const loading = useState<boolean>('auth:loading', () => false)

  async function fetchUser() {
    try {
      loading.value = true
      const data = await $fetch<UserInfo>(`${apiBase}/api/me`, {
        credentials: 'include',
      })
      user.value = data
    } catch {
      user.value = null
    } finally {
      loading.value = false
    }
  }

  async function login(email: string, password: string, turnstileToken: string) {
    const data = await $fetch<UserInfo>(`${apiBase}/api/auth/login`, {
      method: 'POST',
      body: { email, password, turnstileToken },
      credentials: 'include',
    })
    user.value = data
    return data
  }

  async function logout() {
    await $fetch(`${apiBase}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
    user.value = null
    await navigateTo('/')
  }

  const isLoggedIn = computed(() => !!user.value)
  const isAdmin = computed(() => !!user.value && ['admin', 'owner'].includes(user.value.role))
  const isOwner = computed(() => !!user.value && user.value.role === 'owner')

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
