# KMP 客户端技术栈与库选型

App 版本：1.0

日期：2026-08-02

状态：最小构建矩阵与 M0 公共发现网络/图片 Spike 已落地；其余功能库继续逐批冻结

## 1. 文档目的

本文面向客户端架构、Android、iOS、后端和测试人员，说明独立 App 在 Kotlin Multiplatform（KMP）与 Compose Multiplatform（CMP）下采用哪些公共库、哪些能力必须保留平台实现，以及正式编码前需要验证的兼容性和安全边界。

本文同时记录选型方向和已落地的依赖锁。Kotlin、CMP、Gradle、Android Gradle Plugin、JDK、Android SDK、Ktor、kotlinx.serialization、kotlinx.coroutines 和 Coil 已进入 `meigallery-client/gradle/libs.versions.toml`；KSP、Xcode 最终版本、iOS 最低系统和其余功能库组合仍需在对应 Spike 中关闭。

App 1.0 不接入支付和系统推送。相关能力不进入首轮依赖和技术 Spike，未来 Feature 立项时再增加平台适配实现并正常升级 App。

## 2. 选型结论

| 领域 | 首选方案 | 放置位置 | 结论 |
|------|----------|----------|------|
| UI | Compose Multiplatform | `commonMain` 为主 | Android/iOS 共享页面和设计系统 |
| 状态与生命周期 | Jetpack Lifecycle、ViewModel、SavedState | `commonMain` | 使用官方 KMP 稳定组件 |
| 导航 | Navigation 3 | `commonMain` | 绿地项目优先；Spike 验证返回栈和深链 |
| 分页 | Paging 3 | `commonMain` | 推荐流、真人列表、互动列表和消息补拉 |
| 结构化本地数据 | Room + SQLite | `commonMain`，平台创建实例 | 缓存、历史、会话摘要和必要消息投影 |
| 轻量配置 | DataStore Preferences | `commonMain`，平台提供存储路径 | 设置、筛选和非敏感配置 |
| 网络 | Ktor Client + kotlinx.serialization | 公共配置在 `commonMain`，平台引擎分离 | REST、WebSocket、鉴权和文件传输统一入口 |
| 图片 | Coil 3 + Ktor 3 网络模块 | `commonMain` | 头像、封面、瀑布流和图库图片 |
| 视频 | 公共播放契约 + Media3/AVPlayer | 契约与控制 UI 共享，播放内核分平台 | 不依赖社区播放器作为核心播放内核 |
| 敏感凭证 | Android Keystore / iOS Keychain | `androidMain` / `iosMain` | Token 和密钥不得写入 DataStore 或 Room 明文 |

