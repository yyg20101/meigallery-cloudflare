<script setup lang="ts">
import type { MediaAsset } from '~/components/admin/MediaGrid.vue'
import { resolveCoverPreviewUrl } from '~/utils/mediaUrlSecurity'

definePageMeta({ layout: 'admin' })

const { api, baseURL } = useApi()
const router = useRouter()
const { isOwner } = useAuth()

// ============================================================
// 第一步：基本信息
// ============================================================

const form = reactive({
  title: '',
  slug: '',
  summary: '',
  bodyMd: '',
  requiredLevelRank: 0,
  tagIds: [] as string[],
  status: 'draft',
})
const error = ref('')
const loading = ref(false)
const slugManuallyEdited = ref(false)

// 创建完成后的图库 ID
const createdGalleryId = ref<string | null>(null)
const createdGallery = ref<{
  id: string
  title: string
  slug: string
  status: string
  coverKey: string | null
} | null>(null)

// 获取标签供选择
const { data: tagsData } = await useAsyncData('admin-all-tags', () =>
  api<{ data: Array<{ id: string; type: string; name: string; slug: string; gallery_count: number }> }>('/api/admin/tags'),
)

// 按标签类型分组
const tagTypeLabels: Record<string, string> = {
  region_scope: '地区范围',
  region_group: '地区组',
  city_country: '城市/国家',
  identity: '身份',
  personality: '性格',
  style: '风格',
  occupation: '职业',
  hair: '发型',
  clothing: '服饰',
  scene: '场景',
  content_type: '内容类型',
}
const tagsByType = computed(() => {
  const groups: Record<string, Array<{ id: string; name: string; type: string }>> = {}
  for (const tag of tagsData.value?.data ?? []) {
    if (!groups[tag.type]) groups[tag.type] = []
    groups[tag.type]!.push(tag)
  }
  return groups
})

// 自动生成 slug（仅在用户未手动编辑 slug 时）
watch(() => form.title, (val) => {
  if (!slugManuallyEdited.value) {
    form.slug = slugify(val)
  }
})

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 100)
}

async function onSubmit() {
  error.value = ''
  if (!form.title || !form.slug) {
    error.value = '标题和 slug 为必填'
    return
  }
  loading.value = true
  try {
    const result = await api<{ id: string }>('/api/admin/galleries', {
      method: 'POST',
      body: {
        title: form.title,
        slug: form.slug,
        summary: form.summary || undefined,
        bodyMd: form.bodyMd || undefined,
        requiredLevelRank: form.requiredLevelRank,
        tagIds: form.tagIds.length > 0 ? form.tagIds : undefined,
        status: isOwner.value ? form.status : 'draft',
      },
    })
    createdGalleryId.value = result.id
    createdGallery.value = {
      id: result.id,
      title: form.title,
      slug: form.slug,
      status: form.status,
      coverKey: null,
    }
  } catch (e: any) {
    error.value = e?.data?.message || '创建失败'
  } finally {
    loading.value = false
  }
}

// ============================================================
// 第二步：媒体上传（创建成功后展示）
// ============================================================

const mediaAssets = ref<MediaAsset[]>([])
const mediaLoading = ref(false)

async function loadMedia() {
  if (!createdGalleryId.value) return
  mediaLoading.value = true
  try {
    const result = await api<{ data: MediaAsset[] }>(
      `/api/admin/galleries/${createdGalleryId.value}/media`,
    )
    mediaAssets.value = result.data ?? []
  } catch {
    // 静默
  } finally {
    mediaLoading.value = false
  }
}

function onMediaUploaded() {
  loadMedia()
}

// 封面
const coverKey = ref<string | null>(null)
const coverSettingLoading = ref(false)

function getCoverPreviewUrl(): string | null {
  return resolveCoverPreviewUrl(coverKey.value, createdGalleryId.value, baseURL)
}

async function onSetCover(assetId: string) {
  if (!createdGalleryId.value) return
  coverSettingLoading.value = true
  try {
    await api(`/api/admin/galleries/${createdGalleryId.value}/cover`, {
      method: 'PATCH',
      body: { assetId },
    })
    // 刷新封面信息
    const detail = await api<{ data: { coverKey: string | null } }>(
      `/api/admin/galleries/${createdGalleryId.value}`,
    )
    coverKey.value = detail.data?.coverKey ?? null
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '设置封面失败'
  } finally {
    coverSettingLoading.value = false
  }
}

