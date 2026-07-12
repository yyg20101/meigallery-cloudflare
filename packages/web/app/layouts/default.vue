<script setup lang="ts">
const { isLoggedIn, isAdmin, user, logout } = useAuth()
const { siteName, footerText, videoEnabled } = useSiteSettings()
const route = useRoute()
const config = useRuntimeConfig()
const isDevEnvironment = computed(() => config.public.appEnv !== 'production')

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
  <div class="min-h-screen flex flex-col bg-transparent text-gray-950">
    <div v-if="isDevEnvironment" class="fixed right-3 top-16 z-[60] rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 shadow-sm lg:top-20">
      DEV 测试环境
    </div>

    <!-- 桌面端顶部导航 -->
    <header class="hidden lg:block sticky top-0 z-40 border-b border-white/60 bg-white/78 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.75)]">
      <nav class="mx-auto max-w-7xl px-6 lg:px-8">
        <div class="flex h-16 items-center justify-between">
          <!-- 左侧 Logo -->
          <NuxtLink to="/" class="group inline-flex items-baseline gap-2 text-lg font-semibold tracking-tight text-gray-950">
            <span>{{ siteName }}</span>
            <span class="h-1.5 w-1.5 rounded-full bg-[#bfa46a] transition-transform group-hover:scale-150" />
          </NuxtLink>

          <!-- 中间导航 -->
          <div class="flex items-center gap-1 rounded-full border border-gray-100 bg-white/70 p-1 shadow-sm shadow-orange-950/5">
            <NuxtLink
              v-for="link in navLinks"
              :key="link.to"
              :to="link.to"
              class="rounded-full px-4 py-2 text-sm transition-all duration-200"
              :class="isActive(link.to)
                ? 'bg-gray-950 text-white shadow-sm shadow-gray-900/15'
                : 'text-gray-500 hover:bg-orange-50/80 hover:text-gray-950'"
            >
              {{ link.label }}
            </NuxtLink>
          </div>

          <!-- 右侧：搜索 + 用户 -->
          <div class="flex items-center gap-4">
            <div class="relative">
              <svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.35-4.35"/></svg>
              <input
                v-model="searchQuery"
                type="text"
                placeholder="搜索图库..."
                class="w-44 rounded-full border border-gray-100 bg-white/80 py-2 pl-9 pr-3 text-sm text-gray-700 shadow-sm shadow-orange-950/5 outline-none transition-all placeholder:text-gray-400 focus:w-56 focus:border-[#d6c39a] focus:bg-white focus:ring-4 focus:ring-[#f8e7dc]/60"
                @keydown.enter="onSearch"
              />
            </div>
            <template v-if="isLoggedIn">
              <NuxtLink v-if="isAdmin" to="/admin" class="rounded-full px-3 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900">管理</NuxtLink>
              <NuxtLink to="/user" class="rounded-full px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-orange-50 hover:text-gray-950">
                {{ user?.nickname || '我的' }}
              </NuxtLink>
              <button class="rounded-full px-3 py-1.5 text-sm text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700" @click="logout">退出</button>
            </template>
            <template v-else>
              <NuxtLink to="/login" class="rounded-full bg-gray-950 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-gray-900/15 transition-all hover:-translate-y-0.5 hover:bg-gray-800">登录</NuxtLink>
            </template>
          </div>
        </div>
      </nav>
    </header>

    <!-- 移动端顶部栏 -->
    <header class="lg:hidden sticky top-0 z-40 border-b border-white/70 bg-white/82 backdrop-blur-xl">
      <div class="flex h-12 items-center justify-between px-4">
        <NuxtLink to="/" class="inline-flex items-baseline gap-1.5 text-lg font-semibold text-gray-950">
          <span>{{ siteName }}</span><span class="h-1.5 w-1.5 rounded-full bg-[#bfa46a]" />
        </NuxtLink>
        <div class="flex items-center gap-3">
          <!-- 搜索图标 -->
          <NuxtLink to="/search" class="rounded-full bg-white/80 p-2 text-gray-600 shadow-sm ring-1 ring-gray-100" aria-label="打开搜索页">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.35-4.35"/></svg>
          </NuxtLink>
          <!-- 用户头像 -->
          <NuxtLink :to="isLoggedIn ? '/user' : '/login'" class="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-orange-50 to-gray-100 text-gray-600 shadow-sm ring-1 ring-white" :aria-label="isLoggedIn ? '打开个人中心' : '登录账号'">
            <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7Z"/></svg>
          </NuxtLink>
        </div>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0">
      <slot />
    </main>

    <!-- 全局联系方式 -->
    <ContactPanel />
    <MarketingConsentBanner />

    <!-- 桌面端底部 copyright -->
    <footer class="hidden lg:block">
      <p class="text-xs text-gray-400 text-center py-4">{{ footerText }}</p>
    </footer>

    <!-- 移动端底部 Tab Bar -->
    <nav class="lg:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-white/70 bg-white/88 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl shadow-[0_-12px_36px_rgba(17,24,39,0.06)]">
      <div class="flex h-16 items-center justify-around">
        <!-- 首页 -->
        <NuxtLink to="/" class="flex min-w-14 flex-col items-center gap-0.5 rounded-2xl px-2 py-1.5 transition-all" :class="isActive('/') ? 'bg-orange-50 text-gray-950' : 'text-gray-400'">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m3 12 2-2m0 0 7-7 7 7M5 10v10a1 1 0 0 0 1 1h3m10-11 2 2m-2-2v10a1 1 0 0 1-1 1h-3m-6 0a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1m-6 0h6"/></svg>
          <span class="text-[10px]" :class="isActive('/') ? 'font-medium' : ''">首页</span>
        </NuxtLink>
        <!-- 发现 -->
        <NuxtLink to="/discover" class="flex min-w-14 flex-col items-center gap-0.5 rounded-2xl px-2 py-1.5 transition-all" :class="isActive('/discover') ? 'bg-orange-50 text-gray-950' : 'text-gray-400'">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="m14.5 9.5-5 2 2 5 5-2z"/></svg>
          <span class="text-[10px]" :class="isActive('/discover') ? 'font-medium' : ''">发现</span>
        </NuxtLink>
        <!-- 搜索 -->
        <NuxtLink to="/search" class="flex min-w-14 flex-col items-center gap-0.5 rounded-2xl px-2 py-1.5 transition-all" :class="isActive('/search') ? 'bg-orange-50 text-gray-950' : 'text-gray-400'">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.35-4.35"/></svg>
          <span class="text-[10px]" :class="isActive('/search') ? 'font-medium' : ''">搜索</span>
        </NuxtLink>
        <!-- 我的 -->
        <NuxtLink :to="isLoggedIn ? '/user' : '/login'" class="flex min-w-14 flex-col items-center gap-0.5 rounded-2xl px-2 py-1.5 transition-all" :class="isActive('/user') ? 'bg-orange-50 text-gray-950' : 'text-gray-400'">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7Z"/></svg>
          <span class="text-[10px]" :class="isActive('/user') ? 'font-medium' : ''">我的</span>
        </NuxtLink>
      </div>
    </nav>
  </div>
</template>
