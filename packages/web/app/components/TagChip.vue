<script setup lang="ts">
interface TagChipProps {
  tag: { name: string; slug: string; type?: string }
  size?: 'sm' | 'md'
  removable?: boolean
  selected?: boolean
  linkable?: boolean
}
withDefaults(defineProps<TagChipProps>(), { size: 'md', removable: false, selected: false, linkable: false })
const emit = defineEmits<{ remove: [] }>()
</script>

<template>
  <NuxtLink
    v-if="linkable"
    :to="`/discover?tag=${tag.slug}`"
    :class="[
      'inline-flex items-center rounded-full border transition-all duration-200 cursor-pointer',
      selected ? 'border-gray-950 bg-[#111] text-white shadow-sm shadow-gray-900/10' : 'border-transparent bg-[#f8e7dc]/55 text-gray-700 hover:border-[#e8d5c5] hover:bg-[#fff7ed] hover:text-gray-950',
      size === 'sm' ? 'px-2.5 py-0.5 text-[10px]' : 'px-3.5 py-1 text-[10px]',
    ]"
  >
    {{ tag.name }}
  </NuxtLink>
  <span
    v-else
    :class="[
      'inline-flex items-center rounded-full border transition-all duration-200 cursor-pointer',
      selected ? 'border-gray-950 bg-[#111] text-white shadow-sm shadow-gray-900/10' : 'border-transparent bg-[#f8e7dc]/55 text-gray-700 hover:border-[#e8d5c5] hover:bg-[#fff7ed] hover:text-gray-950',
      size === 'sm' ? 'px-2.5 py-0.5 text-[10px]' : 'px-3.5 py-1 text-[10px]',
    ]"
  >
    {{ tag.name }}
    <button v-if="removable" class="ml-1 text-gray-400 transition-colors hover:text-gray-700" @click.prevent="emit('remove')">
      &times;
    </button>
  </span>
</template>
