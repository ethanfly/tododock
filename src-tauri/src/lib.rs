mod data_files;
mod db;
mod llm;
mod models;
mod reminders;
mod windowing;
mod zentao;

use std::collections::VecDeque;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc::SyncSender,
};
use std::time::Instant;

use db::{Database, DueReminder, ReminderAcknowledgement};
use models::{
    AppCapabilities, AppSettings, CreateTodoInput, DataFileResult, GeneratedTodoDraft,
    ImportPreview, ListTodosInput, LlmImageInput, RestorePreview, Todo, UpdateTodoInput,
    ZentaoSyncResult,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri_plugin_window_state::{AppHandleExt as WindowStateExt, StateFlags};

const MAX_SHORTCUT_TIMING_SAMPLES: usize = 100;

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TimingSummary {
    sample_count: usize,
    latest_ms: Option<u64>,
    p50_ms: Option<u64>,
    p95_ms: Option<u64>,
}

struct AppState {
    database: Arc<Database>,
    reminder_wake: SyncSender<()>,
    shortcut_error: Mutex<Option<String>>,
    tray_available: AtomicBool,
    started_at: Instant,
    frontend_ready_ms: Mutex<Option<u64>>,
    shortcut_started_at: Mutex<Option<Instant>>,
    shortcut_focus_samples: Mutex<VecDeque<u64>>,
}

fn persisted_window_flags() -> StateFlags {
    StateFlags::POSITION | StateFlags::SIZE
}

fn should_close_to_tray(tray_available: bool, settings: Option<&AppSettings>) -> bool {
    tray_available && settings.is_none_or(|settings| settings.close_to_tray)
}

impl AppState {
    fn wake_reminders(&self) {
        let _ = self.reminder_wake.try_send(());
    }

    fn set_shortcut_error(&self, value: Option<String>) {
        match self.shortcut_error.lock() {
            Ok(mut error) => *error = value,
            Err(_) => log::error!("global shortcut error state lock poisoned"),
        }
    }

    fn shortcut_error(&self) -> Option<String> {
        self.shortcut_error
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| {
                log::error!("global shortcut error state lock poisoned");
                Some("无法读取全局快捷键状态".to_string())
            })
    }

    fn set_tray_available(&self, available: bool) {
        self.tray_available.store(available, Ordering::Relaxed);
    }

    fn tray_available(&self) -> bool {
        self.tray_available.load(Ordering::Relaxed)
    }

    fn mark_frontend_ready(&self) -> Result<u64, String> {
        let mut value = self.frontend_ready_ms.lock().map_err(|_| {
            log::error!("frontend ready metric lock poisoned");
            "无法记录启动性能".to_string()
        })?;
        let elapsed = *value.get_or_insert_with(|| self.started_at.elapsed().as_millis() as u64);
        log::info!("frontend ready after {elapsed} ms");
        Ok(elapsed)
    }

    fn mark_shortcut_started(&self) {
        match self.shortcut_started_at.lock() {
            Ok(mut value) => *value = Some(Instant::now()),
            Err(_) => log::error!("shortcut start metric lock poisoned"),
        }
    }

    fn mark_capture_focused(&self) -> Result<Option<u64>, String> {
        let started = self
            .shortcut_started_at
            .lock()
            .map_err(|_| "无法读取快捷键性能起点".to_string())?
            .take();
        let Some(started) = started else {
            return Ok(None);
        };
        let elapsed = started.elapsed().as_millis() as u64;
        let mut samples = self
            .shortcut_focus_samples
            .lock()
            .map_err(|_| "无法记录快捷键性能".to_string())?;
        samples.push_back(elapsed);
        if samples.len() > MAX_SHORTCUT_TIMING_SAMPLES {
            samples.pop_front();
        }
        log::info!("global shortcut focused capture after {elapsed} ms");
        Ok(Some(elapsed))
    }

    fn runtime_metrics(&self) -> (Option<u64>, TimingSummary) {
        let frontend = self.frontend_ready_ms.lock().ok().and_then(|value| *value);
        let shortcut = self
            .shortcut_focus_samples
            .lock()
            .map(|samples| summarize_timings(&samples))
            .unwrap_or_else(|_| summarize_timings(&VecDeque::new()));
        (frontend, shortcut)
    }
}

