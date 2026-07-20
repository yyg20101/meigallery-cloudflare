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

用户于 2026-07-20 确认采用 KMP 方向。App 1.0 只发布 Android/iOS；普通用户桌面客户端不再作为已承诺范围，未来按真实需求独立立项。本决定在创建客户端工程前生效。

## Context

独立真人发现与互动 App 首期覆盖 Android 和 iOS，承载登录、真人发现、单向互动、会员私信、安全中心、五级会员、金币明细和站内通知。App 1.0 不接入商店支付和系统推送；普通用户 Windows/macOS 客户端是否需要由未来独立决策确定，当前桌面运营由 Nuxt 管理后台承担。

现有 MeiGallery 是 Nuxt、Hono 和 TypeScript 组成的 pnpm monorepo。共享平台后端继续运行在 Cloudflare Workers，现有 Web 和管理后台仍适合使用 Nuxt。客户端选型不能要求后端改写，也不能把 TypeScript 源码复用误当成跨语言数据契约。

截至本决定日期，Kotlin Multiplatform 核心以及 Compose Multiplatform 的 Android、iOS 和 Desktop（JVM）目标均为 Stable。Web UI 目标仍为 Beta，因此本决定不使用 Compose Multiplatform 替换 Nuxt Web。

## Decision

- **DEC-001**：用户客户端采用 Kotlin Multiplatform（KMP）和 Compose Multiplatform，以 Kotlin 作为客户端主要开发语言。
- **DEC-002**：Android 和 iOS 是 App 1.0 发布目标；Windows、macOS 和 Linux 均不纳入已承诺的普通用户客户端路线。
- **DEC-003**：领域模型、用例、API、WebSocket、状态管理、缓存策略、错误映射、设计 token 和大部分业务 UI 默认放入共享代码。
- **DEC-004**：App 1.0 需要的安全存储、深链和系统能力使用平台适配层。StoreKit、Google Play Billing、系统推送、相机/相册和桌面能力在未来 Feature 立项后再增加平台实现，不预装无用 SDK。
- **DEC-005**：现有 Hono/Cloudflare 后端、Nuxt 公共 Web 和 Nuxt 管理后台保持不变；KMP 只改变用户客户端技术路线。
- **DEC-006**：OpenAPI、JSON Schema 和 WebSocket event schema 是跨语言唯一契约来源，分别生成或校验 Kotlin 与 TypeScript 模型；`@meigallery/shared` 不再被定义为 KMP 可直接复用的源码。
- **DEC-007**：未来如立项普通用户桌面端，复用共享业务核心并独立评审分发、维护、安全和平台体验，不因 KMP 可构建而自动承诺发布。
- **DEC-008**：公共客户端基线采用稳定版 Jetpack Lifecycle/ViewModel、Navigation 3、Paging、Room/SQLite、DataStore Preferences、Ktor Client、kotlinx.serialization 和 Coil 3。
- **DEC-009**：视频共享播放契约、状态和控制 UI；Android 使用 Media3 ExoPlayer，iOS 使用 AVPlayer/AVKit，不把社区统一播放器设为生产核心依赖。
- **DEC-010**：Android App 1.0 使用 `minSdk = 26`，API 25 及以下不进入兼容、测试和发布范围；允许基于安全、媒体或商店要求继续提高。

## Consequences

### Positive

- **POS-001**：Android 和 iOS 可以共享业务核心和大部分 UI，降低首发功能分叉概率。
- **POS-002**：未来若桌面端立项，可以评估复用发现、互动、会员私信、安全和契约测试，而不需要现在承担桌面发布成本。
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
- **IMP-002**：工程启动前完成技术验证：登录与令牌轮换、WebSocket 断线补拉、安全存储、站内通知、Android/iOS 构建和无障碍。支付、系统推送、媒体选择和桌面打包在对应 Feature 立项后验证。
- **IMP-003**：共享模块采用端口与适配器边界；任何直接调用平台 API 的实现只能进入对应平台 source set。
- **IMP-004**：版本锁定时同时记录 Kotlin、Compose Multiplatform、Gradle、Android Gradle Plugin、JDK、Xcode 和最低操作系统版本，并通过依赖更新验证任务统一升级。
- **IMP-005**：App 1.0 CI 至少包含共享单元测试、Android 构建和 iOS 模拟器构建；Windows/macOS 构建、签名和发布仅在桌面客户端立项后加入。
- **IMP-006**：以共享业务逻辑覆盖率、各目标构建通过率、UI 例外数量、平台缺陷率、启动性能和无障碍结果衡量方案，不以单一“代码共享百分比”作为成功指标。
- **IMP-007**：依赖版本、source set 边界、媒体缓存和视频 Spike 以 [KMP 客户端技术栈与库选型](../app/KMP_CLIENT_TECH_STACK.md) 为实施基线。

## References

- **REF-001**：[Kotlin Multiplatform 支持平台与稳定性](https://kotlinlang.org/docs/multiplatform/supported-platforms.html)
- **REF-002**：[Google 的 Kotlin Multiplatform 指南](https://developer.android.com/kotlin/multiplatform)
- **REF-003**：[Compose Multiplatform 与 Jetpack Compose 的关系](https://kotlinlang.org/docs/multiplatform/compose-multiplatform-and-jetpack-compose.html)
- **REF-004**：[React Native Windows](https://microsoft.github.io/react-native-windows/)
- **REF-005**：[React Native macOS](https://microsoft.github.io/react-native-macos/docs/intro)
- **REF-006**：[真人发现与互动 App 技术架构](../app/TECHNICAL_ARCHITECTURE.md)
- **REF-007**：[客户端方向与开放问题](../app/DECISIONS_AND_OPEN_QUESTIONS.md)
- **REF-008**：[KMP 客户端技术栈与库选型](../app/KMP_CLIENT_TECH_STACK.md)
