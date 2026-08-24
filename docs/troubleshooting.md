# 故障排除

先记录两端 OS 版本、CPU 架构、应用版本/提交 SHA、连接方式、IP/端口、分辨率/FPS/码率和完整复现步骤。日志对外发送前删除私网 IP、设备名、UUID、SDP/ICE 和屏幕内容。

## 1. 应用无法启动

### Mac 提示无法验证开发者或未公证

CI 构建没有配置 Developer ID 正式签名和 Apple 公证。确认文件来自可信工作流和正确提交后，优先使用 Finder 右键应用 →“打开”，或在“系统设置 → 隐私与安全性”中使用针对该应用的单次“仍要打开”。

不要长期关闭 Gatekeeper，也不要对来源不明的应用清除隔离属性。正式用户分发前必须完成签名和公证。

### Windows SmartScreen 提示未知发布者

CI portable EXE 没有 Authenticode 签名。只在核对可信 Actions 运行和文件哈希后用于内部验收。正式发布前应签名，不能把关闭 SmartScreen 作为安装步骤。

### 源码启动报缺少模块

在仓库根目录确认 Node/npm 版本并做干净锁定安装：

```bash
node --version
npm --version
npm ci
```

要求 Node 22+、npm 10+。不要复制其他平台的 `node_modules`。

## 2. Mac 无法创建虚拟显示器

主端没有独立创建按钮。请先选择子端并点击“扩展到 …”；应用收到 `welcome` 的真实设备 UUID 后，才会在默认“创建扩展屏”模式启动 helper。若这一步提示找不到 helper：

```bash
npm run build:native
ls -l native/macos/.build/lanextend-vdisplay
```

构建需要 Xcode Command Line Tools、macOS SDK 和 Clang：

```bash
xcode-select -p
xcrun --sdk macosx --show-sdk-path
xcrun --sdk macosx --find clang
```

### 探测私有 API

```bash
native/macos/.build/lanextend-vdisplay --probe
```

- `available: true`：只代表类和 selector 在当前进程可见，继续做创建测试；
- `available: false` / `api_unavailable`：当前 macOS 与 helper 不兼容，不要反复重试或关闭系统保护；记录 OS build 和 `missing` 字段，提交兼容性问题。

项目支持基线是 macOS 14+，但每个系统版本仍需真机回归。App Store 版本不是可行分发路径。

### 显示创建后立即消失

虚拟显示对象由 helper 进程持有；helper 退出、崩溃或被系统终止时，显示器会消失。检查启动终端的 stderr/JSONL 输出和系统崩溃报告。确认没有脚本清理进程，也没有重复启动另一个主端实例。

### 参数被拒绝

GUI 接受偶数逻辑宽 `800–7680`、偶数逻辑高 `600–4320`、`15–60` FPS。HiDPI 会创建宽高各 2× 的物理 framebuffer，因此逻辑宽/高各自不能超过 3840。先恢复 1920×1080、30 FPS、关闭 HiDPI，再逐项增加。

## 3. 已创建显示器但捕获源没有出现

1. 确认已经选中子端、保持“创建扩展屏”并点击“扩展到 …”；收到 welcome 前不会创建显示器。
2. 打开“系统设置 → 显示器”，确认系统确实列出虚拟显示器。默认模式会自动按 display ID/名称匹配，不需要手选。
3. 检查屏幕录制权限；修改后完全退出并重开应用。
4. 点击“断开扩展屏”清理后重新连接，让应用重新创建并轮询捕获源。
5. 如果 GUI 已切到“已有显示器”兼容模式，刷新列表并手选来源；不依赖上次保存的 source ID，系统重启或显示器重建后 ID 可能改变。

如果系统显示器列表也没有该显示器，回到 helper 排障，而不是继续排查 WebRTC。

### 已授权但应用仍显示“需要屏幕录制权限”

1. 完全退出所有 LanExtend 进程，确认没有从 DMG、下载目录、源码目录或 `release/` 运行另一份副本。
2. 只保留并启动 `/Applications/LanExtend.app`；不要从构建输出双击应用。
3. 在系统屏幕录制列表中关闭旧 LanExtend 项，再为当前 `/Applications` 副本开启；返回窗口后应用会自动重新检测。
4. 如果替换了未使用 Developer ID 正式签名的开发包，macOS 仍可能要求重新授权。用于公开稳定分发的根本方案是 Developer ID 签名和公证。

开发包会对整个应用和原生 helper 做 ad-hoc 签名，以避免“应用包完全未签名”；这不等同于 Developer ID，不能提供发布者身份、跨版本稳定要求或公证。

## 4. Windows 子端未被自动发现

按顺序检查：

