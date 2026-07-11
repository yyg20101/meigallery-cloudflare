<script setup lang="ts">
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionTrendPanel from '~/components/admin/attribution/AttributionTrendPanel.vue'
import MetaConnectionStatus from '~/components/admin/attribution/MetaConnectionStatus.vue'
import MetaIncidentList from '~/components/admin/attribution/MetaIncidentList.vue'
import MetaRolloutControl from '~/components/admin/attribution/MetaRolloutControl.vue'
import type { AttributionQualityData, MetaIncident, MetaStatusData } from '~/composables/useAdminAttribution'

definePageMeta({ layout: 'admin' })

interface IncidentData {
  items: MetaIncident[]
  pagination: { hasMore: boolean }
}

const { isOwner } = useAuth()
const rangeState = useAdminAttributionRange('7d')
const requestOptions = { rangeState, autoRefresh: false }
const status = useAdminAttribution<MetaStatusData>('/api/admin/attribution/meta/status', requestOptions)
const quality = useAdminAttribution<AttributionQualityData>('/api/admin/attribution/quality', requestOptions)
const incidents = useAdminAttribution<IncidentData>('/api/admin/attribution/meta/incidents', {
  ...requestOptions,
  query: { status: 'all', limit: 50 },
})
const sources = [status, quality, incidents]
const qualitySeries = computed(() => {
  const summary = quality.data.value?.match.summary
  if (!summary) return []
  return [
    { key: 'fbp', label: 'fbp' },
    { key: 'fbc', label: 'fbc' },
    { key: 'email', label: 'email' },
    { key: 'externalId', label: 'external_id' },
  ].filter(item => summary[item.key as keyof typeof summary].availability === 'available')
    .map(item => ({ key: `${item.key}.rate`, label: item.label, layer: 'quality' as const, format: 'percent' as const }))
})

async function refreshAll() {
  await Promise.all(sources.map(source => source.refresh()))
}

watch(rangeState.queryKey, () => void refreshAll())
onMounted(() => void refreshAll())
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="Meta 运维"
    description="核对连接、匹配质量、rollout target/effective 与 incident 处置状态。"
    :loading="sources.some(source => source.loading.value)"
    :error="sources.map(source => source.error.value).find(Boolean) || ''"
    :usage="status.usage.value"
    @refresh="refreshAll"
  >
    <div class="space-y-0 bg-white">
      <section class="border-b border-gray-200 px-3 py-5 sm:px-5">
        <h2 class="mb-4 text-sm font-semibold text-gray-900">连接状态</h2>
        <MetaConnectionStatus :connection="status.data.value?.connection || null" :activity="status.data.value?.activity || null" :is-owner="isOwner" @refreshed="refreshAll" />
      </section>
      <section class="border-b border-gray-200 px-3 py-5 sm:px-5">
        <h2 class="mb-4 text-sm font-semibold text-gray-900">发布控制</h2>
        <MetaRolloutControl :rollout="status.data.value?.rollout || null" :is-owner="isOwner" @refreshed="refreshAll" />
      </section>
      <section class="border-b border-gray-200 px-3 py-5 sm:px-5">
        <h2 class="text-sm font-semibold text-gray-900">Meta 质量</h2>
        <p v-if="quality.data.value?.datasetQuality.availability !== 'available'" class="mt-2 text-sm text-gray-600">尚未取得 Meta 质量数据</p>
        <AttributionTrendPanel v-if="qualitySeries.length" class="mt-4" title="匹配质量趋势" :rows="quality.data.value?.match.rows as unknown as Array<Record<string, unknown>> || []" :series="qualitySeries" />
      </section>
      <section class="px-3 py-5 sm:px-5">
        <h2 class="mb-4 text-sm font-semibold text-gray-900">incident 记录</h2>
        <MetaIncidentList :incidents="incidents.data.value?.items || []" :is-owner="isOwner" @refreshed="refreshAll" />
      </section>
    </div>
  </AttributionPageShell>
</template>
