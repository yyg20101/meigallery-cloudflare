<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

// 来源列表
const sources = ref<any[]>([])
const loadingSources = ref(false)

// 创建来源表单
const newSource = reactive({ name: '', baseUrl: '', mode: 'rest_api' })
const creating = ref(false)

// 任务列表
const jobs = ref<any[]>([])
const startingJob = ref(false)
const selectedSourceId = ref('')

async function fetchSources() {
  loadingSources.value = true
  try {
    const res = await api<{ data: any[] }>('/api/admin/legacy-import/sources')
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

async function fetchJobs() {
  // 获取最近任务（简化：取所有来源的任务）
  const res = await api<{ data: any[] }>('/api/admin/legacy-import/jobs')
  jobs.value = res.data ?? []
}

const statusLabel: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
}

const statusColor: Record<string, string> = {
  pending: 'gray',
  running: 'blue',
  completed: 'green',
  failed: 'red',
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
          <div class="mb-2 text-xs text-gray-500 truncate">{{ source.baseUrl }}</div>
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
      <h2 class="mb-4 text-base font-semibold text-gray-800">最近任务</h2>
      <div v-if="jobs.length === 0" class="text-sm text-gray-500">暂无任务记录。</div>
      <div v-else class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table class="w-full text-sm">
          <thead class="border-b bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-600">任务 ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">来源</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">状态</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">进度</th>
              <th class="px-4 py-3 text-left font-medium text-gray-600">创建时间</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr v-for="job in jobs" :key="job.id" class="hover:bg-gray-50">
              <td class="px-4 py-3 font-mono text-xs">{{ job.id }}</td>
              <td class="px-4 py-3">{{ sources.find(s => s.id === job.sourceId)?.name ?? job.sourceId }}</td>
              <td class="px-4 py-3">
                <span :class="`rounded-full px-2 py-0.5 text-xs font-medium bg-${statusColor[job.status] ?? 'gray'}-100 text-${statusColor[job.status] ?? 'gray'}-800`">
                  {{ statusLabel[job.status] ?? job.status }}
                </span>
              </td>
              <td class="px-4 py-3">{{ job.progress ?? 0 }}%</td>
              <td class="px-4 py-3 text-gray-500">{{ job.createdAt }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
