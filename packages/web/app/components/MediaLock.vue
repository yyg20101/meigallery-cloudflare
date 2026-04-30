<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ requiredRank: number; message?: string }>()

const levelName = computed(() => {
  if (props.requiredRank >= 20) return 'SVIP'
  if (props.requiredRank >= 10) return 'VIP'
  return '会员'
})
</script>

<template>
  <div class="border border-dashed border-gray-300 rounded-xl bg-gray-50 p-6 text-center">
    <!-- 预览 slot -->
    <div v-if="$slots.preview" class="grid grid-cols-3 gap-1 mb-4 opacity-30">
      <slot name="preview" />
    </div>
    <!-- 锁头图标 -->
    <svg class="w-8 h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
    <p class="text-sm text-gray-600 mb-1">🔒 需要 {{ levelName }} 会员</p>
    <p v-if="message" class="text-xs text-gray-400 mb-3">{{ message }}</p>
    <NuxtLink to="/user" class="inline-block bg-gray-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-800">
      了解会员权益
    </NuxtLink>
  </div>
</template>
