# Recommendation-4 可执行规则选择与依赖降级开发基线

日期：2026-08-20

状态：源码开发完成；配置、migration 执行、构建、专项测试与环境验证统一后置

## 1. 结论

Recommendation-4 把“状态、时间、地区和客户端版本兼容”进一步收敛为“完整可执行”。服务端现在会按 `scheduled → active → 显式历史回退` 的优先级依次验证规则结构、渠道、taxonomy、heatVersion 和 production-ready 依赖；高优先规则失效时继续选择下一条安全完整版本，而不是在已选中后直接中断。

本增量不新增请求/响应字段、D1 表、配置项或页面，交付时累计 App API v2 契约为 `1.25.0`；Membership-7 后仓库当前累计为 `1.26.0`。Figma 仍为 99 个 Page ID / 408 个正式状态，Mobile 50/208、Admin 49/200。

## 2. 已修复的缺口

Recommendation-2/3 已让规则按客户端版本和地区作用域选择，但此前候选选择仍只读取少数字段。若到点排期出现以下问题，服务端可能选中后才失败：

- 权重、理由或 App 渠道配置无效；
- 个性化 taxonomy 目录失效、尚未生效或未通过 production-ready；
- heat 权重大于零但 heatVersion 已不可用；
- 个性化新目录排期与账号仍保存的旧目录偏好不兼容。

这些异常不应覆盖仍可执行的 active 或明确历史回退，也不应让 bootstrap 宣称一个实际无法读取的推荐 capability。

## 3. 完整候选选择

每个新请求先形成有序兼容候选：

1. 已到生效时间的 scheduled；
2. 当前 active；
3. 上述候选明确登记且已生效过的历史回退。

服务端先按地区、客户端版本和个性化 taxonomy 目录筛选，再逐条加载完整不可变规则并校验：

- 五项权重与模式约束；
- 理由映射和固定 App 渠道；
- 地区作用域格式；
- 个性化 taxonomy 目录状态、生效时间和 production-ready；
- heatVersion 状态与 production-ready；
- 规则本身的环境门禁和有效期。

某条候选因业务配置或依赖门禁不可执行时，只跳过该候选；D1 或未知基础设施错误不会被吞掉。全部候选不可用时返回明确未就绪/维护状态，不放宽公开人物资格。

## 4. 个性化目录兼容

个性化规则选择现在绑定账号当前偏好的不可变 `taxonomyCatalogId`：

- 新目录 scheduled 不会覆盖仍使用旧目录偏好的账号；
- 旧目录 active 仍有效时可继续完成该账号的新推荐会话；
- 没有同目录且完整可执行的规则时，`auto` 使用既有 `PERSONALIZATION_NOT_READY` 回落到非个性化；
- 个性化会话分桶选出的历史回退若在运行期失去依赖或目录兼容，`auto` 也会重新建立非个性化执行上下文；
- 显式 `personalized` 请求仍明确拒绝，不把其他目录词条映射或猜测为当前偏好；
- 偏好 GET/PUT 的 `effectivePersonalizationEnabled` 只在同目录可执行规则存在时为 true。

## 5. Bootstrap capability

bootstrap 在既有策略、版本与地区格式探测后，会再次执行完整规则校验：

- 没有完整可执行的非个性化规则时，推荐域 capability 全部安全关闭；
- `activeRuleVersionId` 指向实际通过完整校验的非个性化版本；
- 个性化 capability 还要求至少存在一个完整可执行的个性化版本；
- capability 探测不绑定具体地区或账号 taxonomy，具体请求仍按自身上下文重新选择。

## 6. UI 与 Figma 边界

本增量只修正规则选择和 capability 真值。`APP-DSC-01` 已有通用/智能推荐、fallback 和维护状态，`ADM-REC-01/02/03/04` 已有依赖诊断与校验错误，不需要新增页面、字段或视觉状态，因此未调用 Figma 工具。

KMP 不解析运营规则，也不需要 DTO 改动；它继续以服务端返回的实际模式、fallbackReason 和 ruleVersionId 为权威。

## 7. 明确后置

本增量不启用 OQ-009 热度计算、OQ-020 证据/跨会话频控、OQ-023 新个性化信号、指标反指标或自动停止阈值。当前规则只有排序权重和理由映射，候选集合统一由“公开资格 + 请求地区”决定；若该集合在运行期为空，任何兼容历史规则面对的也是同一空集合，因此服务端返回显式空结果，不能用跨规则切换伪造内容。Dry-run 会阻断一开始就无候选的规则启用。只有未来引入规则专属候选过滤器时，才需把“结果为空后切换旧规则”作为独立能力设计。

按当前顺序，本阶段未运行构建、测试、migration、模拟器/真机或截图 QA。统一验证需覆盖失效 scheduled + 可用 active、失效 active + 可用历史回退、taxonomy 目录切换、heatVersion 失效、非法渠道/权重，以及 bootstrap 与直接请求的一致性。
