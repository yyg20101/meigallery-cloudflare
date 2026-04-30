<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const route = useRoute()

// ============================================================
// 列表数据 & 筛选
// ============================================================

const page = ref(parseInt((route.query.page as string) || '1', 10))
const status = ref((route.query.status as string) || '')
const search = ref('')
const searchInput = ref('')

interface AdminGallery {
  id: string; title: string; slug: string; status: string
  required_level_rank: number; published_at: string | null; created_at: string; updated_at: string
}

interface GalleryListResponse {
  data: AdminGallery[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

const { data, refresh } = await useAsyncData('admin-galleries', () =>
  api<GalleryListResponse>('/api/admin/galleries', {
    query: {
      page: String(page.value),
      pageSize: '20',
      status: status.value || undefined,
      search: search.value || undefined,
    },
  }),
  { watch: [page, status, search] },
)

const galleries = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.pagination?.total ?? 0)
const totalPages = computed(() => data.value?.pagination?.totalPages ?? 0)

const statusOptions = [
  { label: '全部', value: '' },
  { label: '草稿', value: 'draft' },
  { label: '已发布', value: 'published' },
  { label: '已归档', value: 'archived' },
]

const statusColors: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-800',
  published: 'bg-green-100 text-green-800',
  archived: 'bg-gray-100 text-gray-600',
}

const statusLabels: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
}

const levelLabels: Record<number, string> = {
  0: '免费',
  10: 'VIP',
  20: 'SVIP',
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    search.value = searchInput.value
    page.value = 1
  }, 300)
}

// ============================================================
// 选择逻辑
// ============================================================

const selectedIds = ref<Set<string>>(new Set())
const selectAllMatching = ref(false) // 全选所有匹配项（不仅当前页）

const pageIds = computed(() => galleries.value.map((g) => g.id))
const isAllPageSelected = computed(() =>
  pageIds.value.length > 0 && pageIds.value.every((id) => selectedIds.value.has(id)),
)

function toggleSelectAll() {
  if (isAllPageSelected.value) {
    // 取消本页全选
    pageIds.value.forEach((id) => selectedIds.value.delete(id))
    selectAllMatching.value = false
  } else {
    // 全选本页
    pageIds.value.forEach((id) => selectedIds.value.add(id))
  }
}

function toggleSelectItem(id: string) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id)
    selectAllMatching.value = false
  } else {
    selectedIds.value.add(id)
  }
}

function selectAllMatchingGalleries() {
  selectAllMatching.value = true
  // 同时选中当前页
  pageIds.value.forEach((id) => selectedIds.value.add(id))
}

function clearSelection() {
  selectedIds.value.clear()
  selectAllMatching.value = false
}

const selectedCount = computed(() =>
  selectAllMatching.value ? total.value : selectedIds.value.size,
)

// 页面切换 / 筛选变化时清空选择
watch([page, status, search], () => {
  clearSelection()
})

// ============================================================
// 批量操作
// ============================================================

type BatchAction = 'publish' | 'unpublish' | 'delete' | 'set_level' | 'add_tags' | 'remove_tags'

interface BatchResult {
  affected: number
  success: number
  failed: number
  errors: Array<{ galleryId: string; error: string }>
}

const batchLoading = ref(false)

// 确认弹窗
const showConfirmModal = ref(false)
const confirmAction = ref<BatchAction | null>(null)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmDanger = ref(false)

// 操作参数
const batchLevelRank = ref(0)
const batchTagIds = ref<string[]>([])
const batchTagMode = ref<'add' | 'remove'>('add')

// 标签数据
const tags = ref<Array<{ id: string; type: string; name: string; slug: string; gallery_count: number }>>([])
const tagSearchQuery = ref('')
const showTagPicker = ref(false)

async function loadTags() {
  try {
    const result = await api<{ data: typeof tags.value }>('/api/admin/tags')
    tags.value = result.data ?? []
  } catch { /* ignore */ }
}

const filteredTags = computed(() => {
  if (!tagSearchQuery.value) return tags.value
  const q = tagSearchQuery.value.toLowerCase()
  return tags.value.filter((t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q))
})

