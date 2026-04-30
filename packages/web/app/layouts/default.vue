<script setup lang="ts">
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-gray-200">
      <nav class="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
        <NuxtLink to="/" class="text-xl font-bold text-gray-900">
          MeiGallery
        </NuxtLink>
        <div class="flex gap-6">
          <NuxtLink to="/" class="text-gray-600 hover:text-gray-900">首页</NuxtLink>
          <NuxtLink to="/tags" class="text-gray-600 hover:text-gray-900">标签</NuxtLink>
        </div>
      </nav>
    </header>

    <main class="flex-1 max-w-7xl mx-auto px-4 py-8 w-full">
      <slot />
    </main>

    <footer class="border-t border-gray-200 text-center py-6 text-sm text-gray-400">
      <p>&copy; {{ new Date().getFullYear() }} MeiGallery</p>
    </footer>
  </div>
</template>