fn summarize_timings(samples: &VecDeque<u64>) -> TimingSummary {
    let mut sorted = samples.iter().copied().collect::<Vec<_>>();
    sorted.sort_unstable();
    let percentile = |value: usize| {
        (!sorted.is_empty()).then(|| {
            let index = (sorted.len() * value).div_ceil(100).saturating_sub(1);
            sorted[index]
        })
    };
    TimingSummary {
        sample_count: samples.len(),
        latest_ms: samples.back().copied(),
        p50_ms: percentile(50),
        p95_ms: percentile(95),
    }
}

#[tauri::command]
fn list_todos(
    state: tauri::State<'_, AppState>,
    input: ListTodosInput,
    limit: i64,
    offset: i64,
) -> Result<Vec<Todo>, String> {
    state.database.list_todos_page(&input, limit, offset)
}

#[tauri::command]
fn get_todo(state: tauri::State<'_, AppState>, id: String) -> Result<Todo, String> {
    state.database.get_todo(&id)
}

#[tauri::command]
fn create_todo(state: tauri::State<'_, AppState>, input: CreateTodoInput) -> Result<Todo, String> {
    let todo = state.database.create_todo(&input)?;
    state.wake_reminders();
    Ok(todo)
}

#[tauri::command]
fn update_todo(state: tauri::State<'_, AppState>, input: UpdateTodoInput) -> Result<Todo, String> {
    let todo = state.database.update_todo(&input)?;
    state.wake_reminders();
    Ok(todo)
}

#[tauri::command]
fn set_todo_completed(
    state: tauri::State<'_, AppState>,
    id: String,
    completed: bool,
) -> Result<Todo, String> {
    let todo = state.database.set_completed(&id, completed)?;
    state.wake_reminders();
    Ok(todo)
}

#[tauri::command]
fn set_todo_archived(
    state: tauri::State<'_, AppState>,
    id: String,
    archived: bool,
) -> Result<Todo, String> {
    let todo = state.database.set_archived(&id, archived)?;
    state.wake_reminders();
    Ok(todo)
}

#[tauri::command]
fn reorder_todos(state: tauri::State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state.database.reorder_todos(&ids)
}

#[tauri::command]
fn delete_todo(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.database.soft_delete(&id)?;
    state.wake_reminders();
    Ok(())
}

#[tauri::command]
fn restore_todo(state: tauri::State<'_, AppState>, id: String) -> Result<Todo, String> {
    let todo = state.database.restore_deleted(&id)?;
    state.wake_reminders();
    Ok(todo)
}

#[tauri::command]
fn purge_deleted_todos(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    state.database.purge_deleted()
}

#[tauri::command]
fn get_capabilities(state: tauri::State<'_, AppState>) -> AppCapabilities {
    let wayland = windowing::is_wayland_session();

    let shortcut_error = state.shortcut_error();
    let mut reasons = Vec::new();
    if wayland {
        reasons.push(
            "当前 Wayland 合成器可能禁止应用精确定位窗口；贴边吸附和自动隐藏已降级。".to_string(),
        );
    }
    if let Some(error) = &shortcut_error {
        reasons.push(error.clone());
    }
    if !state.tray_available() {
        reasons.push(
            "当前桌面环境不提供系统托盘；关闭按钮将直接退出，请使用窗口按钮或全局快捷键。"
                .to_string(),
        );
    }

    AppCapabilities {
        edge_snap: !wayland,
        edge_hide: !wayland,
        global_shortcut: shortcut_error.is_none(),
        notifications: true,
        tray: state.tray_available(),
        reason: (!reasons.is_empty()).then(|| reasons.join(" ")),
    }
}

#[tauri::command]
fn snap_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, windowing::WindowDockState>,
) -> Result<windowing::DockSnapshot, String> {
    windowing::snap(&window, &state)
}

