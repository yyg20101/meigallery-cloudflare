<script setup lang="ts">
import { resolveAdminMediaDisplayUrl } from '~/utils/mediaUrlSecurity'

/**
 * 媒体网格管理组件
 * 显示图库关联的所有图片/视频，支持拖拽排序、设为封面、VIP 等级修改、删除
 */

export interface MediaAsset {
  id: string
  galleryId: string
  type: string
  storage: string
  r2Key: string | null
  streamUid: string | null
  requiredRank: number
  role: string
  sortOrder: number
  uploadStatus: string
  createdAt: string
  thumbnailUrl: string | null
}

const props = defineProps<{
  assets: MediaAsset[]
  coverKey: string | null
  galleryId: string
  loading?: boolean
}>()

const emit = defineEmits<{
  setCover: [assetId: string]
  delete: [assetId: string]
  updateRank: [assetId: string, rank: number]
  reorder: [order: Array<{ assetId: string; sortOrder: number }>]
}>()

const showDeleteConfirm = ref(false)
const deleteTargetId = ref<string | null>(null)

const levelOptions = [
  { label: '免费', value: 0 },
  { label: 'VIP', value: 10 },
  { label: 'SVIP', value: 20 },
]

// ============================================================
// 拖拽排序
// ============================================================

const dragSourceId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)
const isDragging = ref(false)

function onDragStart(event: DragEvent, asset: MediaAsset) {
  if (!event.dataTransfer) return
  dragSourceId.value = asset.id
  isDragging.value = true
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', asset.id)
  // 让拖拽元素半透明
  const el = event.target as HTMLElement
  requestAnimationFrame(() => {
    el.style.opacity = '0.4'
  })
}

function onDragEnd(event: DragEvent) {
  const el = event.target as HTMLElement
  el.style.opacity = ''
  dragSourceId.value = null
  dragOverId.value = null
  isDragging.value = false
}

function onDragOver(event: DragEvent, asset: MediaAsset) {
  event.preventDefault()
  if (!event.dataTransfer) return
  event.dataTransfer.dropEffect = 'move'
  dragOverId.value = asset.id
}

function onDragLeave(_event: DragEvent, asset: MediaAsset) {
  if (dragOverId.value === asset.id) {
    dragOverId.value = null
  }
}

function onDrop(event: DragEvent, targetAsset: MediaAsset) {
  event.preventDefault()
  dragOverId.value = null

  const sourceId = dragSourceId.value
  if (!sourceId || sourceId === targetAsset.id) return

  // 计算新排序
  const items = [...props.assets]
  const sourceIdx = items.findIndex(a => a.id === sourceId)
  const targetIdx = items.findIndex(a => a.id === targetAsset.id)
  if (sourceIdx < 0 || targetIdx < 0) return

  // 从原位置移除，插入到目标位置
  const [moved] = items.splice(sourceIdx, 1)
  items.splice(targetIdx, 0, moved!)

  // 生成新的排序数据
  const order = items.map((item, idx) => ({
    assetId: item.id,
    sortOrder: idx,
  }))

  emit('reorder', order)
}

function isCover(asset: MediaAsset): boolean {
  return !!(props.coverKey && asset.r2Key && props.coverKey === asset.r2Key)
}

function getImageUrl(asset: MediaAsset): string {
  return resolveAdminMediaDisplayUrl(asset.thumbnailUrl)
}

function confirmDelete(assetId: string) {
  deleteTargetId.value = assetId
  showDeleteConfirm.value = true
}

function executeDelete() {
  if (deleteTargetId.value) {
    emit('delete', deleteTargetId.value)
  }
  showDeleteConfirm.value = false
  deleteTargetId.value = null
}

function onRankChange(assetId: string, event: Event) {
  const target = event.target as HTMLSelectElement
  emit('updateRank', assetId, parseInt(target.value, 10))
}
</script>

<template>
  <div>
    <!-- 空状态 -->
    <div v-if="assets.length === 0 && !loading" class="rounded-lg border-2 border-dashed border-gray-200 p-8 text-center">
      <p class="text-sm text-gray-400">暂无媒体资源，请通过上方区域上传图片</p>
    </div>

    <!-- 加载状态 -->
    <div v-else-if="loading" class="flex justify-center py-8">
      <span class="text-sm text-gray-400">加载中...</span>
    </div>

    <!-- 排序提示 -->
    <div v-if="assets.length > 1 && !loading" class="mb-2 text-xs text-gray-400">
      拖拽图片可调整排序
    </div>

    <!-- 网格 -->
    <div v-else-if="!loading && assets.length === 0" />
    <div v-if="assets.length > 0 && !loading" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      <div
        v-for="asset in assets"
        :key="asset.id"
        draggable="true"
        class="group relative rounded-lg border bg-white overflow-hidden transition-all duration-150 cursor-grab active:cursor-grabbing"
        :class="[
          isCover(asset) ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200',
          dragOverId === asset.id && dragSourceId !== asset.id ? 'ring-2 ring-indigo-400 scale-105' : '',
          dragSourceId === asset.id ? 'opacity-40' : '',
        ]"
        @dragstart="onDragStart($event, asset)"
        @dragend="onDragEnd"
        @dragover="onDragOver($event, asset)"
        @dragleave="onDragLeave($event, asset)"
        @drop="onDrop($event, asset)"
      >
        <!-- 缩略图 -->
        <div class="aspect-[4/3] bg-gray-100 relative">
          <img
            v-if="getImageUrl(asset)"
            :src="getImageUrl(asset)"
            :alt="`图片 ${asset.sortOrder + 1}`"
            class="w-full h-full object-cover"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <div v-else class="flex items-center justify-center h-full text-gray-300">
            <svg class="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>

          <!-- 封面标记 -->
          <span
            v-if="isCover(asset)"
            class="absolute top-1 left-1 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
          >
            封面
          </span>

          <!-- 悬停操作 -->
          <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
            <button
              v-if="!isCover(asset)"
              class="rounded bg-white/90 px-2 py-1 text-[10px] font-medium text-gray-700 hover:bg-white"
              @click="emit('setCover', asset.id)"
            >
              设为封面
            </button>
            <button
              class="rounded bg-red-500/90 px-2 py-1 text-[10px] font-medium text-white hover:bg-red-600"
              @click="confirmDelete(asset.id)"
            >
              删除
            </button>
          </div>
        </div>

        <!-- 底部信息栏 -->
        <div class="px-2 py-1.5 flex items-center justify-between">
          <span class="text-[10px] text-gray-400">#{{ asset.sortOrder + 1 }}</span>
          <select
            :value="asset.requiredRank"
            class="text-[10px] border-0 bg-transparent p-0 pr-4 text-gray-500 focus:ring-0 cursor-pointer"
            @change="onRankChange(asset.id, $event)"
          >
            <option v-for="opt in levelOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <Teleport to="body">
      <div
        v-if="showDeleteConfirm"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showDeleteConfirm = false"
      >
        <div class="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
          <h3 class="text-lg font-bold text-red-700 mb-2">删除媒体</h3>
          <p class="text-sm text-gray-600 mb-4">
            确定要删除这个媒体资源吗？文件将从存储中永久移除，此操作不可恢复。
          </p>
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              @click="showDeleteConfirm = false"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
              @click="executeDelete"
            >
              确认删除
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
