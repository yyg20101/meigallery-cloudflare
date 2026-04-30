<script setup lang="ts">
</script>

<template>
  <div class="flex min-h-screen">
    <aside class="w-60 bg-gray-900 text-gray-300 flex flex-col shrink-0">
      <div class="p-6 border-b border-gray-700">
        <NuxtLink to="/admin" class="text-white text-lg font-bold">
          MeiGallery 管理
        </NuxtLink>
      </div>
      <nav class="flex-1 py-4">
        <NuxtLink to="/admin" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          数据概览
        </NuxtLink>
        <NuxtLink to="/admin/galleries" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          图库管理
        </NuxtLink>
        <NuxtLink to="/admin/tags" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          标签管理
        </NuxtLink>
        <NuxtLink to="/admin/users" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          用户管理
        </NuxtLink>
        <NuxtLink to="/admin/import" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          批量导入
        </NuxtLink>
        <NuxtLink to="/admin/audit-logs" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          审计日志
        </NuxtLink>
        <NuxtLink to="/admin/contact-methods" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          联系方式
        </NuxtLink>
        <NuxtLink to="/admin/settings" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          站点设置
        </NuxtLink>
      </nav>
      <div class="py-4 border-t border-gray-700">
        <NuxtLink to="/" class="block px-6 py-3 text-sm hover:bg-gray-800 hover:text-white">
          返回前台
        </NuxtLink>
      </div>
    </aside>

    <div class="flex-1 flex flex-col overflow-x-hidden">
      <header class="px-8 py-4 border-b border-gray-200 bg-white">
        <!-- 用户信息 -->
      </header>
      <main class="flex-1 p-8 bg-gray-50">
        <slot />
      </main>
    </div>
  </div>
</template>
