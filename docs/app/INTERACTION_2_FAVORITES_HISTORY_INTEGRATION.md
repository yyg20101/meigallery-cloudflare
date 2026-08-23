# Interaction-2 收藏夹与浏览历史开发基线

App 版本：1.0

App API：Interaction-2 引入于 v2 / `1.11.0`；本切片最终修订对应累计 `1.21.0`，仓库当前累计为 `1.26.0`

状态：Figma、Cloudflare 与 KMP 开发口径已同步；Interaction-4 已补齐默认关闭的浏览历史到期清理；配置、migration、构建、专项测试、设备截图与远端联调后置

需求追踪：`PRD-FR-040`～`PRD-FR-042`、`SCP-FR-003`、`VIR-FR-030`～`VIR-FR-063`、`APP-INT-03`～`APP-INT-05`

## 1. 本阶段目标

在不启用 production capability、不写入真实收藏或浏览记录、不提前关闭保留期和个性化开放问题的前提下，完成 Interaction-2 服务端开发基线：

- 收藏与喜欢、关注保持独立；收藏使用多文件夹模型，不向 `app_viewer_interactions` 增加临时 `favorite` 类型。
- 提供不可删除的默认收藏位置和 API 层去重聚合能力；同一人物可以进入多个自定义收藏夹。移动端 Figma 不提供独立“全部收藏”卡片。
- 删除自定义收藏夹时，在同一 D1 事务中把其中条目保留到默认收藏，不取消喜欢。
- 自定义收藏夹数量读取稳定 `favorite.folder_count` entitlement；会员降级不删除既有收藏夹或条目，只阻止继续超额创建。
- 浏览历史默认关闭，只有用户明确开启并提交当前设置版本后才记录。
- 清除历史会提升设置版本，使清除前的在途请求不能重新写回；拉黑人物同步清理当前收藏与可见历史，解除后不恢复。
- Interaction-4 已补齐批准后的有界物理清理；能力关闭后仍按每行既有 `expires_at` 履行删除义务。

## 2. 本阶段刻意后置

按照当前开发顺序，本阶段不处理以下工作：

- 不修改 `packages/api/wrangler.toml`，不设置 `APP_INTERACTION_COLLECTIONS_*` 环境值。
- 不执行本地或远端 `0078` migration，不创建 Cloudflare 资源，不部署 Worker。
- 不新增或运行 Interaction-2 专项测试、D1 功能 smoke、KMP UI 回归、模拟器/真机或远端联调。
- 不把开发目录中的 planned entitlement 改成 available，不切换当前会员目录。
- 不配置或启用自动清理；Interaction-4 清理源码已存在，但 OQ-020 未关闭时策略仍为 `unresolved + purge_enabled=0`，调度调用只会安全跳过。
- 不把收藏或浏览历史接入推荐、热度、关注更新、目标侧通知或分析明细。

仓库规范要求的 API TypeScript 和 Nuxt production build 仍属于提交前最小编译门禁，不代表专项测试已经完成。

## 3. 数据结构

`0078_app_favorites_and_view_history.sql` 创建空表和默认关闭的 development 策略；`0096_app_favorite_folder_preserve_default.sql` 增加删除前保留触发器并把当前 development policy 的名称上限收敛为 20，不回填业务数据：

| 表 | 责任 | 关键边界 |
|---|---|---|
| `app_interaction_collection_policies` | 收藏/历史版本化运行策略 | production-ready、保留期、个性化和清理门禁彼此独立 |
| `app_favorite_folders` | 本人默认/自定义收藏夹 | 账号作用域 ID；默认夹唯一；自定义名称归一化去重；单调 version |
| `app_favorite_folder_items` | 文件夹与人物资料关系 | 账号+文件夹+资料唯一；不创建匹配或目标侧关系 |
| `app_view_history_preferences` | 本人记录开关与并发版本 | 默认关闭；mutation token 绑定清除和拉黑联动 |
| `app_profile_view_history` | 本人按人物聚合的浏览历史 | 同一人物单行；最近浏览、次数、最近 view ID 摘要和到期时间 |

