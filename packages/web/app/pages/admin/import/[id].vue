<script setup lang="ts">
import { IMPORT_PACKAGE_LIMITS } from '@meigallery/shared/constants'
import { resolveAdminImportErrorReportUrl } from '~/utils/adminDownloadSecurity'
import { uploadAdminImportPackage } from '~/utils/adminImportUpload'
import type { AdminImportJobDetail, AdminImportJobItem } from '~/types/admin-import'
import {
  adminImportFigmaState,
  adminImportStateTone,
  adminImportStatusClass,
  adminImportStatusLabel,
  formatAdminImportBytes,
  isActiveAdminImportStatus,
} from '~/utils/adminImportJobs'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api, apiResponse } = useApi()
const toast = useToast()
const jobId = String(route.params.id || '')
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const commandBusy = ref(false)
const uploadBusy = ref(false)
const localError = ref('')
let pollTimer: ReturnType<typeof setInterval> | undefined
let pollRunning = false
const {
  turnstileToken,
  turnstileExpired,
  hasTurnstile,
  mountTurnstile,
  resetTurnstile,
  cleanupTurnstile,
} = useTurnstile({
  containerId: 'turnstile-admin-import-command',
  onError: message => toast.add({ title: message, color: 'error' }),
})

const { data: job, refresh, error: loadError, status: loadStatus } = await useAsyncData(
  `admin-zip-import-${jobId}`,
  () => api<AdminImportJobDetail>(`/api/admin/import-jobs/${encodeURIComponent(jobId)}`),
)

const pageState = computed(() => adminImportFigmaState(job.value?.status))
const pageTone = computed(() => adminImportStateTone(job.value?.status))
const items = computed(() => job.value?.items ?? [])
const pendingCount = computed(() => items.value.filter(item => item.status === 'pending' || item.status === 'processing').length)
const completedCount = computed(() => items.value.filter(item => item.status === 'completed').length)
const failedCount = computed(() => items.value.filter(item => item.status === 'failed').length)
const canReplacePackage = computed(() => {
  const current = job.value
  if (!current || current.success_count > 0 || completedCount.value > 0) return false
  return current.status === 'queued' || current.status === 'paused' || current.status === 'uploading'
})
const commandType = computed<'process' | 'retry' | 'resume' | null>(() => {
  if (job.value?.status === 'queued' && job.value.package_uploaded) return 'process'
  if (job.value?.status === 'partial_failure' && items.value.some(item => Number(item.retryable) === 1)) return 'retry'
  if (job.value?.status === 'paused' && job.value.package_uploaded) return 'resume'
  return null
})
const primaryLabel = computed(() => {
  if (commandBusy.value) return '提交中…'
  if (uploadBusy.value) return '上传中…'
  if (selectedFile.value && canReplacePackage.value) return '上传导入包'
  if (['queued', 'paused', 'uploading'].includes(job.value?.status || '') && !job.value?.package_uploaded) return '选择导入包'
  if (commandType.value === 'process') return '执行导入'
  if (commandType.value === 'retry') return '重试失败项'
  if (job.value?.status === 'partial_failure') return '新建修复任务'
  if (commandType.value === 'resume') return '继续任务'
  if (isActiveAdminImportStatus(job.value?.status)) return '校验中…'
  return '返回任务列表'
})
const needsCommandTurnstile = computed(() => Boolean(commandType.value))
const errorReportUrl = computed(() => job.value?.has_error_report
  ? resolveAdminImportErrorReportUrl(jobId)
  : null)
const stateNotice = computed(() => {
  if (pageState.value === '校验中') return {
    title: '校验中',
    detail: '服务器正在读取不可变 ZIP 快照并逐项写入；离开页面不会中断任务。',
    className: 'border-sky-200 bg-sky-50 text-sky-800',
  }
  if (pageState.value === '部分失败') return {
    title: '部分失败',
    detail: '成功条目已经保留。请查看逐项原因，只重试失败项，不会重复创建成功记录。',
    className: 'border-rose-200 bg-rose-50 text-rose-800',
  }
  if (pageState.value === '已暂停') return {
    title: '已暂停',
    detail: job.value?.last_error_message || '任务已安全暂停；修复可重试原因后可以继续。',
    className: 'border-amber-200 bg-amber-50 text-amber-900',
  }
  if (pageState.value === '已完成') return {
    title: '已完成',
    detail: '全部条目已处理并生成审计记录；管理员导入默认遵守草稿与发布权限边界。',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }
  return null
})

