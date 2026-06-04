<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const loading = ref(false)
const uploadLoading = ref(false)
const message = ref('')
const files = ref<FileList | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)

interface AdminCaseDetail {
  id: string
  title: string
  slug: string
  summary: string | null
  bodyMd: string | null
  status: 'draft' | 'published'
  featured: boolean
  sortOrder: number
  seoTitle: string | null
  seoDescription: string | null
  images: Array<{ id: string; url: string; alt: string; sortOrder: number }>
}

const { data, refresh } = await useAsyncData(`admin-case-${route.params.id}`, () =>
  api<AdminCaseDetail>(`/api/admin/cases/${route.params.id}`),
)

const form = reactive({ title: '', slug: '', summary: '', bodyMd: '', status: 'draft' as 'draft' | 'published', featured: true, sortOrder: 0, seoTitle: '', seoDescription: '' })

watch(data, (value) => {
  if (!value) return
  form.title = value.title
  form.slug = value.slug
  form.summary = value.summary || ''
  form.bodyMd = value.bodyMd || ''
  form.status = value.status
  form.featured = value.featured
  form.sortOrder = value.sortOrder
  form.seoTitle = value.seoTitle || ''
  form.seoDescription = value.seoDescription || ''
}, { immediate: true })

const imageCountValid = computed(() => {
  const count = data.value?.images.length ?? 0
  return count >= 2 && count <= 9
})

const selectedFileSummary = computed(() => {
  const selected = Array.from(files.value || [])
  if (selected.length === 0) return '尚未选择图片'
  const names = selected.slice(0, 2).map(file => file.name).join('、')
  return selected.length === 1 ? `已选择：${names}` : `已选择 ${selected.length} 张：${names}${selected.length > 2 ? ' 等' : ''}`
})

function onFilesChange(event: Event) {
  files.value = (event.target as HTMLInputElement).files
}

function openImagePicker() {
  imageInput.value?.click()
}

async function onSave() {
  loading.value = true
  message.value = ''
  try {
    await api(`/api/admin/cases/${route.params.id}`, { method: 'PATCH', body: form })
    message.value = '已保存'
    await refresh()
  } catch (e: any) {
    message.value = resolveApiErrorMessage(e, '保存失败')
  } finally {
    loading.value = false
  }
}

async function onUpload() {
  if (!files.value?.length) return
  uploadLoading.value = true
  message.value = ''
  try {
    const body = new FormData()
    for (const file of Array.from(files.value)) body.append('files', file)
    await api(`/api/admin/cases/${route.params.id}/images`, { method: 'POST', body })
    files.value = null
    if (imageInput.value) imageInput.value.value = ''
    await refresh()
  } catch (e: any) {
    message.value = resolveApiErrorMessage(e, '上传失败')
  } finally {
    uploadLoading.value = false
  }
}

async function moveImage(index: number, direction: -1 | 1) {
  const images = [...(data.value?.images || [])]
  const nextIndex = index + direction
  if (nextIndex < 0 || nextIndex >= images.length) return
  const current = images[index]
  const next = images[nextIndex]
  if (!current || !next) return
  images[index] = next
  images[nextIndex] = current
  await api(`/api/admin/cases/${route.params.id}/images/order`, { method: 'PATCH', body: { imageIds: images.map(image => image.id) } })
  await refresh()
}

async function deleteImage(imageId: string) {
  if (!confirm('确认删除这张图片？')) return
  await api(`/api/admin/cases/${route.params.id}/images/${imageId}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
    <form class="space-y-5 rounded-lg border border-gray-200 bg-white p-6" @submit.prevent="onSave">
      <div class="flex items-center justify-between gap-4"><h1 class="text-xl font-bold text-gray-900">编辑真实案例</h1><NuxtLink to="/admin/cases" class="text-sm text-blue-600 hover:underline">返回列表</NuxtLink></div>
      <div class="grid gap-4 sm:grid-cols-2"><div><label class="mb-1 block text-sm font-medium text-gray-700">标题</label><input v-model="form.title" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div><div><label class="mb-1 block text-sm font-medium text-gray-700">Slug</label><input v-model="form.slug" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div></div>
      <div><label class="mb-1 block text-sm font-medium text-gray-700">摘要</label><textarea v-model="form.summary" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
      <div><label class="mb-1 block text-sm font-medium text-gray-700">正文 Markdown</label><textarea v-model="form.bodyMd" rows="8" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono leading-6" /></div>
      <div class="grid gap-4 sm:grid-cols-3"><div><label class="mb-1 block text-sm font-medium text-gray-700">状态</label><select v-model="form.status" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="draft">草稿</option><option value="published">已发布</option></select></div><div><label class="mb-1 block text-sm font-medium text-gray-700">排序</label><input v-model.number="form.sortOrder" type="number" min="0" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div><label class="flex items-center gap-2 pt-7 text-sm text-gray-700"><input v-model="form.featured" type="checkbox" /> 首页精选</label></div>
      <p v-if="!imageCountValid" class="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">发布需要 2-9 张已授权、已脱敏图片。</p>
      <div><label class="mb-1 block text-sm font-medium text-gray-700">SEO 标题</label><input v-model="form.seoTitle" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
      <div><label class="mb-1 block text-sm font-medium text-gray-700">SEO 描述</label><textarea v-model="form.seoDescription" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
      <p v-if="message" class="text-sm" :class="message.includes('失败') || message.includes('需要') ? 'text-red-600' : 'text-green-600'">{{ message }}</p>
      <button :disabled="loading" class="rounded-lg bg-blue-600 px-5 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{{ loading ? '保存中...' : '保存' }}</button>
    </form>

    <aside class="space-y-4">
      <div class="rounded-lg border border-gray-200 bg-white p-5">
        <h2 class="text-base font-semibold text-gray-900">图片管理</h2>
        <p class="mt-1 text-xs text-gray-500">仅上传已授权、已脱敏图片；每个案例 2-9 张。</p>
        <div class="mt-4 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3">
          <input ref="imageInput" type="file" multiple accept="image/jpeg,image/png,image/webp" class="hidden" @change="onFilesChange" />
          <button type="button" class="inline-flex items-center justify-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900" @click="openImagePicker">
            选择图片文件
          </button>
          <p class="mt-2 break-all text-xs text-gray-600">{{ selectedFileSummary }}</p>
        </div>
        <button :disabled="uploadLoading || !files?.length" class="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50" @click="onUpload">{{ uploadLoading ? '上传中...' : '上传图片' }}</button>
      </div>
      <div class="space-y-3">
        <div v-for="(image, index) in data?.images || []" :key="image.id" class="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <img :src="image.url" :alt="image.alt" class="aspect-[4/3] w-full object-cover" referrerpolicy="no-referrer" />
          <div class="flex items-center justify-between gap-2 p-3 text-xs"><span class="text-gray-500">排序 {{ index + 1 }}</span><div class="flex gap-2"><button class="text-gray-500 hover:text-gray-900" @click="moveImage(index, -1)">上移</button><button class="text-gray-500 hover:text-gray-900" @click="moveImage(index, 1)">下移</button><button class="text-red-600 hover:underline" @click="deleteImage(image.id)">删除</button></div></div>
        </div>
      </div>
    </aside>
  </div>
</template>
