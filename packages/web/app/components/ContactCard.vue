<script setup lang="ts">
defineProps<{
  wechat?: string
  telegram?: string
  email?: string
  customNote?: string
}>()
</script>

<template>
  <div class="bg-white border border-gray-200 rounded-xl p-4">
    <p class="font-semibold text-sm mb-3">联系站长</p>

    <div class="divide-y divide-gray-50">
      <div v-if="wechat" class="flex justify-between py-2">
        <span class="text-gray-400 text-xs">微信</span>
        <span class="text-sm">{{ wechat }}</span>
      </div>
      <div v-if="telegram" class="flex justify-between py-2">
        <span class="text-gray-400 text-xs">Telegram</span>
        <span class="text-sm">{{ telegram }}</span>
      </div>
      <div v-if="email" class="flex justify-between py-2">
        <span class="text-gray-400 text-xs">邮箱</span>
        <span class="text-sm">{{ email }}</span>
      </div>
    </div>

    <div class="bg-gray-50 rounded-lg p-3 mt-3 text-xs text-gray-500">
      {{ customNote || '如需开通会员或有任何问题，请通过以上方式联系站长。' }}
    </div>
  </div>
</template>
