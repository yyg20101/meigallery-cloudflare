<script setup lang="ts">
withDefaults(defineProps<{
  title?: string
  description?: string
}>(), {
  title: '暂无数据',
  description: '暂无数据，部署埋点后会在这里展示',
})
</script>

<template>
  <div class="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-10 text-center">
    <p class="text-sm font-medium text-gray-700">{{ title }}</p>
    <p class="mt-1 text-xs text-gray-400">{{ description }}</p>
  </div>
</template>
