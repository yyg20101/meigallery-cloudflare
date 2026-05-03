<script setup lang="ts">
defineProps<{
  eyebrow?: string
  title: string
  description?: string
  actionLabel?: string
  actionTo?: string
}>()
</script>

<template>
  <div class="mb-4 flex items-end justify-between gap-4">
    <div>
      <p v-if="eyebrow" class="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#bfa46a]">{{ eyebrow }}</p>
      <h2 class="mt-1 text-xl font-semibold tracking-tight text-gray-950 lg:text-2xl">{{ title }}</h2>
      <p v-if="description" class="mt-1 max-w-2xl text-sm leading-6 text-gray-500">{{ description }}</p>
    </div>
    <NuxtLink v-if="actionLabel && actionTo" :to="actionTo" class="hidden rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm text-gray-700 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-gray-950 sm:inline-flex">
      {{ actionLabel }}
    </NuxtLink>
  </div>
</template>
