<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()

const form = reactive({
  // 基础信息
  site_name: '',
  site_description: '',
  site_icon: '',
  footer_text: '',
  // SEO / OG
  seo_title: '',
  og_title: '',
  og_description: '',
  og_image: '',
  // 其他
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
    useToast().add({ title: e?.data?.message || '操作失败', color: 'error' })
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

    <form v-else class="space-y-8" @submit.prevent="onSave">
      <!-- 基础信息 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">基础信息</legend>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">站点名称</label>
          <input v-model="form.site_name" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="MeiGallery" />
          <p class="text-xs text-gray-400 mt-1">显示在导航栏、页脚和浏览器标签页</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">站点描述</label>
          <textarea v-model="form.site_description" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="精选写真、时尚、生活、艺术类图库平台" />
          <p class="text-xs text-gray-400 mt-1">用于 meta description 和默认 OG 描述</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">站点图标 URL</label>
          <input v-model="form.site_icon" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="https://example.com/icon.png" />
          <p class="text-xs text-gray-400 mt-1">favicon 和 apple-touch-icon 地址（留空使用默认）</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">页脚文案</label>
          <input v-model="form.footer_text" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="© 2026 MeiGallery. All rights reserved." />
          <p class="text-xs text-gray-400 mt-1">页面底部的版权或自定义文字</p>
        </div>
      </fieldset>

      <!-- SEO / OG 社交分享 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">SEO / 社交分享</legend>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">SEO 标题</label>
          <input v-model="form.seo_title" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="MeiGallery - 精选写真图库" />
          <p class="text-xs text-gray-400 mt-1">搜索引擎显示的页面标题（title 标签）</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">OG 标题</label>
          <input v-model="form.og_title" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="留空则使用 SEO 标题" />
          <p class="text-xs text-gray-400 mt-1">社交平台（微信、微博等）分享时显示的标题</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">OG 描述</label>
          <textarea v-model="form.og_description" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="留空则使用站点描述" />
          <p class="text-xs text-gray-400 mt-1">社交平台分享时显示的描述文字</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">OG 封面图 URL</label>
          <input v-model="form.og_image" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="https://example.com/og-cover.jpg" />
          <p class="text-xs text-gray-400 mt-1">社交平台分享时显示的封面图片（推荐 1200x630）</p>
        </div>
      </fieldset>

      <!-- 其他设置 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">其他设置</legend>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">会员说明</label>
          <textarea v-model="form.membership_description" rows="3" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="会员等级权益说明..." />
        </div>

        <!-- 邮箱验证开关 -->
        <div class="rounded-lg border border-gray-200 p-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-700">邮箱验证</p>
              <p class="text-xs text-gray-500 mt-0.5">开启后注册和修改邮箱需要验证码（需 Workers Paid 计划）</p>
            </div>
            <button
              type="button"
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
      </fieldset>

      <div v-if="message" class="text-sm" :class="message.includes('失败') ? 'text-red-600' : 'text-green-600'">{{ message }}</div>

      <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
        {{ loading ? '保存中...' : '保存设置' }}
      </button>
    </form>
  </div>
</template>
