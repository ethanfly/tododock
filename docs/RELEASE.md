# TodoDock 发布说明

## 支持产物

Tauri 配置会按运行平台生成 Windows、macOS 和 Linux 原生包。CI 和手动 Package 工作流使用六个明确的原生目标：Windows x64/arm64、macOS arm64/x64、Linux x64/arm64；系统镜像标签固定为明确版本，不依赖含义会迁移的 `windows-latest` 或 `macos-latest`。每个任务会在编译前核对 runner 的操作系统与 CPU 架构，防止错误主机生成命名不实的产物。手动工作流生成按目标分开的未签名测试产物。

Windows NSIS 安装包（`*-setup.exe`）内嵌多语言界面，启动时按操作系统 UI 语言选择，未覆盖的语言回退到英语。MSI 按语言分别生成（当前包含 `zh-CN`、`en-US`、`zh-TW`、`ja-JP`、`ko-KR`）；需要随系统语言自动切换时使用 NSIS 安装器。`npm run check` 会核对上述安装器语言配置。

2026-09-01 Windows 本地发布构建已使用固定的 Rust 1.85.0 生成 en-US、zh-CN、zh-TW、ja-JP、ko-KR 五种 MSI 语言包和一个 NSIS 安装器。en-US/ja-JP/ko-KR MSI 各为 6,037,504 bytes（5.76 MiB），zh-CN/zh-TW MSI 各为 6,033,408 bytes（5.75 MiB），NSIS 为 4,482,347 bytes（4.27 MiB）；6 项 SHA-256 已独立复算并通过清单验证器复核，Authenticode 状态均为 `NotSigned`。zh-CN MSI 校验值为 `1f5d3caf6dae105fabc515602c050725c39756ac5d88947fe93e583da1750860`，NSIS 校验值为 `b8cd7872fac68efc58c9b3ddabef4cc5c82affa4d05c7869e0c001af4b965f64`；全部校验值见 bundle 中的 `release-manifest.json` 与 `checksums-sha256.txt`。这些产物只用于当前验收，不得以正式可信发行物名义分发。

同日已对照官方 `actions/runner-images` 清单核对六个 CI 标签和架构；配置标签均存在，Linux workflow 同时显式安装 pkg-config、DBus、WebKit、托盘、SVG 和 `xdg-utils`（AppImage 打包需要 `/usr/bin/xdg-open`）。但 Windows 本机之外仍需在目标仓库实际触发 CI 后保存每个平台的构建日志和 manifest。

正式打包后执行 `npm run release:manifest`，再执行 `npm run release:verify`。生成脚本会先确认 `package.json`、`tauri.conf.json` 与 Cargo 包版本一致，再遍历 `src-tauri/target/release/bundle`，忽略未压缩的 macOS `.app`/`.dSYM` 内部内容，生成面向可分发包的 `release-manifest.json` 和 `checksums-sha256.txt`。验证脚本独立核对应用版本、产物集合、文件字节数、SHA-256 和 checksum 文本。Package 工作流会在每个平台上传产物前强制执行两步。

推送到 `main`（提交说明不含 `chore(release)`）会运行 [Release 工作流](https://github.com/ethanfly/tododock/actions/workflows/release.yml)：先跑前端与 Rust 质量门禁，再用 `scripts/bump-version.mjs` 递增补丁版本（`0.1.0` → `0.1.1`），同步写入 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock`，提交 `chore(release): vX.Y.Z` 并打 `vX.Y.Z` 标签。随后按六个原生目标打包，把安装包和按平台区分的校验清单发布到 [GitHub Releases](https://github.com/ethanfly/tododock/releases)。某个平台 runner 不可用时其余平台仍会继续；只要至少有一份安装包就会发版。`chore(release)` 提交本身不会再次发版，避免循环。手动 `workflow_dispatch` 仍可触发 Package 工作流做未发版验收包。

## 正式发行前的必需条件

- Windows 配置受信任代码签名证书并验证 SmartScreen 安装体验。
- macOS 配置 Developer ID、Hardened Runtime、公证和 stapling。
- Linux 验证 deb/AppImage（以及决定是否提供 rpm）；记录托盘依赖。
- 所有构建输入由 lockfile 固定；产物保存校验和和构建来源。
- 自动更新器默认不启用。只有签名密钥、更新清单、失败回滚和三平台恢复测试都完成后才开放。
- 数据库迁移前创建一致性备份；导出 `formatVersion` 的兼容策略独立于应用 SemVer。

## 发布门禁

1. 本地和 CI 的全部自动化门禁通过。
2. 三平台手工清单有对应版本的记录。
3. 性能探针和真实唤起/资源采样有结果。
4. 日志、网络请求和 Tauri capability 完成隐私/权限审计。
5. 签名、公证、安装、卸载、升级和失败恢复均真实验证。
