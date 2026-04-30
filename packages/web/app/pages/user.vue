<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const { isLoggedIn, user, membershipRank, membershipLevel, membershipExpiry, logout } = useAuth()

useSeoMeta({ title: '个人中心 - MeiGallery', robots: 'noindex' })

const levelName = computed(() => {
  if (membershipLevel?.value) return membershipLevel.value === 'svip' ? 'SVIP' : membershipLevel.value === 'vip' ? 'VIP' : '免费'
  if (membershipRank.value >= 20) return 'SVIP'
  if (membershipRank.value >= 10) return 'VIP'
  return '免费'
})

const currentRank = computed(() => membershipRank.value ?? 0)

async function handleLogout() {
  await logout()
  navigateTo('/')
}
</script>

<template>
  <div class="max-w-lg mx-auto px-4 py-6 pb-20 sm:pb-6">
    <!-- 已登录 -->
    <template v-if="isLoggedIn && user">
      <!-- 用户信息区 -->
      <div class="bg-white rounded-xl p-6 mb-3">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center text-xl text-gray-500 font-semibold shrink-0">
            {{ user.nickname?.charAt(0) || user.email?.charAt(0) || '?' }}
          </div>
          <div class="min-w-0">
            <div class="text-lg font-semibold text-gray-900 truncate">{{ user.nickname || '未设置昵称' }}</div>
            <div class="text-sm text-gray-400 truncate">{{ user.email }}</div>
          </div>
        </div>
      </div>

      <!-- 会员卡 -->
      <MembershipCard :level="levelName" :rank="currentRank" :expires-at="membershipExpiry" class="mb-3" />

      <!-- 权益对比 -->
      <div class="bg-white rounded-xl p-6 mb-3">
        <h3 class="text-base font-semibold text-gray-900 mb-4">会员权益</h3>
        <div class="grid grid-cols-3 gap-3 text-center text-sm">
          <!-- 免费列 -->
          <div
            class="rounded-lg p-3"
            :class="currentRank === 0 ? 'border-2 border-gray-400 bg-gray-50' : 'border border-gray-200'"
          >
            <div class="font-medium text-gray-700 mb-2">免费</div>
            <ul class="space-y-1 text-gray-500 text-xs">
              <li>公开图库</li>
              <li>预览视频</li>
            </ul>
          </div>
          <!-- VIP列 -->
          <div
            class="rounded-lg p-3"
            :class="currentRank === 10 ? 'border-2 border-amber-400 bg-amber-50' : 'border border-gray-200'"
          >
            <div class="font-medium text-amber-700 mb-2">VIP</div>
            <ul class="space-y-1 text-gray-500 text-xs">
              <li>VIP 图库</li>
              <li>高清图片</li>
              <li>完整视频</li>
            </ul>
          </div>
          <!-- SVIP列 -->
          <div
            class="rounded-lg p-3"
            :class="currentRank >= 20 ? 'border-2 border-purple-400 bg-purple-50' : 'border border-gray-200'"
          >
            <div class="font-medium text-purple-700 mb-2">SVIP</div>
            <ul class="space-y-1 text-gray-500 text-xs">
              <li>全部内容</li>
              <li>优先更新</li>
              <li>专属内容</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 联系站长 -->
      <ContactCard
        wechat="mei_gallery"
        telegram="@meigallery"
        email="hi@meigallery.com"
        custom-note="升级会员或有任何问题，请通过以上方式联系站长"
        class="mb-3"
      />

      <!-- 功能入口 -->
      <div class="bg-white rounded-xl divide-y divide-gray-100 mb-3">
        <div class="flex items-center justify-between px-6 py-4">
          <span class="text-sm text-gray-700">浏览历史</span>
          <span class="text-xs text-gray-400">即将推出</span>
        </div>
        <div class="flex items-center justify-between px-6 py-4">
          <span class="text-sm text-gray-700">我的收藏</span>
          <span class="text-xs text-gray-400">即将推出</span>
        </div>
        <button class="w-full flex items-center justify-between px-6 py-4" @click="handleLogout">
          <span class="text-sm text-red-500">退出登录</span>
        </button>
      </div>
    </template>

    <!-- 未登录 -->
    <template v-else>
      <div class="bg-white rounded-xl p-8 text-center">
        <div class="text-gray-500 mb-4">登录后查看个人信息和会员权益</div>
        <button
          class="inline-block px-6 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-800 transition"
          @click="navigateTo('/login')"
        >
          登录 / 注册
        </button>
      </div>
    </template>
  </div>
</template>
