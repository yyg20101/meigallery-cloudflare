<script setup lang="ts">
import AttributionConnectionFilter from '~/components/admin/attribution/AttributionConnectionFilter.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import {
  useAttributionBindings,
  useAttributionConnectionFilterState,
} from '~/composables/useAdminAttribution'
import type {
  AttributionBindingView,
} from '~/types/attribution-admin'
import {
  attributionPlatformDefinition,
} from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

const rangeState = useAdminAttributionRange('7d')
const filters = useAttributionConnectionFilterState()
const connections = useAttributionConnections(undefined, {
  autoLoad: false,
})
const bindings = useAttributionBindings()
const readQuery = computed(() => ({
  ...(filters.provider.value
    ? { provider: filters.provider.value }
    : {}),
  ...(filters.connectionId.value
    ? { connectionId: filters.connectionId.value }
    : {}),
}))
const loading = computed(() => (
  connections.loading.value || bindings.loading.value
))
const error = computed(() => (
  connections.error.value || bindings.error.value
))
const canonicalEvents = [
  'Contact',
  'CompleteRegistration',
] as const

watch(
  [filters.provider, filters.connectionId],
  () => void bindings.refresh(readQuery.value),
)
onMounted(() => void refreshAll())

async function refreshAll() {
  await Promise.all([
    connections.refresh(),
    bindings.refresh(readQuery.value),
  ])
}

function bindingFor(
  rows: AttributionBindingView[],
  canonicalEvent: AttributionBindingView['canonicalEvent'],
): AttributionBindingView | null {
  return rows.find(row => row.canonicalEvent === canonicalEvent) ?? null
}

function candidateStateLabel(value: string): string {
  if (value === 'candidate') return '待验证'
  if (value === 'validating') return '验证中'
  if (value === 'ready') return '待启用'
  return '验证失败'
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="事件映射"
    description="只读核对当前生产映射与候选差异；映射变更必须在连接详情创建完整身份候选。"
    :loading="loading"
    :error="error"
    :show-range-controls="false"
    :show-usage="false"
    @refresh="refreshAll"
  >
    <AttributionConnectionFilter
      v-model:provider="filters.provider.value"
      v-model:connection-id="filters.connectionId.value"
      :connections="connections.connections.value"
    />

    <section
      v-for="connection in bindings.rows.value"
      :key="connection.connectionId"
      class="min-w-0 border-y border-gray-200 bg-white"
    >
      <div class="flex flex-col gap-3 border-b border-gray-200 px-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h2 class="text-base font-semibold text-gray-900">
            {{ attributionPlatformDefinition(connection.provider).label }}
            / {{ connection.connectionName }}
          </h2>
          <p class="mt-1 text-xs text-gray-500">
            Active {{ connection.active.state === 'active' ? '生产运行' : '未配置' }}
            <template v-if="connection.candidate">
              · 候选 {{ candidateStateLabel(connection.candidate.state) }}
            </template>
          </p>
        </div>
        <NuxtLink
          :to="`/admin/attribution/connections/${connection.connectionId}`"
          class="w-fit text-sm font-medium text-blue-700 hover:text-blue-900"
        >
          前往连接详情
        </NuxtLink>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full min-w-[58rem] text-left text-sm">
          <thead class="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-3 py-2 font-medium sm:px-5">业务事件</th>
              <th class="px-3 py-2 font-medium">Active Browser</th>
              <th class="px-3 py-2 font-medium">Active Server</th>
              <th class="px-3 py-2 font-medium">候选 Browser</th>
              <th class="px-3 py-2 font-medium">候选 Server</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr
              v-for="eventName in canonicalEvents"
              :key="eventName"
            >
              <td class="px-3 py-3 font-medium text-gray-900 sm:px-5">
                {{ eventName }}
              </td>
              <td class="px-3 py-3 text-gray-600">
                {{ bindingFor(
                  connection.active.bindings,
                  eventName,
                )?.browserDestination || '-' }}
              </td>
              <td class="px-3 py-3 text-gray-600">
                {{ bindingFor(
                  connection.active.bindings,
                  eventName,
                )?.serverDestination || '-' }}
              </td>
              <td class="px-3 py-3 text-gray-600">
                {{ bindingFor(
                  connection.candidate?.bindings || [],
                  eventName,
                )?.browserDestination || '-' }}
              </td>
              <td class="px-3 py-3 text-gray-600">
                {{ bindingFor(
                  connection.candidate?.bindings || [],
                  eventName,
                )?.serverDestination || '-' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <p
      v-if="!bindings.rows.value.length"
      class="border-y border-gray-200 bg-white px-3 py-10 text-center text-sm text-gray-500 sm:px-5"
    >
      当前筛选没有归因连接
    </p>
  </AttributionPageShell>
</template>
