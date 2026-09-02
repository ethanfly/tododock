use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub priority: i64,
    pub deadline_at: Option<i64>,
    pub reminder_minutes: Option<i64>,
    pub completed_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub sort_order: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTodosInput {
    pub filter: String,
    #[serde(default)]
    pub search: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoInput {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub priority: i64,
    pub deadline_at: Option<i64>,
    pub reminder_minutes: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoInput {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub priority: i64,
    pub deadline_at: Option<i64>,
    pub reminder_minutes: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCapabilities {
    pub edge_snap: bool,
    pub edge_hide: bool,
    pub global_shortcut: bool,
    pub notifications: bool,
    pub tray: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub global_shortcut_enabled: bool,
    pub global_shortcut: String,
    #[serde(default = "default_create_shortcut")]
    pub create_shortcut: String,
    pub auto_hide: bool,
    pub always_on_top: bool,
    pub default_reminder_minutes: i64,
    pub launch_at_login: bool,
    pub close_to_tray: bool,
    pub close_to_tray_explained: bool,
    pub quiet_hours_start: Option<String>,
    pub quiet_hours_end: Option<String>,
    pub zentao_url: String,
    pub zentao_account: String,
    pub zentao_password: String,
    pub zentao_assigned_only: bool,
}

fn default_create_shortcut() -> String {
    "Control+Alt+KeyQ".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            global_shortcut_enabled: true,
            global_shortcut: "Alt+Space".to_string(),
            create_shortcut: "Control+Alt+KeyQ".to_string(),
            auto_hide: true,
            always_on_top: false,
            default_reminder_minutes: 15,
            launch_at_login: false,
            close_to_tray: true,
            close_to_tray_explained: false,
            quiet_hours_start: None,
            quiet_hours_end: None,
            zentao_url: String::new(),
            zentao_account: String::new(),
            zentao_password: String::new(),
            zentao_assigned_only: true,
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZentaoSyncResult {
    pub created: usize,
    pub updated: usize,
    pub completed: usize,
    pub skipped: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundle {
    pub format_version: u32,
    pub exported_at: i64,
    pub app_version: String,
    pub todos: Vec<Todo>,
    pub settings: AppSettings,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub total: usize,
    pub new_count: usize,
    pub update_count: usize,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub total: usize,
    pub add_count: usize,
    pub replace_count: usize,
    pub remove_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFileResult {
    pub path: String,
    pub todo_count: usize,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDiagnostics {
    pub schema_version: i64,
    pub open_count: i64,
    pub completed_count: i64,
    pub archived_count: i64,
    pub deleted_count: i64,
    pub reminder_delivery_count: i64,
}
