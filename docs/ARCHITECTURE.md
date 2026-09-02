# TodoDock 架构说明

## 1. 决策摘要

采用 Tauri 2 + Rust + React/TypeScript + SQLite。

相比把完整浏览器运行时随应用分发，这条路线复用系统 WebView，通常拥有更小的发布体积和更低的常驻资源；同时把窗口、快捷键、通知、提醒调度和数据库操作留在 Rust 侧，缩小前端权限面。React 只负责视图与交互状态。

## 2. 模块边界

- `src/`：React 界面、键盘交互、Markdown 渲染/编辑、视图状态和无障碍语义。
- `src/lib/api.ts`：唯一 IPC 入口，负责运行时校验和错误归一化。
- `src-tauri/src/db.rs`：SQLite 连接、迁移、事务和查询。
- `src-tauri/src/lib.rs`：窄而强类型的 Tauri 命令、系统托盘和应用生命周期，不接受任意 SQL 或文件路径。
- `src-tauri/src/reminders.rs`：基于最近到期时间休眠的调度器、休眠恢复扫描和系统通知派发。
- `tauri-plugin-window-state`：只持久化窗口位置与尺寸，并在已保存显示器不存在时交回操作系统安全放置。
- `src-tauri/src/windowing.rs`：工作区纠正、吸附/隐藏状态机和平台能力检测。
- `src-tauri/src/zentao.rs`：可选的禅道任务同步客户端（用户触发，不经过前端任意 URL）。

前端不直接访问数据库或任意文件系统。所有持久化通过 Rust 命令完成，以便集中维护校验、事务、迁移与未来同步边界。

Markdown 编辑器是延迟加载的受控组件。视觉模式通过安全 Markdown 渲染生成可编辑 DOM，输入后立即序列化回 CommonMark/GFM；源码模式直接编辑同一字符串。剪贴板与拖放只接收纯文本，原始 HTML 不进入编辑 DOM。视觉层不保存专有 JSON，因此导出、备份与未来迁移仍只处理 Markdown。

## 3. 数据模型

首版数据库使用以下核心实体：

- `todos`：UUIDv7 主键、标题、Markdown 正文、状态、优先级、deadline UTC、提醒提前量、完成/归档/软删除时间、排序值、创建/更新时间。
- `reminder_deliveries`：Todo、deadline 版本和提醒类型的唯一投递记录，用于跨重启去重。
- `reminder_inbox`：系统通知阶段发生崩溃时仍可恢复的应用内提醒队列，最多保留最新 100 条，用户查看或忽略后才删除。
- `settings`：有 schema 的键值设置；复杂设置存版本化 JSON。
- `PRAGMA user_version`：单调递增的数据库 schema 版本；升级现有数据库前先创建 SQLite 一致性备份。

SQLite 启用 WAL、foreign keys、busy timeout。写操作使用事务；合并导入只写 Todo 并按更新时间解决冲突，不会改变本机设置；精确恢复在单一事务中替换 Todo 与设置，并由命令层在恢复前自动创建当前数据备份。时间戳统一使用 Unix 毫秒 UTC。

## 4. 进程与生命周期

应用单实例运行。主窗口关闭默认转入后台并保留托盘和提醒调度；用户选择“退出”才终止进程。提醒调度器查询最近一条待提醒记录并休眠到目标时间或数据变更信号；无近期提醒时最多每 60 秒重新核对系统时间。桌面端 Tao 不提供可靠的系统恢复事件，因此这个有界等待也是休眠和系统时钟变化后的补偿机制：即使底层等待在休眠期间暂停，恢复后最迟 60 秒重新扫描。提醒去重记录与应用内提醒在同一 SQLite 事务中写入，再发送前端可用信号和系统通知；读取队列不会删除，用户查看或忽略后才显式确认。因此通知权限拒绝、窗口尚未就绪或系统通知派发阶段崩溃都不会永久丢失应用内提醒。

## 5. 窗口状态机

窗口至少存在 `floating`、`snapped-visible`、`snapped-hidden`、`revealing` 四个状态。

- 拖动开始时进入 `floating`，暂停自动隐藏。
- 移动到工作区阈值内时记录候选边缘并反馈。
- 松开后进入 `snapped-visible`；若启用自动隐藏且窗口失焦，延迟进入 `snapped-hidden`。
- 指针进入保留把手、全局快捷键或托盘动作时进入 `revealing`，动画结束回到 `snapped-visible`。
- 编辑、菜单、模态框和提醒交互持有“隐藏抑制令牌”，令牌释放前不得隐藏。
- 隐藏动作在移动窗口前先提交 `hidden` 状态，程序化 `onMoved` 因此不能误清空贴边边缘；唤回、退出和启动恢复都会先把窗口纠正回当前显示器工作区，禁止持久化不可唤回的屏外坐标。

所有坐标以 Tauri 提供的监视器工作区为权威，并在物理/逻辑坐标转换边界集中处理。能力检测不通过时，状态机停留在 `floating` 并向 UI 暴露原因。

## 6. 安全与隐私

- Tauri capability 仅开放实际使用的窗口和系统插件权限。
- IPC 参数在 Rust 再次校验长度、枚举、时间范围和 ID 格式。
- Markdown 禁用原始 HTML；外链交给受控 opener，拒绝非预期协议；远程图片只显示保留语法的占位，不触发网络请求。
- 日志不记录用户内容；生产默认 info/error 且可由用户导出脱敏诊断。
- 导入文件视为不可信输入，限制大小、验证 schema，并在事务中应用。
- 未来更新器只接受签名包；不在首版未配置签名时假装支持自动更新。

## 7. 测试策略

- Rust 单元/集成测试：迁移、CRUD、筛选、提醒计算与去重、导入导出、窗口几何纯函数。
- React/Vitest：快速输入、IME、Markdown 安全、视觉 DOM 与 Markdown 双向转换、deadline 展示、键盘操作和能力降级。
- 端到端/手工：全局快捷键、系统通知、托盘、always-on-top、多显示器、吸附和自动隐藏。
- CI：Windows、macOS、Ubuntu 原生构建；Rust fmt/clippy/test 与前端 lint/typecheck/test/build。
- 性能：固定数据生成器、1 万条查询基准、唤起时间埋点（仅本地输出）和空闲资源采样。

## 8. 版本与发布

应用版本遵循 SemVer。数据库迁移只前进且有备份；导出格式拥有独立 `formatVersion`。Rust 1.85.0 由仓库工具链文件固定并在三平台 CI 读取。每个平台打包后生成含提交、构建器版本、文件大小和 SHA-256 的清单。首个公开构建前确定 Windows 签名、macOS Developer ID/公证和 Linux 包格式。自动更新在三平台签名验证与失败回滚测试完成后再启用。

## 9. 参考的官方能力文档

- [Tauri Global Shortcut](https://v2.tauri.app/plugin/global-shortcut/)
- [Tauri Notification](https://v2.tauri.app/plugin/notification/)
- [Tauri Autostart](https://v2.tauri.app/plugin/autostart/)
- [Tauri Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
- [Tauri Distribution](https://v2.tauri.app/distribute/)

这些文档用于确认 API 能力；具体平台限制仍以真实系统验证为准。
