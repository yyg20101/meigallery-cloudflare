<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const page = ref(1)

// 筛选条件
const filterAction = ref('')
const filterTimeRange = ref('')
const filterAdmin = ref('')

const actionOptions = [
  { value: '', label: '全部操作' },
  { value: 'gallery.create', label: '创建图库' },
  { value: 'gallery.update', label: '更新图库' },
  { value: 'gallery.delete', label: '删除图库' },
  { value: 'gallery.publish', label: '发布图库' },
  { value: 'gallery.unpublish', label: '下架图库' },
  { value: 'tag.create', label: '创建标签' },
  { value: 'tag.delete', label: '删除标签' },
  { value: 'user.update', label: '更新用户' },
  { value: 'user.grant_membership', label: '发放会员' },
  { value: 'settings.update', label: '更新设置' },
  { value: 'media.upload', label: '上传媒体' },
  { value: 'media.delete', label: '删除媒体' },
  { value: 'import.create', label: '创建导入' },
  { value: 'import.process', label: '处理导入' },
]

const timeRangeOptions = [
  { value: '', label: '全部时间' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
]

const actionLabels: Record<string, string> = {
  'gallery.create': '创建图库', 'gallery.update': '更新图库', 'gallery.delete': '删除图库',
  'gallery.publish': '发布图库', 'gallery.unpublish': '下架图库',
  'tag.create': '创建标签', 'tag.delete': '删除标签',
  'user.update': '更新用户', 'user.grant_membership': '发放会员',
  'settings.update': '更新设置', 'media.upload': '上传媒体', 'media.delete': '删除媒体',
  'import.create': '创建导入', 'import.process': '处理导入',
}

interface AuditLog {
  id: string; admin_email: string; action: string; target_type: string
  target_id: string; created_at: string
}

const logs = ref<AuditLog[]>([])
const total = ref(0)
const loading = ref(true)
const totalPages = computed(() => Math.ceil(total.value / 30))

async function fetchLogs() {
  loading.value = true
  try {
    const query: Record<string, string> = { page: String(page.value), pageSize: '30' }
    if (filterAction.value) query.action = filterAction.value
    if (filterAdmin.value) query.adminEmail = filterAdmin.value
    if (filterTimeRange.value) {
      const days = parseInt(filterTimeRange.value)
      const since = new Date(Date.now() - days * 86400000).toISOString()
      query.since = since
    }
    const res = await api<{ data: AuditLog[]; total: number }>('/api/admin/audit-logs', { query })
    logs.value = res.data ?? []
    total.value = res.total ?? 0
  } finally {
    loading.value = false
  }
}

onMounted(fetchLogs)

watch([page, filterAction, filterTimeRange, filterAdmin], () => {
  fetchLogs()
})

// 防抖管理员搜索
let adminTimer: ReturnType<typeof setTimeout> | null = null
const adminSearchInput = ref('')
watch(adminSearchInput, (val) => {
  if (adminTimer) clearTimeout(adminTimer)
  adminTimer = setTimeout(() => {
    filterAdmin.value = val
    page.value = 1
  }, 400)
})

function formatDateTime(d: string) {
  if (!d) return '-'
  return d.replace('T', ' ').substring(0, 19)
}

function onFilterChange() {
  page.value = 1
}
</script>

<template>
  <div>
    <h1 class="text-xl font-bold text-gray-900 mb-6">审计日志</h1>

    <!-- 筛选栏 -->
    <div class="mb-4 flex flex-wrap gap-3">
      <select v-model="filterAction" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" @change="onFilterChange">
        <option v-for="opt in actionOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <select v-model="filterTimeRange" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" @change="onFilterChange">
        <option v-for="opt in timeRangeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <input
        v-model="adminSearchInput"
        placeholder="搜索管理员邮箱"
        class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-48"
      />
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-600">时间</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">管理员</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">操作</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">目标类型</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">目标 ID</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="log in logs" :key="log.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 text-gray-500 whitespace-nowrap">{{ formatDateTime(log.created_at) }}</td>
            <td class="px-4 py-3">{{ log.admin_email }}</td>
            <td class="px-4 py-3">{{ actionLabels[log.action] || log.action }}</td>
            <td class="px-4 py-3">{{ log.target_type }}</td>
            <td class="px-4 py-3 font-mono text-xs text-gray-500">{{ log.target_id || '-' }}</td>
          </tr>
          <tr v-if="logs.length === 0 && !loading">
            <td colspan="5" class="px-4 py-8 text-center text-gray-400">暂无日志</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="mt-4 flex justify-center gap-2">
      <button :disabled="page <= 1" class="rounded px-3 py-1 text-sm border disabled:opacity-50" @click="page--">上一页</button>
      <span class="px-3 py-1 text-sm text-gray-600">{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" class="rounded px-3 py-1 text-sm border disabled:opacity-50" @click="page++">下一页</button>
    </div>
  </div>
</template>
