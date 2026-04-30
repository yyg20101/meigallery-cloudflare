/**
 * 管理员中间件：要求用户为 admin 或 owner 角色
 * 用法：definePageMeta({ middleware: ['auth', 'admin'] })
 */
export default defineNuxtRouteMiddleware(async (_to, _from) => {
  // TODO: 实现管理员权限检查
  // const { user } = useAuth()
  // if (!user.value || !['admin', 'owner'].includes(user.value.role)) {
  //   return navigateTo('/')
  // }
})
