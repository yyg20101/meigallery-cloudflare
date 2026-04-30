<script setup lang="ts">
const props = defineProps<{ rank: number }>()

const label = computed(() => {
  if (props.rank >= 20) return 'SVIP'
  if (props.rank >= 10) return 'VIP'
  return ''
})
const colorClass = computed(() => {
  if (props.rank >= 20) return 'bg-violet-600 text-white'
  if (props.rank >= 10) return 'bg-amber-500 text-white'
  return 'bg-gray-100 text-gray-600'
})
</script>

<template>
  <span v-if="label" :class="['inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', colorClass]">
    {{ label }}
  </span>
</template>
