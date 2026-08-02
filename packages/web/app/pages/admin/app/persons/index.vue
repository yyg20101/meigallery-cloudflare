<script setup lang="ts">
import type { AdminPersonListResponse } from '~/types/admin-app-person'
import { formatAdminDate, PERSON_STATUS_LABELS, personStatusClass } from '~/types/admin-app-person'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const page = ref(1)
const publicationStatus = ref('')
const searchInput = ref('')
const query = ref('')

const { data, status, error, refresh } = await useAsyncData('admin-app-persons', () =>
  api<AdminPersonListResponse>('/api/admin/app/persons', {
    query: {
      page: page.value,
      pageSize: 20,
      q: query.value || undefined,
      publicationStatus: publicationStatus.value || undefined,
    },
  }),
  { watch: [page, publicationStatus, query] },
)

const items = computed(() => data.value?.data ?? [])
const pagination = computed(() => data.value?.pagination ?? { page: 1, pageSize: 20, total: 0, totalPages: 0 })

function applySearch() {
  query.value = searchInput.value.trim()
  page.value = 1
}

watch(publicationStatus, () => { page.value = 1 })
</script>

<template>
  <div class="min-w-0 space-y-5">
    <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h1 class="text-xl font-bold text-gray-950">App 人物供给</h1>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
          管理人物候选、用途授权、认证复核与公开版本。这里不会把现有图库自动映射为人物。
        </p>
      </div>
      <NuxtLink
        to="/admin/app/persons/new"
        class="inline-flex min-h-10 shrink-0 items-center justify-center self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        新建人物候选
      </NuxtLink>
    </div>

    <div class="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
      <span class="font-semibold">上线边界：</span>
      只有当前内容版本同时通过用途授权、四项认证与发布复核，且来源图库仍发布时，才会生成 App 公开投影。
    </div>

    <form class="grid min-w-0 gap-3 rounded-xl border border-gray-200 bg-white p-4 md:grid-cols-[minmax(0,1fr)_13rem_auto]" @submit.prevent="applySearch">
      <label class="min-w-0">
        <span class="sr-only">搜索人物候选</span>
        <input
          v-model="searchInput"
          class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          maxlength="80"
          placeholder="搜索展示名、人物 ID 或资料 ID"
        />
      </label>
      <label class="min-w-0">
        <span class="sr-only">发布状态</span>
        <select v-model="publicationStatus" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="">全部发布状态</option>
          <option value="draft">草稿</option>
          <option value="pending_review">待发布复核</option>
          <option value="published">已发布</option>
          <option value="suspended">已暂停</option>
          <option value="archived">已归档</option>
        </select>
      </label>
      <button class="min-h-10 rounded-lg bg-gray-950 px-5 py-2 text-sm font-medium text-white hover:bg-black">查询</button>
    </form>

    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      人物候选加载失败。
      <button class="ml-2 font-medium underline" @click="refresh()">重试</button>
    </div>

    <div class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div v-if="status === 'pending'" class="px-6 py-12 text-center text-sm text-gray-500">正在加载人物供给队列…</div>
      <div v-else-if="!items.length" class="px-6 py-12 text-center">
        <h2 class="text-base font-semibold text-gray-900">还没有人物候选</h2>
        <p class="mt-2 text-sm text-gray-500">请从一条已确认来源的图库开始创建草稿。</p>
      </div>
      <div v-else class="w-full overflow-x-auto">
        <table class="min-w-[980px] w-full divide-y divide-gray-200 text-sm">
          <thead class="bg-gray-50 text-left text-xs font-medium text-gray-600">
            <tr>
              <th class="px-4 py-3">人物 / 来源</th>
              <th class="px-4 py-3">用途授权</th>
              <th class="px-4 py-3">认证</th>
              <th class="px-4 py-3">发布</th>
              <th class="px-4 py-3">版本</th>
              <th class="px-4 py-3">更新时间</th>
              <th class="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="item in items" :key="item.personId" class="align-top hover:bg-gray-50/70">
              <td class="max-w-72 px-4 py-4">
                <div class="break-words font-medium text-gray-950">{{ item.displayName }}</div>
                <div class="mt-1 break-all text-xs text-gray-500">{{ item.personId }}</div>
                <div class="mt-1 break-words text-xs text-gray-500">来源：{{ item.sourceGalleryTitle }}</div>
              </td>
              <td class="px-4 py-4">
                <span class="inline-flex rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="personStatusClass(item.authorizationStatus)">
                  {{ PERSON_STATUS_LABELS[item.authorizationStatus] || item.authorizationStatus }}
                </span>
              </td>
              <td class="px-4 py-4">
                <span class="inline-flex rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="personStatusClass(item.verificationStatus)">
                  {{ PERSON_STATUS_LABELS[item.verificationStatus] || item.verificationStatus }}
                </span>
              </td>
              <td class="px-4 py-4">
                <span class="inline-flex rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="personStatusClass(item.publicationStatus)">
                  {{ PERSON_STATUS_LABELS[item.publicationStatus] || item.publicationStatus }}
                </span>
                <div class="mt-2 text-xs" :class="item.liveVisible ? 'text-emerald-700' : 'text-gray-500'">
                  {{ item.liveVisible ? 'App 当前可见' : 'App 当前不可见' }}
                </div>
              </td>
              <td class="px-4 py-4 text-xs leading-5 text-gray-600">
                <div>草稿 v{{ item.contentVersion }}</div>
                <div>线上 {{ item.liveContentVersion ? `v${item.liveContentVersion}` : '—' }}</div>
              </td>
              <td class="whitespace-nowrap px-4 py-4 text-xs text-gray-500">{{ formatAdminDate(item.updatedAt) }}</td>
              <td class="px-4 py-4 text-right">
                <NuxtLink :to="`/admin/app/persons/${item.personId}`" class="font-medium text-blue-600 hover:underline">进入工作台</NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
      <span>共 {{ pagination.total }} 条</span>
      <div class="flex items-center gap-2">
        <button
          :disabled="page <= 1"
          class="min-h-9 rounded-lg border border-gray-300 bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          @click="page -= 1"
        >上一页</button>
        <span>第 {{ pagination.page }} / {{ Math.max(pagination.totalPages, 1) }} 页</span>
        <button
          :disabled="page >= pagination.totalPages"
          class="min-h-9 rounded-lg border border-gray-300 bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          @click="page += 1"
        >下一页</button>
      </div>
    </div>
  </div>
</template>
