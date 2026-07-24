<script setup lang="ts">
import AttributionConnectionFilter from '~/components/admin/attribution/AttributionConnectionFilter.vue'
import AttributionDeliveryFunnel from '~/components/admin/attribution/AttributionDeliveryFunnel.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionTrendPanel from '~/components/admin/attribution/AttributionTrendPanel.vue'
import {
  attributionReadModelDateQuery,
  useAttributionConnectionFilterState,
  useAttributionOperations,
} from '~/composables/useAdminAttribution'
import {
  aggregateAttributionOperations,
  attributionOperationTrendRows,
} from '~/utils/attributionOperations'

definePageMeta({ layout: 'admin' })

const rangeState = useAdminAttributionRange('7d')
const filters = useAttributionConnectionFilterState()
const connections = useAttributionConnections(undefined, {
  autoLoad: false,
})
const operations = useAttributionOperations()
const quality = useAttributionQuality()

const dateQuery = computed(() => attributionReadModelDateQuery(
  rangeState.range.value,
  rangeState.date.value,
))
const readQuery = computed(() => ({
  ...dateQuery.value,
  ...(filters.provider.value
    ? { provider: filters.provider.value }
    : {}),
  ...(filters.connectionId.value
    ? { connectionId: filters.connectionId.value }
    : {}),
}))
const metrics = computed(() => aggregateAttributionOperations(
  operations.rows.value,
))
const trendRows = computed(() => attributionOperationTrendRows(
  operations.rows.value,
))
const qualityRows = computed(() => quality.rows.value)
const availableQuality = computed(() => qualityRows.value.filter(
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

const businessSeries = [
  {
    key: 'business.contactCount',
    label: '有效联系',
    layer: 'business' as const,
    aggregation: { type: 'sum' as const },
  },
  {
    key: 'business.completeRegistrationCount',
    label: '完成注册',
    layer: 'business' as const,
    aggregation: { type: 'sum' as const },
  },
]
const deliverySeries = [
  {
    key: 'delivery.browserAttempted',
    label: 'Browser Attempted',
    layer: 'browser' as const,
    aggregation: { type: 'sum' as const },
  },
  {
    key: 'delivery.serverProcessed',
    label: 'Server Processed',
    layer: 'server' as const,
    aggregation: { type: 'sum' as const },
  },
]

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

function formatMetricValue(value: number | null): string {
  if (value === null) return '-'
  if (value >= 0 && value <= 1) {
    return `${Math.round(value * 10_000) / 100}%`
  }
  return formatAnalyticsNumber(value)
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="广告归因总览"
    description="按业务事实、Browser 回执和 Server 投递阶段核对归因结果。"
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

    <section
      data-attribution-section="operations"
      class="min-w-0 space-y-4"
    >
      <AttributionDeliveryFunnel :metrics="metrics" />

      <div class="border-y border-gray-200 bg-white px-3 py-5 sm:px-5">
        <AttributionTrendPanel
          title="业务与投递趋势"
          description="业务事实与投递状态分别统计，不以 Pixel 或 Server 状态替代站内转化。"
          :rows="trendRows"
          :series="[...businessSeries, ...deliverySeries]"
        />
      </div>
    </section>

    <section
      data-attribution-section="quality"
      class="min-w-0 border-y border-gray-200 bg-white"
    >
      <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
        <h2 class="text-base font-semibold text-gray-900">平台质量</h2>
        <p class="mt-1 text-xs leading-5 text-gray-500">
          质量快照仅作平台侧诊断，不改变连接状态和运行比例。
        </p>
      </div>
      <div v-if="availableQuality.length" class="overflow-x-auto">
        <table class="w-full min-w-[40rem] text-left text-sm">
          <thead class="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-3 py-2 font-medium sm:px-5">日期</th>
              <th class="px-3 py-2 font-medium">连接</th>
              <th class="px-3 py-2 font-medium">指标</th>
              <th class="px-3 py-2 font-medium">样本</th>
              <th class="px-3 py-2 font-medium">结果</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr
              v-for="row in availableQuality"
              :key="`${row.date}:${row.connectionId}:${row.metricKey}`"
            >
              <td class="px-3 py-3 tabular-nums sm:px-5">{{ row.date }}</td>
              <td class="px-3 py-3 font-medium text-gray-900">
                {{ row.connectionName }}
              </td>
              <td class="px-3 py-3 text-gray-600">{{ row.metricKey }}</td>
              <td class="px-3 py-3 tabular-nums text-gray-600">
                {{ row.numerator ?? '-' }} / {{ row.denominator ?? '-' }}
              </td>
              <td class="px-3 py-3 font-medium text-gray-900">
                {{ formatMetricValue(row.value) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        v-else
        class="px-3 py-10 text-center text-sm text-gray-500 sm:px-5"
      >
        平台质量暂不可用
      </p>
    </section>
  </AttributionPageShell>
</template>
