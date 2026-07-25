<script setup lang="ts">
import AttributionConnectionFilter from '~/components/admin/attribution/AttributionConnectionFilter.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionVerificationPanel from '~/components/admin/attribution/AttributionVerificationPanel.vue'
import {
  attributionReadModelDateQuery,
  useAttributionConnectionFilterState,
  useAttributionVerifications,
} from '~/composables/useAdminAttribution'

definePageMeta({ layout: 'admin' })

const rangeState = useAdminAttributionRange('7d')
const filters = useAttributionConnectionFilterState()
const connections = useAttributionConnections(undefined, {
  autoLoad: false,
})
const verifications = useAttributionVerifications()
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
  limit: 200,
}))
const loading = computed(() => (
  connections.loading.value || verifications.loading.value
))
const error = computed(() => (
  connections.error.value || verifications.error.value
))

watch(
  [
    rangeState.queryKey,
    filters.provider,
    filters.connectionId,
  ],
  () => void verifications.refresh(readQuery.value),
)
onMounted(() => void refreshAll())

async function refreshAll() {
  await Promise.all([
    connections.refresh(),
    verifications.refresh(readQuery.value),
  ])
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="验证记录"
    description="查看完整身份候选的自动验证结果；生产版本在候选验证期间继续运行。"
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
    <AttributionVerificationPanel
      :records="verifications.rows.value"
    />
  </AttributionPageShell>
</template>
