<script setup lang="ts">
import AttributionCredentialEditor from '~/components/admin/attribution/AttributionCredentialEditor.vue'
import AttributionEventBindingEditor from '~/components/admin/attribution/AttributionEventBindingEditor.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionPlatformConnectionEditor from '~/components/admin/attribution/AttributionPlatformConnectionEditor.vue'
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
  Object.fromEntries(ATTRIBUTION_PLATFORMS.map(platform => [
    platform.provider,
    emptyAttributionPlatformConnectionDraft(platform),
  ])) as Record<AttributionPlatformProvider, AttributionPlatformConnectionDraft>,
)
const credentialPlaintext = ref('')
const credentialError = ref('')

const platform = computed(() => attributionPlatformDefinition(selectedProvider.value))
const connectionsByProvider = computed(() => Object.fromEntries(manager.connections.value.map(connection => [connection.provider, connection])))
const connection = computed(() => connectionsByProvider.value[selectedProvider.value] ?? null)
const draft = computed({
  get: () => drafts[selectedProvider.value],
  set: value => { drafts[selectedProvider.value] = value },
})
const pageError = computed(() => credentialError.value || manager.error.value)

watch(manager.connections, (connections) => {
  const indexed = Object.fromEntries(connections.map(item => [item.provider, item]))
  for (const definition of ATTRIBUTION_PLATFORMS) {
    drafts[definition.provider] = attributionConnectionToDraft(indexed[definition.provider], definition)
  }
}, { immediate: true, deep: true })

watch(selectedProvider, () => {
  credentialPlaintext.value = ''
  credentialError.value = ''
  manager.clearFeedback()
})

onMounted(() => void manager.refreshConnections())

async function save() {
  credentialError.value = ''
  try {
    await manager.saveConnection(
      selectedProvider.value,
      attributionConnectionPayload(platform.value, draft.value, credentialPlaintext.value) as Record<string, unknown>,
    )
  }
  finally {
    credentialPlaintext.value = ''
  }
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="平台连接"
    description="统一管理广告平台的公开标识、Server 凭证和运行开关。"
    :loading="manager.loading.value"
    :error="pageError"
    :show-range-controls="false"
    :show-usage="false"
    @refresh="manager.refreshConnections"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />

    <form class="space-y-4" @submit.prevent="save">
      <AttributionPlatformConnectionEditor
        v-model="draft"
        :platform="platform"
        :connection="connection"
        :is-owner="isOwner"
      />
      <AttributionEventBindingEditor
        v-model="draft.eventBindings"
        :platform="platform"
        :disabled="!isOwner || manager.saving.value"
      />
      <AttributionCredentialEditor
        v-model="credentialPlaintext"
        :platform="platform"
        :configured="connection?.credential.configured"
        :disabled="!isOwner || manager.saving.value"
        @error="credentialError = $event"
      />
      <div class="flex min-w-0 flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
        <button v-if="isOwner" type="submit" :disabled="manager.saving.value" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">
          {{ manager.saving.value ? '保存中...' : '保存连接' }}
        </button>
        <span role="status" class="min-w-0 text-sm text-gray-600">{{ manager.message.value }}</span>
      </div>
    </form>
  </AttributionPageShell>
</template>
