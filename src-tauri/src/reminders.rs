use std::{
    sync::{Arc, mpsc::Receiver},
    thread,
    time::Duration,
};

use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

use crate::db::{Database, DueReminder};

const MAX_RECHECK_INTERVAL: Duration = Duration::from_secs(60);
const MIN_SLEEP: Duration = Duration::from_millis(250);

fn wait_for_next_scan(now: i64, target: Option<i64>) -> Duration {
    let Some(target) = target else {
        return MAX_RECHECK_INTERVAL;
    };
    let millis = target.saturating_sub(now).max(MIN_SLEEP.as_millis() as i64);
    Duration::from_millis(millis as u64).min(MAX_RECHECK_INTERVAL)
}

pub fn start(app: tauri::AppHandle, database: Arc<Database>, wake: Receiver<()>) {
    thread::Builder::new()
        .name("tododock-reminders".to_string())
        .spawn(move || scheduler_loop(app, database, wake))
        .expect("failed to start reminder scheduler");
}

fn scheduler_loop(app: tauri::AppHandle, database: Arc<Database>, wake: Receiver<()>) {
    loop {
        let now = chrono::Utc::now().timestamp_millis();
        match database.quiet_until(now) {
            Ok(Some(timestamp)) => {
                let wait_for = wait_for_next_scan(now, Some(timestamp));
                match wake.recv_timeout(wait_for) {
                    Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            Ok(None) => {}
            Err(error) => log::error!("failed to calculate quiet hours: {error}"),
        }
        match database.claim_due_reminders(now) {
            Ok(reminders) => publish_reminders(&app, reminders),
            Err(error) => log::error!("reminder scan failed: {error}"),
        }

        let wait_for = match database.next_reminder_at(now) {
            Ok(timestamp) => wait_for_next_scan(now, timestamp),
            Err(error) => {
                log::error!("failed to calculate next reminder: {error}");
                Duration::from_secs(60)
            }
        };

        match wake.recv_timeout(wait_for) {
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn publish_reminders(app: &tauri::AppHandle, reminders: Vec<DueReminder>) {
    if reminders.is_empty() {
        return;
    }
    if let Err(error) = app.emit("tododock://reminders-ready", ()) {
        log::error!("failed to emit reminder availability: {error}");
    }
    show_notifications(app, reminders);
}

fn show_notifications(app: &tauri::AppHandle, reminders: Vec<DueReminder>) {
    if reminders.len() > 1 {
        let count = reminders.len();
        if let Err(error) = app
            .notification()
            .builder()
            .title("TodoDock")
            .body(format!("有 {count} 个 Todo 需要关注"))
            .show()
        {
            log::error!("desktop notification summary failed: {error}");
        }
        return;
    }
    for reminder in reminders {
        show_notification(app, reminder);
    }
}

fn show_notification(app: &tauri::AppHandle, reminder: DueReminder) {
    let body = if reminder.kind == "due"
        || reminder.deadline_at <= chrono::Utc::now().timestamp_millis()
    {
        "Todo 已到截止时间"
    } else {
        "Todo 即将到期"
    };
    if let Err(error) = app
        .notification()
        .builder()
        .title(reminder.title)
        .body(body)
        .show()
    {
        log::error!("desktop notification failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduler_rechecks_clock_changes_without_polling_frequently() {
        assert_eq!(wait_for_next_scan(1_000, None), MAX_RECHECK_INTERVAL);
        assert_eq!(
            wait_for_next_scan(1_000, Some(1_000 + 60_000)),
            Duration::from_secs(60)
        );
        assert_eq!(
            wait_for_next_scan(1_000, Some(1_000 + 10 * 60_000)),
            MAX_RECHECK_INTERVAL
        );
        assert_eq!(wait_for_next_scan(1_000, Some(999)), MIN_SLEEP);
    }
}