策略 `icp_app_1_0_interaction_2_dev_1` 的收藏和历史代码能力可供后续隔离开发配置使用，但 `production_ready=0`、保留期与个性化结论均为 `unresolved`、自动清理关闭。Interaction-4 不把该源码默认 ID 当作删除授权，只有环境显式配置同一策略且保留决策与 purge 门禁完整时才执行。当前名称上限为 20 字，每夹 `500` 项仍只是防御性上限，不是会员销售承诺。

## 4. API 契约

### 4.1 收藏

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT/DELETE | `/api/v2/person-profiles/:profileId/favorite` | 当前收藏状态、加入默认收藏、取消全部收藏 |
| GET | `/api/v2/me/favorites` | 本人收藏去重聚合列表；可选 `query/region/styleTerm` |
| GET | `/api/v2/me/favorite-folders` | 文件夹、去重总数、每夹最多四张当前可用封面、当前自定义夹额度 |
| PUT/PATCH/DELETE | `/api/v2/me/favorite-folders/:folderId` | 客户端随机 ID 幂等创建、版本化编辑、条件删除 |
| GET | `/api/v2/me/favorite-folders/:folderId/items` | 指定文件夹游标分页；可选账号私有搜索、单地区和单风格筛选 |
| PUT/DELETE | `/api/v2/me/favorite-folders/:folderId/items/:profileId` | 幂等加入或移出单个文件夹 |

取消某一文件夹条目不会影响其他文件夹；取消全局收藏才会移除本人该人物的全部文件夹关系。删除自定义收藏夹前，`0096` 触发器使用 `INSERT OR IGNORE` 把条目保留到固定默认收藏，随后级联删除原文件夹条目；响应的 `removedItemCount` 表示原文件夹条目数，兼容字段 `removedGlobalFavoriteCount` 自 `1.21.0` 起固定为 `0`。资料失效后列表只返回稳定 ID、关系时间和不可用原因，不返回历史封面或简介。

列表筛选游标绑定账号、文件夹、归一化搜索词、地区 code 和风格 term ID，任一条件变化都必须从首屏重新分页。地区和风格均为单选；搜索最多 40 字。收藏夹名称业务上限为 20 字，底层 30 字 CHECK 仅为旧 schema 兼容空间，不能作为客户端或 API 可接受上限。

