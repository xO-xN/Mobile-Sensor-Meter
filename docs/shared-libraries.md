# v0.4.2 固定共享库接线

本版 manifest.schemaVersion 为 2，sharedLibraries 声明确切运行库。只在 App v1.6.2 或支持这些引用的 Host 中运行；旧 App 不能执行共享引用。本地 standalone 开发用 npm ci --ignore-scripts 安装 package-lock 的精确依赖，Host 运行不会安装或下载。

本工具明确声明 `scoreServer.needsHttps: true` 与 `supportsPerformerUrl: true`，因为手机传感器、摄像头和麦克风使用安全上下文 API。App 仅对这种明确需求启用已配置的 HTTPS 入口；普通工程默认 HTTP。共享库引用本身不构成 HTTPS 需求，QR、复制地址与页面连接使用 Host 决定的同一网址。

Host 注入 PNDS_SHARED_LIBRARIES JSON 映射。lib/shared-libraries.js 只接受本工程声明的固定 id/version/kind 与存在的绝对入口；Host 环境存在时缺项、错误版本或缺文件明确失败，不静默使用本地依赖。Node CommonJS 通过 requireLibrary 加载；浏览器资源由工程 /__pnds/shared/ 同源路由提供，手机和可信 HTTPS 使用相同含义。标准模块和工具策略仍属于工程。

共享 .pnds 只携带引用、源码与工程资产，不携带重复库或 node_modules；打包安装须由 App 检查接收方能力。Standalone 不注入该环境，继续使用精确本地 npm 依赖。公开 Node/HTTP/受控进程回归与真实设备验收分开记录；健康检查、HTTP 成功不能代表传感器、推理、诊断功能或声音已通过。

本地候选产物尚未发布。维护者完成真机验收并发布固定工具产物后，App 才能引用真实 release URL 与对应 sha256；不得把本地候选写成已发布来源。

Mobile 的 ml5 1.4.0 与 tfjs/lite 模型分别检查：库由 /__pnds/shared/ml5.js 提供，模型仍在 public/vendor/handpose/。/handpose/assets.json 分别列出库、检测模型和关键点模型；fetch:handpose 只校验并补齐四个工程模型文件，运行时零 CDN。权限、采集 epoch、seq、推理与停止策略不变。

验证记录（2026-10-14）：npm run check 与 npm test 全绿（159 tests）；缺项、版本错误、缺文件、无本地依赖的共享启动与关停已通过受控进程回归。模型、真实手机、声音、原生 App 和安装验收按支持模式分别记录，不由这些回归替代。
Chromium 149.0.7827.102 的断公网验证通过：固定共享 ml5 1.4.0、工程 tfjs/lite 四个模型文件实际加载并完成 WebGL 计算；256×256 灰色 canvas 输入得到真实零手结果，耗时约7015 ms。未请求摄像头、麦克风或运动权限；这条自动证据不覆盖实体设备。后续用户于 2026-10-14 明确确认 Template 与四个 Utilities 已测试完成、无问题，补齐本工程人工验收；不自行补写设备型号或测试时长。复验命令：`node scripts/verify-shared-browser.mjs <App共享目录> <playwright模块> <Chromium可执行文件>`。

发布维护（0.4.2）：ml5 npm 包的 postinstall 依赖其开发用 patch-package；本工程只消费已编译浏览器分发，维护安装采用 `npm ci --ignore-scripts`。四个模型与运行源码保持不变，0.4.1 的已验收行为沿用；旧 tag 保留，固定新产物来自 0.4.2。
