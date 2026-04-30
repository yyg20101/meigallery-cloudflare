<script setup lang="ts">
import type { MediaAsset } from '~/components/admin/MediaGrid.vue'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api, baseURL } = useApi()
const router = useRouter()
const { isOwner } = useAuth()

const galleryId = route.params.id as string

// ============================================================
// 图库基本信息
// ============================================================

interface GalleryDetail {
  id: string
  title: string
  slug: string
  summary: string | null
  bodyMd: string | null
  coverKey: string | null
  status: string
  requiredLevelRank: number
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  tags: Array<{ id: string; name: string; type?: string }>
}

const { data: gallery, refresh: refreshGallery } = await useAsyncData(
  `admin-gallery-${galleryId}`,
  () => api<{ data: GalleryDetail }>(`/api/admin/galleries/${galleryId}`),
)

if (!gallery.value?.data) {
  throw createError({ statusCode: 404, message: '图库不存在' })
}

const form = reactive({
  title: gallery.value.data.title,
  slug: gallery.value.data.slug,
  summary: gallery.value.data.summary || '',
  bodyMd: gallery.value.data.bodyMd || '',
  requiredLevelRank: gallery.value.data.requiredLevelRank,
  tagIds: gallery.value.data.tags.map((t) => t.id),
})

const error = ref('')
const loading = ref(false)
const saveSuccess = ref(false)

// 标签列表
const { data: tagsData } = await useAsyncData('admin-all-tags-edit', () =>
  api<{ data: Array<{ id: string; type: string; name: string; slug: string }> }>('/api/admin/tags'),
)

// 保存基本信息
async function onSubmit() {
  error.value = ''
  saveSuccess.value = false
  loading.value = true
  try {
    await api(`/api/admin/galleries/${galleryId}`, {
      method: 'PATCH',
      body: {
        title: form.title,
        slug: form.slug,
        summary: form.summary || undefined,
        bodyMd: form.bodyMd || undefined,
        requiredLevelRank: form.requiredLevelRank,
        tagIds: form.tagIds,
      },
    })
    saveSuccess.value = true
    setTimeout(() => { saveSuccess.value = false }, 3000)
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '保存失败'
  } finally {
    loading.value = false
  }
}

// ============================================================
// 发布 / 下架
// ============================================================

const publishLoading = ref(false)

async function togglePublish() {
  publishLoading.value = true
  try {
    const action = gallery.value?.data.status === 'published' ? 'unpublish' : 'publish'
    await api(`/api/admin/galleries/${galleryId}/${action}`, { method: 'POST' })
    await refreshGallery()
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '操作失败'
  } finally {
    publishLoading.value = false
  }
}

// ============================================================
// 媒体管理
// ============================================================

const mediaAssets = ref<MediaAsset[]>([])
const mediaLoading = ref(true)

// 获取媒体列表
async function loadMedia() {
  mediaLoading.value = true
  try {
    const result = await api<{ data: MediaAsset[] }>(
      `/api/admin/galleries/${galleryId}/media`,
    )
    mediaAssets.value = result.data ?? []
  } catch {
    // 静默失败
  } finally {
    mediaLoading.value = false
  }
}

// 初始加载
onMounted(() => {
  loadMedia()
})

// 上传完成后刷新媒体列表
function onMediaUploaded() {
  loadMedia()
}

// 封面相关
const coverKey = computed(() => gallery.value?.data.coverKey ?? null)

function getCoverPreviewUrl(): string | null {
  const key = coverKey.value
  if (!key) return null
  if (key.startsWith('http')) return key
  return `${baseURL}/api/media/cover/${galleryId}`
}

const coverSettingLoading = ref(false)

async function onSetCover(assetId: string) {
  coverSettingLoading.value = true
  try {
    await api(`/api/admin/galleries/${galleryId}/cover`, {
      method: 'PATCH',
      body: { assetId },
    })
    await refreshGallery()
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '设置封面失败'
  } finally {
    coverSettingLoading.value = false
  }
}

// 删除媒体
async function onDeleteMedia(assetId: string) {
  try {
    await api(`/api/admin/media/${assetId}`, { method: 'DELETE' })
    // 如果删除的是封面，刷新图库信息
    const asset = mediaAssets.value.find((a) => a.id === assetId)
    if (asset && asset.r2Key === coverKey.value) {
      await refreshGallery()
    }
    await loadMedia()
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '删除失败'
  }
}

// 修改 VIP 等级
async function onUpdateRank(assetId: string, rank: number) {
  try {
    await api(`/api/admin/media/${assetId}`, {
      method: 'PATCH',
      body: { requiredRank: rank },
    })
    // 局部更新，不刷新整个列表
    const idx = mediaAssets.value.findIndex((a) => a.id === assetId)
    if (idx >= 0) {
      mediaAssets.value[idx] = { ...mediaAssets.value[idx]!, requiredRank: rank }
    }
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '修改等级失败'
  }
}

// 计算统计
const imageCount = computed(() => mediaAssets.value.filter((a) => a.type === 'image').length)
const videoCount = computed(() => mediaAssets.value.filter((a) => a.type === 'video').length)
</script>

