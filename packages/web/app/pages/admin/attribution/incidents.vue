<script setup lang="ts">
import AttributionConnectionFilter from '~/components/admin/attribution/AttributionConnectionFilter.vue'
import AttributionIncidentList from '~/components/admin/attribution/AttributionIncidentList.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import {
  attributionReadModelDateQuery,
  useAttributionConnectionFilterState,
  useAttributionIncidents,
} from '~/composables/useAdminAttribution'

definePageMeta({ layout: 'admin' })

const rangeState = useAdminAttributionRange('7d')
const filters = useAttributionConnectionFilterState()
const status = ref<'' | 'open' | 'resolved'>('')
const connections = useAttributionConnections(undefined, {
  autoLoad: false,
})
const incidents = useAttributionIncidents()
const readQuery = computed(() => ({
  ...attributionReadModelDateQuery(
    rangeState.range.value,
    rangeState.date.value,
  ),
  ...(filters.provider.value
    ? { provider: filters.provider.value }
    : {}),
  ...(filters.connectionId.value
    ? { connectionId: filters.connectionId.value }
    : {}),
  ...(status.value ? { status: status.value } : {}),
  limit: 200,
}))
const loading = computed(() => (
  connections.loading.value || incidents.loading.value
))
const error = computed(() => (
  connections.error.value || incidents.error.value
))

watch(
  [
    rangeState.queryKey,
    filters.provider,
    filters.connectionId,
    status,
  ],
  () => void incidents.refresh(readQuery.value),
)
onMounted(() => void refreshAll())

async function refreshAll() {
  await Promise.all([
    connections.refresh(),
    incidents.refresh(readQuery.value),
  ])
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="Incident"
    description="按连接核对异常影响范围、自动处置和恢复状态。"
    :loading="loading"
    :error="error"
    :show-usage="false"
    @refresh="refreshAll"
  >
    <AttributionConnectionFilter
      v-model:provider="filters.provider.value"
      v-model:connection-id="filters.connectionId.value"
      :connections="connections.connections.value"
    />
    <div class="border-y border-gray-200 bg-white px-3 py-3 sm:px-5">
      <label class="block max-w-xs">
        <span class="mb-1 block text-xs font-medium text-gray-600">
          恢复状态
        </span>
        <select
          v-model="status"
          class="h-10 w-full border border-gray-300 bg-white px-3 text-sm"
        >
          <option value="">全部状态</option>
          <option value="open">处理中</option>
          <option value="resolved">已恢复</option>
        </select>
      </label>
    </div>
    <AttributionIncidentList :incidents="incidents.rows.value" />
  </AttributionPageShell>
</template>
