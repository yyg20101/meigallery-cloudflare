<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  liked: boolean
  loading?: boolean
  likeCount: number
}>(), {
  loading: false,
})

defineEmits<{
  click: []
}>()

const buttonClass = computed(() => {
  if (props.liked) {
    return 'border-black bg-black text-[#d6c39a] shadow-black/20 ring-[#d6c39a]/30 hover:bg-stone-950'
  }

  return 'border-[#eadfcf] bg-white text-black shadow-orange-950/7 ring-white/80 hover:border-[#d6c39a] hover:bg-[#fffaf2]'
})
</script>

<template>
  <button
    type="button"
    class="inline-flex max-w-full items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold shadow-sm ring-1 transition-all duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
    :class="buttonClass"
    :aria-pressed="liked"
    :disabled="loading"
    @click="$emit('click')"
  >
    <span class="truncate">{{ liked ? '已点赞' : '点赞' }}</span>
    <span class="rounded-full px-2 py-0.5 text-xs tabular-nums" :class="liked ? 'bg-white/10 text-[#d6c39a]' : 'bg-stone-100 text-stone-700'">
      {{ likeCount }}
    </span>
  </button>
</template>
