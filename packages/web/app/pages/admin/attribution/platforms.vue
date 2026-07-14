<script setup lang="ts">
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionPlatformConnectionEditor from '~/components/admin/attribution/AttributionPlatformConnectionEditor.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import MetaConnectionStatus from '~/components/admin/attribution/MetaConnectionStatus.vue'
import type {
  AdPlatformConnectionStatusData,
  AttributionDashboardProvider,
  MetaStatusData,
} from '~/composables/useAdminAttribution'
import {
  attributionPlatformDefinition,
  emptyAttributionPlatformConnectionDraft,
  type AttributionPlatformConnectionDraft,
} from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

const { isOwner } = useAuth()
const { api } = useApi()
const rangeState = useAdminAttributionRange('7d')
const selectedProvider = useAttributionProvider()
const platforms = useAdminAttribution<AdPlatformConnectionStatusData[]>('/api/admin/attribution/platforms', { rangeState, autoRefresh: false })
const metaStatus = useAdminAttribution<MetaStatusData>('/api/admin/attribution/meta/status', { rangeState, autoRefresh: false })
const metaTestEventCode = ref('')
const tiktokTestEventCode = ref('')
const saving = ref(false)
const verifying = ref(false)
const message = ref('')
const drafts = reactive<Record<AttributionDashboardProvider, AttributionPlatformConnectionDraft>>({
  meta: emptyAttributionPlatformConnectionDraft(),
  tiktok: emptyAttributionPlatformConnectionDraft(),
})

const platform = computed(() => attributionPlatformDefinition(selectedProvider.value))
const connection = computed(() => platforms.data.value?.find(item => item.provider === selectedProvider.value) ?? null)
const selectedDraft = computed({
  get: () => drafts[selectedProvider.value],
  set: value => Object.assign(drafts[selectedProvider.value], value),
})
const loading = computed(() => platforms.loading.value || (selectedProvider.value === 'meta' && metaStatus.loading.value))
const error = computed(() => platforms.error.value || (selectedProvider.value === 'meta' ? metaStatus.error.value : ''))

watch(() => platforms.data.value, (connections) => {
  for (const provider of ['meta', 'tiktok'] as const) {
    const item = connections?.find(connection => connection.provider === provider)
    if (!item) continue
    Object.assign(drafts[provider], {
      enabled: item.enabled,
      browserEnabled: item.browserEnabled,
      serverEnabled: item.serverEnabled,
      destinationId: item.destinationId,
      debugEnabled: item.debugEnabled,
      mode: item.mode,
      rolloutPercentage: item.rolloutPercentage,
    })
  }
}, { immediate: true })

watch(selectedProvider, async (provider) => {
  message.value = ''
  if (provider === 'meta' && !metaStatus.data.value) await metaStatus.refresh()
})

onMounted(() => void refreshAll())

async function refreshAll() {
  await Promise.all([
    platforms.refresh(),
    ...(selectedProvider.value === 'meta' ? [metaStatus.refresh()] : []),
  ])
}

async function saveConnection() {
  saving.value = true
  message.value = ''
  try {
    await api(`/api/admin/attribution/platforms/${selectedProvider.value}`, {
      method: 'PATCH',
      body: { ...selectedDraft.value },
    })
    message.value = `${platform.value.label} 连接已保存`
    await refreshAll()
  }
  catch (error) {
    message.value = resolveApiErrorMessage(error, `${platform.value.label} 连接保存失败`)
  }
  finally {
    saving.value = false
  }
}

async function verifyTikTokConnection() {
  if (selectedProvider.value !== 'tiktok') return
  verifying.value = true
  message.value = ''
  try {
    const response = await api<{ data: { idempotent?: boolean } }>('/api/admin/attribution/platforms/tiktok/verify', {
      method: 'POST',
      body: { testEventCode: tiktokTestEventCode.value.trim() },
    })
    tiktokTestEventCode.value = ''
    message.value = response.data.idempotent ? '测试事件已重新发送，连接保持有效' : 'TikTok Events API 已验证'
    await refreshAll()
  }
  catch (error) {
    message.value = resolveApiErrorMessage(error, 'TikTok Events API 验证失败')
  }
  finally {
    verifying.value = false
  }
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="平台接入"
    description="集中管理广告平台目标 ID、运行通道和一次性验证；不同平台的凭证、事件与投递保持隔离。"
    :loading="loading"
    :error="error"
    :show-range-controls="false"
    :show-usage="false"
    @refresh="refreshAll"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />

    <div class="space-y-0 bg-white">
      <section class="border-b border-gray-200 px-3 py-5 sm:px-5">
        <AttributionPlatformConnectionEditor
          v-model="selectedDraft"
          :platform="platform"
          :connection="connection"
          :is-owner="isOwner"
          :saving="saving"
          :message="message"
          @save="saveConnection"
        />
      </section>

      <section class="border-b border-gray-200 px-3 py-5 sm:px-5">
        <div class="mb-4">
          <h2 class="text-sm font-semibold text-gray-900">连接验证</h2>
          <p class="mt-1 text-sm text-gray-500">测试码只用于当前验证请求，不保存为配置，也不会进入正式事件。</p>
        </div>
        <MetaConnectionStatus
          v-if="selectedProvider === 'meta'"
          v-model:test-event-code="metaTestEventCode"
          :connection="metaStatus.data.value?.connection || null"
          :activity="metaStatus.data.value?.activity || null"
          :is-owner="isOwner"
          @refreshed="refreshAll"
        />
        <div v-else class="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,22rem)_auto] sm:items-end">
          <label class="block min-w-0">
            <span class="mb-1 block text-xs font-medium text-gray-600">{{ platform.testEventLabel }}</span>
            <input v-model.trim="tiktokTestEventCode" type="password" autocomplete="new-password" maxlength="128" class="h-10 w-full rounded-md border border-gray-300 px-3 font-mono text-sm outline-none focus:border-gray-500 focus:ring-2 focus:ring-gray-200">
          </label>
          <button type="button" :disabled="verifying || !tiktokTestEventCode" class="h-10 w-fit rounded-md border border-gray-900 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50" @click="verifyTikTokConnection">
            {{ verifying ? '验证中...' : `验证 ${platform.serverLabel}` }}
          </button>
        </div>
      </section>

      <section class="px-3 py-5 sm:px-5">
        <h2 class="text-sm font-semibold text-gray-900">事件边界</h2>
        <div class="mt-3 grid gap-3 md:grid-cols-3">
          <div class="border-l-2 border-emerald-500 bg-emerald-50 px-3 py-3">
            <p class="text-xs font-medium text-emerald-800">正式转化</p>
            <p class="mt-1 text-sm text-emerald-950">Contact · CompleteRegistration</p>
          </div>
          <div class="border-l-2 border-gray-400 bg-gray-50 px-3 py-3">
            <p class="text-xs font-medium text-gray-600">来源路由</p>
            <p class="mt-1 text-sm text-gray-900">仅接收明确归属于 {{ platform.label }} 的事件</p>
          </div>
          <div class="border-l-2 border-blue-500 bg-blue-50 px-3 py-3">
            <p class="text-xs font-medium text-blue-700">去重契约</p>
            <p class="mt-1 text-sm text-blue-950">Browser 与 Server 共用同一 event ID</p>
          </div>
        </div>
      </section>
    </div>
  </AttributionPageShell>
</template>
