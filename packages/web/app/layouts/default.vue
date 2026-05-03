<script setup lang="ts">
const { isLoggedIn, isAdmin, user, logout } = useAuth()
const { siteName, footerText, videoEnabled } = useSiteSettings()
const route = useRoute()

const searchQuery = ref('')

function onSearch() {
  if (searchQuery.value.trim()) {
    navigateTo(`/search?q=${encodeURIComponent(searchQuery.value.trim())}`)
  }
}

const navLinks = computed(() => {
  const links = [
    { label: '首页', to: '/' },
    { label: '发现', to: '/discover' },
    { label: '标签', to: '/tags' },
    { label: '关于', to: '/about' },
  ]
  if (videoEnabled.value) {
    links.push({ label: '视频', to: '/search?type=video' })
  }
  return links
})

function isActive(to: string) {
  if (to === '/') return route.path === '/'
  return route.fullPath.startsWith(to)
}
</script>

<template>
  <div class="min-h-screen flex flex-col bg-white">
    <!-- 桌面端顶部导航 -->
    <header class="hidden lg:block sticky top-0 z-40 bg-white border-b border-gray-100">
      <nav class="mx-auto max-w-7xl px-6 lg:px-8">
        <div class="flex h-14 items-center justify-between">
          <!-- 左侧 Logo -->
          <NuxtLink to="/" class="text-lg font-bold text-gray-900 tracking-tight">{{ siteName }}</NuxtLink>

          <!-- 中间导航 -->
          <div class="flex items-center gap-6">
            <NuxtLink
              v-for="link in navLinks"
              :key="link.to"
              :to="link.to"
              class="text-sm py-4 transition-colors"
              :class="isActive(link.to)
                ? 'text-gray-900 font-semibold border-b-2 border-gray-900'
                : 'text-gray-500 hover:text-gray-700'"
            >
              {{ link.label }}
            </NuxtLink>
          </div>

          <!-- 右侧：搜索 + 用户 -->
          <div class="flex items-center gap-4">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="搜索图库..."
              class="w-40 bg-gray-100 rounded-lg px-3 py-1.5 text-sm text-gray-700 placeholder-gray-400 outline-none focus:ring-1 focus:ring-gray-300"
              @keydown.enter="onSearch"
            />
            <template v-if="isLoggedIn">
              <NuxtLink v-if="isAdmin" to="/admin" class="text-sm text-gray-500 hover:text-gray-900">管理</NuxtLink>
              <NuxtLink to="/user" class="text-sm text-gray-700 hover:text-gray-900">
                {{ user?.nickname || '我的' }}
              </NuxtLink>
              <button class="text-sm text-gray-400 hover:text-gray-600" @click="logout">退出</button>
            </template>
            <template v-else>
              <NuxtLink to="/login" class="text-sm text-gray-600 hover:text-gray-900">登录</NuxtLink>
            </template>
          </div>
        </div>
      </nav>
    </header>

    <!-- 移动端顶部栏 -->
    <header class="lg:hidden sticky top-0 z-40 bg-white border-b border-gray-100">
      <div class="flex h-12 items-center justify-between px-4">
        <NuxtLink to="/" class="text-lg font-bold text-gray-900">{{ siteName }}</NuxtLink>
        <div class="flex items-center gap-3">
          <!-- 搜索图标 -->
          <NuxtLink to="/search" class="text-gray-600">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.35-4.35"/></svg>
          </NuxtLink>
          <!-- 用户头像 -->
          <NuxtLink :to="isLoggedIn ? '/user' : '/login'" class="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center">
            <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7Z"/></svg>
          </NuxtLink>
        </div>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="flex-1 pb-16 lg:pb-0">
      <slot />
    </main>

    <!-- 全局联系方式 -->
    <ContactPanel />

    <!-- 桌面端底部 copyright -->
    <footer class="hidden lg:block">
      <p class="text-xs text-gray-400 text-center py-4">{{ footerText }}</p>
    </footer>

    <!-- 移动端底部 Tab Bar -->
    <nav class="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-100">
      <div class="flex justify-around items-center h-14">
        <!-- 首页 -->
        <NuxtLink to="/" class="flex flex-col items-center gap-0.5" :class="isActive('/') ? 'text-gray-900' : 'text-gray-400'">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m3 12 2-2m0 0 7-7 7 7M5 10v10a1 1 0 0 0 1 1h3m10-11 2 2m-2-2v10a1 1 0 0 1-1 1h-3m-6 0a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1m-6 0h6"/></svg>
          <span class="text-[10px]" :class="isActive('/') ? 'font-medium' : ''">首页</span>
        </NuxtLink>
        <!-- 发现 -->
        <NuxtLink to="/discover" class="flex flex-col items-center gap-0.5" :class="isActive('/discover') ? 'text-gray-900' : 'text-gray-400'">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="m14.5 9.5-5 2 2 5 5-2z"/></svg>
          <span class="text-[10px]" :class="isActive('/discover') ? 'font-medium' : ''">发现</span>
        </NuxtLink>
        <!-- 搜索 -->
        <NuxtLink to="/search" class="flex flex-col items-center gap-0.5" :class="isActive('/search') ? 'text-gray-900' : 'text-gray-400'">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.35-4.35"/></svg>
          <span class="text-[10px]" :class="isActive('/search') ? 'font-medium' : ''">搜索</span>
        </NuxtLink>
        <!-- 我的 -->
        <NuxtLink :to="isLoggedIn ? '/user' : '/login'" class="flex flex-col items-center gap-0.5" :class="isActive('/user') ? 'text-gray-900' : 'text-gray-400'">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7Z"/></svg>
          <span class="text-[10px]" :class="isActive('/user') ? 'font-medium' : ''">我的</span>
        </NuxtLink>
      </div>
    </nav>
  </div>
</template>
