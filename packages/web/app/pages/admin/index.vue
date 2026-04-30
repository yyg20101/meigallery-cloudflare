<script setup lang="ts">
definePageMeta({
  layout: 'admin',
})

useHead({
  title: '管理后台 - MeiGallery',
})
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900 mb-6">数据概览</h1>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="bg-white rounded-lg p-6 shadow-sm">
        <span class="text-sm text-gray-500">图库总数</span>
        <span class="block text-3xl font-bold text-gray-900 mt-1">-</span>
      </div>
      <div class="bg-white rounded-lg p-6 shadow-sm">
        <span class="text-sm text-gray-500">已发布</span>
        <span class="block text-3xl font-bold text-gray-900 mt-1">-</span>
      </div>
      <div class="bg-white rounded-lg p-6 shadow-sm">
        <span class="text-sm text-gray-500">注册用户</span>
        <span class="block text-3xl font-bold text-gray-900 mt-1">-</span>
      </div>
      <div class="bg-white rounded-lg p-6 shadow-sm">
        <span class="text-sm text-gray-500">VIP 会员</span>
        <span class="block text-3xl font-bold text-gray-900 mt-1">-</span>
      </div>
    </div>
  </div>
</template>
