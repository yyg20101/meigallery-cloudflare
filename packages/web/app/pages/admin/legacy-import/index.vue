<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

interface LegacyImportSource {
  id: string
  name: string
  base_url?: string | null
  baseUrl?: string | null
  mode: 'rest_api' | 'xml'
}

interface LegacyImportJob {
  id: string
  status: string
  source_key: string
  success_count: number
  failure_count: number
  created_at: string
  legacy_processing_expires_at?: string | null
  recovery_available?: number
}

interface LegacyExecuteResult {
  totalPosts: number
  processed: number
  skippedDuplicates: number
  successCount: number
  failureCount: number
  errors?: Array<{ title: string; errorCode: string; error: string }>
}

interface LegacyMediaDownloadResult {
  galleries: number
  selectedCount: number
  downloaded: number
  failed: number
  skipped: number
  remaining: number
  done: boolean
  errors: string[]
}

// 来源列表
const sources = ref<LegacyImportSource[]>([])
const loadingSources = ref(false)

// 创建来源表单
const newSource = reactive({ name: '', baseUrl: '', mode: 'rest_api' })
const creating = ref(false)

// 任务列表
const jobs = ref<LegacyImportJob[]>([])
const startingJob = ref(false)
const selectedSourceId = ref('')

// 执行/下载状态
const executingJobId = ref<string | null>(null)
const downloadingJobId = ref<string | null>(null)
const executeResult = ref<LegacyExecuteResult | null>(null)
const downloadResult = ref<LegacyMediaDownloadResult | null>(null)

async function fetchSources() {
  loadingSources.value = true
  try {
    const res = await api<{ data: LegacyImportSource[] }>('/api/admin/legacy-import/sources')
    sources.value = res.data ?? []
  } finally {
    loadingSources.value = false
  }
}

async function createSource() {
  if (!newSource.name || !newSource.baseUrl) return
  creating.value = true
  try {
    await api('/api/admin/legacy-import/sources', {
      method: 'POST',
      body: { name: newSource.name, baseUrl: newSource.baseUrl, mode: newSource.mode },
    })
    newSource.name = ''
    newSource.baseUrl = ''
    newSource.mode = 'rest_api'
    await fetchSources()
  } finally {
    creating.value = false
  }
}

async function startJob() {
  if (!selectedSourceId.value) return
  startingJob.value = true
  try {
    await api('/api/admin/legacy-import/jobs', {
      method: 'POST',
      body: { sourceId: selectedSourceId.value },
    })
    await fetchJobs()
  } finally {
    startingJob.value = false
  }
}

async function executeJob(jobId: string) {
  executingJobId.value = jobId
  executeResult.value = null
  try {
    const res = await api<LegacyExecuteResult>(`/api/admin/legacy-import/jobs/${jobId}/execute`, { method: 'POST' })
    executeResult.value = res
    await fetchJobs()
  } catch (e: any) {
    useToast().add({ title: resolveApiErrorMessage(e, '执行失败'), color: 'error' })
  } finally {
    executingJobId.value = null
  }
}

async function downloadMedia(jobId: string) {
  downloadingJobId.value = jobId
  downloadResult.value = null
  try {
    const res = await api<LegacyMediaDownloadResult>(`/api/admin/legacy-import/jobs/${jobId}/download-media`, { method: 'POST' })
    downloadResult.value = res
    await fetchJobs()
  } catch (e: any) {
    useToast().add({ title: resolveApiErrorMessage(e, '下载失败'), color: 'error' })
  } finally {
    downloadingJobId.value = null
  }
}

async function fetchJobs() {
  try {
    const res = await api<{ data: LegacyImportJob[]; total: number }>('/api/admin/legacy-import/jobs', {
      query: { pageSize: '50' },
    })
    jobs.value = res.data ?? []
  } catch {
    jobs.value = []
  }
}

function getSourceName(sourceKey: string): string {
  const s = sources.value.find(s => s.id === sourceKey)
  return s?.name ?? sourceKey?.slice(0, 12) ?? '-'
}

function getSourceBaseUrl(source: LegacyImportSource): string | null {
  return source?.base_url ?? source?.baseUrl ?? null
}

const statusLabel: Record<string, string> = {
  pending: '等待中',
  queued: '排队中',
  processing: '执行中',
  completed: '已完成',
  failed: '失败',
}

const statusColors: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-800',
  queued: 'bg-yellow-100 text-yellow-800',
  processing: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
}

