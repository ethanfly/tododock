use std::{
    io::Write,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use crate::models::{DataFileResult, ExportBundle};

const MAX_IMPORT_BYTES: usize = 20 * 1024 * 1024;

pub fn parse_import(json: &str) -> Result<ExportBundle, String> {
    if json.len() > MAX_IMPORT_BYTES {
        return Err("导入文件不能超过 20MB".to_string());
    }
    serde_json::from_str(json).map_err(|error| {
        log::error!("failed to decode import bundle: {error}");
        "无法解析导入文件，请确认它是 TodoDock JSON 导出".to_string()
    })
}

pub fn write_export(app_data_dir: &Path, bundle: &ExportBundle) -> Result<DataFileResult, String> {
    write_bundle(app_data_dir, "exports", "tododock-export", bundle, None)
}

pub fn write_backup(app_data_dir: &Path, bundle: &ExportBundle) -> Result<DataFileResult, String> {
    write_bundle(app_data_dir, "backups", "tododock-backup", bundle, Some(10))
}

pub fn write_markdown_export(
    app_data_dir: &Path,
    bundle: &ExportBundle,
) -> Result<DataFileResult, String> {
    let directory = app_data_dir.join("exports");
    std::fs::create_dir_all(&directory).map_err(file_error)?;
    let suffix = unique_suffix();
    let path = directory.join(format!("tododock-export-{suffix}.md"));
    write_atomic(&path, render_markdown(bundle).as_bytes())?;
    Ok(DataFileResult {
        path: path.to_string_lossy().into_owned(),
        todo_count: bundle.todos.len(),
    })
}

pub fn write_diagnostics(
    app_data_dir: &Path,
    report: &serde_json::Value,
) -> Result<String, String> {
    let directory = app_data_dir.join("diagnostics");
    std::fs::create_dir_all(&directory).map_err(file_error)?;
    let suffix = unique_suffix();
    let path = directory.join(format!("tododock-diagnostics-{suffix}.json"));
    let json = serde_json::to_vec_pretty(report).map_err(|error| {
        log::error!("failed to serialize diagnostic report: {error}");
        "无法生成脱敏诊断文件".to_string()
    })?;
    write_atomic(&path, &json)?;
    Ok(path.to_string_lossy().into_owned())
}

fn write_bundle(
    app_data_dir: &Path,
    directory_name: &str,
    prefix: &str,
    bundle: &ExportBundle,
    keep: Option<usize>,
) -> Result<DataFileResult, String> {
    let directory = app_data_dir.join(directory_name);
    std::fs::create_dir_all(&directory).map_err(file_error)?;
    let suffix = unique_suffix();
    let path = directory.join(format!("{prefix}-{suffix}.json"));
    let json = serde_json::to_vec_pretty(bundle).map_err(|error| {
        log::error!("failed to serialize data bundle: {error}");
        "无法生成本地数据文件".to_string()
    })?;
    write_atomic(&path, &json)?;
    if let Some(keep) = keep {
        prune_old_files(&directory, prefix, keep)?;
    }
    Ok(DataFileResult {
        path: path.to_string_lossy().into_owned(),
        todo_count: bundle.todos.len(),
    })
}

fn render_markdown(bundle: &ExportBundle) -> String {
    let exported = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(bundle.exported_at)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| bundle.exported_at.to_string());
    let mut markdown = format!(
        "# TodoDock\n\n导出时间：`{exported}`  \n应用版本：`{}`\n\n",
        bundle.app_version
    );
    if bundle.todos.is_empty() {
        markdown.push_str("_没有 Todo。_\n");
        return markdown;
    }

    for todo in &bundle.todos {
        let checked = if todo.status == "completed" { "x" } else { " " };
        let title = todo.title.replace(['\r', '\n'], " ");
        markdown.push_str(&format!("## - [{checked}] {title}\n\n"));
        markdown.push_str(&format!("- 状态：{}\n", todo.status));
        if todo.priority > 0 {
            markdown.push_str(&format!("- 优先级：P{}\n", todo.priority));
        }
        if let Some(deadline) = todo.deadline_at {
            let value = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(deadline)
                .map(|value| value.to_rfc3339())
                .unwrap_or_else(|| deadline.to_string());
            markdown.push_str(&format!("- Deadline（UTC）：`{value}`\n"));
        }
        if !todo.body.trim().is_empty() {
            markdown.push('\n');
            markdown.push_str(todo.body.trim());
            markdown.push('\n');
        }
        markdown.push_str("\n---\n\n");
    }
    markdown
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = temporary_path(path);
    let mut file = std::fs::File::create(&temporary).map_err(file_error)?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        let _ = std::fs::remove_file(&temporary);
        return Err(file_error(error));
    }
    drop(file);
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(file_error(error));
    }
    #[cfg(unix)]
    if let Some(directory) = path.parent() {
        std::fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(file_error)?;
    }
    Ok(())
}

