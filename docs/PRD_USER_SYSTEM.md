# PRD: 用户体系增强 — 用户名登录、邮箱验证开关、后台用户管理、个人设置

> 版本: 1.0 | 日期: 2026-04-30 | 状态: 草案，多数用户体系增强已落地；当前生产状态以 `docs/PROJECT_STATUS.md` 为准。

---

## 1. 执行摘要

### 问题陈述

1. **注册无用户名**：当前 `users` 表仅有 `nickname`（可选），用户登录只能通过邮箱。缺少唯一标识的用户名，不利于社区互动和运营。
2. **邮箱验证无法关闭**：上一版已实现邮箱验证码注册，但 Cloudflare Email Service 尚未配置（需升级 Workers Paid），注册流程被阻断。需要后台开关控制是否启用邮箱验证。
3. **后台用户管理单薄**：现有管理后台只能查看用户列表和发放会员，缺少编辑用户信息、重置密码、查看活动日志等基础管理能力。
4. **无个人设置页**：用户无法修改自己的用户名、密码、头像、通知偏好，也看不到会员状态。

### 解决方案

1. `users` 表新增 `username` 列（唯一，仅英文+数字，3-20 字符），注册时强制填写；登录支持用户名或邮箱。
2. `site_settings` 新增 `email_verification_enabled` 开关，后台可配置；关闭时注册跳过验证码步骤。
3. 完善后台用户详情页：编辑基本信息、重置密码、禁用/启用、会员管理、活动日志。
4. 新建前台 `/settings` 个人设置页：修改用户名、修改密码、上传头像（R2）、通知偏好、会员信息展示、修改邮箱。

当前实现备注：用户名注册/登录、邮箱验证开关、后台用户编辑/重置密码/活动日志、个人设置页、头像上传、通知偏好和邮箱修改 API 已实现；后续仍需按真实运营继续补齐更细粒度的前端验收和邮件服务配置验收。

### 成功指标

| 指标 | 目标 |
|------|------|
| 注册完成率（无邮件服务时） | 不因邮箱验证阻断，验证关闭时 >= 95% 完成 |
| 用户名唯一性冲突率 | < 5%（前端实时检查 + 建议） |
| 后台用户管理操作覆盖率 | 6 项操作全部可用（编辑信息、重置密码、角色、状态、会员、日志） |
| 个人设置页各功能可用率 | 6 项设置全部可操作（用户名、密码、头像、通知、会员、邮箱） |
| 头像上传成功率 | >= 98%（2MB 限制内） |

---

## 2. 用户体验 & 功能需求

### 2.1 用户角色

| 角色 | 描述 |
|------|------|
| 管理员（Owner/Admin） | 后台管理用户、配置站点设置 |
| 普通用户 | 注册、浏览图库、管理个人资料 |

### 2.2 功能 A：用户名系统 & 登录改造

#### 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| A1 | 作为新用户，注册时我必须填写用户名 | - 用户名为必填字段<br>- 仅允许英文字母和数字，3-20 字符<br>- 不区分大小写存储（统一小写）<br>- 唯一性校验，输入时实时检查<br>- 不允许使用保留词（admin、root、system 等） |
| A2 | 作为已注册用户，我可以用用户名或邮箱登录 | - 登录表单标签改为"用户名 / 邮箱"<br>- 后端自动判断输入是邮箱还是用户名<br>- 两种方式使用同一个输入框 |
| A3 | 作为管理员（admin@616618.xyz），我在迁移后需要有一个默认用户名 | - migration 为现有 admin 用户设置 `username = 'admin'`<br>- 现有无用户名的用户（如有）标记需要补充 |

#### 数据库变更

```sql
-- users 表新增列
ALTER TABLE users ADD COLUMN username TEXT;
-- 设置唯一索引（允许 NULL 是因为 ALTER TABLE 不支持 NOT NULL 新列无默认值）
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
-- 为 admin 设置默认用户名
UPDATE users SET username = 'admin' WHERE email = 'admin@616618.xyz';
```

#### API 变更

| 接口 | 变更 |
|------|------|
| `POST /api/auth/register` | 新增 `username` 必填参数；校验格式和唯一性 |
| `POST /api/auth/login` | `email` 字段改为接受用户名或邮箱，后端自动判断 |
| `GET /api/auth/check-username/:username` | **新增** — 实时检查用户名是否可用 |
| `GET /api/me` | 返回值新增 `username` 字段 |

