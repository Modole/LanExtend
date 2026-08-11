# 构建产物与发布说明

## 1. 当前交付级别

`.github/workflows/build.yml` 生成的是**开发/验收 artifacts**，不是面向最终用户的正式 Release：

- macOS job：测试、构建含 `arm64`/`x86_64` 的 universal2 私有 API helper，并以 `--universal` 打包 DMG/ZIP；
- Windows job：测试，打包 portable EXE/ZIP；
- 两端均未配置正式代码签名；Mac 未公证；
- workflow 不创建 GitHub Release、不上传商店、不自动更新。

Artifacts 保留 14 天，名称包含平台；实际文件名由 electron-builder 的 `LanExtend-${version}-${os}-${arch}.${ext}` 规则生成。

## 2. 触发与权限

工作流在 push、Pull Request 和手动触发时运行，权限仅为：

```yaml
permissions:
  contents: read
```

它不会写仓库、创建 tag/Release 或访问部署环境。未来签名工作流应与 PR 构建分离，仅允许受保护 tag/环境读取证书 secrets，避免来自 fork 的代码接触签名身份。

## 3. 下载并核对 CI artifacts

1. 打开目标提交对应的 `Build desktop artifacts` Actions 运行。
2. 确认 commit SHA、两个 job 和测试日志。
3. 分别下载 `LanExtend-macOS-*` 与 `LanExtend-Windows-*` artifact。
4. 解压后计算 SHA-256 并写入验收记录。

macOS：

```bash
shasum -a 256 release/LanExtend-*
```

Windows PowerShell：

```powershell
Get-FileHash .\release\LanExtend-* -Algorithm SHA256
```

不要把不同 Actions 运行或不同提交的主端/子端混为一个候选版本，协议可能不兼容。

## 4. 本地候选构建

Mac：

```bash
npm ci
npm test
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

Windows：

```powershell
npm ci
npm test
npm run dist:win
```

本地构建只能用于调试/验收。正式包应来自可审计、受保护且保存 provenance 的发布工作流。

## 5. 正式发布前阻塞项

### 通用

- [ ] 版本、tag、锁文件、变更日志一致。
- [ ] `npm ci` 和单元测试在两端原生 runner 通过。
- [ ] [验收清单](acceptance.md)全部 P0 有实测记录。
- [ ] `THIRD_PARTY_NOTICES.md`、Electron 内置许可证和锁定依赖完成审查。
- [ ] 生成 SHA-256、SBOM、依赖/恶意软件扫描结果和回滚说明。
- [ ] 发布页醒目标明：可信内网、无认证、私有 API、系统要求、单子端及不支持项。

### macOS

- [ ] 用 `lipo` 验证 Universal app 与 helper 都包含 `arm64`/`x86_64` slices，并分别在 Apple Silicon/Intel 真机验收；Universal 打包成功不能替代两种硬件测试。
- [ ] 使用组织受控的 `Developer ID Application` 身份签名 app、helper 和外层 DMG/ZIP 所需内容。
- [ ] 检查 hardened runtime/entitlements 与屏幕捕获、本地网络行为；不增加无关权限。
- [ ] 提交 Apple notarization、等待成功并 staple ticket。
- [ ] 在一台未安装开发证书、未授权过应用的干净 Mac 上验证 Gatekeeper、权限和运行。
- [ ] 明确**不支持 Mac App Store**：`CGVirtualDisplay` 是私有 API，不能把 App Store 作为发布目标。

### Windows

- [ ] 使用组织受控的 Authenticode 证书签名 portable EXE（及未来安装器）。
- [ ] 在干净 Windows 10/11 上验证签名、SmartScreen、Defender、防火墙提示和卸载/清理。
- [ ] 若未来增加安装器/服务/驱动，另做管理员权限、升级和恢复审查；当前 MVP 没有这些组件。

## 6. 签名 secrets 原则

- 不把证书、私钥、密码或 notarization 凭据提交到仓库。
- PR/fork workflow 永远不读取签名 secrets。
- 使用受保护 GitHub Environment、最少批准者和仅 tag 触发。
- 日志禁止打印 base64 证书、临时 keychain 密码或 API 私钥。
- job 结束时销毁临时 keychain/证书文件；凭据定期轮换和可撤销。
- 签名 job 应从已经测试的不可变产物继续，而不是在另一套依赖状态下重新随意构建。

本仓库当前 workflow 故意不包含占位 secrets，以免让未签名 artifacts 被误认成正式包。

## 7. 版本与兼容性

建议使用 SemVer：

- patch：同协议的修复；
- minor：向后兼容 GUI/能力增加；
- major：协议、安全模型、配置不可兼容变化。

`PROTOCOL_VERSION` 与应用 SemVer 独立。只要线协议有不兼容变化，就必须提升协议版本并在发布说明中列出主/子端兼容矩阵。

由于无自动更新，主端和子端应从同一 Release 安装。协议不匹配时应失败关闭，不尝试静默降级。

## 8. 发布页必须包含的限制

建议直接使用以下摘要，不要删减为模糊营销文案：

> LanExtend 当前支持 macOS 14+ 主端到 Windows 10/11 64 位子端的一主一子视频扩展屏。仅用于可信 IPv4 局域网；当前无设备认证，禁止公网暴露。MVP 不支持音频、输入回传、HDR、多子端、IPv6 或跨网中继。macOS 虚拟显示依赖 Apple 未公开 API，系统更新可能导致失效，不支持 Mac App Store。

另外列出本次真实测试的 OS build、CPU 架构、网络和已知问题。未测平台必须写“未测”，不能仅写“理论支持”。

## 9. 回滚

正式发布至少保留上一个已签名版本和哈希。发生以下任一情况应停止分发并回滚：

- 捕获源可能默默切换到主屏或泄露错误显示器；
- helper 无法释放、导致 WindowServer 异常或系统不稳定；
- 发现/信令被误暴露公网；
- 依赖/签名证书出现高危供应链事件；
- 新 macOS/Windows 更新使核心路径不可用。

回滚不应自动恢复旧的明文设备信任状态；当前记忆本来就不是认证数据。
