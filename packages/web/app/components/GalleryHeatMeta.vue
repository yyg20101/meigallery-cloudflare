<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  viewCount?: number | null
  likeCount?: number | null
  tone?: 'light' | 'dark'
}>(), {
  viewCount: null,
  likeCount: null,
  tone: 'light',
})

const toneClass = computed(() => {
  if (props.tone === 'dark') {
    return 'border-white/12 bg-white/8 text-stone-100 shadow-black/20 ring-white/10'
  }

  return 'border-[#eadfcf] bg-white/76 text-stone-800 shadow-orange-950/5 ring-white/80'
})

const labelClass = computed(() => props.tone === 'dark' ? 'text-stone-400' : 'text-stone-500')
const dividerClass = computed(() => props.tone === 'dark' ? 'bg-white/14' : 'bg-[#e8d5c5]')

function formatCount(count?: number | null) {
  const value = Math.max(0, count ?? 0)

  if (value < 10000) return String(value)

  return `${(value / 10000).toFixed(1)}万`
}
</script>

<template>
  <dl
    class="inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] shadow-sm ring-1 backdrop-blur-md sm:gap-3 sm:text-xs"
    :class="toneClass"
  >
    <div class="flex min-w-0 items-center gap-1.5">
      <dt class="shrink-0 tracking-[0.16em]" :class="labelClass">浏览</dt>
      <dd class="tabular-nums font-semibold tracking-tight">{{ formatCount(viewCount) }}</dd>
    </div>
    <div class="h-3.5 w-px shrink-0" :class="dividerClass" />
    <div class="flex min-w-0 items-center gap-1.5">
      <dt class="shrink-0 tracking-[0.16em]" :class="labelClass">点赞</dt>
      <dd class="tabular-nums font-semibold tracking-tight">{{ formatCount(likeCount) }}</dd>
    </div>
  </dl>
</template>
