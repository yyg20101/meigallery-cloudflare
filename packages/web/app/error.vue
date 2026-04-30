<script setup lang="ts">
import type { NuxtError } from '#app'

defineProps<{ error: NuxtError }>()

const handleError = () => clearError({ redirect: '/' })
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 px-4">
    <div class="text-center max-w-md">
      <p class="text-6xl font-bold text-gray-300">{{ error.statusCode }}</p>
      <h1 class="mt-4 text-xl font-semibold text-gray-900">
        {{ error.statusCode === 404 ? '页面不存在' : '出了点问题' }}
      </h1>
      <p class="mt-2 text-sm text-gray-500">
        {{ error.statusCode === 404 ? '您访问的页面不存在或已被移除' : error.message || '服务器遇到了错误，请稍后重试' }}
      </p>
      <button
        class="mt-6 rounded-lg bg-blue-600 px-6 py-2.5 text-sm text-white hover:bg-blue-700"
        @click="handleError"
      >
        返回首页
      </button>
    </div>
  </div>
</template>
