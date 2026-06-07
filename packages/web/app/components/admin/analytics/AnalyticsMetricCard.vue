<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  hint?: string
  tone?: 'default' | 'blue' | 'gold' | 'green' | 'red'
}>()

const toneClass: Record<string, string> = {
  default: 'border-gray-200 text-gray-950',
  blue: 'border-blue-200 text-blue-700',
  gold: 'border-amber-200 text-amber-700',
  green: 'border-emerald-200 text-emerald-700',
  red: 'border-red-200 text-red-700',
}
</script>

<template>
  <div :class="['rounded-lg border bg-white p-4 shadow-sm', toneClass[tone || 'default']]">
    <p class="text-xs font-medium text-gray-500">{{ label }}</p>
    <p class="mt-2 text-2xl font-semibold leading-none">{{ value }}</p>
    <p v-if="hint" class="mt-2 truncate text-xs text-gray-400">{{ hint }}</p>
  </div>
</template>