#### 登录逻辑

```typescript
// 判断输入是邮箱还是用户名
const isEmail = identifier.includes('@')
const user = isEmail
  ? await db.prepare('SELECT ... FROM users WHERE email = ?').bind(identifier).first()
  : await db.prepare('SELECT ... FROM users WHERE username = ?').bind(identifier.toLowerCase()).first()
```

#### 保留用户名列表

```
admin, root, system, support, noreply, api, www, mail, help, info,
meigallery, owner, moderator, mod, staff, test, null, undefined
```

### 2.3 功能 B：邮箱验证开关

#### 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| B1 | 作为管理员，我可以在后台设置中开关邮箱验证 | - `site_settings` 新增 `email_verification_enabled` 键<br>- 后台设置页显示开关<br>- 默认值 `false`（关闭）<br>- 切换后立即生效 |
| B2 | 作为新用户，当邮箱验证关闭时，我填完信息直接注册 | - 注册流程跳过验证码步骤<br>- `email_verified` 设为 `0`（未验证）<br>- 后续管理员开启验证后，新注册用户需要验证 |
| B3 | 作为新用户，当邮箱验证开启时，走完整的验证码流程 | - 与现有两步式注册流程一致<br>- `email_verified` 设为 `1` |

#### 注册流程判断

```
前端加载时 → GET /api/settings/public（返回 email_verification_enabled）
  ├─ false → 一步式注册（用户名+邮箱+密码 → 直接注册）
  └─ true  → 两步式注册（填写信息 → 发送验证码 → 输入验证码 → 注册）
```

#### API 变更

| 接口 | 变更 |
|------|------|
| `GET /api/settings/public` | 返回值新增 `email_verification_enabled`（布尔） |
| `POST /api/auth/register` | 当 `email_verification_enabled = false` 时，`code` 字段非必填 |
| `POST /api/auth/send-code` | 当 `email_verification_enabled = false` 时，返回 400 提示验证已关闭 |

#### 数据库变更

```sql
-- site_settings 新增配置项
INSERT OR IGNORE INTO site_settings (key, value) VALUES ('email_verification_enabled', '"false"');
```

### 2.4 功能 C：后台用户管理增强

#### 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| C1 | 作为管理员，我在用户列表中能看到用户名列 | - 列表新增"用户名"列<br>- 搜索支持用户名匹配 |
| C2 | 作为管理员，我能编辑用户的基本信息 | - 可修改：用户名、邮箱、角色<br>- 用户名修改需校验唯一性<br>- 邮箱修改直接生效（管理员操作不需要邮箱验证）<br>- 写审计日志 |
| C3 | 作为管理员，我能为用户重置密码 | - 输入新密码（>= 8 位）<br>- 重置后清除该用户所有 session<br>- 写审计日志 |
| C4 | 作为管理员，我能查看用户的活动日志 | - 展示该用户相关的审计日志<br>- 展示用户最近的 session 记录（登录时间） |

#### API 新增/变更

| 接口 | 方法 | 说明 |
|------|------|------|
| `PATCH /api/admin/users/:id` | PATCH | **新增** — 编辑用户信息（username, email, role） |
| `POST /api/admin/users/:id/reset-password` | POST | **新增** — 管理员重置用户密码 |
| `GET /api/admin/users/:id/activity` | GET | **新增** — 获取用户活动日志 |
| `GET /api/admin/users` | GET | 变更 — 返回值和搜索新增 username |
| `GET /api/admin/users/:id` | GET | 变更 — 返回值新增 username, avatar_url |

#### 活动日志查询

```sql
-- 审计日志中与该用户相关的记录
SELECT * FROM admin_audit_logs
WHERE target_type = 'user' AND target_id = ?
   OR target_type = 'user_membership' AND JSON_EXTRACT(after_value, '$.userId') = ?
ORDER BY created_at DESC LIMIT 50;

-- 最近登录（session 记录）
SELECT id, created_at FROM sessions
WHERE user_id = ? ORDER BY created_at DESC LIMIT 20;  -- user_id 为 INTEGER 类型
```

