# 通用广告归因架构

## 文档状态

- 当前生产实现：统一事实与平台 Adapter 仍运行在 Web/API Worker 和主 D1 中。
- 已确认目标架构：独立 Attribution Worker、独立 D1/Queue、不可变候选版本和零中断激活。
- 唯一目标设计：`docs/superpowers/specs/2026-07-24-attribution-runtime-isolation-design.md`。
- 目标架构完成前，不得把本文描述误写为“已上线”。

## 不可违反的原则

1. 站内业务只创建一次 `Contact` 或 `CompleteRegistration` 事实。
2. 一条事实最多归属一个 provider 和一个 connection。
3. Meta、TikTok、Google 以及同平台不同团队之间禁止广播、猜测或交叉投递。
4. Pixel ID、Token 和事件映射保存为候选版本；验证成功后自动原子切换。
5. 候选失败时当前 Active 版本继续运行。
6. 启停、Browser 开关和 Server rollout 独立于身份配置。
7. Git commit 不参与验证、激活、放量、停用或回滚。
8. 归因运行时独立部署，其他模块发布不得修改归因配置或运行状态。
9. 新平台只能通过统一 Adapter 契约接入。
10. 最终切换后删除旧运行代码、旧表和永久兼容路径。

## 目标数据流

```text
业务动作
  -> Canonical Event Contract
  -> Attribution Worker
  -> 可信来源与唯一 connection
  -> 转化事实
  -> Browser Instruction + Server Outbox
  -> 唯一 Provider Adapter
  -> 广告平台
```

## 目标配置流

```text
保存身份配置
  -> candidate
  -> validating
  -> ready
  -> D1 原子切换 active_version_id
  -> 旧版本 retired

验证失败
  -> failed
  -> 当前 Active 不变
```

## 当前实施约束

- 新实现必须以目标设计文档为依据，不在现有连接保存流程继续追加局部补丁。
- 迁移前保持当前 production Active 配置不变。
- 迁移必须保留稳定 connection/source ID 和签名契约，避免现有投放链接失效。
- 旧实现只作为迁移输入和事故证据，不作为目标架构的兼容层。
