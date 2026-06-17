<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const toast = useToast()
const createExport = useAnalyticsExport()

interface InviteCode {
  id: string
  displayCode: string
  name: string
  channel: string
  status: string
  maxUses: number | null
  usedCount: number
  expiresAt: string | null
  note: string
}

const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/invites')
const inviteCodes = ref<InviteCode[]>([])
const codesLoading = ref(false)
const createOpen = ref(false)
const createError = ref('')
const creating = ref(false)
const createdCode = ref('')
const form = reactive({
  name: '',
  channel: 'manual',
  code: '',
  maxUses: '',
  expiresAt: '',
  note: '',
})

onMounted(() => {
  void fetchInviteCodes()
})

async function fetchInviteCodes() {
  codesLoading.value = true
  try {
    const result = await api<{ data: InviteCode[] }>('/api/admin/invite-codes')
    inviteCodes.value = result.data ?? []
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '邀请码加载失败'), color: 'error' })
  } finally {
    codesLoading.value = false
  }
}

async function createInviteCode() {
  createError.value = ''
  createdCode.value = ''
  if (!form.name.trim()) {
    createError.value = '请填写邀请码名称'
    return
  }
  creating.value = true
  try {
    const result = await api<{ code: string }>('/api/admin/invite-codes', {
      method: 'POST',
      body: {
        name: form.name,
        channel: form.channel,
        code: form.code || undefined,
        maxUses: form.maxUses ? Number(form.maxUses) : null,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        note: form.note,
      },
    })
    createdCode.value = result.code
    form.name = ''
    form.code = ''
    form.maxUses = ''
    form.expiresAt = ''
    form.note = ''
    toast.add({ title: '邀请码已创建', color: 'success' })
    await fetchInviteCodes()
  } catch (error) {
    createError.value = resolveApiErrorMessage(error, '邀请码创建失败')
  } finally {
    creating.value = false
  }
}

async function disableInviteCode(item: InviteCode) {
  if (item.status === 'disabled') return
  try {
    await api(`/api/admin/invite-codes/${item.id}`, {
      method: 'PATCH',
      body: { disable: true },
    })
    toast.add({ title: '邀请码已禁用', color: 'success' })
    await fetchInviteCodes()
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '邀请码禁用失败'), color: 'error' })
  }
}

function inviteLink(code: string) {
  if (!import.meta.client) return `/?invite=${encodeURIComponent(code)}`
  return `${window.location.origin}/?invite=${encodeURIComponent(code)}`
}

async function copyInviteLink(code: string) {
  if (!import.meta.client) return
  await navigator.clipboard?.writeText(inviteLink(code))
  toast.add({ title: '邀请链接已复制', color: 'success' })
}
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    v-model:date="analytics.date.value"
    title="邀请转化"
    description="查看邀请码带来的落地、注册、联系和会员发放，并维护后台邀请码。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('invites', analytics.range.value, analytics.date.value)"
  >
    <div class="grid gap-5 xl:grid-cols-[1fr_22rem]">
      <section class="space-y-3">
        <h2 class="text-sm font-semibold text-gray-900">邀请效果</h2>
        <AnalyticsDataTable
          empty-title="暂无邀请转化"
          empty-text="当前时间范围没有邀请码落地、注册或会员发放转化。创建邀请码并使用邀请链接访问后会生成数据。"
          empty-action-label="查看采集健康"
          empty-action-to="/admin/analytics/health"
          :columns="[
            { key: 'invite_code_id', label: '邀请码 ID', sortable: true },
            { key: 'invite_name', label: '名称', sortable: true },
            { key: 'channel', label: '渠道', sortable: true },
            { key: 'status', label: '状态' },
            { key: 'landing_count', label: '落地', type: 'number', sortable: true },
            { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
            { key: 'register_count', label: '注册', type: 'number', sortable: true },
            { key: 'contact_click_count', label: '联系入口', type: 'number', sortable: true },
            { key: 'membership_grant_count', label: '会员', type: 'number', sortable: true },
          ]"
          :rows="analytics.data.value || []"
        />
      </section>

      <aside class="space-y-4">
        <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-sm font-semibold text-gray-900">邀请码</h2>
            <button class="rounded-lg bg-gray-950 px-3 py-2 text-xs font-medium text-white hover:bg-gray-800" type="button" @click="createOpen = !createOpen">
              {{ createOpen ? '收起' : '创建' }}
            </button>
          </div>

          <form v-if="createOpen" class="mt-4 space-y-3" @submit.prevent="createInviteCode">
            <input v-model="form.name" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="名称，例如 6 月 Telegram 活动" />
            <select v-model="form.channel" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="manual">manual</option>
              <option value="telegram">telegram</option>
              <option value="wechat">wechat</option>
              <option value="partner">partner</option>
            </select>
            <input v-model="form.code" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="自定义 code，可留空" />
            <input v-model="form.maxUses" type="number" min="0" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="最大使用次数，可留空" />
            <input v-model="form.expiresAt" type="datetime-local" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <textarea v-model="form.note" rows="3" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="内部备注" />
            <p v-if="createError" class="text-xs text-red-600">{{ createError }}</p>
            <button class="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60" type="submit" :disabled="creating">
              {{ creating ? '创建中...' : '创建邀请码' }}
            </button>
            <div v-if="createdCode" class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
              <p class="font-semibold">明文 code 仅此一次显示</p>
              <p class="mt-1 font-mono">{{ createdCode }}</p>
              <button class="mt-2 text-emerald-700 underline" type="button" @click="copyInviteLink(createdCode)">复制邀请链接</button>
            </div>
          </form>
        </div>

        <div class="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div class="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">
            最近邀请码
          </div>
          <div v-if="codesLoading" class="px-4 py-6 text-sm text-gray-500">加载中...</div>
          <div v-else-if="inviteCodes.length === 0" class="px-4 py-6 text-sm text-gray-400">暂无邀请码</div>
          <div v-else class="divide-y divide-gray-100">
            <div v-for="item in inviteCodes.slice(0, 8)" :key="item.id" class="px-4 py-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-gray-900">{{ item.name }}</p>
                  <p class="mt-1 text-xs text-gray-500">{{ item.channel }} · {{ item.displayCode }} · 已用 {{ item.usedCount }}{{ item.maxUses !== null ? `/${item.maxUses}` : '' }}</p>
                </div>
                <span :class="['rounded-full px-2 py-0.5 text-xs', item.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500']">{{ item.status }}</span>
              </div>
              <div class="mt-2 flex gap-3 text-xs">
                <span class="text-gray-400">完整链接仅创建后显示</span>
                <button v-if="item.status !== 'disabled'" class="text-red-600 hover:underline" type="button" @click="disableInviteCode(item)">禁用</button>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </AnalyticsPageShell>
</template>
