export default defineNuxtRouteMiddleware(async (to) => {
  const { isLoggedIn, isAdmin, fetchUser } = useAuth()

  // 首次加载尝试获取用户
  if (!isLoggedIn.value) {
    try {
      await fetchUser()
    } catch {
      // 忽略错误
    }
  }

  // 未登录跳转登录
  if (!isLoggedIn.value) {
    return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
  }

  // 非管理员跳转首页
  if (!isAdmin.value) {
    return navigateTo('/')
  }
})
