<script setup lang="ts">
const route = useRoute()
const { user, logout } = useAuth()
const { siteName } = useSiteSettings()
const config = useRuntimeConfig()
const isAppConsole = computed(() => route.path.startsWith('/admin/app'))
const globalSearch = ref('')

const sidebarCollapsed = ref(false)
const sidebarReady = ref(false)
const showDevDataWarning = computed(() =>
  config.public.appEnv === 'dev' || String(config.public.devAdminDataWarning) === 'true',
)

// 响应式：窄屏自动折叠
function checkWidth() {
  if (import.meta.client) {
    sidebarCollapsed.value = window.innerWidth < 1024
  }
}
onMounted(async () => {
  checkWidth()
  await nextTick()
  sidebarReady.value = true
  window.addEventListener('resize', checkWidth)
})
onUnmounted(() => {
  if (import.meta.client) window.removeEventListener('resize', checkWidth)
})

type AdminNavItem = {
  to: string
  label: string
  icon: string
  exact?: boolean
  activePrefix?: string
  activePaths?: string[]
}

const appNavItems: AdminNavItem[] = [
  { to: '/admin/app', label: '运营总览', exact: true, activePaths: ['/admin/app/incidents'], icon: 'grid' },
  {
    to: '/admin/app/persons',
    label: '真人与内容',
    icon: 'users',
    activePaths: ['/admin/app/imports', '/admin/app/verifications', '/admin/app/publications'],
  },
  {
    to: '/admin/app/recommendation/rules',
    label: '发现运营',
    icon: 'chart',
    activePaths: ['/admin/app/taxonomy', '/admin/app/search', '/admin/app/recommendation'],
  },
  {
    to: '/admin/app/conversations',
    label: '平台话题',
    icon: 'message',
    activePaths: ['/admin/app/conversation-groups', '/admin/app/conversation-quality'],
  },
  {
    to: '/admin/app/reviews',
    label: '安全与申诉',
    icon: 'clipboard',
    activePaths: ['/admin/app/safety', '/admin/app/appeals'],
  },
  {
    to: '/admin/app/membership/applications',
    activePrefix: '/admin/app/membership',
    activePaths: [
      '/admin/app/entitlements',
      '/admin/app/wallets',
      '/admin/app/coin-adjustments',
      '/admin/app/coin-adjustment-batches',
      '/admin/app/reconciliation',
    ],
    label: '会员与金币',
    icon: 'ticket',
  },
  { to: '/admin/app/data-rights', label: '数据权利', icon: 'key' },
  {
    to: '/admin/app/notifications',
    label: '通知与审计',
    icon: 'message',
    activePaths: ['/admin/app/audit'],
  },
]

const legacyNavItems: AdminNavItem[] = [
  { to: '/admin', label: '概览', exact: true, icon: 'grid' },
  { to: '/admin/app', label: 'App 运营总览', icon: 'grid' },
  { to: '/admin/galleries', label: '图库管理', icon: 'image' },
  { to: '/admin/app/persons', label: 'App 人物供给', icon: 'users' },
  { to: '/admin/app/taxonomy', label: 'App 分类目录', icon: 'tag' },
  { to: '/admin/app/search', label: 'App 搜索运营', icon: 'refresh' },
  { to: '/admin/app/recommendation/rules', label: 'App 推荐运营', icon: 'chart' },
  { to: '/admin/app/conversations', label: 'App 平台话题', icon: 'message' },
  { to: '/admin/app/conversation-groups', label: 'App 话题排班', icon: 'users' },
  { to: '/admin/app/conversation-quality', label: 'App 话题质检', icon: 'clipboard' },
  { to: '/admin/app/notifications', label: 'App 站内通知', icon: 'message' },
  { to: '/admin/app/wallets', label: 'App 金币钱包', icon: 'ticket' },
  {
    to: '/admin/app/membership/applications',
    activePrefix: '/admin/app/membership',
    activePaths: ['/admin/app/entitlements'],
    label: 'App 会员运营',
    icon: 'ticket',
  },
  { to: '/admin/app/safety', label: 'App 安全审核', icon: 'clipboard' },
  { to: '/admin/app/appeals', label: 'App 申诉复核', icon: 'clipboard' },
  { to: '/admin/app/data-rights', label: 'App 数据权利', icon: 'clipboard' },
  { to: '/admin/tags', label: '标签管理', icon: 'tag' },
  { to: '/admin/users', label: '会员管理', icon: 'users' },
  { to: '/admin/app/imports', label: '导入任务', icon: 'upload' },
  { to: '/admin/import-api-tokens', label: '导入 Token', icon: 'key' },
  { to: '/admin/external-import-records', label: '外部导入', icon: 'clipboard' },
  { to: '/admin/legacy-import', label: '旧站迁移', icon: 'refresh' },
  { to: '/admin/cases', label: '真实案例', icon: 'message' },
  { to: '/admin/ads', label: '广告位', icon: 'megaphone' },
  { to: '/admin/analytics', label: '数据分析', icon: 'chart' },
  { to: '/admin/attribution', label: '广告归因', icon: 'chart' },
  { to: '/admin/invite-codes', label: '邀请码', icon: 'ticket' },
  { to: '/admin/settings', label: '站点设置', icon: 'gear' },
  { to: '/admin/contact-methods', label: '联系方式', icon: 'message' },
  { to: '/admin/app/audit', label: 'App 审计与完整性', icon: 'clipboard' },
]