onMounted(() => {
  fetchSources()
  fetchJobs()
})
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">WordPress 旧站迁移</h1>
    </div>

    <!-- 创建来源 -->
    <div class="mb-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 class="mb-4 text-base font-semibold text-gray-800">添加迁移来源</h2>
      <form class="flex flex-wrap items-end gap-4" @submit.prevent="createSource">
        <div class="flex-1 min-w-[160px]">
          <label class="mb-1 block text-sm text-gray-600">名称</label>
          <input v-model="newSource.name" type="text" placeholder="例如：旧站主站" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div class="flex-1 min-w-[200px]">
          <label class="mb-1 block text-sm text-gray-600">站点地址</label>
          <input v-model="newSource.baseUrl" type="url" placeholder="https://example.com" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div class="w-[140px]">
          <label class="mb-1 block text-sm text-gray-600">模式</label>
          <select v-model="newSource.mode" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="rest_api">REST API</option>
            <option value="xml">XML 导出</option>
          </select>
        </div>
        <button type="submit" :disabled="creating" class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
          {{ creating ? '创建中...' : '添加来源' }}
        </button>
      </form>
    </div>

    <!-- 来源列表 -->
    <div class="mb-8">
      <h2 class="mb-4 text-base font-semibold text-gray-800">已配置来源</h2>
      <div v-if="loadingSources" class="text-sm text-gray-500">加载中...</div>
      <div v-else-if="sources.length === 0" class="text-sm text-gray-500">暂无来源，请先添加。</div>
      <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="source in sources" :key="source.id" class="rounded-lg border border-gray-200 bg-white p-4">
          <div class="mb-1 font-medium text-gray-900">{{ source.name }}</div>
          <div class="mb-2 text-xs">
            <AdminSafeExternalLink :href="getSourceBaseUrl(source)" />
          </div>
          <span class="rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-800">{{ source.mode === 'rest_api' ? 'REST API' : 'XML' }}</span>
        </div>
      </div>
    </div>

    <!-- 启动任务 -->
    <div class="mb-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 class="mb-4 text-base font-semibold text-gray-800">启动迁移任务</h2>
      <div class="flex items-end gap-4">
        <div class="flex-1 max-w-[300px]">
          <label class="mb-1 block text-sm text-gray-600">选择来源</label>
          <select v-model="selectedSourceId" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="" disabled>请选择来源</option>
            <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option>
          </select>
        </div>
        <button :disabled="!selectedSourceId || startingJob" class="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50" @click="startJob">
          {{ startingJob ? '启动中...' : '启动任务' }}
        </button>
      </div>
    </div>

    <!-- 最近任务 -->
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-base font-semibold text-gray-800">迁移任务</h2>
        <NuxtLink to="/admin/legacy-import/items" class="text-sm text-blue-600 hover:underline">查看条目审核 &rarr;</NuxtLink>
      </div>
      <div v-if="jobs.length === 0" class="text-sm text-gray-500">暂无任务记录。</div>
      <div v-else class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table class="w-full text-sm">
          <thead class="border-b bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-600">任务 ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">来源</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">状态</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">成功/失败</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">创建时间</th>
              <th class="px-4 py-3 text-right font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr v-for="job in jobs" :key="job.id" class="hover:bg-gray-50">
              <td class="px-4 py-3 font-mono text-xs">{{ job.id.slice(0, 12) }}</td>
              <td class="px-4 py-3">{{ getSourceName(job.source_key) }}</td>
              <td class="px-4 py-3">
                <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusColors[job.status] || 'bg-gray-100 text-gray-800']">
                  {{ statusLabel[job.status] ?? job.status }}
                </span>
              </td>
              <td class="px-4 py-3">
                <span class="text-green-600">{{ job.success_count }}</span> /
                <span class="text-red-600">{{ job.failure_count }}</span>
              </td>
              <td class="px-4 py-3 text-gray-500">{{ job.created_at?.split('T')[0] }}</td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-2">
                  <!-- 执行按钮：仅 pending 状态 -->
                  <button
                    v-if="job.status === 'pending'"
                    :disabled="executingJobId === job.id"
                    class="rounded-lg bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                    @click="executeJob(job.id)"
                  >
                    {{ executingJobId === job.id ? '执行中...' : '执行迁移' }}
                  </button>
                  <!-- 下载媒体按钮：completed 状态 -->
                  <button
                    v-if="job.status === 'completed'"
                    :disabled="downloadingJobId === job.id"
                    class="rounded-lg bg-purple-600 px-3 py-1 text-xs text-white hover:bg-purple-700 disabled:opacity-50"
                    @click="downloadMedia(job.id)"
                  >
                    {{ downloadingJobId === job.id ? '下载中...' : '下载媒体' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 执行结果 -->
      <div v-if="executeResult" class="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm">
        <p class="font-medium text-green-800">迁移完成</p>
        <p>总文章: {{ executeResult.totalPosts }}，处理: {{ executeResult.processed }}，跳过重复: {{ executeResult.skippedDuplicates }}</p>
        <p>成功: <span class="font-bold text-green-700">{{ executeResult.successCount }}</span>，失败: <span class="font-bold text-red-600">{{ executeResult.failureCount }}</span></p>
        <div v-if="executeResult.errors" class="mt-2 max-h-40 overflow-y-auto text-xs text-red-600">
          <p v-for="(err, i) in executeResult.errors" :key="i">{{ err.title }}: {{ err.error }}</p>
        </div>
      </div>

      <!-- 下载结果 -->
      <div v-if="downloadResult" class="mt-4 rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm">
        <p class="font-medium text-purple-800">媒体下载完成</p>
        <p>图库数: {{ downloadResult.galleries }}，下载成功: {{ downloadResult.downloaded }}，失败: {{ downloadResult.failed }}</p>
      </div>
    </div>
  </div>
</template>
