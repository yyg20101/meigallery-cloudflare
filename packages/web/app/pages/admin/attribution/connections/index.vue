<script setup lang="ts">
import type {
  AttributionProvider,
} from '@meigallery/shared'
import AttributionConnectionFilter from '~/components/admin/attribution/AttributionConnectionFilter.vue'
import AttributionConnectionList from '~/components/admin/attribution/AttributionConnectionList.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'
import { ATTRIBUTION_PLATFORMS } from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

const { isOwner } = useAuth()
const route = useRoute()
const toast = useToast()
const rangeState = useAdminAttributionRange('7d')
const manager = useAttributionConnections()
const initialProvider = Array.isArray(route.query.provider)
  ? route.query.provider[0]
  : route.query.provider
const provider = ref<AttributionProvider | ''>(
  ATTRIBUTION_PLATFORMS.some(
    platform => platform.provider === initialProvider,
  )
    ? initialProvider as AttributionProvider
    : '',
)
const search = ref('')
const createOpen = ref(false)
const createError = ref('')
const form = reactive<{
  provider: AttributionProvider
  name: string
  isDefault: boolean
}>({
  provider: 'meta',
  name: '',
  isDefault: false,
})

const filteredConnections = computed(() => {
  const normalizedSearch = search.value.trim().toLocaleLowerCase()
  return manager.connections.value.filter(connection => (
    (!provider.value || connection.provider === provider.value)
    && (
      !normalizedSearch
      || connection.name.toLocaleLowerCase().includes(normalizedSearch)
      || connection.activeTarget.toLocaleLowerCase().includes(normalizedSearch)
    )
  ))
})

async function createConnection() {
  createError.value = ''
  try {
    const connection = await manager.createConnection({
      provider: form.provider,
      name: form.name.trim(),
      isDefault: form.isDefault,
    })
    toast.add({ title: '归因连接已创建', color: 'success' })
    form.name = ''
    form.isDefault = false
    createOpen.value = false
    await navigateTo(`/admin/attribution/connections/${connection.id}`)
  } catch (cause) {
    createError.value = resolveApiErrorMessage(
      cause,
      '归因连接创建失败',
    )
  }
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="归因连接"
    description="按平台和投放团队管理多个独立连接，每个连接拥有自己的身份、运行策略和投放来源。"
    :loading="manager.loading.value"
    :error="manager.error.value"
    :show-range-controls="false"
    :show-usage="false"
    @refresh="manager.refresh"
  >
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-3 border-y border-gray-200 bg-white px-3 py-3 sm:px-5">
      <div>
        <p class="text-sm font-semibold text-gray-900">
          {{ manager.connections.value.length }} 个连接
        </p>
        <p class="mt-1 text-xs text-gray-500">
          同一平台可并列创建多个团队连接。
        </p>
      </div>
      <button
        v-if="isOwner"
        type="button"
        class="min-h-10 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800"
        @click="createOpen = !createOpen"
      >
        {{ createOpen ? '取消新建' : '新建连接' }}
      </button>
    </div>

    <form
      v-if="createOpen && isOwner"
      class="grid min-w-0 gap-3 border-y border-gray-200 bg-white px-3 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-[12rem_minmax(16rem,1fr)_auto_auto] lg:items-end"
      @submit.prevent="createConnection"
    >
      <label class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-700">平台</span>
        <select
          v-model="form.provider"
          :disabled="manager.creating.value"
          class="h-10 w-full border border-gray-300 bg-white px-3 text-sm"
        >
          <option
            v-for="platform in ATTRIBUTION_PLATFORMS"
            :key="platform.provider"
            :value="platform.provider"
          >
            {{ platform.label }}
          </option>
        </select>
      </label>
      <label class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-700">
          连接名称
        </span>
        <input
          v-model="form.name"
          :disabled="manager.creating.value"
          required
          maxlength="160"
          placeholder="例如 Meta 美国 BJ 团队"
          class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm"
        >
      </label>
      <label class="flex min-h-10 items-center gap-2">
        <input
          v-model="form.isDefault"
          :disabled="manager.creating.value"
          type="checkbox"
        >
        <span class="text-sm text-gray-700">设为平台默认连接</span>
      </label>
      <button
        type="submit"
        :disabled="manager.creating.value || !manager.canCreate.value"
        class="min-h-10 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {{ manager.creating.value ? '创建中...' : '创建并配置' }}
      </button>
      <p
        v-if="createError"
        role="alert"
        class="text-sm text-red-700 sm:col-span-2 lg:col-span-4"
      >
        {{ createError }}
      </p>
    </form>

    <AttributionConnectionFilter
      v-model:provider="provider"
      v-model:search="search"
      :connections="manager.connections.value"
      :show-connection="false"
      show-search
    />

    <AttributionConnectionList :connections="filteredConnections" />
  </AttributionPageShell>
</template>
