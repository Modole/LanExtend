# 开发、测试与构建

## 1. 工具链

### 通用

- Git
- Node.js 22 或更高版本
- npm 10 或更高版本
- Windows 10/11 64 位（构建/验证子端）或 macOS 14+（构建/验证主端）

使用 `npm ci` 按 `package-lock.json` 安装，不要在可复现构建中用不锁版本的 `npm install`。

### macOS 额外要求

- Xcode Command Line Tools，或完整 Xcode；
- 可被 `xcrun --sdk macosx` 找到的 macOS SDK 和 Clang；
- 登录到图形桌面的普通用户会话，用于真实 WindowServer/屏幕录制验证。

安装命令行工具：

```bash
xcode-select --install
```

仓库不要求内核扩展、管理员权限、关闭 SIP 或 Apple Developer 账号。Developer ID 证书只在正式签名/公证发布时需要。

## 2. 目录结构

```text
LanExtend/
├── src/
│   ├── main.js                 Electron 主进程
│   ├── preload.js              白名单 IPC 桥
│   ├── core/                   配置、网络、协议和 helper 管理
│   └── renderer/               两端 GUI 与 WebRTC
├── native/macos/               CGVirtualDisplay helper 和说明
├── scripts/                    原生构建、源码检查
├── tests/                      Node 单元测试
├── docs/                       中文交付文档
├── .github/workflows/          CI 构建
├── package.json
└── package-lock.json
```

## 3. 常用命令

| 命令 | 平台 | 作用 |
| --- | --- | --- |
| `npm start` | 两端 | 启动 Electron；macOS 默认主端，Windows 默认子端 |
| `npm run dev:host` | macOS | 强制主端并允许多实例；使用临时开发 userData |
| `npm run dev:receiver` | Windows | 强制子端并允许多实例；使用临时开发 userData |
| `npm run build:native` | macOS | 构建虚拟显示 helper；其他平台明确跳过 |
| `npm test` | 两端 | 先做 JS/MJS 语法检查，再运行 Node 测试 |
| `npm run verify` | 两端 | 构建/跳过 helper 后运行测试 |
| `npm run dist:mac` | macOS | 构建 universal2 helper，再生成 Universal DMG 和 ZIP |
| `npm run dist:win` | Windows | 生成 portable EXE 和 ZIP |

所有打包产物写入 `release/`。不要在 Windows 上交叉构建 Mac 主端，也不要把 Mac 上交叉生成的 Windows 包当作已验证子端；原生 runner 能更早暴露平台路径、二进制和打包问题。

两个 `dev:*` 脚本会传入 `--allow-multiple-instances`，并把 userData 改到系统临时目录中的 `lanextend-dev-host`/`lanextend-dev-receiver`，避免污染正式配置；临时目录可能被系统清理。要验证正式单实例和正常 userData 路径，请在对应平台使用 `npm start` 或打包产物。

## 4. 本地开发流程

### Mac 主端

```bash
npm ci
npm run build:native
native/macos/.build/lanextend-vdisplay --probe
npm run dev:host
```

`--probe` 只检查所需私有类/selector 是否存在，不创建显示器。成功结果包含 `available: true`；它不代表创建、捕获和 WebRTC 已通过实机验收。

若要独立调试 helper：

```bash
native/macos/.build/lanextend-vdisplay create \
  --width 1920 --height 1080 --fps 30 \
  --name "LanExtend Dev"
```

helper 输出 JSON Lines；看到 `ready` 后必须保持进程运行。按 `Ctrl+C` 会释放显示器。不要用强制终止作为常规流程。

### Windows 子端

```powershell
npm ci
npm run dev:receiver
```

确认 Windows 网络配置文件为“专用”：允许子端程序向 UDP `47771` 发出广播、从可信 Mac/子网接收配置的 TCP 信令端口，并允许 WebRTC 动态 UDP。Mac 端需要接收入站发现广播。不要对公用网络放行。

### 双机调试

1. 先开子端，再开主端。
2. 两端从各自终端启动，保留日志。
3. 先用默认低风险参数跑通创建、发现、连接、画面、断开、清理。
4. 再分别改变一个变量：Wi‑Fi、HiDPI、60 FPS、不同分辨率或重连。
5. 每次记录 OS build、CPU 架构、网卡、分辨率、提交 SHA 和结果。

启用网络警告日志：

macOS：

```bash
LANEXTEND_DEBUG=1 npm run dev:host
```

Windows PowerShell：

```powershell
$env:LANEXTEND_DEBUG = '1'
npm run dev:receiver
```

日志可能包含设备名称、内网 IP、端口和断开原因。提交 issue 前先脱敏。