1. 子端 GUI 是否显示正在监听，端口是否合法。
2. `ipconfig` 中 Windows 和 Mac 是否在预期 IPv4 子网。
3. Windows 网络配置文件是否为“专用”，防火墙是否允许子端程序的 UDP 广播。
4. Wi‑Fi 是否启用 AP/client isolation；企业无线网和访客网通常会阻止客户端互见。
5. 两端是否经过不同 VLAN、VPN 或虚拟网卡；广播默认不能跨三层路由。
6. 暂停 VPN/虚拟网卡后重试，避免广播从错误接口发出。
7. 若 IP 可路由但广播受限，使用手动私有 IPv4 + 端口。

在线设备约 6 秒收不到广播会变离线；这不是立即断开会话的判据。

## 5. 手动地址被拒绝

MVP 只接受：`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16` IPv4 和 `1–65535` 端口。

不支持：

- IPv6；
- `hostname.local` 或 DNS 名称；
- 公网 IPv4；
- 带 `http://`、`ws://` 或路径的完整 URL。

应只填写例如 `192.168.1.25` 和 `47772`。

## 6. 连接被拒绝或立即断开

### “子端当前正在使用” / 关闭码 1013

子端已有活动 WebSocket 会话。到当前主端正常断开，或在 Windows 子端确认会话后断开。不要通过杀进程绕过会话归属，除非应用已无响应。

### 关闭码 1008 / 信令格式无效

双端协议版本或消息实现不一致，或者同网有非 LanExtend 客户端连接。确认两端来自同一提交/版本，当前版本应显示 `协议 v3`，不要把完整 SDP/ICE 发布到公开 issue。

### `ECONNREFUSED`

- 子端未启动或端口已修改；
- Windows 防火墙阻止 TCP；
- 连接了错误 IP/网卡；
- 信令服务启动失败。

Windows 可检查监听端口：

```powershell
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 47772
```

### `EADDRINUSE`

端口被另一个进程占用，或启动了两个子端实例。关闭冲突程序，或在子端设置一个未占用的高位端口后让服务重启。同步更新主端记忆/手动端口和防火墙规则。

## 7. 已连接但 Windows 黑屏/无画面

1. Mac 屏幕录制权限是否为已授权；修改后重开应用。
2. 默认“创建扩展屏”是否成功自动匹配新 display ID；若处于“已有显示器”兼容模式，确认手选的是仍存在的来源而不是旧 source ID。
3. 把一个颜色明显、无敏感内容的窗口拖到虚拟显示器，确认不是空桌面。
4. 断开后用 1920×1080、30 FPS、8 Mbps、关闭 HiDPI 重建。
5. 检查两端 WebRTC 状态是否到 `connected`；若停在 `connecting`，重点排查防火墙/ICE。
6. Windows 更新显卡驱动并重启；Electron/Chromium 会自行选择编解码路径，但 MVP 没有硬件解码保证。

如果主端预览/缩略图也黑，问题在权限/捕获；如果主端可见而子端黑，问题更可能在 WebRTC、解码或视频元素渲染。

## 8. 连接卡在协商中

MVP 没有 STUN/TURN，只面向可直接互通的局域网。检查：

- 两端主机防火墙是否阻止 WebRTC 动态 UDP；
- VPN、企业 EDR 或安全软件是否过滤 ICE/DTLS；
- 是否处于仅能访问网关、不能客户端互访的无线网络；
- 双端系统时间是否严重异常（证书/DTLS 行为可能受影响）；
- 两端是否为相同协议版本。

成功建立 WebSocket 不代表 WebRTC 媒体一定可达。

## 9. 画面卡顿、模糊或延迟高

一次只调整一个变量：

1. 降为 1920×1080、30 FPS、8 Mbps、关闭 HiDPI。
2. 改用有线网络，或靠近 5/6 GHz AP；避免 2.4 GHz 拥塞。
3. 关闭 Mac/Windows 上的高负载编码、游戏、虚拟机和屏幕录制软件。
4. 若卡顿但带宽充足，降低 FPS；若稳定但块状模糊，逐步提高码率。
5. 若 CPU/GPU 饱和，降低分辨率；HiDPI 可能让物理像素量增加四倍。
6. 连续测试至少 10 分钟，记录任务管理器/活动监视器和网络丢包，不使用单次主观感受做结论。

码率是发送目标，实际 WebRTC 会受带宽估计和编码器约束影响；GUI 数值不保证线上恒定码率。

## 10. 全屏或窗口问题

- 使用子端顶部按钮或画面悬浮按钮退出/进入全屏；Esc 也会退出全屏。
- 多显示器 Windows 上，先把子端窗口移到目标物理屏，再进入全屏。
- 若应用在断开后仍阻止显示休眠，正常退出子端并记录复现；会话关闭处理应停止 blocker。
- 若窗口在睡眠/唤醒后黑屏，断开并重新建立 WebRTC；MVP 尚未声明完整的睡眠恢复保证。

