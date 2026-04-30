<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()

const form = reactive({
  site_name: '',
  seo_title: '',
  membership_description: '',
})
const emailVerificationEnabled = ref(false)
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
    if (key === 'email_verification_enabled') {
      emailVerificationEnabled.value = val.value === true || val.value === 'true'
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

const toggleLoading = ref(false)
async function toggleEmailVerification() {
  toggleLoading.value = true
  try {
    const newVal = !emailVerificationEnabled.value
    await api('/api/admin/settings', {
      method: 'PATCH',
      body: { email_verification_enabled: newVal },
    })
    emailVerificationEnabled.value = newVal
  } catch (e: any) {
    alert(e?.data?.message || '操作失败')
  } finally {
    toggleLoading.value = false
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

      <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
        联系方式已迁移到独立管理页面。
        <NuxtLink to="/admin/contact-methods" class="text-blue-600 hover:underline font-medium ml-1">前往管理联系方式 →</NuxtLink>
      </div>

      <!-- 邮箱验证开关 -->
      <div class="rounded-lg border border-gray-200 p-4">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-medium text-gray-700">邮箱验证</p>
            <p class="text-xs text-gray-500 mt-0.5">开启后注册和修改邮箱需要验证码（需 Workers Paid 计划）</p>
          </div>
          <button
            :disabled="toggleLoading"
            class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50"
            :class="emailVerificationEnabled ? 'bg-blue-600' : 'bg-gray-300'"
            @click="toggleEmailVerification"
          >
            <span
              class="inline-block h-4 w-4 rounded-full bg-white transition-transform"
              :class="emailVerificationEnabled ? 'translate-x-6' : 'translate-x-1'"
            />
          </button>
        </div>
      </div>

      <div v-if="message" class="text-sm" :class="message.includes('失败') ? 'text-red-600' : 'text-green-600'">{{ message }}</div>

      <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
        {{ loading ? '保存中...' : '保存设置' }}
      </button>
    </form>
  </div>
</template>
