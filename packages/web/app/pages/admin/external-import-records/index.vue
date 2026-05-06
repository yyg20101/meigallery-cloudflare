<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const page = ref(1)
const status = ref('')
const targetType = ref('')
const sourceBotKey = ref('')
const loading = ref(false)

interface ExternalImportRecord {
  id: string
  source: string
  external_message_id: string
  source_bot_key: string
  target_type: string
  target_id: string | null
  status: string
  file_count: number
  fetched_count: number
  failed_count: number
  retry_count: number
  created_at: string
  completed_at: string | null
}

const records = ref<ExternalImportRecord[]>([])
const total = ref(0)
const totalPages = computed(() => Math.ceil(total.value / 20))

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'pending_media_fetch', label: '待拉取' },
  { value: 'fetching_media', label: '拉取中' },
  { value: 'draft_created', label: '草稿已创建' },
  { value: 'partial_failed', label: '部分失败' },
  { value: 'failed', label: '失败' },
]
const targetTypeOptions = [
  { value: '', label: '全部目标' },
  { value: 'gallery', label: '图库' },
  { value: 'testimonial_case', label: '真实案例' },
]

function statusLabel(value: string) {
  return statusOptions.find(item => item.value === value)?.label || value
}

function statusClass(value: string) {
  if (value === 'draft_created') return 'bg-green-50 text-green-700'
  if (value === 'failed') return 'bg-red-50 text-red-700'
  if (value === 'partial_failed') return 'bg-amber-50 text-amber-700'
  return 'bg-blue-50 text-blue-700'
}

function targetTypeLabel(value: string) {
  return targetTypeOptions.find(item => item.value === value)?.label || value
}

function formatDateTime(value: string | null) {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 19)
}

async function fetchRecords() {
  loading.value = true
  try {
    const query: Record<string, string> = { page: String(page.value), pageSize: '20' }
    if (status.value) query.status = status.value
    if (targetType.value) query.targetType = targetType.value
    if (sourceBotKey.value.trim()) query.sourceBotKey = sourceBotKey.value.trim()
    const result = await api<{ data: ExternalImportRecord[]; total: number }>('/api/admin/external-import-records', { query })
    records.value = result.data ?? []
    total.value = result.total ?? 0
  } finally {
    loading.value = false
  }
}

function onFilterChange() {
  page.value = 1
  fetchRecords()
}

onMounted(fetchRecords)
watch(page, fetchRecords)
</script>

<template>
  <div>
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-bold text-gray-900">外部导入记录</h1>
        <p class="mt-1 text-sm text-gray-500">查看 Telegram file_id 导入状态、文件计数和失败原因，不展示 Telegram 下载 URL 或私有对象 key。</p>
      </div>
      <NuxtLink to="/admin/import-api-tokens" class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">管理 Token</NuxtLink>
    </div>

    <div class="mb-4 flex flex-wrap gap-3">
      <select v-model="status" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" @change="onFilterChange">
        <option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <select v-model="targetType" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" @change="onFilterChange">
        <option v-for="option in targetTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <input v-model="sourceBotKey" class="w-56 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="sourceBotKey" @keydown.enter="onFilterChange" />
      <button class="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-black" @click="onFilterChange">筛选</button>
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="min-w-full text-sm">
        <thead class="border-b bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
          <tr><th class="px-4 py-3">导入 ID</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">目标</th><th class="px-4 py-3">Bot</th><th class="px-4 py-3">外部消息</th><th class="px-4 py-3">文件</th><th class="px-4 py-3">重试</th><th class="px-4 py-3">创建时间</th><th class="px-4 py-3 text-right">操作</th></tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="record in records" :key="record.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 font-mono text-xs text-gray-600">{{ record.id }}</td>
            <td class="px-4 py-3"><span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusClass(record.status)]">{{ statusLabel(record.status) }}</span></td>
            <td class="px-4 py-3"><div>{{ targetTypeLabel(record.target_type) }}</div><div class="font-mono text-xs text-gray-400">{{ record.target_id || '-' }}</div></td>
            <td class="px-4 py-3 font-mono text-xs text-gray-600">{{ record.source_bot_key }}</td>
            <td class="px-4 py-3 font-mono text-xs text-gray-500">{{ record.external_message_id }}</td>
            <td class="px-4 py-3"><span class="text-green-700">{{ record.fetched_count }}</span> / {{ record.file_count }}<span v-if="record.failed_count" class="ml-1 text-red-600">失败 {{ record.failed_count }}</span></td>
            <td class="px-4 py-3">{{ record.retry_count }}</td>
            <td class="px-4 py-3 whitespace-nowrap text-gray-500">{{ formatDateTime(record.created_at) }}</td>
            <td class="px-4 py-3 text-right"><NuxtLink :to="`/admin/external-import-records/${record.id}`" class="text-xs text-blue-600 hover:underline">详情</NuxtLink></td>
          </tr>
          <tr v-if="records.length === 0 && !loading"><td colspan="9" class="px-4 py-10 text-center text-gray-400">暂无外部导入记录</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="mt-4 flex justify-center gap-2">
      <button :disabled="page <= 1" class="rounded border px-3 py-1 text-sm disabled:opacity-50" @click="page--">上一页</button>
      <span class="px-3 py-1 text-sm text-gray-600">{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" class="rounded border px-3 py-1 text-sm disabled:opacity-50" @click="page++">下一页</button>
    </div>
  </div>
</template>