const navItems = computed(() => isAppConsole.value ? appNavItems : legacyNavItems)

function isActive(item: AdminNavItem) {
  if (item.exact) {
    return route.path === item.to
      || item.activePaths?.some(path => route.path.startsWith(path)) === true
  }
  return route.path.startsWith(item.activePrefix || item.to)
    || item.activePaths?.some(path => route.path.startsWith(path)) === true
}

const pageTitle = computed(() => {
  // 逆序匹配最长前缀
  const matched = [...navItems.value].reverse().find(n => isActive(n))
  return matched?.label ?? '后台管理'
})

function submitGlobalSearch() {
  const query = globalSearch.value.trim()
  if (!query) return
  navigateTo({ path: '/admin/app/search', query: { query } })
}

async function handleLogout() {
  await logout()
  navigateTo('/login')
}
</script>

<template>
  <div data-admin-layout :data-admin-app-layout="isAppConsole || undefined" class="flex min-h-screen min-w-0">
    <aside
      :class="[
        'flex shrink-0 flex-col text-stone-300',
        isAppConsole ? 'bg-[#2f2622]' : 'bg-[#111]',
        sidebarReady ? 'transition-all duration-200' : '',
        sidebarCollapsed ? 'w-14' : isAppConsole ? 'w-[236px]' : 'w-48',
      ]"
    >
      <div :class="['flex min-h-16 items-center justify-between gap-3 px-4', isAppConsole ? 'border-b border-white/5' : 'border-b border-gray-700']">
        <NuxtLink v-if="!sidebarCollapsed" :to="isAppConsole ? '/admin/app' : '/admin'" class="flex min-w-0 items-center gap-3 truncate text-sm font-bold text-white">
          <span v-if="isAppConsole" class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#f25182] to-[#c92558] font-serif text-base italic text-white shadow-lg shadow-rose-950/20">M</span>
          <span class="truncate">{{ isAppConsole ? 'MeiGallery 控制台' : `${siteName} 管理` }}</span>
        </NuxtLink>
        <button class="shrink-0 rounded-md p-1 text-stone-400 hover:bg-white/10 hover:text-white" :aria-label="sidebarCollapsed ? '展开后台侧栏' : '折叠后台侧栏'" @click="sidebarCollapsed = !sidebarCollapsed">
          <svg v-if="sidebarCollapsed" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
      </div>
      <p v-if="isAppConsole && !sidebarCollapsed" class="px-5 pb-2 pt-3 text-[11px] tracking-wide text-stone-500">开发环境</p>
      <nav :class="['flex-1 overflow-y-auto', isAppConsole ? 'space-y-1 px-3 py-2' : 'py-2']">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          :class="[
            'relative flex min-w-0 items-center gap-3 text-sm transition-colors',
            isAppConsole ? 'min-h-11 rounded-xl px-3 py-2.5' : 'px-3 py-2.5',
            isActive(item)
              ? isAppConsole
                ? 'bg-[#746a65] text-white'
                : 'border-l-2 border-white bg-white/10 text-white'
              : isAppConsole
                ? 'text-stone-400 hover:bg-white/[0.07] hover:text-white'
                : 'border-l-2 border-transparent hover:bg-white/10 hover:text-white',
          ]"
          :title="sidebarCollapsed ? item.label : undefined"
        >
          <span v-if="isAppConsole && isActive(item)" class="absolute -left-3 h-7 w-1 rounded-r-full bg-[#ed4b7d]" />
          <!-- Icons -->
          <svg v-if="item.icon === 'grid'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          <svg v-else-if="item.icon === 'image'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          <svg v-else-if="item.icon === 'tag'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="1"/></svg>
          <svg v-else-if="item.icon === 'users'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          <svg v-else-if="item.icon === 'upload'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <svg v-else-if="item.icon === 'key'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M11 12l9-9"/><path d="M15 4l5 5"/><path d="M18 6l-2 2"/></svg>
          <svg v-else-if="item.icon === 'refresh'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          <svg v-else-if="item.icon === 'gear'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          <svg v-else-if="item.icon === 'message'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          <svg v-else-if="item.icon === 'megaphone'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 11 18-5v12L3 14v-3Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/><path d="M21 12h-3"/></svg>
          <svg v-else-if="item.icon === 'chart'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 15l3-3 3 2 5-7"/><path d="M18 7h-4"/><path d="M18 7v4"/></svg>
          <svg v-else-if="item.icon === 'ticket'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9a3 3 0 0 0 0 6v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a3 3 0 0 0 0-6V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>
          <svg v-else-if="item.icon === 'clipboard'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>
          <span v-if="!sidebarCollapsed" class="min-w-0 truncate">{{ item.label }}</span>
        </NuxtLink>
      </nav>
      <div v-if="isAppConsole && !sidebarCollapsed" class="m-4 rounded-xl bg-[#746a65] px-3 py-3 text-xs leading-5 text-stone-200">
        <p class="truncate font-medium text-white">{{ user?.nickname || user?.email || '当前管理员' }}</p>
        <p class="truncate text-stone-300">{{ user?.role === 'owner' ? 'Owner · 华东运营组' : '管理员 · 当前在线' }}</p>
      </div>
      <div :class="['py-2', isAppConsole ? 'border-t border-white/5' : 'border-t border-gray-700']">
        <NuxtLink
          to="/"
          class="flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-white/10 hover:text-white border-l-2 border-transparent"
        >
          <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
          <span v-if="!sidebarCollapsed">返回前台</span>
        </NuxtLink>
      </div>
    </aside>

    <div data-admin-content class="flex w-0 min-w-0 flex-1 flex-col">
      <header data-admin-header class="min-w-0 border-b border-[#f1e5df] bg-white/95 backdrop-blur">
        <div v-if="showDevDataWarning" data-admin-dev-warning class="min-w-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900 [overflow-wrap:anywhere] sm:px-5 lg:px-8">
          <span class="font-semibold">DEV 测试环境：</span>
          当前后台连接独立 dev D1/R2/Queue 资源，发布、导入、上传、会员和设置修改会影响 dev 测试数据；写操作会弹出二次确认并写入审计日志。
        </div>
        <div data-admin-header-row :class="['flex min-h-16 min-w-0 items-center justify-between gap-4 px-3 sm:px-5 lg:px-10', isAppConsole ? 'py-2' : 'py-3']">
          <div class="min-w-0">
            <p v-if="isAppConsole" class="truncate text-sm text-stone-500">App 运营&nbsp; / &nbsp;{{ pageTitle }}</p>
            <h2 v-else data-admin-header-title class="min-w-0 [overflow-wrap:anywhere] text-base font-semibold text-gray-900">{{ pageTitle }}</h2>
          </div>
          <div class="flex min-w-0 items-center gap-2 text-sm text-gray-600">
            <form v-if="isAppConsole" class="hidden min-w-0 lg:block" role="search" @submit.prevent="submitGlobalSearch">
              <label class="flex min-h-10 w-[280px] min-w-0 items-center gap-2 rounded-xl border border-[#eedbd3] bg-[#fffdfa] px-3 focus-within:border-[#df4a79]">
                <svg class="h-4 w-4 shrink-0 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input v-model="globalSearch" class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-stone-400" placeholder="搜索页面、账号或业务单" />
              </label>
            </form>
            <NuxtLink v-if="isAppConsole" to="/admin/app/notifications" aria-label="查看站内通知" class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#fff7f2] text-stone-600 hover:text-[#d62f65]"><svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></NuxtLink>
            <NuxtLink v-if="isAppConsole" to="/admin/app/audit" aria-label="查看审计信息" class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#fff7f2] text-stone-600 hover:text-[#d62f65]"><svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg></NuxtLink>
            <button v-if="isAppConsole" class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#d62f65] text-sm font-semibold text-white" :title="user?.email || '退出登录'" @click="handleLogout">{{ (user?.nickname || user?.email || 'W').slice(0, 1).toUpperCase() }}</button>
            <template v-else>
              <span v-if="user" class="hidden min-w-0 truncate sm:inline">{{ user.email }}</span>
              <button class="text-gray-500 hover:text-red-600" @click="handleLogout">登出</button>
            </template>
          </div>
        </div>
      </header>
      <main data-admin-main :class="['min-w-0 flex-1', isAppConsole ? 'bg-[#fffaf7] p-4 sm:p-6 lg:p-10' : 'bg-gray-50 p-3 sm:p-5 lg:p-8']">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
[data-admin-app-layout] :deep(.bg-blue-600) {
  background-color: #d62f65;
}

[data-admin-app-layout] :deep(.hover\:bg-blue-700:hover) {
  background-color: #bd2756;
}

[data-admin-app-layout] :deep(.text-blue-600),
[data-admin-app-layout] :deep(.text-blue-700) {
  color: #c53867;
}
</style>