async function onDeleteMedia(assetId: string) {
  if (!createdGalleryId.value) return
  try {
    await api(`/api/admin/media/${assetId}`, { method: 'DELETE' })
    const asset = mediaAssets.value.find(a => a.id === assetId)
    if (asset && asset.r2Key === coverKey.value) {
      coverKey.value = null
    }
    await loadMedia()
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '删除失败'
  }
}

async function onUpdateRank(assetId: string, rank: number) {
  try {
    await api(`/api/admin/media/${assetId}`, {
      method: 'PATCH',
      body: { requiredRank: rank },
    })
    const idx = mediaAssets.value.findIndex(a => a.id === assetId)
    if (idx >= 0) {
      mediaAssets.value[idx] = { ...mediaAssets.value[idx]!, requiredRank: rank }
    }
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '修改等级失败'
  }
}

async function onReorder(order: Array<{ assetId: string; sortOrder: number }>) {
  if (!createdGalleryId.value) return
  const orderMap = new Map(order.map(o => [o.assetId, o.sortOrder]))
  mediaAssets.value = [...mediaAssets.value].sort((a, b) => {
    const orderA = orderMap.get(a.id) ?? a.sortOrder
    const orderB = orderMap.get(b.id) ?? b.sortOrder
    return orderA - orderB
  })
  mediaAssets.value.forEach((asset, idx) => {
    asset.sortOrder = idx
  })
  try {
    await api(`/api/admin/galleries/${createdGalleryId.value}/media/reorder`, {
      method: 'POST',
      body: { order },
    })
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '排序保存失败'
    await loadMedia()
  }
}

const imageCount = computed(() => mediaAssets.value.filter(a => a.type === 'image').length)

function goToEdit() {
  if (createdGalleryId.value) {
    router.push(`/admin/galleries/${createdGalleryId.value}`)
  }
}
</script>

