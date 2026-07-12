<script setup lang="ts">
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

/**
 * 图片拖拽上传组件
 * 支持拖拽/点击选择，逐张上传（最多 3 并发），实时显示进度
 */

const props = defineProps<{
  galleryId: string
}>()

const emit = defineEmits<{
  uploaded: [assets: Array<{ assetId: string; r2Key: string; thumbnailUrl: string; sortOrder: number }>]
}>()

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']
const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_CONCURRENT = 3

interface UploadItem {
  id: string
  file: File
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
  result?: { assetId: string; r2Key: string; thumbnailUrl: string; sortOrder: number }
}

const queue = ref<UploadItem[]>([])
const isDragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function validateFile(file: File): string | null {
  const ext = '.' + (file.name.split('.').pop()?.toLowerCase() || '')
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `不支持的格式: ${ext}`
  }
  if (file.size > MAX_SIZE) {
    return `文件过大: ${(file.size / 1024 / 1024).toFixed(1)}MB，最大 10MB`
  }
  return null
}

function addFiles(files: FileList | File[]) {
  const newItems: UploadItem[] = []
  for (const file of files) {
    const error = validateFile(file)
    newItems.push({
      id: crypto.randomUUID(),
      file,
      status: error ? 'error' : 'pending',
      error: error || undefined,
    })
  }
  queue.value = [...queue.value, ...newItems]
  processQueue()
}

function onDrop(e: DragEvent) {
  isDragging.value = false
  if (e.dataTransfer?.files) {
    addFiles(e.dataTransfer.files)
  }
}

function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) {
    addFiles(input.files)
    input.value = '' // 重置以允许再次选择相同文件
  }
}

// 并发上传控制
let activeUploads = 0

async function processQueue() {
  while (activeUploads < MAX_CONCURRENT) {
    const next = queue.value.find(item => item.status === 'pending')
    if (!next) break
    activeUploads++
    next.status = 'uploading'
    // 触发响应式更新
    queue.value = [...queue.value]

    try {
      const formData = new FormData()
      formData.append('files', next.file)

      const response = await fetch(
        `/api/admin/galleries/${props.galleryId}/media/upload`,
        {
          method: 'POST',
          body: formData,
          credentials: 'include',
        },
      )

      if (!response.ok) {
        const err = await response.json().catch(() => ({ message: '上传失败' }))
        throw new Error(resolveApiErrorMessage({ data: err }, `HTTP ${response.status}`))
      }

      const result = await response.json() as {
        uploaded: Array<{ assetId: string; r2Key: string; thumbnailUrl: string; sortOrder: number }>
        failed: Array<{ filename: string; error: string }>
      }

      if (result.failed.length > 0) {
        next.status = 'error'
        next.error = result.failed[0]!.error
      } else if (result.uploaded.length > 0) {
        next.status = 'done'
        next.result = result.uploaded[0]!
        emit('uploaded', result.uploaded)
      }
    } catch (e: unknown) {
      next.status = 'error'
      next.error = e instanceof Error ? e.message : '上传失败'
    } finally {
      activeUploads--
      queue.value = [...queue.value]
      processQueue()
    }
  }
}

function removeItem(id: string) {
  queue.value = queue.value.filter(item => item.id !== id)
}

function clearCompleted() {
  queue.value = queue.value.filter(item => item.status !== 'done')
}

const pendingCount = computed(() => queue.value.filter(i => i.status === 'pending').length)
const uploadingCount = computed(() => queue.value.filter(i => i.status === 'uploading').length)
const doneCount = computed(() => queue.value.filter(i => i.status === 'done').length)
const hasItems = computed(() => queue.value.length > 0)
</script>

<template>
  <div>
    <!-- 拖拽区域 -->
    <div
      class="relative rounded-lg border-2 border-dashed p-6 text-center transition-colors cursor-pointer"
      :class="isDragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'"
      @dragover.prevent="isDragging = true"
      @dragleave="isDragging = false"
      @drop.prevent="onDrop"
      @click="fileInput?.click()"
    >
      <input
        ref="fileInput"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        class="hidden"
        @change="onFileSelect"
      />
      <div class="text-gray-500">
        <svg class="mx-auto h-8 w-8 text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <p class="text-sm font-medium">拖拽图片到此处，或点击选择</p>
        <p class="text-xs text-gray-400 mt-1">支持 JPG/PNG/WebP，单张最大 10MB</p>
      </div>
    </div>

    <!-- 上传队列 -->
    <div v-if="hasItems" class="mt-3">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-gray-500">
          <template v-if="uploadingCount > 0">上传中 {{ uploadingCount }}，</template>
          <template v-if="pendingCount > 0">等待 {{ pendingCount }}，</template>
          <template v-if="doneCount > 0">完成 {{ doneCount }}</template>
        </span>
        <button
          v-if="doneCount > 0"
          class="text-xs text-gray-400 hover:text-gray-600"
          @click="clearCompleted"
        >
          清除已完成
        </button>
      </div>

      <div class="space-y-1.5 max-h-48 overflow-y-auto">
        <div
          v-for="item in queue"
          :key="item.id"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"
          :class="{
            'bg-gray-50': item.status === 'pending',
            'bg-blue-50': item.status === 'uploading',
            'bg-green-50': item.status === 'done',
            'bg-red-50': item.status === 'error',
          }"
        >
          <!-- 状态图标 -->
          <span class="flex-shrink-0">
            <span v-if="item.status === 'pending'" class="text-gray-400">&#9675;</span>
            <span v-else-if="item.status === 'uploading'" class="text-blue-500 animate-spin inline-block">&#9696;</span>
            <span v-else-if="item.status === 'done'" class="text-green-600">&#10003;</span>
            <span v-else class="text-red-600">&#10007;</span>
          </span>

          <!-- 文件名 -->
          <span class="truncate flex-1" :class="item.status === 'error' ? 'text-red-700' : 'text-gray-700'">
            {{ item.file.name }}
            <span class="text-gray-400 ml-1">({{ (item.file.size / 1024 / 1024).toFixed(1) }}MB)</span>
          </span>

          <!-- 错误信息 -->
          <span v-if="item.error" class="text-red-500 truncate max-w-[200px]">{{ item.error }}</span>

          <!-- 移除按钮 -->
          <button
            v-if="item.status === 'error' || item.status === 'done'"
            class="flex-shrink-0 text-gray-400 hover:text-gray-600"
            @click="removeItem(item.id)"
          >
            &times;
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
