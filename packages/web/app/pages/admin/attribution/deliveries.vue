<script setup lang="ts">
import AttributionIncidentList from '~/components/admin/attribution/AttributionIncidentList.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import AttributionRolloutControl from '~/components/admin/attribution/AttributionRolloutControl.vue'
import { useAdminAttributionPlatforms } from '~/composables/useAdminAttribution'
import type { AttributionPlatformConnectionDraft, AttributionPlatformProvider } from '~/utils/attributionPlatforms'
import {
  ATTRIBUTION_PLATFORMS,
  attributionConnectionPayload,
  attributionConnectionStateLabel,
  attributionConnectionToDraft,
  attributionPlatformDefinition,
  emptyAttributionPlatformConnectionDraft,
} from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

const { isOwner } = useAuth()
const rangeState = useAdminAttributionRange('7d')
const selectedProvider = useAttributionProvider()
const manager = useAdminAttributionPlatforms()
const drafts = reactive<Record<AttributionPlatformProvider, AttributionPlatformConnectionDraft>>(
  Object.fromEntries(ATTRIBUTION_PLATFORMS.map(platform => [platform.provider, emptyAttributionPlatformConnectionDraft(platform)])) as Record<AttributionPlatformProvider, AttributionPlatformConnectionDraft>,
)

const platform = computed(() => attributionPlatformDefinition(selectedProvider.value))
const connectionsByProvider = computed(() => Object.fromEntries(manager.connections.value.map(connection => [connection.provider, connection])))
const connection = computed(() => connectionsByProvider.value[selectedProvider.value] ?? null)
const draft = computed({
  get: () => drafts[selectedProvider.value],
  set: value => { drafts[selectedProvider.value] = value },
})

watch(manager.connections, (connections) => {
  const indexed = Object.fromEntries(connections.map(item => [item.provider, item]))
  for (const definition of ATTRIBUTION_PLATFORMS) {
    drafts[definition.provider] = attributionConnectionToDraft(indexed[definition.provider], definition)
  }
}, { immediate: true, deep: true })

watch(selectedProvider, manager.clearFeedback)
onMounted(() => void manager.refreshConnections())

async function saveRollout() {
  await manager.saveConnection(
    selectedProvider.value,
    attributionConnectionPayload(platform.value, draft.value) as Record<string, unknown>,
  )
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="投递质量"
    description="核对 Browser 与 Server 投递状态、放量比例和异常记录。"
    :loading="manager.loading.value"
    :error="manager.error.value"
    :show-usage="false"
    @refresh="manager.refreshConnections"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />
    <section class="border-y border-gray-200 bg-white">
      <dl class="grid grid-cols-2 md:grid-cols-5">
        <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">连接</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ attributionConnectionStateLabel(connection) }}</dd></div>
        <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">Browser</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.browserEnabled ? '100%' : '0%' }}</dd></div>
        <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">Server target</dt><dd class="mt-1 text-sm font-semibold tabular-nums text-gray-900">{{ connection?.rolloutTargetPercentage ?? 0 }}%</dd></div>
        <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">Server effective</dt><dd class="mt-1 text-sm font-semibold tabular-nums text-gray-900">{{ connection?.rolloutEffectivePercentage ?? 0 }}%</dd></div>
        <div class="col-span-2 px-3 py-3 md:col-span-1"><dt class="text-xs text-gray-500">运行模式</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.mode || 'disabled' }}</dd></div>
      </dl>
    </section>

    <form v-if="connection" class="space-y-4" @submit.prevent="saveRollout">
      <AttributionRolloutControl
        v-model:browser-enabled="draft.browserEnabled"
        v-model:server-target-percentage="draft.rolloutTargetPercentage"
        :server-effective-percentage="connection.rolloutEffectivePercentage"
        :disabled="!isOwner || manager.saving.value"
      />
      <div class="flex min-w-0 flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
        <button v-if="isOwner" type="submit" :disabled="manager.saving.value" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">保存投放控制</button>
        <span role="status" class="text-sm text-gray-600">{{ manager.message.value }}</span>
      </div>
    </form>
    <AttributionIncidentList :incidents="[]" />
  </AttributionPageShell>
</template>
