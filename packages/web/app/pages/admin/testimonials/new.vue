<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const loading = ref(false)
const message = ref('')
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

async function onSubmit() {
  loading.value = true
  message.value = ''
  try {
    const result = await api<{ id: string }>('/api/admin/testimonial-cases', { method: 'POST', body: form })
    await navigateTo(`/admin/testimonials/${result.id}`)
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
      <p v-if="message" class="text-sm text-red-600">{{ message }}</p>
      <button :disabled="loading" class="rounded-lg bg-blue-600 px-5 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{{ loading ? '创建中...' : '创建草稿' }}</button>
    </form>
  </div>
</template>
