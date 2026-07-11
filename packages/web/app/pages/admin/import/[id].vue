<script setup lang="ts">
import { resolveAdminImportErrorReportUrl } from '~/utils/adminDownloadSecurity'
import { parseAdminImportManifestCsv } from '~/utils/adminImportManifest'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const jobId = route.params.id as string
const {
  turnstileToken,
  turnstileExpired,
  hasTurnstile,
  mountTurnstile,
  resetTurnstile,
  cleanupTurnstile,
} = useTurnstile({
  containerId: 'turnstile-admin-import-process',
  onError: message => useToast().add({ title: message, color: 'error' }),
})

interface ImportJobDetail {
  id: string
  status: string
  total_count: number
  success_count: number
  failure_count: number
  error_report_key: string | null
  creator_email: string
  created_at: string
  completed_at: string | null
}

const { data: job, refresh } = await useAsyncData(`import-job-${jobId}`, () =>
  api<ImportJobDetail>(`/api/admin/import-jobs/${jobId}`),
)

// 用于提交处理的表单
const manifestText = ref('')
const processing = ref(false)

interface ProcessResult {
  successCount: number
  failureCount: number
  errors?: Array<{ folder: string; error: string }>
}
const processResult = ref<ProcessResult | null>(null)
const errorReportUrl = computed(() => resolveAdminImportErrorReportUrl(job.value?.id ?? jobId))

onMounted(() => {
  void mountTurnstile()
})

onUnmounted(() => {
  cleanupTurnstile()
})

async function processJob() {
  if (!manifestText.value.trim()) {
    useToast().add({ title: '请粘贴 manifest CSV 内容', color: 'warning' })
    return
  }
  if (hasTurnstile.value && !turnstileToken.value) {
    useToast().add({ title: '请先完成人机验证', color: 'warning' })
    return
  }

  processing.value = true
  try {
    const parsedManifest = parseAdminImportManifestCsv(manifestText.value)
    if (parsedManifest.errors.length > 0) {
      useToast().add({ title: parsedManifest.errors[0], color: 'error' })
      return
    }

    const result = await api<ProcessResult>(
      `/api/admin/import-jobs/${jobId}/process`,
      {
        method: 'POST',
        body: {
          galleries: parsedManifest.galleries,
          turnstileToken: hasTurnstile.value ? turnstileToken.value : undefined,
        },
      },
    )
    processResult.value = result
    refresh()
  } catch (e: any) {
    useToast().add({ title: resolveApiErrorMessage(e, '处理失败'), color: 'error' })
    resetTurnstile()
  } finally {
    processing.value = false
  }
}

const statusColors: Record<string, string> = {
  queued: 'bg-yellow-100 text-yellow-800',
  processing: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
}
</script>

<template>
  <div class="max-w-4xl">
    <div class="flex items-center gap-3 mb-6">
      <NuxtLink to="/admin/import" class="text-sm text-gray-500 hover:text-gray-700">&larr; 返回列表</NuxtLink>
      <h1 class="text-xl font-bold text-gray-900">导入任务详情</h1>
    </div>

    <div v-if="job" class="space-y-6">
      <!-- 任务信息卡片 -->
      <div class="rounded-lg bg-white p-5 border border-gray-200">
        <dl class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <dt class="text-gray-500">ID</dt>
            <dd class="font-mono text-xs mt-1">{{ job.id }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">状态</dt>
            <dd class="mt-1">
              <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusColors[job.status] || '']">
                {{ job.status }}
              </span>
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">总数 / 成功 / 失败</dt>
            <dd class="mt-1 font-medium">{{ job.total_count }} / <span class="text-green-600">{{ job.success_count }}</span> / <span class="text-red-600">{{ job.failure_count }}</span></dd>
          </div>
          <div>
            <dt class="text-gray-500">创建者</dt>
            <dd class="mt-1">{{ job.creator_email }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">创建时间</dt>
            <dd class="mt-1 text-gray-700">{{ job.created_at }}</dd>
          </div>
          <div v-if="job.completed_at">
            <dt class="text-gray-500">完成时间</dt>
            <dd class="mt-1 text-gray-700">{{ job.completed_at }}</dd>
          </div>
        </dl>
      </div>

      <!-- 处理入口（仅 queued 状态） -->
      <div v-if="job.status === 'queued'" class="rounded-lg bg-white p-5 border border-gray-200">
        <h2 class="text-base font-semibold text-gray-900 mb-3">提交导入数据</h2>
        <p class="text-sm text-gray-500 mb-3">
          粘贴 manifest.csv 内容（首行为表头：folder,title,slug,region,personality,style,tags,required_level,status）
        </p>
        <textarea
          v-model="manifestText"
          rows="10"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          placeholder="folder,title,slug,region,personality,style,tags,required_level,status&#10;gallery-001,夏日写真,summer-portrait-001,广东,甜美,清新,&quot;长发,户外&quot;,vip,draft"
        />
        <div v-if="hasTurnstile" class="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p class="text-sm text-gray-600">开始处理导入任务前需完成安全验证。</p>
            <div id="turnstile-admin-import-process" />
          </div>
          <p v-if="turnstileExpired" class="mt-2 text-xs text-amber-600">验证已过期，请重新完成验证。</p>
        </div>
        <button
          :disabled="processing"
          class="mt-3 rounded-lg bg-green-600 px-6 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
          @click="processJob"
        >
          {{ processing ? '处理中...' : '开始处理' }}
        </button>
      </div>

      <!-- 处理结果 -->
      <div v-if="processResult" class="rounded-lg bg-white p-5 border border-gray-200">
        <h2 class="text-base font-semibold text-gray-900 mb-3">处理结果</h2>
        <div class="flex gap-6 text-sm mb-4">
          <p>成功: <span class="text-green-600 font-bold">{{ processResult.successCount }}</span></p>
          <p>失败: <span class="text-red-600 font-bold">{{ processResult.failureCount }}</span></p>
        </div>
        <div v-if="processResult.errors && processResult.errors.length > 0">
          <h3 class="text-sm font-medium text-red-700 mb-2">错误详情：</h3>
          <div class="max-h-60 overflow-y-auto rounded border border-red-100 bg-red-50 p-3">
            <ul class="text-xs text-red-600 space-y-1">
              <li v-for="(err, i) in processResult.errors" :key="i">
                <span class="font-mono font-medium">{{ err.folder }}</span>: {{ err.error }}
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 错误报告下载 -->
      <div v-if="job.error_report_key && errorReportUrl" class="rounded-lg bg-white p-4 border border-gray-200">
        <a
          :href="errorReportUrl"
          class="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline"
          referrerpolicy="no-referrer"
          download
        >
          下载错误报告 CSV
        </a>
      </div>
    </div>

    <div v-else class="text-center py-12 text-gray-500">
      任务不存在
    </div>
  </div>
</template>
