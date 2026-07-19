---
title: "ADR-0001: 使用 KMP 与 Compose Multiplatform 构建跨平台用户客户端"
version: "1.0"
status: "Accepted"
product_status: "需求讨论中"
date: "2026-07-20"
authors: "项目 Owner、产品负责人、客户端架构负责人"
tags: ["architecture", "decision", "kmp", "compose-multiplatform", "client"]
---

# ADR-0001: 使用 KMP 与 Compose Multiplatform 构建跨平台用户客户端

## Status

Proposed | **Accepted** | Rejected | Superseded | Deprecated

用户于 2026-07-20 确认采用 KMP 方向，并把面向普通用户的桌面客户端纳入长期产品范围。本决定在创建客户端工程前生效。

## Context

独立真人发现与互动 App 首期需要覆盖 Android 和 iOS，后续需要提供面向普通用户的 Windows 和 macOS 客户端。客户端要承载登录、真人发现、单向互动、会员私信、安全中心、会员和金币等一致业务，同时接入商店支付、推送、媒体、安全存储和桌面系统能力。

现有 MeiGallery 是 Nuxt、Hono 和 TypeScript 组成的 pnpm monorepo。共享平台后端继续运行在 Cloudflare Workers，现有 Web 和管理后台仍适合使用 Nuxt。客户端选型不能要求后端改写，也不能把 TypeScript 源码复用误当成跨语言数据契约。

截至本决定日期，Kotlin Multiplatform 核心以及 Compose Multiplatform 的 Android、iOS 和 Desktop（JVM）目标均为 Stable。Web UI 目标仍为 Beta，因此本决定不使用 Compose Multiplatform 替换 Nuxt Web。

## Decision

- **DEC-001**：用户客户端采用 Kotlin Multiplatform（KMP）和 Compose Multiplatform，以 Kotlin 作为客户端主要开发语言。
- **DEC-002**：Android 和 iOS 是 M1/M2 首发目标；Windows 和 macOS 是 M4 的面向用户桌面目标；Linux 不纳入当前产品路线。
- **DEC-003**：领域模型、用例、API、WebSocket、状态管理、缓存策略、错误映射、设计 token 和大部分业务 UI 默认放入共享代码。
- **DEC-004**：StoreKit、Google Play Billing、推送、相机/相册、定位、生物识别、安全存储、深链、桌面通知、窗口、菜单、签名和更新使用平台适配层，不追求百分之百源码共享。
- **DEC-005**：现有 Hono/Cloudflare 后端、Nuxt 公共 Web 和 Nuxt 管理后台保持不变；KMP 只改变用户客户端技术路线。
- **DEC-006**：OpenAPI、JSON Schema 和 WebSocket event schema 是跨语言唯一契约来源，分别生成或校验 Kotlin 与 TypeScript 模型；`@meigallery/shared` 不再被定义为 KMP 可直接复用的源码。
- **DEC-007**：移动发布稳定后再开放桌面端，桌面端不得绕过账号安全、内容治理、权益、地区门禁或支付合规规则。

## Consequences

### Positive

- **POS-001**：Android、iOS、Windows 和 macOS 可以共享业务核心和大部分 UI，降低长期功能分叉概率。
- **POS-002**：桌面端直接复用发现、互动、会员私信、安全和契约测试，而不是另建一套桌面业务核心。
- **POS-003**：平台适配层允许在 iOS/Android/桌面使用原生 SDK、原生安全存储和系统分发能力。
- **POS-004**：契约优先取代语言源码耦合，使现有 Web、后端和未来客户端能够独立发布与迁移。

### Negative

