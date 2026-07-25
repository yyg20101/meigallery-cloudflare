<script setup lang="ts">
import type { AttributionProvider } from '@meigallery/shared'
import type {
  AttributionManagedSourceView,
  CreateAttributionManagedSourceRequest,
} from '~/types/attribution-admin'
import {
  attributionPlatformDefinition,
} from '~/utils/attributionPlatforms'

const props = withDefaults(defineProps<{
  provider: AttributionProvider
  sources: AttributionManagedSourceView[]
  generatedUrl?: string
  disabled?: boolean
  saving?: boolean
}>(), {
  generatedUrl: '',
  disabled: false,
  saving: false,
})

const emit = defineEmits<{
  create: [input: CreateAttributionManagedSourceRequest]
  disable: [sourceId: string]
  clearGenerated: []
}>()

const form = reactive({
  campaign: '',
  medium: attributionPlatformDefinition(props.provider).tracking
    .defaultUtmMedium,
  content: '',
  expiresAt: '',
})
const copyMessage = ref('')

watch(
  () => props.provider,
  provider => {
    form.medium = attributionPlatformDefinition(provider).tracking
      .defaultUtmMedium
  },
)

function submit() {
  const expiresAt = form.expiresAt
    ? new Date(form.expiresAt).toISOString()
    : undefined
  emit('create', {
    campaign: form.campaign.trim(),
    medium: form.medium.trim(),
    content: form.content.trim(),
    ...(expiresAt ? { expiresAt } : {}),
  })
}

async function copyGeneratedUrl() {
  if (!props.generatedUrl || !import.meta.client) return
  await navigator.clipboard?.writeText(props.generatedUrl)
  copyMessage.value = '已复制'
}
</script>

<template>
  <section class="min-w-0 border-y border-gray-200 bg-white">
    <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
      <h2 class="text-base font-semibold text-gray-900">投放来源</h2>
      <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-500">
        每个链接固定绑定当前连接，避免多个团队或平台之间的数据串流。
      </p>
    </div>

    <div
      v-if="generatedUrl"
      class="border-b border-emerald-200 bg-emerald-50 px-3 py-4 sm:px-5"
    >
      <p class="text-sm font-semibold text-emerald-900">
        投放链接已生成，仅显示一次
      </p>
      <p class="mt-1 text-xs leading-5 text-emerald-800">
        关闭后无法再次查看，请立即保存到对应广告团队。
      </p>
      <div class="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row">
        <input
          :value="generatedUrl"
          readonly
          aria-label="新建投放链接"
          class="h-10 min-w-0 flex-1 border border-emerald-300 bg-white px-3 font-mono text-xs text-gray-800"
        >
        <button
          type="button"
          class="min-h-10 bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800"
          @click="copyGeneratedUrl"
        >
          {{ copyMessage || '复制链接' }}
        </button>
        <button
          type="button"
          class="min-h-10 border border-emerald-300 bg-white px-4 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
          @click="emit('clearGenerated')"
        >
          关闭
        </button>
      </div>
    </div>

    <form
      class="grid min-w-0 gap-3 border-b border-gray-200 px-3 py-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(12rem,0.8fr)_auto] xl:items-end"
      @submit.prevent="submit"
    >
      <label class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-700">
          Campaign
        </span>
        <input
          v-model="form.campaign"
          :disabled="disabled || saving"
          required
          maxlength="1024"
          placeholder="例如 us_bj_2026_07"
          class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm"
        >
      </label>
      <label class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-700">
          Medium
        </span>
        <input
          v-model="form.medium"
          :disabled="disabled || saving"
          required
          maxlength="1024"
          class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm"
        >
      </label>
      <label class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-700">
          素材标识
        </span>
        <input
          v-model="form.content"
          :disabled="disabled || saving"
          required
          maxlength="1024"
          placeholder="例如 video_a_chat"
          class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm"
        >
      </label>
      <label class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-700">
          到期时间（可选）
        </span>
        <input
          v-model="form.expiresAt"
          :disabled="disabled || saving"
          type="datetime-local"
          class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm"
        >
      </label>
      <button
        type="submit"
        :disabled="disabled || saving"
        class="min-h-10 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 sm:col-span-2 xl:col-span-1"
      >
        {{ saving ? '处理中...' : '创建链接' }}
      </button>
    </form>

    <div v-if="sources.length" class="divide-y divide-gray-200">
      <article
        v-for="source in sources"
        :key="source.id"
        class="grid min-w-0 gap-3 px-3 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_9rem_auto] lg:items-center"
      >
        <div class="min-w-0">
          <p class="text-xs text-gray-500">Campaign</p>
          <p class="mt-1 truncate text-sm font-semibold text-gray-900">
            {{ source.campaign }}
          </p>
        </div>
        <div class="min-w-0">
          <p class="text-xs text-gray-500">素材 / Medium</p>
          <p class="mt-1 truncate text-sm text-gray-800">
            {{ source.content }} · {{ source.medium }}
          </p>
        </div>
        <div>
          <p class="text-xs text-gray-500">状态</p>
          <p
            :class="[
              'mt-1 text-sm font-medium',
              source.enabled ? 'text-emerald-700' : 'text-gray-500',
            ]"
          >
            {{ source.enabled ? '有效' : '已停用' }}
          </p>
        </div>
        <div>
          <p class="text-xs text-gray-500">到期</p>
          <p class="mt-1 text-sm text-gray-700">
            {{ source.expiresAt
              ? new Date(source.expiresAt).toLocaleDateString('zh-CN')
              : '长期有效' }}
          </p>
        </div>
        <button
          v-if="source.enabled"
          type="button"
          :disabled="disabled || saving"
          class="min-h-9 border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          @click="emit('disable', source.id)"
        >
          停用
        </button>
        <span v-else class="text-sm text-gray-400">不可恢复</span>
      </article>
    </div>
    <div v-else class="px-4 py-10 text-center text-sm text-gray-500">
      尚未创建投放来源。
    </div>
  </section>
</template>
