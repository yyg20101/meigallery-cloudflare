<script setup lang="ts">
const { user, isLoggedIn, membershipRank, logout } = useAuth()
const { api } = useApi()
const router = useRouter()

if (!isLoggedIn.value) {
  router.replace('/login')
}

// 获取站点联系方式
const { data: siteSettings } = await useAsyncData('site-settings', () =>
  api<Record<string, string>>('/api/settings/public'),
)

const memberLabel = computed(() => {
  if (membershipRank.value >= 20) return 'SVIP'
  if (membershipRank.value >= 10) return 'VIP'
  return '免费用户'
})

useSeoMeta({ title: '个人中心 - MeiGallery', robots: 'noindex' })
</script>

<template>
  <div class="mx-auto max-w-2xl px-4 py-6 sm:px-6 lg:px-8 pb-20 sm:pb-6">
    <h1 class="text-2xl font-bold text-gray-900 mb-6">用户中心</h1>

    <div v-if="user" class="space-y-6">
      <!-- 账号信息 -->
      <div class="rounded-lg bg-white p-6 shadow-sm border border-gray-200">
        <h2 class="text-base font-semibold text-gray-900 mb-4">账号信息</h2>
        <dl class="space-y-3 text-sm">
          <div class="flex justify-between">
            <dt class="text-gray-500">邮箱</dt>
            <dd class="text-gray-900">{{ user.email }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-gray-500">昵称</dt>
            <dd class="text-gray-900">{{ user.nickname || '未设置' }}</dd>
          </div>
        </dl>
      </div>

      <!-- 会员状态 -->
      <div class="rounded-lg bg-white p-6 shadow-sm border border-gray-200">
        <h2 class="text-base font-semibold text-gray-900 mb-4">会员状态</h2>
        <div class="flex items-center gap-3 mb-3">
          <MembershipBadge :rank="membershipRank" />
          <span class="text-sm text-gray-900 font-medium">{{ memberLabel }}</span>
        </div>
        <div v-if="user.membershipExpiry" class="text-sm text-gray-500">
          有效期至：{{ user.membershipExpiry.split('T')[0] }}
        </div>
        <div v-else class="text-sm text-gray-500">
          联系站长获取会员权益
        </div>
      </div>

      <!-- 联系站长 -->
      <div class="rounded-lg bg-white p-6 shadow-sm border border-gray-200">
        <h2 class="text-base font-semibold text-gray-900 mb-4">联系站长</h2>
        <dl v-if="siteSettings" class="space-y-3 text-sm">
          <div v-if="siteSettings.contact_wechat" class="flex justify-between">
            <dt class="text-gray-500">微信</dt>
            <dd class="text-gray-900">{{ siteSettings.contact_wechat }}</dd>
          </div>
          <div v-if="siteSettings.contact_telegram" class="flex justify-between">
            <dt class="text-gray-500">Telegram</dt>
            <dd class="text-gray-900">{{ siteSettings.contact_telegram }}</dd>
          </div>
          <div v-if="siteSettings.contact_email" class="flex justify-between">
            <dt class="text-gray-500">邮箱</dt>
            <dd class="text-gray-900">{{ siteSettings.contact_email }}</dd>
          </div>
          <div v-if="siteSettings.contact_custom_note" class="text-gray-600">
            {{ siteSettings.contact_custom_note }}
          </div>
        </dl>
        <p v-else class="text-sm text-gray-400">暂无联系方式</p>
      </div>

      <!-- 操作 -->
      <button class="text-sm text-red-600 hover:underline" @click="logout">退出登录</button>
    </div>
  </div>
</template>
