use std::sync::Mutex;

use serde::Serialize;
use tauri::{PhysicalPosition, WebviewWindow};

const DEFAULT_THRESHOLD_LOGICAL: f64 = 22.0;
const REVEAL_HANDLE_LOGICAL: f64 = 8.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DockEdge {
    Left,
    Right,
    Top,
}

#[derive(Debug, Clone, Copy)]
struct DockGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug)]
struct DockInner {
    edge: Option<DockEdge>,
    hidden: bool,
    auto_hide: bool,
}

impl Default for DockInner {
    fn default() -> Self {
        Self {
            edge: None,
            hidden: false,
            auto_hide: true,
        }
    }
}

#[derive(Default)]
pub struct WindowDockState {
    inner: Mutex<DockInner>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockSnapshot {
    edge: Option<DockEdge>,
    hidden: bool,
    auto_hide: bool,
    supported: bool,
}

impl WindowDockState {
    pub fn snapshot(&self) -> Result<DockSnapshot, String> {
        let inner = self.inner.lock().map_err(lock_error)?;
        Ok(DockSnapshot {
            edge: inner.edge,
            hidden: inner.hidden,
            auto_hide: inner.auto_hide,
            supported: edge_positioning_supported(),
        })
    }

    pub fn set_auto_hide(&self, enabled: bool) -> Result<DockSnapshot, String> {
        let mut inner = self.inner.lock().map_err(lock_error)?;
        inner.auto_hide = enabled;
        Ok(DockSnapshot {
            edge: inner.edge,
            hidden: inner.hidden,
            auto_hide: inner.auto_hide,
            supported: edge_positioning_supported(),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuxiliaryWindowSpec {
    pub kind: &'static str,
    pub label: String,
    pub title: String,
    pub url: String,
    pub width: f64,
    pub height: f64,
}

pub fn auxiliary_window_spec(kind: &str, id: Option<&str>) -> Result<AuxiliaryWindowSpec, String> {
    match kind {
        "create" => Ok(AuxiliaryWindowSpec {
            kind: "create",
            label: "create".to_string(),
            title: "新建待办".to_string(),
            url: "index.html#/create".to_string(),
            width: 420.0,
            height: 640.0,
        }),
        "settings" => Ok(AuxiliaryWindowSpec {
            kind: "settings",
            label: "settings".to_string(),
            title: "设置".to_string(),
            url: "index.html#/settings".to_string(),
            width: 440.0,
            height: 680.0,
        }),
        "edit" => {
            let id = id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "缺少待办 ID".to_string())?;
            uuid::Uuid::parse_str(id).map_err(|_| "Todo ID 无效".to_string())?;
            Ok(AuxiliaryWindowSpec {
                kind: "edit",
                label: format!("edit-{id}"),
                title: "编辑待办".to_string(),
                url: format!("index.html#/edit/{id}"),
                width: 420.0,
                height: 640.0,
            })
        }
        _ => Err("未知窗口".to_string()),
    }
}

pub fn is_auxiliary_window_label(label: &str) -> bool {
    matches!(label, "create" | "settings") || label.starts_with("edit-")
}

pub fn ensure_visible(window: &WebviewWindow) -> Result<(), String> {
    if !edge_positioning_supported() {
        return Ok(());
    }
    let monitor = match window.current_monitor().map_err(window_error)? {
        Some(monitor) => monitor,
        None => match window.primary_monitor().map_err(window_error)? {
            Some(monitor) => monitor,
            None => window
                .available_monitors()
                .map_err(window_error)?
                .into_iter()
                .next()
                .ok_or_else(|| "没有可用显示器，无法恢复窗口".to_string())?,
        },
    };
    let position = window.outer_position().map_err(window_error)?;
    let size = window.outer_size().map_err(window_error)?;
    let work = monitor.work_area();
    let geometry = DockGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let work_area = WorkArea {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width,
        height: work.size.height,
    };
    let target = fully_visible_position(geometry, work_area);
    if target != (geometry.x, geometry.y) {
        window
            .set_position(PhysicalPosition::new(target.0, target.1))
            .map_err(window_error)?;
    }
    Ok(())
}

pub fn snap(window: &WebviewWindow, state: &WindowDockState) -> Result<DockSnapshot, String> {
    if !edge_positioning_supported() {
        return state.snapshot();
    }
    {
        let inner = state.inner.lock().map_err(lock_error)?;
        if inner.hidden {
            return Ok(DockSnapshot {
                edge: inner.edge,
                hidden: true,
                auto_hide: inner.auto_hide,
                supported: true,
            });
        }
    }

    let monitor = window
        .current_monitor()
        .map_err(window_error)?
        .ok_or_else(|| "无法确定窗口所在显示器".to_string())?;
    let position = window.outer_position().map_err(window_error)?;
    let size = window.outer_size().map_err(window_error)?;
    let work = monitor.work_area();
    let geometry = DockGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let work_area = WorkArea {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width,
        height: work.size.height,
    };
    let threshold = (DEFAULT_THRESHOLD_LOGICAL * monitor.scale_factor()).round() as i32;

    let Some(edge) = nearest_edge(geometry, work_area, threshold) else {
        let mut inner = state.inner.lock().map_err(lock_error)?;
        inner.edge = None;
        inner.hidden = false;
        return Ok(DockSnapshot {
            edge: None,
            hidden: false,
            auto_hide: inner.auto_hide,
            supported: true,
        });
    };

    let target = visible_position(edge, geometry, work_area);
    window
        .set_position(PhysicalPosition::new(target.0, target.1))
        .map_err(window_error)?;
    let mut inner = state.inner.lock().map_err(lock_error)?;
    inner.edge = Some(edge);
    inner.hidden = false;
    Ok(DockSnapshot {
        edge: inner.edge,
        hidden: inner.hidden,
        auto_hide: inner.auto_hide,
        supported: true,
    })
}

pub fn reconcile(window: &WebviewWindow, state: &WindowDockState) -> Result<DockSnapshot, String> {
    if !edge_positioning_supported() {
        return state.snapshot();
    }
    {
        let inner = state.inner.lock().map_err(lock_error)?;
        if inner.hidden {
            return Ok(DockSnapshot {
                edge: inner.edge,
                hidden: true,
                auto_hide: inner.auto_hide,
                supported: true,
            });
        }
    }
    ensure_visible(window)?;
    snap(window, state)
}

pub fn hide(window: &WebviewWindow, state: &WindowDockState) -> Result<DockSnapshot, String> {
    if !edge_positioning_supported() {
        return state.snapshot();
    }

    let (edge, auto_hide) = {
        let inner = state.inner.lock().map_err(lock_error)?;
        (inner.edge, inner.auto_hide)
    };
    let Some(edge) = edge else {
        return state.snapshot();
    };
    if !auto_hide {
        return state.snapshot();
    }

    let (geometry, work_area, scale_factor) = window_geometry(window)?;
    let handle = (REVEAL_HANDLE_LOGICAL * scale_factor).round().max(1.0) as i32;
    let visible = visible_position(edge, geometry, work_area);
    let hidden = match edge {
        DockEdge::Left => (work_area.x - geometry.width as i32 + handle, visible.1),
        DockEdge::Right => (work_area.x + work_area.width as i32 - handle, visible.1),
        DockEdge::Top => (visible.0, work_area.y - geometry.height as i32 + handle),
    };
    {
        let mut inner = state.inner.lock().map_err(lock_error)?;
        inner.hidden = true;
    }
    if let Err(error) = window.set_position(PhysicalPosition::new(hidden.0, hidden.1)) {
        if let Ok(mut inner) = state.inner.lock() {
            inner.hidden = false;
        }
        return Err(window_error(error));
    }
    state.snapshot()
}

pub fn reveal(window: &WebviewWindow, state: &WindowDockState) -> Result<DockSnapshot, String> {
    if !edge_positioning_supported() {
        return state.snapshot();
    }

    let (edge, was_hidden) = {
        let inner = state.inner.lock().map_err(lock_error)?;
        (inner.edge, inner.hidden)
    };
    let Some(edge) = edge else {
        return state.snapshot();
    };
    let (geometry, work_area, _) = window_geometry(window)?;
    let target = visible_position(edge, geometry, work_area);
    {
        let mut inner = state.inner.lock().map_err(lock_error)?;
        inner.hidden = false;
    }
    if let Err(error) = window.set_position(PhysicalPosition::new(target.0, target.1)) {
        if let Ok(mut inner) = state.inner.lock() {
            inner.hidden = was_hidden;
        }
        return Err(window_error(error));
    }
    state.snapshot()
}

fn window_geometry(window: &WebviewWindow) -> Result<(DockGeometry, WorkArea, f64), String> {
    let monitor = window
        .current_monitor()
        .map_err(window_error)?
        .ok_or_else(|| "无法确定窗口所在显示器".to_string())?;
    let position = window.outer_position().map_err(window_error)?;
    let size = window.outer_size().map_err(window_error)?;
    let work = monitor.work_area();
    Ok((
        DockGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        WorkArea {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
        },
        monitor.scale_factor(),
    ))
}

fn nearest_edge(window: DockGeometry, work: WorkArea, threshold: i32) -> Option<DockEdge> {
    let work_right = work.x.saturating_add(work.width as i32);
    let window_right = window.x.saturating_add(window.width as i32);
    let distances = [
        (DockEdge::Left, (window.x - work.x).abs()),
        (DockEdge::Right, (window_right - work_right).abs()),
        (DockEdge::Top, (window.y - work.y).abs()),
    ];
    distances
        .into_iter()
        .filter(|(_, distance)| *distance <= threshold)
        .min_by_key(|(_, distance)| *distance)
        .map(|(edge, _)| edge)
}

fn visible_position(edge: DockEdge, window: DockGeometry, work: WorkArea) -> (i32, i32) {
    match edge {
        DockEdge::Left => (
            work.x,
            clamp_axis(window.y, work.y, work.height, window.height),
        ),
        DockEdge::Right => (
            work.x + work.width as i32 - window.width as i32,
            clamp_axis(window.y, work.y, work.height, window.height),
        ),
        DockEdge::Top => (
            clamp_axis(window.x, work.x, work.width, window.width),
            work.y,
        ),
    }
}

fn fully_visible_position(window: DockGeometry, work: WorkArea) -> (i32, i32) {
    (
        clamp_axis(window.x, work.x, work.width, window.width),
        clamp_axis(window.y, work.y, work.height, window.height),
    )
}

fn clamp_axis(value: i32, start: i32, available: u32, occupied: u32) -> i32 {
    let end = start.saturating_add(available.saturating_sub(occupied) as i32);
    value.clamp(start, end)
}

pub fn edge_positioning_supported() -> bool {
    !is_wayland_session()
}

pub fn is_wayland_session() -> bool {
    #[cfg(target_os = "linux")]
    {
        wayland_session_from_env(
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[cfg(target_os = "linux")]
fn wayland_session_from_env(
    wayland_display: Option<&std::ffi::OsStr>,
    session_type: Option<&str>,
) -> bool {
    wayland_display.is_some()
        || session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
}

fn window_error(error: tauri::Error) -> String {
    log::error!("window operation failed: {error}");
    "窗口操作失败".to_string()
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    log::error!("window dock state lock poisoned");
    "窗口贴边状态暂时不可用".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: WorkArea = WorkArea {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1040,
    };

    #[test]
    fn detects_left_right_and_top_edges_but_not_bottom() {
        let window = DockGeometry {
            x: -1910,
            y: 200,
            width: 420,
            height: 640,
        };
        assert_eq!(nearest_edge(window, WORK, 22), Some(DockEdge::Left));

        let window = DockGeometry { x: -430, ..window };
        assert_eq!(nearest_edge(window, WORK, 22), Some(DockEdge::Right));

        let window = DockGeometry {
            x: -900,
            y: 12,
            ..window
        };
        assert_eq!(nearest_edge(window, WORK, 22), Some(DockEdge::Top));

        let window = DockGeometry { y: 400, ..window };
        assert_eq!(nearest_edge(window, WORK, 22), None);
    }

    #[test]
    fn clamps_a_snapped_window_inside_the_monitor_work_area() {
        let window = DockGeometry {
            x: -1915,
            y: 900,
            width: 420,
            height: 640,
        };
        assert_eq!(visible_position(DockEdge::Left, window, WORK), (-1920, 400));
        assert_eq!(visible_position(DockEdge::Top, window, WORK), (-1915, 0));
    }

    #[test]
    fn restores_an_offscreen_window_fully_into_the_work_area() {
        let hidden_left = DockGeometry {
            x: -2332,
            y: 900,
            width: 420,
            height: 640,
        };
        assert_eq!(fully_visible_position(hidden_left, WORK), (-1920, 400));

        let oversized = DockGeometry {
            x: -3000,
            y: -200,
            width: 2200,
            height: 1200,
        };
        assert_eq!(fully_visible_position(oversized, WORK), (-1920, 0));
    }

    #[test]
    fn maps_create_settings_and_edit_to_independent_windows() {
        let create = auxiliary_window_spec("create", None).expect("create spec");
        assert_eq!(create.label, "create");
        assert_eq!(create.title, "新建待办");
        assert!(create.url.contains("#/create"));
        assert!(create.height >= 420.0);

        let settings = auxiliary_window_spec("settings", None).expect("settings spec");
        assert_eq!(settings.label, "settings");
        assert_eq!(settings.title, "设置");
        assert!(settings.url.contains("#/settings"));

        let todo_id = "01991a3b-e122-7fd0-a321-f4af72160cb8";
        let edit = auxiliary_window_spec("edit", Some(todo_id)).expect("edit spec");
        assert_eq!(edit.label, format!("edit-{todo_id}"));
        assert_eq!(edit.title, "编辑待办");
        assert!(edit.url.contains(&format!("#/edit/{todo_id}")));
        assert!(is_auxiliary_window_label("create"));
        assert!(is_auxiliary_window_label("settings"));
        assert!(is_auxiliary_window_label(&edit.label));
        assert!(!is_auxiliary_window_label("main"));
        assert!(!is_auxiliary_window_label("editor"));
        assert_eq!(
            auxiliary_window_spec("edit", None).unwrap_err(),
            "缺少待办 ID"
        );
        assert_eq!(
            auxiliary_window_spec("edit", Some("not-a-uuid")).unwrap_err(),
            "Todo ID 无效"
        );
        assert_eq!(
            auxiliary_window_spec("unknown", None).unwrap_err(),
            "未知窗口"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detects_wayland_from_either_session_indicator() {
        assert!(wayland_session_from_env(
            Some(std::ffi::OsStr::new("wayland-0")),
            None
        ));
        assert!(wayland_session_from_env(None, Some("WAYLAND")));
        assert!(!wayland_session_from_env(None, Some("x11")));
    }
}
