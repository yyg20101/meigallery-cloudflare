<script setup lang="ts">
export interface AttributionIncidentItem {
  id: string
  provider: string
  severity: string
  status: string
  summary: string
  openedAt: string
}

withDefaults(defineProps<{
  incidents?: AttributionIncidentItem[]
}>(), {
  incidents: () => [],
})
</script>

<template>
  <section data-attribution-incident-list class="min-w-0 border-y border-gray-200 bg-white">
    <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
      <h2 class="text-base font-semibold text-gray-900">异常记录</h2>
    </div>
    <div v-if="incidents.length" class="divide-y divide-gray-200">
      <div v-for="incident in incidents" :key="incident.id" class="grid min-w-0 gap-2 px-3 py-3 text-sm sm:grid-cols-[7rem_7rem_minmax(0,1fr)_10rem] sm:px-5">
        <span class="font-medium text-gray-900">{{ incident.provider }}</span>
        <span class="text-gray-600">{{ incident.severity }}</span>
        <span class="min-w-0 [overflow-wrap:anywhere] text-gray-700">{{ incident.summary }}</span>
        <time class="text-gray-500">{{ formatAnalyticsDateTime(incident.openedAt) }}</time>
      </div>
    </div>
    <p v-else class="px-3 py-8 text-center text-sm text-gray-500 sm:px-5">当前没有未处理异常</p>
  </section>
</template>
