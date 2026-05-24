<script setup lang="ts">
import { CONTACT_PLATFORMS, generateContactLink } from '@meigallery/shared/constants'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()

interface ContactMethod {
  id: string
  platform: string
  label: string
  value: string
  linkUrl: string | null
  qrCodeKey: string | null
  qrCodeUrl: string | null
  sortOrder: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

const { data: result, refresh } = await useAsyncData('admin-contact-methods', () =>
  api<{ data: ContactMethod[] }>('/api/admin/contact-methods'),
)

const items = computed(() => result.value?.data || [])

// Form state
const showForm = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({
  platform: 'wechat',
  label: '',
  value: '',
  linkUrl: '',
  enabled: true,
})

const platformOptions = Object.entries(CONTACT_PLATFORMS).map(([key, cfg]) => ({ key, name: cfg.name }))

const currentPlatformConfig = computed(() => CONTACT_PLATFORMS[form.platform])
const autoLink = computed(() => generateContactLink(form.platform, form.value))
const canAutoLink = computed(() => currentPlatformConfig.value?.supportsLink && !!currentPlatformConfig.value?.linkTemplate)
const linkHint = computed(() => currentPlatformConfig.value?.linkHint || '该平台无法自动判断跳转能力，前台会优先复制联系值。')

function resetForm() {
  form.platform = 'wechat'
  form.label = ''
  form.value = ''
  form.linkUrl = ''
  form.enabled = true
  editingId.value = null
  showForm.value = false
}

function startCreate() {
  resetForm()
  showForm.value = true
}

function startEdit(item: ContactMethod) {
  editingId.value = item.id
  form.platform = item.platform
  form.label = item.label
  form.value = item.value
  form.linkUrl = item.linkUrl || ''
  form.enabled = item.enabled
  showForm.value = true
}

async function onSubmit() {
  try {
    const body = {
      platform: form.platform,
      label: form.label,
      value: form.value,
      linkUrl: form.linkUrl || null,
      enabled: form.enabled,
    }
    if (editingId.value) {
      await api(`/api/admin/contact-methods/${editingId.value}`, { method: 'PUT', body })
    } else {
      await api('/api/admin/contact-methods', { method: 'POST', body })
    }
    resetForm()
    await refresh()
  } catch (e: any) {
    useToast().add({ title: e?.data?.message || '操作失败', color: 'error' })
  }
}

const showDeleteConfirm = ref(false)
const deleteTargetId = ref('')

function onDelete(id: string) {
  deleteTargetId.value = id
  showDeleteConfirm.value = true
}

async function doDelete() {
  await api(`/api/admin/contact-methods/${deleteTargetId.value}`, { method: 'DELETE' })
  showDeleteConfirm.value = false
  await refresh()
}

async function onToggle(item: ContactMethod) {
  await api(`/api/admin/contact-methods/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } })
  await refresh()
}

async function onMove(index: number, direction: -1 | 1) {
  const list = [...items.value]
  const target = index + direction
  if (target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target], list[index]]
  await api('/api/admin/contact-methods/reorder', { method: 'PATCH', body: { ids: list.map(i => i.id) } })
  await refresh()
}

// QR Code upload
const fileInputRefs = ref<Record<string, HTMLInputElement | null>>({})

function triggerUpload(id: string) {
  const el = document.getElementById(`qr-input-${id}`) as HTMLInputElement | null
  el?.click()
}

async function onQrUpload(event: Event, id: string) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const formData = new FormData()
  formData.append('file', file)
  await api(`/api/admin/contact-methods/${id}/qrcode`, { method: 'POST', body: formData })
  input.value = ''
  await refresh()
}

async function onQrDelete(id: string) {
  await api(`/api/admin/contact-methods/${id}/qrcode`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-bold text-gray-900">联系方式管理</h1>
      <button class="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700" @click="startCreate">
        新增联系方式
      </button>
    </div>

    <div v-if="!isOwner" class="rounded-lg bg-yellow-50 p-4 text-sm text-yellow-800 mb-6">
      仅站长可管理联系方式
    </div>

    <!-- Create/Edit Form -->
    <div v-if="showForm && isOwner" class="bg-white border border-gray-200 rounded-lg p-6 mb-6">
      <h2 class="text-base font-semibold text-gray-900 mb-4">{{ editingId ? '编辑联系方式' : '新增联系方式' }}</h2>
      <form class="space-y-4" @submit.prevent="onSubmit">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">平台 <span class="text-red-500">*</span></label>
            <select v-model="form.platform" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option v-for="opt in platformOptions" :key="opt.key" :value="opt.key">{{ opt.name }}</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">标签 <span class="text-red-500">*</span></label>
            <input v-model="form.label" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" :placeholder="'如：客服' + currentPlatformConfig.name" />
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">联系值 <span class="text-red-500">*</span></label>
          <input v-model="form.value" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" :placeholder="currentPlatformConfig.placeholder" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">跳转链接（可选）</label>
          <div class="flex gap-2">
            <input v-model="form.linkUrl" class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="可手动填写完整 URL；留空时按平台自动判断" />
            <button
              v-if="autoLink && !form.linkUrl"
              type="button"
              class="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-xs text-blue-600 hover:bg-blue-50"
              @click="form.linkUrl = autoLink"
            >
              填充自动链接
            </button>
          </div>
          <p class="mt-1 text-xs text-gray-500">{{ linkHint }}</p>
          <p v-if="autoLink" class="mt-0.5 break-all text-xs text-gray-400">可用自动链接：{{ autoLink }}</p>
          <p v-else-if="canAutoLink" class="mt-0.5 text-xs text-gray-400">填写有效联系值后，前台会自动生成跳转链接。</p>
          <p v-else class="mt-0.5 text-xs text-gray-400">未手动填写链接时，前台点击默认复制联系值。</p>
        </div>
        <div class="flex items-center gap-2">
          <input id="form-enabled" v-model="form.enabled" type="checkbox" class="rounded" />
          <label for="form-enabled" class="text-sm text-gray-700">启用</label>
        </div>
        <div class="flex gap-3">
          <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
            {{ editingId ? '保存修改' : '创建' }}
          </button>
          <button type="button" class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" @click="resetForm">
            取消
          </button>
        </div>
      </form>
    </div>

    <!-- List -->
    <div v-if="isOwner" class="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-700">排序</th>
            <th class="px-4 py-3 text-left font-medium text-gray-700">平台</th>
            <th class="px-4 py-3 text-left font-medium text-gray-700">标签</th>
            <th class="px-4 py-3 text-left font-medium text-gray-700">联系值</th>
            <th class="px-4 py-3 text-left font-medium text-gray-700">二维码</th>
            <th class="px-4 py-3 text-left font-medium text-gray-700">状态</th>
            <th class="px-4 py-3 text-left font-medium text-gray-700">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in items" :key="item.id" class="border-b border-gray-100 last:border-0">
            <td class="px-4 py-3">
              <div class="flex gap-1">
                <button class="text-gray-400 hover:text-gray-700 disabled:opacity-30" :disabled="index === 0" @click="onMove(index, -1)">↑</button>
                <button class="text-gray-400 hover:text-gray-700 disabled:opacity-30" :disabled="index === items.length - 1" @click="onMove(index, 1)">↓</button>
              </div>
            </td>
            <td class="px-4 py-3">
              <div class="flex items-center gap-2">
                <PlatformIcon :platform="item.platform" :size="18" />
                <span>{{ CONTACT_PLATFORMS[item.platform]?.name || item.platform }}</span>
              </div>
            </td>
            <td class="px-4 py-3">{{ item.label }}</td>
            <td class="px-4 py-3 text-gray-600">{{ item.value }}</td>
            <td class="px-4 py-3">
              <div class="flex items-center gap-2">
                <img v-if="item.qrCodeUrl" :src="item.qrCodeUrl" class="w-10 h-10 rounded object-cover" />
                <button class="text-xs text-blue-600 hover:underline" @click="triggerUpload(item.id)">
                  {{ item.qrCodeUrl ? '更换' : '上传' }}
                </button>
                <button v-if="item.qrCodeUrl" class="text-xs text-red-600 hover:underline" @click="onQrDelete(item.id)">
                  删除
                </button>
                <input :id="`qr-input-${item.id}`" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="(e) => onQrUpload(e, item.id)" />
              </div>
            </td>
            <td class="px-4 py-3">
              <button
                class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                :class="item.enabled ? 'bg-green-500' : 'bg-gray-300'"
                @click="onToggle(item)"
              >
                <span class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform" :class="item.enabled ? 'translate-x-4.5' : 'translate-x-0.5'" />
              </button>
            </td>
            <td class="px-4 py-3">
              <div class="flex gap-2">
                <button class="text-xs text-blue-600 hover:underline" @click="startEdit(item)">编辑</button>
                <button class="text-xs text-red-600 hover:underline" @click="onDelete(item.id)">删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">暂无联系方式，点击右上角"新增联系方式"添加</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 删除确认弹窗 -->
    <UModal v-model:open="showDeleteConfirm">
      <template #content>
        <div class="p-6">
          <h3 class="text-base font-semibold text-gray-900 mb-3">确认删除</h3>
          <p class="text-sm text-gray-600 mb-4">确认删除此联系方式？</p>
          <div class="flex gap-3">
            <button class="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700" @click="doDelete">确认删除</button>
            <button class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" @click="showDeleteConfirm = false">取消</button>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