<template>
  <div class="max-w-5xl">
    <!-- ============================================================ -->
    <!-- 步骤指示器 -->
    <!-- ============================================================ -->
    <div class="flex items-center gap-3 mb-6">
      <div
        class="flex items-center gap-2"
        :class="createdGalleryId ? 'text-green-600' : 'text-blue-600'"
      >
        <span
          class="flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold text-white"
          :class="createdGalleryId ? 'bg-green-500' : 'bg-blue-600'"
        >
          {{ createdGalleryId ? '&#10003;' : '1' }}
        </span>
        <span class="text-sm font-medium">基本信息</span>
      </div>
      <div class="w-8 h-px bg-gray-300" />
      <div
        class="flex items-center gap-2"
        :class="createdGalleryId ? 'text-blue-600' : 'text-gray-400'"
      >
        <span
          class="flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold"
          :class="createdGalleryId ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'"
        >
          2
        </span>
        <span class="text-sm font-medium">上传资源</span>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- 第一步：基本信息表单 -->
    <!-- ============================================================ -->
    <div v-if="!createdGalleryId">
      <h1 class="text-xl font-bold text-gray-900 mb-6">创建图库</h1>

      <form class="space-y-5 rounded-lg border border-gray-200 bg-white p-5" @submit.prevent="onSubmit">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">标题 *</label>
          <input v-model="form.title" type="text" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="输入图库标题" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Slug *</label>
          <input v-model="form.slug" type="text" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="url-friendly-slug" @input="slugManuallyEdited = true" />
          <p class="text-xs text-gray-400 mt-1">用于 URL 路径，自动根据标题生成</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">摘要</label>
          <textarea v-model="form.summary" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="简短描述（可选）" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">正文 (Markdown)</label>
          <textarea v-model="form.bodyMd" rows="8" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="图库正文内容（可选）" />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">所需会员等级</label>
            <select v-model.number="form.requiredLevelRank" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option :value="0">免费 (0)</option>
              <option :value="10">VIP (10)</option>
              <option :value="20">SVIP (20)</option>
            </select>
          </div>
          <div v-if="isOwner">
            <label class="block text-sm font-medium text-gray-700 mb-1">状态</label>
            <select v-model="form.status" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="draft">草稿</option>
              <option value="published">直接发布</option>
            </select>
          </div>
        </div>

        <!-- 标签选择（按类型分组） -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">标签</label>
          <div class="space-y-3 max-h-64 overflow-y-auto p-3 border rounded-lg bg-gray-50">
            <div v-for="(tags, type) in tagsByType" :key="type">
              <p class="text-xs font-medium text-gray-500 mb-1">{{ tagTypeLabels[type] || type }}</p>
              <div class="flex flex-wrap gap-1.5">
                <label
                  v-for="tag in tags"
                  :key="tag.id"
                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs cursor-pointer transition-colors"
                  :class="form.tagIds.includes(tag.id) ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:border-gray-400'"
                >
                  <input type="checkbox" :value="tag.id" v-model="form.tagIds" class="hidden" />
                  {{ tag.name }}
                </label>
              </div>
            </div>
          </div>
        </div>

        <div v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ error }}</div>

        <div class="flex gap-3">
          <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
            {{ loading ? '创建中...' : '创建并继续上传资源' }}
          </button>
          <NuxtLink to="/admin/galleries" class="rounded-lg border px-6 py-2 text-sm text-gray-600 hover:bg-gray-50">取消</NuxtLink>
        </div>
      </form>
    </div>

    <!-- ============================================================ -->
    <!-- 第二步：上传媒体资源（创建成功后） -->
    <!-- ============================================================ -->
    <div v-else>
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-xl font-bold text-gray-900">上传资源</h1>
          <p class="text-sm text-gray-500 mt-1">
            图库「{{ createdGallery?.title }}」已创建成功，现在可以上传图片
          </p>
        </div>
        <div class="flex items-center gap-3">
          <button
            class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
            @click="goToEdit"
          >
            前往完整编辑
          </button>
          <NuxtLink
            to="/admin/galleries"
            class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            完成，返回列表
          </NuxtLink>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- 左栏：上传 + 网格 -->
        <div class="lg:col-span-2 space-y-4">
          <!-- 上传区域 -->
          <div class="rounded-lg border border-gray-200 bg-white p-5">
            <h2 class="text-sm font-semibold text-gray-700 mb-3">上传图片</h2>
            <AdminMediaUploader :gallery-id="createdGalleryId" @uploaded="onMediaUploaded" />
          </div>

          <!-- 图片网格 -->
          <div class="rounded-lg border border-gray-200 bg-white p-5">
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-sm font-semibold text-gray-700">
                已上传图片
                <span class="text-gray-400 font-normal ml-1">({{ imageCount }})</span>
              </h2>
              <button
                class="text-xs text-gray-400 hover:text-gray-600"
                @click="loadMedia"
              >
                刷新
              </button>
            </div>
            <AdminMediaGrid
              :assets="mediaAssets.filter(a => a.type === 'image')"
              :cover-key="coverKey"
              :gallery-id="createdGalleryId"
              :loading="mediaLoading"
              @set-cover="onSetCover"
              @delete="onDeleteMedia"
              @update-rank="onUpdateRank"
              @reorder="onReorder"
            />
          </div>
        </div>

        <!-- 右栏：封面预览 + 操作提示 -->
        <div class="space-y-4">
          <div class="rounded-lg border border-gray-200 bg-white p-4">
            <h2 class="text-sm font-semibold text-gray-700 mb-3">封面</h2>
            <div v-if="getCoverPreviewUrl()" class="rounded-lg overflow-hidden bg-gray-100 mb-2">
              <img :src="getCoverPreviewUrl()!" alt="封面预览" class="w-full aspect-[4/3] object-cover" />
            </div>
            <div v-else class="rounded-lg bg-gray-100 aspect-[4/3] flex items-center justify-center mb-2">
              <span class="text-sm text-gray-400">暂无封面</span>
            </div>
            <p class="text-xs text-gray-400">上传图片后，在网格中选择「设为封面」</p>
          </div>

          <div class="rounded-lg border border-blue-200 bg-blue-50 p-4">
            <h3 class="text-sm font-medium text-blue-800 mb-2">操作提示</h3>
            <ul class="text-xs text-blue-700 space-y-1.5">
              <li>1. 拖拽或点击上传区域添加图片</li>
              <li>2. 在图片上悬停可设为封面或删除</li>
              <li>3. 拖拽图片可调整显示顺序</li>
              <li>4. 下拉菜单可设置单张图片的会员等级</li>
              <li>5. 完成后点击右上角返回列表或前往完整编辑</li>
            </ul>
          </div>

          <div class="rounded-lg border border-gray-200 bg-white p-4">
            <h2 class="text-sm font-semibold text-gray-700 mb-3">图库信息</h2>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-gray-500">标题</span>
                <span class="font-medium text-gray-700 truncate ml-2">{{ createdGallery?.title }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-500">Slug</span>
                <span class="font-mono text-xs text-gray-600 truncate ml-2">{{ createdGallery?.slug }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-500">状态</span>
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="createdGallery?.status === 'published' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'"
                >
                  {{ createdGallery?.status === 'published' ? '已发布' : '草稿' }}
                </span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-500">图片数</span>
                <span class="font-medium">{{ imageCount }} 张</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
