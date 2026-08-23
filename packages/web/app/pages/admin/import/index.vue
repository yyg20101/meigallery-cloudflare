<script setup lang="ts">
import { IMPORT_PACKAGE_LIMITS } from '@meigallery/shared/constants'
import type { AdminImportJobSummary } from '~/types/admin-import'
import { uploadAdminImportPackage } from '~/utils/adminImportUpload'
import {
  adminImportFigmaState,
  adminImportStateTone,
  adminImportStatusClass,
  adminImportStatusLabel,
  formatAdminImportBytes,
} from '~/utils/adminImportJobs'

definePageMeta({ layout: 'admin' })

const { api, apiResponse } = useApi()
const toast = useToast()
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const createdJobId = ref('')
const busy = ref(false)
const dragActive = ref(false)
const localError = ref('')
const busyLabel = ref('')
const {
  turnstileToken,
  turnstileExpired,
  hasTurnstile,
  mountTurnstile,
  resetTurnstile,
  cleanupTurnstile,
} = useTurnstile({
  containerId: 'turnstile-admin-import-create',
  onError: message => toast.add({ title: message, color: 'error' }),
})

const { data, refresh, status: listStatus } = await useAsyncData('admin-zip-imports', () =>
  api<{ data: AdminImportJobSummary[]; total: number }>('/api/admin/import-jobs', {
    query: { type: 'zip', pageSize: 20 },
  }),
)
const jobs = computed(() => data.value?.data ?? [])
const pageState = computed(() => busy.value
  ? '校验中'
  : localError.value
    ? '部分失败'
    : adminImportFigmaState(jobs.value[0]?.status))
const pageTone = computed(() => localError.value
  ? 'danger'
  : busy.value
    ? 'warning'
    : adminImportStateTone(jobs.value[0]?.status))
const waitingCount = computed(() => jobs.value.reduce((total, job) => {
  if (job.status === 'queued' && job.total_count === 0) return total + 1
  if (!['validating', 'processing', 'finalizing'].includes(job.status)) return total
  return total + Math.max(0, job.total_count - job.success_count - job.failure_count)
}, selectedFile.value ? 1 : 0))
const importableCount = computed(() => jobs.value.reduce((total, job) => total + Number(job.success_count || 0), 0))
const failureCount = computed(() => jobs.value.reduce((total, job) => total + Number(job.failure_count || 0), 0))

onMounted(() => {
  void mountTurnstile()
})

onUnmounted(() => {
  cleanupTurnstile()
})

function openFilePicker() {
  if (!busy.value) fileInput.value?.click()
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  acceptFile(input.files?.[0] ?? null)
  input.value = ''
}

function onFileDropped(event: DragEvent) {
  dragActive.value = false
  acceptFile(event.dataTransfer?.files?.[0] ?? null)
}

