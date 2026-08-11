# 开源方案调研与选型记录

核验日期：**2026-08-10**。许可证以各项目当日默认分支的 LICENSE/仓库标识为准；上游可能改许可证或使用多许可证，实际复用前必须按固定 commit/tag 再审查。本文件是工程调研，不是法律意见。

## 1. 调研矩阵

| 项目 | 主体能力/技术路径 | 与“Mac 主端 → Windows 子端扩展屏”的匹配 | 当日许可证 | LanExtend 采用边界 |
| --- | --- | --- | --- | --- |
| [OpenDisplay](https://github.com/peetzweg/opendisplay) | Mac 用私有 `CGVirtualDisplay` 创建真扩展屏，ScreenCaptureKit + VideoToolbox H.264，经 USB/Wi‑Fi TCP 发到 iPhone/iPad；含输入回传 | 真扩展屏和低延迟管线最接近，但接收端是 iOS，不是 Windows；传输栈与本 MVP 不同 | [GPL-3.0](https://github.com/peetzweg/opendisplay/blob/main/LICENSE)；README 说明 v0.4.x 及更早版本曾为 MIT，复用必须锁定具体历史版本 | 仅参考分层、权限提示和生命周期；未复制 GPL 实现 |
| [VoidDisplay](https://github.com/iamsyc/VoidDisplay) | macOS 创建/预览虚拟显示器，并通过 WebRTC + WebSocket 向局域网浏览器共享；访问 URL 含 capability | 架构非常接近“虚拟屏 + LAN WebRTC”，但当前项目本身是 macOS 应用/浏览器观看，README 要求 macOS 15.6+ | [Apache-2.0](https://github.com/iamsyc/VoidDisplay/blob/main/LICENSE)，另有私有 API 声明来源文件 | 参考 WebRTC 分层、capability/安全披露；未作为依赖或复制实现 |
| [node-mac-virtual-display](https://github.com/enfp-dev-studio/node-mac-virtual-display) | Node 原生模块封装 CoreGraphics/CoreDisplay 私有接口，支持创建/销毁、镜像/扩展和多虚拟屏 | 与 Electron/Node 集成直接，MIT 友好；但原生 addon 与 Electron ABI/进程稳定性耦合，私有 API 风险仍存在 | [MIT](https://github.com/enfp-dev-studio/node-mac-virtual-display/blob/main/LICENSE) | 参考 Node 侧 API 形态和持久显示身份；MVP 选择独立 helper 隔离，不依赖此包 |
| [DeskPad](https://github.com/Stengo/DeskPad) | 用私有 API 建一个 macOS 虚拟显示器，并在本地窗口镜像，主打屏幕共享工作区 | 虚拟显示创建和简洁 GUI 很有参考价值；没有 Windows 网络子端 | [MIT](https://github.com/Stengo/DeskPad/blob/main/LICENSE.md) | 参考最小虚拟屏 UX、权限和系统排列行为；未复制代码 |
| [Deskreen CE](https://github.com/pavlobu/deskreen) | Electron 桌面端 + WebRTC，将屏幕/窗口发到任意浏览器；跨平台、配对式 UX | Windows 接收兼容性强，但浏览器端模型与独立子端不同；真扩展通常仍需额外虚拟显示方案 | [AGPL-3.0](https://github.com/pavlobu/deskreen/blob/master/LICENSE) | 参考 Electron/WebRTC 与设备选择体验；AGPL 代码未进入 MIT 仓库 |
| [Weylus](https://github.com/H-M-H/Weylus) | Rust 主程序 + 浏览器端，屏幕镜像、硬件编码、键鼠/触控/笔输入；README 明确建议可信网络和可选访问码 | 适合“设备作为触控屏/数位板”；跨平台，但 macOS 不是本需求的真扩展屏一体方案 | [AGPL-3.0-or-later](https://github.com/H-M-H/Weylus/blob/master/LICENSE)；其 LICENSE 说明贡献工作为 3-Clause BSD | 参考浏览器兼容、硬件编码和明文内网风险说明；未复用代码/输入功能 |
| [Sunshine](https://github.com/LizardByte/Sunshine) | Moonlight 自托管游戏串流主机，低延迟、硬件编码、Web 管理和配对，跨平台 | 高性能媒体管线成熟，但协议/产品复杂度远超单扩展屏 MVP；上游不是专为 Mac 私有虚拟显示创建设计 | [GPL-3.0](https://github.com/LizardByte/Sunshine/blob/master/LICENSE) | 参考编码、重连、指标和安全配对方向；不引入其协议或 GPL 代码 |
| [Lumen](https://github.com/trollzem/Lumen) | Sunshine 的 macOS 分支，加入 ScreenCaptureKit、VideoToolbox、私有虚拟显示、音频/游戏手柄等 | 对 Apple Silicon 游戏串流有产品先例，但范围更大且是 GPL | [GPL-3.0](https://github.com/trollzem/Lumen/blob/main/LICENSE) | 仅作产品能力调研；未查阅或复制其 helper 实现，未作为依赖 |
| [Chromium virtual display test utility](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/display/mac/test/virtual_display_util_mac.mm) | Chromium 测试代码中的 macOS 私有虚拟显示工具，记录类/selector 与兼容性细节 | 不是成品，但适合核对私有 API 声明、非零 vendor ID 和 serial 等约束 | Chromium BSD-style 许可证；以对应源码树 LICENSE 为准 | 只作接口/兼容性参考，`native/macos/ATTRIBUTION.md` 已记录；没有复制第三方实现 |

## 2. 关键观察

### 真扩展屏与屏幕镜像不是同一问题

Deskreen、Weylus、Sunshine 等擅长把现有画面传给其他设备，但“macOS 认为多接了一块显示器”还需要：

- 物理显示器/HDMI dummy；
- DisplayLink/系统级驱动；或
- `CGVirtualDisplay` 之类的私有 API。

LanExtend 选择第三条以实现免硬件 MVP，因此必须接受 App Store 不支持和系统更新兼容风险。不能因为 WebRTC 画面能传输就宣称“扩展屏”已经完成；必须验收系统排列中确有独立显示器、窗口能移入且只捕获该显示器。

### WebRTC 是合适的 MVP 媒体层，但不是完整安全方案

VoidDisplay/Deskreen 等证明了 WebRTC 适合浏览器/Electron 低延迟视频和跨平台解码。它提供 DTLS-SRTP 媒体加密、拥塞控制和广泛编解码支持，能避免自己定义裸帧协议。

但 SDP/ICE 仍需要经过可信信令。LanExtend v1 的 WebSocket 没有 TLS/认证，攻击者可以替换协商内容；“WebRTC 已加密”不能被写成“设备已安全认证”。

### 子端监听、主端主动连接符合需求

OpenDisplay 的接收端监听、发送端主动连接，以及 Sunshine/Moonlight 的 host/client 分工，都支持清晰的角色模型。LanExtend 让 Windows 子端广播并监听，Mac 主端选择目标后主动连接：

- 用户能在主端决定投放到哪里；
- Windows 不需要反向发现 Mac；
- 同一子端拒绝第二个主端，先保持 MVP 单会话。

这仍只是流程权限，不是认证。

### 独立 helper 优于把私有 API 直接放进 Electron 进程

`node-mac-virtual-display` 的 addon 路径集成最短，但会带来 Electron/Node ABI、崩溃域和打包差异。LanExtend 使用 Objective-C helper：

- Electron 只监督子进程和解析 JSONL；
- helper 崩溃时显示被释放，主进程可更新状态；
- 可以单独 `--probe` 和按 OS/架构构建；
- 私有 API 风险被隔离但没有消失。

## 3. 选型结论

MVP 采用以下组合：

| 层 | 选择 | 原因 |
| --- | --- | --- |
| GUI | Electron 单仓双角色 | Mac/Windows 共享 UI/WebRTC 代码，开发速度快 |
| Mac 虚拟屏 | 原创 Objective-C 子进程 + 私有 `CGVirtualDisplay` | 真扩展屏、无需驱动，崩溃域与 Electron 隔离 |
| 捕获 | Electron/Chromium 屏幕捕获 | 与 WebRTC 直接衔接，有系统权限模型 |
| 发现 | IPv4 UDP 广播 | 受控同子网零配置；保留手动 IP 回退 |
| 信令 | Windows 上明文 WebSocket | 实现小、适合无认证内网 MVP；明确不能公网使用 |
| 媒体 | WebRTC 单路视频 | 跨平台、标准媒体加密、拥塞控制、Electron 原生支持 |
| 记忆 | 本地 JSON 原子写入 | 无服务端、易迁移；明确不是信任数据库 |

没有直接 fork 任一项目，因为没有一个上游同时满足“Mac 真扩展屏、Windows 独立 GUI 子端、主端主动连接、MIT 可控范围和内网 MVP”全部约束。

## 4. 许可证决策

### 可借鉴不等于可复制

- MIT/3-Clause BSD 通常允许在保留声明后复用，但仍需核对具体文件、作者和专利/商标条件。
- Apache-2.0 还包含明确专利条款和 NOTICE 处理要求；复制前应建立来源清单。
- GPL-3.0/AGPL-3.0 是强 copyleft。把其实现并入并分发一个组合程序可能要求整体按相应许可证提供源代码；AGPL 还针对网络交互有额外义务。
- 仅阅读架构和公开接口名称，不代表可以逐行翻译或做近似复制。

因此本仓库：

1. 不把 OpenDisplay、Deskreen、Weylus、Sunshine、Lumen 的 GPL/AGPL 实现作为依赖或源码复制；
2. 原生 helper 使用原创实现；只在 `native/macos/ATTRIBUTION.md` 记录实际用于核对私有接口的 Chromium 与 DeskPad 来源；
3. 运行时只直接依赖 `ws` 和 Electron，构建依赖 electron-builder，均按各自 MIT/捆绑第三方声明处理；
4. 未来若决定直接采用上游代码，先停止合并，固定 commit，完成逐文件许可证/NOTICE/专利评估，再决定整体许可证。

## 5. 为什么暂不选择其他路线

| 路线 | 暂不选择原因 |
| --- | --- |
| 直接 fork OpenDisplay | Windows 接收端缺失；当前 GPL-3.0 会改变分发策略；其 USB/iOS 路径超出需求 |
| 直接 fork VoidDisplay | 当前以 macOS 应用 + 浏览器查看为中心，系统要求与目标不同；仍需做 Windows 独立 GUI 产品化 |
| 直接使用 node 原生 addon | ABI/打包/崩溃域耦合；本 MVP 更看重 helper 隔离与可探测性 |
| 直接用 Deskreen/Weylus | 不能单独解决 Mac 真扩展显示创建；AGPL 对当前 MIT 交付边界不合适 |
| 基于 Sunshine/Moonlight | 功能与依赖过重，协议/配对/游戏输入超出 MVP，GPL 分发要求不同 |
| 开发虚拟显示驱动 | 稳定性潜力更高，但签名、安装、系统权限、维护成本远高于当前 MVP |
| 仅镜像现有显示器 | 无法满足“多扩展一个显示器”的核心目标 |

## 6. 后续可回看上游的议题

- 私有 API 在新 macOS 的变化：OpenDisplay、VoidDisplay、DeskPad、Chromium；
- 低延迟 VideoToolbox/ScreenCaptureKit：OpenDisplay、Lumen、Sunshine；
- 认证和配对 UX：Sunshine/Moonlight、Deskreen；
- capability URL 和可信 LAN 披露：VoidDisplay、Weylus；
- 浏览器兼容和输入模型：Deskreen、Weylus；
- 多虚拟显示和持久身份：node-mac-virtual-display、OpenDisplay。

回看上游时应记录 URL、commit、文件、许可证和“只阅读/复制/修改”的具体关系，避免事后无法证明来源边界。
