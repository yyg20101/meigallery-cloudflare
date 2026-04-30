<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  level: string
  rank: number
  expiresAt: string | null
}>()

const bgClass = computed(() => {
  if (props.rank >= 20) return 'bg-gradient-to-br from-purple-500 to-purple-700'
  if (props.rank >= 10) return 'bg-gradient-to-br from-amber-400 to-yellow-600'
  return 'bg-gradient-to-br from-gray-400 to-gray-600'
})

const formattedDate = computed(() => {
  if (!props.expiresAt) return '永久'
  return new Date(props.expiresAt).toLocaleDateString('zh-CN')
})

const benefitText = computed(() => {
  if (props.rank >= 20) return '尊享全站所有内容无限制访问'
  if (props.rank >= 10) return '解锁 VIP 专属内容'
  return '仅可浏览免费内容'
})
</script>

<template>
  <div :class="[bgClass, 'rounded-xl p-4 relative overflow-hidden text-white']">
    <!-- 装饰圆 -->
    <div class="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-white/10" />

    <div class="flex justify-between items-start relative">
      <div>
        <p class="text-xs text-white/70">当前等级</p>
        <p class="text-2xl font-bold">{{ level }}</p>
      </div>
      <div class="text-right">
        <p class="text-xs text-white/70">有效期至</p>
        <p class="font-semibold">{{ formattedDate }}</p>
      </div>
    </div>

    <p class="text-xs text-white/80 mt-4 relative">{{ benefitText }}</p>
  </div>
</template>
