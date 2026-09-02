# TodoDock 测试与验证

## 自动化质量门禁

前端完整门禁：

```powershell
npm run check
```

它依次执行 ESLint、TypeScript、Vitest、Vite 生产构建，以及安装器多语言配置核对。

Rust 门禁：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

三平台构建由 `.github/workflows/ci.yml` 执行，矩阵覆盖 Windows/Linux x64 与 arm64、macOS Apple Silicon 与 Intel；可分发包由手动触发的 `.github/workflows/package.yml` 生成。Linux job 显式安装 `pkg-config`、`libdbus-1-dev`、WebKit、托盘和 SVG 依赖，避免依赖 runner 的预装状态。

## 性能探针

1 万条 Todo 搜索探针：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml measures_ten_thousand_todo_search_latency -- --ignored --nocapture
```

1 万条 Todo 后台提醒扫描探针：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml measures_ten_thousand_todo_reminder_scan_latency -- --ignored --nocapture
```

两个探针都生成固定规模数据并运行 30 次，报告 P95。调试构建的宽松失败阈值为 1000ms；产品规格中的 100ms 目标必须以发布构建和固定基准机数据判断。

## 已自动覆盖

- SQLite 迁移、CRUD、搜索通配符转义、软删除和撤销恢复。
- 每个 Todo 的单次临近/到期提醒、跨扫描与提醒模式切换去重、完成后取消，以及应用内提醒队列的持久保留、显式确认、100 条边界和前端事件去重。
- 无目标或远期目标的等待最多 60 秒重新核对一次系统时钟，作为桌面休眠恢复和系统时钟变化的有界补偿机制。
- 静默时段的白天与跨午夜计算。
- 静默结束时间在夏令时跳时中不存在时向后解析到首个有效分钟，歧义时刻选择较晚结果。
- 设置持久化和非法设置拒绝。
- 左/右/上边缘检测、多屏负坐标与工作区钳制。
- Linux Wayland 能力检测同时识别 `WAYLAND_DISPLAY` 和 `XDG_SESSION_TYPE=wayland`，定位能力与设置页使用同一判定。
- 脱敏诊断文件复用同一 Wayland 判定，避免能力页和诊断数据对会话类型产生不一致结论。
- 数据库迁移前一致性备份、v1 到 v2 持久提醒队列迁移、未来 schema 拒绝、未提交事务重开回滚。
- 版本化 JSON 导出、只合并 Todo 且保留本机设置的导入、导入/精确恢复失败时的事务整体回滚、恢复预览和未知格式拒绝。
- 落盘同步后的原子 JSON/Markdown 数据文件写入、唯一备份文件名、最新 10 份轮换和 20MB 导入限制。
- Markdown 原始 HTML 丢弃、GFM、危险链接协议和远程图片不自动加载。
- Markdown 标题、强调、嵌套/任务列表、代码块、表格、链接和图片占位的 DOM→Markdown 转换，以及视觉/源码模式往返。
- 浏览器预览中的本地 CRUD、删除恢复、归档、排序、清理和设置持久化适配器。
- 应用内提醒横幅的单项/汇总展示、查看和忽略动作。
- 快捷键启用设置的默认值，以及旧版设置缺少该字段时的兼容解码。
- Todo 归档/恢复、键盘排序、deadline 与单 Todo 提醒保存、无托盘生命周期降级和诊断文件隐私字段。
- 关闭贴边隐藏设置时会立即唤回当前已隐藏的贴边窗口；运行时设置回滚失败会在错误中明确提示。
- 关闭到托盘说明只有在窗口成功隐藏后才持久化，隐藏失败会回滚说明状态。
- 点击编辑会打开独立窗口而不是主窗口模态框；编辑器关闭后恢复到打开它的控件焦点。
- 导入数据拒绝状态与完成/归档时间戳不一致或更新时间早于创建时间的 Todo；完成已归档 Todo 会清除归档时间戳；修改截止时间会重置该 Todo 的提醒历史。
- 所见即所得编辑器中的链接保持可编辑，不会触发 WebView 导航。
- 所见即所得编辑器获得焦点后卸载隐藏 Markdown 解析模板，失焦和模式切换时仍能重建视觉内容。
- `prefers-reduced-motion` 会将界面动画与过渡压缩为即时状态，保留所有交互与滚动可用性。
- 自动通知权限请求在单次运行周期内只尝试一次，设置页显式请求仍可重试。
- 全局快捷键替换失败时会尝试恢复旧快捷键，避免部分注销造成无快捷键状态。
- 搜索/筛选和分页请求使用版本门控，旧的异步响应不会覆盖较新的查询结果。

