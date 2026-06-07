<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ requiredRank: number; message?: string }>()
const emit = defineEmits<{ membershipCtaClick: [] }>()

const levelName = computed(() => {
  if (props.requiredRank >= 20) return 'SVIP'
  if (props.requiredRank >= 10) return 'VIP'
  return '会员'
})
</script>

<template>
  <div class="relative overflow-hidden rounded-[1.5rem] border border-dashed border-[#e8d5c5] bg-[#fffbf7] p-6 text-center shadow-sm shadow-orange-950/5">
    <div class="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-[#f8e7dc] blur-3xl" />
    <!-- 预览 slot -->
    <div v-if="$slots.preview" class="relative mb-4 grid grid-cols-3 gap-1 opacity-30">
      <slot name="preview" />
    </div>
    <!-- 锁头图标 -->
    <svg class="relative mx-auto mb-2 h-8 w-8 text-[#bfa46a]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
    <p class="relative mb-1 text-sm font-medium text-gray-800">需要 {{ levelName }} 会员</p>
    <p v-if="message" class="relative mb-3 text-xs text-gray-500">{{ message }}</p>
    <NuxtLink to="/user" class="relative inline-block rounded-full bg-gray-950 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-gray-900/15 transition-all hover:-translate-y-0.5 hover:bg-gray-800" @click="emit('membershipCtaClick')">
      了解会员权益
    </NuxtLink>
  </div>
</template>
