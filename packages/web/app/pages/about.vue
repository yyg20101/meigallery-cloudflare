<script setup lang="ts">
const { fetchSettings, aboutTitle, aboutSummary, aboutContent, siteName } = useSiteSettings()

await fetchSettings()

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInlineMarkdown(input: string) {
  return escapeHtml(input)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

function renderMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let listOpen = false

  function closeList() {
    if (listOpen) {
      html.push('</ul>')
      listOpen = false
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      closeList()
      continue
    }
    if (line.startsWith('### ')) {
      closeList()
      html.push(`<h3>${renderInlineMarkdown(line.slice(4))}</h3>`)
      continue
    }
    if (line.startsWith('## ')) {
      closeList()
      html.push(`<h2>${renderInlineMarkdown(line.slice(3))}</h2>`)
      continue
    }
    if (line.startsWith('# ')) {
      closeList()
      html.push(`<h2>${renderInlineMarkdown(line.slice(2))}</h2>`)
      continue
    }
    if (line.startsWith('- ')) {
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push(`<li>${renderInlineMarkdown(line.slice(2))}</li>`)
      continue
    }
    closeList()
    html.push(`<p>${renderInlineMarkdown(line)}</p>`)
  }
  closeList()
  return html.join('\n')
}

const renderedContent = computed(() => renderMarkdown(aboutContent.value))

useHead(() => ({
  title: `${aboutTitle.value} - ${siteName.value}`,
  meta: [
    { name: 'description', content: aboutSummary.value || aboutTitle.value },
    { property: 'og:title', content: `${aboutTitle.value} - ${siteName.value}` },
    { property: 'og:description', content: aboutSummary.value || aboutTitle.value },
  ],
}))
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10 lg:px-8 lg:py-16">
    <div class="relative overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] px-6 py-10 shadow-2xl shadow-orange-950/8 lg:px-12 lg:py-14">
      <div class="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-orange-100/70 blur-3xl" />
      <div class="absolute -bottom-24 -left-20 h-56 w-56 rounded-full bg-stone-100 blur-3xl" />
      <div class="relative">
        <p class="text-xs font-medium uppercase tracking-[0.22em] text-[#bfa46a]">About MeiGallery</p>
        <h1 class="mt-4 text-3xl font-semibold tracking-tight text-gray-950 lg:text-5xl">{{ aboutTitle }}</h1>
        <p v-if="aboutSummary" class="mt-5 max-w-2xl text-sm leading-7 text-gray-600 lg:text-base">
          {{ aboutSummary }}
        </p>
      </div>
    </div>

    <article class="about-content mt-8 rounded-[1.5rem] border border-[#f0e4d8] bg-white/90 px-6 py-8 shadow-sm shadow-orange-950/5 lg:px-10 lg:py-10" v-html="renderedContent" />
  </div>
</template>

<style scoped>
.about-content :deep(h2) {
  margin-top: 2rem;
  margin-bottom: 0.75rem;
  font-size: 1.25rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #111827;
}

.about-content :deep(h2:first-child) {
  margin-top: 0;
}

.about-content :deep(h3) {
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  font-size: 1rem;
  font-weight: 650;
  color: #1f2937;
}

.about-content :deep(p),
.about-content :deep(li) {
  font-size: 0.9375rem;
  line-height: 1.9;
  color: #4b5563;
}

.about-content :deep(p + p) {
  margin-top: 1rem;
}

.about-content :deep(ul) {
  margin: 0.75rem 0 1.25rem;
  padding-left: 1.25rem;
  list-style: disc;
}

.about-content :deep(a) {
  color: #111827;
  text-decoration: underline;
  text-decoration-color: #d6c39a;
  text-underline-offset: 4px;
}

.about-content :deep(strong) {
  color: #111827;
  font-weight: 650;
}
</style>