#[tauri::command]
fn reconcile_window_position(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, windowing::WindowDockState>,
) -> Result<windowing::DockSnapshot, String> {
    windowing::reconcile(&window, &state)
}

#[tauri::command]
fn hide_docked_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, windowing::WindowDockState>,
) -> Result<windowing::DockSnapshot, String> {
    if auxiliary_window_is_open(window.app_handle()) {
        return state.snapshot();
    }
    windowing::hide(&window, &state)
}

fn auxiliary_window_is_open(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| windowing::is_auxiliary_window_label(label))
}

#[tauri::command]
async fn open_auxiliary_window(
    app: tauri::AppHandle,
    kind: String,
    id: Option<String>,
) -> Result<(), String> {
    show_or_create_auxiliary_window(&app, &kind, id.as_deref()).await
}

async fn show_or_create_auxiliary_window(
    app: &tauri::AppHandle,
    kind: &str,
    id: Option<&str>,
) -> Result<(), String> {
    let spec = windowing::auxiliary_window_spec(kind, id)?;
    if let Some(existing) = app.get_webview_window(&spec.label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let always_on_top = app
        .try_state::<AppState>()
        .and_then(|state| state.database.load_settings().ok())
        .is_some_and(|settings| settings.always_on_top);

    WebviewWindowBuilder::new(app, &spec.label, WebviewUrl::App(spec.url.into()))
        .title(&spec.title)
        .inner_size(spec.width, spec.height)
        .min_inner_size(340.0, 420.0)
        .decorations(false)
        .resizable(true)
        .shadow(true)
        .center()
        .always_on_top(always_on_top)
        .build()
        .map_err(|error| format!("无法打开{}窗口：{error}", spec.title))?;
    Ok(())
}

#[tauri::command]
fn reveal_docked_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, windowing::WindowDockState>,
) -> Result<windowing::DockSnapshot, String> {
    windowing::reveal(&window, &state)
}

