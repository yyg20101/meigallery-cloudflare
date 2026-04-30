# 前端 UI 增强实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有前端页面从基础功能实现升级为符合 UI_DESIGN.md 杂志编排风格的完整视觉体验。

**Architecture:** 在现有 Nuxt 3 + Tailwind CSS + @nuxt/ui 基础上，增强布局/页面/组件的视觉层。不改变数据模型或 API 接口，纯前端视觉和交互增强。

**Tech Stack:** Nuxt 3, Vue 3 Composition API, Tailwind CSS, @nuxt/ui v4

---

## 文件结构概览

需要修改或创建的文件：

```
packages/web/app/
├── layouts/
│   └── default.vue                    # 修改：重新设计导航栏和底部 Tab Bar
├── components/
│   ├── GalleryCard.vue                # 修改：添加角标样式（VIP/SVIP/视频）
│   ├── TagChip.vue                    # 修改：添加选中/可移除状态样式
│   ├── MediaLock.vue                  # 修改：重新设计锁定视觉
│   ├── HomeFeatured.vue               # 新建：首页精选专题区块
│   ├── HomeVideoZone.vue              # 新建：首页视频专区
│   ├── GalleryGrid.vue                # 新建：响应式图库网格容器
│   ├── MembershipCard.vue             # 新建：用户中心会员渐变卡
│   ├── ContactCard.vue                # 新建：联系站长信息卡
│   ├── RelatedGalleries.vue           # 新建：相关推荐组件
│   ├── BreadcrumbNav.vue              # 新建：面包屑导航
│   └── TagFilterTabs.vue              # 新建：标签类型 Tab + 子标签筛选
├── pages/
│   ├── index.vue                      # 修改：添加精选/视频专区/分区块结构
│   ├── discover.vue                   # 新建：发现页（标签筛选）
│   ├── gallery/[slug].vue             # 修改：双栏布局+侧边栏+面包屑
│   ├── user.vue                       # 修改：会员卡片+权益对比+联系站长
│   ├── search.vue                     # 修改：搜索建议+相关标签推荐
│   ├── login.vue                      # 修改：居中卡片式+Turnstile占位
│   └── register.vue                   # 修改：同上
└── middleware/
    ├── auth.ts                        # 修改：激活登录检查
    └── admin.ts                       # 修改：激活管理员检查
```

---

### Task 1: 默认布局增强（导航+底部 Tab Bar）

**Files:**
- Modify: `packages/web/app/layouts/default.vue`

**设计要求：**
- 顶部导航：Logo | 主导航（首页/发现/标签/视频）| 搜索框 | 登录按钮
- 当前路由高亮（下划线）
- 移动端底部 Tab Bar：首页/发现/搜索/我的（4个 Tab，SVG 图标）
- Tab Bar 当前选中项加粗+深色

- [ ] **Step 1: 重写 default.vue 布局**

完整替换导航栏结构：
- 桌面端：Logo + 4个导航链接（首页/发现/标签/视频）+ 搜索输入框 + 用户区
- 移动端顶部：Logo + 搜索图标 + 头像按钮
- 底部 Tab Bar：4 tabs with SVG icons，`activeClass` 用 route path 判断
- 去掉 footer（移动端被 Tab Bar 覆盖，桌面端底部极简 copyright 行）

- [ ] **Step 2: 验证所有路由导航正常**

Run: `pnpm --filter @meigallery/web exec nuxt build`

- [ ] **Step 3: Commit**

```
feat: 重新设计前台默认布局，匹配杂志编排风格
```

---

### Task 2: 新建通用组件

**Files:**
- Create: `packages/web/app/components/HomeFeatured.vue`
- Create: `packages/web/app/components/HomeVideoZone.vue`
- Create: `packages/web/app/components/GalleryGrid.vue`
- Create: `packages/web/app/components/MembershipCard.vue`
- Create: `packages/web/app/components/ContactCard.vue`
- Create: `packages/web/app/components/RelatedGalleries.vue`
- Create: `packages/web/app/components/BreadcrumbNav.vue`
- Create: `packages/web/app/components/TagFilterTabs.vue`
- Modify: `packages/web/app/components/GalleryCard.vue`（角标增强）
- Modify: `packages/web/app/components/MediaLock.vue`（锁定视觉重设计）

组件规格见 docs/UI_DESIGN.md 第 7-8 节。

- [ ] **Step 1: 创建 HomeFeatured.vue**

Props: `galleries: GallerySummary[]` (取前 3 个)
布局：1大2小不对称布局，大图 flex:2 全高，小图 flex:1 垂直等分

- [ ] **Step 2: 创建 HomeVideoZone.vue**

Props: `galleries: GallerySummary[]` (含视频的图库)
布局：暗色调 3 列卡片，播放图标居中，标题覆盖底部

- [ ] **Step 3: 创建 GalleryGrid.vue**

Props: `galleries: GallerySummary[]`
Slot: default (给 GalleryCard)
响应式：2列(mobile) / 3列(tablet) / 4列(desktop)

- [ ] **Step 4: 创建 MembershipCard.vue**

Props: `level: string`, `rank: number`, `expiresAt: string | null`
渐变背景：VIP 金色 / SVIP 紫色 / Free 灰色
显示：等级大字 + 有效期 + 权益描述

- [ ] **Step 5: 创建 ContactCard.vue**

Props: `contacts: { wechat?: string; telegram?: string; email?: string; customNote?: string }`
结构化列表展示，底部提示文案

- [ ] **Step 6: 创建 RelatedGalleries.vue**

Props: `galleries: GallerySummary[]`
桌面端：缩略图+标题+标签 垂直列表
移动端：2列小卡片网格

- [ ] **Step 7: 创建 BreadcrumbNav.vue**

