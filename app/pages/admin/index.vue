<script setup lang="ts">
// 管理后台首页：数据概览
definePageMeta({
  layout: 'admin',
})

useHead({
  title: '管理后台 - MeiGallery',
})
</script>

<template>
  <div class="admin-dashboard">
    <h1>数据概览</h1>
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">图库总数</span>
        <span class="stat-value">-</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">已发布</span>
        <span class="stat-value">-</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">注册用户</span>
        <span class="stat-value">-</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">VIP 会员</span>
        <span class="stat-value">-</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin-dashboard h1 {
  font-size: 1.5rem;
  color: #333;
  margin-bottom: 1.5rem;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.stat-card {
  background: #fff;
  border-radius: 0.5rem;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.stat-label {
  font-size: 0.875rem;
  color: #666;
}

.stat-value {
  font-size: 2rem;
  font-weight: 700;
  color: #333;
}
</style>
