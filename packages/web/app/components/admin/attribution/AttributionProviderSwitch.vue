<script setup lang="ts">
import type { AttributionPlatformProvider } from '~/utils/attributionPlatforms'
import { ATTRIBUTION_PLATFORMS, attributionPlatformDefinition } from '~/utils/attributionPlatforms'

const selectedProvider = defineModel<AttributionPlatformProvider>({ required: true })
const selectedPlatform = computed(() => attributionPlatformDefinition(selectedProvider.value))

function isSelected(candidate: AttributionPlatformProvider) {
  return selectedProvider.value === candidate
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 border-b border-gray-200 bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
    <div class="min-w-0">
      <p class="text-xs font-medium text-gray-500">当前平台</p>
      <p class="mt-0.5 truncate text-sm font-semibold text-gray-900">
        {{ selectedPlatform.label }}
      </p>
    </div>
    <div class="grid w-full min-w-0 grid-cols-3 rounded-md border border-gray-300 bg-gray-50 p-0.5 sm:w-auto sm:shrink-0" role="group" aria-label="选择归因平台">
      <button
        v-for="platform in ATTRIBUTION_PLATFORMS"
        :key="platform.provider"
        type="button"
        :aria-pressed="isSelected(platform.provider)"
        :class="isSelected(platform.provider) ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-white'"
        class="flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded px-2 text-sm font-medium transition-colors sm:min-w-20 sm:px-3"
        @click="selectedProvider = platform.provider"
      >
        <span :class="platform.accentClass" class="h-2 w-2 rounded-sm" aria-hidden="true" />
        {{ platform.shortLabel }}
      </button>
    </div>
  </div>
</template>
