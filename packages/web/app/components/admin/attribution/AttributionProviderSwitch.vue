<script setup lang="ts">
import type { AttributionDashboardProvider } from '~/composables/useAdminAttribution'
import { ATTRIBUTION_PLATFORMS } from '~/utils/attributionPlatforms'

const selectedProvider = defineModel<AttributionDashboardProvider>({ required: true })
</script>

<template>
  <div class="flex min-w-0 items-center justify-between gap-3 border-b border-gray-200 bg-white px-3 py-3 sm:px-5">
    <div class="min-w-0">
      <p class="text-xs font-medium text-gray-500">当前平台</p>
      <p class="mt-0.5 truncate text-sm font-semibold text-gray-900">
        {{ ATTRIBUTION_PLATFORMS.find(item => item.provider === selectedProvider)?.label }}
      </p>
    </div>
    <div class="inline-grid shrink-0 grid-flow-col rounded-md border border-gray-300 bg-gray-50 p-0.5" role="group" aria-label="选择归因平台">
      <button
        v-for="platform in ATTRIBUTION_PLATFORMS"
        :key="platform.provider"
        type="button"
        :aria-pressed="selectedProvider === platform.provider"
        :class="selectedProvider === platform.provider ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-white'"
        class="flex min-h-9 min-w-20 items-center justify-center gap-2 rounded px-3 text-sm font-medium transition-colors"
        @click="selectedProvider = platform.provider"
      >
        <span :class="platform.accentClass" class="h-2 w-2 rounded-sm" aria-hidden="true" />
        {{ platform.label }}
      </button>
    </div>
  </div>
</template>