#[tauri::command]
fn set_edge_auto_hide(
    state: tauri::State<'_, windowing::WindowDockState>,
    enabled: bool,
) -> Result<windowing::DockSnapshot, String> {
    state.set_auto_hide(enabled)
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Result<AppSettings, String> {
    state.database.load_settings()
}

#[tauri::command]
fn list_in_app_reminders(state: tauri::State<'_, AppState>) -> Result<Vec<DueReminder>, String> {
    state.database.list_pending_reminders()
}

#[tauri::command]
fn acknowledge_in_app_reminders(
    state: tauri::State<'_, AppState>,
    reminders: Vec<ReminderAcknowledgement>,
) -> Result<usize, String> {
    state.database.acknowledge_pending_reminders(&reminders)
}

#[tauri::command]
fn record_frontend_ready(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    state.mark_frontend_ready()
}

#[tauri::command]
fn record_capture_focused(state: tauri::State<'_, AppState>) -> Result<Option<u64>, String> {
    state.mark_capture_focused()
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    dock_state: tauri::State<'_, windowing::WindowDockState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let previous = state.database.load_settings()?;
    state.database.save_settings(&settings)?;
    let target = app.get_webview_window("main").unwrap_or(window);
    if let Err(error) = apply_runtime_settings(
        &app,
        &target,
        &dock_state,
        &previous,
        &settings,
        state.shortcut_error().is_some(),
    ) {
        if let Err(rollback_error) = state.database.save_settings(&previous) {
            return Err(format!("{error}；同时无法恢复原本地设置：{rollback_error}"));
        }
        return Err(error);
    }
    state.set_shortcut_error(None);
    state.wake_reminders();
    Ok(settings)
}

#[tauri::command]
fn sync_zentao_tasks(state: tauri::State<'_, AppState>) -> Result<ZentaoSyncResult, String> {
    let settings = state.database.load_settings()?;
    let tasks = zentao::fetch_my_tasks(&settings)?;
    let result =
        state
            .database
            .sync_external_todos("zentao", &tasks, settings.default_reminder_minutes)?;
    state.wake_reminders();
    Ok(result)
}

#[tauri::command]
fn generate_todos_from_images(
    state: tauri::State<'_, AppState>,
    images: Vec<LlmImageInput>,
) -> Result<Vec<GeneratedTodoDraft>, String> {
    let settings = state.database.load_settings()?;
    llm::generate_todos_from_images(&settings, &images)
}

#[tauri::command]
fn acknowledge_close_to_tray(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettings, String> {
    let mut settings = state.database.load_settings()?;
    let previous = settings.clone();
    settings.close_to_tray_explained = true;
    state.database.save_settings(&settings)?;
    if let Err(error) = window.hide() {
        log::error!("failed to hide window after close explanation: {error}");
        if let Err(rollback_error) = state.database.save_settings(&previous) {
            return Err(format!(
                "无法隐藏 TodoDock 窗口；同时无法恢复关闭行为设置：{rollback_error}"
            ));
        }
        return Err("无法隐藏 TodoDock 窗口".to_string());
    }
    Ok(settings)
}

fn apply_runtime_settings(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    dock_state: &windowing::WindowDockState,
    previous: &AppSettings,
    settings: &AppSettings,
    retry_shortcut: bool,
) -> Result<(), String> {
    let autostart_changed = settings.launch_at_login != previous.launch_at_login;
    let pin_changed = settings.always_on_top != previous.always_on_top;
    let dock_changed = settings.auto_hide != previous.auto_hide;

    if autostart_changed {
        set_autostart(app, settings.launch_at_login)?;
    }
    if pin_changed {
        if let Err(error) = window.set_always_on_top(settings.always_on_top) {
            let rollback = rollback_runtime_settings(
                app,
                window,
                dock_state,
                previous,
                autostart_changed,
                false,
                false,
            );
            return Err(with_runtime_rollback(
                format!("无法更新窗口置顶状态：{error}"),
                rollback,
            ));
        }
    }
    if dock_changed {
        if let Err(error) = dock_state.set_auto_hide(settings.auto_hide) {
            let rollback = rollback_runtime_settings(
                app,
                window,
                dock_state,
                previous,
                autostart_changed,
                pin_changed,
                false,
            );
            return Err(with_runtime_rollback(error, rollback));
        }
        if !settings.auto_hide {
            if let Err(error) = windowing::reveal(window, dock_state) {
                let rollback = rollback_runtime_settings(
                    app,
                    window,
                    dock_state,
                    previous,
                    autostart_changed,
                    pin_changed,
                    true,
                );
                return Err(with_runtime_rollback(
                    format!("无法显示贴边窗口：{error}"),
                    rollback,
                ));
            }
        }
    }
    if let Err(error) = apply_global_shortcut(app, previous, settings, retry_shortcut) {
        let rollback = rollback_runtime_settings(
            app,
            window,
            dock_state,
            previous,
            autostart_changed,
            pin_changed,
            dock_changed,
        );
        return Err(with_runtime_rollback(error, rollback));
    }
    Ok(())
}

fn registered_shortcuts(settings: &AppSettings) -> Vec<String> {
    if !settings.global_shortcut_enabled {
        return Vec::new();
    }
    vec![
        settings.create_shortcut.clone(),
        settings.global_shortcut.clone(),
    ]
}

fn apply_global_shortcut(
    app: &tauri::AppHandle,
    previous: &AppSettings,
    settings: &AppSettings,
    retry_shortcut: bool,
) -> Result<(), String> {
    let previous_keys = if retry_shortcut {
        Vec::new()
    } else {
        registered_shortcuts(previous)
    };
    let next_keys = registered_shortcuts(settings);
    if previous_keys == next_keys {
        return Ok(());
    }

    let mut newly: Vec<String> = Vec::new();
    for key in &next_keys {
        if previous_keys
            .iter()
            .any(|item| item.eq_ignore_ascii_case(key))
        {
            continue;
        }
        if let Err(error) = app.global_shortcut().register(key.as_str()) {
            for added in &newly {
                let _ = app.global_shortcut().unregister(added.as_str());
            }
            return Err(format!("全局快捷键 {key} 不可用：{error}"));
        }
        newly.push(key.clone());
    }

    for key in &previous_keys {
        if next_keys.iter().any(|item| item.eq_ignore_ascii_case(key)) {
            continue;
        }
        if let Err(error) = app.global_shortcut().unregister(key.as_str()) {
            for added in &newly {
                let _ = app.global_shortcut().unregister(added.as_str());
            }
            for restore in &previous_keys {
                let _ = app.global_shortcut().register(restore.as_str());
            }
            return Err(format!("无法替换原全局快捷键：{error}"));
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum GlobalShortcutAction {
    OpenCreate,
    OpenTodo,
}

fn global_shortcut_action(
    settings: &AppSettings,
    pressed: &Shortcut,
) -> Option<GlobalShortcutAction> {
    if !settings.global_shortcut_enabled {
        return None;
    }
    if settings.create_shortcut.parse::<Shortcut>().ok().as_ref() == Some(pressed) {
        return Some(GlobalShortcutAction::OpenCreate);
    }
    if settings.global_shortcut.parse::<Shortcut>().ok().as_ref() == Some(pressed) {
        return Some(GlobalShortcutAction::OpenTodo);
    }
    None
}

fn dispatch_global_shortcut(app: &tauri::AppHandle, pressed: &Shortcut) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(settings) = state.database.load_settings() else {
        return;
    };
    match global_shortcut_action(&settings, pressed) {
        Some(GlobalShortcutAction::OpenCreate) => toggle_create_window_from_shortcut(app),
        Some(GlobalShortcutAction::OpenTodo) => toggle_main_window_from_shortcut(app),
        None => {}
    }
}

fn set_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    result.map_err(|error| format!("无法更新开机启动状态：{error}"))
}

fn rollback_runtime_settings(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    dock_state: &windowing::WindowDockState,
    previous: &AppSettings,
    autostart_changed: bool,
    pin_changed: bool,
    dock_changed: bool,
) -> Result<(), String> {
    let mut failures = Vec::new();
    if dock_changed {
        if let Err(error) = dock_state.set_auto_hide(previous.auto_hide) {
            log::error!("failed to roll back edge auto-hide: {error}");
            failures.push("贴边隐藏".to_string());
        }
    }
    if pin_changed {
        if let Err(error) = window.set_always_on_top(previous.always_on_top) {
            log::error!("failed to roll back always-on-top: {error}");
            failures.push("窗口置顶".to_string());
        }
    }
    if autostart_changed {
        if let Err(error) = set_autostart(app, previous.launch_at_login) {
            log::error!("failed to roll back autostart: {error}");
            failures.push("开机启动".to_string());
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("无法完全恢复原系统设置：{}", failures.join("、")))
    }
}

fn with_runtime_rollback(error: String, rollback: Result<(), String>) -> String {
    match rollback {
        Ok(()) => error,
        Err(rollback_error) => format!("{error}；{rollback_error}"),
    }
}

#[tauri::command]
fn export_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DataFileResult, String> {
    let bundle = state.database.export_bundle(env!("CARGO_PKG_VERSION"))?;
    data_files::write_export(&app_data_dir(&app)?, &bundle)
}

#[tauri::command]
fn backup_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DataFileResult, String> {
    let bundle = state.database.export_bundle(env!("CARGO_PKG_VERSION"))?;
    data_files::write_backup(&app_data_dir(&app)?, &bundle)
}

#[tauri::command]
fn export_markdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DataFileResult, String> {
    let bundle = state.database.export_bundle(env!("CARGO_PKG_VERSION"))?;
    data_files::write_markdown_export(&app_data_dir(&app)?, &bundle)
}

#[tauri::command]
fn get_data_directory(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app_data_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn export_diagnostics(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let database = state.database.diagnostics()?;
    let (frontend_ready_ms, shortcut_focus) = state.runtime_metrics();
    let report = serde_json::json!({
        "formatVersion": 1,
        "generatedAt": chrono::Utc::now().timestamp_millis(),
        "appVersion": app.package_info().version.to_string(),
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "wayland": windowing::is_wayland_session(),
        },
        "database": database,
        "runtime": {
            "globalShortcutHealthy": state.shortcut_error().is_none(),
            "frontendReadyMs": frontend_ready_ms,
            "shortcutFocus": shortcut_focus,
        },
        "privacy": {
            "containsTodoTitles": false,
            "containsTodoBodies": false,
            "containsFileContents": false,
        }
    });
    data_files::write_diagnostics(&app_data_dir(&app)?, &report)
}

#[tauri::command]
fn preview_import(
    state: tauri::State<'_, AppState>,
    json: String,
) -> Result<ImportPreview, String> {
    let bundle = data_files::parse_import(&json)?;
    state.database.preview_import(&bundle)
}

#[tauri::command]
fn preview_restore(
    state: tauri::State<'_, AppState>,
    json: String,
) -> Result<RestorePreview, String> {
    let bundle = data_files::parse_import(&json)?;
    state.database.preview_restore(&bundle)
}

#[tauri::command]
fn import_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    json: String,
) -> Result<ImportPreview, String> {
    let bundle = data_files::parse_import(&json)?;
    state.database.preview_import(&bundle)?;
    let current_bundle = state.database.export_bundle(env!("CARGO_PKG_VERSION"))?;
    data_files::write_backup(&app_data_dir(&app)?, &current_bundle)?;
    let result = state.database.import_bundle(&bundle)?;
    state.wake_reminders();
    Ok(result)
}

#[tauri::command]
fn restore_data(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    dock_state: tauri::State<'_, windowing::WindowDockState>,
    json: String,
) -> Result<RestorePreview, String> {
    let bundle = data_files::parse_import(&json)?;
    state.database.preview_restore(&bundle)?;
    let current_bundle = state.database.export_bundle(env!("CARGO_PKG_VERSION"))?;
    let backup = data_files::write_backup(&app_data_dir(&app)?, &current_bundle)?;
    let previous = state.database.load_settings()?;
    apply_runtime_settings(
        &app,
        &window,
        &dock_state,
        &previous,
        &bundle.settings,
        state.shortcut_error().is_some(),
    )?;
    let result = match state.database.restore_bundle(&bundle) {
        Ok(result) => result,
        Err(error) => {
            if let Err(rollback_error) = apply_runtime_settings(
                &app,
                &window,
                &dock_state,
                &bundle.settings,
                &previous,
                false,
            ) {
                return Err(format!(
                    "{error}；同时无法恢复原系统设置：{rollback_error}。操作前备份位于 {}",
                    backup.path
                ));
            }
            return Err(error);
        }
    };
    state.set_shortcut_error(None);
    state.wake_reminders();
    Ok(result)
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))
}

