<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const toast = useToast()
const retrying = ref(false)

interface ExternalImportFile {
  id: string
  filename: string | null
  telegram_file_unique_id: string | null
  declared_mime_type: string | null
  actual_mime_type: string | null
  file_size: number | null
  sort_order: number
  is_cover: number
  status: string
  error_message: string | null
}

interface ExternalImportDetail {
  id: string
  source: string
  external_message_id: string
  source_bot_key: string
  source_chat_id: string
  source_message_id: string
  media_group_id: string | null
  target_type: string
  target_id: string | null
  status: string
  metadata_json: string
  file_count: number
  fetched_count: number
  failed_count: number
  retry_count: number
  error_json: string | null
  request_ip: string | null
  user_agent: string | null
  created_at: string
  completed_at: string | null
  files: ExternalImportFile[]
}

const { data: record, refresh } = await useAsyncData(`external-import-${route.params.id}`, () =>
  api<ExternalImportDetail>(`/api/admin/external-import-records/${route.params.id}`),
)

function formatDateTime(value: string | null) {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 19)
}

function formatBytes(value: number | null) {
  if (!value) return '-'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function maskIdentifier(value: string | null) {
  if (!value) return '-'
  if (value.length <= 6) return '已记录（脱敏）'
  return `${value.slice(0, 3)}***${value.slice(-3)}`
}

const metadataSummary = computed(() => {
  if (!record.value?.metadata_json) return null
  try {
    const metadata = JSON.parse(record.value.metadata_json) as Record<string, unknown>
    return {
      type: metadata.type,
      title: metadata.title,
      slug: metadata.slug,
      requiredLevelRank: metadata.requiredLevelRank,
      status: metadata.status,
      tagCount: Array.isArray(metadata.tags) ? metadata.tags.length : 0,
    }
  } catch {
    return null
  }
})

const errorSummary = computed(() => {
  if (!record.value?.error_json) return null
  try {
    const error = JSON.parse(record.value.error_json) as Record<string, unknown>
    return { message: error.message || '导入失败' }
  } catch {
    return { message: '导入失败' }
  }
})

function statusClass(value: string) {
  if (value === 'draft_created' || value === 'completed') return 'bg-green-50 text-green-700'
  if (value === 'failed') return 'bg-red-50 text-red-700'
  if (value === 'partial_failed') return 'bg-amber-50 text-amber-700'
  return 'bg-blue-50 text-blue-700'
}

const targetLink = computed(() => {
  if (!record.value?.target_id) return ''
  if (record.value.target_type === 'gallery') return `/admin/galleries/${record.value.target_id}`
  if (record.value.target_type === 'case') return `/admin/cases/${record.value.target_id}`
  return ''
})

const canRetry = computed(() => record.value?.status === 'failed')

async function retryImport() {
  if (!record.value || !canRetry.value || retrying.value) return
  if (!confirm('确认重试该失败导入？系统会重新拉取 Telegram file_id 并尝试创建草稿。')) return

  retrying.value = true
  try {
    await api(`/api/admin/external-import-records/${record.value.id}/retry`, { method: 'POST' })
    await refresh()
    toast.add({ title: '导入重试已开始', color: 'success' })
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '导入重试失败'), color: 'error' })
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <div>
        <NuxtLink to="/admin/external-import-records" class="text-sm text-blue-600 hover:underline">← 返回外部导入记录</NuxtLink>
        <h1 class="mt-2 text-xl font-bold text-gray-900">导入详情</h1>
      </div>
      <div v-if="record" class="flex items-center gap-3">
        <button
          v-if="canRetry"
          type="button"
          :disabled="retrying"
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          @click="retryImport"
        >
          {{ retrying ? '重试中...' : '重试导入' }}
        </button>
        <span :class="['rounded-full px-3 py-1 text-sm font-medium', statusClass(record.status)]">{{ record.status }}</span>
      </div>
    </div>

    <div v-if="record" class="space-y-6">
      <section class="rounded-xl border border-gray-200 bg-white p-5">
        <h2 class="text-base font-semibold text-gray-900">基本信息</h2>
        <dl class="mt-4 grid gap-4 text-sm md:grid-cols-2">
          <div><dt class="text-gray-500">导入 ID</dt><dd class="mt-1 font-mono text-xs text-gray-900">{{ record.id }}</dd></div>
          <div><dt class="text-gray-500">外部消息 ID</dt><dd class="mt-1 font-mono text-xs text-gray-900">{{ record.external_message_id }}</dd></div>
          <div><dt class="text-gray-500">sourceBotKey</dt><dd class="mt-1 font-mono text-xs text-gray-900">{{ record.source_bot_key }}</dd></div>
          <div><dt class="text-gray-500">Telegram 来源</dt><dd class="mt-1 font-mono text-xs text-gray-900">chat {{ maskIdentifier(record.source_chat_id) }} / message {{ maskIdentifier(record.source_message_id) }}</dd></div>
          <div><dt class="text-gray-500">目标</dt><dd class="mt-1 text-gray-900">{{ record.target_type }} <NuxtLink v-if="targetLink" :to="targetLink" class="ml-2 text-blue-600 hover:underline">打开草稿</NuxtLink><span v-else class="ml-2 text-gray-400">尚未创建</span></dd></div>
          <div><dt class="text-gray-500">文件进度</dt><dd class="mt-1 text-gray-900">{{ record.fetched_count }} / {{ record.file_count }}，失败 {{ record.failed_count }}，重试 {{ record.retry_count }}</dd></div>
          <div><dt class="text-gray-500">创建时间</dt><dd class="mt-1 text-gray-900">{{ formatDateTime(record.created_at) }}</dd></div>
          <div><dt class="text-gray-500">完成时间</dt><dd class="mt-1 text-gray-900">{{ formatDateTime(record.completed_at) }}</dd></div>
        </dl>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-5">
        <h2 class="text-base font-semibold text-gray-900">文件列表</h2>
        <div class="mt-4 overflow-x-auto rounded-lg border border-gray-100">
          <table class="min-w-full text-sm">
            <thead class="bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              <tr><th class="px-4 py-3">顺序</th><th class="px-4 py-3">文件</th><th class="px-4 py-3">MIME</th><th class="px-4 py-3">大小</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">错误</th></tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="file in record.files" :key="file.id">
                <td class="px-4 py-3">{{ file.sort_order }}<span v-if="file.is_cover" class="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">封面</span></td>
                <td class="px-4 py-3"><div class="text-gray-900">{{ file.filename || '-' }}</div><div class="font-mono text-xs text-gray-400">{{ maskIdentifier(file.telegram_file_unique_id) }}</div></td>
                <td class="px-4 py-3 text-gray-600">{{ file.actual_mime_type || file.declared_mime_type || '-' }}</td>
                <td class="px-4 py-3 text-gray-600">{{ formatBytes(file.file_size) }}</td>
                <td class="px-4 py-3"><span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusClass(file.status)]">{{ file.status }}</span></td>
                <td class="px-4 py-3 text-red-600">{{ file.error_message || '-' }}</td>
              </tr>
              <tr v-if="record.files.length === 0"><td colspan="6" class="px-4 py-8 text-center text-gray-400">暂无文件</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-2">
        <div class="rounded-xl border border-gray-200 bg-white p-5">
          <h2 class="text-base font-semibold text-gray-900">元数据摘要</h2>
          <dl v-if="metadataSummary" class="mt-4 space-y-2 text-sm">
            <div class="flex justify-between gap-4"><dt class="text-gray-500">类型</dt><dd class="text-gray-900">{{ metadataSummary.type }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-gray-500">标题</dt><dd class="text-right text-gray-900">{{ metadataSummary.title }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-gray-500">Slug</dt><dd class="font-mono text-xs text-gray-900">{{ metadataSummary.slug }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-gray-500">会员 rank</dt><dd class="text-gray-900">{{ metadataSummary.requiredLevelRank ?? 0 }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-gray-500">标签数量</dt><dd class="text-gray-900">{{ metadataSummary.tagCount }}</dd></div>
          </dl>
          <p v-else class="mt-4 text-sm text-gray-400">元数据无法解析</p>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-5">
          <h2 class="text-base font-semibold text-gray-900">错误摘要</h2>
          <p class="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-700">{{ errorSummary?.message || '无' }}</p>
        </div>
      </section>
    </div>
  </div>
</template>
