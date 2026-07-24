<script setup lang="ts">
import AttributionConnectionFilter from '~/components/admin/attribution/AttributionConnectionFilter.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import {
  attributionReadModelDateQuery,
  useAttributionAudit,
  useAttributionConnectionFilterState,
} from '~/composables/useAdminAttribution'

definePageMeta({ layout: 'admin' })

const rangeState = useAdminAttributionRange('7d')
const filters = useAttributionConnectionFilterState()
const connections = useAttributionConnections(undefined, {
  autoLoad: false,
})
const audit = useAttributionAudit()
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
  connections.loading.value || audit.loading.value
))
const error = computed(() => (
  connections.error.value || audit.error.value
))

watch(
  [
    rangeState.queryKey,
    filters.provider,
    filters.connectionId,
  ],
  () => void audit.refresh(readQuery.value),
)
onMounted(() => void refreshAll())

async function refreshAll() {
  await Promise.all([
    connections.refresh(),
    audit.refresh(readQuery.value),
  ])
}

function outcomeLabel(value: string): string {
  const labels: Record<string, string> = {
    created: '已创建',
    candidate: '候选已创建',
    validating: '验证已启动',
    ready: '验证已通过',
    active: '已启用',
    updated: '已更新',
    disabled: '已停用',
    server_open: 'Server 已暂停',
    closed: 'Server 已恢复',
    succeeded: '成功',
    replayed: '幂等复用',
    failed: '失败',
  }
  return labels[value] ?? '已完成'
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="审计日志"
    description="记录归因连接、身份候选、运行策略和自动处置命令。"
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

    <section class="min-w-0 border-y border-gray-200 bg-white">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[52rem] text-left text-sm">
          <thead class="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-3 py-2 font-medium sm:px-5">时间</th>
              <th class="px-3 py-2 font-medium">连接</th>
              <th class="px-3 py-2 font-medium">操作</th>
              <th class="px-3 py-2 font-medium">结果</th>
              <th class="px-3 py-2 font-medium">操作者</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr
              v-for="(log, index) in audit.rows.value"
              :key="`${log.createdAt}:${log.connectionId}:${log.commandType}:${index}`"
            >
              <td class="whitespace-nowrap px-3 py-3 text-gray-600 sm:px-5">
                {{ formatAnalyticsDateTime(log.createdAt) }}
              </td>
              <td class="px-3 py-3 font-medium text-gray-900">
                {{ log.connectionName }}
              </td>
              <td class="px-3 py-3 text-gray-700">
                <p class="font-medium text-gray-900">{{ log.summary }}</p>
              </td>
              <td class="px-3 py-3 text-gray-600">
                {{ outcomeLabel(log.outcome) }}
              </td>
              <td class="px-3 py-3 text-gray-500">
                Owner #{{ log.actorId }}
              </td>
            </tr>
            <tr v-if="!audit.rows.value.length">
              <td colspan="5" class="px-3 py-10 text-center text-gray-500">
                当前范围没有归因配置变更
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </AttributionPageShell>
</template>
