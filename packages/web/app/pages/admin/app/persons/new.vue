<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const loading = ref(false)
const message = ref('')
const form = reactive({
  sourceGalleryId: '',
  displayName: '',
  summary: '',
  tagsText: '',
  regionCode: '',
  regionLabel: '',
  regionPrecision: 'city',
  recommendationScore: 0,
  heatScore: 0,
  recommendationReasonCode: 'EDITORIAL_QUALITY',
})

const { data: galleryData, status: galleryStatus } = await useAsyncData('admin-app-person-source-galleries', () =>
  api<{ data: Array<{ id: string; title: string; status: string; cover_key?: string | null }> }>('/api/admin/galleries', {
    query: { page: 1, pageSize: 100, status: 'published', sort: 'created_desc' },
  }),
)

const galleries = computed(() => galleryData.value?.data ?? [])

function normalizedTags() {
  return [...new Set(
    form.tagsText
      .split(/[，,]/u)
      .map(item => item.trim())
      .filter(Boolean),
  )]
}

async function onSubmit() {
  loading.value = true
  message.value = ''
  try {
    const response = await api<{ data: { personId: string } }>('/api/admin/app/persons', {
      method: 'POST',
      body: {
        sourceGalleryId: form.sourceGalleryId,
        displayName: form.displayName,
        summary: form.summary,
        tags: normalizedTags(),
        regionCode: form.regionCode,
        regionLabel: form.regionLabel,
        regionPrecision: form.regionCode || form.regionLabel ? form.regionPrecision : '',
        recommendationScore: form.recommendationScore,
        heatScore: form.heatScore,
        recommendationReasonCode: form.recommendationReasonCode,
      },
    })
    await navigateTo(`/admin/app/persons/${response.data.personId}`)
  } catch (error: any) {
    message.value = resolveApiErrorMessage(error, '创建人物候选失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-w-0 max-w-5xl space-y-5">
    <AdminAppPageHeader
      page-id="ADM-PER-02"
      route="/admin/app/persons/new"
      title="手动新建真人"
      description="创建带来源、授权、主体和媒体信息的不可见真人草稿。"
      :state="loading ? '保存中' : message ? '保存失败' : '正常'"
      :figma-state="galleryStatus !== 'pending' && !galleries.length ? '缺少来源' : message ? '媒体失败' : '正常'"
      :state-tone="message ? 'danger' : loading ? 'warning' : 'success'"
    >
      <template #actions><NuxtLink to="/admin/app/persons" class="inline-flex min-h-9 items-center rounded-[10px] border border-[#f2ddd6] bg-white px-4 text-sm font-medium text-[#6a5f5a] hover:bg-[#fff5f1]">返回真人列表</NuxtLink></template>
    </AdminAppPageHeader>

    <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
      <span class="font-semibold">不得直接录入宣传性认证结论。</span>
      展示名是公开昵称；认证声明只由后续复核结果生成。证据原件不要填写在本页。
    </div>

    <form class="min-w-0 space-y-6 rounded-xl border border-gray-200 bg-white p-4 sm:p-6" @submit.prevent="onSubmit">
      <section class="min-w-0 space-y-4">
        <div>
          <h2 class="text-base font-semibold text-gray-950">基础资料</h2>
          <p class="mt-1 text-xs leading-5 text-gray-500">一个来源图库当前只能关联一个人物候选，避免重复公开。</p>
        </div>
        <label class="block min-w-0">
          <span class="mb-1 block text-sm font-medium text-gray-700">来源图库</span>
          <select v-model="form.sourceGalleryId" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="" disabled>{{ galleryStatus === 'pending' ? '正在加载已发布图库…' : '选择已发布图库' }}</option>
            <option v-for="gallery in galleries" :key="gallery.id" :value="gallery.id">{{ gallery.title }}（{{ gallery.id }}）</option>
          </select>
          <p v-if="galleryStatus !== 'pending' && !galleries.length" class="mt-2 text-xs text-red-600">当前没有可选的已发布图库，请先准备来源图库及封面。</p>
        </label>
        <div class="grid min-w-0 gap-4 sm:grid-cols-2">
          <label class="min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">公开展示名</span>
            <input v-model="form.displayName" required maxlength="80" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="使用已确认可公开的昵称" />
          </label>
          <label class="min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">标签</span>
            <input v-model="form.tagsText" maxlength="320" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="清新，生活，长发（最多 8 个）" />
          </label>
        </div>
        <label class="block min-w-0">
          <span class="mb-1 block text-sm font-medium text-gray-700">公开简介</span>
          <textarea v-model="form.summary" maxlength="500" rows="4" class="w-full min-w-0 resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6" placeholder="仅填写已经确认允许公开的信息" />
          <span class="mt-1 block text-right text-xs text-gray-400">{{ form.summary.length }} / 500</span>
        </label>
      </section>

      <section class="min-w-0 space-y-4 border-t border-gray-100 pt-6">
        <div>
          <h2 class="text-base font-semibold text-gray-950">地区与推荐</h2>
          <p class="mt-1 text-xs leading-5 text-gray-500">地区三项必须同时填写或同时留空；只记录业务所需的粗粒度地区。</p>
        </div>
        <div class="grid min-w-0 gap-4 md:grid-cols-3">
          <label class="min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">地区代码</span>
            <input v-model="form.regionCode" maxlength="32" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="cn-bj" />
          </label>
          <label class="min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">地区名称</span>
            <input v-model="form.regionLabel" maxlength="80" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="北京市" />
          </label>
          <label class="min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">地区精度</span>
            <select v-model="form.regionPrecision" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="city">城市</option>
              <option value="province">省级</option>
              <option value="country">国家</option>
              <option value="broad">宽泛地区</option>
            </select>
          </label>
        </div>
        <div class="grid min-w-0 gap-4 md:grid-cols-3">
          <label class="min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">推荐分</span>
            <input v-model.number="form.recommendationScore" type="number" min="0" max="1000000" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label class="min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">热度分</span>
            <input v-model.number="form.heatScore" type="number" min="0" max="1000000" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label class="min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">推荐原因码</span>
            <input v-model="form.recommendationReasonCode" maxlength="80" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
          </label>
        </div>
      </section>

      <section class="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <h2 class="text-sm font-semibold text-gray-900">固定运营披露</h2>
        <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt class="text-gray-500">当前运营模式</dt><dd class="mt-1 font-medium text-gray-900">平台运营</dd></div>
          <div><dt class="text-gray-500">App 公开文案</dt><dd class="mt-1 font-medium text-gray-900">消息由平台运营接收</dd></div>
        </dl>
      </section>

      <p v-if="message" class="break-words rounded-lg bg-red-50 p-3 text-sm leading-6 text-red-700">{{ message }}</p>
      <div class="flex flex-wrap items-center gap-3">
        <button
          :disabled="loading || !galleries.length"
          class="inline-flex min-h-11 max-w-full items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >{{ loading ? '创建中…' : '创建不可见草稿' }}</button>
        <span class="text-xs leading-5 text-gray-500">创建操作会写入管理员审计日志。</span>
      </div>
    </form>
  </div>
</template>
