<script setup lang="ts">
defineProps<{ requiredRank: number; message?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center rounded-lg bg-gray-50 border border-gray-200 p-8 text-center">
    <div class="mb-3 text-4xl text-gray-300">
      <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    </div>
    <p class="text-sm text-gray-600">{{ message || '需要更高会员等级才能查看' }}</p>
    <MembershipBadge :rank="requiredRank" class="mt-2" />
    <NuxtLink to="/user" class="mt-3 text-sm text-blue-600 hover:underline">查看会员权益</NuxtLink>
  </div>
</template>
