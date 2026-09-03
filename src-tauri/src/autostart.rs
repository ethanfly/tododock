use tauri::AppHandle;

#[cfg(not(windows))]
use tauri_plugin_autostart::ManagerExt as AutostartExt;

#[cfg(any(windows, test))]
const BACKGROUND_ARG: &str = "--background";
#[cfg(windows)]
const WINDOWS_VALUE_NAMES: [&str; 2] = ["TodoDock", "tododock"];
#[cfg(windows)]
const WINDOWS_PRIMARY_NAME: &str = "TodoDock";
#[cfg(windows)]
const WINDOWS_RUN_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const WINDOWS_APPROVED_KEY: &str =
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
#[cfg(windows)]
const WINDOWS_APPROVED_ENABLED: [u8; 12] = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

pub fn apply(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if enabled { enable(app) } else { disable(app) }
}

pub fn is_enabled(app: &AppHandle) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let _ = app;
        windows_is_enabled()
    }
    #[cfg(not(windows))]
    {
        app.autolaunch()
            .is_enabled()
            .map_err(|error| format!("无法读取开机启动状态：{error}"))
    }
}

fn enable(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        windows_enable()
    }
    #[cfg(not(windows))]
    {
        app.autolaunch()
            .enable()
            .map_err(|error| format!("无法更新开机启动状态：{error}"))
    }
}

fn disable(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        windows_disable()
    }
    #[cfg(not(windows))]
    {
        match app.autolaunch().is_enabled() {
            Ok(false) => Ok(()),
            Ok(true) | Err(_) => {
                app.autolaunch()
                    .disable()
                    .or_else(|error| match app.autolaunch().is_enabled() {
                        Ok(false) => Ok(()),
                        _ => Err(format!("无法更新开机启动状态：{error}")),
                    })
            }
        }
    }
}

#[cfg(any(windows, test))]
pub(crate) fn sanitize_windows_exe_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    path.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

#[cfg(any(windows, test))]
pub(crate) fn windows_run_command(exe_path: &str) -> String {
    format!(
        "\"{}\" {BACKGROUND_ARG}",
        sanitize_windows_exe_path(exe_path)
    )
}

#[cfg(windows)]
fn windows_enable() -> Result<(), String> {
    use std::env::current_exe;
    use winreg::enums::{HKEY_CURRENT_USER, REG_BINARY};
    use winreg::{RegKey, RegValue};

    let exe = current_exe().map_err(|error| format!("无法确定当前程序路径：{error}"))?;
    let command = windows_run_command(&exe.to_string_lossy());
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu
        .create_subkey(WINDOWS_RUN_KEY)
        .map_err(|error| format!("无法写入开机启动注册表：{error}"))?;
    run.set_value(WINDOWS_PRIMARY_NAME, &command)
        .map_err(|error| format!("无法写入开机启动注册表：{error}"))?;
    for leftover in WINDOWS_VALUE_NAMES
        .iter()
        .copied()
        .filter(|name| *name != WINDOWS_PRIMARY_NAME)
    {
        delete_value_if_present(&run, leftover)?;
    }

    if let Ok((approved, _)) = hkcu.create_subkey(WINDOWS_APPROVED_KEY) {
        let _ = approved.set_raw_value(
            WINDOWS_PRIMARY_NAME,
            &RegValue {
                vtype: REG_BINARY,
                bytes: WINDOWS_APPROVED_ENABLED.to_vec(),
            },
        );
        for leftover in WINDOWS_VALUE_NAMES
            .iter()
            .copied()
            .filter(|name| *name != WINDOWS_PRIMARY_NAME)
        {
            let _ = delete_value_if_present(&approved, leftover);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn windows_disable() -> Result<(), String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(run) = hkcu.open_subkey_with_flags(WINDOWS_RUN_KEY, KEY_SET_VALUE) {
        for name in WINDOWS_VALUE_NAMES {
            delete_value_if_present(&run, name)?;
        }
    }
    if let Ok(approved) = hkcu.open_subkey_with_flags(WINDOWS_APPROVED_KEY, KEY_SET_VALUE) {
        for name in WINDOWS_VALUE_NAMES {
            let _ = delete_value_if_present(&approved, name);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn windows_is_enabled() -> Result<bool, String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run = match hkcu.open_subkey(WINDOWS_RUN_KEY) {
        Ok(run) => run,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法读取开机启动注册表：{error}")),
    };
    if run.get_value::<String, _>(WINDOWS_PRIMARY_NAME).is_err() {
        return Ok(false);
    }
    Ok(windows_task_manager_allows(&hkcu).unwrap_or(true))
}

#[cfg(windows)]
fn windows_task_manager_allows(hkcu: &winreg::RegKey) -> Option<bool> {
    let approved = hkcu.open_subkey(WINDOWS_APPROVED_KEY).ok()?;
    let value = approved.get_raw_value(WINDOWS_PRIMARY_NAME).ok()?;
    if value.bytes.len() < 8 {
        return None;
    }
    Some(value.bytes.iter().rev().take(8).all(|byte| *byte == 0))
}

#[cfg(windows)]
fn delete_value_if_present(key: &winreg::RegKey, name: &str) -> Result<(), String> {
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法更新开机启动注册表：{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize_windows_exe_path, windows_run_command};

    #[test]
    fn strips_verbatim_prefix_and_quotes_windows_paths() {
        assert_eq!(
            sanitize_windows_exe_path(r"\\?\C:\Users\a\tododock.exe"),
            r"C:\Users\a\tododock.exe"
        );
        assert_eq!(
            sanitize_windows_exe_path(r"\\?\UNC\server\share\tododock.exe"),
            r"\\server\share\tododock.exe"
        );
        assert_eq!(
            sanitize_windows_exe_path(r"C:\Users\a\tododock.exe"),
            r"C:\Users\a\tododock.exe"
        );
        assert_eq!(
            windows_run_command(r"C:\Program Files\TodoDock\tododock.exe"),
            r#""C:\Program Files\TodoDock\tododock.exe" --background"#
        );
        assert_eq!(
            windows_run_command(r"\\?\C:\Program Files\TodoDock\tododock.exe"),
            r#""C:\Program Files\TodoDock\tododock.exe" --background"#
        );
    }
}
