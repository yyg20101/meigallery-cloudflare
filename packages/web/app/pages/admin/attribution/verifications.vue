<script setup lang="ts">
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import AttributionVerificationPanel from '~/components/admin/attribution/AttributionVerificationPanel.vue'
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
const verification = computed(() => manager.verifications.value[selectedProvider.value] ?? null)

watch(selectedProvider, async () => {
  testEventCode.value = ''
  manager.clearFeedback()
  await manager.refreshVerification(selectedProvider.value).catch(() => undefined)
})

onMounted(async () => {
  await manager.refreshConnections()
  await manager.refreshVerification(selectedProvider.value).catch(() => undefined)
})

async function verify(reverify = false) {
  try {
    await manager.startVerification(selectedProvider.value, testEventCode.value, reverify)
  }
  finally {
    testEventCode.value = ''
  }
}

async function confirmEvidence(reference: string) {
  if (!verification.value) return
  await manager.confirmVerificationEvidence(selectedProvider.value, verification.value.id, reference)
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="验证记录"
    description="查看自动验证、人工平台证据和连接版本的一致性。"
    :loading="manager.loading.value"
    :error="manager.error.value"
    :show-usage="false"
    @refresh="manager.refreshVerification(selectedProvider)"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />
    <div v-if="!connection" class="border-y border-amber-200 bg-amber-50 px-3 py-4 text-sm text-amber-900 sm:px-5">
      当前平台尚未建立连接。<NuxtLink :to="{ path: '/admin/attribution/platforms', query: { provider: selectedProvider } }" class="font-medium underline">前往平台连接</NuxtLink>
    </div>
    <AttributionVerificationPanel
      v-else
      v-model:test-event-code="testEventCode"
      :platform="platform"
      :verification="verification"
      :loading="manager.verifying.value"
      :disabled="!isOwner"
      @verify="verify(false)"
      @reverify="verify(true)"
      @confirm-evidence="confirmEvidence"
      @refresh="manager.refreshVerification(selectedProvider)"
    />
    <p role="status" class="border-y border-gray-200 bg-white px-3 py-3 text-sm text-gray-600 sm:px-5">{{ manager.message.value }}</p>
  </AttributionPageShell>
</template>