onMounted(() => {
  void mountTurnstile()
  pollTimer = setInterval(() => {
    if (isActiveAdminImportStatus(job.value?.status)) void refreshWithoutOverlap()
  }, 3000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  cleanupTurnstile()
})

async function refreshWithoutOverlap() {
  if (pollRunning) return
  pollRunning = true
  try {
    await refresh()
  }
  finally {
    pollRunning = false
  }
}

function openFilePicker() {
  if (canReplacePackage.value && !uploadBusy.value && !commandBusy.value) fileInput.value?.click()
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  localError.value = ''
  selectedFile.value = null
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.zip')) {
    localError.value = '请选择扩展名为 .zip 的导入包'
    return
  }
  if (file.size <= 0 || file.size > IMPORT_PACKAGE_LIMITS.MAX_ARCHIVE_BYTES) {
    localError.value = 'ZIP 文件必须大于 0，且不能超过 256 MB'
    return
  }
  selectedFile.value = file
}

async function uploadPackage() {
  const file = selectedFile.value
  if (!file || !canReplacePackage.value) return
  uploadBusy.value = true
  localError.value = ''
  try {
    await uploadAdminImportPackage(api, apiResponse, jobId, file)
    selectedFile.value = null
    toast.add({ title: 'ZIP 原包已安全上传', description: '可以执行服务端校验与逐项导入。', color: 'success' })
    await refresh()
  }
  catch (error: unknown) {
    localError.value = resolveApiErrorMessage(error, 'ZIP 上传失败')
    toast.add({ title: localError.value, color: 'error' })
    await refresh()
  }
  finally {
    uploadBusy.value = false
  }
}

async function runCommand() {
  const type = commandType.value
  if (!type) return
  if (hasTurnstile.value && !turnstileToken.value) {
    toast.add({ title: '请先完成人机验证', color: 'warning' })
    return
  }
  commandBusy.value = true
  localError.value = ''
  try {
    const result = await api<{ message: string }>(
      `/api/admin/import-jobs/${encodeURIComponent(jobId)}/${type}`,
      {
        method: 'POST',
        body: { turnstileToken: hasTurnstile.value ? turnstileToken.value : undefined },
      },
    )
    toast.add({ title: result.message, color: 'success' })
    resetTurnstile()
    await refresh()
  }
  catch (error: unknown) {
    localError.value = resolveApiErrorMessage(error, '导入命令执行失败')
    toast.add({ title: localError.value, color: 'error' })
    resetTurnstile()
    await refresh()
  }
  finally {
    commandBusy.value = false
  }
}

async function runPrimaryAction() {
  if (selectedFile.value && canReplacePackage.value) {
    await uploadPackage()
    return
  }
  if (['queued', 'paused', 'uploading'].includes(job.value?.status || '') && !job.value?.package_uploaded) {
    openFilePicker()
    return
  }
  if (commandType.value) {
    await runCommand()
    return
  }
  if (!isActiveAdminImportStatus(job.value?.status)) await navigateTo('/admin/app/imports')
}

function itemValidationLabel(item: AdminImportJobItem): string {
  if (item.status === 'pending') return '待校验'
  if (item.status === 'processing') return '校验中'
  if (item.status === 'failed') return item.error_message || item.error_code || '失败'
  return '通过'
}

function itemResultLabel(item: AdminImportJobItem): string {
  if (item.status === 'completed') return '已导入'
  if (item.status === 'failed') return '失败'
  if (item.status === 'processing') return '处理中'
  return '等待'
}

function itemResultClass(item: AdminImportJobItem): string {
  if (item.status === 'completed') return 'text-emerald-700'
  if (item.status === 'failed') return 'text-rose-700'
  if (item.status === 'processing') return 'text-sky-700'
  return 'text-[#8a7d76]'
}