Props: `items: Array<{ label: string; to?: string }>`
最后一项不可点击，前面的项为链接

- [ ] **Step 8: 创建 TagFilterTabs.vue**

Props: `tags: Record<string, TagInfo[]>`, `selected: string[]`
Emits: `toggle(tagSlug)`, `clear`
顶部类型 Tab 切换 + 展开子标签 pill 列表 + 已选 chip 行

- [ ] **Step 9: 增强 GalleryCard.vue**

添加角标：VIP 金色 / SVIP 紫色 / 视频标记(半透明黑底+▶)
位置：右上角绝对定位

- [ ] **Step 10: 重设计 MediaLock.vue**

dashed border + 半透明网格 + 锁定文案 + CTA 按钮
配合 UI_DESIGN.md 第 5.1 节权限提示设计

- [ ] **Step 11: 验证构建**

Run: `pnpm --filter @meigallery/web exec nuxt build`

- [ ] **Step 12: Commit**

```
feat: 新增通用 UI 组件，增强 GalleryCard 和 MediaLock 视觉
```

---

### Task 3: 首页增强

**Files:**
- Modify: `packages/web/app/pages/index.vue`

**设计要求（分区块流式）：**
1. 精选专题（HomeFeatured）— 推荐图库
2. 热门标签 — pill 横向列表
3. 最新图库 — GalleryGrid 4列网格
4. 视频专区（HomeVideoZone）— 含视频图库

- [ ] **Step 1: 重写首页结构**

- 获取数据：galleries（最新24条）、tags、featured（带 featured 标记或取前3条）
- 按区块排列：精选 → 标签 → 最新网格 → 视频专区
- 每个区块有标题 + "查看全部 →" 链接

- [ ] **Step 2: 验证构建**

- [ ] **Step 3: Commit**

```
feat: 首页改为分区块流式布局，添加精选专题和视频专区
```

---

### Task 4: 新增发现页

**Files:**
- Create: `packages/web/app/pages/discover.vue`

**设计要求：**
- TagFilterTabs 标签筛选
- 已选标签彩色 chip + 清除按钮
- 排序选项：最新/最热/随机
- GalleryGrid 展示筛选结果
- 分页

- [ ] **Step 1: 创建 discover.vue 页面**

- URL query 同步：`/discover?region=guangdong&personality=sweet`
- 调用 `/api/galleries` 附带 tag query
- TagFilterTabs 顶部筛选
- 结果网格 + 分页

- [ ] **Step 2: 更新布局导航链接**

在 default.vue 导航中确保"发现"链接指向 `/discover`

- [ ] **Step 3: 验证构建**

- [ ] **Step 4: Commit**

```
feat: 新增发现页，支持标签类型 Tab 组合筛选
```

---

### Task 5: 图库详情页增强

**Files:**
- Modify: `packages/web/app/pages/gallery/[slug].vue`

**设计要求（桌面双栏布局）：**
- 面包屑导航
- 左栏(flex:3)：封面 → 标题/标签/元信息 → 摘要 → 公开图片(3列) → 锁定区 → 视频区
- 右栏(flex:1)：会员引导卡 → ContactCard → RelatedGalleries

- [ ] **Step 1: 重写详情页布局**

- 添加 BreadcrumbNav
- 桌面端 flex 双栏，移动端单栏流式
- 图片区分公开/锁定两部分
- 视频区分预览(免费)/完整(锁定)
- 右栏组件组合

- [ ] **Step 2: 验证构建**

- [ ] **Step 3: Commit**

```
feat: 图库详情页改为双栏布局，添加侧边栏和面包屑
```

---

### Task 6: 用户中心增强

**Files:**
- Modify: `packages/web/app/pages/user.vue`

**设计要求：**
- 用户信息区（头像+昵称+邮箱）
- MembershipCard 渐变会员卡
- 权益对比三栏
- ContactCard 联系站长
- 退出登录

- [ ] **Step 1: 重写用户中心页面**

- [ ] **Step 2: 验证构建**

- [ ] **Step 3: Commit**

```
feat: 用户中心增加会员渐变卡片和权益对比
```

---

### Task 7: 登录/注册页增强 + 搜索页增强

**Files:**
- Modify: `packages/web/app/pages/login.vue`
- Modify: `packages/web/app/pages/register.vue`
- Modify: `packages/web/app/pages/search.vue`

- [ ] **Step 1: 重设计登录页**

居中卡片式，Logo+slogan 顶部，Turnstile 占位区域

- [ ] **Step 2: 重设计注册页**

同上风格，4字段 + Turnstile

- [ ] **Step 3: 搜索页增强**

移动端沉浸式，添加相关标签推荐区域

- [ ] **Step 4: 验证构建**

- [ ] **Step 5: Commit**

```
feat: 登录/注册改为居中卡片式，搜索页添加标签推荐
```

---

### Task 8: 激活中间件守卫

**Files:**
- Modify: `packages/web/app/middleware/auth.ts`
- Modify: `packages/web/app/middleware/admin.ts`

- [ ] **Step 1: 实现 auth 中间件**

检查 useAuth().isLoggedIn，未登录跳转 /login?redirect=当前路径

- [ ] **Step 2: 实现 admin 中间件**

检查 useAuth().isAdmin，非管理员跳转 /

- [ ] **Step 3: 验证构建**

- [ ] **Step 4: Commit**

```
feat: 激活路由中间件守卫，保护用户和管理员页面
```

---

## 执行顺序

Tasks 1-2 可并行（布局和组件独立），3-7 依赖 1-2 的产出需顺序执行，Task 8 最后。

建议分两批：
- 批次 A（并行）：Task 1 + Task 2
- 批次 B（顺序）：Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8
