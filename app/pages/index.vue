<script setup lang="ts">
// 首页：展示最新图库
useHead({
  title: 'MeiGallery - 精选写真图库',
  meta: [
    { name: 'description', content: '精选写真、时尚、生活、艺术类图库平台' },
  ],
})
</script>

<template>
  <div class="home-page">
    <section class="hero">
      <h1>MeiGallery</h1>
      <p>精选写真 · 时尚 · 生活 · 艺术</p>
    </section>

    <section class="gallery-grid">
      <p class="placeholder">图库列表即将呈现...</p>
    </section>
  </div>
</template>

<style scoped>
.hero {
  text-align: center;
  padding: 4rem 1rem;
}

.hero h1 {
  font-size: 2.5rem;
  color: #333;
  margin-bottom: 0.5rem;
}

.hero p {
  font-size: 1.125rem;
  color: #666;
}

.placeholder {
  text-align: center;
  color: #999;
  padding: 4rem;
}
</style>
