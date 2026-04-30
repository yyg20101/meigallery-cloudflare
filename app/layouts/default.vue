<script setup lang="ts">
// 默认布局：前台页面使用
</script>

<template>
  <div class="layout-default">
    <header class="site-header">
      <nav class="nav-container">
        <NuxtLink to="/" class="site-logo">
          MeiGallery
        </NuxtLink>
        <div class="nav-links">
          <NuxtLink to="/">首页</NuxtLink>
          <NuxtLink to="/tags">标签</NuxtLink>
        </div>
      </nav>
    </header>

    <main class="site-main">
      <slot />
    </main>

    <footer class="site-footer">
      <p>&copy; {{ new Date().getFullYear() }} MeiGallery</p>
    </footer>
  </div>
</template>

<style scoped>
.layout-default {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.site-header {
  border-bottom: 1px solid #eee;
}

.nav-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.site-logo {
  font-size: 1.25rem;
  font-weight: 700;
  text-decoration: none;
  color: #333;
}

.nav-links {
  display: flex;
  gap: 1.5rem;
}

.nav-links a {
  text-decoration: none;
  color: #666;
}

.nav-links a:hover,
.nav-links a.router-link-active {
  color: #333;
}

.site-main {
  flex: 1;
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 1rem;
  width: 100%;
}

.site-footer {
  border-top: 1px solid #eee;
  text-align: center;
  padding: 1.5rem;
  color: #999;
  font-size: 0.875rem;
}
</style>
