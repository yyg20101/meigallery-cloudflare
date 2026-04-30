<script setup lang="ts">
// 管理后台布局：CSR 模式，需要 admin 权限
</script>

<template>
  <div class="layout-admin">
    <aside class="admin-sidebar">
      <div class="sidebar-header">
        <NuxtLink to="/admin" class="admin-logo">
          MeiGallery 管理
        </NuxtLink>
      </div>
      <nav class="sidebar-nav">
        <NuxtLink to="/admin" class="nav-item">
          数据概览
        </NuxtLink>
        <NuxtLink to="/admin/galleries" class="nav-item">
          图库管理
        </NuxtLink>
        <NuxtLink to="/admin/tags" class="nav-item">
          标签管理
        </NuxtLink>
        <NuxtLink to="/admin/users" class="nav-item">
          用户管理
        </NuxtLink>
        <NuxtLink to="/admin/import" class="nav-item">
          批量导入
        </NuxtLink>
        <NuxtLink to="/admin/audit-logs" class="nav-item">
          审计日志
        </NuxtLink>
      </nav>
      <div class="sidebar-footer">
        <NuxtLink to="/" class="nav-item">
          返回前台
        </NuxtLink>
      </div>
    </aside>

    <div class="admin-content">
      <header class="admin-header">
        <div class="header-actions">
          <!-- 用户信息和登出按钮将在后续实现 -->
        </div>
      </header>
      <main class="admin-main">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout-admin {
  display: flex;
  min-height: 100vh;
}

.admin-sidebar {
  width: 240px;
  background: #1a1a2e;
  color: #e0e0e0;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.admin-logo {
  color: #fff;
  text-decoration: none;
  font-size: 1.125rem;
  font-weight: 700;
}

.sidebar-nav {
  flex: 1;
  padding: 1rem 0;
}

.nav-item {
  display: block;
  padding: 0.75rem 1.5rem;
  color: #b0b0b0;
  text-decoration: none;
  font-size: 0.9375rem;
  transition: background 0.15s, color 0.15s;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
}

.nav-item.router-link-active {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.sidebar-footer {
  padding: 1rem 0;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.admin-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}

.admin-header {
  padding: 1rem 2rem;
  border-bottom: 1px solid #eee;
  background: #fff;
}

.admin-main {
  flex: 1;
  padding: 2rem;
  background: #f5f5f5;
}
</style>