- **NEG-001**：团队需要具备 Kotlin、Gradle、Xcode、Swift/Objective-C interop 和桌面打包签名能力，初期工程门槛高于单一 TypeScript 栈。
- **NEG-002**：部分第三方 SDK 没有成熟的 KMP 封装，需要维护平台实现和 `expect`/`actual` 或接口适配代码。
- **NEG-003**：iOS 原生行为、桌面交互和无障碍不能仅靠共享 UI 测试证明，仍需分平台验收。
- **NEG-004**：Kotlin、Compose Multiplatform、Gradle、Android Gradle Plugin 和 Xcode 存在兼容矩阵，升级必须经过专门验证。
- **NEG-005**：客户端无法直接导入现有 TypeScript 类型，需要建设契约生成、变更检查和双语言发布流程。

## Alternatives Considered

### React Native + TypeScript

- **ALT-001**：**Description**：移动端使用 React Native，共享现有 TypeScript 类型；Windows 和 macOS 使用各自的 React Native 扩展。
- **ALT-002**：**Rejection Reason**：移动端启动较快，但 Windows 和 macOS 属于独立扩展和发布链，长期桌面目标会增加平台版本、组件兼容与原生模块分叉。

### KMP 共享逻辑 + 完全原生 UI

- **ALT-003**：**Description**：共享领域、网络和缓存，Android 使用 Jetpack Compose、iOS 使用 SwiftUI、桌面单独实现 UI。
- **ALT-004**：**Rejection Reason**：原生控制力最强，但同一产品需要维护三套页面和状态矩阵，不符合当前团队希望为桌面端复用 UI 的目标。平台高风险页面仍可按例外采用此模式。

### Flutter 全平台客户端

- **ALT-005**：**Description**：使用 Dart 和 Flutter 覆盖移动端与桌面端。
- **ALT-006**：**Rejection Reason**：同样能覆盖多平台，但会新增 Dart 技术栈；KMP 更容易按模块保留原生 UI/SDK，并允许从共享业务层逐步扩大到共享 UI。

## Implementation Notes

- **IMP-001**：客户端建议位于独立 Gradle 根目录 `clients/app-kmp/`，不伪装成 pnpm package；pnpm 与 Gradle 在仓库级 CI 中编排。
- **IMP-002**：工程启动前完成技术验证：登录与令牌轮换、WebSocket 断线补拉、媒体选择、安全存储、推送、StoreKit/Play Billing sandbox、Windows/macOS 打包签名和无障碍。
- **IMP-003**：共享模块采用端口与适配器边界；任何直接调用平台 API 的实现只能进入对应平台 source set。
- **IMP-004**：版本锁定时同时记录 Kotlin、Compose Multiplatform、Gradle、Android Gradle Plugin、JDK、Xcode 和最低操作系统版本，并通过依赖更新验证任务统一升级。
- **IMP-005**：CI 至少包含共享单元测试、Android 构建、iOS 模拟器构建、macOS 构建和 Windows 构建；商店签名、notarization 和发布在受保护环境执行。
- **IMP-006**：以共享业务逻辑覆盖率、各目标构建通过率、UI 例外数量、平台缺陷率、启动性能和无障碍结果衡量方案，不以单一“代码共享百分比”作为成功指标。

## References

- **REF-001**：[Kotlin Multiplatform 支持平台与稳定性](https://kotlinlang.org/docs/multiplatform/supported-platforms.html)
- **REF-002**：[Google 的 Kotlin Multiplatform 指南](https://developer.android.com/kotlin/multiplatform)
- **REF-003**：[Compose Multiplatform 与 Jetpack Compose 的关系](https://kotlinlang.org/docs/multiplatform/compose-multiplatform-and-jetpack-compose.html)
- **REF-004**：[React Native Windows](https://microsoft.github.io/react-native-windows/)
- **REF-005**：[React Native macOS](https://microsoft.github.io/react-native-macos/docs/intro)
- **REF-006**：[真人发现与互动 App 技术架构](../app/TECHNICAL_ARCHITECTURE.md)
- **REF-007**：[客户端方向与开放问题](../app/DECISIONS_AND_OPEN_QUESTIONS.md)
