<script setup lang="ts">
const route = useRoute()
const { user, logout } = useAuth()

const sidebarCollapsed = ref(false)

// 响应式：窄屏自动折叠
function checkWidth() {
  if (import.meta.client) {
    sidebarCollapsed.value = window.innerWidth < 1024
  }
}
onMounted(() => {
  checkWidth()
  window.addEventListener('resize', checkWidth)
})
onUnmounted(() => {
  if (import.meta.client) window.removeEventListener('resize', checkWidth)
})

const navItems = [
  { to: '/admin', label: '概览', exact: true, icon: 'grid' },
  { to: '/admin/galleries', label: '图库管理', icon: 'image' },
  { to: '/admin/tags', label: '标签管理', icon: 'tag' },
  { to: '/admin/users', label: '会员管理', icon: 'users' },
  { to: '/admin/import', label: '导入任务', icon: 'upload' },
  { to: '/admin/legacy-import', label: '旧站迁移', icon: 'refresh' },
  { to: '/admin/settings', label: '站点设置', icon: 'gear' },
  { to: '/admin/contact-methods', label: '联系方式', icon: 'message' },
  { to: '/admin/audit-logs', label: '审计日志', icon: 'clipboard' },
]

function isActive(item: { to: string; exact?: boolean }) {
  if (item.exact) return route.path === item.to
  return route.path.startsWith(item.to)
}

const pageTitle = computed(() => {
  // 逆序匹配最长前缀
  const matched = [...navItems].reverse().find(n => isActive(n))
  return matched?.label ?? '后台管理'
})

async function handleLogout() {
  await logout()
  navigateTo('/login')
}
</script>

<template>
  <div class="flex min-h-screen">
    <aside
      :class="[
        'bg-[#111] text-gray-300 flex flex-col shrink-0 transition-all duration-200',
        sidebarCollapsed ? 'w-14' : 'w-48',
      ]"
    >
      <div class="p-4 border-b border-gray-700 flex items-center justify-between">
        <NuxtLink v-if="!sidebarCollapsed" to="/admin" class="text-white text-sm font-bold truncate">
          MeiGallery 管理
        </NuxtLink>
        <button class="text-gray-400 hover:text-white p-1" @click="sidebarCollapsed = !sidebarCollapsed">
          <svg v-if="sidebarCollapsed" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
      </div>
      <nav class="flex-1 py-2">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          :class="[
            'flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-white/10 hover:text-white transition-colors',
            isActive(item) ? 'bg-white/10 text-white border-l-2 border-white' : 'border-l-2 border-transparent',
          ]"
          :title="sidebarCollapsed ? item.label : undefined"
        >
          <!-- Icons -->
          <svg v-if="item.icon === 'grid'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          <svg v-else-if="item.icon === 'image'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          <svg v-else-if="item.icon === 'tag'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="1"/></svg>
          <svg v-else-if="item.icon === 'users'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          <svg v-else-if="item.icon === 'upload'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <svg v-else-if="item.icon === 'refresh'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          <svg v-else-if="item.icon === 'gear'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          <svg v-else-if="item.icon === 'message'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          <svg v-else-if="item.icon === 'clipboard'" class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>
          <span v-if="!sidebarCollapsed" class="truncate">{{ item.label }}</span>
        </NuxtLink>
      </nav>
      <div class="py-2 border-t border-gray-700">
        <NuxtLink
          to="/"
          class="flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-white/10 hover:text-white border-l-2 border-transparent"
        >
          <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
          <span v-if="!sidebarCollapsed">返回前台</span>
        </NuxtLink>
      </div>
    </aside>

    <div class="flex-1 flex flex-col overflow-x-hidden">
      <header class="px-8 py-3 border-b border-gray-200 bg-white flex items-center justify-between">
        <h2 class="text-base font-semibold text-gray-900">{{ pageTitle }}</h2>
        <div class="flex items-center gap-4 text-sm text-gray-600">
          <span v-if="user">{{ user.email }}</span>
          <button class="text-gray-500 hover:text-red-600" @click="handleLogout">登出</button>
        </div>
      </header>
      <main class="flex-1 p-8 bg-gray-50">
        <slot />
      </main>
    </div>
  </div>
</template>
