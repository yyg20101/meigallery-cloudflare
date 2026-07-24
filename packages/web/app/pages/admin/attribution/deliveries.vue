<script setup lang="ts">
import AttributionConnectionFilter from '~/components/admin/attribution/AttributionConnectionFilter.vue'
import AttributionDeliveryFunnel from '~/components/admin/attribution/AttributionDeliveryFunnel.vue'
import AttributionHealthStrip from '~/components/admin/attribution/AttributionHealthStrip.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import {
  attributionReadModelDateQuery,
  useAttributionConnectionFilterState,
  useAttributionOperations,
} from '~/composables/useAdminAttribution'
import {
  aggregateAttributionOperations,
  attributionOperationTrendRows,
} from '~/utils/attributionOperations'
import {
  attributionPlatformDefinition,
} from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

const rangeState = useAdminAttributionRange('7d')
const filters = useAttributionConnectionFilterState()
const connections = useAttributionConnections(undefined, {
  autoLoad: false,
})
const operations = useAttributionOperations()
const quality = useAttributionQuality()

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
}))
const selectedConnection = computed(() => (
  connections.connections.value.find(
    item => item.id === filters.connectionId.value,
  ) ?? null
))
const metrics = computed(() => aggregateAttributionOperations(
  operations.rows.value,
))
const dailyRows = computed(() => attributionOperationTrendRows(
  operations.rows.value,
))
const serverPending = computed(() => Math.max(
  0,
  metrics.value.serverPlanned
    - metrics.value.serverProcessed
    - metrics.value.serverRejected
    - metrics.value.serverDeadLetter,
))
const serverFailed = computed(() => (
  metrics.value.serverRejected + metrics.value.serverDeadLetter
))
const platformLabels = computed(() => filters.provider.value
  ? attributionPlatformDefinition(filters.provider.value)
  : null)
const qualityAvailable = computed(() => quality.rows.value.some(
  row => row.availability === 'available',
))
const loading = computed(() => (
  connections.loading.value
  || operations.loading.value
  || quality.loading.value
))
const error = computed(() => (
  connections.error.value
  || operations.error.value
  || quality.error.value
))

watch(
  [
    rangeState.queryKey,
    filters.provider,
    filters.connectionId,
  ],
  () => void refreshData(),
)
onMounted(() => void refreshAll())

async function refreshAll() {
  await Promise.all([
    connections.refresh(),
    refreshData(),
  ])
}

async function refreshData() {
  await Promise.all([
    operations.refresh(readQuery.value),
    quality.refresh(readQuery.value),
  ])
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="投递质量"
    description="核对 Browser 实际回执、Server 阶段和平台质量快照。运行策略仅在连接详情修改。"
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

    <AttributionHealthStrip
      :provider-label="platformLabels?.label || '全部平台'"
      :browser-label="platformLabels?.browserLabel || 'Browser'"
      :server-label="platformLabels?.serverLabel || 'Server API'"
      :browser-enabled="selectedConnection?.runtime.browserEnabled"
      :server-enabled="selectedConnection?.runtime.serverEnabled"
      :browser-attempted="metrics.browserAttempted"
      :server-processed="metrics.serverProcessed"
      :server-pending="serverPending"
      :server-failed="serverFailed"
    />

    <AttributionDeliveryFunnel :metrics="metrics" />

    <section class="min-w-0 border-y border-gray-200 bg-white">
      <div class="flex flex-col gap-2 border-b border-gray-200 px-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h2 class="text-base font-semibold text-gray-900">每日阶段明细</h2>
          <p class="mt-1 text-xs text-gray-500">
            日期按北京时间自然日统计。
          </p>
        </div>
        <span
          class="text-sm font-medium"
          :class="qualityAvailable ? 'text-emerald-700' : 'text-gray-500'"
        >
          {{ qualityAvailable ? '平台质量有数据' : '平台质量暂不可用' }}
        </span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[58rem] text-left text-sm">
          <thead class="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-3 py-2 font-medium sm:px-5">日期</th>
              <th class="px-3 py-2 font-medium">业务事实</th>
              <th class="px-3 py-2 font-medium">已归因</th>
              <th class="px-3 py-2 font-medium">Browser Attempted</th>
              <th class="px-3 py-2 font-medium">Server Planned</th>
              <th class="px-3 py-2 font-medium">Server Queued</th>
              <th class="px-3 py-2 font-medium">Server Processed</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="row in dailyRows" :key="row.date">
              <td class="px-3 py-3 font-medium tabular-nums sm:px-5">
                {{ row.date }}
              </td>
              <td class="px-3 py-3 tabular-nums">
                {{ row.business.factCount }}
              </td>
              <td class="px-3 py-3 tabular-nums">
                {{ row.business.attributedFactCount }}
              </td>
              <td class="px-3 py-3 tabular-nums text-amber-700">
                {{ row.delivery.browserAttempted }}
              </td>
              <td class="px-3 py-3 tabular-nums">
                {{ row.delivery.serverPlanned }}
              </td>
              <td class="px-3 py-3 tabular-nums">
                {{ row.delivery.serverQueued }}
              </td>
              <td class="px-3 py-3 tabular-nums text-blue-700">
                {{ row.delivery.serverProcessed }}
              </td>
            </tr>
            <tr v-if="!dailyRows.length">
              <td colspan="7" class="px-3 py-10 text-center text-gray-500">
                当前范围没有投递数据
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </AttributionPageShell>
</template>