fn unique_suffix() -> String {
    format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f"),
        Uuid::now_v7()
    )
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(".tmp");
    PathBuf::from(value)
}

fn prune_old_files(directory: &Path, prefix: &str, keep: usize) -> Result<(), String> {
    let mut files = std::fs::read_dir(directory)
        .map_err(file_error)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|value| value.is_file())
                && entry.file_name().to_string_lossy().starts_with(prefix)
                && entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "json")
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.file_name());
    let remove_count = files.len().saturating_sub(keep);
    for entry in files.into_iter().take(remove_count) {
        std::fs::remove_file(entry.path()).map_err(file_error)?;
    }
    Ok(())
}

fn file_error(error: std::io::Error) -> String {
    log::error!("local data file operation failed: {error}");
    "本地数据文件操作失败".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AppSettings;

    fn empty_bundle() -> ExportBundle {
        ExportBundle {
            format_version: 1,
            exported_at: 1_900_000_000_000,
            app_version: "test".to_string(),
            todos: Vec::new(),
            settings: AppSettings::default(),
        }
    }

    #[test]
    fn writes_atomic_exports_and_backups() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let export = write_export(directory.path(), &empty_bundle()).expect("write export");
        let backup = write_backup(directory.path(), &empty_bundle()).expect("write backup");
        let markdown =
            write_markdown_export(directory.path(), &empty_bundle()).expect("write markdown");
        assert!(Path::new(&export.path).is_file());
        assert!(Path::new(&backup.path).is_file());
        assert!(Path::new(&markdown.path).is_file());
        assert!(!Path::new(&format!("{}.tmp", export.path)).exists());
        let markdown_text = std::fs::read_to_string(markdown.path).expect("read markdown");
        assert!(markdown_text.contains("# TodoDock"));
        assert!(markdown_text.contains("没有 Todo"));

        let diagnostic_report = serde_json::json!({
            "formatVersion": 1,
            "privacy": { "containsTodoTitles": false, "containsTodoBodies": false }
        });
        let diagnostics =
            write_diagnostics(directory.path(), &diagnostic_report).expect("write diagnostics");
        let diagnostic_text = std::fs::read_to_string(diagnostics).expect("read diagnostics");
        assert!(diagnostic_text.contains("containsTodoTitles"));
        assert!(!diagnostic_text.contains("Ship the first build"));
    }

    #[test]
    fn rejects_oversized_imports() {
        let value = "x".repeat(MAX_IMPORT_BYTES + 1);
        assert!(parse_import(&value).is_err());
    }

    #[test]
    fn keeps_only_the_ten_newest_unique_backups() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let mut paths = Vec::new();
        for _ in 0..12 {
            paths.push(
                write_backup(directory.path(), &empty_bundle())
                    .expect("write backup")
                    .path,
            );
        }
        let backup_directory = directory.path().join("backups");
        let files = std::fs::read_dir(&backup_directory)
            .expect("read backups")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect backups");
        assert_eq!(files.len(), 10);
        assert_eq!(
            paths.iter().collect::<std::collections::HashSet<_>>().len(),
            12
        );
        assert!(!Path::new(&paths[0]).exists());
        assert!(!Path::new(&paths[1]).exists());
        assert!(Path::new(&paths[11]).exists());
    }
}
