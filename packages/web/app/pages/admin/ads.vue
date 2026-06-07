<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const toast = useToast()

interface AdminHomeAd {
  id: string
  placement: string
  eyebrow: string
  title: string
  summary: string
  ctaLabel: string
  targetUrl: string
  sponsor: string
  imageUrl: string
  imageKey: string | null
  enabled: boolean
  startsAt: string
  endsAt: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

const { data: adsResult, refresh } = await useAsyncData('admin-home-ads', () =>
  api<{ data: AdminHomeAd[] }>('/api/admin/ads'),
)

const ads = computed(() => adsResult.value?.data ?? [])
const activeAds = computed(() => ads.value.filter(ad => ad.enabled))
const selectedId = ref('')
const saving = ref(false)
const imageUploadingId = ref('')
const deleteTarget = ref<AdminHomeAd | null>(null)
const deleteModalOpen = ref(false)
const imageInputs = reactive<Record<string, HTMLInputElement | null>>({})

const form = reactive({
  eyebrow: '本周推荐',
  title: '',
  summary: '',
  ctaLabel: '查看详情',
  targetUrl: '/discover?sort=hot',
  sponsor: '',
  imageUrl: '',
  enabled: true,
  startsAt: '',
  endsAt: '',
})

const selectedAd = computed(() => ads.value.find(ad => ad.id === selectedId.value) ?? null)
const selectedImageUrl = computed(() => selectedAd.value?.imageUrl ?? '')
const selectedImageAlt = computed(() => selectedAd.value?.title || '广告大图')
const previewAds = computed(() => {
  const draft = {
    id: selectedId.value || 'draft-ad',
    eyebrow: form.eyebrow,
    title: form.title || '广告标题示例',
    summary: form.summary || '填写摘要后，首页广告位会以更强的大图横幅方式展示。',
    ctaLabel: form.ctaLabel || '查看详情',
    url: form.targetUrl || '/discover?sort=hot',
    sponsor: form.sponsor,
    imageUrl: form.imageUrl,
  }
  return [draft]
})

watch(ads, (items) => {
  if (selectedId.value && items.some(item => item.id === selectedId.value)) return
  if (items[0]) selectAd(items[0])
}, { immediate: true })

function resetForm() {
  selectedId.value = ''
  form.eyebrow = '本周推荐'
  form.title = ''
  form.summary = ''
  form.ctaLabel = '查看详情'
  form.targetUrl = '/discover?sort=hot'
  form.sponsor = ''
  form.imageUrl = ''
  form.enabled = true
  form.startsAt = ''
  form.endsAt = ''
}

function selectAd(ad: AdminHomeAd) {
  selectedId.value = ad.id
  form.eyebrow = ad.eyebrow
  form.title = ad.title
  form.summary = ad.summary
  form.ctaLabel = ad.ctaLabel
  form.targetUrl = ad.targetUrl
  form.sponsor = ad.sponsor
  form.imageUrl = ad.imageUrl
  form.enabled = ad.enabled
  form.startsAt = toDatetimeLocalValue(ad.startsAt)
  form.endsAt = toDatetimeLocalValue(ad.endsAt)
}

async function saveAd() {
  saving.value = true
  try {
    const body = {
      eyebrow: form.eyebrow,
      title: form.title,
      summary: form.summary,
      ctaLabel: form.ctaLabel,
      targetUrl: form.targetUrl,
      sponsor: form.sponsor,
      imageUrl: form.imageUrl,
      enabled: form.enabled,
      startsAt: normalizeDatetimeInput(form.startsAt),
      endsAt: normalizeDatetimeInput(form.endsAt),
    }
    if (selectedId.value) {
      await api(`/api/admin/ads/${selectedId.value}`, { method: 'PUT', body })
      toast.add({ title: '广告位已更新', color: 'success' })
    } else {
      const result = await api<{ id: string }>('/api/admin/ads', { method: 'POST', body })
      selectedId.value = result.id
      toast.add({ title: '广告位已创建', color: 'success' })
    }
    await refresh()
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '广告位保存失败'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function toggleAd(ad: AdminHomeAd) {
  try {
    await api(`/api/admin/ads/${ad.id}`, { method: 'PUT', body: { enabled: !ad.enabled } })
    await refresh()
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '状态更新失败'), color: 'error' })
  }
}

async function moveAd(index: number, direction: -1 | 1) {
  const list = [...ads.value]
  const target = index + direction
  if (target < 0 || target >= list.length) return
  const current = list[index]
  const next = list[target]
  if (!current || !next) return
  list[index] = next
  list[target] = current
  try {
    await api('/api/admin/ads/reorder', { method: 'PATCH', body: { ids: list.map(item => item.id) } })
    await refresh()
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '排序更新失败'), color: 'error' })
  }
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  try {
    await api(`/api/admin/ads/${deleteTarget.value.id}`, { method: 'DELETE' })
    if (selectedId.value === deleteTarget.value.id) resetForm()
    deleteTarget.value = null
    await refresh()
    toast.add({ title: '广告位已删除', color: 'success' })
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '删除失败'), color: 'error' })
  }
}

