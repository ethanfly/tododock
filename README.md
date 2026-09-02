# TodoDock

TodoDock 是一款本地优先、性能优先的跨平台桌面 Todo 应用。它把快速记录、Markdown、截止时间与提醒放进一个可置顶、可吸附并能贴边隐藏的小窗口中。

当前工作目标由本任务中的持久 Goal 管理。产品边界、交互语义和验收条件见 [产品规格](docs/PRODUCT.md)，技术决策见 [架构说明](docs/ARCHITECTURE.md)。

## 技术栈

- Tauri 2 + Rust：桌面壳、SQLite、提醒调度、窗口与系统集成
- React 19 + TypeScript + Vite：界面
- SQLite：单文件本地持久化，WAL、迁移和原子事务

## 当前能力

- 默认可用 `Alt + Space` 老板键隐藏/唤回窗口，快捷键可在设置中按键录入；标题、Markdown 正文和 deadline 可以一次记录。
- 可选从禅道同步指派给自己的任务（需在设置中填写地址和账号并手动触发）。
- Markdown 默认所见即所得编辑，提供源码模式与常用格式工具；保存格式仍是可移植的 Markdown，不绑定私有富文本结构。
- 左/右/上边缘吸附与自动隐藏，窗口置顶、自由拖动，位置和尺寸跨重启恢复。
- 本地提醒调度、静默时段、系统休眠后补发和重复提醒去重；系统通知不可用时仍显示应用内提醒。
- 单实例、系统托盘（快速新建、今天、设置）、开机启动、后台启动和关闭到托盘。
- 版本化 JSON 合并导入、精确备份恢复、Markdown 清单导出和最多 10 份自动轮换备份。
- 支持拖拽/键盘排序、归档与恢复、分页加载；删除先软删除，并在界面提供 8 秒撤销入口。
- 首次关闭会解释后台驻留；无系统托盘时自动降级为关闭即退出，避免产生无法唤回的隐藏进程。
- 可导出不含 Todo 标题和正文的脱敏诊断文件。

## 本地开发

```powershell
npm install
npm run tauri dev
```

仅运行 Web 界面：

```powershell
npm run dev
```

质量门禁：

```powershell
npm run check
npm run test
npm run tauri build -- --debug
```

正式打包后运行 `npm run release:manifest`，会在 bundle 目录生成包含构建工具链、文件大小和 SHA-256 的 `release-manifest.json` 与 `checksums-sha256.txt`；随后运行 `npm run release:verify`，独立核对产物集合、字节数和哈希。Rust 工具链由仓库根目录的 `rust-toolchain.toml` 固定为 1.85.0。

推送到 `main` 会自动递增补丁版本（例如 `0.1.0` → `0.1.1`）、构建各平台安装包，并发布到 [GitHub Releases](https://github.com/ethanfly/tododock/releases)。版本号同时写在 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml`。

## 隐私

默认不需要账号，不上传 Todo、Markdown 正文或使用数据。Markdown 外链只有用户点击后才交给系统打开，远程图片不会自动联网加载。导出、备份和未来可能出现的同步能力都必须由用户明确触发。审计边界和证据见 [隐私审计](docs/PRIVACY.md)。

## 数据、备份与恢复

设置页会显示当前系统的准确数据目录。典型位置如下：

- Windows：`%APPDATA%\com.tododock.desktop`
- macOS：`~/Library/Application Support/com.tododock.desktop`
- Linux：`$XDG_DATA_HOME/com.tododock.desktop`，未设置时通常是 `~/.local/share/com.tododock.desktop`

`tododock.db` 是主数据库，`backups/` 保存最新 10 份轮换 JSON 备份以及数据库升级前自动创建的一致性 SQLite 备份，`exports/` 保存用户主动创建的 JSON 或 Markdown 导出。设置页的“导入”只合并 Todo，不改动本机设置：它会预览新增/更新数量，同一 ID 由 `updatedAt` 较新的版本胜出。“恢复”则把当前 Todo 和设置精确替换成备份内容，预览新增/替换/移除数量，并在执行前自动备份当前数据。请不要在应用运行时直接替换 SQLite 主文件。

## 平台限制与发行状态

- Windows 10/11 是当前已实际运行和打包验证的平台。
- macOS 与 Linux 已配置原生 CI 和打包任务；构建矩阵明确覆盖 Windows/Linux 的 x64 与 arm64，以及 macOS 的 Apple Silicon 与 Intel。发布前仍必须完成对应系统的通知、托盘、快捷键与多屏实机验收。
- Linux Wayland 合成器通常禁止应用设置绝对窗口位置；检测到 Wayland 时会关闭贴边吸附/自动隐藏，并在设置页说明原因。Todo、Markdown、本地存储和显式隐藏仍可使用。
- 当前本地安装包尚未进行 Windows 代码签名或 macOS 公证。自动更新在签名验证和失败回滚完成前保持关闭。

完整手工检查步骤见 [验收清单](docs/MANUAL_TESTS.md)，性能实测见 [性能基线](docs/PERFORMANCE.md)。
