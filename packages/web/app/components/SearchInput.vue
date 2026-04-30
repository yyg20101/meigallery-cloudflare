<script setup lang="ts">
const modelValue = defineModel<string>({ default: '' })
const emit = defineEmits<{ search: [value: string] }>()

function onSubmit() {
  emit('search', modelValue.value.trim())
}
</script>

<template>
  <form class="relative" @submit.prevent="onSubmit">
    <input
      v-model="modelValue"
      type="search"
      placeholder="搜索图库..."
      class="w-full rounded-full border border-gray-300 bg-white py-2 pl-4 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
    />
    <button type="submit" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    </button>
  </form>
</template>