## 11. 键鼠或剪贴板共享问题

### 鼠标到边缘后没有切换

1. 确认主端“键鼠与剪贴板共享”显示“共享运行中”。
2. 在 macOS“隐私与安全性 → 辅助功能”允许当前 LanExtend 副本；源码、构建目录和 `/Applications` 中的副本可能被系统视为不同程序。
3. 在布局画布确认橙色 Windows 矩形与目标 Mac 矩形真正贴边，没有缝隙或重叠；可先点“自动排列”。
4. 把边缘停留临时调为 `0 ms`，持续向该边缘移动鼠标测试。
5. 源码版执行 `native/macos/.build/lanextend-input --probe`，应返回 `trusted: true`。

如果显示“输入助手提前退出”，先记录括号内退出码和冒号后的 stderr。v0.4.1 修复了 macOS 26 上无提示权限探测的崩溃，并让 Windows helper 通过显式 UTF-8 管道读写，避免在 Electron 隐藏子进程中修改 Console 编码而提前退出。

### 控制权没有返回 Mac

按 `Control + Option + Command + Esc`。该组合由 Mac helper 本地处理，会释放 Windows 上所有已按下的键并把鼠标送回进入时的 Mac 显示器。helper 进程退出后 macOS 也会恢复正常本地输入。

### Windows 能移动鼠标但快捷键不符合预期

默认按物理键映射：Mac `Command` 对应 Windows `Ctrl`、`Option` 对应 `Alt`、Mac `Control` 对应 Windows 键。当前版本没有自定义键位映射页面。

### 文本剪贴板没有同步

- 文本开关只同步纯文本，不同步图片、富文本或剪贴板历史；文件使用旁边的独立开关。
- 确认主端“纯文本剪贴板”开关已启用，并且键鼠共享会话仍在线。
- 超过 128 KiB 的文本会被忽略；缩短文本后重试。
- 部分密码管理器或受保护应用会阻止读取系统剪贴板。

### 文件或文件夹没有同步

1. 确认“文件与文件夹同步”开关已打开，并且双端都已升级到协议 v3。
2. 复制后观察两端文件卡片。若始终停在“等待另一台设备接收”，检查发送端专用网络入站动态 TCP 是否被防火墙拦截；文件端口每次启动由系统随机分配，不是固定 `47772`。
3. 文件清单超过 10000 项、普通文件合计超过 20 GiB、顶层超过 16 项时会拒绝；拆分后重试。
4. 符号链接、socket、device 等特殊项目会跳过；请复制实际普通文件。macOS resource fork、Finder 标签、ACL 和 Windows NTFS 扩展属性不会保留。
5. 若显示“完整性校验失败”或“清单不一致”，原文件可能在发送期间被修改；等待写入完成后重新复制。
6. 剪贴板只会在全部内容校验并提交后更新。接收中途取消或断线不会留下可粘贴的半成品。
7. Windows helper 必须以 STA 运行；使用官方程序或 `npm run dev:receiver`，不要直接在 MTA PowerShell 作业中嵌入脚本。

接收缓存位于 Electron userData 的 `clipboard-files` 目录，完成内容保留 7 天。需要立即释放空间时，先退出 LanExtend，再只删除该目录中确认不再需要的传输 UUID 子目录；不要删除整个 userData。

## 12. 记忆设备错误或配置损坏

### IP 变更

重新发现相同设备 UUID 后，在线记录应覆盖记忆中的旧 IP。若广播不可用，忘记旧设备并用新私有 IP 手动添加。

### 名称/UUID 重复

克隆 Windows 用户数据目录可能复制子端 UUID，导致主端把两台机器合并。退出被克隆的子端，备份并重命名其 `settings.json`，让它生成新 UUID，再重新命名和连接。

### 重置设置

完全退出应用，备份后重命名 Electron userData 目录中的 `settings.json`。不要直接删除整个 userData 目录，里面可能有 Chromium/Electron 其他状态。

## 13. GitHub Actions 构建失败

- `npm ci` 失败：确认 `package.json` 与 `package-lock.json` 同步、registry 可用。
- Mac 原生构建失败：查看 `xcrun`/SDK/Clang 错误和 Objective-C `-Werror` 输出。
- electron-builder 找不到 helper：确认 `npm run dist:mac` 先运行 native build，且 `.build/lanextend-vdisplay` 与 `.build/lanextend-input` 都存在。
- 上传提示无匹配文件：检查 `release/` 与 `artifactName`，不要用 `if-no-files-found: ignore` 隐藏打包失败。
- Windows 构建意外尝试 Mac helper：`build-native.mjs` 在非 macOS 应明确打印 skip 并成功退出。

CI 通过后仍需双机手工验收；CI 失败时不要发布上一次残留的 `release/` 文件。