### 2.5 功能 D：个人设置页

#### 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| D1 | 作为用户，我在 `/settings` 页面看到我的个人信息 | - 展示用户名、邮箱、头像、注册时间<br>- 会员等级和到期时间<br>- 需要登录才能访问 |
| D2 | 作为用户，我可以修改用户名 | - 输入新用户名，实时检查可用性<br>- 提交后立即生效<br>- 同一格式限制（英文+数字，3-20） |
| D3 | 作为用户，我可以修改密码 | - 输入旧密码 + 新密码 + 确认新密码<br>- 旧密码错误返回提示<br>- 成功后清除其他 session，保留当前 |
| D4 | 作为用户，我可以上传/更换头像 | - 点击头像区域选择图片<br>- 支持 JPG/PNG/WebP，最大 2MB<br>- 上传后服务端存入 R2，key 格式 `avatars/{userId}.{ext}`<br>- 返回头像 URL，更新用户记录 |
| D5 | 作为用户，我可以开关新图库通知 | - 开关控件，关闭后不再收到新图库发布邮件<br>- 状态存入 `users.notification_enabled` |
| D6 | 作为用户，我可以查看会员信息 | - 只读展示当前等级（免费/VIP/SVIP）<br>- 到期时间<br>- 提示"如需续费请联系站长" |
| D7 | 作为用户，我可以修改绑定邮箱 | - 输入新邮箱 + 密码确认<br>- 如果邮箱验证开启，需要向新邮箱发送验证码<br>- 如果邮箱验证关闭，直接修改<br>- 新邮箱不能与已有用户冲突 |

#### API 新增

| 接口 | 方法 | 说明 |
|------|------|------|
| `GET /api/me` | GET | 变更 — 返回 username, avatarUrl, notificationEnabled |
| `PATCH /api/me/profile` | PATCH | **新增** — 修改用户名 |
| `PATCH /api/me/password` | PATCH | **新增** — 修改密码（旧密码+新密码） |
| `POST /api/me/avatar` | POST | **新增** — 上传头像（multipart/form-data） |
| `PATCH /api/me/notifications` | PATCH | **新增** — 修改通知偏好 |
| `PATCH /api/me/email` | PATCH | **新增** — 修改邮箱 |
| `POST /api/me/email/verify` | POST | **新增** — 验证新邮箱验证码 |

#### 头像上传流程

```
前端：选择图片 → 校验格式/大小 → POST /api/me/avatar (FormData)
后端：
  1. 验证文件格式（image/jpeg, image/png, image/webp）和大小（<= 2MB）
  2. 生成 R2 key：avatars/{userId}.{ext}
  3. 上传到 R2（覆盖旧头像）
  4. 更新 users.avatar_key
  5. 返回公开访问 URL
```

#### 数据库变更

```sql
-- users 表新增头像列
ALTER TABLE users ADD COLUMN avatar_key TEXT;
```

#### 页面布局

```
/settings
├── 头像 + 用户名 + 邮箱（概览卡片）
├── 个人信息区域
│   ├── 修改用户名（内联编辑）
│   └── 修改邮箱（内联编辑 + 验证码）
├── 安全设置
│   └── 修改密码（展开式表单）
├── 通知设置
│   └── 新图库通知开关
└── 会员信息
    ├── 当前等级 + 到期时间
    └── 续费提示
```

### 2.6 非目标（Not Goals）

- 不实现社交登录（OAuth、微信扫码等）
- 不实现用户头像裁剪编辑器（直接上传原图，服务端不做裁剪）
- 不实现用户间私信或评论系统
- 不实现两步验证（2FA / TOTP）
- 不实现用户注销（删除账号）功能

---

## 3. 技术规格

### 3.1 数据库变更汇总

新增 D1 migration `0006_username_avatar.sql`：

```sql
-- 用户名（唯一，英文+数字，3-20 字符）
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- 头像 R2 key
ALTER TABLE users ADD COLUMN avatar_key TEXT;

-- 现有 admin 用户设置默认用户名
UPDATE users SET username = 'admin' WHERE email = 'admin@616618.xyz';

-- 邮箱验证开关（默认关闭）
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES ('email_verification_enabled', '"false"', datetime('now'));
```

### 3.2 `users` 表最终结构