<template>
  <div class="max-w-5xl">
    <!-- 页头 -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-xl font-bold text-gray-900">编辑图库</h1>
        <p class="text-xs text-gray-400 mt-1">ID: {{ galleryId }}</p>
      </div>
      <div class="flex items-center gap-3">
        <!-- 发布/下架按钮 -->
        <button
          :disabled="publishLoading"
          class="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          :class="gallery?.data.status === 'published'
            ? 'bg-orange-100 text-orange-700 hover:bg-orange-200'
            : 'bg-green-100 text-green-700 hover:bg-green-200'"
          @click="togglePublish"
        >
          {{ publishLoading ? '处理中...' : (gallery?.data.status === 'published' ? '下架' : '发布') }}
        </button>
        <span
          class="rounded-full px-2.5 py-0.5 text-xs font-medium"
          :class="{
            'bg-green-100 text-green-800': gallery?.data.status === 'published',
            'bg-yellow-100 text-yellow-800': gallery?.data.status === 'draft',
            'bg-gray-100 text-gray-600': gallery?.data.status === 'archived',
          }"
        >
          {{ gallery?.data.status === 'published' ? '已发布' : gallery?.data.status === 'draft' ? '草稿' : '已归档' }}
        </span>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- ============================================================ -->
      <!-- 左栏：基本信息表单 -->
      <!-- ============================================================ -->
      <div class="lg:col-span-2">
        <form class="space-y-5 rounded-lg border border-gray-200 bg-white p-5" @submit.prevent="onSubmit">
          <h2 class="text-sm font-semibold text-gray-700 border-b pb-2">基本信息</h2>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">标题</label>
            <input v-model="form.title" type="text" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Slug</label>
            <input v-model="form.slug" type="text" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">摘要</label>
            <textarea v-model="form.summary" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">正文 (Markdown)</label>
            <textarea v-model="form.bodyMd" rows="6" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
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
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">标签</label>
            <div class="flex flex-wrap gap-2 max-h-36 overflow-y-auto p-2 border rounded-lg">
              <label v-for="tag in tagsData?.data" :key="tag.id" class="inline-flex items-center gap-1 text-xs">
                <input type="checkbox" :value="tag.id" v-model="form.tagIds" class="rounded" />
                {{ tag.name }}
              </label>
            </div>
          </div>

          <div v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ error }}</div>
          <div v-if="saveSuccess" class="rounded-lg bg-green-50 p-3 text-sm text-green-700">保存成功</div>

          <div class="flex gap-3">
            <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
              {{ loading ? '保存中...' : '保存' }}
            </button>
            <NuxtLink to="/admin/galleries" class="rounded-lg border px-6 py-2 text-sm text-gray-600 hover:bg-gray-50">返回列表</NuxtLink>
          </div>
        </form>
      </div>

      <!-- ============================================================ -->
      <!-- 右栏：封面预览 + 统计 -->
      <!-- ============================================================ -->
      <div class="space-y-4">
        <!-- 封面预览 -->
        <div class="rounded-lg border border-gray-200 bg-white p-4">
          <h2 class="text-sm font-semibold text-gray-700 mb-3">封面</h2>
          <div v-if="getCoverPreviewUrl()" class="rounded-lg overflow-hidden bg-gray-100 mb-2">
            <img
              :src="getCoverPreviewUrl()!"
              alt="封面预览"
              class="w-full aspect-[4/3] object-cover"
            />
          </div>
          <div v-else class="rounded-lg bg-gray-100 aspect-[4/3] flex items-center justify-center mb-2">
            <span class="text-sm text-gray-400">暂无封面</span>
          </div>
          <p class="text-xs text-gray-400">可在下方图片网格中选择"设为封面"</p>
        </div>

        <!-- 统计卡片 -->
        <div class="rounded-lg border border-gray-200 bg-white p-4">
          <h2 class="text-sm font-semibold text-gray-700 mb-3">资源统计</h2>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-500">图片</span>
              <span class="font-medium">{{ imageCount }} 张</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">视频</span>
              <span class="font-medium">{{ videoCount }} 个</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">创建时间</span>
              <span class="text-gray-600">{{ gallery?.data.createdAt?.split('T')[0] }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">更新时间</span>
              <span class="text-gray-600">{{ gallery?.data.updatedAt?.split('T')[0] }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- 媒体管理区域（全宽） -->
    <!-- ============================================================ -->
    <div class="mt-6 space-y-4">
      <!-- 图片上传 -->
      <div class="rounded-lg border border-gray-200 bg-white p-5">
        <h2 class="text-sm font-semibold text-gray-700 mb-3">上传图片</h2>
        <AdminMediaUploader :gallery-id="galleryId" @uploaded="onMediaUploaded" />
      </div>

      <!-- 图片网格 -->
      <div class="rounded-lg border border-gray-200 bg-white p-5">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-semibold text-gray-700">
            图片管理
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
          :gallery-id="galleryId"
          :loading="mediaLoading"
          @set-cover="onSetCover"
          @delete="onDeleteMedia"
          @update-rank="onUpdateRank"
        />
      </div>
    </div>
  </div>
</template>