const GLOBAL_SHORTCUT_WINDOW: &str = "create";

fn spawn_auxiliary_window(app: &tauri::AppHandle, kind: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = show_or_create_auxiliary_window(&app, kind, None).await {
            log::error!("failed to open {kind} window: {error}");
        }
    });
}

fn should_hide_window(visible: bool, minimized: bool, dock_hidden: bool) -> bool {
    visible && !minimized && !dock_hidden
}

fn is_window_shown(window: &tauri::WebviewWindow, dock_hidden: bool) -> bool {
    should_hide_window(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
        dock_hidden,
    )
}

fn toggle_create_window_from_shortcut(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.mark_shortcut_started();
    }
    if let Some(window) = app.get_webview_window("create") {
        if is_window_shown(&window, false) {
            let _ = window.hide();
            return;
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    spawn_auxiliary_window(app, GLOBAL_SHORTCUT_WINDOW);
}

fn toggle_main_window_from_shortcut(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.mark_shortcut_started();
    }
    if let Some(window) = app.get_webview_window("main") {
        let dock_hidden = app
            .try_state::<windowing::WindowDockState>()
            .is_some_and(|state| state.is_hidden());
        if is_window_shown(&window, dock_hidden) {
            let _ = window.hide();
            return;
        }
    }
    show_main_window(app, false);
}

