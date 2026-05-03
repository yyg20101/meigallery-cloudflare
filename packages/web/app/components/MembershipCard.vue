<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  level: string
  rank: number
  expiresAt: string | null
}>()

const bgClass = computed(() => {
  if (props.rank >= 20) return 'bg-[radial-gradient(circle_at_18%_0%,rgba(255,255,255,0.28),transparent_30%),linear-gradient(135deg,#5b21b6,#111827)]'
  if (props.rank >= 10) return 'bg-[radial-gradient(circle_at_18%_0%,rgba(255,247,237,0.42),transparent_30%),linear-gradient(135deg,#111827,#bfa46a)]'
  return 'bg-[radial-gradient(circle_at_18%_0%,rgba(255,255,255,0.35),transparent_30%),linear-gradient(135deg,#374151,#111827)]'
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
  <div :class="[bgClass, 'relative overflow-hidden rounded-[1.5rem] p-5 text-white shadow-xl shadow-gray-900/12']">
    <!-- 装饰圆 -->
    <div class="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-white/10 blur-sm" />

    <div class="flex justify-between items-start relative">
      <div>
        <p class="text-xs uppercase tracking-[0.18em] text-white/62">当前等级</p>
        <p class="mt-1 text-2xl font-semibold tracking-tight">{{ level }}</p>
      </div>
      <div class="text-right">
        <p class="text-xs text-white/62">有效期至</p>
        <p class="font-semibold">{{ formattedDate }}</p>
      </div>
    </div>

    <p class="text-xs text-white/80 mt-4 relative">{{ benefitText }}</p>
  </div>
</template>
