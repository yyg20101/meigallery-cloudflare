<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{
  error: NuxtError
}>()

const handleError = () => clearError({ redirect: '/' })

const statusMessage = computed(() => {
  switch (props.error.statusCode) {
    case 404:
      return '页面不存在'
    case 403:
      return '没有访问权限'
    case 500:
      return '服务器错误'
    default:
      return '出了点问题'
  }
})
</script>

<template>
  <div class="error-page">
    <h1>{{ error.statusCode }}</h1>
    <p>{{ statusMessage }}</p>
    <button @click="handleError">
      返回首页
    </button>
  </div>
</template>

<style scoped>
.error-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  text-align: center;
  font-family: system-ui, sans-serif;
}

.error-page h1 {
  font-size: 4rem;
  margin-bottom: 0.5rem;
  color: #333;
}

.error-page p {
  font-size: 1.25rem;
  color: #666;
  margin-bottom: 2rem;
}

.error-page button {
  padding: 0.75rem 1.5rem;
  background: #333;
  color: #fff;
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 1rem;
}

.error-page button:hover {
  background: #555;
}
</style>