## 5. 自动化测试

```bash
npm test
```

当前自动化覆盖重点：

- 配置默认值、输入清洗、持久化和设备记忆；
- 私有 IPv4、端口、发现报文和信令消息解析；
- IPv4 广播地址计算和 WebSocket 单会话行为；
- 虚拟显示参数验证、helper 路径与生命周期管理的可测试部分；
- JS/MJS 源码语法。

当前自动化**没有**覆盖：

- 真实 `CGVirtualDisplay` 在所有 macOS 14+ 版本/CPU 架构上的创建；
- macOS 屏幕录制授权弹窗和捕获内容正确性；
- Mac 到 Windows 的真实 WebRTC 编解码、GPU 使用、端到端延迟和丢包恢复；
- Windows Defender 防火墙交互、全屏多显示器行为；
- 安装、签名、公证、升级和长时间稳定性。

这些项目必须执行[双机手工验收](acceptance.md)。

## 6. 构建 macOS 产物

```bash
npm ci
npm test
npm run dist:mac
```

`dist:mac` 会先用 `-arch arm64 -arch x86_64` 把 universal2 helper 编译到 `native/macos/.build/lanextend-vdisplay`，再调用 electron-builder `--universal` 合并两种 Electron 架构并生成 Universal DMG/ZIP。

注意：

- 本地/CI 默认产物不具备正式 Developer ID 签名和 Apple 公证；
- 当前项目使用私有 `CGVirtualDisplay` API，不支持 Mac App Store；
- 构建后用 `lipo -info native/macos/.build/lanextend-vdisplay` 并检查最终 app 主二进制，确认都含 `x86_64` 与 `arm64`；命令配置为 Universal 不等于产物已经正确合并。
- 即使同一个 Universal 包包含两种 slices，也必须分别在 Intel 和 Apple Silicon 真机验收私有 API、权限、捕获和 WebRTC；当前没有自动真机矩阵可替代。
- 构建时设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 可避免 CI 意外使用 runner 上的签名身份；正式发布则应使用受保护 secrets 和独立签名工作流。

## 7. 构建 Windows 产物

在 Windows 10/11 或 GitHub `windows-2022` runner 上执行：

```powershell
npm ci
npm test
npm run dist:win
```

生成 portable EXE 和 ZIP。当前没有 MSI、系统服务、驱动、静默自动安装或 Authenticode 签名。应用只检查 GitHub 最新 Release 并打开固定下载页；Windows SmartScreen 可能提示未知发布者，这是正式发布前的阻塞项，不应通过文案声称“安全”来规避。

## 8. GitHub Actions

`.github/workflows/build.yml` 在以下情况运行：

- 向仓库推送；
- Pull Request；
- 手动 `workflow_dispatch`。

两个独立 job：

1. `macos-build`：`npm ci` → `npm test` → `npm run dist:mac` → 上传 DMG/ZIP；
2. `windows-build`：`npm ci` → `npm test` → `npm run dist:win` → 上传 portable EXE/ZIP。

workflow 使用最小 `contents: read` 权限，并上传 14 天 artifacts。它不自动创建 Release、不签名、不公证、不上传商店；维护者可在两个 job 均通过后，另外创建 GitHub Release 并上传同一版本的候选包与哈希。

## 9. 发布前版本与合规检查

1. 更新 `package.json` 版本并同步锁文件。
2. 检查 `THIRD_PARTY_NOTICES.md` 与实际直接/打包依赖。
3. 执行 `npm ci && npm test`，两端各自原生打包。
4. 完成全部 P0 双机验收并保存记录。
5. 在隔离环境验证未签名候选，再在正式工作流完成 Mac Developer ID 签名/公证和 Windows Authenticode 签名。
6. 计算 SHA-256、生成 SBOM/依赖清单、做恶意软件扫描。
7. 只发布由受保护 tag 对应工作流产生的最终文件，并附已知限制。

更完整的门槛见[发布说明](release.md)。

## 10. 贡献约束

- 不要直接复制 GPL/AGPL 调研项目代码到 MIT 仓库；先做许可证评估。
- 修改协议必须同步更新 `src/core/constants.js`、验证器、双端、测试和[协议文档](protocol.md)。
- 修改私有 API 声明/行为必须更新 `native/macos/ATTRIBUTION.md`，并在目标 macOS 版本上执行 helper 探测与真机创建。
- 新增 IPC 时继续使用 preload 白名单、输入校验和渲染沙箱，不向页面暴露通用文件/进程能力。
- 不把“能编译”“测试通过”和“已完成双机/安全/发布验收”混为一谈。
