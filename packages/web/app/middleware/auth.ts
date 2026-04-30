/**
 * 认证中间件：要求用户已登录
 * 用法：definePageMeta({ middleware: 'auth' })
 */
export default defineNuxtRouteMiddleware(async (_to, _from) => {
  // TODO: 实现认证检查
  // const { user } = useAuth()
  // if (!user.value) {
  //   return navigateTo('/login')
  // }
})
