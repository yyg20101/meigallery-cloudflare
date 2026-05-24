<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const loading = ref(false)
const message = ref('')
const files = ref<FileList | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const form = reactive({
  title: '',
  slug: '',
  summary: '',
  bodyMd: '',
  featured: true,
  sortOrder: 0,
  seoTitle: '',
  seoDescription: '',
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

function createFormData() {
  const body = new FormData()
  body.set('title', form.title)
  body.set('slug', form.slug)
  body.set('summary', form.summary)
  body.set('bodyMd', form.bodyMd)
  body.set('featured', String(form.featured))
  body.set('sortOrder', String(form.sortOrder))
  body.set('seoTitle', form.seoTitle)
  body.set('seoDescription', form.seoDescription)
  for (const file of Array.from(files.value || [])) body.append('files', file)
  return body
}

async function onSubmit() {
  loading.value = true
  message.value = ''
  try {
    const result = await api<{ id: string }>('/api/admin/cases', {
      method: 'POST',
      body: files.value?.length ? createFormData() : form,
    })
    await navigateTo(`/admin/cases/${result.id}`)
  } catch (e: any) {
    message.value = e?.data?.message || '创建失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="max-w-3xl">
    <h1 class="mb-6 text-xl font-bold text-gray-900">新建真实案例</h1>
    <form class="space-y-5 rounded-lg border border-gray-200 bg-white p-6" @submit.prevent="onSubmit">
      <div class="grid gap-4 sm:grid-cols-2">
        <div><label class="mb-1 block text-sm font-medium text-gray-700">标题</label><input v-model="form.title" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
        <div><label class="mb-1 block text-sm font-medium text-gray-700">Slug</label><input v-model="form.slug" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="member-feedback-001" /></div>
      </div>
      <div><label class="mb-1 block text-sm font-medium text-gray-700">摘要</label><textarea v-model="form.summary" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
      <div><label class="mb-1 block text-sm font-medium text-gray-700">正文 Markdown</label><textarea v-model="form.bodyMd" rows="8" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono leading-6" /></div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div><label class="mb-1 block text-sm font-medium text-gray-700">排序</label><input v-model.number="form.sortOrder" type="number" min="0" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
        <label class="flex items-center gap-2 pt-7 text-sm text-gray-700"><input v-model="form.featured" type="checkbox" /> 首页精选</label>
      </div>
      <div><label class="mb-1 block text-sm font-medium text-gray-700">SEO 标题</label><input v-model="form.seoTitle" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
      <div><label class="mb-1 block text-sm font-medium text-gray-700">SEO 描述</label><textarea v-model="form.seoDescription" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
      <div class="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4">
        <label class="mb-1 block text-sm font-medium text-gray-700">案例图片</label>
        <input ref="imageInput" type="file" multiple accept="image/jpeg,image/png,image/webp" class="hidden" @change="onFilesChange" />
        <button type="button" class="mt-2 inline-flex items-center justify-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900" @click="openImagePicker">
          选择图片文件
        </button>
        <p class="mt-2 break-all text-xs text-gray-600">{{ selectedFileSummary }}</p>
        <p class="mt-2 text-xs text-gray-500">可在创建草稿时上传 1-9 张已授权、已脱敏图片；也可以创建后继续在编辑页补充。</p>
      </div>
      <p v-if="message" class="text-sm text-red-600">{{ message }}</p>
      <button :disabled="loading" class="rounded-lg bg-blue-600 px-5 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{{ loading ? '创建中...' : '创建草稿' }}</button>
    </form>
  </div>
</template>