function triggerImageUpload(id: string) {
  imageInputs[id]?.click()
}

function triggerSelectedImageUpload() {
  if (!selectedId.value) return
  triggerImageUpload(selectedId.value)
}

function setImageInput(id: string, el: Element | ComponentPublicInstance | null) {
  imageInputs[id] = el as HTMLInputElement | null
}

function uploadSelectedImage(event: Event) {
  if (!selectedAd.value) return
  return uploadImage(event, selectedAd.value)
}

function deleteSelectedImage() {
  if (!selectedAd.value) return
  return deleteImage(selectedAd.value)
}

async function uploadImage(event: Event, ad: AdminHomeAd) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const body = new FormData()
  body.set('file', file)
  imageUploadingId.value = ad.id
  try {
    const result = await api<{ imageUrl: string }>(`/api/admin/ads/${ad.id}/image`, { method: 'POST', body })
    if (selectedId.value === ad.id) form.imageUrl = result.imageUrl
    await refresh()
    toast.add({ title: '广告大图已上传', color: 'success' })
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '大图上传失败'), color: 'error' })
  } finally {
    imageUploadingId.value = ''
    input.value = ''
  }
}

async function deleteImage(ad: AdminHomeAd) {
  try {
    await api(`/api/admin/ads/${ad.id}/image`, { method: 'DELETE' })
    if (selectedId.value === ad.id) form.imageUrl = ''
    await refresh()
    toast.add({ title: '广告大图已删除', color: 'success' })
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '大图删除失败'), color: 'error' })
  }
}

function normalizeDatetimeInput(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString()
}

