<script setup lang="ts">
definePageMeta({ layout: 'admin' })

type AdminUserListItem = {
  id: number
  email: string
  username: string | null
  nickname: string | null
  role: string
  status: string
  createdAt: string
}

type AdminUserDetail = AdminUserListItem & {
  emailVerified: boolean
}

const { api } = useApi()
const route = useRoute()
const router = useRouter()
const searchDraft = ref('')
const searchResults = ref<AdminUserListItem[]>([])
const searchTotal = ref(0)
const searching = ref(false)
const searchAttempted = ref(false)
const searchError = ref('')
const selectedUser = ref<AdminUserDetail | AdminUserListItem | null>(null)
const selectionError = ref('')
const selectionLoading = ref(false)

const initialUserId = positiveUserId(route.query.userId)
if (initialUserId) await loadSelectedUser(initialUserId)

async function searchAccounts() {
  const query = searchDraft.value.trim()
  if (!query) {
    searchError.value = '请输入稳定账号 ID、邮箱、用户名或昵称。'
    return
  }
  searching.value = true
  searchAttempted.value = true
  searchError.value = ''
  try {
    const response = await api<{ data: AdminUserListItem[]; total: number }>('/api/admin/users', {
      query: { q: query, page: 1, pageSize: 20 },
    })
    searchResults.value = response.data
    searchTotal.value = response.total
    if (response.data.length === 1 && response.data[0]?.status === 'active') {
      await selectUser(response.data[0])
    }
  }
  catch (error) {
    searchResults.value = []
    searchTotal.value = 0
    searchError.value = apiErrorMessage(error, '账号搜索失败，请重试。')
  }
  finally {
    searching.value = false
  }
}

async function selectUser(user: AdminUserListItem) {
  if (user.status !== 'active') {
    selectionError.value = '该账号当前受限，不能发放会员。'
    return
  }
  selectedUser.value = user
  selectionError.value = ''
  await router.replace({
    path: '/admin/app/membership/grants/new',
    query: { userId: String(user.id) },
  })
}

async function loadSelectedUser(userId: number) {
  selectionLoading.value = true
  selectionError.value = ''
  try {
    selectedUser.value = await api<AdminUserDetail>(`/api/admin/users/${userId}`)
    if (selectedUser.value.status !== 'active') {
      selectionError.value = '该账号当前受限，不能发放会员。'
    }
  }
  catch (error) {
    selectedUser.value = null
    selectionError.value = apiErrorMessage(error, '目标账号不存在或当前不可访问。')
  }
  finally {
    selectionLoading.value = false
  }
}

function clearSelection() {
  selectedUser.value = null
  selectionError.value = ''
  router.replace({ path: '/admin/app/membership/grants/new' })
}

function positiveUserId(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function userDisplayName(user: AdminUserListItem) {
  return user.nickname || user.username || '未设置昵称'
}

function apiErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback
  const candidate = error as { data?: { message?: unknown }; message?: unknown }
  if (typeof candidate.data?.message === 'string') return candidate.data.message
  if (typeof candidate.message === 'string' && candidate.message.length < 180) return candidate.message
  return fallback
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full bg-pink-50 px-2.5 py-1 text-xs font-medium text-pink-700 ring-1 ring-inset ring-pink-200">ADM-MBR-04 / 05</span>
          <h1 class="text-xl font-bold text-gray-950">创建会员变更</h1>
        </div>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
          在没有用户会员申请时，也可先确认目标账号，再预览并提交单账号 App 五级会员发放、续期或撤销。App 会员与旧 Web vip/svip 完全隔离。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <NuxtLink to="/admin/app/membership/reviews" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-800 hover:bg-violet-100">独立复核队列</NuxtLink>
        <NuxtLink to="/admin/app/membership/applications" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">返回会员申请队列</NuxtLink>
      </div>
    </div>

    <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
      <span class="font-semibold">当前开发边界：</span>
      支持单账号新发放、同级续期、预约生效、追加式撤销和独立复核。未发布正式风险阈值时全部变更进入双人复核；批量发放和旧会员迁移仍未开放。
    </div>

    <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
      <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
        <label class="min-w-0 flex-1 text-sm font-medium text-gray-700">
          搜索目标账号
          <input v-model="searchDraft" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="稳定账号 ID、邮箱、用户名或昵称" @keyup.enter="searchAccounts" />
        </label>
        <button :disabled="searching" class="min-h-11 w-full rounded-lg bg-gray-950 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" @click="searchAccounts">
          {{ searching ? '搜索中…' : '搜索并确认' }}
        </button>
      </div>
      <p v-if="searchError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ searchError }}</p>
      <div v-if="searchResults.length" class="mt-4 grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <button v-for="user in searchResults" :key="user.id" type="button" :disabled="user.status !== 'active'" class="min-w-0 rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:bg-gray-50 disabled:opacity-60" :class="selectedUser?.id === user.id ? 'border-pink-400 bg-pink-50/50 ring-2 ring-pink-100' : 'border-gray-200 hover:border-gray-400'" @click="selectUser(user)">
          <span class="block truncate text-sm font-semibold text-gray-950">{{ userDisplayName(user) }}</span>
          <span class="mt-1 block break-all text-xs text-gray-500">#{{ user.id }} · {{ user.email }}</span>
          <span class="mt-2 inline-flex rounded-full px-2 py-1 text-xs" :class="user.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'">{{ user.status === 'active' ? '账号正常' : '账号受限' }}</span>
        </button>
      </div>
      <p v-else-if="searchAttempted && !searching && !searchError" class="mt-4 rounded-lg bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">没有匹配账号，请核对输入。</p>
      <p v-if="searchTotal > searchResults.length" class="mt-3 text-xs text-gray-500">共匹配 {{ searchTotal }} 个账号，当前只显示前 {{ searchResults.length }} 个；请增加搜索条件缩小范围。</p>
    </section>

    <section v-if="selectionLoading" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在核对目标账号…</section>
    <p v-if="selectionError" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ selectionError }}</p>

    <section v-if="selectedUser" class="min-w-0 rounded-xl border border-pink-200 bg-gradient-to-r from-pink-50 to-white p-4 sm:p-5">
      <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <p class="text-xs font-medium text-pink-700">已确认目标账号</p>
          <p class="mt-1 truncate text-base font-semibold text-gray-950">{{ userDisplayName(selectedUser) }}</p>
          <p class="mt-1 break-all text-xs text-gray-600">内部用户 ID：{{ selectedUser.id }} · {{ selectedUser.email }}</p>
        </div>
        <button type="button" class="min-h-10 shrink-0 rounded-lg border border-pink-200 bg-white px-4 text-sm font-medium text-pink-700 hover:bg-pink-50" @click="clearSelection">更换账号</button>
      </div>
    </section>

    <AdminAppMembershipPanel v-if="selectedUser && selectedUser.status === 'active'" :key="selectedUser.id" :user-id="selectedUser.id" autoload />

    <section v-else-if="!selectionLoading" class="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center">
      <h2 class="text-base font-semibold text-gray-900">先选择一个正常账号</h2>
      <p class="mt-2 text-sm leading-6 text-gray-500">账号确认后才会加载当前会员、五级目录、权益差异和历史 grant。</p>
    </section>
  </div>
</template>