### 4.2 浏览历史

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/v2/me/view-history/settings` | 本人记录开关、并发版本和当前保留权益 |
| POST | `/api/v2/person-profiles/:profileId/view-history` | 详情成功呈现后的显式记录命令 |
| GET | `/api/v2/me/view-history` | 本人未到期历史游标分页 |
| POST | `/api/v2/me/view-history/clear` | 原子清空并使旧版本写请求失效，可同时关闭记录 |
| DELETE | `/api/v2/me/view-history/:profileId` | 幂等删除单条历史并返回新的设置版本 |

记录命令必须提交 `vhv_*` 随机 `viewId` 和 `expectedHistoryVersion`。卡片曝光、页面预取或详情失败不调用该命令。服务端只在资料仍公开、未被当前账号屏蔽、记录开关开启且 `history.retention_days` 为 available/executable 时写入；最近一次同 `viewId` 重试不会重复增加次数。

## 5. 隐私与并发边界

- 所有响应继续使用 `Cache-Control: no-store`，账号 ID 只从 Auth-1 Bearer 会话取得。
- 文件夹 ID、分页游标和历史版本均绑定当前账号作用域；其他账号相同 ID 不产生跨账号访问。
- 历史设置默认虚拟版本为 `1`。首次修改写入版本 `2`；后续修改、清空和拉黑联动均单调提升版本。
- 逐条删除和清空操作都会在同一 D1 batch 中更新偏好 mutation token 并删除目标历史；旧版本记录命令安全冲突，不能把删除前的在途浏览写回。
- 拉黑在原 Message-2 条件批次中删除喜欢/关注、收藏、当前人物历史并提升历史设置版本；解除拉黑不恢复任何旧关系。
- 历史列表同时检查行级 `expires_at` 和当前会员保留窗口：降级可以缩短可见期，升级不会让已过期记录重新出现。
- 每日物理清理按 `expires_at, account_id, profile_id` 稳定顺序有界删除；不修改偏好版本、收藏关系或会员 entitlement，记录 capability 关闭后仍继续履行已经批准的删除义务。
- 收藏夹名称只在业务表和本人响应出现，不进入通用审计、分析或目标侧通知。

## 6. 默认关闭规则

运行时只有同时满足以下条件时才可能在 bootstrap 返回 `favorite=true`、`history=true`：

1. Auth-1 本身安全可用；
2. `APP_INTERACTION_COLLECTIONS_ENABLED=true`；
3. 提供合法的 `APP_INTERACTION_COLLECTIONS_POLICY_VERSION`；
4. production 额外满足独立 production-ready 环境门禁；
5. 请求时 D1 策略存在、状态允许且对应收藏/历史能力开启。

当前没有写入 Wrangler 配置，因此所有现有环境都继续返回 `favorite=false`、`history=false`。代码、migration 和 OpenAPI 的存在不构成启用授权。

## 7. Figma 与 KMP 客户端交付

- Figma 文件 `LaNSwwGsznwcpV8msj7BQC` 是唯一 UI 事实源：`APP-INT-03` 为 `159:67152`、`159:67223`、`159:67304`、`159:67377`；`APP-INT-04` 为 `159:67454`、`159:67524`、`159:67566`；`APP-INT-05` 为 `159:67653`、`159:67737`、`159:67782`、`159:67875`；`APP-INT-06` 为 `894:3616`、`896:3614`、`896:3677`、`896:3740`、`898:3616`、`898:3679`、`898:3746`、`898:3809`、`899:3616`、`899:3681`。新建、失败、管理、重命名、删除与地区/风格筛选支持稿同样具有独立 Node ID；设计缺口必须先补 Figma，禁止在 Compose 中自行发明可见状态。
- `meigallery-client` 当前按累计 `1.21.0` 契约接入 Interaction-2 Domain、严格 DTO/Repository、Bootstrap capability 和 `APP-INT-03/04/05/06` Compose 页面。
- 人物详情收藏与文件夹归属保持独立于喜欢/关注；收藏夹总览/详情覆盖四图预览、额度、幂等创建、失败保稿、删除保留默认收藏、下架占位、搜索/单选筛选和分页。
- `APP-INT-06` 每次选择立即提交但不乐观改勾选状态；服务端成功后刷新收藏状态与文件夹摘要，失败保留旧值并标出失败目标。移出唯一剩余收藏夹必须二次确认，确认后独立显示处理中与已取消收藏结果；资料失效只允许移出现有归属。
- 浏览记录只在详情成功展示后写入；逻辑打开期间保持稳定 `vhv_*`，网络不确定时使用同一 ID 重试，版本冲突后刷新设置但不重放旧事件。
- 逐条删除/清空返回的新版本会同步到当前账号绑定缓存；切换账号不会复用上一账号设置。会员 `required/not_ready` 时不读取列表，降级后的开启状态仍可由用户关闭。
- 历史基线曾通过 Android Debug APK 与 iOS Simulator Kotlin/Native 编译；本次 Figma-first 重构只完成开发和静态差异检查。按当前顺序不执行 Gradle、专项测试、Framework 链接、模拟器/真机、`android-cli` 截图、migration、配置或远端联调。

## 8. 后续开发顺序

1. Interaction-3 服务端关注更新、必要通知投影和 KMP `1.16.0` 累计契约接入均已完成；配置、migration、专项测试、模拟器/真机和远端联调继续与本阶段统一后置，仍不接系统推送。
2. 继续完成 App 1.0 剩余开发模块。
3. 全部开发完成后统一补齐环境配置、目录 available 值、migration、专项测试、KMP 回归、隔离联调和上线门禁。

搜索历史必须随 Discovery 搜索契约独立开发，不能由客户端直接上传自由文本到当前浏览历史接口。推荐信号、Interaction-3 关注更新通知和 Interaction-4 到期清理保持独立策略与门禁，不能从本阶段表结构或清理源码自动推断为已启用。完整生命周期边界见 `docs/app/INTERACTION_4_VIEW_HISTORY_LIFECYCLE_INTEGRATION.md`。
