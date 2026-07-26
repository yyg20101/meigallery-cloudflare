<script setup lang="ts">
import AttributionIncidentList from '~/components/admin/attribution/AttributionIncidentList.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import { useAdminAttributionPlatforms } from '~/composables/useAdminAttribution'
import {
  attributionConnectionStateLabel,
} from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

const rangeState = useAdminAttributionRange('7d')
const selectedProvider = useAttributionProvider()
const manager = useAdminAttributionPlatforms()

const connectionsByProvider = computed(() => Object.fromEntries(manager.connections.value.map(connection => [connection.provider, connection])))
const connection = computed(() => connectionsByProvider.value[selectedProvider.value] ?? null)

watch(selectedProvider, manager.clearFeedback)
onMounted(() => void manager.refreshConnections())
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="投递质量"
    description="核对 Browser、Server 与异常记录。投递开关统一在平台连接中管理。"
    :loading="manager.loading.value"
    :error="manager.error.value"
    :show-usage="false"
    @refresh="manager.refreshConnections"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />
    <section class="border-y border-gray-200 bg-white">
      <dl class="grid grid-cols-3">
        <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">连接</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ attributionConnectionStateLabel(connection) }}</dd></div>
        <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">Browser</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.browserEnabled ? '已启用' : '已关闭' }}</dd></div>
        <div class="px-3 py-3"><dt class="text-xs text-gray-500">Server</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.serverEnabled ? '已启用' : '已关闭' }}</dd></div>
      </dl>
    </section>

    <AttributionIncidentList :incidents="[]" />
  </AttributionPageShell>
</template>