fn show_main_window(app: &tauri::AppHandle, focus_capture: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(state) = app.try_state::<windowing::WindowDockState>() {
            let _ = windowing::reveal(&window, &state);
        }
        let _ = windowing::ensure_visible(&window);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if focus_capture {
            let _ = app.emit("tododock://focus-capture", ());
        }
    }
}

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show = MenuItem::with_id(app, "show", "显示 TodoDock", true, None::<&str>)?;
    let create = MenuItem::with_id(app, "create", "快速新建", true, None::<&str>)?;
    let today = MenuItem::with_id(app, "today", "今日任务", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &create, &today, &settings, &quit])?;
    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::new()
        .tooltip("TodoDock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app, false),
            "create" => spawn_auxiliary_window(app, "create"),
            "today" => {
                show_main_window(app, false);
                let _ = app.emit("tododock://show-today", ());
            }
            "settings" => spawn_auxiliary_window(app, "settings"),
            "quit" => {
                if let Some(window) = app.get_webview_window("main") {
                    if let Some(state) = app.try_state::<windowing::WindowDockState>() {
                        let _ = windowing::reveal(&window, &state);
                    }
                    let _ = windowing::ensure_visible(&window);
                }
                if let Err(error) = app.save_window_state(persisted_window_flags()) {
                    log::error!("failed to save window state before tray exit: {error}");
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle(), false);
            }
        });
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started_at = Instant::now();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(persisted_window_flags())
                .with_denylist(&["create", "settings", "edit"])
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app, false);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(512_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        dispatch_global_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .invoke_handler(tauri::generate_handler![
            list_todos,
            get_todo,
            create_todo,
            update_todo,
            set_todo_completed,
            set_todo_archived,
            reorder_todos,
            delete_todo,
            restore_todo,
            purge_deleted_todos,
            get_capabilities,
            snap_window,
            reconcile_window_position,
            hide_docked_window,
            reveal_docked_window,
            set_edge_auto_hide,
            get_settings,
            list_in_app_reminders,
            acknowledge_in_app_reminders,
            record_frontend_ready,
            record_capture_focused,
            open_auxiliary_window,
            save_settings,
            acknowledge_close_to_tray,
            export_data,
            export_markdown,
            backup_data,
            get_data_directory,
            export_diagnostics,
            preview_import,
            preview_restore,
            import_data,
            restore_data,
            sync_zentao_tasks,
            generate_todos_from_images
        ])
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
            std::fs::create_dir_all(&app_data_dir)?;
            let database =
                Database::open(&app_data_dir.join("tododock.db")).map_err(std::io::Error::other)?;
            let database = Arc::new(database);
            let (reminder_wake, reminder_receiver) = std::sync::mpsc::sync_channel(1);
            reminders::start(
                app.handle().clone(),
                Arc::clone(&database),
                reminder_receiver,
            );
            app.manage(AppState {
                database,
                reminder_wake,
                shortcut_error: Mutex::new(None),
                tray_available: AtomicBool::new(false),
                started_at,
                frontend_ready_ms: Mutex::new(None),
                shortcut_started_at: Mutex::new(None),
                shortcut_focus_samples: Mutex::new(VecDeque::new()),
            });
            app.manage(windowing::WindowDockState::default());
            let settings = app.state::<AppState>().database.load_settings()?;
            app.state::<windowing::WindowDockState>()
                .set_auto_hide(settings.auto_hide)?;
            if settings.global_shortcut_enabled {
                let mut failed = Vec::new();
                for shortcut in registered_shortcuts(&settings) {
                    if let Err(error) = app.global_shortcut().register(shortcut.as_str()) {
                        log::error!("stored global shortcut is unavailable: {error}");
                        failed.push(shortcut);
                    }
                }
                if !failed.is_empty() {
                    app.state::<AppState>().set_shortcut_error(Some(format!(
                        "全局快捷键 {} 当前被占用；请在下方修改或关闭。",
                        failed.join("、")
                    )));
                }
            }
            let tray_available = match install_tray(app) {
                Ok(()) => true,
                Err(error) => {
                    log::error!("system tray is unavailable: {error}");
                    false
                }
            };
            app.state::<AppState>().set_tray_available(tray_available);
            if let Some(window) = app.get_webview_window("main") {
                windowing::ensure_visible(&window)?;
                let dock_state = app.state::<windowing::WindowDockState>();
                windowing::snap(&window, &dock_state)?;
                window.set_always_on_top(settings.always_on_top)?;
                if tray_available && std::env::args().any(|argument| argument == "--background") {
                    window.hide()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if windowing::is_auxiliary_window_label(window.label()) {
                    return;
                }
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    if let Some(state) = window
                        .app_handle()
                        .try_state::<windowing::WindowDockState>()
                    {
                        let _ = windowing::reveal(&webview, &state);
                    }
                    let _ = windowing::ensure_visible(&webview);
                }
                if let Err(error) = window
                    .app_handle()
                    .save_window_state(persisted_window_flags())
                {
                    log::error!("failed to save window state on close: {error}");
                }
                let state = window.app_handle().try_state::<AppState>();
                let settings = state
                    .as_ref()
                    .and_then(|state| state.database.load_settings().ok());
                let tray_available = state.as_ref().is_some_and(|state| state.tray_available());
                if should_close_to_tray(tray_available, settings.as_ref()) {
                    api.prevent_close();
                    if settings.is_some_and(|settings| settings.close_to_tray_explained) {
                        let _ = window.hide();
                    } else if let Err(error) = window.emit("tododock://explain-close-to-tray", ()) {
                        log::error!("failed to emit close-to-tray explanation: {error}");
                    }
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run TodoDock");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_shortcuts_open_create_and_todo_windows() {
        let settings = AppSettings::default();
        assert_eq!(settings.create_shortcut, "Control+Alt+KeyQ");
        assert_eq!(settings.global_shortcut, "Alt+Space");

        let create: Shortcut = settings.create_shortcut.parse().expect("create shortcut");
        let todo: Shortcut = settings.global_shortcut.parse().expect("todo shortcut");
        assert_eq!(
            global_shortcut_action(&settings, &create),
            Some(GlobalShortcutAction::OpenCreate)
        );
        assert_eq!(
            global_shortcut_action(&settings, &todo),
            Some(GlobalShortcutAction::OpenTodo)
        );

        let disabled = AppSettings {
            global_shortcut_enabled: false,
            ..settings
        };
        assert_eq!(global_shortcut_action(&disabled, &create), None);
        assert_eq!(
            windowing::auxiliary_window_spec(GLOBAL_SHORTCUT_WINDOW, None)
                .expect("create spec")
                .label,
            "create"
        );
        assert!(should_hide_window(true, false, false));
        assert!(!should_hide_window(false, false, false));
        assert!(!should_hide_window(true, true, false));
        assert!(!should_hide_window(true, false, true));
    }

    #[test]
    fn missing_tray_never_leaves_a_hidden_unreachable_process() {
        let settings = AppSettings {
            close_to_tray: true,
            ..AppSettings::default()
        };
        assert!(!should_close_to_tray(false, Some(&settings)));
        assert!(should_close_to_tray(true, Some(&settings)));

        let direct_exit = AppSettings {
            close_to_tray: false,
            ..AppSettings::default()
        };
        assert!(!should_close_to_tray(true, Some(&direct_exit)));
    }

    #[test]
    fn shortcut_timing_summary_is_bounded_and_reports_nearest_rank_percentiles() {
        let samples = (1..=100).collect::<VecDeque<_>>();
        assert_eq!(
            summarize_timings(&samples),
            TimingSummary {
                sample_count: 100,
                latest_ms: Some(100),
                p50_ms: Some(50),
                p95_ms: Some(95),
            }
        );
        assert_eq!(
            summarize_timings(&VecDeque::new()),
            TimingSummary {
                sample_count: 0,
                latest_ms: None,
                p50_ms: None,
                p95_ms: None,
            }
        );
    }

    #[test]
    fn runtime_errors_include_failed_rollback_details() {
        assert_eq!(
            with_runtime_rollback("原操作失败".to_string(), Ok(())),
            "原操作失败"
        );
        assert_eq!(
            with_runtime_rollback("原操作失败".to_string(), Err("回滚失败".to_string())),
            "原操作失败；回滚失败"
        );
    }
}
