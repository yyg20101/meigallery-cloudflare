export default defineNuxtRouteMiddleware(async (to) => {
  if (!to.path.startsWith('/admin')) return

  const { isLoggedIn, isAdmin, fetchUser } = useAuth()

  if (!isLoggedIn.value) {
    try {
      await fetchUser()
    } catch {
      // 未登录时交给下方统一跳转处理。
    }
  }

  if (!isLoggedIn.value) {
    return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
  }

  if (!isAdmin.value) {
    return navigateTo('/')
  }
})