function mediaLabel(item: AdminImportJobItem): string {
  const parts = [`${Number(item.image_count || 0)} 张`]
  if (Number(item.video_count || 0) > 0) parts.push(`${item.video_count} 个视频`)
  return parts.join(' · ')
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—'
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader
      page-id="ADM-PER-04"
      route="/admin/app/imports"
      title="导入任务"
      description="上传或引用导入包，逐项校验并允许部分失败重试。"
      :state="pageState"
      :figma-state="pageState"
      :state-tone="pageTone"
    >
      <template #actions>
        <NuxtLink to="/admin/app/imports" class="inline-flex min-h-11 items-center rounded-[10px] border border-[#eaded8] bg-white px-4 text-sm font-medium text-[#6a5f5a] hover:bg-[#fff9f6]">返回列表</NuxtLink>
        <button
          type="button"
          :disabled="commandBusy || uploadBusy || (isActiveAdminImportStatus(job?.status) && job?.status !== 'uploading')"
          class="inline-flex min-h-11 items-center justify-center rounded-[10px] bg-[#cf3f61] px-5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(207,63,97,0.18)] transition hover:bg-[#b93252] disabled:cursor-not-allowed disabled:opacity-45"
          @click="runPrimaryAction"
        >
          {{ primaryLabel }}
        </button>
      </template>
    </AdminAppPageHeader>

    <div v-if="stateNotice" class="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-6" :class="stateNotice.className" role="status" aria-live="polite">
      <svg class="mt-0.5 size-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="pageState === '已完成'" d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M9 12l2 2l4 -4" />
        <template v-else><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 8v4" /><path d="M12 16h.01" /></template>
      </svg>
      <div class="min-w-0"><p class="font-semibold">{{ stateNotice.title }}</p><p class="break-words opacity-90">{{ stateNotice.detail }}</p></div>
    </div>

    <div v-if="localError" role="alert" class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">
      <p class="font-semibold">本次操作未完成</p>
      <p class="break-words">{{ localError }}</p>
    </div>

    <template v-if="job">
      <section
        class="flex min-h-[190px] flex-col items-center justify-center rounded-xl border border-dashed border-[#d8d0cc] bg-white px-5 py-7 text-center"
        :class="canReplacePackage ? 'cursor-pointer hover:border-[#cf3f61]/70 hover:bg-[#fffaf8]' : ''"
        :role="canReplacePackage ? 'button' : undefined"
        :tabindex="canReplacePackage ? 0 : undefined"
        @click="openFilePicker"
        @keydown.enter.prevent="openFilePicker"
        @keydown.space.prevent="openFilePicker"
      >
        <input ref="fileInput" type="file" accept=".zip,application/zip,application/x-zip-compressed" class="sr-only" @change="onFileSelected">
        <svg class="size-9 text-[#2c2421]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M9 17h6" /><path d="M9 13h6" />
        </svg>
        <h2 class="mt-3 text-base font-semibold text-[#2c2421]">{{ selectedFile?.name || job.source_name || '拖入 gallery-import.zip' }}</h2>
        <p class="mt-1 text-xs leading-5 text-[#8a7d76]">
          <template v-if="selectedFile">{{ formatAdminImportBytes(selectedFile.size) }} · 点击页首按钮上传此文件</template>
          <template v-else-if="job.package_uploaded">{{ formatAdminImportBytes(job.package_size) }} · 已保存不可变私有原包 · {{ formatTimestamp(job.uploaded_at) }}</template>
          <template v-else>包含 manifest.csv、content.md、cover.jpg 与至少一张图片</template>
        </p>
        <span v-if="canReplacePackage" class="mt-4 inline-flex min-h-9 items-center rounded-lg bg-[#cf3f61] px-4 text-xs font-semibold text-white">{{ job.package_uploaded ? '更换导入包' : '选择导入包' }}</span>
        <span v-else class="mt-4 inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium" :class="adminImportStatusClass(job.status)">{{ adminImportStatusLabel(job.status) }}</span>
      </section>

      <section v-show="needsCommandTurnstile && hasTurnstile" class="rounded-xl border border-[#eaded8] bg-white px-4 py-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm font-medium text-[#2c2421]">导入命令安全验证</p>
            <p class="mt-1 text-xs text-[#8a7d76]">执行、重试和继续均写入管理员审计日志。</p>
          </div>
          <div id="turnstile-admin-import-command" />
        </div>
        <p v-if="turnstileExpired" class="mt-2 text-xs text-amber-700">验证已过期，请重新完成验证。</p>
      </section>

      <section v-if="isActiveAdminImportStatus(job.status) && job.total_count > 0" class="rounded-xl border border-sky-200 bg-sky-50 p-4">
        <div class="flex items-center justify-between gap-3 text-xs font-medium text-sky-800">
          <span>逐项处理进度</span><span>{{ job.success_count + job.failure_count }} / {{ job.total_count }}</span>
        </div>
        <div class="mt-2 h-2 overflow-hidden rounded-full bg-sky-100">
          <div class="h-full rounded-full bg-sky-500 transition-all" :style="{ width: `${Math.min(100, ((job.success_count + job.failure_count) / job.total_count) * 100)}%` }" />
        </div>
      </section>

      <section class="grid min-w-0 gap-3 md:grid-cols-3">
        <article class="rounded-xl border border-[#eaded8] bg-white p-4">
          <p class="text-xs text-[#8a7d76]">待校验</p>
          <strong class="mt-2 block text-2xl font-semibold text-[#2c2421]">{{ pendingCount || (job.package_uploaded && !job.total_count ? 1 : 0) }}</strong>
          <span class="mt-2 block text-xs text-emerald-600">正在或等待读取 manifest</span>
        </article>
        <article class="rounded-xl border border-[#eaded8] bg-white p-4">
          <p class="text-xs text-[#8a7d76]">可导入</p>
          <strong class="mt-2 block text-2xl font-semibold text-[#2c2421]">{{ completedCount || job.success_count }}</strong>
          <span class="mt-2 block text-xs text-emerald-600">已安全生成目标记录</span>
        </article>
        <article class="rounded-xl border border-[#eaded8] bg-white p-4">
          <p class="text-xs text-[#8a7d76]">失败</p>
          <strong class="mt-2 block text-2xl font-semibold text-[#2c2421]">{{ failedCount || job.failure_count }}</strong>
          <span class="mt-2 block text-xs text-amber-700">不阻塞其他有效项目</span>
        </article>
      </section>

      <section class="overflow-hidden rounded-xl border border-[#eaded8] bg-white">
        <div class="flex flex-col gap-3 border-b border-[#eee5e1] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-[#2c2421]">逐项校验与结果</h2>
            <p class="mt-0.5 break-all font-mono text-[11px] text-[#9b8f89]">{{ job.id }} · 第 {{ job.attempt_count }} 次执行</p>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <a v-if="errorReportUrl" :href="errorReportUrl" download referrerpolicy="no-referrer" class="text-xs font-semibold text-rose-700 hover:underline">查看失败 CSV</a>
            <span class="text-xs text-[#8a7d76]">更新于 {{ formatTimestamp(job.updated_at || job.created_at) }}</span>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] text-left text-sm">
            <thead class="bg-[#fbf9f8] text-xs font-medium text-[#8a7d76]">
              <tr><th class="px-4 py-3">目录</th><th class="px-4 py-3">标题</th><th class="px-4 py-3">校验</th><th class="px-4 py-3">媒体</th><th class="px-4 py-3">结果</th></tr>
            </thead>
            <tbody class="divide-y divide-[#eee5e1]">
              <tr v-for="item in items" :key="item.id" class="align-top hover:bg-[#fffaf8]">
                <td class="px-4 py-3 font-mono text-xs text-[#6a5f5a]">{{ item.folder }}</td>
                <td class="px-4 py-3"><p class="font-medium text-[#2c2421]">{{ item.title || '未命名' }}</p><p class="mt-1 font-mono text-[11px] text-[#9b8f89]">{{ item.slug }}</p></td>
                <td class="max-w-[260px] px-4 py-3"><p :class="item.status === 'failed' ? 'text-rose-700' : 'text-[#6a5f5a]'">{{ itemValidationLabel(item) }}</p><p v-if="item.error_code" class="mt-1 font-mono text-[10px] text-[#9b8f89]">{{ item.error_code }}</p></td>
                <td class="whitespace-nowrap px-4 py-3 text-[#6a5f5a]">{{ mediaLabel(item) }}</td>
                <td class="px-4 py-3 font-medium" :class="itemResultClass(item)">
                  <NuxtLink v-if="item.gallery_id" :to="`/admin/galleries/${item.gallery_id}`" class="hover:underline">{{ itemResultLabel(item) }}</NuxtLink>
                  <template v-else>{{ itemResultLabel(item) }}</template>
                </td>
              </tr>
              <tr v-if="!items.length"><td colspan="5" class="px-4 py-10 text-center text-sm text-[#8a7d76]">{{ job.package_uploaded ? '执行导入后将在这里显示逐项校验结果' : '请先选择并上传 ZIP 导入包' }}</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="grid gap-3 rounded-xl border border-[#eaded8] bg-white p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><p class="text-xs text-[#8a7d76]">创建者</p><p class="mt-1 truncate font-medium text-[#2c2421]">{{ job.creator_email }}</p></div>
        <div><p class="text-xs text-[#8a7d76]">创建时间</p><p class="mt-1 font-medium text-[#2c2421]">{{ formatTimestamp(job.created_at) }}</p></div>
        <div><p class="text-xs text-[#8a7d76]">开始时间</p><p class="mt-1 font-medium text-[#2c2421]">{{ formatTimestamp(job.started_at) }}</p></div>
        <div><p class="text-xs text-[#8a7d76]">完成时间</p><p class="mt-1 font-medium text-[#2c2421]">{{ formatTimestamp(job.completed_at) }}</p></div>
      </section>
    </template>

    <div v-else class="rounded-xl border border-[#eaded8] bg-white px-6 py-14 text-center">
      <p class="text-sm font-medium text-[#2c2421]">{{ loadStatus === 'pending' ? '正在加载导入任务…' : '导入任务不存在或无权查看' }}</p>
      <p v-if="loadError" class="mt-2 text-xs text-rose-700">{{ resolveApiErrorMessage(loadError, '任务加载失败') }}</p>
      <NuxtLink to="/admin/app/imports" class="mt-4 inline-flex min-h-10 items-center rounded-lg bg-[#cf3f61] px-4 text-sm font-semibold text-white">返回导入任务</NuxtLink>
    </div>
  </div>
</template>