2026-09-01 当前门禁结果：前端 15 个测试文件、53 项测试通过；Rust 45 项常规测试通过、2 项性能探针通过；本轮显式性能探针 P95 为搜索 7.89ms、提醒扫描 15.42ms。ESLint、TypeScript、Vite 生产构建、Rust fmt 与 clippy 通过。Rust 门禁与发布包均使用仓库固定的 1.85.0，而非本机默认的新版本工具链。

2026-09-01 发布矩阵审计：`scripts/verify-build-host.mjs` 已在本地用 CI 矩阵的六组 OS/架构组合模拟通过；当前官方 `actions/runner-images` 清单中存在 `windows-2025`、`windows-11-arm`、`macos-15`、`macos-15-intel`、`ubuntu-24.04` 和 `ubuntu-24.04-arm` 标签。Windows 主机构建已通过；本机尝试 Linux 目标 `cargo check` 时进入 Tauri 依赖编译并因缺少 Linux DBus sysroot 停止，已在 CI 中补齐原生依赖。尚未取得仓库实际 GitHub Actions run，因此这不是三平台构建成功证明。

## Windows 实机证据（2026-08-31）

- 最新调试构建中用快速记录一次提交标题与 GFM 任务清单，SQLite 列表立即展示 Markdown 复选框和行内代码。
- 设置页正确显示实际数据目录，并生成包含两项 Todo 的 Markdown 文件。
- 修改单一设置不再重复调用未变化的开机启动接口；关闭到托盘开关保存后无错误提示。
- 正常退出生成 `.window-state.json`，记录主窗口物理位置和尺寸；再次启动恢复到保存坐标，窗口仍完整可见。
- 移除启动时强制注册后，进程级全局快捷键仍能从 Chrome 唤起隐藏窗口并把输入框置于可输入状态；窗口已显示时再按会隐藏。注册冲突会降级为设置页提示，不再阻止应用启动。
- 在设置中关闭全局快捷键后，从 Chrome 按已配置快捷键不再唤起或隐藏窗口；重新启用并保存后，同一按键再次成功切换显示/隐藏。
- 2026-09-01 从文件资源管理器发送 `Ctrl+Shift+Space` 后窗口成功唤回；Rust 运行日志记录从快捷键到快速输入焦点为 112ms，低于 150ms 目标。Computer Use 的 WebView 无障碍层将焦点汇总为 RootWebArea，因此该次以运行时埋点作为焦点时延证据，并保留手工光标复核要求。
- 2026-09-01 快速记录 WYSIWYG 输入中文与字面量 `<script>` 文本，视觉表面正常显示且未执行；源码/视觉模式切换后内容保留。
- 先前已验证单实例、托盘隐藏/唤回、置顶和 SQLite 跨重启持久化。
- 浏览器预览在 `340×420` 与 `420×640` 视口实测无页面、应用壳层或工作区横向溢出；最小窗口下设置数据操作保持可读，保存按钮换行后右对齐。

## 仍需真实系统验证

系统级行为不能只用 DOM 或纯函数测试证明。每个目标平台发布前按 [手工验收清单](MANUAL_TESTS.md) 执行，并保存系统版本、桌面环境、DPI、显示器布局、应用构建哈希和结果。