Google 将 Android、iOS 和 JVM 列为 Jetpack KMP 的 Tier 1 平台：包含完整 CI 测试，并跟踪源码和二进制兼容性。Windows、JavaScript 和 Wasm 当前保障级别较低，因此 App 1.0 只以 Android/iOS 为发布目标；普通用户 Desktop 未立项，未来若启动再单独锁定平台矩阵。参考：[Google Jetpack KMP 支持矩阵](https://developer.android.com/kotlin/multiplatform)。

### 2.1 已落地的最小构建矩阵

| 项目 | 锁定值 | 验证结论 |
|---|---:|---|
| Kotlin / KGP | 2.4.10 | Android 与 iOS Kotlin/Native 编译通过 |
| Compose Multiplatform | 1.11.1 | Runtime、Foundation、UI 跨端编译通过 |
| Android Gradle Plugin | 9.0.1 | Android Application 与 KMP Android Library 构建通过 |
| Gradle Wrapper | 9.6.1 | 当前 Gradle 9.x 最新正式版，使用官方 SHA-256 校验 |
| JDK | 21.0.10 | 使用 Android Studio 2026.1 内置 JBR |
| Android SDK | min 26 / compile 36 / target 36 | Host Test 与 Debug APK 通过 |
| iOS | deployment target 16.0（候选） | Simulator Kotlin/Native 编译通过；Framework 链接等待完整 Xcode/iOS SDK |
| Ktor Client | 3.5.1 | OkHttp/Darwin、JSON、超时、错误映射和 MockEngine 测试通过 |
| kotlinx.serialization | 1.11.0 | OpenAPI 手写 transport model 与未知字段兼容测试通过 |
| kotlinx.coroutines | 1.11.0 | M0 页面加载与游标分页状态、公共异步测试通过 |
| Coil | 3.5.0 | Android/iOS 公共封面组件编译通过；公开网络图真机 QA 待可用数据 |
| KSP | 未引入 | 在 Room 等需要代码生成的 Spike 中单独锁定 |

Gradle 9.6.1 完整告警模式下，AGP 9.0.1 内部会报告面向 Gradle 10 弃用的 Project 依赖表示法；告警不是本工程脚本产生，当前不阻断 Gradle 9.6.1 构建。后续升级 Android Studio/AGP 时必须重新验证并消除。版本依据：[Gradle 9.6.1 正式版](https://docs.gradle.org/9.6.1/release-notes.html)、[AGP 与 Gradle 兼容表](https://developer.android.com/build/releases/about-agp)。

## 3. Jetpack KMP 稳定基线

| 分类 | 库 | 调研稳定版本 | App 用途 |
|------|----|--------------|----------|
| UI | Jetpack Compose（AndroidX） | 1.11.4 | 共享页面所用 AndroidX 组件版本线；CMP Gradle 插件版本见 2.1 |
| 生命周期 | Lifecycle | 2.11.0 | 生命周期感知状态收集 |
| 状态 | ViewModel / ViewModel Compose | 2.11.0 | 共享页面状态、用例编排和状态恢复 |
| 导航 | Navigation | 2.9.8 | Navigation 3 不满足场景时的稳定回退 |
| 导航 | Navigation 3 | 1.1.4 | 新项目的主要返回栈和路由方案 |
| 导航事件 | Navigation Event | 1.1.2 | 返回事件和平台返回手势衔接 |
| 分页 | Paging | 3.5.0 | 推荐、热门、最新、关注、收藏、会话和消息分页 |
| 数据库 | Room | 2.8.4 | 离线投影、同步状态和本地查询 |
| 数据库 | SQLite | 2.7.0 | Room 的 KMP SQLite 驱动 |
| 配置 | DataStore | 1.2.1 | Preferences 设置和非敏感配置 |
| 状态恢复 | SavedState | 1.5.0 | 页面与导航状态恢复 |
| 基础 | Collection | 1.6.0 | 公共集合能力，通常为间接依赖 |
| 基础 | Annotation | 1.10.0 | 公共注解，通常为间接依赖 |

版本来源以 [Google Jetpack KMP 支持矩阵](https://developer.android.com/kotlin/multiplatform) 为准。创建工程时只选稳定版本，不把 alpha/beta 版本作为首发依赖。

### 3.1 使用边界

- Room 2.8.4 支持 Android、iOS、JVM/Desktop、原生 macOS 和 Linux；Room 2.8 起 Android 最低版本为 API 23。参考：[Room 发布说明](https://developer.android.com/jetpack/androidx/releases/room)。
- Paging 3.5.0 可在公共代码中承载分页状态；是否将具体页面数据持久化到 Room，由数据新鲜度和离线需求决定。参考：[Paging 发布说明](https://developer.android.com/jetpack/androidx/releases/paging)。
- KMP DataStore 当前只正式支持 Preferences DataStore，不把 Proto DataStore 写入首发方案。参考：[DataStore KMP 文档](https://developer.android.com/kotlin/multiplatform/datastore)。
- Media3、Hilt、WorkManager、CameraX 等未进入 Google 的 Jetpack KMP 支持矩阵。需要时放入平台 source set，或在公共层定义端口后由平台实现。
- Room 2.8.4 和 Coil 3.5.0 的技术最低门槛是 Android API 23，但这不是本产品的支持目标。App 1.0 将 Android `minSdk` 设为 API 26，不为 API 25 及以下提供兼容、测试或降级方案。

### 3.2 Android 版本策略

- App 1.0 基线：`minSdk = 26`（Android 8.0）。
- API 25 及以下不进入设备矩阵，不为其增加专用兼容库、条件分支、降级 UI 或缺陷修复。
- 如果登录安全、媒体播放、系统 WebView 或关键依赖需要更高版本，可以在客户端脚手架冻结前继续提高 `minSdk`；降低到 26 以下需要重新形成产品和技术决策。
- `compileSdk` 和 `targetSdk` 在实现时选择满足目标应用商店要求的稳定版本，不与 `minSdk` 绑定。
- iOS 最低版本仍由 OQ-027 决定；Windows/macOS 只有在普通用户桌面客户端立项后才确定。

## 4. 网络请求与实时通信

### 4.1 首选：Ktor Client 3.5.1

Ktor Client 3.5.1 是首选公共网络层。它覆盖 Android、iOS、JVM、Native、JavaScript 和 Wasm，并允许各平台使用不同底层引擎。参考：[Ktor 发布记录](https://ktor.io/docs/releases.html)、[Ktor Client Engines](https://ktor.io/docs/client-engines.html)。

建议模块：

```text
commonMain
├── ktor-client-core
├── ktor-client-content-negotiation
├── ktor-serialization-kotlinx-json
├── ktor-client-auth
├── ktor-client-websockets
└── ktor-client-logging（仅开发环境输出脱敏信息）

androidMain
└── ktor-client-okhttp

iosMain
└── ktor-client-darwin
```

职责划分：

- `commonMain` 统一 Base URL、超时、序列化、错误映射、Token 刷新、幂等键、请求 ID、重试条件和 WebSocket 事件协议。
- Android 使用 OkHttp 引擎；iOS 使用 Darwin 引擎。两者都支持 HTTP/2 和 WebSocket。
- 自动重试仅用于可证明幂等的请求。消息、订单、赠礼和调币仍必须携带服务端认可的幂等键。
- 日志不得输出 Token、Cookie、私信正文、签名媒体 URL、证件或支付凭证。
- API 业务缓存放入 Room；图片缓存交给 Coil；不以通用 HTTP 缓存替代领域同步规则。

### 4.2 可选：Ktorfit

Ktorfit 2.7.5 可以为 Ktor 提供类似 Retrofit 的注解接口和 KSP 代码生成，支持 Android、iOS、JVM、JS、Native 和 Wasm。参考：[Ktorfit 项目](https://github.com/Foso/Ktorfit)。

首期不把 Ktorfit 设为基础依赖，原因是它增加 Kotlin、KSP、Compiler Plugin 和 Ktor 的兼容矩阵。只有在 API 数量增长、手写 Service 样板成为明确成本后，才通过独立 Spike 决定是否引入；Repository 和领域层不得直接依赖生成器类型。

### 4.3 不采用的网络基础

- Retrofit 和 OkHttp 继续适合 Android/JVM，但不能作为 Android/iOS 的统一 `commonMain` 网络层。OkHttp 只作为 Android 的 Ktor 引擎。
- Apollo Kotlin 适合 GraphQL；当前 Hono 服务采用 REST、OpenAPI 和 WebSocket，不引入 GraphQL 客户端。

## 5. 图片加载与缓存

### 5.1 首选：Coil 3.5.0

Coil 3.5.0 支持 Compose Multiplatform 的 Android、iOS、JVM、JavaScript 和 Wasm，首期使用以下能力：

```text
coil-compose
coil-network-ktor3
coil-network-cache-control
coil-svg（仅确有 SVG 资源时）
```

参考：[Coil 3 KMP 说明](https://coil-kt.github.io/coil/upgrading_to_coil3/)、[Coil 网络图片](https://coil-kt.github.io/coil/network/)。

图片策略：

| 媒体类型 | 缓存策略 | 失效要求 |
|----------|----------|----------|
| 公开头像、列表封面 | 内存 + 磁盘，可使用稳定派生资源 URL | 内容版本变化时更换版本键 |
| 公开详情图片 | 内存 + 受控磁盘缓存 | 资料暂停或授权撤销时按版本/TTL 失效 |
| VIP 受保护原图 | 默认内存缓存；如启用磁盘缓存必须独立、可清理并完成安全评审 | 退出、远程登出、会员失效和权限撤回时清理 |
| 短期签名 URL | URL 与业务媒体 ID、过期时间分开建模 | 不把签名 URL 当作永久媒体标识 |

Coil 3 默认不会自动遵守服务端 `Cache-Control`，并可能保存网络响应到磁盘。受保护媒体必须显式配置 `coil-network-cache-control` 或自定义缓存策略，不能只依赖签名 URL 过期控制本地副本。

`coil-video` 当前仍是 Android-only 的视频帧解码器，不作为跨端视频封面方案。视频缩略图由媒体处理流水线或 Cloudflare Stream 生成，App 只加载审定后的缩略图 URL。

### 5.2 备选：Kamel

Kamel 1.0.9 是基于 Ktor 的 Compose Multiplatform 图片加载和缓存库，可作为 Coil 出现阻断性兼容问题时的备选。由于 Coil 的 Android 生态、API 熟悉度和当前 KMP 支持更符合团队能力，首发不同时引入两套图片管线。参考：[Kamel 项目](https://github.com/Kamel-Media/Kamel)。

## 6. 视频播放

### 6.1 架构决定

当前没有由 Google 或 JetBrains 官方维护、同时统一 Android Media3 和 iOS AVPlayer 的 KMP 播放器。视频采用“共享播放契约和控制 UI，平台实现播放内核”：

| 层 | Android | iOS | 是否共享 |
|----|---------|-----|----------|
| 视频源、凭证到期、播放状态和错误模型 | 公共模型 | 公共模型 | 是 |
| `VideoPlayerController` | Media3 适配器 | AVPlayer 适配器 | 接口共享、实现分离 |
| 播放表面 | Media3 Compose/View | `AVPlayerLayer` 或 `AVPlayerViewController` | 否 |
| 播放、暂停、进度、加载、VIP 锁定和错误 UI | Compose | Compose | 尽量共享 |
| 全屏、画中画、音频焦点、生命周期 | Android 平台实现 | iOS 平台实现 | 否 |

Android 使用 Jetpack Media3 ExoPlayer 1.10.1，并按需要加入 HLS 和 Compose UI 模块。参考：[Media3 快速开始](https://developer.android.com/media/media3/exoplayer/hello-world)、[Media3 HLS](https://developer.android.com/media/media3/exoplayer/hls)。

iOS 使用 AVFoundation 的 `AVPlayer`/`AVPlayerItem` 和 AVKit。CMP 可以通过 `UIKitView` 嵌入原生 UIKit 播放表面。参考：[Apple AVPlayer](https://developer.apple.com/documentation/avfoundation/avplayer)、[Compose UIKit 互操作](https://kotlinlang.org/docs/multiplatform/compose-uikit-integration.html)。

### 6.2 Cloudflare Stream 约束

- App 优先消费 HLS `.m3u8`，Android Media3 和 iOS AVPlayer 均原生支持。
- 服务端校验账号、会员和媒体权限后发放短期签名播放 URL；客户端不得自行拼接永久 Stream 地址。
- HLS/DASH Manifest 是动态资源，不做持久缓存、代理或离线保存。
- 视频封面使用 Stream 缩略图或后台派生图，不在列表滚动中启动播放器截帧。
- 暂不实现视频下载、离线播放、DRM、后台音频、画中画或短视频连播；这些能力进入对应 Feature PRD 后再扩展公共契约。

参考：[Cloudflare Stream 自定义播放器](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/)、[Cloudflare Stream 访问保护](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/)。

### 6.3 社区播放器的使用边界

[ComposeMultiplatformMediaPlayer](https://github.com/Chaintech-Network/ComposeMultiplatformMediaPlayer) 可用于快速验证 Android/iOS HLS 和共享控制 UI，但不作为生产基础依赖。生产采用前必须验证维护和 Release 机制、生命周期释放、列表复用、签名 Header、全屏、画中画、字幕、音频焦点、弱网和平台错误映射；任一关键项不满足即回到 Media3/AVPlayer 平台适配方案。

## 7. 推荐 source set 边界

```text
commonMain
├── Compose Multiplatform
├── Lifecycle / ViewModel / SavedState
├── Navigation 3
├── Paging
├── Room / SQLite
├── DataStore Preferences
├── Ktor Client / kotlinx.serialization / coroutines
├── Coil 3
├── 领域模型、Repository、Use Case 和状态机
└── VideoPlayerController、PlaybackState 和共享控制 UI

androidMain
├── Ktor OkHttp Engine
├── Media3 ExoPlayer
├── Android Keystore
└── Android 生命周期、全屏和系统适配

iosMain
├── Ktor Darwin Engine
├── AVPlayer / AVKit
├── iOS Keychain
└── UIKit 播放表面和系统适配

desktopMain（普通用户桌面客户端独立立项后再创建）
└── 根据目标平台重新验证网络、数据库、图片、视频和安全存储
```

## 8. 实现前技术 Spike

最小脚手架阶段已经完成以下验证：Gradle 工程模型可解析，四个共享模块 Android Host Test 通过，Android Debug APK 生成，四个共享模块的 iOS Simulator Kotlin/Native 编译通过。iOS Framework 链接已确认只被本机缺少完整 Xcode/iOS SDK 阻塞。

首个 M0/P0 公共发现纵向切片已完成 Ktor、serialization、Coil、Android Host Test、Debug APK 与 iOS Kotlin/Native 编译验证。后续仍按业务切片验证：

1. Lifecycle/ViewModel、Navigation 3、Paging、Room 和 DataStore 与当前 Ktor/Coil 基线能同时构建。
2. Android 真机与 iOS 真机/模拟器完成公开图片、游标分页和错误映射；登录立项后再验证 Token 刷新。
3. 受保护媒体立项后验证短期签名图；退出、远程登出和会员撤权后受保护缓存能够清理。
4. WebSocket 完成连接、断线重连、sequence 补拉、重复事件去重和 HTTP 发送兜底。
5. Media3 与 AVPlayer 播放同一条签名 HLS，覆盖过期、403、弱网、切后台、旋转/全屏和资源释放。
6. Room migration schema、KSP 生成、iOS 链接和并发访问通过测试。
7. Release 构建不包含网络明文日志、测试证书、固定 Token 或可长期使用的媒体 URL。

只有对应功能 Spike 通过，Lifecycle、Navigation 3、Paging、Room、DataStore、Media3、KSP 等调研版本才能转为工程依赖锁；Ktor、serialization、coroutines 和 Coil 已因 M0 通过转为依赖锁。未通过时记录最小复现、替代库、平台差异和是否影响产品范围。

## 9. 验收标准

- **KMP-LIB-AC-001**：`commonMain` 不依赖 Android-only 的 Media3、OkHttp、Hilt、WorkManager 或平台安全存储类型。
- **KMP-LIB-AC-002**：Android/iOS 使用同一套 API、序列化、错误和 WebSocket 事件契约。
- **KMP-LIB-AC-003**：公开媒体和受保护媒体使用不同缓存策略，撤权后不继续展示受保护内容。
- **KMP-LIB-AC-004**：视频公共状态不暴露 Media3 或 AVFoundation 类型，两个平台能替换播放实现。
- **KMP-LIB-AC-005**：所有正式依赖使用 Version Catalog 统一锁定，并在 CI 验证 Android 与 iOS 构建。
- **KMP-LIB-AC-006**：依赖升级必须同时验证 Kotlin、CMP、Gradle、AGP、KSP、JDK、Xcode 和最低系统版本，不单独自动升级核心组件。
