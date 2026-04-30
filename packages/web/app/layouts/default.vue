<script setup lang="ts">
const { isLoggedIn, isAdmin, user, logout } = useAuth()
</script>

<template>
  <div class="min-h-screen flex flex-col bg-gray-50">
    <!-- 顶部导航 -->
    <header class="sticky top-0 z-40 bg-white border-b border-gray-200">
      <nav class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex h-14 items-center justify-between">
          <!-- 左侧 Logo + 导航 -->
          <div class="flex items-center gap-6">
            <NuxtLink to="/" class="text-lg font-bold text-gray-900">MeiGallery</NuxtLink>
            <div class="hidden sm:flex items-center gap-4">
              <NuxtLink to="/" class="text-sm text-gray-600 hover:text-gray-900">首页</NuxtLink>
              <NuxtLink to="/tags" class="text-sm text-gray-600 hover:text-gray-900">标签</NuxtLink>
              <NuxtLink to="/search" class="text-sm text-gray-600 hover:text-gray-900">搜索</NuxtLink>
            </div>
          </div>

          <!-- 右侧用户区 -->
          <div class="flex items-center gap-3">
            <template v-if="isLoggedIn">
              <NuxtLink v-if="isAdmin" to="/admin" class="text-sm text-gray-600 hover:text-gray-900">管理后台</NuxtLink>
              <NuxtLink to="/user" class="text-sm text-gray-600 hover:text-gray-900">
                {{ user?.nickname || user?.email }}
              </NuxtLink>
              <button class="text-sm text-gray-500 hover:text-gray-700" @click="logout">退出</button>
            </template>
            <template v-else>
              <NuxtLink to="/login" class="text-sm text-gray-600 hover:text-gray-900">登录</NuxtLink>
              <NuxtLink to="/register" class="rounded-full bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700">注册</NuxtLink>
            </template>
          </div>
        </div>
      </nav>
    </header>

    <!-- 主内容 -->
    <main class="flex-1">
      <slot />
    </main>

    <!-- 底部 -->
    <footer class="border-t border-gray-200 bg-white py-6">
      <div class="mx-auto max-w-7xl px-4 text-center text-sm text-gray-500">
        &copy; {{ new Date().getFullYear() }} MeiGallery. All rights reserved.
      </div>
    </footer>

    <!-- 移动端底部导航 -->
    <nav class="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200">
      <div class="flex justify-around py-2">
        <NuxtLink to="/" class="flex flex-col items-center text-xs text-gray-600">
          <svg class="w-5 h-5 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
          首页
        </NuxtLink>
        <NuxtLink to="/tags" class="flex flex-col items-center text-xs text-gray-600">
          <svg class="w-5 h-5 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/></svg>
          标签
        </NuxtLink>
        <NuxtLink to="/search" class="flex flex-col items-center text-xs text-gray-600">
          <svg class="w-5 h-5 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          搜索
        </NuxtLink>
        <NuxtLink :to="isLoggedIn ? '/user' : '/login'" class="flex flex-col items-center text-xs text-gray-600">
          <svg class="w-5 h-5 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
          我的
        </NuxtLink>
      </div>
    </nav>
  </div>
</template>