| 列 | 类型 | 说明 | 来源 |
|----|------|------|------|
| id | INTEGER PK AUTOINCREMENT | （通过 migration 0007 从 TEXT 迁移） | 0001/0007 |
| email | TEXT NOT NULL UNIQUE | | 0001 |
| **username** | TEXT UNIQUE | 英文+数字，3-20 字符 | **0006 新增** |
| nickname | TEXT | 保留兼容，但新用户不再使用 | 0001 |
| password_hash | TEXT NOT NULL | | 0001 |
| role | TEXT NOT NULL DEFAULT 'user' | | 0001 |
| status | TEXT NOT NULL DEFAULT 'active' | | 0001 |
| email_verified | INTEGER DEFAULT 0 | | 0005 |
| notification_enabled | INTEGER DEFAULT 1 | | 0005 |
| **avatar_key** | TEXT | R2 对象 key | **0006 新增** |
| created_at | TEXT | | 0001 |
| updated_at | TEXT | | 0001 |

### 3.3 头像存储

- **R2 key 格式**: `avatars/{userId}.{ext}`（ext 根据 MIME 推断：jpg/png/webp）
- **大小限制**: 2MB（Workers 请求体限制 100MB，R2 put 限制 5GB，2MB 足够）
- **访问方式**: 通过已有的媒体签名 URL 机制，或直接公开（头像不需要权限控制）
- **覆盖策略**: 同一用户只保留最新头像，上传新头像自动覆盖旧 key

### 3.4 用户名校验规则

```typescript
const USERNAME_REGEX = /^[a-z0-9]{3,20}$/
const RESERVED_USERNAMES = new Set([
  'admin', 'root', 'system', 'support', 'noreply', 'api', 'www',
  'mail', 'help', 'info', 'meigallery', 'owner', 'moderator', 'mod',
  'staff', 'test', 'null', 'undefined',
])

function validateUsername(username: string): { valid: boolean; error?: string } {
  const normalized = username.toLowerCase()
  if (!USERNAME_REGEX.test(normalized)) {
    return { valid: false, error: '用户名只允许英文字母和数字，3-20 字符' }
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return { valid: false, error: '该用户名为系统保留' }
  }
  return { valid: true }
}
```

### 3.5 后台设置页扩展

`ALLOWED_KEYS` 数组新增 `'email_verification_enabled'`，后台设置页新增开关组件。

### 3.6 安全考虑

| 场景 | 措施 |
|------|------|
| 用户名枚举 | `GET /api/auth/check-username/:username` 有速率限制（10次/分钟/IP） |
| 头像上传恶意文件 | 服务端校验 Content-Type 白名单 + 文件头 magic bytes |
| 管理员重置密码 | 仅 Admin/Owner 可操作；Owner 不可被重置；写审计日志 |
| 修改邮箱 | 需要输入当前密码确认身份；邮箱验证开启时需验证新邮箱 |
| 修改密码 | 需要输入旧密码；成功后清除其他 session |

---

## 4. 风险 & 路线图

### 4.1 分阶段实施

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **Step 1** | D1 migration + 用户名系统（注册/登录改造）+ 邮箱验证开关 | P0 — 解除注册阻断 |
| **Step 2** | 后台用户管理增强（编辑、重置密码、活动日志） | P0 — 管理基础 |
| **Step 3** | 个人设置页（用户名、密码、通知、会员展示） | P1 |
| **Step 4** | 头像上传 + 修改邮箱 | P1 |

### 4.2 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 现有用户无 username | admin 用户迁移后无法用用户名登录 | migration 为 admin 设置 `username = 'admin'` |
| 头像上传大文件 | Workers CPU 时间超限 | 前端预校验 2MB 限制 + R2 直传 |
| `nickname` 与 `username` 并存 | 前端展示混乱 | 优先展示 username，nickname 保留但不再在新注册中使用 |
| 用户名不区分大小写 | 大小写变体冲突 | 统一存储为小写，查询时 LOWER() 比较 |

### 4.3 依赖项

- **Step 1-3**：无外部依赖，当前架构即可实现
- **Step 4 头像上传**：R2 已配置，直接可用
- **Step 4 修改邮箱**：依赖邮箱验证开关状态（开启时需要 Email Service）
