<script setup lang="ts">
import AttributionEventBindingEditor from '~/components/admin/attribution/AttributionEventBindingEditor.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import { useAdminAttributionPlatforms } from '~/composables/useAdminAttribution'
import type { AttributionPlatformConnectionDraft, AttributionPlatformProvider } from '~/utils/attributionPlatforms'
import {
  ATTRIBUTION_PLATFORMS,
  attributionConnectionPayload,
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

async function saveBindings() {
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
    title="事件绑定"
    description="将站内有效联系和完成注册映射到当前广告平台。"
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
    <form v-else class="space-y-4" @submit.prevent="saveBindings">
      <AttributionEventBindingEditor v-model="draft.eventBindings" :platform="platform" :disabled="!isOwner || manager.saving.value" />
      <div class="flex min-w-0 flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
        <button v-if="isOwner" type="submit" :disabled="manager.saving.value" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">
          {{ manager.saving.value ? '保存中...' : '保存事件绑定' }}
        </button>
        <span role="status" class="text-sm text-gray-600">{{ manager.message.value }}</span>
      </div>
    </form>
  </AttributionPageShell>
</template>