function acceptFile(file: File | null) {
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

async function executeImport() {
  const file = selectedFile.value
  if (!file) {
    toast.add({ title: '请先选择 ZIP 导入包', color: 'warning' })
    return
  }
  if (!createdJobId.value && hasTurnstile.value && !turnstileToken.value) {
    toast.add({ title: '请先完成人机验证', color: 'warning' })
    return
  }

  busy.value = true
  localError.value = ''
  try {
    let jobId = createdJobId.value
    let createdThisAttempt = false
    if (!jobId) {
      busyLabel.value = '正在创建任务…'
      const created = await api<{ id: string }>('/api/admin/import-jobs', {
        method: 'POST',
        body: { turnstileToken: hasTurnstile.value ? turnstileToken.value : undefined },
      })
      jobId = created.id
      createdJobId.value = jobId
      createdThisAttempt = true
    }

    busyLabel.value = '正在初始化分片上传…'
    await uploadAdminImportPackage(api, apiResponse, jobId, file, {
      devWriteAlreadyConfirmed: createdThisAttempt,
      onProgress: (uploadedParts, partCount) => {
        busyLabel.value = uploadedParts === partCount
          ? '正在合并私有原包…'
          : `正在上传 ${uploadedParts} / ${partCount}…`
      },
    })
    await navigateTo(`/admin/app/imports/${jobId}`)
  }
  catch (error: unknown) {
    localError.value = resolveApiErrorMessage(error, '导入包上传失败')
    toast.add({ title: localError.value, color: 'error' })
    resetTurnstile()
    await refresh()
  }
  finally {
    busy.value = false
    busyLabel.value = ''
  }
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
        <button
          type="button"
          :disabled="busy || !selectedFile"
          class="inline-flex min-h-11 items-center justify-center rounded-[10px] bg-[#cf3f61] px-5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(207,63,97,0.18)] transition hover:bg-[#b93252] disabled:cursor-not-allowed disabled:opacity-45"
          @click="executeImport"
        >
          {{ busy ? busyLabel : createdJobId ? '重试上传' : '执行导入' }}
        </button>
      </template>
    </AdminAppPageHeader>

    <div
      v-if="localError"
      role="alert"
      class="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800"
    >
      <svg class="mt-0.5 size-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 8v4" /><path d="M12 16h.01" />
      </svg>
      <div class="min-w-0">
        <p class="font-semibold">导入包尚未就绪</p>
        <p class="break-words text-rose-700">{{ localError }}</p>
        <NuxtLink v-if="createdJobId" :to="`/admin/app/imports/${createdJobId}`" class="mt-1 inline-flex font-medium underline underline-offset-2">打开已创建任务</NuxtLink>
      </div>
    </div>

    <section
      class="group flex min-h-[210px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-5 py-8 text-center transition focus-within:ring-2 focus-within:ring-[#cf3f61]/30"
      :class="dragActive ? 'border-[#cf3f61] bg-[#fff4f6]' : 'border-[#d8d0cc] bg-white hover:border-[#cf3f61]/70 hover:bg-[#fffaf8]'"
      role="button"
      tabindex="0"
      aria-label="选择 ZIP 导入包"
      @click="openFilePicker"
      @keydown.enter.prevent="openFilePicker"
      @keydown.space.prevent="openFilePicker"
      @dragenter.prevent="dragActive = true"
      @dragover.prevent="dragActive = true"
      @dragleave.prevent="dragActive = false"
      @drop.prevent="onFileDropped"
    >
      <input ref="fileInput" type="file" accept=".zip,application/zip,application/x-zip-compressed" class="sr-only" @change="onFileSelected">
      <svg class="size-10 text-[#2c2421]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M9 17h6" /><path d="M9 13h6" />
      </svg>
      <h2 class="mt-3 text-base font-semibold text-[#2c2421]">
        {{ selectedFile ? selectedFile.name : '拖入 gallery-import.zip' }}
      </h2>
      <p class="mt-1 max-w-xl text-xs leading-5 text-[#8a7d76]">
        {{ selectedFile ? `${formatAdminImportBytes(selectedFile.size)} · 原包将流式写入私有 R2` : '包含 manifest.csv、content.md、cover.jpg 与至少一张图片' }}
      </p>
      <span class="mt-4 inline-flex min-h-9 items-center rounded-lg bg-[#cf3f61] px-4 text-xs font-semibold text-white">
        {{ selectedFile ? '更换导入包' : '选择导入包' }}
      </span>
    </section>

    <section v-show="Boolean(selectedFile) && hasTurnstile" class="rounded-xl border border-[#eaded8] bg-white px-4 py-3">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-sm font-medium text-[#2c2421]">执行前安全验证</p>
          <p class="mt-1 text-xs text-[#8a7d76]">验证通过后才会创建任务；原包不会经由浏览器解析。</p>
        </div>
        <div id="turnstile-admin-import-create" />
      </div>
      <p v-if="turnstileExpired" class="mt-2 text-xs text-amber-700">验证已过期，请重新完成验证。</p>
    </section>

    <section class="grid min-w-0 gap-3 md:grid-cols-3">
      <article class="rounded-xl border border-[#eaded8] bg-white p-4">
        <p class="text-xs text-[#8a7d76]">待校验</p>
        <strong class="mt-2 block text-2xl font-semibold text-[#2c2421]">{{ waitingCount }}</strong>
        <span class="mt-2 block text-xs text-emerald-600">等待或正在读取 manifest</span>
      </article>
      <article class="rounded-xl border border-[#eaded8] bg-white p-4">
        <p class="text-xs text-[#8a7d76]">可导入</p>
        <strong class="mt-2 block text-2xl font-semibold text-[#2c2421]">{{ importableCount }}</strong>
        <span class="mt-2 block text-xs text-emerald-600">已生成图库草稿或发布记录</span>
      </article>
      <article class="rounded-xl border border-[#eaded8] bg-white p-4">
        <p class="text-xs text-[#8a7d76]">失败</p>
        <strong class="mt-2 block text-2xl font-semibold text-[#2c2421]">{{ failureCount }}</strong>
        <span class="mt-2 block text-xs text-amber-700">单项失败不阻塞其他项目</span>
      </article>
    </section>

    <section class="overflow-hidden rounded-xl border border-[#eaded8] bg-white">
      <div class="flex items-center justify-between border-b border-[#eee5e1] px-4 py-3">
        <div>
          <h2 class="text-sm font-semibold text-[#2c2421]">最近导入任务</h2>
          <p class="mt-0.5 text-xs text-[#8a7d76]">点击任务查看逐项校验、失败原因和安全重试入口。</p>
        </div>
        <button type="button" class="text-xs font-medium text-[#b93252] hover:underline" :disabled="listStatus === 'pending'" @click="refresh()">刷新</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] text-left text-sm">
          <thead class="bg-[#fbf9f8] text-xs font-medium text-[#8a7d76]">
            <tr>
              <th class="px-4 py-3">任务 / 导入包</th>
              <th class="px-4 py-3">状态</th>
              <th class="px-4 py-3">进度</th>
              <th class="px-4 py-3">创建者</th>
              <th class="px-4 py-3">结果</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[#eee5e1]">
            <tr v-for="job in jobs" :key="job.id" class="transition hover:bg-[#fffaf8]">
              <td class="px-4 py-3">
                <NuxtLink :to="`/admin/app/imports/${job.id}`" class="font-medium text-[#2c2421] hover:text-[#b93252]">{{ job.source_name || '等待上传 ZIP' }}</NuxtLink>
                <p class="mt-1 font-mono text-[11px] text-[#9b8f89]">{{ job.id }} · {{ formatAdminImportBytes(job.package_size) }}</p>
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex rounded-full border px-2.5 py-1 text-xs font-medium" :class="adminImportStatusClass(job.status)">{{ adminImportStatusLabel(job.status) }}</span>
              </td>
              <td class="px-4 py-3 text-[#6a5f5a]">{{ job.success_count + job.failure_count }} / {{ job.total_count || '—' }}</td>
              <td class="max-w-[180px] truncate px-4 py-3 text-[#6a5f5a]">{{ job.creator_email }}</td>
              <td class="px-4 py-3">
                <span v-if="job.failure_count" class="font-medium text-rose-700">{{ job.failure_count }} 项失败</span>
                <span v-else-if="job.success_count" class="font-medium text-emerald-700">{{ job.success_count }} 项成功</span>
                <span v-else class="text-[#8a7d76]">等待校验</span>
              </td>
            </tr>
            <tr v-if="!jobs.length">
              <td colspan="5" class="px-4 py-10 text-center text-sm text-[#8a7d76]">{{ listStatus === 'pending' ? '正在加载导入任务…' : '还没有 ZIP 导入任务' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
