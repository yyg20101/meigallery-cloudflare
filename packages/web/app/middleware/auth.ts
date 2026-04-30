export default defineNuxtRouteMiddleware(async (to) => {
  const { isLoggedIn, fetchUser } = useAuth()

  // 首次加载可能没有用户状态，尝试获取
  if (!isLoggedIn.value) {
    try {
      await fetchUser()
    } catch {
      // 忽略错误
    }
  }

  // 仍然未登录，跳转到登录页
  if (!isLoggedIn.value) {
    return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
  }
})
