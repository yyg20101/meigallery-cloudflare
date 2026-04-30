<script setup lang="ts">
defineProps<{ items: Array<{ label: string; to?: string }> }>()
</script>

<template>
  <nav class="flex items-center gap-1 text-xs text-gray-400 mb-4">
    <template v-for="(item, i) in items" :key="i">
      <span v-if="i > 0" class="select-none">/</span>
      <NuxtLink v-if="item.to && i < items.length - 1" :to="item.to" class="hover:text-gray-600">{{ item.label }}</NuxtLink>
      <span v-else class="text-gray-700 font-medium">{{ item.label }}</span>
    </template>
  </nav>
</template>
