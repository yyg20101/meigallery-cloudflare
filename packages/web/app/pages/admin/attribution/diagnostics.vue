<script setup lang="ts">
import AttributionDiagnosticPanel from '~/components/admin/attribution/AttributionDiagnosticPanel.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import { useAdminAttributionPlatforms } from '~/composables/useAdminAttribution'
import { attributionPlatformDefinition } from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

const { isOwner } = useAuth()
const rangeState = useAdminAttributionRange('7d')
const selectedProvider = useAttributionProvider()
const manager = useAdminAttributionPlatforms()
const testEventCode = ref('')

const platform = computed(() => attributionPlatformDefinition(selectedProvider.value))
const connectionsByProvider = computed(() => Object.fromEntries(manager.connections.value.map(connection => [connection.provider, connection])))
const connection = computed(() => connectionsByProvider.value[selectedProvider.value] ?? null)
const diagnostic = computed(() => manager.diagnostics.value[selectedProvider.value] ?? null)

watch(selectedProvider, () => {
  testEventCode.value = ''
  manager.clearFeedback()
})

onMounted(() => void manager.refreshConnections())

async function testConnection() {
  try {
    await manager.testConnection(selectedProvider.value, testEventCode.value)
  }
  catch {
    // manager 已记录并展示稳定错误信息。
  }
  finally {
    testEventCode.value = ''
  }
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="连接诊断"
    description="即时测试平台连接。测试结果仅用于排障，不控制正式事件投递。"
    :loading="manager.loading.value"
    :error="manager.error.value"
    :show-range-controls="false"
    :show-usage="false"
    @refresh="manager.refreshConnections"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />
    <div v-if="!connection" class="border-y border-amber-200 bg-amber-50 px-3 py-4 text-sm text-amber-900 sm:px-5">
      当前平台尚未建立连接。<NuxtLink :to="{ path: '/admin/attribution/platforms', query: { provider: selectedProvider } }" class="font-medium underline">前往平台连接</NuxtLink>
    </div>
    <AttributionDiagnosticPanel
      v-else
      v-model:test-event-code="testEventCode"
      :platform="platform"
      :diagnostic="diagnostic"
      :loading="manager.testing.value"
      :disabled="!isOwner"
      @test="testConnection"
    />
    <p v-if="manager.message.value" role="status" class="border-y border-gray-200 bg-white px-3 py-3 text-sm text-gray-600 sm:px-5">
      {{ manager.message.value }}
    </p>
  </AttributionPageShell>
</template>