// 结果反馈
const toast = ref<{ show: boolean; message: string; type: 'success' | 'error' }>({
  show: false, message: '', type: 'success',
})

function showToast(message: string, type: 'success' | 'error' = 'success') {
  toast.value = { show: true, message, type }
  setTimeout(() => { toast.value.show = false }, 4000)
}

// 发起批量操作确认
function requestBatch(action: BatchAction) {
  confirmAction.value = action
  confirmDanger.value = action === 'delete'

  const count = selectedCount.value
  switch (action) {
    case 'publish':
      confirmTitle.value = '批量发布'
      confirmMessage.value = `确定要发布选中的 ${count} 个图库吗？`
      showConfirmModal.value = true
      break
    case 'unpublish':
      confirmTitle.value = '批量下架'
      confirmMessage.value = `确定要下架选中的 ${count} 个图库吗？`
      showConfirmModal.value = true
      break
    case 'delete':
      confirmTitle.value = '批量删除'
      confirmMessage.value = `确定要永久删除选中的 ${count} 个图库吗？此操作不可恢复，图库关联的图片也将从 R2 中删除。`
      showConfirmModal.value = true
      break
    case 'set_level':
      confirmTitle.value = '设置会员等级'
      confirmMessage.value = `将选中的 ${count} 个图库的访问等级设置为：`
      showConfirmModal.value = true
      break
    case 'add_tags':
      batchTagMode.value = 'add'
      batchTagIds.value = []
      tagSearchQuery.value = ''
      showTagPicker.value = true
      loadTags()
      break
    case 'remove_tags':
      batchTagMode.value = 'remove'
      batchTagIds.value = []
      tagSearchQuery.value = ''
      showTagPicker.value = true
      loadTags()
      break
  }
}

function confirmTagBatch() {
  if (batchTagIds.value.length === 0) return
  const action: BatchAction = batchTagMode.value === 'add' ? 'add_tags' : 'remove_tags'
  confirmAction.value = action
  confirmDanger.value = false
  const count = selectedCount.value
  const tagNames = batchTagIds.value
    .map((id) => tags.value.find((t) => t.id === id)?.name)
    .filter(Boolean)
    .join('、')
  confirmTitle.value = batchTagMode.value === 'add' ? '批量添加标签' : '批量移除标签'
  confirmMessage.value = `将${batchTagMode.value === 'add' ? '添加' : '移除'}标签「${tagNames}」到选中的 ${count} 个图库。`
  showTagPicker.value = false
  showConfirmModal.value = true
}

// 执行批量操作
async function executeBatch() {
  if (!confirmAction.value) return
  batchLoading.value = true
  showConfirmModal.value = false

  try {
    const payload: Record<string, unknown> = { action: confirmAction.value }

    if (selectAllMatching.value) {
      payload.selectAll = true
      payload.filter = {
        status: status.value || undefined,
        search: search.value || undefined,
      }
    } else {
      payload.galleryIds = Array.from(selectedIds.value)
    }

    if (confirmAction.value === 'set_level') {
      payload.params = { requiredLevelRank: batchLevelRank.value }
    }

    if (confirmAction.value === 'add_tags' || confirmAction.value === 'remove_tags') {
      payload.params = { tagIds: batchTagIds.value }
    }

    const result = await api<BatchResult>('/api/admin/galleries/batch', {
      method: 'POST',
      body: payload,
    })

    if (result.failed > 0) {
      showToast(`操作完成：成功 ${result.success}，失败 ${result.failed}`, 'error')
    } else {
      showToast(`批量操作成功：${result.success} 个图库已更新`, 'success')
    }

    clearSelection()
    refresh()
  } catch (e: any) {
    showToast(e?.data ? JSON.parse(e.data)?.error ?? '操作失败' : '操作失败', 'error')
  } finally {
    batchLoading.value = false
    confirmAction.value = null
  }
}

// 单个操作快捷方式
async function publishGallery(id: string) {
  await api(`/api/admin/galleries/${id}/publish`, { method: 'POST' })
  refresh()
}

