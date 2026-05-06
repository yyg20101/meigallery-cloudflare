<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()

interface ImportApiTokenRow {
  id: string
  name: string
  permissions: string
  allowed_source_bot_keys: string
  status: 'active' | 'disabled'
  expires_at: string | null
  last_used_at: string | null
  created_at: string
  updated_at: string
}

const { data, refresh } = await useAsyncData('admin-import-api-tokens', () =>
  api<{ data: ImportApiTokenRow[] }>('/api/admin/import-api-tokens'),
)

const items = computed(() => data.value?.data ?? [])
const creating = ref(false)
const createdToken = ref('')
const form = reactive({
  name: '',
  allowedSourceBotKeys: 'ops_gallery_bot',
  expiresAt: '',
  galleryCreate: true,
  testimonialCreate: false,
})

function parseJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

function formatDateTime(value: string | null) {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 19)
}

function permissionLabel(permission: string) {
  if (permission === 'gallery:create') return '图库草稿'
  if (permission === 'testimonial:create') return '真实案例草稿'
  return permission
}

function tokenStatusClass(status: string) {
  return status === 'active' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'
}

async function createToken() {
  createdToken.value = ''
  creating.value = true
  try {
    const permissions = [
      form.galleryCreate ? 'gallery:create' : '',
      form.testimonialCreate ? 'testimonial:create' : '',
    ].filter(Boolean)
    const allowedSourceBotKeys = form.allowedSourceBotKeys.split(',').map(key => key.trim()).filter(Boolean)
    const result = await api<{ token: string; message: string }>('/api/admin/import-api-tokens', {
      method: 'POST',
      body: {
        name: form.name,
        permissions,
        allowedSourceBotKeys,
        expiresAt: form.expiresAt || null,
      },
    })
    createdToken.value = result.token
    form.name = ''
    await refresh()
  } catch (error: any) {
    useToast().add({ title: error?.data?.message || '创建 Import Token 失败', color: 'error' })
  } finally {
    creating.value = false
  }
}

async function disableToken(id: string) {
  if (!confirm('确认禁用该 Import Token？禁用后 Bot 将无法继续使用它导入。')) return
  await api(`/api/admin/import-api-tokens/${id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div>
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-bold text-gray-900">导入 API Token</h1>
        <p class="mt-1 text-sm text-gray-500">用于 Telegram Bot / Ops Hub 调用 file_id 异步导入 API。明文 token 只在创建后显示一次。</p>
      </div>
      <NuxtLink to="/admin/external-import-records" class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">查看导入记录</NuxtLink>
    </div>

    <div v-if="!isOwner" class="mb-6 rounded-lg bg-yellow-50 p-4 text-sm text-yellow-800">仅站长可管理 Import Token。</div>

    <section v-if="isOwner" class="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 class="text-base font-semibold text-gray-900">创建 Token</h2>
      <form class="mt-4 grid gap-4 lg:grid-cols-2" @submit.prevent="createToken">
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">名称</label>
          <input v-model="form.name" required maxlength="60" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如 Telegram 图库导入 Bot" />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">允许的 sourceBotKey</label>
          <input v-model="form.allowedSourceBotKeys" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="ops_gallery_bot,ops_case_bot" />
          <p class="mt-1 text-xs text-gray-400">英文逗号分隔，只允许小写字母、数字和下划线。</p>
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">过期时间</label>
          <input v-model="form.expiresAt" type="datetime-local" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <span class="mb-2 block text-sm font-medium text-gray-700">权限</span>
          <div class="flex flex-wrap gap-3 text-sm text-gray-700">
            <label class="inline-flex items-center gap-2"><input v-model="form.galleryCreate" type="checkbox" />图库草稿</label>
            <label class="inline-flex items-center gap-2"><input v-model="form.testimonialCreate" type="checkbox" />真实案例草稿</label>
          </div>
        </div>
        <div class="lg:col-span-2">
          <button :disabled="creating" class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{{ creating ? '创建中...' : '创建 Token' }}</button>
        </div>
      </form>
    </section>

    <div v-if="createdToken" class="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p class="text-sm font-medium text-amber-900">请立即保存以下 token，刷新后无法再次查看。</p>
      <code class="mt-3 block overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-xs text-gray-900 ring-1 ring-amber-100">{{ createdToken }}</code>
    </div>

    <div v-if="isOwner" class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="min-w-full text-sm">
        <thead class="border-b bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
          <tr><th class="px-4 py-3">名称</th><th class="px-4 py-3">权限</th><th class="px-4 py-3">sourceBotKey</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">最近使用</th><th class="px-4 py-3">过期</th><th class="px-4 py-3 text-right">操作</th></tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="item in items" :key="item.id" class="hover:bg-gray-50">
            <td class="px-4 py-3"><div class="font-medium text-gray-900">{{ item.name }}</div><div class="font-mono text-xs text-gray-400">{{ item.id }}</div></td>
            <td class="px-4 py-3"><span v-for="permission in parseJsonArray(item.permissions)" :key="permission" class="mr-1 inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{{ permissionLabel(permission) }}</span></td>
            <td class="px-4 py-3"><span v-for="key in parseJsonArray(item.allowed_source_bot_keys)" :key="key" class="mr-1 inline-flex rounded-full bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">{{ key }}</span></td>
            <td class="px-4 py-3"><span :class="['rounded-full px-2 py-0.5 text-xs font-medium', tokenStatusClass(item.status)]">{{ item.status === 'active' ? '启用' : '禁用' }}</span></td>
            <td class="px-4 py-3 text-gray-500">{{ formatDateTime(item.last_used_at) }}</td>
            <td class="px-4 py-3 text-gray-500">{{ formatDateTime(item.expires_at) }}</td>
            <td class="px-4 py-3 text-right"><button v-if="item.status === 'active'" class="text-xs text-red-600 hover:underline" @click="disableToken(item.id)">禁用</button></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="7" class="px-4 py-10 text-center text-gray-400">暂无 Import Token</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