function toDatetimeLocalValue(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return localDate.toISOString().slice(0, 16)
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-bold text-gray-900">广告位管理</h1>
        <p class="mt-1 text-sm text-gray-500">配置首页大图广告轮播，支持多个广告位、排序、排期和安全跳转。</p>
      </div>
      <button
        class="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        @click="resetForm"
      >
        新增广告位
      </button>
    </div>

    <div v-if="!isOwner" class="rounded-lg bg-yellow-50 p-4 text-sm text-yellow-800">
      仅站长可管理广告位。
    </div>

    <div v-else class="grid gap-6 xl:grid-cols-[minmax(21rem,0.86fr)_minmax(0,1.14fr)]">
      <section class="space-y-4">
        <div class="grid grid-cols-3 gap-3">
          <div class="rounded-xl border border-gray-200 bg-white p-4">
            <p class="text-xs text-gray-500">广告总数</p>
            <p class="mt-1 text-2xl font-semibold text-gray-950">{{ ads.length }}</p>
          </div>
          <div class="rounded-xl border border-gray-200 bg-white p-4">
            <p class="text-xs text-gray-500">启用中</p>
            <p class="mt-1 text-2xl font-semibold text-green-600">{{ activeAds.length }}</p>
          </div>
          <div class="rounded-xl border border-gray-200 bg-white p-4">
            <p class="text-xs text-gray-500">轮播位</p>
            <p class="mt-1 text-2xl font-semibold text-gray-950">首页</p>
          </div>
        </div>

        <div class="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div class="border-b border-gray-100 px-4 py-3">
            <h2 class="text-sm font-semibold text-gray-900">广告排序</h2>
          </div>
          <div class="divide-y divide-gray-100">
            <article
              v-for="(ad, index) in ads"
              :key="ad.id"
              class="cursor-pointer p-4 transition-colors hover:bg-gray-50"
              :class="selectedId === ad.id ? 'bg-gray-50' : 'bg-white'"
              @click="selectAd(ad)"
            >
              <div class="flex gap-3">
                <div class="h-20 w-24 shrink-0 overflow-hidden rounded-lg bg-gray-100">
                  <img v-if="ad.imageUrl" :src="ad.imageUrl" :alt="ad.title" class="h-full w-full object-cover" referrerpolicy="no-referrer" />
                  <div v-else class="flex h-full items-center justify-center text-xs text-gray-400">未上传</div>
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-semibold text-gray-950">{{ ad.title }}</p>
                      <p class="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{{ ad.summary || '未填写摘要' }}</p>
                    </div>
                    <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="ad.enabled ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'">
                      {{ ad.enabled ? '启用' : '停用' }}
                    </span>
                  </div>
                  <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <button class="rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-white disabled:opacity-30" :disabled="index === 0" @click.stop="moveAd(index, -1)">上移</button>
                    <button class="rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-white disabled:opacity-30" :disabled="index === ads.length - 1" @click.stop="moveAd(index, 1)">下移</button>
                    <button class="rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-white" @click.stop="toggleAd(ad)">{{ ad.enabled ? '停用' : '启用' }}</button>
                    <button class="rounded border border-red-100 px-2 py-1 text-red-600 hover:bg-red-50" @click.stop="deleteTarget = ad; deleteModalOpen = true">删除</button>
                  </div>
                </div>
              </div>
            </article>
            <div v-if="ads.length === 0" class="px-4 py-12 text-center text-sm text-gray-400">
              暂无广告位，点击右上角新增。
            </div>
          </div>
        </div>
      </section>

      <section class="space-y-4">
        <form class="rounded-xl border border-gray-200 bg-white p-5" @submit.prevent="saveAd">
          <div class="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 class="text-base font-semibold text-gray-950">{{ selectedAd ? '编辑广告位' : '新增广告位' }}</h2>
              <p class="mt-1 text-xs text-gray-500">标题、跳转链接为必填；图片可上传到 R2，也可填写安全 https 图片地址。</p>
            </div>
            <label class="flex items-center gap-2 text-sm text-gray-700">
              <input v-model="form.enabled" type="checkbox" class="rounded" />
              启用
            </label>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">广告眉标</label>
              <input v-model="form.eyebrow" maxlength="16" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="本周推荐" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">赞助/来源说明</label>
              <input v-model="form.sponsor" maxlength="40" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="MeiGallery 运营推荐" />
            </div>
          </div>

          <div class="mt-4">
            <label class="mb-1 block text-sm font-medium text-gray-700">广告标题 <span class="text-red-500">*</span></label>
            <input v-model="form.title" required maxlength="64" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="会员季精选内容" />
          </div>

          <div class="mt-4">
            <label class="mb-1 block text-sm font-medium text-gray-700">广告摘要</label>
            <textarea v-model="form.summary" rows="3" maxlength="180" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="探索本周精选图库、真实案例和会员可访问内容。" />
          </div>

          <div class="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_10rem]">
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">跳转链接 <span class="text-red-500">*</span></label>
              <input v-model="form.targetUrl" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="/discover?sort=hot" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">按钮文案</label>
              <input v-model="form.ctaLabel" maxlength="16" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="查看详情" />
            </div>
          </div>

          <div class="mt-4">
            <label class="mb-1 block text-sm font-medium text-gray-700">大图 URL</label>
            <input v-model="form.imageUrl" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="/api/media/public/home-ads/... 或 https://example.com/ad.webp" />
            <p class="mt-1 text-xs text-gray-400">上传大图会自动填充该地址；外链仅允许安全 https 公开图片地址。</p>
          </div>

          <div class="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">开始时间</label>
              <input v-model="form.startsAt" type="datetime-local" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">结束时间</label>
              <input v-model="form.endsAt" type="datetime-local" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>

          <div class="mt-5 flex flex-wrap gap-3">
            <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60" :disabled="saving">
              {{ saving ? '保存中...' : (selectedAd ? '保存修改' : '创建广告位') }}
            </button>
            <button type="button" class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" @click="resetForm">
              清空表单
            </button>
          </div>
        </form>

        <div v-if="selectedAd" class="rounded-xl border border-gray-200 bg-white p-5">
          <div class="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 class="text-base font-semibold text-gray-950">大图上传</h2>
              <p class="mt-1 text-xs text-gray-500">支持 PNG、JPEG、WebP，单张不超过 3MB。</p>
            </div>
            <div class="flex gap-2">
              <button type="button" class="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50" :disabled="imageUploadingId === selectedId" @click="triggerSelectedImageUpload">
                {{ imageUploadingId === selectedId ? '上传中...' : '上传大图' }}
              </button>
              <button v-if="selectedAd.imageKey" type="button" class="rounded-lg border border-red-100 px-3 py-2 text-xs text-red-600 hover:bg-red-50" @click="deleteSelectedImage">
                删除大图
              </button>
            </div>
          </div>
          <input :ref="(el) => selectedId && setImageInput(selectedId, el)" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="uploadSelectedImage" />
          <div class="aspect-[16/7] overflow-hidden rounded-xl bg-gray-100">
            <img v-if="selectedImageUrl" :src="selectedImageUrl" :alt="selectedImageAlt" class="h-full w-full object-cover" referrerpolicy="no-referrer" />
            <div v-else class="flex h-full items-center justify-center text-sm text-gray-400">当前广告位还没有大图</div>
          </div>
        </div>

        <div class="rounded-xl border border-gray-200 bg-white p-5">
          <div class="mb-4">
            <h2 class="text-base font-semibold text-gray-950">首页预览</h2>
            <p class="mt-1 text-xs text-gray-500">预览复用首页广告组件；按钮不可跳转。</p>
          </div>
          <HomeAdBand :enabled="true" :ads="previewAds" preview />
        </div>
      </section>
    </div>

    <UModal v-model:open="deleteModalOpen">
      <template #content>
        <div class="p-6">
          <h3 class="text-base font-semibold text-gray-900">确认删除广告位</h3>
          <p class="mt-2 text-sm text-gray-600">删除后会同时删除该广告位上传到 R2 的大图，此操作不可恢复。</p>
          <div class="mt-6 flex justify-end gap-3">
            <button class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" @click="deleteModalOpen = false; deleteTarget = null">取消</button>
            <button class="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700" @click="confirmDelete">确认删除</button>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