async function unpublishGallery(id: string) {
  await api(`/api/admin/galleries/${id}/unpublish`, { method: 'POST' })
  refresh()
}
</script>

<template>
  <div>
    <!-- 页头 -->
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-bold text-gray-900">图库管理</h1>
      <NuxtLink to="/admin/galleries/new" class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
        创建图库
      </NuxtLink>
    </div>

    <!-- 筛选栏 -->
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <select v-model="status" class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm" @change="page = 1">
        <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <input
        v-model="searchInput"
        type="text"
        placeholder="搜索标题..."
        class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm w-48"
        @input="onSearchInput"
      />
      <span class="text-sm text-gray-500 ml-auto">共 {{ total }} 个图库</span>
    </div>

    <!-- 批量操作工具栏 -->
    <Transition name="slide">
      <div
        v-if="selectedCount > 0"
        class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3"
      >
        <span class="text-sm font-medium text-blue-800">
          已选 {{ selectedCount }} 项
          <template v-if="selectAllMatching">（全部匹配）</template>
        </span>

        <!-- 全选所有匹配项提示 -->
        <button
          v-if="isAllPageSelected && !selectAllMatching && total > galleries.length"
          class="text-sm text-blue-600 underline ml-1"
          @click="selectAllMatchingGalleries"
        >
          选择全部 {{ total }} 个匹配结果
        </button>

        <div class="flex-1" />

        <button
          class="rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
          :disabled="batchLoading"
          @click="requestBatch('publish')"
        >发布</button>

        <button
          class="rounded bg-orange-500 px-3 py-1 text-xs text-white hover:bg-orange-600 disabled:opacity-50"
          :disabled="batchLoading"
          @click="requestBatch('unpublish')"
        >下架</button>

        <button
          class="rounded bg-purple-600 px-3 py-1 text-xs text-white hover:bg-purple-700 disabled:opacity-50"
          :disabled="batchLoading"
          @click="requestBatch('set_level')"
        >设置等级</button>

        <button
          class="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="batchLoading"
          @click="requestBatch('add_tags')"
        >添加标签</button>

        <button
          class="rounded bg-gray-600 px-3 py-1 text-xs text-white hover:bg-gray-700 disabled:opacity-50"
          :disabled="batchLoading"
          @click="requestBatch('remove_tags')"
        >移除标签</button>

        <button
          class="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
          :disabled="batchLoading"
          @click="requestBatch('delete')"
        >删除</button>

        <button class="text-xs text-gray-500 underline ml-2" @click="clearSelection">取消选择</button>
      </div>
    </Transition>

    <!-- 表格 -->
    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr>
            <th class="w-10 px-3 py-3">
              <input
                type="checkbox"
                :checked="isAllPageSelected"
                :indeterminate="selectedIds.size > 0 && !isAllPageSelected"
                class="rounded border-gray-300"
                @change="toggleSelectAll"
              />
            </th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">标题</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">状态</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">等级</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">更新时间</th>
            <th class="px-4 py-3 text-right font-medium text-gray-600">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="g in galleries" :key="g.id" class="hover:bg-gray-50" :class="{ 'bg-blue-50/50': selectedIds.has(g.id) }">
            <td class="px-3 py-3">
              <input
                type="checkbox"
                :checked="selectedIds.has(g.id)"
                class="rounded border-gray-300"
                @change="toggleSelectItem(g.id)"
              />
            </td>
            <td class="px-4 py-3">
              <NuxtLink :to="`/admin/galleries/${g.id}`" class="text-blue-600 hover:underline line-clamp-1">{{ g.title }}</NuxtLink>
            </td>
            <td class="px-4 py-3">
              <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusColors[g.status] || '']">
                {{ statusLabels[g.status] || g.status }}
              </span>
            </td>
            <td class="px-4 py-3">
              <span class="text-xs">{{ levelLabels[g.required_level_rank] ?? `Lv.${g.required_level_rank}` }}</span>
            </td>
            <td class="px-4 py-3 text-gray-500">{{ g.updated_at?.split('T')[0] }}</td>
            <td class="px-4 py-3 text-right space-x-2">
              <NuxtLink :to="`/admin/galleries/${g.id}`" class="text-xs text-blue-600 hover:underline">编辑</NuxtLink>
              <button v-if="g.status === 'draft'" class="text-xs text-green-600 hover:underline" @click="publishGallery(g.id)">发布</button>
              <button v-if="g.status === 'published'" class="text-xs text-orange-600 hover:underline" @click="unpublishGallery(g.id)">下架</button>
            </td>
          </tr>
          <tr v-if="galleries.length === 0">
            <td colspan="6" class="px-4 py-8 text-center text-gray-400">暂无图库</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div v-if="totalPages > 1" class="mt-4 flex justify-center gap-2">
      <button :disabled="page <= 1" class="rounded px-3 py-1 text-sm border disabled:opacity-50" @click="page--">上一页</button>
      <span class="px-3 py-1 text-sm text-gray-600">{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" class="rounded px-3 py-1 text-sm border disabled:opacity-50" @click="page++">下一页</button>
    </div>

    <!-- ============================================================ -->
    <!-- 确认弹窗 -->
    <!-- ============================================================ -->
    <Teleport to="body">
      <div v-if="showConfirmModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="showConfirmModal = false">
        <div class="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
          <h3 class="text-lg font-bold mb-3" :class="confirmDanger ? 'text-red-700' : 'text-gray-900'">
            {{ confirmTitle }}
          </h3>
          <p class="text-sm text-gray-600 mb-4">{{ confirmMessage }}</p>

          <!-- set_level 参数选择 -->
          <div v-if="confirmAction === 'set_level'" class="mb-4">
            <select v-model.number="batchLevelRank" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option :value="0">免费（rank=0）</option>
              <option :value="10">VIP（rank=10）</option>
              <option :value="20">SVIP（rank=20）</option>
            </select>
          </div>

          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              @click="showConfirmModal = false"
            >取消</button>
            <button
              :class="confirmDanger
                ? 'rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700'
                : 'rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700'"
              :disabled="batchLoading"
              @click="executeBatch"
            >
              <span v-if="batchLoading">处理中...</span>
              <span v-else>确认</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============================================================ -->
    <!-- 标签选择弹窗 -->
    <!-- ============================================================ -->
    <Teleport to="body">
      <div v-if="showTagPicker" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="showTagPicker = false">
        <div class="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
          <h3 class="text-lg font-bold mb-3">
            {{ batchTagMode === 'add' ? '批量添加标签' : '批量移除标签' }}
          </h3>
          <input
            v-model="tagSearchQuery"
            type="text"
            placeholder="搜索标签..."
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3"
          />
          <div class="max-h-60 overflow-y-auto border rounded-lg p-2 space-y-1">
            <label
              v-for="t in filteredTags"
              :key="t.id"
              class="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50 cursor-pointer text-sm"
            >
              <input
                type="checkbox"
                :value="t.id"
                v-model="batchTagIds"
                class="rounded border-gray-300"
              />
              <span>{{ t.name }}</span>
              <span class="text-xs text-gray-400 ml-auto">{{ t.type }} · {{ t.gallery_count }}</span>
            </label>
            <p v-if="filteredTags.length === 0" class="text-center text-gray-400 py-4 text-sm">无匹配标签</p>
          </div>
          <div class="flex justify-between items-center mt-4">
            <span class="text-xs text-gray-500">已选 {{ batchTagIds.length }} 个标签</span>
            <div class="flex gap-3">
              <button
                class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                @click="showTagPicker = false"
              >取消</button>
              <button
                class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                :disabled="batchTagIds.length === 0"
                @click="confirmTagBatch"
              >下一步</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============================================================ -->
    <!-- Toast 反馈 -->
    <!-- ============================================================ -->
    <Teleport to="body">
      <Transition name="toast">
        <div
          v-if="toast.show"
          class="fixed top-6 right-6 z-[60] max-w-sm rounded-lg px-4 py-3 text-sm font-medium shadow-lg"
          :class="toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'"
        >
          {{ toast.message }}
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.slide-enter-active,
.slide-leave-active {
  transition: all 0.2s ease;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(40px);
}
</style>
