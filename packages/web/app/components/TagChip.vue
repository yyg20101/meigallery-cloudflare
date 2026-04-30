<script setup lang="ts">
interface TagChipProps {
  tag: { name: string; slug: string; type?: string }
  size?: 'sm' | 'md'
  removable?: boolean
}
withDefaults(defineProps<TagChipProps>(), { size: 'md', removable: false })
const emit = defineEmits<{ remove: [] }>()
</script>

<template>
  <span
    :class="[
      'inline-flex items-center rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors cursor-pointer',
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm',
    ]"
  >
    {{ tag.name }}
    <button v-if="removable" class="ml-1 text-gray-400 hover:text-gray-600" @click.prevent="emit('remove')">
      &times;
    </button>
  </span>
</template>
