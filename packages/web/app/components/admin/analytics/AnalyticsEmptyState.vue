<script setup lang="ts">
withDefaults(defineProps<{
  title?: string
  description?: string
  actionLabel?: string
  actionTo?: string
  secondaryLabel?: string
  secondaryTo?: string
  tone?: 'default' | 'blue' | 'gold' | 'green' | 'red'
}>(), {
  title: '暂无数据',
  description: '暂无数据，部署埋点后会在这里展示',
  actionLabel: '',
  actionTo: '',
  secondaryLabel: '',
  secondaryTo: '',
  tone: 'default',
})

const emit = defineEmits<{
  action: []
  secondary: []
}>()

const toneClass: Record<string, string> = {
  default: 'border-gray-200 bg-white text-gray-900',
  blue: 'border-blue-100 bg-blue-50 text-blue-900',
  gold: 'border-amber-100 bg-amber-50 text-amber-900',
  green: 'border-emerald-100 bg-emerald-50 text-emerald-900',
  red: 'border-red-100 bg-red-50 text-red-900',
}

const markerClass: Record<string, string> = {
  default: 'bg-gray-900',
  blue: 'bg-blue-600',
  gold: 'bg-amber-500',
  green: 'bg-emerald-600',
  red: 'bg-red-600',
}
</script>

<template>
  <div :class="['flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed px-5 py-10 text-center shadow-sm', toneClass[tone]]">
    <div class="mb-4 flex h-10 items-end gap-1" aria-hidden="true">
      <span :class="['h-4 w-1.5 rounded-full opacity-40', markerClass[tone]]" />
      <span :class="['h-7 w-1.5 rounded-full opacity-70', markerClass[tone]]" />
      <span :class="['h-5 w-1.5 rounded-full opacity-50', markerClass[tone]]" />
      <span :class="['h-9 w-1.5 rounded-full opacity-80', markerClass[tone]]" />
    </div>
    <p class="text-sm font-semibold">{{ title }}</p>
    <p class="mt-2 max-w-xl text-sm leading-6 text-gray-500">{{ description }}</p>
    <div v-if="actionLabel || secondaryLabel" class="mt-5 flex flex-wrap items-center justify-center gap-2">
      <NuxtLink
        v-if="actionLabel && actionTo"
        :to="actionTo"
        class="inline-flex min-h-9 items-center rounded-lg bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800"
      >
        {{ actionLabel }}
      </NuxtLink>
      <button
        v-else-if="actionLabel"
        class="inline-flex min-h-9 items-center rounded-lg bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800"
        type="button"
        @click="emit('action')"
      >
        {{ actionLabel }}
      </button>
      <NuxtLink
        v-if="secondaryLabel && secondaryTo"
        :to="secondaryTo"
        class="inline-flex min-h-9 items-center rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        {{ secondaryLabel }}
      </NuxtLink>
      <button
        v-else-if="secondaryLabel"
        class="inline-flex min-h-9 items-center rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
        type="button"
        @click="emit('secondary')"
      >
        {{ secondaryLabel }}
      </button>
    </div>
  </div>
</template>
