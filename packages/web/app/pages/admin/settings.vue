<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()

const form = reactive({
  site_name: '',
  seo_title: '',
  membership_description: '',
  contact_wechat: '',
  contact_telegram: '',
  contact_email: '',
  contact_custom_note: '',
})
const loading = ref(false)
const message = ref('')

// 加载现有设置
const { data: settings } = await useAsyncData('admin-settings', () =>
  api<{ data: Record<string, { value: string; updatedAt: string }> }>('/api/admin/settings'),
)

if (settings.value?.data) {
  for (const [key, val] of Object.entries(settings.value.data)) {
    if (key in form) {
      (form as any)[key] = val.value || ''
    }
  }
}

async function onSave() {
  loading.value = true
  message.value = ''
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: { ...form } })
    message.value = '设置已保存'
  } catch (e: any) {
    message.value = e?.data?.message || '保存失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="max-w-2xl">
    <h1 class="text-xl font-bold text-gray-900 mb-6">站点设置</h1>

    <div v-if="!isOwner" class="rounded-lg bg-yellow-50 p-4 text-sm text-yellow-800 mb-6">
      仅站长可修改站点设置
    </div>

    <form v-else class="space-y-5" @submit.prevent="onSave">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">站点名称</label>
        <input v-model="form.site_name" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">SEO 标题</label>
        <input v-model="form.seo_title" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">会员说明</label>
        <textarea v-model="form.membership_description" rows="3" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>

      <hr class="border-gray-200" />
      <h2 class="text-base font-semibold text-gray-900">联系方式</h2>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">微信号</label>
        <input v-model="form.contact_wechat" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Telegram</label>
        <input v-model="form.contact_telegram" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
        <input v-model="form.contact_email" type="email" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">自定义说明</label>
        <textarea v-model="form.contact_custom_note" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>

      <div v-if="message" class="text-sm" :class="message.includes('失败') ? 'text-red-600' : 'text-green-600'">{{ message }}</div>

      <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
        {{ loading ? '保存中...' : '保存设置' }}
      </button>
    </form>
  </div>
</template>
